import { basename, dirname, relative, resolve, sep } from "node:path"
import { discoverExistingMcpServer } from "../agents/discover"
import type { McpServerDefinition } from "../agents/mcp"
import { readConfiguredMcpServer, readProjectManifest } from "../config"
import { diagnoseProject } from "../doctor"
import {
  attestExecutableMcpServer,
  ENGINE_INDEX_MODES,
  type EngineIndexMode,
  indexProjectDetailed,
  indexResponseStatus,
  type McpSessionRequest,
  type McpToolRequest,
  runMcpSession,
  runMcpTools,
} from "../engine"
import { readManagedFile } from "../fs/safe-file"
import { reconcileKnowledge } from "../knowledge/reconcile"
import {
  discoverProjectKnowledge,
  isKnowledgeActive,
  type KnowledgeEntry,
  manifestKnowledgeDirectory,
  recordKnowledge,
} from "../knowledge/store"
import {
  assessProjectFreshness,
  currentGitSnapshot,
  type ProjectIndexRun,
  readProjectState,
  recordProjectIndex,
} from "../project/state"
import { discoverStandards } from "../standards/discover"
import { isTrustedKnowledgeDirectory, isTrustedMcpExecutable } from "../trust"
import { SKALD_VERSION } from "../version"
import type {
  ContextBundle,
  ContextItem,
  KnowledgeRecordInput,
  KnowledgeRecordKind,
} from "./contract"
import { DEFAULT_CONTEXT_MAX_CHARS, selectContextItems } from "./rank"

type JsonRpcResponse = {
  readonly jsonrpc: "2.0"
  readonly id: unknown
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

const SERVER_INFO = { name: "skald-context", version: SKALD_VERSION }
const MAX_MCP_BUFFER_CHARS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function recordKind(value: unknown): KnowledgeRecordKind | undefined {
  return value === "adr" ||
    value === "decision" ||
    value === "observation" ||
    value === "measurement" ||
    value === "component" ||
    value === "contract" ||
    value === "investigation" ||
    value === "research"
    ? value
    : undefined
}

function sourceRefs(args: Record<string, unknown>): readonly string[] | undefined {
  const value = args["sourceRefs"]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("sourceRefs must be an array of strings")
  }
  return value
}

function maxItems(args: Record<string, unknown>): number {
  const value = args["maxItems"]
  if (typeof value !== "number" || !Number.isFinite(value)) return 20
  return Math.max(1, Math.min(50, Math.floor(value)))
}

function contextMaxChars(requested?: number): number {
  const configured = requested ?? Number.parseInt(process.env["SKALD_CONTEXT_MAX_CHARS"] ?? "", 10)
  if (!Number.isFinite(configured)) return DEFAULT_CONTEXT_MAX_CHARS
  return Math.max(4_000, Math.min(1_000_000, Math.floor(configured)))
}

function contextScope(projectRoot: string, requested: string | undefined): string | undefined {
  if (requested === undefined) return undefined
  const absolute = resolve(projectRoot, requested)
  const child = relative(resolve(projectRoot), absolute)
  if (child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error("path must stay within the project root")
  }
  return child === "" ? "." : child.replaceAll("\\", "/")
}

function appliesToScope(instructionPath: string, scope: string | undefined): boolean {
  if (scope === undefined) return true
  const directory = dirname(instructionPath).replaceAll("\\", "/")
  const child = relative(directory, scope).replaceAll("\\", "/")
  return child === "" || (child !== ".." && !child.startsWith("../"))
}

function knowledgeItem(entry: KnowledgeEntry): ContextBundle["items"][number] {
  return {
    kind: "knowledge",
    title: entry.title,
    summary: entry.summary,
    sourceRefs: [entry.path],
    authority: entry.authority,
    freshness: entry.freshness,
    confidence: entry.authority === "canonical" ? "high" : "medium",
  }
}

type KnowledgeDirectorySelection = {
  readonly directory: string | undefined
  readonly warning?: string
}

