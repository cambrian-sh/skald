import { discoverExistingMcpServer } from "../agents/discover"
import type { McpServerDefinition } from "../agents/mcp"
import { readConfiguredMcpServer } from "../config"
import {
  attestExecutableMcpServer,
  conformMcpEngine,
  ENGINE_INDEX_MODES,
  type EngineIndexMode,
  indexProjectDetailed,
  indexResponseStatus,
  locateMcpEngine,
  mcpExecutableSha256,
  resolveMcpServer,
  serveProject,
} from "../engine"
import { installManagedEngine } from "../engine/distribution"
import { defaultProjectEngineServer, installProjectEngine } from "../engine/project"
import { discoverProject } from "../project/discover"
import { recordProjectIndex } from "../project/state"
import { isTrustedMcpExecutable, trustMcpExecutable } from "../trust"
import { buildMcpServer, parseEnvironmentAssignment } from "./mcp-options"

export type EngineCommand =
  | {
      readonly kind: "engine-install"
      readonly json: boolean
      readonly root: string | undefined
      readonly packageSpec: string | undefined
      readonly upgrade: boolean
    }
  | {
      readonly kind: "engine-locate"
      readonly json: boolean
      readonly root: string | undefined
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
    }
  | {
      readonly kind: "engine-index"
      readonly json: boolean
      readonly root: string | undefined
      readonly mode: EngineIndexMode
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
    }
  | {
      readonly kind: "engine-conformance"
      readonly json: boolean
      readonly root: string | undefined
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
      readonly smoke: boolean
    }
  | {
      readonly kind: "engine-serve"
      readonly root: string | undefined
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
    }
  | { readonly kind: "error"; readonly message: string }

type MutableOptions = {
  command: string | undefined
  args: string[]
  env: Record<string, string>
}

type EngineOperationCommand = Exclude<EngineCommand, { readonly kind: "error" | "engine-install" }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseEngineCommand(args: readonly string[]): EngineCommand {
  const operation = args[0]
  if (
    operation !== "install" &&
    operation !== "locate" &&
    operation !== "index" &&
    operation !== "conformance" &&
    operation !== "serve"
  ) {
    return {
      kind: "error",
      message: "Usage: skald engine install|locate|index|conformance|serve [options]",
    }
  }
  let json = false
  let root: string | undefined
  let mode: EngineIndexMode = "fast"
  let packageSpec: string | undefined
  let upgrade = false
  let smoke = false
  const options: MutableOptions = { command: undefined, args: [], env: {} }

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--upgrade") {
      if (operation !== "install") {
        return { kind: "error", message: "--upgrade is only valid for engine install" }
      }
      upgrade = true
      continue
    }
    if (argument === "--smoke") {
      if (operation !== "conformance") {
        return { kind: "error", message: "--smoke is only valid for engine conformance" }
      }
      smoke = true
      continue
    }
    if (argument === "--package") {
      if (operation !== "install") {
        return { kind: "error", message: "--package is only valid for engine install" }
      }
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--package requires a package spec" }
      }
      packageSpec = value
      index += 1
      continue
    }
    if (argument === "--root") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--root requires a path" }
      }
      root = value
      index += 1
      continue
    }
    if (argument === "--mode") {
      if (operation !== "index") {
        return { kind: "error", message: "--mode is only valid for engine index" }
      }
      const value = args[index + 1]
      if (value === undefined || !isEngineIndexMode(value)) {
        return { kind: "error", message: "--mode must be fast, moderate, or full" }
      }
      mode = value
      index += 1
      continue
    }
    if (argument === "--mcp-command") {
      if (operation === "install") {
        return { kind: "error", message: "--mcp-command is not valid for engine install" }
      }
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--") || value.length === 0) {
        return { kind: "error", message: "--mcp-command requires a command" }
      }
      options.command = value
      index += 1
      continue
    }
    if (argument === "--mcp-arg") {
      if (operation === "install") {
        return { kind: "error", message: "--mcp-arg is not valid for engine install" }
      }
      const value = args[index + 1]
      if (value === undefined) return { kind: "error", message: "--mcp-arg requires an argument" }
      options.args.push(value)
      index += 1
      continue
    }
    if (argument === "--mcp-env") {
      if (operation === "install") {
        return { kind: "error", message: "--mcp-env is not valid for engine install" }
      }
      const value = args[index + 1]
      const assignment = value === undefined ? undefined : parseEnvironmentAssignment(value)
      if (value === undefined || value.startsWith("--") || assignment === undefined) {
        return { kind: "error", message: "--mcp-env requires KEY=VALUE" }
      }
      options.env[assignment.key] = assignment.value
      index += 1
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }

  const common = {
    root,
    mcpCommand: options.command,
    mcpArgs: options.args,
    mcpEnv: options.env,
  }
  if (operation === "install") return { kind: "engine-install", json, root, packageSpec, upgrade }
  if (operation === "locate") return { kind: "engine-locate", json, ...common }
  if (operation === "index") return { kind: "engine-index", json, mode, ...common }
  if (operation === "conformance") return { kind: "engine-conformance", json, smoke, ...common }
  return { kind: "engine-serve", ...common }
}

function isEngineIndexMode(value: string): value is EngineIndexMode {
  return ENGINE_INDEX_MODES.some((mode) => mode === value)
}

function explicitServer(command: EngineOperationCommand): McpServerDefinition | undefined {
  const hasOverride =
    command.mcpCommand !== undefined ||
    command.mcpArgs.length > 0 ||
    Object.keys(command.mcpEnv).length > 0
  return hasOverride
    ? buildMcpServer({ command: command.mcpCommand, args: command.mcpArgs, env: command.mcpEnv })
    : undefined
}

