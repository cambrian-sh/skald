import { MCP_AGENTS, type McpAgent, type McpConfigAction } from "../agents/mcp"
import type { ConfigAction } from "../config"
import { ENGINE_INDEX_MODES, type EngineIndexMode } from "../engine"
import type { ProjectDiscovery } from "../project/discover"
import type { StandardsInventory } from "../standards/discover"
import { type AgentCommand, parseAgentCommand } from "./agents"
import { type EngineCommand, parseEngineCommand } from "./engine"
import { mcpActionLabel, parseEnvironmentAssignment } from "./mcp-options"

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "backend"; readonly root: string | undefined }
  | { readonly kind: "hook-claude-session-start" }
  | { readonly kind: "serve"; readonly root: string | undefined }
  | { readonly kind: "doctor"; readonly root: string | undefined; readonly json: boolean }
  | {
      readonly kind: "context"
      readonly root: string | undefined
      readonly json: boolean
      readonly query: string | undefined
      readonly path?: string
      readonly maxChars?: number
    }
  | {
      readonly kind: "memory-record"
      readonly root: string | undefined
      readonly json: boolean
      readonly recordKind:
        | "adr"
        | "decision"
        | "observation"
        | "measurement"
        | "component"
        | "contract"
        | "investigation"
        | "research"
      readonly title: string
      readonly summary: string
      readonly sourceRefs: readonly string[]
    }
  | { readonly kind: "memory-review"; readonly root: string | undefined; readonly json: boolean }
  | {
      readonly kind: "memory-promote"
      readonly root: string | undefined
      readonly json: boolean
      readonly recordPath: string
    }
  | {
      readonly kind: "memory-reject"
      readonly root: string | undefined
      readonly json: boolean
      readonly recordPath: string
    }
  | {
      readonly kind: "knowledge-reconcile" | "knowledge-sync" | "knowledge-index"
      readonly root: string | undefined
      readonly knowledgeDirectory: string | undefined
      readonly repositories: readonly { readonly origin: string; readonly path: string }[]
      readonly write: boolean
      readonly json: boolean
      readonly mode?: EngineIndexMode
    }
  | AgentCommand
  | EngineCommand
  | {
      readonly kind: "init"
      readonly dryRun: boolean
      readonly json: boolean
      readonly root: string | undefined
      readonly knowledgeDirectory: string | undefined
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
      readonly enginePackage: string | undefined
      readonly trigger?: "manual" | "automatic" | "setup"
      readonly hooks: boolean
      readonly agents: readonly McpAgent[]
      readonly index: boolean
      readonly indexMode: EngineIndexMode
    }
  | {
      readonly kind: "setup"
      readonly dryRun: boolean
      readonly json: boolean
      readonly root: string | undefined
      readonly knowledgeDirectory: string | undefined
      readonly mcpCommand: string | undefined
      readonly mcpArgs: readonly string[]
      readonly mcpEnv: Readonly<Record<string, string>>
      readonly enginePackage: string | undefined
      readonly trigger?: "manual" | "automatic" | "setup"
      readonly hooks: boolean
      readonly agents: readonly McpAgent[]
      readonly index: boolean
      readonly indexMode: EngineIndexMode
    }

export type InitCommand = Extract<CliCommand, { readonly kind: "init" }>
export type SetupCommand = Extract<CliCommand, { readonly kind: "setup" }>

export type McpConfigReport = {
  readonly agent: McpAgent
  readonly action: McpConfigAction
  readonly path: string
  readonly existingServer?: string
  readonly note?: string
}

