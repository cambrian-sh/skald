import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { ensureCodexGlobalMcpConfig } from "../agents/codex"
import {
  currentSkaldServer,
  DEFAULT_CONTEXT_SERVER,
  type McpConfigResult,
  type McpServerDefinition,
  supervisedBackendServer,
} from "../agents/mcp"
import { AGENT_ADAPTERS } from "../agents/registry"
import { attestExecutableMcpServer, prepareMcpServer, resolveMcpServer } from "../engine"
import { isTrustedMcpExecutable, trustKnowledgeDirectory, trustMcpExecutable } from "../trust"
import {
  buildMcpServer,
  environmentValue,
  mcpActionLabel,
  parseEnvironmentAssignment,
} from "./mcp-options"

export type AgentCommand =
  | { readonly kind: "agents-list"; readonly json: boolean }
  | {
      readonly kind: "agents-install"
      readonly agent: "codex"
      readonly dryRun: boolean
      readonly json: boolean
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
    }
  | { readonly kind: "error"; readonly message: string }

type AgentInstallReport = {
  readonly command: "agents install"
  readonly dryRun: boolean
  readonly installation: McpConfigResult
}

export function parseAgentCommand(args: readonly string[]): AgentCommand {
  if (args[0] === "list") {
    return args.length === 1
      ? { kind: "agents-list", json: false }
      : args.length === 2 && args[1] === "--json"
        ? { kind: "agents-list", json: true }
        : { kind: "error", message: "Usage: skald agents list [--json]" }
  }
  if (args[0] !== "install") {
    return { kind: "error", message: "Usage: skald agents list|install codex --global" }
  }
  if (args[1] !== "codex") {
    return { kind: "error", message: "Only the Codex global installer is available currently" }
  }

  let dryRun = false
  let json = false
  let global = false
  let mcpCommand: string | undefined
  const mcpArgs: string[] = []
  const mcpEnv: Record<string, string> = {}

  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--global") {
      global = true
      continue
    }
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--mcp-command") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--") || value.length === 0) {
        return { kind: "error", message: "--mcp-command requires a command" }
      }
      mcpCommand = value
      index += 1
      continue
    }
    if (argument === "--mcp-arg") {
      const value = args[index + 1]
      if (value === undefined) {
        return { kind: "error", message: "--mcp-arg requires an argument" }
      }
      mcpArgs.push(value)
      index += 1
      continue
    }
    if (argument === "--mcp-env") {
      const value = args[index + 1]
      const assignment = value === undefined ? undefined : parseEnvironmentAssignment(value)
      if (value === undefined || value.startsWith("--") || assignment === undefined) {
        return { kind: "error", message: "--mcp-env requires KEY=VALUE" }
      }
      mcpEnv[assignment.key] = assignment.value
      index += 1
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }

  if (!global) return { kind: "error", message: "Codex installation requires --global" }
  return { kind: "agents-install", agent: "codex", dryRun, json, mcpCommand, mcpArgs, mcpEnv }
}

export function runAgentList(
  command: Extract<AgentCommand, { readonly kind: "agents-list" }>,
): number {
  if (command.json) console.log(JSON.stringify({ agents: AGENT_ADAPTERS }))
  else {
    for (const adapter of AGENT_ADAPTERS) {
      console.log(
        `${adapter.name} (${adapter.id}): ${adapter.capabilities.join(", ")}; hooks ${adapter.hooks}`,
      )
    }
  }
  return 0
}

export async function runAgentInstall(
  command: Extract<AgentCommand, { readonly kind: "agents-install" }>,
): Promise<number> {
  const override = buildMcpServer({
    command: command.mcpCommand,
    args: command.mcpArgs,
    env: command.mcpEnv,
  })
  const resolvedServer: McpServerDefinition = await resolveMcpServer(
    process.cwd(),
    override,
    undefined,
    true,
    { allowProjectLocal: command.mcpCommand !== undefined },
  )
  const attestedServer = await attestExecutableMcpServer(process.cwd(), resolvedServer, true)
  const explicitKnowledge = override?.env?.["CBM_KNOWLEDGE_DIR"]
  if (!command.dryRun && explicitKnowledge !== undefined) {
    await trustKnowledgeDirectory(process.cwd(), explicitKnowledge)
  }
  let preparedServer: McpServerDefinition | undefined
  let trustedServer: McpServerDefinition | undefined
  if (attestedServer !== undefined) {
    const explicitlyTrusted = override !== undefined
    if (explicitlyTrusted) {
      preparedServer = await prepareMcpServer(
        process.cwd(),
        { ...attestedServer, trust: "explicit" },
        !command.dryRun,
      )
    }
    if (override !== undefined) {
      if (!command.dryRun) await trustMcpExecutable(process.cwd(), preparedServer ?? attestedServer)
      trustedServer = { ...(preparedServer ?? attestedServer), trust: "explicit" }
    } else if (await isTrustedMcpExecutable(process.cwd(), attestedServer)) {
      trustedServer = { ...attestedServer, trust: "explicit" }
      preparedServer = await prepareMcpServer(process.cwd(), trustedServer, !command.dryRun)
      trustedServer = { ...preparedServer, trust: "explicit" }
    }
  }
  const server =
    trustedServer === undefined
      ? {
          command: (attestedServer ?? resolvedServer).command,
          args: [...(attestedServer ?? resolvedServer).args],
          ...((attestedServer ?? resolvedServer).env === undefined
            ? {}
            : { env: { ...(attestedServer ?? resolvedServer).env } }),
          ...((attestedServer ?? resolvedServer).serverName === undefined
            ? {}
            : { serverName: (attestedServer ?? resolvedServer).serverName }),
        }
      : trustedServer
  const contextServer = currentSkaldServer() ?? DEFAULT_CONTEXT_SERVER
  const configuredServer =
    trustedServer === undefined ? server : supervisedBackendServer(contextServer)
  const configuredHome = environmentValue("CODEX_HOME")?.trim()
  const configDirectory =
    configuredHome === undefined || configuredHome.length === 0
      ? join(homedir(), ".codex")
      : resolve(configuredHome)
  const installationResult = await ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath:
      configuredHome === undefined || configuredHome.length === 0
        ? "~/.codex/config.toml"
        : "$CODEX_HOME/config.toml",
    server: configuredServer,
    contextServer,
    dryRun: command.dryRun,
    includeBackend: trustedServer !== undefined,
  })
  const installation =
    trustedServer === undefined
      ? {
          ...installationResult,
          note:
            installationResult.note === undefined
              ? "The backend MCP entry was not added because the engine is not trusted; pass --mcp-command to approve it."
              : `${installationResult.note} The backend MCP entry was not added because the engine is not trusted; pass --mcp-command to approve it.`,
        }
      : installationResult
  const report: AgentInstallReport = {
    command: "agents install",
    dryRun: command.dryRun,
    installation,
  }

  if (command.json) console.log(JSON.stringify(report))
  else {
    const existing =
      installation.existingServer === undefined ? "" : ` (${installation.existingServer})`
    console.log(`${mcpActionLabel(installation.action)}: codex ${installation.path}${existing}`)
    if (installation.note !== undefined) console.log(installation.note)
    if (command.dryRun) console.log("Dry run: no files changed")
  }
  return 0
}
