import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  DEFAULT_MCP_SERVER,
  type McpServerDefinition,
  persistableMcpEnvironment,
} from "./agents/mcp"
import { locateAnyManagedEngine } from "./engine/distribution"
import { PROJECT_ENGINE_PATH, projectEngineEnvironment } from "./engine/project"
import { EngineIntegrityError, EngineNotFoundError } from "./errors"
import { SKALD_VERSION } from "./version"

const PROJECT_ENGINE_PATHS = [
  PROJECT_ENGINE_PATH,
  "build/c-afsin/codebase-memory-mcp",
  "build/c-cambrian/codebase-memory-mcp",
  "build/c/codebase-memory-mcp",
] as const
const DEFAULT_MCP_TIMEOUT_MS = 15_000
const MIN_MCP_TIMEOUT_MS = 100
const MAX_MCP_TIMEOUT_MS = 10 * 60_000
const DEFAULT_INDEX_MCP_TIMEOUT_MS = MAX_MCP_TIMEOUT_MS
const MCP_TERM_GRACE_MS = 250
const MCP_CLEANUP_TIMEOUT_MS = 250
const MAX_MCP_MESSAGE_CHARS = 1_000_000
const MAX_MCP_STDERR_CHARS = 64_000
const CODEBASE_MEMORY_ENGINE = "codebase-memory-mcp"

const INHERITED_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
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

export const ENGINE_INDEX_MODES = ["fast", "moderate", "full"] as const
export type EngineIndexMode = (typeof ENGINE_INDEX_MODES)[number]

export type EngineCliResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly response: unknown | undefined
}

export type EngineProbe = {
  readonly available: boolean
  readonly compatible: boolean
  readonly command: string
  readonly sha256?: string
  readonly tools: readonly string[]
  readonly missingTools: readonly string[]
  readonly projects: readonly { readonly name: string; readonly rootPath: string }[]
  readonly detail: string
}

export type EngineConformance = EngineProbe & {
  readonly expectedTools: readonly string[]
  readonly unexpectedTools: readonly string[]
  readonly schemaFailures: readonly string[]
  readonly semanticCompatible: boolean | undefined
  readonly semanticChecks: readonly {
    readonly tool: string
    readonly status: "pass" | "fail" | "skipped"
    readonly detail: string
  }[]
}

const REQUIRED_ENGINE_TOOLS = ["list_projects", "index_repository"] as const
const RETRIEVAL_ENGINE_TOOLS = ["get_architecture", "search_graph", "search_code"] as const

export const AFSIN_ENGINE_TOOL_NAMES = [
  "index_repository",
  "search_graph",
  "query_graph",
  "trace_path",
  "get_code_snippet",
  "get_graph_schema",
  "compare_graphs",
  "get_architecture",
  "search_code",
  "list_projects",
  "delete_project",
  "index_status",
  "check_index_coverage",
  "detect_changes",
  "manage_adr",
  "ingest_traces",
] as const

const AFSIN_REQUIRED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  index_repository: ["repo_path"],
  search_graph: ["project"],
  query_graph: ["query", "project"],
  trace_path: ["function_name", "project"],
  get_code_snippet: ["qualified_name", "project"],
  get_graph_schema: ["project"],
  compare_graphs: ["base_project", "target_project"],
  get_architecture: ["project"],
  search_code: ["pattern", "project"],
  delete_project: ["project"],
  index_status: ["project"],
  check_index_coverage: ["project"],
  detect_changes: ["project"],
  manage_adr: ["project"],
  ingest_traces: ["traces", "project"],
}

function hasCoverageIssue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "number") return value > 0
  if (!isRecord(value)) return false
  for (const key of ["count", "total", "files", "items", "examples"]) {
    const candidate = value[key]
    if (typeof candidate === "number" && candidate > 0) return true
    if (Array.isArray(candidate) && candidate.length > 0) return true
  }
  return false
}

export function indexResponseStatus(response: unknown): "indexed" | "degraded" {
  if (!isRecord(response)) return "indexed"
  if (response["status"] === "degraded") return "degraded"
  return ["skipped", "parse_partial", "skipped_count", "parse_partial_count"].some((key) =>
    hasCoverageIssue(response[key]),
  )
    ? "degraded"
    : "indexed"
}