async function configuredKnowledgeDirectory(
  projectRoot: string,
): Promise<KnowledgeDirectorySelection> {
  const manifest = await readProjectManifest(projectRoot)
  const existing = await discoverExistingMcpServer(projectRoot)
  const persisted = await readConfiguredMcpServer(projectRoot)
  const directory =
    manifestKnowledgeDirectory(manifest) ??
    existing?.server.env?.["CBM_KNOWLEDGE_DIR"] ??
    persisted?.env?.["CBM_KNOWLEDGE_DIR"] ??
    process.env["CBM_KNOWLEDGE_DIR"]
  if (directory === undefined || (await isTrustedKnowledgeDirectory(projectRoot, directory))) {
    return { directory }
  }
  return {
    directory: undefined,
    warning:
      "External knowledge directory is not trusted; pass --mcp-env CBM_KNOWLEDGE_DIR=<path> to approve it",
  }
}

async function configuredBackend(projectRoot: string): Promise<McpServerDefinition | undefined> {
  const manifest = await readProjectManifest(projectRoot)
  const persisted = await readConfiguredMcpServer(projectRoot)
  if (persisted !== undefined) return persisted
  const existing = await discoverExistingMcpServer(projectRoot)
  if (existing !== undefined) return existing.server
  if (manifest === undefined) return undefined
  return {
    command: manifest.backend.command,
    args: [...manifest.backend.args],
    ...(manifest.backend.env === undefined ? {} : { env: { ...manifest.backend.env } }),
    ...(manifest.backend.serverName === undefined
      ? {}
      : { serverName: manifest.backend.serverName }),
    ...(manifest.backend.sha256 === undefined ? {} : { sha256: manifest.backend.sha256 }),
  }
}

function responseSummary(value: unknown): string {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
  return serialized.length > 4000 ? `${serialized.slice(0, 4000)}\n[truncated]` : serialized
}

function backendProject(
  value: unknown,
  projectRoot: string,
): { readonly name: string; readonly rootPath: string } | undefined {
  if (!isRecord(value) || !Array.isArray(value["projects"])) return undefined
  for (const candidate of value["projects"]) {
    if (
      isRecord(candidate) &&
      typeof candidate["name"] === "string" &&
      candidate["root_path"] === projectRoot
    ) {
      return { name: candidate["name"], rootPath: projectRoot }
    }
  }
  return undefined
}

type AdvertisedTool = {
  readonly name: string
  readonly inputSchema?: unknown
}

type ToolCatalog = ReadonlyMap<string, AdvertisedTool>

function advertisedTools(
  result: { readonly exitCode: number; readonly response: unknown } | undefined,
): ToolCatalog | undefined {
  if (result === undefined || result.exitCode !== 0 || !isRecord(result.response)) return undefined
  const tools = result.response["tools"]
  if (!Array.isArray(tools)) return undefined
  const catalog = new Map<string, AdvertisedTool>()
  for (const tool of tools) {
    if (isRecord(tool) && typeof tool["name"] === "string") {
      catalog.set(tool["name"], {
        name: tool["name"],
        ...(Object.hasOwn(tool, "inputSchema") ? { inputSchema: tool["inputSchema"] } : {}),
      })
    }
  }
  return catalog
}

function toolArguments(
  catalog: ToolCatalog | undefined,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const schema = catalog?.get(tool)?.inputSchema
  if (!isRecord(schema) || !isRecord(schema["properties"])) return args
  const properties = schema["properties"]
  return Object.fromEntries(Object.entries(args).filter(([key]) => Object.hasOwn(properties, key)))
}

function toolAccepts(
  catalog: ToolCatalog | undefined,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  knownCodeGraph: boolean,
): boolean {
  if (catalog === undefined) return knownCodeGraph
  const descriptor = catalog.get(tool)
  if (descriptor === undefined) return false
  const schema = descriptor.inputSchema
  if (!isRecord(schema) || !Array.isArray(schema["required"])) return true
  return schema["required"].every((key) => typeof key === "string" && Object.hasOwn(args, key))
}

