import { ConfigParseError } from "../errors"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"
import {
  DEFAULT_CONTEXT_SERVER,
  type McpConfigResult,
  type McpServerDefinition,
  persistableMcpEnvironment,
  SKALD_CONTEXT_SERVER_NAME,
} from "./mcp"

const SKALD_MCP_SERVER_NAME = "skald"
const LEGACY_MCP_SERVER_NAME = "codebase-memory-mcp"

export type CodexGlobalMcpOptions = {
  readonly configDirectory: string
  readonly displayPath: string
  readonly server: McpServerDefinition
  readonly contextServer?: McpServerDefinition
  readonly dryRun: boolean
  readonly includeBackend?: boolean
}

type TomlObject = Record<string, unknown> & { mcp_servers?: unknown }

function isTomlObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseCodexToml(contents: string, path: string): TomlObject {
  try {
    const parsed: unknown = Bun.TOML.parse(contents)
    if (!isTomlObject(parsed)) throw new ConfigParseError(path, "TOML")
    return parsed
  } catch (error) {
    if (error instanceof ConfigParseError) throw error
    throw new ConfigParseError(path, "TOML", error)
  }
}

function hasCodexServer(document: TomlObject, name: string): boolean {
  const servers = document.mcp_servers
  return isTomlObject(servers) && Object.hasOwn(servers, name)
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`
}

function codexServerBlock(server: McpServerDefinition): string {
  const name = server.serverName ?? SKALD_MCP_SERVER_NAME
  const lines = [
    `[mcp_servers.${tomlKey(name)}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args)}`,
  ]
  const environment = persistableMcpEnvironment(server.env)
  if (environment !== undefined) {
    lines.push("", `[mcp_servers.${tomlKey(name)}.env]`)
    for (const [key, value] of Object.entries(environment).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`${tomlKey(key)} = ${tomlString(value)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

export async function ensureCodexGlobalMcpConfig(
  options: CodexGlobalMcpOptions,
): Promise<McpConfigResult> {
  const path = "config.toml"
  const existing = await readManagedFile(options.configDirectory, path)
  const existingContents = existing.contents ?? ""
  const document = parseCodexToml(existingContents, options.displayPath)
  const existingServer = hasCodexServer(document, SKALD_MCP_SERVER_NAME)
    ? SKALD_MCP_SERVER_NAME
    : hasCodexServer(document, LEGACY_MCP_SERVER_NAME)
      ? LEGACY_MCP_SERVER_NAME
      : undefined
  const contextServer = options.contextServer ?? DEFAULT_CONTEXT_SERVER
  const hasContextServer = hasCodexServer(document, SKALD_CONTEXT_SERVER_NAME)
  if (existingServer !== undefined && hasContextServer) {
    return { agent: "codex", action: "exists", path: options.displayPath, existingServer }
  }

  if (options.dryRun) {
    return {
      agent: "codex",
      action: existing.exists ? "would_update" : "would_create",
      path: options.displayPath,
      ...(existingServer === undefined ? {} : { existingServer }),
    }
  }

  const blocks: string[] = []
  if (existingServer === undefined && (options.includeBackend ?? true)) {
    blocks.push(codexServerBlock(options.server))
  }
  if (!hasContextServer) blocks.push(codexServerBlock(contextServer))
  const separator = existingContents.length === 0 || existingContents.endsWith("\n") ? "" : "\n"
  const contents =
    existingContents + separator + (existingContents.length === 0 ? "" : "\n") + blocks.join("\n")
  parseCodexToml(contents, options.displayPath)
  const writeResult = await writeManagedFile(options.configDirectory, path, contents)
  return {
    agent: "codex",
    action: writeResult === "created" ? "created" : writeResult === "exists" ? "exists" : "updated",
    path: options.displayPath,
    ...(existingServer === undefined ? {} : { existingServer }),
  }
}

export async function ensureCodexProjectMcpConfig(projectRoot: string): Promise<McpConfigResult> {
  const path = ".codex/config.toml"
  const existing = await readManagedFile(projectRoot, path)
  const contents = existing.contents ?? ""
  let existingServer: string | undefined
  if (existing.exists) {
    const document = parseCodexToml(contents, path)
    existingServer = hasCodexServer(document, SKALD_MCP_SERVER_NAME)
      ? SKALD_MCP_SERVER_NAME
      : hasCodexServer(document, LEGACY_MCP_SERVER_NAME)
        ? LEGACY_MCP_SERVER_NAME
        : undefined
  }
  const note =
    existingServer === undefined
      ? "Codex CLI does not load project-local MCP configuration in this environment."
      : "A project Codex entry exists, but this Codex CLI ignores project-local MCP configuration."
  return {
    agent: "codex",
    action: "requires_global",
    path: "~/.codex/config.toml",
    ...(existingServer === undefined ? {} : { existingServer }),
    note,
  }
}