export type InitReport = {
  readonly command: "init" | "setup"
  readonly dryRun: boolean
  readonly projectRoot: string
  readonly gitMarker: ProjectDiscovery["gitMarker"]
  readonly instructionFiles: StandardsInventory["instructions"]
  readonly skills: StandardsInventory["skills"]
  readonly standardsTruncated: boolean
  readonly agents: readonly McpAgent[]
  readonly engine: {
    readonly command: string
    readonly sha256?: string
    readonly trust: "explicit" | "discovered" | "unresolved"
  }
  readonly configAction: ConfigAction
  readonly configPath: string
  readonly mcpConfigs: readonly McpConfigReport[]
  readonly knowledgeHooks: readonly {
    readonly repository: string
    readonly path: string
    readonly action: "created" | "updated" | "exists" | "would_create" | "would_update" | "skipped"
    readonly note?: string
  }[]
  readonly bootstrapAction: "created" | "exists" | "would_create"
  readonly contextRuntime: {
    readonly path: string
    readonly action: "created" | "updated" | "exists" | "would_create" | "unavailable"
    readonly note?: string
  }
  readonly index:
    | {
        readonly action: "skipped"
        readonly reason: "disabled" | "engine-not-found" | "engine-not-trusted"
      }
    | { readonly action: "would_index"; readonly mode: EngineIndexMode }
    | {
        readonly action: "indexed"
        readonly mode: EngineIndexMode
        readonly status: number
        readonly detail?: string
      }
}

export function helpText(): string {
  return [
    "Skald project context and memory",
    "",
    "Usage:",
    "  skald --version",
    "  skald init [--dry-run] [--root <path>] [--knowledge-dir <path>] [--json] [--no-index] [--index-mode <mode>] [--hooks]",
    "             [--mcp-arg <argument> ...] [--mcp-env KEY=VALUE ...]",
    "             [--agents claude,codex,opencode]",
    "  skald setup [init options] [--knowledge-dir <path>] [--hooks]",
    "  skald agents list [--json]",
    "  skald agents install codex --global [--dry-run] [--json]",
    "             [--mcp-command <command>] [--mcp-arg <argument> ...]",
    "             [--mcp-env KEY=VALUE ...]",
    "  skald engine install [--root <path>] [--upgrade] [--json]",
    "  skald engine install --package <spec> [--upgrade] [--json]  Legacy custom channel",
    "  skald engine locate|index|serve|conformance [--root <path>] [--json] [--smoke]",
    "             [--mode fast|moderate|full] [--mcp-command <command>]",
    "  skald doctor [--root <path>] [--json]",
    "  skald context [--root <path>] [--json] [--query <text>] [--path <path>] [--max-chars <n>]",
    "  skald memory record <kind> --title <title> --summary <summary> [--source <path> ...]",
    "             kind: adr|decision|observation|measurement|component|contract|investigation|research",
    "  skald memory review|promote <path>|reject <path> [--root <path>] [--json]",
    "  skald serve [--root <path>]    Run the project-context MCP server",
    "  skald backend [--root <path>]  Run the trusted configured structural backend",
    "  skald knowledge reconcile|sync|index [--root <path>] [--knowledge-dir <path>]",
    "             [--repo origin=/path/to/repository ...] [--write] [--json]",
    "             index also accepts [--mode fast|moderate|full]",
    "  skald hook claude-session-start    Inject bounded context into Claude Code",
    "",
    "Creates project-local Skald and MCP configuration for the selected agents.",
    "--dry-run reports changes without writing files.",
    "The default engine is Afşin's pinned native engine, installed under .skald/engine/.",
    "setup installs and verifies that engine; a custom engine requires --mcp-command.",
    "Implicit repository-local engines are never executed; pass --mcp-command to trust one.",
  ].join("\n")
}

