import { createHash, randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import type { McpServerDefinition } from "../agents/mcp"
import type { EngineIndexMode } from "../engine"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"

const PROJECT_STATE_PATH = ".skald/state.json"
const PROJECT_STATE_VERSION = 1 as const
const GIT_OUTPUT_LIMIT = 64 * 1024
const GIT_TIMEOUT_MS = 2_000
const MAX_INDEX_RUNS = 20
const GIT_SCOPED_PATHS = [
  ".",
  ":(exclude).skald/**",
  ":(exclude).mcp.json",
  ":(exclude)opencode.json",
  ":(exclude)opencode.jsonc",
  ":(exclude).opencode/**",
  ":(exclude).claude/.mcp.json",
  ":(exclude).claude/settings.json",
  ":(exclude).codex/**",
] as const

export type ProjectGitSnapshot = {
  readonly revision: string | undefined
  readonly workingTree: "clean" | "dirty" | "unknown"
  readonly repositoryRevisions?: Readonly<Record<string, string>>
}

export type ProjectIndexState = {
  readonly status: "indexed" | "degraded"
  readonly mode: EngineIndexMode
  readonly engine: {
    readonly command: string
    readonly sha256: string
  }
  readonly backendProject?: string
  readonly revision: string | undefined
  readonly workingTree: ProjectGitSnapshot["workingTree"]
  readonly indexedAt: string
}

export type ProjectIndexRun = {
  readonly id: string
  readonly trigger: "manual" | "automatic" | "setup"
  readonly status: "indexed" | "degraded"
  readonly mode: EngineIndexMode
  readonly engine: { readonly command: string; readonly sha256: string }
  readonly backendProject?: string
  readonly revision: string | undefined
  readonly workingTree: ProjectGitSnapshot["workingTree"]
  readonly indexedAt: string
}

export type ProjectState = {
  readonly version: typeof PROJECT_STATE_VERSION
  readonly project: { readonly root: "." }
  readonly index?: ProjectIndexState
  readonly runs?: readonly ProjectIndexRun[]
}

export type ProjectStateRead = {
  readonly state: ProjectState | undefined
  readonly warning: string | undefined
}

export type ProjectFreshness = {
  readonly status: "fresh" | "stale" | "degraded" | "unknown"
  readonly currentRevision: string | undefined
  readonly indexedRevision: string | undefined
  readonly workingTree: ProjectGitSnapshot["workingTree"]
  readonly detail: string
}

export type ProjectEngineIdentity = {
  readonly command: string
  readonly sha256: string | undefined
}

type ProcessResult = {
  readonly exitCode: number
  readonly output: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

function safeGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const key of ["HOME", "LANG", "LC_ALL", "PATH", "TMP", "TMPDIR"]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function processErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function isProcessGone(error: unknown): boolean {
  const code = processErrorCode(error)
  return code === "ESRCH" || code === "ECHILD" || code === "ERR_PROCESS_NOT_RUNNING"
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ readonly output: string; readonly truncated: boolean }> {
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
    return { output, truncated }
  } finally {
    reader.releaseLock()
  }
}

async function runGit(projectRoot: string, args: readonly string[]): Promise<ProcessResult> {
  const child = Bun.spawn(
    ["git", "-C", projectRoot, "-c", "core.fsmonitor=false", "--no-optional-locks", ...args],
    {
      env: safeGitEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  )
  const outputPromise =
    typeof child.stdout === "object" && child.stdout !== null
      ? readBoundedStream(child.stdout, GIT_OUTPUT_LIMIT)
      : Promise.resolve({ output: "", truncated: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), GIT_TIMEOUT_MS)
  })
  const completed = Promise.all([child.exited, outputPromise]).then(([exitCode, output]) => ({
    kind: "completed" as const,
    exitCode,
    ...output,
  }))
  const result = await Promise.race([completed, timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (result === "timeout") {
    try {
      child.kill("SIGTERM")
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
    await Promise.race([child.exited, waitMs(100)])
    await outputPromise.catch(() => undefined)
    return { exitCode: 1, output: "", truncated: false, timedOut: true }
  }
  return { ...result, timedOut: false }
}

async function gitWorkingTree(projectRoot: string): Promise<ProjectGitSnapshot["workingTree"]> {
  const [trackedResult, untrackedResult] = await Promise.all([
    runGit(projectRoot, ["diff", "--quiet", "HEAD", "--", ...GIT_SCOPED_PATHS]),
    runGit(projectRoot, ["ls-files", "--others", "--exclude-standard", "--", ...GIT_SCOPED_PATHS]),
  ])
  const trackedDirty = trackedResult.exitCode === 1 && !trackedResult.timedOut
  const trackedUnknown = trackedResult.timedOut || (trackedResult.exitCode !== 0 && !trackedDirty)
  const untrackedDirty =
    untrackedResult.exitCode === 0 &&
    (untrackedResult.truncated || untrackedResult.output.trim().length > 0)
  const untrackedUnknown = untrackedResult.timedOut || untrackedResult.exitCode !== 0
  if (trackedDirty || untrackedDirty) return "dirty"
  if (trackedUnknown || untrackedUnknown) return "unknown"
  return "clean"
}

export async function currentGitSnapshot(projectRoot: string): Promise<ProjectGitSnapshot> {
  const [revisionResult, workingTree] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "--verify", "HEAD"]),
    gitWorkingTree(projectRoot),
  ])
  const revision =
    revisionResult.exitCode === 0 && !revisionResult.truncated
      ? revisionResult.output.trim() || undefined
      : undefined
  if (revision !== undefined || workingTree !== "unknown") {
    const name = projectRoot.split(/[\\/]/).pop()?.toLowerCase()
    const repositoryRevisions =
      revision === undefined || name === undefined
        ? undefined
        : {
            [name]: revision,
            [name.startsWith("cambrian-") ? name : `cambrian-${name}`]: revision,
          }
    return {
      revision,
      workingTree,
      ...(repositoryRevisions === undefined ? {} : { repositoryRevisions }),
    }
  }

  const workspace = await workspaceSnapshot(projectRoot)
  if (workspace !== undefined) return workspace
  return { revision, workingTree }
}