function backendCoverageWarning(value: unknown): string | undefined {
  if (!isRecord(value)) return "backend coverage metadata was not returned"
  if (indexResponseStatus(value) === "degraded")
    return "backend index reports skipped or partial files"
  const statuses: string[] = []
  for (const key of ["paths", "scopes"]) {
    const entries = value[key]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (
        isRecord(entry) &&
        typeof entry["status"] === "string" &&
        entry["status"] !== "no_recorded_issue"
      ) {
        statuses.push(entry["status"])
      }
    }
  }
  return statuses.length === 0
    ? undefined
    : `backend coverage reports ${[...new Set(statuses)].join(", ")}`
}

function backendResultsTruncated(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value["has_more"] === true) return true
  return (
    typeof value["total"] === "number" &&
    typeof value["returned"] === "number" &&
    value["total"] > value["returned"]
  )
}

async function backendContext(
  projectRoot: string,
  server: McpServerDefinition,
  query: string | undefined,
  scope: string | undefined,
  freshness: ContextBundle["freshness"],
): Promise<{ readonly item?: ContextItem; readonly warnings?: readonly string[] }> {
  const discoveryRequests: readonly McpSessionRequest[] = [
    { kind: "tool", tool: "list_projects" },
    { kind: "method", method: "tools/list" },
  ]
  const [projects, catalog] = await runMcpSession(projectRoot, server, discoveryRequests)
  if (projects === undefined) {
    return { warnings: ["Backend context unavailable: list_projects produced no result"] }
  }
  if (projects.exitCode !== 0) {
    return {
      warnings: [
        `Backend context unavailable: ${projects.stderr.trim() || "list_projects failed"}`,
      ],
    }
  }
  const project = backendProject(projects.response, projectRoot)
  if (project === undefined) {
    return { warnings: ["Backend context unavailable: this project is not indexed"] }
  }
  const knownCodeGraph = basename(server.command).startsWith("codebase-memory-mcp")
  const tools = advertisedTools(catalog)
  const supports = (tool: string, args: Readonly<Record<string, unknown>>): boolean => {
    const adapted = toolArguments(tools, tool, args)
    return toolAccepts(tools, tool, adapted, knownCodeGraph)
  }
  const pathFilter =
    knownCodeGraph && scope !== undefined && scope !== "."
      ? `^${scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`
      : undefined
  const filePattern = scope === undefined || scope === "." ? undefined : `${scope}/**`
  const requests: McpToolRequest[] = []
  const addRequest = (tool: string, args: Readonly<Record<string, unknown>>): void => {
    const adapted = toolArguments(tools, tool, args)
    if (!supports(tool, adapted)) return
    requests.push({ tool, arguments: adapted })
  }
  addRequest("index_status", { project: project.name })
  addRequest("check_index_coverage", { project: project.name, scopes: [scope ?? "."] })
  if (query === undefined) {
    addRequest("get_architecture", {
      project: project.name,
      aspects: ["overview"],
      ...(knownCodeGraph && scope !== undefined ? { path: scope } : {}),
    })
  } else {
    addRequest("search_graph", {
      project: project.name,
      query,
      format: "json",
      limit: 20,
      ...(filePattern === undefined ? {} : { file_pattern: filePattern }),
    })
    addRequest("search_code", {
      project: project.name,
      pattern: query,
      mode: "full",
      limit: 20,
      ...(pathFilter === undefined ? {} : { path_filter: pathFilter }),
    })
  }
  if (requests.length === 0) {
    return {
      warnings: [
        query === undefined
          ? "Backend context unavailable: no architecture capability was advertised"
          : "Backend context unavailable: no compatible search capability was advertised",
      ],
    }
  }
  const results = await runMcpTools(projectRoot, server, requests)
  const metadataTools = new Set(["index_status", "check_index_coverage"])
  const successful = results
    .map((result, index) => ({ result, request: requests[index] }))
    .filter(
      ({ result, request }) => result.exitCode === 0 && !metadataTools.has(request?.tool ?? ""),
    )
  const warnings: string[] = []
  for (const [index, request] of requests.entries()) {
    if (request.tool !== "index_status" && request.tool !== "check_index_coverage") continue
    const result = results[index]
    if (result === undefined) continue
    if (result.exitCode !== 0) {
      warnings.push(`${request.tool} unavailable: ${result.stderr.trim() || "request failed"}`)
      continue
    }
    const warning = backendCoverageWarning(result.response)
    if (warning !== undefined) warnings.push(`${request.tool}: ${warning}`)
  }
  if (successful.length === 0) {
    const detail = results
      .map((result, index) =>
        metadataTools.has(requests[index]?.tool ?? "") ? "" : result.stderr.trim(),
      )
      .find((message) => message.length > 0)
    warnings.push(`Backend context unavailable: ${detail ?? "graph query failed"}`)
    return { warnings }
  }
  const summary = successful
    .map(({ result, request }) => {
      const tool = request?.tool ?? "backend"
      return `${tool}:\n${responseSummary(result.response)}`
    })
    .join("\n\n")
  for (const { result, request } of successful) {
    if (backendResultsTruncated(result.response)) {
      warnings.push(`${request?.tool ?? "backend"}: additional results were omitted`)
    }
  }
  return {
    item: {
      kind: "architecture",
      title: query === undefined ? "Code graph overview" : `Code graph matches: ${query}`,
      summary,
      sourceRefs: successful.map(
        ({ request }) =>
          `mcp://${server.serverName ?? basename(server.command)}#${request?.tool ?? "query"}`,
      ),
      authority: "derived",
      freshness:
        freshness.status === "fresh"
          ? "fresh"
          : freshness.status === "unknown"
            ? "unknown"
            : "stale",
      confidence: knownCodeGraph ? "high" : "medium",
    },
    ...(warnings.length === 0 ? {} : { warnings }),
  }
}

