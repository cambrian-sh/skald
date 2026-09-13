import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import {
  DEFAULT_MCP_SERVER,
  MCP_AGENTS,
  type McpAgent,
  type McpServerDefinition,
  persistableMcpEnvironment,
} from "./agents/mcp"
import {
  manifestBackend,
  SKALD_MANIFEST_VERSION,
  type SkaldProjectManifest,
} from "./context/contract"
import { ConfigParseError, ConfigShapeError } from "./errors"
import { readManagedFile, writeManagedFile } from "./fs/safe-file"
import type { StandardsInventory } from "./standards/discover"

const CONFIG_DIRECTORY = ".skald"
const CONFIG_FILENAME = "config.json"
const CONFIG_PATH = `${CONFIG_DIRECTORY}/${CONFIG_FILENAME}`
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export type ConfigAction = "created" | "updated" | "exists" | "would_create" | "would_update"

export type ConfigResult = {
  readonly action: ConfigAction
  readonly path: string
}

type ConfigObject = Record<string, unknown> & {
  mcp?: unknown
  backend?: unknown
  standards?: unknown
}

type McpConfigObject = Record<string, unknown> & {
  command?: unknown
  args?: unknown
  env?: unknown
  serverName?: unknown
  trust?: unknown
  sha256?: unknown
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMcpConfigObject(value: unknown): value is McpConfigObject {
  return isObject(value)
}

function parseConfigDocument(contents: string): ConfigObject {
  const errors: ParseError[] = []
  const value: unknown = parse(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ConfigParseError(CONFIG_PATH, "JSON")
  if (!isObject(value)) throw new ConfigShapeError(CONFIG_PATH, "root must be an object")
  return value
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigShapeError(CONFIG_PATH, "mcp.args must be an array of strings")
  }
  return value
}

function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new ConfigShapeError(CONFIG_PATH, "mcp.env must be an object")
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new ConfigShapeError(CONFIG_PATH, "mcp.env values must be strings")
    }
    result[key] = item
  }
  return result
}