async function workspaceSnapshot(projectRoot: string): Promise<ProjectGitSnapshot | undefined> {
  let entries: readonly Dirent[]
  try {
    entries = await readdir(projectRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  const repositories: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    try {
      const marker = await lstat(join(projectRoot, entry.name, ".git"))
      if (marker.isDirectory() || marker.isFile()) repositories.push(join(projectRoot, entry.name))
    } catch {}
  }
  if (repositories.length === 0) return undefined
  repositories.sort((left, right) => left.localeCompare(right))
  const snapshots = await Promise.all(
    repositories.map(async (repository) => {
      const [revisionResult, workingTree] = await Promise.all([
        runGit(repository, ["rev-parse", "--verify", "HEAD"]),
        gitWorkingTree(repository),
      ])
      const revision =
        revisionResult.exitCode === 0 && !revisionResult.truncated
          ? revisionResult.output.trim() || undefined
          : undefined
      return {
        path: relative(projectRoot, repository).replaceAll("\\", "/"),
        revision,
        workingTree,
      }
    }),
  )
  const revision = snapshots.every((snapshot) => snapshot.revision !== undefined)
    ? `workspace:${createHash("sha256")
        .update(snapshots.map((snapshot) => `${snapshot.path}:${snapshot.revision}`).join("\n"))
        .digest("hex")}`
    : undefined
  const workingTree = snapshots.some((snapshot) => snapshot.workingTree === "unknown")
    ? "unknown"
    : snapshots.some((snapshot) => snapshot.workingTree === "dirty")
      ? "dirty"
      : "clean"
  const repositoryRevisions: Record<string, string> = {}
  for (const snapshot of snapshots) {
    if (snapshot.revision === undefined) continue
    const name = snapshot.path.toLowerCase()
    repositoryRevisions[name] = snapshot.revision
    repositoryRevisions[name.startsWith("cambrian-") ? name : `cambrian-${name}`] =
      snapshot.revision
  }
  return {
    revision,
    workingTree,
    ...(Object.keys(repositoryRevisions).length === 0 ? {} : { repositoryRevisions }),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isIndexMode(value: unknown): value is EngineIndexMode {
  return value === "fast" || value === "moderate" || value === "full"
}

function parseState(value: unknown): ProjectState | undefined {
  if (!isObject(value) || value["version"] !== PROJECT_STATE_VERSION) return undefined
  const project = value["project"]
  const index = value["index"]
  if (!isObject(project) || project["root"] !== ".") return undefined
  if (index === undefined) return { version: PROJECT_STATE_VERSION, project: { root: "." } }
  if (!isObject(index) || !isIndexMode(index["mode"])) return undefined
  const engine = index["engine"]
  if (
    !isObject(engine) ||
    typeof engine["command"] !== "string" ||
    typeof engine["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(engine["sha256"])
  ) {
    return undefined
  }
  const status = index["status"]
  const workingTree = index["workingTree"]
  if (
    (status !== "indexed" && status !== "degraded") ||
    (workingTree !== "clean" && workingTree !== "dirty" && workingTree !== "unknown") ||
    (index["revision"] !== undefined && typeof index["revision"] !== "string") ||
    typeof index["indexedAt"] !== "string"
  ) {
    return undefined
  }
  const runsValue = value["runs"]
  if (runsValue !== undefined && !Array.isArray(runsValue)) return undefined
  return {
    version: PROJECT_STATE_VERSION,
    project: { root: "." },
    index: {
      status,
      mode: index["mode"],
      engine: { command: engine["command"], sha256: engine["sha256"] },
      ...(typeof index["backendProject"] === "string"
        ? { backendProject: index["backendProject"] }
        : {}),
      revision: typeof index["revision"] === "string" ? index["revision"] : undefined,
      workingTree,
      indexedAt: index["indexedAt"],
    },
    ...(runsValue === undefined ? {} : { runs: parseRuns(runsValue) }),
  }
}

function parseRuns(value: readonly unknown[]): readonly ProjectIndexRun[] {
  const runs: ProjectIndexRun[] = []
  for (const candidate of value.slice(0, MAX_INDEX_RUNS)) {
    if (!isObject(candidate)) continue
    const engine = candidate["engine"]
    const trigger = candidate["trigger"]
    const status = candidate["status"]
    const workingTree = candidate["workingTree"]
    if (
      typeof candidate["id"] !== "string" ||
      (trigger !== "manual" && trigger !== "automatic" && trigger !== "setup") ||
      (status !== "indexed" && status !== "degraded") ||
      !isIndexMode(candidate["mode"]) ||
      !isObject(engine) ||
      typeof engine["command"] !== "string" ||
      typeof engine["sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(engine["sha256"]) ||
      (workingTree !== "clean" && workingTree !== "dirty" && workingTree !== "unknown") ||
      (candidate["revision"] !== undefined && typeof candidate["revision"] !== "string") ||
      typeof candidate["indexedAt"] !== "string"
    ) {
      continue
    }
    runs.push({
      id: candidate["id"],
      trigger,
      status,
      mode: candidate["mode"],
      engine: { command: engine["command"], sha256: engine["sha256"] },
      ...(typeof candidate["backendProject"] === "string"
        ? { backendProject: candidate["backendProject"] }
        : {}),
      revision: typeof candidate["revision"] === "string" ? candidate["revision"] : undefined,
      workingTree,
      indexedAt: candidate["indexedAt"],
    })
  }
  return runs
}

export async function readProjectState(projectRoot: string): Promise<ProjectStateRead> {
  const existing = await readManagedFile(projectRoot, PROJECT_STATE_PATH)
  if (!existing.exists) return { state: undefined, warning: undefined }
  try {
    const value: unknown = JSON.parse(existing.contents ?? "")
    const state = parseState(value)
    return state === undefined
      ? { state: undefined, warning: "Project state is malformed; freshness is unknown" }
      : { state, warning: undefined }
  } catch {
    return { state: undefined, warning: "Project state is not valid JSON; freshness is unknown" }
  }
}

export function assessProjectFreshness(
  state: ProjectState | undefined,
  current: ProjectGitSnapshot,
  engine?: ProjectEngineIdentity,
): ProjectFreshness {
  const index = state?.index
  if (index === undefined) {
    return {
      status: "unknown",
      currentRevision: current.revision,
      indexedRevision: undefined,
      workingTree: current.workingTree,
      detail: "No Skald index run is recorded",
    }
  }
  if (
    current.revision === undefined ||
    index.revision === undefined ||
    current.workingTree === "unknown"
  ) {
    return {
      status: "unknown",
      currentRevision: current.revision,
      indexedRevision: index.revision,
      workingTree: current.workingTree,
      detail: "The repository revision or working-tree state could not be verified",
    }
  }
  if (engine !== undefined && engine.sha256 === undefined) {
    return {
      status: "unknown",
      currentRevision: current.revision,
      indexedRevision: index.revision,
      workingTree: current.workingTree,
      detail: "The configured engine digest could not be verified",
    }
  }
  if (engine !== undefined && engine.sha256 !== index.engine.sha256) {
    return {
      status: "stale",
      currentRevision: current.revision,
      indexedRevision: index.revision,
      workingTree: current.workingTree,
      detail: "The configured engine changed after the recorded index run",
    }
  }
  if (current.revision !== index.revision || current.workingTree !== "clean") {
    return {
      status: "stale",
      currentRevision: current.revision,
      indexedRevision: index.revision,
      workingTree: current.workingTree,
      detail:
        current.revision !== index.revision
          ? "The repository revision changed after the recorded index run"
          : "The repository has uncommitted changes after the recorded index run",
    }
  }
  return {
    status: index.status === "degraded" ? "degraded" : "fresh",
    currentRevision: current.revision,
    indexedRevision: index.revision,
    workingTree: current.workingTree,
    detail:
      index.status === "degraded"
        ? "The last index completed with skipped or partially parsed files"
        : "The repository matches the recorded index revision",
  }
}

export async function recordProjectIndex(
  projectRoot: string,
  server: McpServerDefinition,
  mode: EngineIndexMode,
  status: "indexed" | "degraded",
  backendProject: string | undefined,
  trigger: ProjectIndexRun["trigger"] = "manual",
): Promise<ProjectState> {
  if (server.sha256 === undefined)
    throw new Error("Cannot record an index without an engine digest")
  const snapshot = await currentGitSnapshot(projectRoot)
  const previous = await readProjectState(projectRoot)
  const indexedAt = new Date().toISOString()
  const run: ProjectIndexRun = {
    id: randomUUID(),
    trigger,
    status,
    mode,
    engine: { command: server.command, sha256: server.sha256 },
    ...(backendProject === undefined ? {} : { backendProject }),
    revision: snapshot.revision,
    workingTree: snapshot.workingTree,
    indexedAt,
  }
  const state: ProjectState = {
    version: PROJECT_STATE_VERSION,
    project: { root: "." },
    index: {
      status,
      mode,
      engine: { command: server.command, sha256: server.sha256 },
      ...(backendProject === undefined ? {} : { backendProject }),
      revision: snapshot.revision,
      workingTree: snapshot.workingTree,
      indexedAt,
    },
    runs: [run, ...(previous.state?.runs ?? [])].slice(0, MAX_INDEX_RUNS),
  }
  await writeManagedFile(projectRoot, PROJECT_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
  return state
}