function engineIndexMode(value: unknown): EngineIndexMode {
  if (typeof value === "string" && ENGINE_INDEX_MODES.some((mode) => mode === value)) {
    return value as EngineIndexMode
  }
  return "fast"
}

export async function refreshProject(
  projectRoot: string,
  mode: EngineIndexMode,
  trigger: ProjectIndexRun["trigger"] = "manual",
): Promise<ContextBundle["freshness"]> {
  const backend = await configuredBackend(projectRoot)
  if (backend === undefined) throw new Error("No configured MCP engine is available")
  const attested = await attestExecutableMcpServer(projectRoot, backend, true)
  if (attested === undefined || !(await isTrustedMcpExecutable(projectRoot, attested))) {
    throw new Error("MCP engine is unavailable or requires explicit trust before execution")
  }
  const executable = { ...attested, trust: "explicit" as const }
  const result = await indexProjectDetailed(projectRoot, executable, mode)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "MCP engine index failed")
  }
  const response = isRecord(result.response) ? result.response : undefined
  const status = indexResponseStatus(response)
  const backendProject = typeof response?.["project"] === "string" ? response["project"] : undefined
  await recordProjectIndex(projectRoot, executable, mode, status, backendProject, trigger)
  const stateRead = await readProjectState(projectRoot)
  const current = assessProjectFreshness(stateRead.state, await currentGitSnapshot(projectRoot), {
    command: executable.command,
    sha256: executable.sha256,
  })
  return {
    status: current.status,
    ...(current.currentRevision === undefined ? {} : { currentRevision: current.currentRevision }),
    ...(current.indexedRevision === undefined ? {} : { indexedRevision: current.indexedRevision }),
    workingTree: current.workingTree,
    detail: current.detail,
  }
}

type FileExcerptResult = {
  readonly summary: string
  readonly warning?: string
}

