import { lstat, readdir, realpath } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"
import { discoverProjectKnowledge, type KnowledgeEntry, type KnowledgeInventory } from "./store"

export type KnowledgeRepository = {
  readonly origin: string
  readonly path: string
}

export type KnowledgeRepositoryStatus = KnowledgeRepository & {
  readonly revision?: string
  readonly workingTree: "clean" | "dirty" | "unknown"
  readonly available: boolean
}

export type KnowledgeIssue = {
  readonly code:
    | "duplicate_identifier"
    | "missing_supersession_target"
    | "supersession_status_mismatch"
    | "supersession_cycle"
    | "missing_revision_anchor"
    | "unknown_origin"
    | "stale_revision"
    | "unverified_worktree"
    | "truncated_inventory"
  readonly severity: "error" | "warning"
  readonly path: string
  readonly message: string
  readonly relatedPaths?: readonly string[]
}

export type KnowledgeReconcileReport = {
  readonly root: string
  readonly generatedAt: string
  readonly status: "clean" | "warn" | "fail"
  readonly records: number
  readonly activeRecords: number
  readonly staleRecords: number
  readonly unknownRecords: number
  readonly repositories: readonly KnowledgeRepositoryStatus[]
  readonly issues: readonly KnowledgeIssue[]
}

export type KnowledgeSyncReport = KnowledgeReconcileReport & {
  readonly checkOnly: boolean
  readonly updated: readonly string[]
  readonly upgraded: readonly string[]
  readonly stale: readonly string[]
  readonly fresh: number
  readonly skipped: number
}

type ProcessResult = {
  readonly exitCode: number
  readonly output: string
}

const REVISION_PATTERN = /^[a-f0-9]{7,}$/i