async function resolveEngine(
  command: EngineOperationCommand,
  projectRoot: string,
): Promise<McpServerDefinition> {
  const override = explicitServer(command)
  const existing = await discoverExistingMcpServer(projectRoot)
  const persisted = override === undefined ? await readConfiguredMcpServer(projectRoot) : undefined
  const configured = persisted ?? existing?.server ?? defaultProjectEngineServer(projectRoot)
  return resolveMcpServer(projectRoot, override, configured, false, {
    allowProjectLocal: true,
  })
}

export async function runEngineCommand(command: EngineCommand): Promise<number> {
  if (command.kind === "error") {
    console.error(command.message)
    return 2
  }
  if (command.kind === "engine-install") {
    try {
      const result =
        command.packageSpec === undefined
          ? await installProjectEngine(command.root ?? process.cwd(), {
              ...(command.upgrade ? { upgrade: true } : {}),
            })
          : await installManagedEngine({
              packageSpec: command.packageSpec,
              ...(command.upgrade ? { upgrade: true } : {}),
            })
      if (command.json) console.log(JSON.stringify({ command: "engine install", ...result }))
      else
        console.log(
          `${result.action === "exists" ? "Ready" : "Installed"}: ${result.path} (${result.sha256})`,
        )
      return 0
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (command.json)
        console.log(JSON.stringify({ command: "engine install", status: 1, detail }))
      else console.error(detail)
      return 1
    }
  }
  const discovery = await discoverProject(command.root ?? process.cwd())
  const server = await resolveEngine(command, discovery.root)
  if (command.kind === "engine-locate") {
    const commandPath = await locateMcpEngine(discovery.root, server.command)
    const report = {
      command: "engine locate",
      projectRoot: discovery.root,
      engine: commandPath,
      ...(commandPath === undefined ? {} : { sha256: await mcpExecutableSha256(commandPath) }),
    }
    if (command.json) console.log(JSON.stringify(report))
    else
      console.log(
        commandPath === undefined
          ? `Unresolved: ${server.command}`
          : `${commandPath} (${report.sha256})`,
      )
    return commandPath === undefined ? 1 : 0
  }
  const explicit = explicitServer(command)
  const executable = await attestExecutableMcpServer(
    discovery.root,
    server,
    explicit !== undefined || server.trust === "explicit",
  )
  if (executable === undefined) {
    const detail =
      "MCP engine is unavailable or not trusted for execution; pass --mcp-command <path> to trust a project-local engine"
    if (command.kind === "engine-index" && command.json) {
      console.log(JSON.stringify({ command: `engine ${command.kind.slice(7)}`, status: 1, detail }))
    } else {
      console.error(detail)
    }
    return 1
  }
  let trustedExecutable: McpServerDefinition | undefined
  if (explicit !== undefined) {
    await trustMcpExecutable(discovery.root, executable)
    trustedExecutable = { ...executable, trust: "explicit" }
  } else if (await isTrustedMcpExecutable(discovery.root, executable)) {
    trustedExecutable = { ...executable, trust: "explicit" }
  }
  if (trustedExecutable === undefined) {
    const detail =
      "MCP engine is not trusted for execution; pass --mcp-command <path> once to approve this binary"
    if (command.kind === "engine-index" && command.json) {
      console.log(JSON.stringify({ command: "engine index", status: 1, detail }))
    } else {
      console.error(detail)
    }
    return 1
  }
  if (command.kind === "engine-conformance") {
    const report = await conformMcpEngine(discovery.root, trustedExecutable, {
      smoke: command.smoke,
    })
    if (command.json) console.log(JSON.stringify({ command: "engine conformance", engine: report }))
    else {
      console.log(`Engine: ${report.command}`)
      console.log(`Afşin contract: ${report.compatible ? "pass" : "fail"}`)
      console.log(`Tools: ${report.tools.length}/${report.expectedTools.length}`)
      if (report.missingTools.length > 0) console.log(`Missing: ${report.missingTools.join(", ")}`)
      if (report.unexpectedTools.length > 0)
        console.log(`Additional: ${report.unexpectedTools.join(", ")}`)
      for (const failure of report.schemaFailures) console.log(`Schema: ${failure}`)
      for (const check of report.semanticChecks) {
        console.log(`Smoke ${check.status}: ${check.tool} (${check.detail})`)
      }
      console.log(report.detail)
    }
    return report.compatible ? 0 : 1
  }
  if (command.kind === "engine-index") {
    const result = await indexProjectDetailed(discovery.root, trustedExecutable, command.mode)
    let detail = result.exitCode === 0 ? undefined : result.stderr.trim() || result.stdout.trim()
    if (result.exitCode === 0) {
      const response = result.response
      const backendProject =
        isRecord(response) && typeof response["project"] === "string"
          ? response["project"]
          : undefined
      try {
        await recordProjectIndex(
          discovery.root,
          trustedExecutable,
          command.mode,
          indexResponseStatus(response),
          backendProject,
        )
      } catch (error) {
        detail = `Index completed, but Skald could not record freshness: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    if (command.json) {
      console.log(
        JSON.stringify({
          command: "engine index",
          mode: command.mode,
          status: result.exitCode,
          ...(detail === undefined ? {} : { detail }),
        }),
      )
    } else if (detail !== undefined) {
      console.error(detail)
    }
    return result.exitCode
  }
  return serveProject(discovery.root, trustedExecutable)
}