export function parseCommand(args: readonly string[]): CliCommand {
  if (args.includes("--version") || args.includes("-v")) return { kind: "version" }
  if (args.includes("--help") || args.includes("-h")) return { kind: "help" }
  const command = args[0]
  if (command === undefined) return { kind: "help" }
  if (command === "backend") return parseBackendCommand(args.slice(1))
  if (command === "serve") return parseServeCommand(args.slice(1))
  if (command === "hook") return parseHookCommand(args.slice(1))
  if (command === "doctor") return parseDoctorCommand(args.slice(1))
  if (command === "context") return parseContextCommand(args.slice(1))
  if (command === "memory") return parseMemoryCommand(args.slice(1))
  if (command === "knowledge") return parseKnowledgeCommand(args.slice(1))
  if (command === "agents") return parseAgentCommand(args.slice(1))
  if (command === "engine") return parseEngineCommand(args.slice(1))
  if (command === "setup") {
    const parsed = parseCommand(["init", ...args.slice(1)])
    return parsed.kind === "init" ? { ...parsed, kind: "setup" } : parsed
  }
  if (command !== "init") return { kind: "error", message: `Unknown command: ${command}` }

  let dryRun = false
  let json = false
  let root: string | undefined
  let knowledgeDirectory: string | undefined
  let mcpCommand: string | undefined
  const mcpArgs: string[] = []
  const mcpEnv: Record<string, string> = {}
  let enginePackage: string | undefined
  let hooks = false
  let agents: readonly McpAgent[] = MCP_AGENTS
  let index = true
  let indexMode: EngineIndexMode = "fast"

  for (let cursor = 1; cursor < args.length; cursor += 1) {
    const argument = args[cursor]
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--no-index") {
      index = false
      continue
    }
    if (argument === "--index-mode") {
      const value = args[cursor + 1]
      if (value === undefined || !isEngineIndexMode(value)) {
        return { kind: "error", message: "--index-mode must be fast, moderate, or full" }
      }
      indexMode = value
      cursor += 1
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--root") {
      const value = args[cursor + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--root requires a path" }
      }
      root = value
      cursor += 1
      continue
    }
    if (argument === "--knowledge-dir") {
      const value = args[cursor + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--knowledge-dir requires a path" }
      }
      knowledgeDirectory = value
      cursor += 1
      continue
    }
    if (argument === "--mcp-command") {
      const value = args[cursor + 1]
      if (value === undefined || value.startsWith("--") || value.length === 0) {
        return { kind: "error", message: "--mcp-command requires a command" }
      }
      mcpCommand = value
      cursor += 1
      continue
    }
    if (argument === "--engine-package") {
      const value = args[cursor + 1]
      if (value === undefined || value.startsWith("--") || value.length === 0) {
        return { kind: "error", message: "--engine-package requires a package spec" }
      }
      enginePackage = value
      cursor += 1
      continue
    }
    if (argument === "--hooks") {
      hooks = true
      continue
    }
    if (argument === "--mcp-arg") {
      const value = args[cursor + 1]
      if (value === undefined) return { kind: "error", message: "--mcp-arg requires an argument" }
      mcpArgs.push(value)
      cursor += 1
      continue
    }
    if (argument === "--mcp-env") {
      const value = args[cursor + 1]
      const assignment = value === undefined ? undefined : parseEnvironmentAssignment(value)
      if (value === undefined || value.startsWith("--") || assignment === undefined) {
        return { kind: "error", message: "--mcp-env requires KEY=VALUE" }
      }
      mcpEnv[assignment.key] = assignment.value
      cursor += 1
      continue
    }
    if (argument === "--agents") {
      const value = args[cursor + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: "--agents requires a comma-separated agent list" }
      }
      const selected = value.split(",")
      if (selected.some((agent) => !isMcpAgent(agent))) {
        return { kind: "error", message: `Unsupported agent in --agents: ${value}` }
      }
      agents = selected.filter(isMcpAgent)
      cursor += 1
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }

  return {
    kind: "init",
    dryRun,
    json,
    root,
    knowledgeDirectory,
    mcpCommand,
    mcpArgs,
    mcpEnv,
    enginePackage,
    hooks,
    agents,
    index,
    indexMode,
  }
}