async function isExecutableFile(path: string, allowExternalSymlink = false): Promise<boolean> {
  try {
    let candidate = path
    let stats = await lstat(candidate)
    if (stats.isSymbolicLink()) {
      if (!allowExternalSymlink) return false
      candidate = await realpath(candidate)
      stats = await lstat(candidate)
    }
    if (!stats.isFile()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isFilesystemError(error) && error.code === "ENOENT"
}

function isFilesystemError(error: unknown): error is { readonly code?: string } {
  return error instanceof Error && "code" in error
}

function isProcessGone(error: unknown): boolean {
  return (
    isFilesystemError(error) &&
    (error.code === "ESRCH" || error.code === "ECHILD" || error.code === "ERR_PROCESS_NOT_RUNNING")
  )
}

function assertPrivateDirectory(path: string, stats: Awaited<ReturnType<typeof lstat>>): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing unsafe MCP runtime directory: ${path}`)
  }
  const mode = typeof stats.mode === "bigint" ? Number(stats.mode) : stats.mode
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new Error(`MCP runtime directory must not be group/world accessible: ${path}`)
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`MCP runtime directory is not owned by the current user: ${path}`)
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    assertPrivateDirectory(path, stats)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  const stats = await lstat(path)
  assertPrivateDirectory(path, stats)
}

function needsPrivateCodebaseMemoryRuntime(server: McpServerDefinition): boolean {
  return basename(server.command).toLowerCase() === CODEBASE_MEMORY_ENGINE
}

export async function prepareMcpServer(
  projectRoot: string,
  server: McpServerDefinition,
  createRuntime = true,
): Promise<McpServerDefinition> {
  if (!needsPrivateCodebaseMemoryRuntime(server)) return server
  const inheritedRuntime = process.env["CBM_RUNTIME_DIR"]?.trim()
  const environment: Readonly<Record<string, string>> = {
    ...projectEngineEnvironment(
      projectRoot,
      server.env?.["CBM_KNOWLEDGE_DIR"] ?? ".skald/knowledge",
    ),
    ...(server.env?.["CBM_RUNTIME_DIR"] === undefined &&
    inheritedRuntime !== undefined &&
    inheritedRuntime.length > 0
      ? { CBM_RUNTIME_DIR: inheritedRuntime }
      : {}),
    ...server.env,
  }
  const preparedServer = { ...server, env: environment }
  if (preparedServer.env["CBM_RUNTIME_DIR"] !== undefined) {
    if (createRuntime && server.trust === "explicit") {
      await Promise.all(
        [
          environment["CBM_CACHE_DIR"],
          environment["CBM_CONFIG_DIR"],
          environment["CBM_RUNTIME_DIR"],
        ]
          .filter((path): path is string => path !== undefined)
          .map((path) => ensurePrivateDirectory(path)),
      )
    }
    return preparedServer
  }
  return preparedServer
}

function configuredTimeoutMs(name: string): number | undefined {
  const configured = Number.parseInt(process.env[name] ?? "", 10)
  if (!Number.isFinite(configured)) return undefined
  return Math.max(MIN_MCP_TIMEOUT_MS, Math.min(MAX_MCP_TIMEOUT_MS, configured))
}

function mcpTimeoutMs(): number {
  return configuredTimeoutMs("SKALD_MCP_TIMEOUT_MS") ?? DEFAULT_MCP_TIMEOUT_MS
}

function indexMcpTimeoutMs(): number {
  return (
    configuredTimeoutMs("SKALD_INDEX_TIMEOUT_MS") ??
    configuredTimeoutMs("SKALD_MCP_TIMEOUT_MS") ??
    DEFAULT_INDEX_MCP_TIMEOUT_MS
  )
}

class McpTimeoutError extends Error {
  readonly name = "McpTimeoutError"

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`MCP ${operation} timed out after ${timeoutMs}ms`)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpTimeoutError(operation, timeoutMs)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function signalChild(
  child: ReturnType<typeof Bun.spawn>,
  signal: NodeJS.Signals,
  processGroup: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    try {
      child.kill(signal)
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
    const treeKiller = Bun.spawn(
      ["taskkill", "/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
    await Promise.race([treeKiller.exited, waitMs(MCP_CLEANUP_TIMEOUT_MS)])
    return
  }
  if (processGroup) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (!isProcessGone(error)) throw error
      return
    }
  }
  child.kill(signal)
}

async function stopChild(child: ReturnType<typeof Bun.spawn>, processGroup = false): Promise<void> {
  try {
    await signalChild(child, "SIGTERM", processGroup)
  } catch (error) {
    if (!isProcessGone(error)) throw error
  }
  const terminated = await Promise.race([
    child.exited.then(() => true),
    waitMs(MCP_TERM_GRACE_MS).then(() => false),
  ])
  if (!terminated) {
    try {
      await signalChild(child, "SIGKILL", processGroup)
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
  }
  await Promise.race([child.exited, waitMs(MCP_CLEANUP_TIMEOUT_MS)])
}

async function readStderr(stderrPromise: Promise<string>): Promise<string> {
  try {
    return await withTimeout(stderrPromise, MCP_CLEANUP_TIMEOUT_MS, "stderr drain")
  } catch (error) {
    if (error instanceof McpTimeoutError && error.operation === "stderr drain") return ""
    if (error instanceof Error) return error.message
    throw error
  }
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function createMcpResponseReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return async (expectedId: number): Promise<Record<string, unknown>> => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`MCP server closed before response ${expectedId}`)
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > MAX_MCP_MESSAGE_CHARS) {
        throw new Error(`MCP response exceeds ${MAX_MCP_MESSAGE_CHARS} characters`)
      }
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.length > 0) {
          if (line.length > MAX_MCP_MESSAGE_CHARS) {
            throw new Error(`MCP response exceeds ${MAX_MCP_MESSAGE_CHARS} characters`)
          }
          const parsed: unknown = JSON.parse(line)
          if (isRecord(parsed) && parsed["id"] === expectedId) return parsed
        }
        newline = buffer.indexOf("\n")
      }
    }
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  let truncated = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const decoded = decoder.decode(chunk.value, { stream: true })
      if (output.length < limit) {
        const remaining = limit - output.length
        output += decoded.slice(0, remaining)
        if (decoded.length > remaining) truncated = true
      } else {
        truncated = true
      }
    }
    const final = decoder.decode()
    if (output.length < limit) {
      const remaining = limit - output.length
      output += final.slice(0, remaining)
      if (final.length > remaining) truncated = true
    } else if (final.length > 0) {
      truncated = true
    }
    return truncated ? `${output}\n[stream truncated after ${limit} characters]` : output
  } finally {
    reader.releaseLock()
  }
}

type WritableMcpStream = {
  write(data: string): number | Promise<number>
}

async function sendMcpMessage(stream: WritableMcpStream, message: unknown): Promise<void> {
  await stream.write(`${JSON.stringify(message)}\n`)
}

function resultText(result: Record<string, unknown>): string | undefined {
  const content = result["content"]
  if (!Array.isArray(content)) return undefined
  const first = content[0]
  return isRecord(first) && typeof first["text"] === "string" ? first["text"] : undefined
}

function mcpToolPayload(message: Record<string, unknown>): { response: unknown; error?: string } {
  const error = message["error"]
  if (isRecord(error)) {
    return {
      response: message,
      error: typeof error["message"] === "string" ? error["message"] : "MCP request failed",
    }
  }
  const result = message["result"]
  if (!isRecord(result)) return { response: result }
  if (result["isError"] === true)
    return { response: result, error: resultText(result) ?? "MCP tool failed" }
  if (Object.hasOwn(result, "structuredContent")) return { response: result["structuredContent"] }
  const text = resultText(result)
  return { response: text === undefined ? result : parseJsonText(text) }
}

export async function locateMcpEngine(
  projectRoot: string,
  command: string,
  options: { readonly allowProjectLocal?: boolean } = {},
): Promise<string | undefined> {
  const allowProjectLocal = options.allowProjectLocal ?? true
  if (isAbsolute(command)) {
    const projectLocal = await isProjectLocalPath(projectRoot, command)
    if (!allowProjectLocal && projectLocal) return undefined
    return (await isExecutableFile(command, !projectLocal)) ? command : undefined
  }

  if (allowProjectLocal) {
    for (const relativePath of PROJECT_ENGINE_PATHS) {
      const candidate = join(projectRoot, relativePath)
      if (await isExecutableFile(candidate)) return candidate
    }
  }

  if (command === CODEBASE_MEMORY_ENGINE) {
    const managed = await locateAnyManagedEngine()
    if (managed !== undefined) return managed
  }

  const localCandidate = join(homedir(), ".local", "bin", command)
  const localCandidateProjectPath = await isProjectLocalPath(projectRoot, localCandidate)
  if (
    (allowProjectLocal || !localCandidateProjectPath) &&
    (await isExecutableFile(localCandidate, false))
  ) {
    return localCandidate
  }
  const pathCandidate = Bun.which(command)
  if (pathCandidate === undefined || pathCandidate === null) return undefined
  const pathCandidateProjectPath = await isProjectLocalPath(projectRoot, pathCandidate)
  if (!allowProjectLocal && pathCandidateProjectPath) return undefined
  return (await isExecutableFile(pathCandidate, !pathCandidateProjectPath))
    ? pathCandidate
    : undefined
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
}

async function isProjectLocalPath(projectRoot: string, candidate: string): Promise<boolean> {
  if (isWithin(projectRoot, candidate)) return true
  try {
    return isWithin(projectRoot, await realpath(candidate))
  } catch (error) {
    if (isFilesystemError(error) && error.code === "ENOENT") return false
    throw error
  }
}

export async function resolveMcpServer(
  projectRoot: string,
  override: McpServerDefinition | undefined,
  existing: McpServerDefinition | undefined,
  allowMissing: boolean,
  options: { readonly allowProjectLocal?: boolean } = {},
): Promise<McpServerDefinition> {
  const server = override ?? existing ?? DEFAULT_MCP_SERVER
  const executable = await locateMcpEngine(projectRoot, server.command, options)
  if (executable !== undefined) return { ...server, command: executable }
  if (override !== undefined || existing !== undefined || allowMissing) return server
  throw new EngineNotFoundError(server.command)
}

export async function resolveExecutableMcpServer(
  projectRoot: string,
  server: McpServerDefinition,
  allowProjectLocal: boolean,
): Promise<McpServerDefinition | undefined> {
  const executable = await locateMcpEngine(projectRoot, server.command, {
    allowProjectLocal,
  })
  if (executable === undefined) return undefined
  if (server.sha256 !== undefined) {
    const actual = await mcpExecutableSha256(executable)
    if (actual !== server.sha256) throw new EngineIntegrityError(executable, server.sha256, actual)
  }
  return { ...server, command: executable }
}

export async function mcpExecutableSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export async function attestExecutableMcpServer(
  projectRoot: string,
  server: McpServerDefinition,
  allowProjectLocal: boolean,
): Promise<McpServerDefinition | undefined> {
  const executable = await resolveExecutableMcpServer(projectRoot, server, allowProjectLocal)
  if (executable === undefined) return undefined
  const sha256 = executable.sha256 ?? (await mcpExecutableSha256(executable.command))
  return { ...executable, sha256 }
}

type PreparedMcpCommand = {
  readonly command: string
  readonly cleanup: () => Promise<void>
}

async function prepareMcpCommand(
  projectRoot: string,
  server: McpServerDefinition,
): Promise<PreparedMcpCommand> {
  if (server.sha256 === undefined) {
    return { command: server.command, cleanup: async () => undefined }
  }
  const executable = await locateMcpEngine(projectRoot, server.command, {
    allowProjectLocal: true,
  })
  if (executable === undefined) throw new EngineNotFoundError(server.command)
  const directory = await mkdtemp(join(tmpdir(), "skald-verified-engine-"))
  const snapshot = join(directory, basename(executable))
  try {
    const source = await realpath(executable)
    const sourceStats = await lstat(source)
    if (!sourceStats.isFile()) throw new EngineNotFoundError(executable)
    await copyFile(source, snapshot)
    await chmod(snapshot, sourceStats.mode & 0o777)
    const actual = await mcpExecutableSha256(snapshot)
    if (actual !== server.sha256) {
      throw new EngineIntegrityError(executable, server.sha256, actual)
    }
    return {
      command: snapshot,
      cleanup: async () => {
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

function inheritedEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (INHERITED_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("XDG_"))
    ) {
      environment[key] = value
    }
  }
  return environment
}

function configuredMcpEnvironment(
  server: McpServerDefinition,
): Readonly<Record<string, string>> | undefined {
  return server.trust === "explicit" ? server.env : persistableMcpEnvironment(server.env)
}

export async function runMcpEngine(
  projectRoot: string,
  server: McpServerDefinition,
  args: readonly string[],
): Promise<number> {
  const runtimeServer = await prepareMcpServer(projectRoot, server)
  const prepared = await prepareMcpCommand(projectRoot, runtimeServer)
  try {
    const child = Bun.spawn([prepared.command, ...runtimeServer.args, ...args], {
      cwd: projectRoot,
      env: { ...inheritedEnvironment(), ...configuredMcpEnvironment(runtimeServer) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    return await child.exited
  } finally {
    await prepared.cleanup()
  }
}

export async function runMcpTool(
  projectRoot: string,
  server: McpServerDefinition,
  tool: string,
  argumentsValue: Readonly<Record<string, unknown>> = {},
  options: McpSessionOptions = {},
): Promise<EngineCliResult> {
  const results = await runMcpTools(
    projectRoot,
    server,
    [{ tool, arguments: argumentsValue }],
    options,
  )
  const result = results[0]
  if (result !== undefined) return result
  return {
    exitCode: 1,
    stdout: "",
    stderr: "MCP tool did not produce a result",
    response: undefined,
  }
}

export type McpToolRequest = {
  readonly tool: string
  readonly arguments?: Readonly<Record<string, unknown>>
}

export type McpSessionRequest =
  | ({ readonly kind: "tool" } & McpToolRequest)
  | {
      readonly kind: "method"
      readonly method: string
      readonly params?: unknown
    }

export type McpSessionOptions = {
  readonly timeoutMs?: number
}

export async function runMcpSession(
  projectRoot: string,
  server: McpServerDefinition,
  requests: readonly McpSessionRequest[],
  options: McpSessionOptions = {},
): Promise<readonly EngineCliResult[]> {
  if (requests.length === 0) return []
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stderrPromise: Promise<string> = Promise.resolve("")
  let processGroup = false
  let cleanup = async (): Promise<void> => undefined
  const results: EngineCliResult[] = []
  try {
    const runtimeServer = await prepareMcpServer(projectRoot, server)
    const prepared = await prepareMcpCommand(projectRoot, runtimeServer)
    cleanup = prepared.cleanup
    child = Bun.spawn([prepared.command, ...runtimeServer.args], {
      cwd: projectRoot,
      env: { ...inheritedEnvironment(), ...configuredMcpEnvironment(runtimeServer) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    processGroup = process.platform !== "win32"
    const stdin = child.stdin
    const stdout = child.stdout
    if (
      typeof stdin !== "object" ||
      stdin === null ||
      typeof stdin.write !== "function" ||
      typeof stdout !== "object" ||
      stdout === null
    ) {
      throw new Error("MCP stdio transport is unavailable")
    }
    if (typeof child.stderr === "object" && child.stderr !== null) {
      stderrPromise = readBoundedStream(child.stderr, MAX_MCP_STDERR_CHARS)
    }
    const timeoutMs =
      options.timeoutMs === undefined
        ? mcpTimeoutMs()
        : Math.max(MIN_MCP_TIMEOUT_MS, Math.min(MAX_MCP_TIMEOUT_MS, options.timeoutMs))
    const nextResponse = createMcpResponseReader(stdout)
    await sendMcpMessage(stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "skald", version: SKALD_VERSION },
      },
    })
    const initialize = await withTimeout(nextResponse(1), timeoutMs, "initialize")
    if (Object.hasOwn(initialize, "error")) {
      const failure = mcpToolPayload(initialize)
      throw new Error(failure.error ?? "MCP initialization failed")
    }
    await sendMcpMessage(stdin, { jsonrpc: "2.0", method: "notifications/initialized" })
    for (const [index, request] of requests.entries()) {
      const id = index + 2
      if (request.kind === "tool") {
        await sendMcpMessage(stdin, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: request.tool, arguments: request.arguments ?? {} },
        })
      } else {
        await sendMcpMessage(stdin, {
          jsonrpc: "2.0",
          id,
          method: request.method,
          ...(request.params === undefined ? {} : { params: request.params }),
        })
      }
      const message = await withTimeout(
        nextResponse(id),
        timeoutMs,
        request.kind === "tool" ? `tool ${request.tool}` : `method ${request.method}`,
      )
      const payload = mcpToolPayload(message)
      results.push({
        exitCode: payload.error === undefined ? 0 : 1,
        stdout: JSON.stringify(payload.response),
        stderr: payload.error ?? "",
        response: payload.response,
      })
    }
    await stopChild(child, processGroup)
    const stderr = await readStderr(stderrPromise)
    return results.map((result) => (result.stderr.length === 0 ? { ...result, stderr } : result))
  } catch (error) {
    if (child !== undefined) {
      await stopChild(child, processGroup)
    }
    const stderr =
      (await readStderr(stderrPromise)).trim() ||
      (error instanceof Error ? error.message : String(error))
    return [
      ...results,
      ...requests.slice(results.length).map(() => ({
        exitCode: 1,
        stdout: "",
        stderr,
        response: undefined,
      })),
    ]
  } finally {
    await cleanup()
  }
}

export async function runMcpTools(
  projectRoot: string,
  server: McpServerDefinition,
  requests: readonly McpToolRequest[],
  options: McpSessionOptions = {},
): Promise<readonly EngineCliResult[]> {
  return runMcpSession(
    projectRoot,
    server,
    requests.map((request) => ({ kind: "tool" as const, ...request })),
    options,
  )
}

export async function probeMcpEngine(
  projectRoot: string,
  server: McpServerDefinition,
): Promise<EngineProbe> {
  const [result, catalogResult] = await runMcpSession(projectRoot, server, [
    { kind: "tool", tool: "list_projects" },
    { kind: "method", method: "tools/list" },
  ])
  return probeFromSessionResults(server, result, catalogResult)
}

function probeFromSessionResults(
  server: McpServerDefinition,
  result: EngineCliResult | undefined,
  catalogResult: EngineCliResult | undefined,
): EngineProbe {
  const projects: { name: string; rootPath: string }[] = []
  if (
    result !== undefined &&
    isRecord(result.response) &&
    Array.isArray(result.response["projects"])
  ) {
    for (const project of result.response["projects"]) {
      if (
        !isRecord(project) ||
        typeof project["name"] !== "string" ||
        typeof project["root_path"] !== "string"
      ) {
        continue
      }
      projects.push({ name: project["name"], rootPath: project["root_path"] })
    }
  }
  const tools: string[] = []
  if (isRecord(catalogResult?.response) && Array.isArray(catalogResult.response["tools"])) {
    for (const tool of catalogResult.response["tools"]) {
      if (isRecord(tool) && typeof tool["name"] === "string") tools.push(tool["name"])
    }
  }
  const uniqueTools = [...new Set(tools)].sort()
  const missingTools: string[] = [...REQUIRED_ENGINE_TOOLS].filter(
    (tool) => !uniqueTools.includes(tool),
  )
  if (!RETRIEVAL_ENGINE_TOOLS.some((tool) => uniqueTools.includes(tool))) {
    missingTools.push("one of get_architecture, search_graph, or search_code")
  }
  const available = result?.exitCode === 0 && isRecord(result.response)
  const compatible = available && catalogResult?.exitCode === 0 && missingTools.length === 0
  const detail = !available
    ? result?.stderr.trim() || "MCP CLI did not return a valid list_projects response"
    : !compatible
      ? `MCP CLI is missing required compatibility capabilities: ${missingTools.join(", ")}`
      : "MCP CLI responded with the required indexing and retrieval capabilities"
  return {
    available,
    compatible,
    command: server.command,
    ...(server.sha256 === undefined ? {} : { sha256: server.sha256 }),
    tools: uniqueTools,
    missingTools,
    projects,
    detail,
  }
}

function toolDescriptors(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value["tools"])) return []
  return value["tools"].filter(isRecord)
}

function firstQualifiedName(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined
  if (typeof value === "string") {
    try {
      return firstQualifiedName(JSON.parse(value), depth + 1)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstQualifiedName(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  const columns = value["columns"] ?? value["cols"]
  const rows = value["rows"]
  if (Array.isArray(columns) && Array.isArray(rows)) {
    const columnIndex = columns.findIndex(
      (column) => column === "qn" || column === "qualified_name" || column === "qualifiedName",
    )
    if (columnIndex >= 0) {
      for (const row of rows) {
        if (Array.isArray(row) && typeof row[columnIndex] === "string") {
          return row[columnIndex]
        }
      }
    }
  }
  for (const key of ["qualified_name", "qualifiedName", "qn"]) {
    if (typeof value[key] === "string" && value[key].length > 0) return value[key]
  }
  for (const child of Object.values(value)) {
    const found = firstQualifiedName(child, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

async function semanticSmoke(
  projectRoot: string,
  server: McpServerDefinition,
  project: { readonly name: string; readonly rootPath: string } | undefined,
  projects: readonly { readonly name: string; readonly rootPath: string }[],
): Promise<{
  readonly compatible: boolean
  readonly checks: readonly {
    readonly tool: string
    readonly status: "pass" | "fail" | "skipped"
    readonly detail: string
  }[]
}> {
  if (project === undefined) {
    return {
      compatible: false,
      checks: [
        {
          tool: "project",
          status: "fail",
          detail: "No indexed project matches the conformance root",
        },
      ],
    }
  }
  const comparisonProject = projects.find((candidate) => candidate.name !== project.name)
  const requestRecords: { readonly tool: string; readonly request: McpToolRequest }[] = [
    {
      tool: "index_status",
      request: { tool: "index_status", arguments: { project: project.name } },
    },
    {
      tool: "check_index_coverage",
      request: {
        tool: "check_index_coverage",
        arguments: { project: project.name, scopes: ["."] },
      },
    },
    {
      tool: "get_graph_schema",
      request: { tool: "get_graph_schema", arguments: { project: project.name } },
    },
    {
      tool: "get_architecture",
      request: {
        tool: "get_architecture",
        arguments: { project: project.name, aspects: ["overview"] },
      },
    },
    {
      tool: "search_graph",
      request: {
        tool: "search_graph",
        arguments: { project: project.name, query: "main", format: "json", limit: 5 },
      },
    },
    {
      tool: "search_code",
      request: {
        tool: "search_code",
        arguments: { project: project.name, pattern: "main", limit: 5 },
      },
    },
    {
      tool: "query_graph",
      request: {
        tool: "query_graph",
        arguments: { project: project.name, query: "MATCH (n) RETURN n LIMIT 1", max_rows: 1 },
      },
    },
    ...(comparisonProject === undefined
      ? []
      : [
          {
            tool: "compare_graphs",
            request: {
              tool: "compare_graphs",
              arguments: {
                base_project: project.name,
                target_project: comparisonProject.name,
                limit: 1,
                scan_limit: 2_000_000,
              },
            },
          },
        ]),
    {
      tool: "detect_changes",
      request: {
        tool: "detect_changes",
        arguments: { project: project.name, scope: "files", limit: 1 },
      },
    },
    {
      tool: "manage_adr",
      request: { tool: "manage_adr", arguments: { project: project.name, mode: "sections" } },
    },
  ]
  const results = await runMcpTools(
    projectRoot,
    server,
    requestRecords.map((record) => record.request),
  )
  const checks: {
    readonly tool: string
    readonly status: "pass" | "fail" | "skipped"
    readonly detail: string
  }[] = results.map((result, index) => ({
    tool: requestRecords[index]?.tool ?? "unknown",
    status: result.exitCode === 0 ? ("pass" as const) : ("fail" as const),
    detail: result.exitCode === 0 ? "responded" : result.stderr.trim() || "request failed",
  }))
  if (comparisonProject === undefined) {
    checks.splice(7, 0, {
      tool: "compare_graphs",
      status: "skipped",
      detail: "A comparison requires two distinct indexed projects",
    })
  }
  const searchResult = results[requestRecords.findIndex((record) => record.tool === "search_graph")]
  const qualifiedName = firstQualifiedName(searchResult?.response)
  if (qualifiedName === undefined) {
    checks.push({
      tool: "trace_path/get_code_snippet",
      status: "skipped",
      detail: "The bounded search returned no qualified symbol",
    })
  } else {
    const symbolResults = await runMcpTools(projectRoot, server, [
      { tool: "trace_path", arguments: { project: project.name, function_name: qualifiedName } },
      {
        tool: "get_code_snippet",
        arguments: { project: project.name, qualified_name: qualifiedName },
      },
    ])
    checks.push(
      ...symbolResults.map((result, index) => ({
        tool: index === 0 ? "trace_path" : "get_code_snippet",
        status: result.exitCode === 0 ? ("pass" as const) : ("fail" as const),
        detail: result.exitCode === 0 ? "responded" : result.stderr.trim() || "request failed",
      })),
    )
  }
  return { compatible: checks.every((check) => check.status !== "fail"), checks }
}

export async function conformMcpEngine(
  projectRoot: string,
  server: McpServerDefinition,
  options: { readonly smoke?: boolean } = {},
): Promise<EngineConformance> {
  const [projectResult, catalogResult] = await runMcpSession(projectRoot, server, [
    { kind: "tool", tool: "list_projects" },
    { kind: "method", method: "tools/list" },
  ])
  const probe = probeFromSessionResults(server, projectResult, catalogResult)
  const catalog =
    catalogResult ??
    ({
      exitCode: 1,
      stdout: "",
      stderr: "MCP tools/list did not return a response",
      response: undefined,
    } satisfies EngineCliResult)
  const descriptors = toolDescriptors(catalog.response)
  const descriptorNames = descriptors.flatMap((tool) =>
    typeof tool["name"] === "string" ? [tool["name"]] : [],
  )
  const tools = [...new Set(descriptorNames)].sort()
  const missingTools = AFSIN_ENGINE_TOOL_NAMES.filter((tool) => !tools.includes(tool))
  const unexpectedTools = tools.filter(
    (tool) => !AFSIN_ENGINE_TOOL_NAMES.includes(tool as (typeof AFSIN_ENGINE_TOOL_NAMES)[number]),
  )
  const schemaFailures: string[] = []
  for (const expected of AFSIN_ENGINE_TOOL_NAMES) {
    const descriptor = descriptors.find((tool) => tool["name"] === expected)
    if (descriptor === undefined) continue
    const schema = descriptor["inputSchema"]
    if (!isRecord(schema)) {
      schemaFailures.push(`${expected}: missing inputSchema`)
      continue
    }
    const required = schema["required"]
    const requiredNames = Array.isArray(required)
      ? required.filter((value): value is string => typeof value === "string")
      : []
    for (const field of AFSIN_REQUIRED_INPUTS[expected] ?? []) {
      if (!requiredNames.includes(field))
        schemaFailures.push(`${expected}: missing required ${field}`)
    }
  }
  const smoke = options.smoke === true
  const semantic = smoke
    ? await semanticSmoke(
        projectRoot,
        server,
        probe.projects.find((project) => resolve(project.rootPath) === resolve(projectRoot)),
        probe.projects,
      )
    : { compatible: true, checks: [] }
  const compatible =
    probe.available &&
    catalog.exitCode === 0 &&
    missingTools.length === 0 &&
    schemaFailures.length === 0 &&
    semantic.compatible
  const detail = compatible
    ? unexpectedTools.length === 0
      ? "MCP engine matches Afşin's complete tool and required-input contract"
      : `MCP engine matches Afşin's contract and adds ${unexpectedTools.length} tool(s)`
    : !semantic.compatible
      ? "MCP engine failed the read-only semantic smoke checks"
      : missingTools.length > 0
        ? `MCP engine is missing Afşin tools: ${missingTools.join(", ")}`
        : schemaFailures.length > 0
          ? `MCP engine has schema mismatches: ${schemaFailures.join(", ")}`
          : catalog.stderr.trim() || probe.detail
  return {
    ...probe,
    compatible,
    expectedTools: [...AFSIN_ENGINE_TOOL_NAMES],
    tools,
    missingTools,
    unexpectedTools,
    schemaFailures,
    semanticCompatible: smoke ? semantic.compatible : undefined,
    semanticChecks: semantic.checks,
    detail,
  }
}

export async function indexProjectDetailed(
  projectRoot: string,
  server: McpServerDefinition,
  mode: EngineIndexMode,
): Promise<EngineCliResult> {
  return runMcpTool(
    projectRoot,
    server,
    "index_repository",
    { repo_path: projectRoot, mode },
    { timeoutMs: indexMcpTimeoutMs() },
  )
}

export async function indexProject(
  projectRoot: string,
  server: McpServerDefinition,
  mode: EngineIndexMode,
): Promise<number> {
  const result = await indexProjectDetailed(projectRoot, server, mode)
  return result.exitCode
}

export async function serveProject(
  projectRoot: string,
  server: McpServerDefinition,
): Promise<number> {
  return runMcpEngine(projectRoot, server, [])
}