export async function readConfiguredMcpServer(
  projectRoot: string,
): Promise<McpServerDefinition | undefined> {
  const existing = await readManagedFile(projectRoot, CONFIG_PATH)
  if (!existing.exists) return undefined
  const value = parseConfigDocument(existing.contents ?? "")
  if (!isObject(value)) throw new ConfigShapeError(CONFIG_PATH, "root must be an object")
  const mcp =
    value["version"] === SKALD_MANIFEST_VERSION
      ? (value["backend"] ?? value["mcp"])
      : (value["mcp"] ?? value["backend"])
  if (mcp === undefined) return undefined
  if (!isMcpConfigObject(mcp) || typeof mcp.command !== "string") {
    throw new ConfigShapeError(CONFIG_PATH, "mcp.command must be a string")
  }
  const args = mcp.args === undefined ? [] : stringArray(mcp.args)
  const env = persistableMcpEnvironment(stringMap(mcp.env))
  const serverName = typeof mcp.serverName === "string" ? mcp.serverName : undefined
  if (mcp.trust !== undefined && mcp.trust !== "explicit") {
    throw new ConfigShapeError(CONFIG_PATH, "mcp.trust must be explicit when present")
  }
  if (
    mcp.sha256 !== undefined &&
    (typeof mcp.sha256 !== "string" || !SHA256_PATTERN.test(mcp.sha256))
  ) {
    throw new ConfigShapeError(CONFIG_PATH, "mcp.sha256 must be a lowercase SHA-256 digest")
  }
  const trust = mcp.trust === "explicit" ? "explicit" : undefined
  const sha256 = typeof mcp.sha256 === "string" ? mcp.sha256 : undefined
  return {
    command: mcp.command,
    args,
    ...(env === undefined ? {} : { env }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(trust === undefined ? {} : { trust }),
    ...(sha256 === undefined ? {} : { sha256 }),
  }
}

export type EnsureConfigOptions = {
  readonly agents?: readonly McpAgent[]
  readonly knowledgeDirectory?: string
  readonly updateBackend?: boolean
}

function projectManifest(
  server: McpServerDefinition,
  standards: StandardsInventory | undefined,
  options: EnsureConfigOptions,
): SkaldProjectManifest {
  const knowledgeDirectory =
    options.knowledgeDirectory ?? server.env?.["CBM_KNOWLEDGE_DIR"] ?? ".skald/knowledge"
  const agents = options.agents ?? MCP_AGENTS
  return {
    version: SKALD_MANIFEST_VERSION,
    project: { root: "." },
    backend: manifestBackend(server),
    sources: [
      { kind: "repository", path: "." },
      { kind: "knowledge", path: knowledgeDirectory },
    ],
    agents: [...agents],
    context: {
      serverName: "skald-context",
      retrieval: "on-demand",
      writeSurface: ".skald/knowledge",
    },
    freshness: { onQuery: "refresh", beforeWrite: "require-verify" },
    ...(standards === undefined
      ? {}
      : {
          standards: {
            instructions: standards.instructions.map((file) => file.path),
            skills: standards.skills.map((skill) => skill.path),
            truncated: standards.truncated,
          },
        }),
  }
}

function isManifest(value: unknown): value is SkaldProjectManifest {
  if (!isObject(value) || value["version"] !== SKALD_MANIFEST_VERSION) return false
  const project = value["project"]
  const backend = value["backend"]
  const sources = value["sources"]
  const agents = value["agents"]
  const context = value["context"]
  const freshness = value["freshness"]
  if (!isObject(project) || project["root"] !== ".") return false
  if (!isObject(backend) || backend["kind"] !== "mcp" || typeof backend["command"] !== "string")
    return false
  if (backend["trust"] !== undefined && backend["trust"] !== "explicit") return false
  if (
    backend["sha256"] !== undefined &&
    (typeof backend["sha256"] !== "string" || !SHA256_PATTERN.test(backend["sha256"]))
  ) {
    return false
  }
  if (
    backend["env"] !== undefined &&
    (!isObject(backend["env"]) ||
      Object.values(backend["env"]).some((value) => typeof value !== "string"))
  ) {
    return false
  }
  if (backend["serverName"] !== undefined && typeof backend["serverName"] !== "string") {
    return false
  }
  if (!Array.isArray(backend["args"]) || backend["args"].some((item) => typeof item !== "string"))
    return false
  if (
    !Array.isArray(sources) ||
    sources.some(
      (source) =>
        !isObject(source) ||
        (source["kind"] !== "repository" && source["kind"] !== "knowledge") ||
        typeof source["path"] !== "string",
    )
  )
    return false
  if (!Array.isArray(agents) || agents.some((agent) => !isMcpAgent(agent))) return false
  if (!isObject(context) || typeof context["serverName"] !== "string") return false
  if (context["retrieval"] !== "on-demand" || typeof context["writeSurface"] !== "string") {
    return false
  }
  if (
    !isObject(freshness) ||
    (freshness["onQuery"] !== "warn" && freshness["onQuery"] !== "refresh") ||
    (freshness["beforeWrite"] !== "warn" && freshness["beforeWrite"] !== "require-verify")
  )
    return false
  return true
}

function isMcpAgent(value: unknown): value is McpAgent {
  return MCP_AGENTS.some((agent) => agent === value)
}

export async function readProjectManifest(
  projectRoot: string,
): Promise<SkaldProjectManifest | undefined> {
  const existing = await readManagedFile(projectRoot, CONFIG_PATH)
  if (!existing.exists) return undefined
  const value = parseConfigDocument(existing.contents ?? "")
  if (isObject(value) && value["version"] === SKALD_MANIFEST_VERSION && !isManifest(value)) {
    throw new ConfigShapeError(CONFIG_PATH, "invalid Skald manifest")
  }
  return isManifest(value) ? value : undefined
}

export async function ensureConfig(
  projectRoot: string,
  dryRun: boolean,
  server: McpServerDefinition = DEFAULT_MCP_SERVER,
  standards?: StandardsInventory,
  options: EnsureConfigOptions = {},
): Promise<ConfigResult> {
  const existing = await readManagedFile(projectRoot, CONFIG_PATH)
  if (existing.exists) {
    const document = parseConfigDocument(existing.contents ?? "")
    if (document["version"] === SKALD_MANIFEST_VERSION && !isManifest(document)) {
      throw new ConfigShapeError(CONFIG_PATH, "invalid Skald manifest")
    }
    if (document["version"] === SKALD_MANIFEST_VERSION) {
      const desired = projectManifest(server, standards, options)
      const current = document as SkaldProjectManifest
      const edits: { readonly path: (string | number)[]; readonly value: unknown }[] = []
      if (
        options.updateBackend === true &&
        JSON.stringify(current.backend) !== JSON.stringify(desired.backend)
      ) {
        edits.push({ path: ["backend"], value: desired.backend })
      }
      if (
        standards !== undefined &&
        JSON.stringify(current.standards) !== JSON.stringify(desired.standards)
      ) {
        edits.push({ path: ["standards"], value: desired.standards })
      }
      if (options.knowledgeDirectory !== undefined || options.updateBackend === true) {
        const desiredKnowledge = desired.sources.find((source) => source.kind === "knowledge")
        const currentKnowledgeIndex = current.sources.findIndex(
          (source) => source.kind === "knowledge",
        )
        if (desiredKnowledge !== undefined) {
          if (currentKnowledgeIndex < 0) {
            edits.push({ path: ["sources", current.sources.length], value: desiredKnowledge })
          } else if (current.sources[currentKnowledgeIndex]?.path !== desiredKnowledge.path) {
            edits.push({
              path: ["sources", currentKnowledgeIndex, "path"],
              value: desiredKnowledge.path,
            })
          }
        }
      }
      if (edits.length === 0) return { action: "exists", path: CONFIG_PATH }
      if (dryRun) return { action: "would_update", path: CONFIG_PATH }
      let contents = existing.contents ?? ""
      for (const edit of edits) {
        contents = applyEdits(
          contents,
          modify(contents, edit.path, edit.value, {
            formattingOptions: {
              eol: contents.includes("\r\n") ? "\r\n" : "\n",
              insertFinalNewline: true,
              insertSpaces: true,
              tabSize: 2,
            },
          }),
        )
      }
      const result = await writeManagedFile(projectRoot, CONFIG_PATH, contents)
      return { action: result === "updated" ? "updated" : "exists", path: CONFIG_PATH }
    }
    if (document["version"] !== 1) return { action: "exists", path: CONFIG_PATH }
    const migrated = projectManifest(server, standards, options)
    if (dryRun) return { action: "would_update", path: CONFIG_PATH }
    let contents = existing.contents ?? ""
    for (const [key, value] of Object.entries(migrated)) {
      contents = applyEdits(
        contents,
        modify(contents, [key], value, {
          formattingOptions: {
            eol: contents.includes("\r\n") ? "\r\n" : "\n",
            insertFinalNewline: true,
            insertSpaces: true,
            tabSize: 2,
          },
        }),
      )
    }
    const result = await writeManagedFile(projectRoot, CONFIG_PATH, contents)
    return { action: result === "updated" ? "updated" : "exists", path: CONFIG_PATH }
  }
  if (dryRun) return { action: "would_create", path: CONFIG_PATH }

  const defaultConfigValue: ConfigObject = projectManifest(server, standards, options)
  const defaultConfig = `${JSON.stringify(defaultConfigValue, null, 2)}\n`
  const result = await writeManagedFile(projectRoot, CONFIG_PATH, defaultConfig)
  return { action: result === "created" ? "created" : "exists", path: CONFIG_PATH }
}