async function fileExcerpt(
  projectRoot: string,
  path: string,
  fallback: string,
): Promise<FileExcerptResult> {
  try {
    const file = await readManagedFile(projectRoot, path)
    if (!file.exists || file.contents === undefined) {
      return { summary: fallback, warning: `Context source is no longer available: ${path}` }
    }
    const excerpt = file.contents.trim()
    return {
      summary: excerpt.length > 4000 ? `${excerpt.slice(0, 4000)}\n[truncated]` : excerpt,
      ...(excerpt.length > 4000 ? { warning: `Context source was truncated: ${path}` } : {}),
    }
  } catch (error) {
    return {
      summary: fallback,
      warning: `Context source could not be read: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function contextFreshness(
  value: ReturnType<typeof assessProjectFreshness>,
): ContextBundle["freshness"] {
  return {
    status: value.status,
    ...(value.currentRevision === undefined ? {} : { currentRevision: value.currentRevision }),
    ...(value.indexedRevision === undefined ? {} : { indexedRevision: value.indexedRevision }),
    workingTree: value.workingTree,
    detail: value.detail,
  }
}

export async function buildContextBundle(
  projectRoot: string,
  query?: string,
  limit = 20,
  options: { readonly path?: string; readonly maxChars?: number } = {},
): Promise<ContextBundle> {
  const manifest = await readProjectManifest(projectRoot)
  const standards = await discoverStandards(projectRoot)
  const knowledgeSelection = await configuredKnowledgeDirectory(projectRoot)
  const knowledge = await discoverProjectKnowledge(projectRoot, knowledgeSelection.directory)
  const stateRead = await readProjectState(projectRoot)
  const scope = contextScope(projectRoot, options.path)
  const normalizedQuery = query?.trim().toLowerCase()
  const effectiveQuery =
    normalizedQuery === undefined || normalizedQuery.length === 0 ? undefined : normalizedQuery
  const items: ContextItem[] = []
  const warnings: string[] = []
  for (const file of standards.instructions) {
    if (!appliesToScope(file.path, scope)) continue
    const excerpt = await fileExcerpt(
      projectRoot,
      file.path,
      `Project instruction source (${file.source})`,
    )
    if (excerpt.warning !== undefined) warnings.push(excerpt.warning)
    items.push({
      kind: "instruction",
      title: file.path,
      summary: excerpt.summary,
      sourceRefs: [file.path],
      authority: "canonical",
      freshness: "not-applicable",
      confidence: "high",
    })
  }
  for (const skill of standards.skills) {
    const excerpt = await fileExcerpt(
      projectRoot,
      skill.path,
      `Portable skill source (${skill.source})`,
    )
    if (excerpt.warning !== undefined) warnings.push(excerpt.warning)
    items.push({
      kind: "skill",
      title: skill.skillId,
      summary: excerpt.summary,
      sourceRefs: [skill.path],
      authority: "canonical",
      freshness: "not-applicable",
      confidence: "high",
    })
  }
  const canonicalFingerprints = new Set(
    knowledge.entries
      .filter((entry) => entry.authority === "canonical" && entry.fingerprint !== undefined)
      .map((entry) => entry.fingerprint),
  )
  const activeKnowledge = knowledge.entries.filter(
    (entry) =>
      isKnowledgeActive(entry) &&
      !(
        entry.authority === "session" &&
        entry.fingerprint !== undefined &&
        canonicalFingerprints.has(entry.fingerprint)
      ),
  )
  items.push(...activeKnowledge.map(knowledgeItem))
  if (knowledgeSelection.warning !== undefined) warnings.push(knowledgeSelection.warning)
  const inactiveKnowledge = knowledge.entries.length - activeKnowledge.length
  if (inactiveKnowledge > 0) {
    warnings.push(`${inactiveKnowledge} superseded or inactive knowledge record(s) omitted`)
  }
  const backend = await configuredBackend(projectRoot)
  const currentSnapshot = await currentGitSnapshot(projectRoot)
  let executableBackend: McpServerDefinition | undefined
  let backendResolutionError: string | undefined
  if (backend !== undefined) {
    try {
      const attested = await attestExecutableMcpServer(projectRoot, backend, true)
      if (attested !== undefined && (await isTrustedMcpExecutable(projectRoot, attested))) {
        executableBackend = { ...attested, trust: "explicit" }
      }
    } catch (error) {
      backendResolutionError = error instanceof Error ? error.message : String(error)
    }
  }
  let freshness = contextFreshness(
    assessProjectFreshness(
      stateRead.state,
      currentSnapshot,
      backend === undefined
        ? undefined
        : {
            command: executableBackend?.command ?? backend.command,
            sha256: executableBackend?.sha256,
          },
    ),
  )
  if (
    freshness.status === "stale" &&
    freshness.workingTree !== "dirty" &&
    executableBackend !== undefined &&
    (manifest?.freshness.onQuery === "refresh" || process.env["SKALD_AUTO_REFRESH"] === "1")
  ) {
    try {
      freshness = await refreshProject(projectRoot, "fast", "automatic")
      warnings.push("Structural index automatically refreshed before context retrieval")
    } catch (error) {
      warnings.push(
        `Automatic structural refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  if (freshness.status === "stale" && freshness.workingTree === "dirty") {
    warnings.push(
      "Automatic structural refresh skipped while the working tree has uncommitted changes; use project_refresh explicitly",
    )
  }
  if (backend !== undefined) {
    if (backendResolutionError !== undefined) {
      warnings.push(`Backend context unavailable: ${backendResolutionError}`)
    } else if (executableBackend === undefined) {
      warnings.push(
        "Backend context unavailable: engine is missing, changed, or requires explicit trust before execution",
      )
    } else {
      const graph = await backendContext(projectRoot, executableBackend, effectiveQuery, scope, {
        status: freshness.status,
        ...(freshness.currentRevision === undefined
          ? {}
          : { currentRevision: freshness.currentRevision }),
        ...(freshness.indexedRevision === undefined
          ? {}
          : { indexedRevision: freshness.indexedRevision }),
        workingTree: freshness.workingTree,
        detail: freshness.detail,
      })
      if (graph.item !== undefined) items.unshift(graph.item)
      if (graph.warnings !== undefined) warnings.push(...graph.warnings)
    }
  }
  const budget = contextMaxChars(options.maxChars)
  const selection = selectContextItems(items, effectiveQuery, limit, budget)
  if (standards.truncated) warnings.push("Instruction and skill discovery reached its safety limit")
  if (knowledge.truncated) warnings.push("Knowledge discovery reached its safety limit")
  if (activeKnowledge.some((entry) => entry.freshness !== "fresh")) {
    warnings.push("Some durable knowledge is stale or lacks a revision anchor")
  }
  if (stateRead.warning !== undefined) warnings.push(stateRead.warning)
  if (freshness.status === "stale") warnings.push(`Structural index is stale: ${freshness.detail}`)
  if (freshness.status === "degraded")
    warnings.push(`Structural index is degraded: ${freshness.detail}`)
  if (freshness.status === "unknown")
    warnings.push(`Structural index freshness is unknown: ${freshness.detail}`)
  if (selection.truncated) warnings.push("Context budget reached; additional sources were omitted")
  if (selection.items.length === 0) warnings.push("No matching project context was found")
  return {
    projectRoot,
    projectId: basename(projectRoot),
    generatedAt: new Date().toISOString(),
    items: selection.items,
    warnings,
    freshness: {
      status: freshness.status,
      ...(freshness.currentRevision === undefined
        ? {}
        : { currentRevision: freshness.currentRevision }),
      ...(freshness.indexedRevision === undefined
        ? {}
        : { indexedRevision: freshness.indexedRevision }),
      workingTree: freshness.workingTree,
      detail: freshness.detail,
    },
    budget: {
      maxChars: budget,
      usedChars: selection.usedChars,
      truncated: selection.truncated,
    },
  }
}

function toolDefinitions(): readonly Record<string, unknown>[] {
  return [
    {
      name: "project_context",
      description:
        "Return source-attributed project instructions, skills, and durable knowledge before code changes.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword filter" },
          path: { type: "string", description: "Optional project-relative scope" },
          maxItems: { type: "number", description: "Maximum context items, from 1 to 50" },
          maxChars: { type: "number", description: "Optional context character budget" },
        },
      },
    },
    {
      name: "project_refresh",
      description:
        "Refresh the trusted structural index through Skald and record the resulting project freshness.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["fast", "moderate", "full"] },
        },
      },
    },
    {
      name: "project_doctor",
      description:
        "Check project configuration, context sources, backend availability, and index readiness.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "record_project_knowledge",
      description:
        "Record a reviewed session discovery as durable project knowledge; it remains marked session authority.",
      inputSchema: {
        type: "object",
        required: ["kind", "title", "summary"],
        properties: {
          kind: {
            type: "string",
            enum: [
              "adr",
              "decision",
              "observation",
              "measurement",
              "component",
              "contract",
              "investigation",
              "research",
            ],
          },
          title: { type: "string" },
          summary: { type: "string" },
          sourceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "project_knowledge_audit",
      description:
        "Reconcile durable project knowledge for broken supersession chains, duplicate identifiers, and revision drift.",
      inputSchema: { type: "object", properties: {} },
    },
  ]
}

