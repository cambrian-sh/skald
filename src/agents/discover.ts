import { type ParseError, parse } from "jsonc-parser"
import { ConfigParseError, ConfigShapeError } from "../errors"
import { readManagedFile } from "../fs/safe-file"
import {
  LEGACY_MCP_SERVER_NAME,
  type McpServerDefinition,
  persistableMcpEnvironment,
  SKALD_MCP_SERVER_NAME,
} from "./mcp"

type JsonObject = Record<string, unknown> & {
  command?: unknown
  args?: unknown
  env?: unknown
  environment?: unknown
  mcpServers?: unknown
  mcp?: unknown
  servers?: unknown
}
type AgentKind = "claude" | "opencode"

export type ExistingMcpServer = {
  readonly agent: AgentKind
  readonly path: string
  readonly serverName: string
  readonly server: McpServerDefinition
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(contents: string, path: string): JsonObject {
  const errors: ParseError[] = []
  const value: unknown = parse(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ConfigParseError(path, "JSON or JSONC")
  if (!isObject(value)) throw new ConfigShapeError(path, "root must be an object")
  return value
}

function stringArray(value: unknown, path: string, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigShapeError(path, `${field} must be an array of strings`)
  }
  return value
}

function stringMap(
  value: unknown,
  path: string,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new ConfigShapeError(path, `${field} must be an object`)
  const entries = Object.entries(value)
  const result: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (typeof item !== "string")
      throw new ConfigShapeError(path, `${field} values must be strings`)
    result[key] = item
  }
  return result
}

function serverDefinition(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
  serverName: string,
): McpServerDefinition {
  const persistableEnvironment = persistableMcpEnvironment(env)
  return persistableEnvironment === undefined
    ? { command, args, serverName }
    : { command, args, env: persistableEnvironment, serverName }
}

function claudeServer(value: unknown, path: string, serverName: string): McpServerDefinition {
  if (!isObject(value) || typeof value.command !== "string") {
    throw new ConfigShapeError(path, "MCP server command must be a string")
  }
  const args = value.args === undefined ? [] : stringArray(value.args, path, "args")
  const env = stringMap(value.env, path, "env")
  return serverDefinition(value.command, args, env, serverName)
}

function openCodeServer(value: unknown, path: string, serverName: string): McpServerDefinition {
  if (!isObject(value)) throw new ConfigShapeError(path, "MCP server must be an object")
  const command = stringArray(value.command, path, "command")
  const first = command[0]
  if (first === undefined || first.length === 0) {
    throw new ConfigShapeError(path, "MCP server command must not be empty")
  }
  const env = stringMap(value.environment, path, "environment")
  return serverDefinition(first, command.slice(1), env, serverName)
}

function findNamedServer(
  servers: JsonObject,
  agent: AgentKind,
  path: string,
): ExistingMcpServer | undefined {
  const serverName = Object.hasOwn(servers, SKALD_MCP_SERVER_NAME)
    ? SKALD_MCP_SERVER_NAME
    : Object.hasOwn(servers, LEGACY_MCP_SERVER_NAME)
      ? LEGACY_MCP_SERVER_NAME
      : undefined
  if (serverName === undefined) return undefined
  const value = servers[serverName]
  const server =
    agent === "claude"
      ? claudeServer(value, path, serverName)
      : openCodeServer(value, path, serverName)
  return { agent, path, serverName, server }
}

function findClaudeServer(config: JsonObject, path: string): ExistingMcpServer | undefined {
  const servers = config.mcpServers
  if (servers === undefined) return undefined
  if (!isObject(servers)) throw new ConfigShapeError(path, "mcpServers must be an object")
  return findNamedServer(servers, "claude", path)
}

function findOpenCodeServer(config: JsonObject, path: string): ExistingMcpServer | undefined {
  const mcp = config.mcp
  if (mcp === undefined) return undefined
  if (!isObject(mcp)) throw new ConfigShapeError(path, "mcp must be an object")
  const servers = mcp.servers
  if (servers !== undefined) {
    if (!isObject(servers)) throw new ConfigShapeError(path, "mcp.servers must be an object")
    return findNamedServer(servers, "opencode", path)
  }
  return findNamedServer(mcp, "opencode", path)
}

export async function discoverExistingMcpServer(
  projectRoot: string,
): Promise<ExistingMcpServer | undefined> {
  const candidates: readonly { readonly agent: AgentKind; readonly path: string }[] = [
    { agent: "claude", path: ".claude/.mcp.json" },
    { agent: "claude", path: ".mcp.json" },
    { agent: "opencode", path: ".opencode/opencode.json" },
    { agent: "opencode", path: ".opencode/opencode.jsonc" },
    { agent: "opencode", path: "opencode.json" },
    { agent: "opencode", path: "opencode.jsonc" },
  ]
  for (const candidate of candidates) {
    const existing = await readManagedFile(projectRoot, candidate.path)
    if (!existing.exists) continue
    const config = parseJson(existing.contents ?? "", candidate.path)
    const server =
      candidate.agent === "claude"
        ? findClaudeServer(config, candidate.path)
        : findOpenCodeServer(config, candidate.path)
    if (server !== undefined) return server
  }
  return undefined
}