function processEnvironment(): Record<string, string> {
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

function runGit(repository: string, args: readonly string[]): ProcessResult {
  const result = Bun.spawnSync(["git", "-C", repository, "--no-optional-locks", ...args], {
    env: processEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  return {
    exitCode: result.exitCode,
    output: new TextDecoder().decode(result.stdout),
  }
}

function validRepositoryPath(path: string): boolean {
  try {
    const result = runGit(path, ["rev-parse", "--show-toplevel"])
    return result.exitCode === 0
  } catch {
    return false
  }
}

function repositoryStatus(repository: KnowledgeRepository): KnowledgeRepositoryStatus {
  if (!validRepositoryPath(repository.path)) {
    return { ...repository, available: false, workingTree: "unknown" }
  }
  const revisionResult = runGit(repository.path, ["rev-parse", "--verify", "HEAD"])
  const statusResult = runGit(repository.path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
  const revision =
    revisionResult.exitCode === 0 ? revisionResult.output.trim() || undefined : undefined
  const workingTree =
    statusResult.exitCode !== 0
      ? "unknown"
      : statusResult.output.trim().length === 0
        ? "clean"
        : "dirty"
  return {
    ...repository,
    available: true,
    ...(revision === undefined ? {} : { revision }),
    workingTree,
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/")
}

function normalizeIdentifier(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("\\", "/")
  const withoutPrefix = normalized.replace(/^adr[-_]?/, "")
  const numeric = withoutPrefix.match(/^0*(\d+)$/)
  return numeric?.[1] === undefined ? withoutPrefix : numeric[1]
}

function entryKeys(entry: KnowledgeEntry): readonly string[] {
  const keys = new Set<string>()
  if (entry.identifier !== undefined) keys.add(normalizeIdentifier(entry.identifier))
  const file = basename(entry.path.split("#", 1)[0] ?? "")
  if (file.length > 0) {
    const withoutExtension = file.replace(/\.md$/i, "")
    keys.add(normalizeIdentifier(withoutExtension))
  }
  return [...keys].filter((key) => key.length > 0)
}

function frontmatter(contents: string): string | undefined {
  return contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
}

function yamlValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === "null") return undefined
  return trimmed.replace(/^("|')(.*)\1$/, "$2")
}

function verifiedRevisions(contents: string): ReadonlyMap<string, string> {
  const text = frontmatter(contents)
  if (text === undefined) return new Map()
  const lines = text.split(/\r?\n/)
  const revisions = new Map<string, string>()
  let inMap = false
  for (const line of lines) {
    const header = line.match(/^verified_at_rev[ \t]*:[ \t]*(.*)$/)
    if (header !== null) {
      const value = yamlValue(header[1] ?? "")
      if (value !== undefined && REVISION_PATTERN.test(value)) revisions.set("project", value)
      inMap = value === undefined
      continue
    }
    if (!inMap) continue
    const item = line.match(/^\s{2,}([^:#]+):\s*(.+)$/)
    if (item !== null) {
      const key = item[1]?.trim()
      const value = yamlValue(item[2] ?? "")
      if (key !== undefined && value !== undefined && REVISION_PATTERN.test(value)) {
        revisions.set(key, value)
      }
      continue
    }
    if (line.trim().length > 0 && !/^\s/.test(line)) inMap = false
  }
  return revisions
}

function replaceVerification(
  contents: string,
  revisions: ReadonlyMap<string, string>,
  date: string,
): string {
  const match = contents.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/)
  if (match === null) throw new Error("Knowledge record has no valid frontmatter")
  const lines = (match[2] ?? "").split(/\r?\n/)
  const next: string[] = []
  let replacedRevision = false
  let replacedDate = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    if (/^verified_at_rev\s*:/.test(line)) {
      if (!replacedRevision) {
        next.push("verified_at_rev:")
        for (const [origin, revision] of [...revisions.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          next.push(`  ${origin}: "${revision}"`)
        }
        replacedRevision = true
      }
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1] ?? "")) index += 1
      continue
    }
    if (/^last_verified\s*:/.test(line)) {
      next.push(`last_verified: ${date}`)
      replacedDate = true
      continue
    }
    next.push(line)
  }
  if (!replacedRevision) {
    const dateIndex = next.findIndex((line) => /^last_verified\s*:/.test(line))
    const insertion = ["verified_at_rev:"]
    for (const [origin, revision] of [...revisions.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      insertion.push(`  ${origin}: "${revision}"`)
    }
    next.splice(dateIndex < 0 ? next.length : dateIndex, 0, ...insertion)
  }
  if (!replacedDate) next.push(`last_verified: ${date}`)
  return `${match[1]}${next.join("\n")}${match[3]}${contents.slice(match[0].length)}`
}

function artifactChanged(
  repository: string,
  revision: string,
  artifacts: readonly string[],
): boolean {
  const result = runGit(repository, ["diff", "--name-only", `${revision}..HEAD`])
  if (result.exitCode !== 0) return true
  const changed = result.output
    .split(/\r?\n/)
    .map((path) => normalizePath(path.trim()))
    .filter((path) => path.length > 0)
  if (artifacts.length === 0) return true
  return artifacts.some((artifact) => {
    const normalized = normalizePath(artifact)
    return changed.some((path) => path === normalized || path.endsWith(`/${normalized}`))
  })
}

async function configuredRepositories(
  projectRoot: string,
  knowledgeRoot: string,
  explicit: readonly KnowledgeRepository[],
): Promise<readonly KnowledgeRepository[]> {
  const repositories = new Map<string, KnowledgeRepository>()
  for (const repository of explicit) {
    repositories.set(repository.origin, {
      origin: repository.origin,
      path: resolve(repository.path),
    })
  }
  const add = (origin: string, path: string): void => {
    if (repositories.has(origin)) return
    repositories.set(origin, { origin, path: resolve(path) })
  }
  if (await validRepositoryDirectory(projectRoot)) {
    const name = basename(resolve(projectRoot)).toLowerCase()
    add(name, projectRoot)
    add(name.startsWith("cambrian-") ? name : `cambrian-${name}`, projectRoot)
  } else {
    try {
      const entries = await readdir(projectRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const path = join(projectRoot, entry.name)
        if (!(await validRepositoryDirectory(path))) continue
        const name = entry.name.toLowerCase()
        add(name, path)
        add(name.startsWith("cambrian-") ? name : `cambrian-${name}`, path)
      }
    } catch {
      // The report will surface explicit unknown origins rather than hiding the failure.
    }
  }
  if (await validRepositoryDirectory(knowledgeRoot)) {
    const name = basename(resolve(knowledgeRoot)).toLowerCase()
    add(name, knowledgeRoot)
  }
  return [...repositories.values()].sort((left, right) => left.origin.localeCompare(right.origin))
}

async function validRepositoryDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory()) return false
    await realpath(path)
    return validRepositoryPath(path)
  } catch {
    return false
  }
}

function repositoryForOrigin(
  origin: string,
  repositories: readonly KnowledgeRepositoryStatus[],
  projectRoot: string,
): KnowledgeRepositoryStatus | undefined {
  const normalized = origin.toLowerCase()
  return (
    repositories.find((repository) => repository.origin.toLowerCase() === normalized) ??
    (normalized === "project"
      ? repositories.find((repository) => resolve(repository.path) === resolve(projectRoot))
      : undefined)
  )
}

function defaultOrigin(repositories: readonly KnowledgeRepositoryStatus[]): string {
  return repositories.some((repository) => repository.origin.toLowerCase() === "cambrian-core")
    ? "cambrian-core"
    : "project"
}

async function entryContents(
  projectRoot: string,
  inventory: KnowledgeInventory,
  entry: KnowledgeEntry,
): Promise<string | undefined> {
  if (entry.path.includes("#")) return undefined
  const absolute = resolve(projectRoot, entry.path)
  const rootRelative = relative(inventory.root, absolute)
  if (rootRelative === ".." || rootRelative.startsWith(`..${sep}`)) return undefined
  const file = await readManagedFile(inventory.root, rootRelative)
  return file.exists ? file.contents : undefined
}

function issueStatus(issues: readonly KnowledgeIssue[]): "clean" | "warn" | "fail" {
  if (issues.some((issue) => issue.severity === "error")) return "fail"
  return issues.length === 0 ? "clean" : "warn"
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
}

async function artifactsPresent(
  artifacts: readonly string[],
  origins: readonly string[],
  repositories: readonly KnowledgeRepositoryStatus[],
  projectRoot: string,
): Promise<boolean> {
  if (artifacts.length === 0) return false
  let found = 0
  for (const artifact of artifacts) {
    const normalized = normalizePath(artifact)
    if (normalized.length === 0 || normalized.startsWith("/")) continue
    let exists = false
    for (const origin of origins) {
      const repository = repositoryForOrigin(origin, repositories, projectRoot)
      if (repository === undefined || !repository.available) continue
      const candidate = resolve(repository.path, normalized)
      if (!isWithin(repository.path, candidate)) continue
      try {
        const stats = await lstat(candidate)
        if (stats.isFile() || stats.isDirectory()) {
          exists = true
          break
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
        throw error
      }
    }
    if (exists) found += 1
  }
  return found > 0 && found >= artifacts.length * 0.8
}

async function statusUpgrade(
  projectRoot: string,
  entry: KnowledgeEntry,
  repositories: readonly KnowledgeRepositoryStatus[],
): Promise<boolean> {
  const status = entry.status?.toLowerCase()
  if (status !== "proposed" && status !== "accepted") return false
  if (entry.gatePassed?.toLowerCase() === "true") return true
  const origins =
    (entry.origins ?? []).length === 0 ? [defaultOrigin(repositories)] : (entry.origins ?? [])
  return artifactsPresent(entry.artifacts ?? [], origins, repositories, projectRoot)
}

function applyStatusUpgrade(contents: string, date: string): string {
  let next = contents.replace(
    /^(status[ \t]*:[ \t]*)(?:["'][^"']*["']|\S+)[ \t]*$/m,
    "$1implemented",
  )
  next = next.replace(/^(gate_date[ \t]*:[ \t]*)null[ \t]*$/m, `$1${date}`)
  return next
}

export async function reconcileKnowledge(
  projectRoot: string,
  configuredDirectory: string | undefined,
  explicitRepositories: readonly KnowledgeRepository[] = [],
): Promise<KnowledgeReconcileReport> {
  const inventory = await discoverProjectKnowledge(projectRoot, configuredDirectory)
  const repositories = (
    await configuredRepositories(projectRoot, inventory.root, explicitRepositories)
  ).map(repositoryStatus)
  const issues: KnowledgeIssue[] = []
  if (inventory.truncated) {
    issues.push({
      code: "truncated_inventory",
      severity: "error",
      path: inventory.root,
      message: "Knowledge discovery reached its safety limit; the report is incomplete",
    })
  }
  const canonical = inventory.entries.filter((entry) => entry.authority === "canonical")
  const identifiers = new Map<string, KnowledgeEntry[]>()
  for (const entry of canonical.filter((candidate) => !candidate.path.includes("#"))) {
    for (const key of entryKeys(entry)) {
      const identifierKey = `${entry.kind}:${key}`
      const entries = identifiers.get(identifierKey) ?? []
      entries.push(entry)
      identifiers.set(identifierKey, entries)
    }
  }
  for (const entries of identifiers.values()) {
    if (entries.length < 2) continue
    issues.push({
      code: "duplicate_identifier",
      severity: "error",
      path: entries[0]?.path ?? inventory.root,
      message: `Knowledge identifier is duplicated across ${entries.length} records`,
      relatedPaths: entries.map((entry) => entry.path),
    })
  }
  const entryByKey = new Map<string, KnowledgeEntry>()
  for (const entry of canonical.filter((candidate) => !candidate.path.includes("#"))) {
    for (const key of entryKeys(entry)) if (!entryByKey.has(key)) entryByKey.set(key, entry)
  }
  for (const entry of canonical) {
    if (entry.supersededBy !== undefined) {
      const target = entryByKey.get(normalizeIdentifier(entry.supersededBy))
      if (target === undefined) {
        issues.push({
          code: "missing_supersession_target",
          severity: "error",
          path: entry.path,
          message: `superseded_by points to missing record ${entry.supersededBy}`,
        })
      } else if (entry.status?.toLowerCase() !== "superseded") {
        issues.push({
          code: "supersession_status_mismatch",
          severity: "error",
          path: entry.path,
          message: "A record with superseded_by must have status: superseded",
          relatedPaths: [target.path],
        })
      }
    } else if (entry.status?.toLowerCase() === "superseded") {
      issues.push({
        code: "supersession_status_mismatch",
        severity: "error",
        path: entry.path,
        message: "A superseded record must declare superseded_by",
      })
    }
    for (const targetReference of entry.supersedes ?? []) {
      const target = entryByKey.get(normalizeIdentifier(targetReference))
      if (
        target !== undefined &&
        normalizeIdentifier(target.supersededBy ?? "") !==
          normalizeIdentifier(entry.identifier ?? "")
      ) {
        issues.push({
          code: "supersession_status_mismatch",
          severity: "warning",
          path: entry.path,
          message: `supersedes points to ${targetReference}, but the target does not point back`,
          relatedPaths: [target.path],
        })
      }
    }
  }
  for (const entry of canonical) {
    const seen = new Set<string>()
    let current: KnowledgeEntry | undefined = entry
    while (current?.supersededBy !== undefined) {
      const key = normalizeIdentifier(current.identifier ?? current.path)
      if (seen.has(key)) {
        issues.push({
          code: "supersession_cycle",
          severity: "error",
          path: entry.path,
          message: "Supersession chain is circular",
        })
        break
      }
      seen.add(key)
      current = entryByKey.get(normalizeIdentifier(current.supersededBy))
      if (current === undefined) break
    }
  }
  for (const entry of canonical) {
    if (entry.path.includes("#")) continue
    const contents = await entryContents(projectRoot, inventory, entry)
    const revisions =
      contents === undefined ? new Map<string, string>() : verifiedRevisions(contents)
    const origins =
      (entry.origins ?? []).length === 0 ? [defaultOrigin(repositories)] : (entry.origins ?? [])
    for (const origin of origins) {
      const repository = repositoryForOrigin(origin, repositories, projectRoot)
      if (repository === undefined || !repository.available) {
        issues.push({
          code: "unknown_origin",
          severity: "warning",
          path: entry.path,
          message: `No readable Git repository is configured for origin ${origin}`,
        })
        continue
      }
      const recorded =
        revisions.get(origin) ?? (origins.length === 1 ? revisions.get("project") : undefined)
      if (recorded === undefined) {
        issues.push({
          code: "missing_revision_anchor",
          severity: "warning",
          path: entry.path,
          message: `No verified_at_rev anchor exists for origin ${origin}`,
        })
        continue
      }
      if (repository.revision === undefined || repository.workingTree === "unknown") {
        issues.push({
          code: "unverified_worktree",
          severity: "warning",
          path: entry.path,
          message: `Could not verify the current revision for origin ${origin}`,
        })
        continue
      }
      if (!sameRevision(repository.revision, recorded)) {
        if (artifactChanged(repository.path, recorded, entry.artifacts ?? [])) {
          issues.push({
            code: "stale_revision",
            severity: "warning",
            path: entry.path,
            message: `Verified revision for ${origin} is behind ${repository.revision.slice(0, 12)}`,
          })
        }
      }
    }
  }
  return {
    root: inventory.root,
    generatedAt: new Date().toISOString(),
    status: issueStatus(issues),
    records: canonical.length,
    activeRecords: canonical.filter(
      (entry) => !entry.supersededBy && entry.status?.toLowerCase() !== "retired",
    ).length,
    staleRecords: canonical.filter((entry) => entry.freshness === "stale").length,
    unknownRecords: canonical.filter((entry) => entry.freshness === "unknown").length,
    repositories,
    issues,
  }
}

function sameRevision(left: string, right: string): boolean {
  return (
    left.toLowerCase() === right.toLowerCase() ||
    left.toLowerCase().startsWith(right.toLowerCase()) ||
    right.toLowerCase().startsWith(left.toLowerCase())
  )
}

export async function syncKnowledge(
  projectRoot: string,
  configuredDirectory: string | undefined,
  explicitRepositories: readonly KnowledgeRepository[] = [],
  write = false,
): Promise<KnowledgeSyncReport> {
  const inventory = await discoverProjectKnowledge(projectRoot, configuredDirectory)
  const repositoryDefinitions = await configuredRepositories(
    projectRoot,
    inventory.root,
    explicitRepositories,
  )
  const repositories = repositoryDefinitions.map(repositoryStatus)
  const updated: string[] = []
  const upgraded: string[] = []
  const stale: string[] = []
  let fresh = 0
  let skipped = 0
  const issues: KnowledgeIssue[] = []
  for (const entry of inventory.entries.filter(
    (candidate) => candidate.authority === "canonical" && !candidate.path.includes("#"),
  )) {
    const contents = await entryContents(projectRoot, inventory, entry)
    if (contents === undefined) {
      skipped += 1
      continue
    }
    const revisions = new Map(verifiedRevisions(contents))
    const origins =
      (entry.origins ?? []).length === 0 ? [defaultOrigin(repositories)] : (entry.origins ?? [])
    let needsUpdate = false
    for (const origin of origins) {
      const repository = repositoryForOrigin(origin, repositories, projectRoot)
      if (repository === undefined || !repository.available || repository.revision === undefined) {
        issues.push({
          code: "unknown_origin",
          severity: "warning",
          path: entry.path,
          message: `Cannot sync origin ${origin}: repository is unavailable or has no commit`,
        })
        continue
      }
      const recorded =
        revisions.get(origin) ?? (origins.length === 1 ? revisions.get("project") : undefined)
      if (recorded === undefined || !sameRevision(repository.revision, recorded)) {
        if (
          recorded === undefined ||
          artifactChanged(repository.path, recorded, entry.artifacts ?? [])
        )
          needsUpdate = true
        revisions.set(origin, repository.revision)
      }
    }
    const shouldUpgrade = await statusUpgrade(projectRoot, entry, repositories)
    if (!needsUpdate && !shouldUpgrade) {
      fresh += 1
      continue
    }
    if (needsUpdate) stale.push(entry.path)
    if (!write) {
      if (shouldUpgrade) upgraded.push(entry.path)
      continue
    }
    const date = new Date().toISOString().slice(0, 10)
    const next = shouldUpgrade
      ? applyStatusUpgrade(
          needsUpdate ? replaceVerification(contents, revisions, date) : contents,
          date,
        )
      : replaceVerification(contents, revisions, date)
    const rootRelative = relative(inventory.root, resolve(projectRoot, entry.path))
    await writeManagedFile(inventory.root, rootRelative, next)
    updated.push(entry.path)
    if (shouldUpgrade) upgraded.push(entry.path)
  }
  const base = await reconcileKnowledge(projectRoot, configuredDirectory, explicitRepositories)
  const combinedIssues = [...base.issues, ...issues]
  return {
    ...base,
    generatedAt: new Date().toISOString(),
    status: issueStatus(combinedIssues),
    issues: combinedIssues,
    checkOnly: !write,
    updated,
    upgraded,
    stale,
    fresh,
    skipped,
  }
}

export async function discoverKnowledgeRepositories(
  projectRoot: string,
  knowledgeRoot: string,
  explicitRepositories: readonly KnowledgeRepository[] = [],
): Promise<readonly KnowledgeRepository[]> {
  return configuredRepositories(projectRoot, knowledgeRoot, explicitRepositories)
}

export function repositoryAssignment(value: string): KnowledgeRepository | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0 || separator === value.length - 1) return undefined
  const origin = value.slice(0, separator).trim()
  const path = value.slice(separator + 1).trim()
  return origin.length === 0 || path.length === 0 ? undefined : { origin, path }
}