function textResult(value: unknown): {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }]
} {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function jsonRpcErrorCode(method: string | undefined): number {
  if (method === undefined) return -32600
  if (method === "tools/call") return -32602
  if (method === "initialize" || method === "ping" || method === "tools/list") return -32603
  return -32601
}

async function callTool(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "project_context") {
    const path = stringArgument(args, "path")
    const maxChars =
      typeof args["maxChars"] === "number" && Number.isFinite(args["maxChars"])
        ? args["maxChars"]
        : undefined
    return textResult(
      await buildContextBundle(projectRoot, stringArgument(args, "query"), maxItems(args), {
        ...(path === undefined ? {} : { path }),
        ...(maxChars === undefined ? {} : { maxChars }),
      }),
    )
  }
  if (name === "project_refresh") {
    return textResult(await refreshProject(projectRoot, engineIndexMode(args["mode"])))
  }
  if (name === "project_doctor") return textResult(await diagnoseProject(projectRoot))
  if (name === "project_knowledge_audit") {
    const selection = await configuredKnowledgeDirectory(projectRoot)
    const report = await reconcileKnowledge(projectRoot, selection.directory)
    return textResult(
      selection.warning === undefined
        ? report
        : {
            ...report,
            issues: [
              ...report.issues,
              {
                code: "unknown_origin",
                severity: "warning",
                path: report.root,
                message: selection.warning,
              },
            ],
          },
    )
  }
  if (name === "record_project_knowledge") {
    const kind = recordKind(args["kind"])
    const title = stringArgument(args, "title")
    const summary = stringArgument(args, "summary")
    if (kind === undefined || title === undefined || summary === undefined) {
      throw new Error("kind, title, and summary are required")
    }
    const refs = sourceRefs(args)
    const input: KnowledgeRecordInput =
      refs === undefined ? { kind, title, summary } : { kind, title, summary, sourceRefs: refs }
    return textResult(await recordKnowledge(projectRoot, input))
  }
  throw new Error(`Unknown Skald context tool: ${name}`)
}