function parseBackendCommand(args: readonly string[]): CliCommand {
  const root = parseRootOnly(args)
  return isParseError(root) ? root : { kind: "backend", root: rootValue(root) }
}

function parseServeCommand(args: readonly string[]): CliCommand {
  const root = parseRootOnly(args)
  return isParseError(root) ? root : { kind: "serve", root: rootValue(root) }
}

function parseHookCommand(args: readonly string[]): CliCommand {
  return args.length === 1 && args[0] === "claude-session-start"
    ? { kind: "hook-claude-session-start" }
    : { kind: "error", message: "Usage: skald hook claude-session-start" }
}

function parseDoctorCommand(args: readonly string[]): CliCommand {
  let json = false
  const root = parseRootOnly(args, (argument) => {
    if (argument === "--json") {
      json = true
      return { consumed: 0 }
    }
    return undefined
  })
  return isParseError(root) ? root : { kind: "doctor", root: rootValue(root), json }
}

function parseContextCommand(args: readonly string[]): CliCommand {
  let json = false
  let query: string | undefined
  let path: string | undefined
  let maxChars: number | undefined
  const root = parseRootOnly(args, (argument, values) => {
    if (argument === "--json") {
      json = true
      return { consumed: 0 }
    }
    if (argument === "--query") {
      query = values.next
      return query === undefined || query.startsWith("--")
        ? { error: "--query requires a query" }
        : { consumed: 1 }
    }
    if (argument === "--path") {
      path = values.next
      return path === undefined || path.startsWith("--")
        ? { error: "--path requires a project-relative path" }
        : { consumed: 1 }
    }
    if (argument === "--max-chars") {
      const value = values.next
      const parsed = value === undefined ? Number.NaN : Number(value)
      if (
        value === undefined ||
        value.startsWith("--") ||
        !Number.isInteger(parsed) ||
        parsed < 1
      ) {
        return { error: "--max-chars requires a positive integer" }
      }
      maxChars = parsed
      return { consumed: 1 }
    }
    return undefined
  })
  if (isParseError(root)) return root
  return {
    kind: "context",
    root: rootValue(root),
    json,
    query,
    ...(path === undefined ? {} : { path }),
    ...(maxChars === undefined ? {} : { maxChars }),
  }
}

function parseMemoryCommand(args: readonly string[]): CliCommand {
  if (args[0] === "review") return parseMemoryReviewCommand(args.slice(1))
  if (args[0] === "promote" || args[0] === "reject") {
    return parseMemoryDecisionCommand(args[0], args.slice(1))
  }
  if (args[0] !== "record") {
    return {
      kind: "error",
      message: "Usage: skald memory record <kind> --title <title> --summary <summary>",
    }
  }
  const recordKind = args[1]
  if (
    recordKind !== "adr" &&
    recordKind !== "decision" &&
    recordKind !== "observation" &&
    recordKind !== "measurement" &&
    recordKind !== "component" &&
    recordKind !== "contract" &&
    recordKind !== "investigation" &&
    recordKind !== "research"
  ) {
    return {
      kind: "error",
      message:
        "Memory kind must be adr, decision, observation, measurement, component, contract, investigation, or research",
    }
  }
  let title: string | undefined
  let summary: string | undefined
  let json = false
  let root: string | undefined
  const sourceRefs: string[] = []
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--root") {
      root = args[index + 1]
      if (root === undefined || root.startsWith("--"))
        return { kind: "error", message: "--root requires a path" }
      index += 1
      continue
    }
    if (argument === "--title" || argument === "--summary" || argument === "--source") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--"))
        return { kind: "error", message: `${argument} requires a value` }
      if (argument === "--title") title = value
      else if (argument === "--summary") summary = value
      else sourceRefs.push(value)
      index += 1
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }
  if (
    title === undefined ||
    title.trim().length === 0 ||
    summary === undefined ||
    summary.trim().length === 0
  ) {
    return { kind: "error", message: "--title and --summary are required" }
  }
  return { kind: "memory-record", root, json, recordKind, title, summary, sourceRefs }
}

