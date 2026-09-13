import { basename, isAbsolute, resolve } from "node:path"

import { ensureCodexProjectMcpConfig } from "./codex"
import { ensureClaudeSessionHook } from "./hooks"
import { ensureClaudeConfig, ensureOpenCodeConfig } from "./json"
import { AGENT_IDS, type AgentAdapterId } from "./registry"

export const SKALD_MCP_SERVER_NAME = "skald"
export const SKALD_CONTEXT_SERVER_NAME = "skald-context"
export const LEGACY_MCP_SERVER_NAME = "codebase-memory-mcp"

export const MCP_AGENTS = AGENT_IDS
export type McpAgent = AgentAdapterId

export type McpServerDefinition = {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly serverName?: string
  readonly trust?: "explicit"
  readonly sha256?: string
}

const SENSITIVE_ENVIRONMENT_KEY = /(TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL|AUTH)/i
const PERSISTABLE_ENVIRONMENT_KEYS = new Set([
  "CBM_ALLOWED_ROOT",
  "CBM_CACHE_DIR",
  "CBM_CONFIG_DIR",
  "CBM_DIAGNOSTICS",
  "CBM_DUMP_VERIFY_MIN_RATIO",
  "CBM_KNOWLEDGE_DIR",
  "CBM_LOG_FILE",
  "CBM_LOG_LEVEL",
  "CBM_MEM_BUDGET_MB",
  "CBM_RUNTIME_DIR",
  "CBM_WORKERS",
])

export function isSensitiveMcpEnvironmentKey(key: string): boolean {
  return SENSITIVE_ENVIRONMENT_KEY.test(key)
}

export function nonPersistableMcpEnvironmentKeys(
  environment: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  return environment === undefined
    ? []
    : Object.keys(environment)
        .filter((key) => !PERSISTABLE_ENVIRONMENT_KEYS.has(key))
        .sort()
}

export const sensitiveMcpEnvironmentKeys = nonPersistableMcpEnvironmentKeys

export function persistableMcpEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (environment === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (PERSISTABLE_ENVIRONMENT_KEYS.has(key)) result[key] = value
  }
  return Object.keys(result).length === 0 ? undefined : result
}

export const DEFAULT_MCP_SERVER: McpServerDefinition = {
  command: LEGACY_MCP_SERVER_NAME,
  args: [],
}

function defaultContextServer(): McpServerDefinition {
  const bunx = Bun.which("bunx")
  if (bunx !== undefined && bunx !== null) {
    return {
      command: bunx,
      args: ["--no-install", "--bun", "@cambrian/skald", "serve"],
      serverName: SKALD_CONTEXT_SERVER_NAME,
    }
  }
  const bun = Bun.which("bun")
  if (bun !== undefined && bun !== null) {
    return {
      command: bun,
      args: ["x", "--no-install", "--bun", "@cambrian/skald", "serve"],
      serverName: SKALD_CONTEXT_SERVER_NAME,
    }
  }
  return (
    currentSkaldServer() ?? {
      command: process.execPath,
      args: ["serve"],
      serverName: SKALD_CONTEXT_SERVER_NAME,
    }
  )
}

export const DEFAULT_CONTEXT_SERVER: McpServerDefinition = defaultContextServer()

export function currentSkaldServer(): McpServerDefinition | undefined {
  const rawEntrypoint = Bun.main
  if (typeof rawEntrypoint !== "string" || rawEntrypoint.length === 0) return undefined
  const entrypoint = resolve(rawEntrypoint)
  if (!isAbsolute(entrypoint)) return undefined
  if (basename(entrypoint) === "skald") {
    return { command: process.execPath, args: ["serve"], serverName: SKALD_CONTEXT_SERVER_NAME }
  }
  if (/\.(?:c|m)?js$|\.ts$/.test(entrypoint)) {
    return {
      command: process.execPath,
      args: [entrypoint, "serve"],
      serverName: SKALD_CONTEXT_SERVER_NAME,
    }
  }
  return undefined
}

export type McpConfigAction =
  | "created"
  | "updated"
  | "exists"
  | "would_create"
  | "would_update"
  | "requires_global"

export type McpConfigResult = {
  readonly agent: McpAgent
  readonly action: McpConfigAction
  readonly path: string
  readonly existingServer?: string
  readonly note?: string
}

export type AgentMcpConfigOptions = {
  readonly includeBackend?: boolean
  readonly installHooks?: boolean
  readonly superviseBackend?: boolean
}

export function supervisedBackendServer(contextServer: McpServerDefinition): McpServerDefinition {
  const args = [...contextServer.args]
  const serveIndex = args.lastIndexOf("serve")
  if (serveIndex >= 0) args[serveIndex] = "backend"
  else args.push("backend")
  return { command: contextServer.command, args }
}

export async function ensureAgentMcpConfig(
  projectRoot: string,
  agent: McpAgent,
  server: McpServerDefinition,
  dryRun: boolean,
  contextServer?: McpServerDefinition,
  options: AgentMcpConfigOptions = {},
): Promise<McpConfigResult> {
  const includeBackend = options.includeBackend ?? true
  const effectiveContextServer = contextServer ?? DEFAULT_CONTEXT_SERVER
  const configuredServer =
    options.superviseBackend === true ? supervisedBackendServer(effectiveContextServer) : server
  const result = await (async (): Promise<McpConfigResult> => {
    switch (agent) {
      case "claude":
        return ensureClaudeConfig(projectRoot, configuredServer, dryRun, effectiveContextServer, {
          includeBackend,
        })
      case "codex":
        return ensureCodexProjectMcpConfig(projectRoot)
      case "opencode":
        return ensureOpenCodeConfig(projectRoot, configuredServer, dryRun, effectiveContextServer, {
          includeBackend,
        })
      default:
        return assertNever(agent)
    }
  })()
  const notes: string[] = []
  if (!includeBackend) {
    notes.push(
      "The backend MCP entry was not added because the engine is not trusted; pass --mcp-command to approve it.",
    )
  }
  const omittedKeys = nonPersistableMcpEnvironmentKeys(server.env)
  if (agent === "claude" && options.installHooks === true) {
    const hook = await ensureClaudeSessionHook(projectRoot, dryRun, contextServer)
    notes.push(`Claude SessionStart hook: ${hook.action} (${hook.path}).`)
  }
  if (omittedKeys.length > 0) {
    notes.push(
      `MCP environment variables were not persisted: ${omittedKeys.join(", ")}. Configure them in the agent environment.`,
    )
  }
  if (notes.length === 0) return result
  const note = notes.join(" ")
  return { ...result, note: result.note === undefined ? note : `${result.note} ${note}` }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP agent: ${JSON.stringify(value)}`)
}