export async function handleMcpRequest(
  projectRoot: string,
  request: unknown,
): Promise<JsonRpcResponse | undefined> {
  const value = isRecord(request) ? request : {}
  const id = value["id"] ?? null
  const method = typeof value["method"] === "string" ? value["method"] : undefined
  if (value["jsonrpc"] !== "2.0" || method === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid JSON-RPC request" },
    }
  }
  if (value["id"] === undefined && method === "notifications/initialized") return undefined
  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "Call project_context before editing. Use project_doctor for setup health and record_project_knowledge for durable session discoveries.",
        },
      }
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} }
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: toolDefinitions() } }
    if (method === "tools/call") {
      const params = isRecord(value["params"]) ? value["params"] : {}
      const name = stringArgument(params, "name")
      if (name === undefined) throw new Error("tools/call requires a tool name")
      const args = isRecord(params["arguments"]) ? params["arguments"] : {}
      const result = await callTool(projectRoot, name, args)
      return { jsonrpc: "2.0", id, result }
    }
    if (method?.startsWith("notifications/")) return undefined
    throw new Error(`Unknown MCP method: ${method ?? "missing method"}`)
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: jsonRpcErrorCode(method),
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

export async function serveContextMcp(projectRoot: string): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline >= 0) {
      if (newline > MAX_MCP_BUFFER_CHARS) {
        console.log(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "MCP request exceeds the 1MB limit" },
          }),
        )
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        continue
      }
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.length > 0) {
        try {
          const request: unknown = JSON.parse(line)
          const response = await handleMcpRequest(projectRoot, request)
          if (response !== undefined) console.log(JSON.stringify(response))
        } catch (error) {
          console.log(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32700,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          )
        }
      }
      newline = buffer.indexOf("\n")
    }
    if (buffer.length > MAX_MCP_BUFFER_CHARS) {
      console.log(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "MCP request exceeds the 1MB limit" },
        }),
      )
      buffer = ""
    }
  }
}