function parseMemoryReviewCommand(args: readonly string[]): CliCommand {
  let root: string | undefined
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
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
    return { kind: "error", message: `Unknown option: ${argument}` }
  }
  return { kind: "memory-review", root, json }
}

function parseMemoryDecisionCommand(
  kind: "promote" | "reject",
  args: readonly string[],
): CliCommand {
  const recordPath = args[0]
  if (recordPath === undefined || recordPath.startsWith("--")) {
    return { kind: "error", message: `memory ${kind} requires a session record path` }
  }
  let root: string | undefined
  let json = false
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
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
    return { kind: "error", message: `Unknown option: ${argument}` }
  }
  return { kind: kind === "promote" ? "memory-promote" : "memory-reject", root, json, recordPath }
}

function parseKnowledgeCommand(args: readonly string[]): CliCommand {
  const operation = args[0]
  if (operation !== "reconcile" && operation !== "sync" && operation !== "index") {
    return { kind: "error", message: "Usage: skald knowledge reconcile|sync|index [options]" }
  }
  let root: string | undefined
  let knowledgeDirectory: string | undefined
  let write = false
  let json = false
  let mode: EngineIndexMode = "fast"
  const repositories: { origin: string; path: string }[] = []
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--write") {
      if (operation === "reconcile") {
        return { kind: "error", message: "--write is not valid for knowledge reconcile" }
      }
      write = true
      continue
    }
    if (argument === "--mode") {
      if (operation !== "index") {
        return { kind: "error", message: "--mode is only valid for knowledge index" }
      }
      const value = args[index + 1]
      if (value === undefined || !isEngineIndexMode(value)) {
        return { kind: "error", message: "--mode must be fast, moderate, or full" }
      }
      mode = value
      index += 1
      continue
    }
    if (argument === "--root" || argument === "--knowledge-dir" || argument === "--repo") {
      const value = args[index + 1]
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: `${argument} requires a value` }
      }
      if (argument === "--root") root = value
      else if (argument === "--knowledge-dir") knowledgeDirectory = value
      else {
        const separator = value.indexOf("=")
        if (separator <= 0 || separator === value.length - 1) {
          return { kind: "error", message: "--repo requires origin=/path/to/repository" }
        }
        repositories.push({ origin: value.slice(0, separator), path: value.slice(separator + 1) })
      }
      index += 1
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }
  return {
    kind:
      operation === "sync"
        ? "knowledge-sync"
        : operation === "index"
          ? "knowledge-index"
          : "knowledge-reconcile",
    root,
    knowledgeDirectory,
    repositories,
    write,
    json,
    ...(operation === "index" ? { mode } : {}),
  }
}

type RootParseResult =
  | { readonly root: string | undefined }
  | { readonly kind: "error"; readonly message: string }

type ExtraParseResult = { readonly consumed: number } | { readonly error: string }

function rootValue(value: RootParseResult): string | undefined {
  return "root" in value ? value.root : undefined
}

function isParseError(
  value: RootParseResult,
): value is { readonly kind: "error"; readonly message: string } {
  return "kind" in value
}

function parseRootOnly(
  args: readonly string[],
  extra?: (
    argument: string,
    values: { readonly next: string | undefined },
  ) => ExtraParseResult | undefined,
): RootParseResult {
  let root: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) return { kind: "error", message: "Unexpected end of arguments" }
    if (argument === "--root") {
      root = args[index + 1]
      if (root === undefined || root.startsWith("--"))
        return { kind: "error", message: "--root requires a path" }
      index += 1
      continue
    }
    const extraResult = extra?.(argument, { next: args[index + 1] })
    if (extraResult !== undefined) {
      if ("error" in extraResult) return { kind: "error", message: extraResult.error }
      index += extraResult.consumed
      continue
    }
    return { kind: "error", message: `Unknown option: ${argument}` }
  }
  return { root }
}

