import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { ConfigParseError, ConfigShapeError } from "../errors"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"
import {
  type AgentMcpConfigOptions,
  DEFAULT_CONTEXT_SERVER,
  LEGACY_MCP_SERVER_NAME,
  type McpAgent,
  type McpConfigAction,
  type McpConfigResult,
  type McpServerDefinition,
  persistableMcpEnvironment,
  SKALD_MCP_SERVER_NAME,
} from "./mcp"

type JsonObject = Record<string, unknown> & {
  mcpServers?: unknown
  mcp?: unknown
  servers?: unknown
  env?: unknown
  environment?: unknown
}

type JsonConfigUpdate = {
  readonly path: string[]
  readonly value: JsonObject
  readonly edits: readonly { readonly path: string[]; readonly value: JsonObject }[]
  readonly existingServer?: string
  readonly changed: boolean
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serverObject(server: McpServerDefinition): JsonObject {
  const result: JsonObject = {
    command: server.command,
    args: [...server.args],
  }
  const environment = persistableMcpEnvironment(server.env)
  if (environment !== undefined) {
    result.env = { ...environment }
  }
  return result
}

function serverName(server: McpServerDefinition): string {
  return server.serverName ?? SKALD_MCP_SERVER_NAME
}

function openCodeServerObject(server: McpServerDefinition): JsonObject {
  const result: JsonObject = {
    type: "local",
    command: [server.command, ...server.args],
    disabled: false,
  }
  const environment = persistableMcpEnvironment(server.env)
  if (environment !== undefined) {
    result.environment = { ...environment }
  }
  return result
}

function existingServerName(servers: JsonObject): string | undefined {
  if (Object.hasOwn(servers, SKALD_MCP_SERVER_NAME)) return SKALD_MCP_SERVER_NAME
  if (Object.hasOwn(servers, LEGACY_MCP_SERVER_NAME)) return LEGACY_MCP_SERVER_NAME
  return undefined
}

function parseJsonConfig(contents: string, path: string): JsonObject {
  const errors: ParseError[] = []
  const parsed: unknown = parse(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ConfigParseError(path, "JSON or JSONC")
  if (!isJsonObject(parsed)) throw new ConfigShapeError(path, "root must be an object")
  return parsed
}

async function writeJsonConfig(
  projectRoot: string,
  agent: McpAgent,
  path: string,
  dryRun: boolean,
  update: (config: JsonObject) => JsonConfigUpdate,
  create: () => JsonObject,
): Promise<McpConfigResult> {
  const existing = await readManagedFile(projectRoot, path)
  const config = existing.exists ? parseJsonConfig(existing.contents ?? "", path) : create()
  const updateResult = update(config)
  if (!updateResult.changed) {
    return updateResult.existingServer === undefined
      ? { agent, action: "exists", path }
      : { agent, action: "exists", path, existingServer: updateResult.existingServer }
  }

  const action: McpConfigAction = existing.exists ? "updated" : "created"
  if (dryRun) return { agent, action: existing.exists ? "would_update" : "would_create", path }

  const contents =
    existing.contents === undefined
      ? `${JSON.stringify(config, null, 2)}\n`
      : updateResult.edits.reduce(
          (current, edit) =>
            applyEdits(
              current,
              modify(current, edit.path, edit.value, {
                formattingOptions: {
                  eol: existing.contents?.includes("\r\n") ? "\r\n" : "\n",
                  insertFinalNewline: true,
                  insertSpaces: true,
                  tabSize: 2,
                },
              }),
            ),
          existing.contents,
        )
  const writeResult = await writeManagedFile(projectRoot, path, contents)
  return {
    agent,
    action: writeResult === "created" ? "created" : writeResult === "exists" ? "exists" : action,
    path,
    ...(updateResult.existingServer === undefined
      ? {}
      : { existingServer: updateResult.existingServer }),
  }
}

function updateClaudeConfig(
  config: JsonObject,
  server: McpServerDefinition,
  contextServer: McpServerDefinition = DEFAULT_CONTEXT_SERVER,
  options: AgentMcpConfigOptions = {},
): JsonConfigUpdate {
  const current = config.mcpServers
  let servers: JsonObject
  if (current === undefined) servers = {}
  else if (isJsonObject(current)) servers = current
  else throw new ConfigShapeError(".mcp.json", "mcpServers must be an object")

  const existing = existingServerName(servers)
  let path: string[] = []
  let value: JsonObject = {}
  const edits: { path: string[]; value: JsonObject }[] = []
  let changed = false
  if (existing === undefined && (options.includeBackend ?? true)) {
    value = serverObject(server)
    const name = serverName(server)
    servers[name] = value
    path = ["mcpServers", name]
    edits.push({ path, value })
    changed = true
  }
  const contextName = serverName(contextServer)
  if (!Object.hasOwn(servers, contextName)) {
    const contextValue = serverObject(contextServer)
    servers[contextName] = contextValue
    if (!changed) {
      value = contextValue
      path = ["mcpServers", contextName]
    }
    edits.push({ path: ["mcpServers", contextName], value: contextValue })
    changed = true
  }
  config.mcpServers = servers
  return {
    path,
    value,
    edits,
    ...(existing === undefined ? {} : { existingServer: existing }),
    changed,
  }
}

async function findExistingConfigPath(
  projectRoot: string,
  paths: readonly string[],
  fallback: string,
): Promise<string> {
  for (const path of paths) {
    if ((await readManagedFile(projectRoot, path)).exists) return path
  }
  return fallback
}

export async function ensureClaudeConfig(
  projectRoot: string,
  server: McpServerDefinition,
  dryRun: boolean,
  contextServer: McpServerDefinition = DEFAULT_CONTEXT_SERVER,
  options: AgentMcpConfigOptions = {},
): Promise<McpConfigResult> {
  const path = await findExistingConfigPath(
    projectRoot,
    [".claude/.mcp.json", ".mcp.json"],
    ".mcp.json",
  )
  return writeJsonConfig(
    projectRoot,
    "claude",
    path,
    dryRun,
    (config) => updateClaudeConfig(config, server, contextServer, options),
    () => ({}),
  )
}

function updateOpenCodeConfig(
  config: JsonObject,
  server: McpServerDefinition,
  contextServer: McpServerDefinition,
  options: AgentMcpConfigOptions = {},
): JsonConfigUpdate {
  const current = config.mcp
  let mcp: JsonObject
  if (current === undefined) mcp = { servers: {} }
  else if (isJsonObject(current)) mcp = current
  else throw new ConfigShapeError("opencode.json", "mcp must be an object")

  const currentServers = mcp.servers
  const usesLegacyShape = currentServers === undefined && Object.keys(mcp).length > 0
  let servers: JsonObject
  if (currentServers === undefined && !usesLegacyShape) {
    servers = {}
    mcp.servers = servers
  } else if (currentServers === undefined) {
    servers = mcp
  } else if (isJsonObject(currentServers)) {
    servers = currentServers
  } else {
    throw new ConfigShapeError("opencode.json", "mcp.servers must be an object")
  }

  const existing = existingServerName(servers)
  let path: string[] = []
  let value: JsonObject = {}
  const edits: { path: string[]; value: JsonObject }[] = []
  let changed = false
  const serverPath = (name: string): string[] =>
    currentServers === undefined && !usesLegacyShape
      ? ["mcp", "servers", name]
      : currentServers === undefined
        ? ["mcp", name]
        : ["mcp", "servers", name]
  if (existing === undefined && (options.includeBackend ?? true)) {
    value = openCodeServerObject(server)
    const name = serverName(server)
    servers[name] = value
    path = serverPath(name)
    edits.push({ path, value })
    changed = true
  }
  const contextName = serverName(contextServer)
  if (!Object.hasOwn(servers, contextName)) {
    const contextValue = openCodeServerObject(contextServer)
    servers[contextName] = contextValue
    if (!changed) {
      value = contextValue
      path = serverPath(contextName)
    }
    edits.push({ path: serverPath(contextName), value: contextValue })
    changed = true
  }
  config.mcp = mcp
  return {
    path,
    value,
    edits,
    ...(existing === undefined ? {} : { existingServer: existing }),
    changed,
  }
}

export async function ensureOpenCodeConfig(
  projectRoot: string,
  server: McpServerDefinition,
  dryRun: boolean,
  contextServer: McpServerDefinition = DEFAULT_CONTEXT_SERVER,
  options: AgentMcpConfigOptions = {},
): Promise<McpConfigResult> {
  const path = await findExistingConfigPath(
    projectRoot,
    [".opencode/opencode.json", ".opencode/opencode.jsonc", "opencode.json", "opencode.jsonc"],
    "opencode.json",
  )
  return writeJsonConfig(
    projectRoot,
    "opencode",
    path,
    dryRun,
    (config) => updateOpenCodeConfig(config, server, contextServer, options),
    () => ({
      $schema: "https://opencode.ai/config.json",
      mcp: { servers: {} },
    }),
  )
}