function isEngineIndexMode(value: string): value is EngineIndexMode {
  return ENGINE_INDEX_MODES.some((mode) => mode === value)
}

function isMcpAgent(value: string): value is McpAgent {
  return MCP_AGENTS.some((agent) => agent === value)
}

function configActionLabel(action: ConfigAction): string {
  switch (action) {
    case "created":
      return "Created"
    case "updated":
      return "Updated"
    case "exists":
      return "Preserved"
    case "would_create":
      return "Would create"
    case "would_update":
      return "Would update"
    default:
      return assertNever(action)
  }
}

export function printHumanReport(report: InitReport): void {
  console.log(`Project: ${report.projectRoot}`)
  console.log(`Instructions: ${report.instructionFiles.length}`)
  for (const file of report.instructionFiles) console.log(`  ${file.path} (${file.source})`)
  console.log(`Skills: ${report.skills.length}`)
  for (const skill of report.skills) console.log(`  ${skill.path} (${skill.source})`)
  if (report.standardsTruncated) console.log("Standards discovery reached its safety limit")
  console.log(`Agents: ${report.agents.join(", ")}`)
  console.log(
    `Engine: ${report.engine.command} (${report.engine.trust}${report.engine.sha256 === undefined ? "" : `, sha256 ${report.engine.sha256}`})`,
  )
  console.log(`${configActionLabel(report.configAction)}: ${report.configPath}`)
  for (const mcp of report.mcpConfigs) {
    const legacy = mcp.existingServer === undefined ? "" : ` (${mcp.existingServer})`
    const note = mcp.note === undefined ? "" : ` - ${mcp.note}`
    console.log(`${mcpActionLabel(mcp.action)}: ${mcp.agent} ${mcp.path}${legacy}${note}`)
  }
  for (const hook of report.knowledgeHooks) {
    const label =
      hook.action === "created"
        ? "Created"
        : hook.action === "updated"
          ? "Updated"
          : hook.action === "exists"
            ? "Preserved"
            : hook.action === "would_create"
              ? "Would create"
              : hook.action === "would_update"
                ? "Would update"
                : "Skipped"
    console.log(
      `${label}: ${hook.repository}/${hook.path}${hook.note === undefined ? "" : ` - ${hook.note}`}`,
    )
  }
  console.log(
    report.bootstrapAction === "exists"
      ? "Preserved: .skald/context.md"
      : report.bootstrapAction === "created"
        ? "Created: .skald/context.md"
        : "Would create: .skald/context.md",
  )
  console.log(
    report.contextRuntime.action === "exists"
      ? `Preserved: ${report.contextRuntime.path}`
      : report.contextRuntime.action === "created"
        ? `Created: ${report.contextRuntime.path}`
        : report.contextRuntime.action === "updated"
          ? `Updated: ${report.contextRuntime.path}`
          : report.contextRuntime.action === "would_create"
            ? `Would create: ${report.contextRuntime.path}`
            : `Unavailable: ${report.contextRuntime.path}`,
  )
  if (report.contextRuntime.note !== undefined) {
    console.log(`Context runtime detail: ${report.contextRuntime.note}`)
  }
  if (report.index.action === "skipped") console.log(`Index: skipped (${report.index.reason})`)
  else if (report.index.action === "would_index")
    console.log(`Index: would run (${report.index.mode})`)
  else
    console.log(
      `Index: ${report.index.status === 0 ? "completed" : "failed"} (${report.index.mode})`,
    )
  if (report.index.action === "indexed" && report.index.detail !== undefined) {
    console.log(`Index detail: ${report.index.detail}`)
  }
  if (report.dryRun) console.log("Dry run: no files changed")
}

function assertNever(value: never): never {
  throw new Error(`Unexpected CLI value: ${JSON.stringify(value)}`)
}
