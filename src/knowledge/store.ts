import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { readConfiguredMcpServer, readProjectManifest } from "../config"
import type {
  KnowledgeRecordInput,
  KnowledgeRecordReceipt,
  SkaldProjectManifest,
} from "../context/contract"
import { attestExecutableMcpServer } from "../engine"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"
import {
  assessProjectFreshness,
  currentGitSnapshot,
  type ProjectGitSnapshot,
  readProjectState,
} from "../project/state"
import { isTrustedMcpExecutable } from "../trust"

const KNOWLEDGE_DIRECTORIES = [
  "adrs",
  "decisions",
  "components",
  "contracts",
  "investigations",
  "research",
] as const

const MAX_KNOWLEDGE_FILES = 512
const MAX_KNOWLEDGE_BYTES = 16 * 1024 * 1024
const MAX_KNOWLEDGE_DEPTH = 16
const LOCAL_CANONICAL_DIRECTORY = ".skald/knowledge-canonical"
const KNOWLEDGE_READ_CHUNK_BYTES = 64 * 1024

export type KnowledgeEntry = {
  readonly kind: string
  readonly path: string
  readonly identifier?: string
  readonly title: string
  readonly summary: string
  readonly status: string | undefined
  readonly supersededBy?: string
  readonly supersedes?: readonly string[]
  readonly dependsOn?: readonly string[]
  readonly origins?: readonly string[]
  readonly artifacts?: readonly string[]
  readonly lastVerified?: string
  readonly gatePassed?: string
  readonly gateDate?: string
  readonly authority: "canonical" | "session"
  readonly freshness: "fresh" | "stale" | "unknown"
  readonly fingerprint?: string
}

export type KnowledgeInventory = {
  readonly root: string
  readonly entries: readonly KnowledgeEntry[]
  readonly truncated: boolean
}

export type KnowledgeReviewRecord = {
  readonly path: string
  readonly kind: string
  readonly title: string
  readonly status: "pending" | "promoted" | "conflict" | "rejected"
  readonly conflicts: readonly string[]
}

export type KnowledgeReview = {
  readonly records: readonly KnowledgeReviewRecord[]
  readonly pending: number
  readonly conflicts: number
}

export type KnowledgePromotionReceipt = {
  readonly action: "promoted" | "exists" | "conflict"
  readonly sourcePath: string
  readonly targetPath?: string
  readonly conflicts: readonly string[]
}

export type KnowledgeRejectionReceipt = {
  readonly action: "rejected" | "exists"
  readonly path: string
}

type WalkState = {
  files: number
  bytes: number
  truncated: boolean
  entries: KnowledgeEntry[]
}

type KnowledgeFreshnessContext = {
  readonly currentRevision: string | undefined
  readonly repositoryKeys: readonly string[]
  readonly currentRevisions?: Readonly<Record<string, string>>
}

function knowledgeKind(directory: string): string {
  switch (directory) {
    case "adrs":
      return "adr"
    case "decisions":
      return "decision"
    case "components":
      return "component"
    case "contracts":
      return "contract"
    case "investigations":
      return "investigation"
    case "research":
      return "research"
    default:
      return "knowledge"
  }
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}[ \\t]*:[ \\t]*(.+)$`, "m"))
  if (match === null) return undefined
  const value = match[1]?.trim()
  if (value === undefined || value === "null") return undefined
  return value.replace(/^(["'])(.*)\1$/, "$2")
}

function listValues(frontmatter: string, key: string): readonly string[] {
  const header = frontmatter.match(new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, "m"))
  if (header === null) return []
  const inline = header[1]?.trim() ?? ""
  if (inline.startsWith("[") && inline.endsWith("]")) {
    return inline
      .slice(1, -1)
      .split(",")
      .map((value) => value.trim().replace(/^("|')(.*)\1$/, "$2"))
      .filter((value) => value.length > 0 && value !== "null")
  }
  if (inline.length > 0 && inline !== "null") return [inline.replace(/^("|')(.*)\1$/, "$2")]
  const lines = frontmatter.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}[ \\t]*:`).test(line))
  if (headerIndex < 0) return []
  const values: string[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length > 0 && !/^\s*-\s+/.test(line) && !/^\s/.test(line)) break
    const item = line.match(/^\s*-\s+(.+)$/)
    if (item?.[1] !== undefined) {
      const value = item[1].trim().replace(/^("|')(.*)\1$/, "$2")
      if (value.length > 0 && value !== "null") values.push(value)
    }
  }
  return values
}

function artifactValues(frontmatter: string): readonly string[] {
  const lines = frontmatter.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => /^artifacts\s*:/.test(line))
  if (headerIndex < 0) return []
  const values: string[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length > 0 && !/^\s*-\s+/.test(line) && !/^\s/.test(line)) break
    const item = line.match(/^\s+(?:file|name)\s*:\s*(.+)$/)
    if (item?.[1] !== undefined) {
      const value = item[1].trim().replace(/^("|')(.*)\1$/, "$2")
      if (value.length > 0 && value !== "null") values.push(value)
    }
  }
  return values
}

function repositoryKeys(projectRoot: string): readonly string[] {
  const name = basename(resolve(projectRoot)).toLowerCase()
  const keys = new Set([name])
  if (name.startsWith("cambrian-")) keys.add(name.slice("cambrian-".length))
  else keys.add(`cambrian-${name}`)
  return [...keys]
}

function parseYamlValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed === "null") return undefined
  return trimmed.replace(/^("|')(.*)\1$/, "$2")
}

function verifiedRevisions(frontmatter: string): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>()
  const lines = frontmatter.split(/\r?\n/)
  let inMap = false
  for (const line of lines) {
    const header = line.match(/^verified_at_rev[ \t]*:[ \t]*(.*)$/)
    if (header !== null) {
      const value = parseYamlValue(header[1] ?? "")
      if (value !== undefined) revisions.set("project", value)
      inMap = value === undefined
      continue
    }
    if (!inMap) continue
    const item = line.match(/^\s{2,}([^:#]+):\s*(.+)$/)
    if (item !== null) {
      const key = item[1]?.trim()
      const value = parseYamlValue(item[2] ?? "")
      if (key !== undefined && value !== undefined) revisions.set(key, value)
      continue
    }
    if (line.trim().length > 0 && !/^\s/.test(line)) inMap = false
  }
  return revisions
}

function sameRevision(current: string, recorded: string): boolean {
  const left = current.toLowerCase()
  const right = recorded.toLowerCase()
  return left === right || left.startsWith(right) || right.startsWith(left)
}

function revisionFreshness(
  revisions: ReadonlyMap<string, string>,
  context: KnowledgeFreshnessContext,
): "fresh" | "stale" | "unknown" {
  const applicable = [...revisions.entries()].filter(([key]) =>
    context.repositoryKeys.some((candidate) => candidate === key.toLowerCase()),
  )
  if (revisions.size === 0) return "stale"
  if (applicable.length === 0) return "unknown"
  return applicable.every(([key, revision]) => {
    const currentRevision =
      context.currentRevisions?.[key] ??
      (applicable.length === 1 ? context.currentRevision : undefined)
    return currentRevision !== undefined && sameRevision(currentRevision, revision)
  })
    ? "fresh"
    : "stale"
}

function bodySummary(body: string): string {
  for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
    const meaningful = paragraph
      .split(/\r?\n/)
      .filter((line) => !/^\s*#{1,6}\s+/.test(line))
      .join("\n")
      .trim()
    if (meaningful.length > 0) return meaningful
  }
  return ""
}

function inactiveKnowledgeStatus(
  status: string | undefined,
  supersededBy: string | undefined,
): boolean {
  return (
    supersededBy !== undefined ||
    ["superseded", "retired", "obsolete", "rejected", "deprecated"].includes(
      status?.toLowerCase() ?? "",
    )
  )
}

export function isKnowledgeActive(entry: KnowledgeEntry): boolean {
  return !inactiveKnowledgeStatus(entry.status, entry.supersededBy)
}

function parseEntry(
  projectRoot: string,
  root: string,
  directory: string,
  absolutePath: string,
  contents: string,
  freshnessContext: KnowledgeFreshnessContext,
): KnowledgeEntry | undefined {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (frontmatter === undefined) return undefined
  const title =
    scalar(frontmatter, "title") ?? scalar(frontmatter, "name") ?? scalar(frontmatter, "id")
  if (title === undefined) return undefined
  const body = contents.slice(contents.indexOf("---", 4) + 3).trim()
  const summary = scalar(frontmatter, "summary") ?? bodySummary(body)
  const path = relative(projectRoot, absolutePath).replaceAll("\\", "/")
  const authority = root === resolve(projectRoot, ".skald", "knowledge") ? "session" : "canonical"
  const revisions = verifiedRevisions(frontmatter)
  const fingerprint = scalar(frontmatter, "fingerprint")
  const supersededBy =
    scalar(frontmatter, "superseded_by") ?? listValues(frontmatter, "superseded_by")[0]
  const status = scalar(frontmatter, "status")
  const identifier = scalar(frontmatter, "id") ?? scalar(frontmatter, "name")
  const supersedes = listValues(frontmatter, "supersedes")
  const dependsOn = listValues(frontmatter, "depends_on")
  const origins = listValues(frontmatter, "origin")
  const artifacts = artifactValues(frontmatter)
  const lastVerified = scalar(frontmatter, "last_verified")
  const gatePassed = scalar(frontmatter, "gate_passed")
  const gateDate = scalar(frontmatter, "gate_date")
  const inactive = inactiveKnowledgeStatus(status, supersededBy)
  const declaredKind = scalar(frontmatter, "kind")
  const parsedKind =
    authority === "session" && declaredKind !== undefined && isKnowledgeKind(declaredKind)
      ? declaredKind
      : knowledgeKind(directory)
  const freshness = inactive
    ? "stale"
    : authority === "session"
      ? "fresh"
      : revisionFreshness(revisions, freshnessContext)
  return {
    kind: parsedKind,
    path,
    ...(identifier === undefined ? {} : { identifier }),
    title,
    summary: summary.slice(0, 1200),
    status,
    authority,
    freshness,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    supersedes,
    dependsOn,
    origins,
    artifacts,
    ...(lastVerified === undefined ? {} : { lastVerified }),
    ...(gatePassed === undefined ? {} : { gatePassed }),
    ...(gateDate === undefined ? {} : { gateDate }),
    ...(fingerprint === undefined ? {} : { fingerprint }),
  }
}

function parseContractIndex(
  projectRoot: string,
  root: string,
  absolutePath: string,
  contents: string,
): readonly KnowledgeEntry[] {
  const path = relative(projectRoot, absolutePath).replaceAll("\\", "/")
  const authority = root === resolve(projectRoot, ".skald", "knowledge") ? "session" : "canonical"
  const entries: KnowledgeEntry[] = []
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /^\|\s*-+/.test(line)) continue
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim())
    const identifier = columns[0]
    const covers = columns[1]
    const status = columns[2]
    const implementedBy = columns[3]
    const lastVerified = columns[4]
    if (
      identifier === undefined ||
      covers === undefined ||
      status === undefined ||
      !/^[-A-Za-z0-9]+$/.test(identifier) ||
      identifier.toLowerCase() === "contract"
    ) {
      continue
    }
    const verified = lastVerified === undefined || lastVerified === "—" ? undefined : lastVerified
    entries.push({
      kind: "contract",
      path: `${path}#${identifier}`,
      identifier,
      title: `Contract ${identifier}: ${covers}`,
      summary: `Status: ${status}. Implemented by: ${implementedBy ?? "—"}. Last verified: ${verified ?? "unknown"}.`,
      status: status === "—" ? undefined : status,
      supersedes: [],
      dependsOn: [],
      origins: [],
      artifacts: [],
      ...(verified === undefined ? {} : { lastVerified: verified }),
      authority,
      freshness: authority === "session" ? "fresh" : "stale",
    })
  }
  return entries
}

async function readKnowledgeFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error(`Knowledge path is not a file: ${path}`)
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let position = 0
    let total = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(
        Math.min(KNOWLEDGE_READ_CHUNK_BYTES, MAX_KNOWLEDGE_BYTES - total + 1),
      )
      const result = await handle.read(buffer, 0, buffer.byteLength, position)
      if (result.bytesRead === 0) break
      total += result.bytesRead
      if (total > MAX_KNOWLEDGE_BYTES) {
        throw new Error(`Knowledge file exceeds ${MAX_KNOWLEDGE_BYTES} bytes: ${path}`)
      }
      chunks.push(decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }))
      position += result.bytesRead
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } finally {
    await handle.close()
  }
}

async function walkKnowledgeDirectory(
  projectRoot: string,
  root: string,
  absoluteDirectory: string,
  directory: string,
  state: WalkState,
  depth: number,
  freshnessContext: KnowledgeFreshnessContext,
): Promise<void> {
  if (state.truncated) return
  if (depth > MAX_KNOWLEDGE_DEPTH) {
    state.truncated = true
    return
  }
  let entries: readonly Dirent[]
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true })
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      return
    }
    state.truncated = true
    return
  }

  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (state.truncated) return
    const absolutePath = join(absoluteDirectory, entry.name)
    if (entry.isSymbolicLink()) {
      state.truncated = true
      continue
    }
    if (entry.isDirectory()) {
      await walkKnowledgeDirectory(
        projectRoot,
        root,
        absolutePath,
        directory,
        state,
        depth + 1,
        freshnessContext,
      )
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    if (state.files >= MAX_KNOWLEDGE_FILES) {
      state.truncated = true
      return
    }
    let stats: Awaited<ReturnType<typeof lstat>>
    try {
      stats = await lstat(absolutePath)
    } catch {
      state.truncated = true
      return
    }
    if (
      !stats.isFile() ||
      stats.size > MAX_KNOWLEDGE_BYTES ||
      state.bytes + stats.size > MAX_KNOWLEDGE_BYTES
    ) {
      state.truncated = true
      return
    }
    let contents: string
    try {
      contents = await readKnowledgeFile(absolutePath)
    } catch {
      state.truncated = true
      return
    }
    state.files += 1
    state.bytes += stats.size
    if (directory === "contracts" && basename(absolutePath) === "INDEX.md") {
      state.entries.push(...parseContractIndex(projectRoot, root, absolutePath, contents))
    } else {
      const parsed = parseEntry(
        projectRoot,
        root,
        directory,
        absolutePath,
        contents,
        freshnessContext,
      )
      if (parsed !== undefined) state.entries.push(parsed)
    }
  }
}

export function resolveKnowledgeRoot(
  projectRoot: string,
  configuredDirectory: string | undefined,
): string {
  if (configuredDirectory === undefined || configuredDirectory.length === 0) {
    return resolve(projectRoot, ".skald", "knowledge")
  }
  return isAbsolute(configuredDirectory)
    ? resolve(configuredDirectory)
    : resolve(projectRoot, configuredDirectory)
}

export async function discoverKnowledge(
  projectRoot: string,
  configuredDirectory?: string,
): Promise<KnowledgeInventory> {
  const git = await currentGitSnapshot(projectRoot)
  return discoverKnowledgeWithContext(projectRoot, configuredDirectory, {
    currentRevision: git.revision,
    repositoryKeys: [...repositoryKeys(projectRoot), ...Object.keys(git.repositoryRevisions ?? {})],
    ...(git.repositoryRevisions === undefined ? {} : { currentRevisions: git.repositoryRevisions }),
  })
}

async function discoverKnowledgeWithContext(
  projectRoot: string,
  configuredDirectory: string | undefined,
  freshnessContext: KnowledgeFreshnessContext,
): Promise<KnowledgeInventory> {
  const root = resolveKnowledgeRoot(projectRoot, configuredDirectory)
  const state: WalkState = { files: 0, bytes: 0, truncated: false, entries: [] }
  try {
    const rootStats = await lstat(root)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      return { root, entries: [], truncated: true }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { root, entries: [], truncated: false }
    }
    throw error
  }
  for (const directory of KNOWLEDGE_DIRECTORIES) {
    if (state.truncated) break
    await walkKnowledgeDirectory(
      projectRoot,
      root,
      join(root, directory),
      directory,
      state,
      0,
      freshnessContext,
    )
  }
  state.entries.sort((left, right) => left.path.localeCompare(right.path))
  return { root, entries: state.entries, truncated: state.truncated }
}

export async function discoverProjectKnowledge(
  projectRoot: string,
  configuredDirectory?: string,
): Promise<KnowledgeInventory> {
  const localRoot = resolveKnowledgeRoot(projectRoot, undefined)
  const configuredRoot = resolveKnowledgeRoot(projectRoot, configuredDirectory)
  const localCanonicalRoot = resolve(projectRoot, LOCAL_CANONICAL_DIRECTORY)
  const roots = [
    localRoot,
    ...(localCanonicalRoot === localRoot ? [] : [localCanonicalRoot]),
    ...(configuredRoot === localRoot || configuredRoot === localCanonicalRoot
      ? []
      : [configuredRoot]),
  ]
  const git = await currentGitSnapshot(projectRoot)
  const freshnessContext = {
    currentRevision: git.revision,
    repositoryKeys: [...repositoryKeys(projectRoot), ...Object.keys(git.repositoryRevisions ?? {})],
    ...(git.repositoryRevisions === undefined ? {} : { currentRevisions: git.repositoryRevisions }),
  }
  const inventories = await Promise.all(
    roots.map((root) => discoverKnowledgeWithContext(projectRoot, root, freshnessContext)),
  )
  const entries = inventories.flatMap((inventory) => inventory.entries)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return {
    root: configuredRoot,
    entries,
    truncated: inventories.some((inventory) => inventory.truncated),
  }
}

function recordDirectory(kind: KnowledgeRecordInput["kind"]): string {
  switch (kind) {
    case "adr":
      return "adrs"
    case "decision":
      return "decisions"
    case "observation":
    case "investigation":
      return "investigations"
    case "measurement":
    case "research":
      return "research"
    case "component":
      return "components"
    case "contract":
      return "contracts"
  }
}

function isKnowledgeKind(value: string): value is KnowledgeRecordInput["kind"] {
  return [
    "adr",
    "decision",
    "observation",
    "measurement",
    "component",
    "contract",
    "investigation",
    "research",
  ].includes(value)
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return normalized.length === 0 ? "record" : normalized.slice(0, 80)
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function recordFingerprint(input: KnowledgeRecordInput, sourceRefs: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        title: input.title.trim(),
        summary: input.summary.trim(),
        sourceRefs: [...new Set(sourceRefs)].sort(),
      }),
    )
    .digest("hex")
}

function sessionRelativePath(projectRoot: string, root: string, path: string): string {
  return relative(root, resolve(projectRoot, path)).replaceAll("\\", "/")
}

async function verifyKnowledgeWrite(projectRoot: string): Promise<ProjectGitSnapshot | undefined> {
  const manifest = await readProjectManifest(projectRoot)
  if (manifest?.freshness.beforeWrite !== "require-verify") return undefined
  const configured = await readConfiguredMcpServer(projectRoot)
  if (configured === undefined) {
    throw new Error("Knowledge writes require a configured, trusted structural engine")
  }
  const attested = await attestExecutableMcpServer(projectRoot, configured, true)
  if (attested === undefined || !(await isTrustedMcpExecutable(projectRoot, attested))) {
    throw new Error(
      "Knowledge writes require an executable engine approved in the user trust registry",
    )
  }
  const current = await currentGitSnapshot(projectRoot)
  const state = await readProjectState(projectRoot)
  const freshness = assessProjectFreshness(state.state, current, {
    command: attested.command,
    sha256: attested.sha256,
  })
  if (freshness.status !== "fresh") {
    throw new Error(
      `Knowledge writes require a fresh verified index; run skald engine index first (${freshness.detail})`,
    )
  }
  return current
}

export async function recordKnowledge(
  projectRoot: string,
  input: KnowledgeRecordInput,
  configuredDirectory?: string,
): Promise<KnowledgeRecordReceipt> {
  const root = resolveKnowledgeRoot(projectRoot, configuredDirectory)
  if (root !== resolve(projectRoot, ".skald", "knowledge")) {
    throw new Error("Canonical knowledge directories are read-only")
  }
  const title = input.title.trim()
  const summary = input.summary.trim()
  if (title.length === 0 || summary.length === 0) {
    throw new Error("Knowledge title and summary are required")
  }
  if (title.length > 400 || summary.length > 16_000) {
    throw new Error("Knowledge title or summary exceeds the safety limit")
  }
  const sourceRefs = input.sourceRefs === undefined ? [] : [...input.sourceRefs]
  if (sourceRefs.length > 32 || sourceRefs.some((source) => source.length > 2_000)) {
    throw new Error("Knowledge sourceRefs exceed the safety limit")
  }
  const fingerprint = recordFingerprint({ ...input, title, summary }, sourceRefs)
  const existing = await discoverProjectKnowledge(projectRoot)
  const duplicate = existing.entries.find(
    (entry) => entry.authority === "session" && entry.fingerprint === fingerprint,
  )
  if (duplicate !== undefined) {
    return {
      path: sessionRelativePath(projectRoot, root, duplicate.path),
      kind: input.kind,
      authority: "session",
      sourceRefs,
      action: "exists",
      fingerprint,
    }
  }
  const verifiedSnapshot = await verifyKnowledgeWrite(projectRoot)
  const date = new Date().toISOString().slice(0, 10)
  const git = verifiedSnapshot ?? (await currentGitSnapshot(projectRoot))
  const identifier = `skald-${date}-${fingerprint.slice(0, 16)}`
  const relativePath = join(
    recordDirectory(input.kind),
    `${date}-${slug(title)}-${fingerprint.slice(0, 16)}.md`,
  )
  const sourceLines =
    sourceRefs.length === 0
      ? "[]"
      : `\n${sourceRefs.map((source) => `  - ${yamlString(source)}`).join("\n")}`
  const contents = [
    "---",
    `id: ${yamlString(identifier)}`,
    `title: ${yamlString(title)}`,
    `kind: ${yamlString(input.kind)}`,
    "status: active",
    `date: ${date}`,
    'origin: ["skald"]',
    `last_verified: ${date}`,
    "verified_at_rev:",
    `  skald: ${git.revision === undefined ? "null" : yamlString(git.revision)}`,
    "authority: session",
    `fingerprint: ${yamlString(fingerprint)}`,
    `source_refs: ${sourceLines}`,
    "---",
    "",
    summary,
    "",
  ].join("\n")
  const written = await writeManagedFile(root, relativePath, contents)
  return {
    path: join(relativePath).replaceAll("\\", "/"),
    kind: input.kind,
    authority: "session",
    sourceRefs,
    action: written === "created" ? "created" : "exists",
    fingerprint,
  }
}

function normalizedTitle(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function reviewConflicts(
  entry: KnowledgeEntry,
  canonical: readonly KnowledgeEntry[],
): readonly KnowledgeEntry[] {
  return canonical.filter(
    (candidate) =>
      candidate.kind === entry.kind &&
      normalizedTitle(candidate.title) === normalizedTitle(entry.title) &&
      candidate.fingerprint !== entry.fingerprint,
  )
}

export async function reviewKnowledge(projectRoot: string): Promise<KnowledgeReview> {
  const inventory = await discoverProjectKnowledge(projectRoot)
  const canonical = inventory.entries.filter((entry) => entry.authority === "canonical")
  const records = inventory.entries
    .filter((entry) => entry.authority === "session")
    .map((entry): KnowledgeReviewRecord => {
      const conflicts = reviewConflicts(entry, canonical)
      const promoted =
        entry.fingerprint !== undefined &&
        canonical.some((candidate) => candidate.fingerprint === entry.fingerprint)
      const status = !isKnowledgeActive(entry)
        ? "rejected"
        : conflicts.length > 0
          ? "conflict"
          : promoted
            ? "promoted"
            : "pending"
      return {
        path: entry.path,
        kind: entry.kind,
        title: entry.title,
        status,
        conflicts: conflicts.map((candidate) => candidate.path),
      }
    })
  return {
    records,
    pending: records.filter((record) => record.status === "pending").length,
    conflicts: records.filter((record) => record.status === "conflict").length,
  }
}

function frontmatterDocument(contents: string): {
  readonly frontmatter: string
  readonly body: string
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (match === null) throw new Error("Knowledge record has no valid frontmatter")
  return { frontmatter: match[1] ?? "", body: contents.slice(match[0].length) }
}

function replaceFrontmatterField(contents: string, key: string, value: string): string {
  const document = frontmatterDocument(contents)
  const lines = document.frontmatter.split(/\r?\n/)
  let replaced = false
  const next = lines.map((line) => {
    if (!new RegExp(`^${key}\\s*:`).test(line)) return line
    replaced = true
    return `${key}: ${yamlString(value)}`
  })
  if (!replaced) next.push(`${key}: ${yamlString(value)}`)
  return `---\n${next.join("\n")}\n---\n${document.body.replace(/^\r?\n/, "")}`
}

async function promotedDocument(
  projectRoot: string,
  sourcePath: string,
  contents: string,
): Promise<string> {
  const document = frontmatterDocument(contents)
  const projectKey = basename(resolve(projectRoot)).toLowerCase()
  const currentRevision = (await currentGitSnapshot(projectRoot)).revision ?? ""
  const date = new Date().toISOString().slice(0, 10)
  const removed = new Set(["authority", "promoted_from", "last_verified", "verified_at_rev"])
  const lines: string[] = []
  let skippingRevision = false
  for (const line of document.frontmatter.split(/\r?\n/)) {
    if (skippingRevision && /^\s/.test(line)) continue
    skippingRevision = false
    const field = line.match(/^([A-Za-z0-9_]+)\s*:/)?.[1]
    if (field !== undefined && removed.has(field)) {
      if (field === "verified_at_rev") skippingRevision = true
      continue
    }
    lines.push(line)
  }
  lines.push(
    "authority: canonical",
    `promoted_from: ${yamlString(sourcePath)}`,
    `last_verified: ${date}`,
    "verified_at_rev:",
    `  ${projectKey}: ${currentRevision.length === 0 ? "null" : yamlString(currentRevision)}`,
  )
  return `---\n${lines.join("\n")}\n---\n${document.body.replace(/^\r?\n/, "")}`
}

function sessionEntry(inventory: KnowledgeInventory, requestedPath: string): KnowledgeEntry {
  const normalized = requestedPath.replaceAll("\\", "/")
  const relativeSessionPath = `.skald/knowledge/${normalized.replace(/^\.\//, "")}`
  const entry = inventory.entries.find(
    (candidate) =>
      candidate.authority === "session" &&
      (candidate.path === normalized || candidate.path === relativeSessionPath),
  )
  if (entry === undefined)
    throw new Error(`Session knowledge record was not found: ${requestedPath}`)
  if (!isKnowledgeKind(entry.kind))
    throw new Error(`Unsupported session knowledge kind: ${entry.kind}`)
  return entry
}

export async function promoteKnowledge(
  projectRoot: string,
  requestedPath: string,
): Promise<KnowledgePromotionReceipt> {
  const inventory = await discoverProjectKnowledge(projectRoot)
  const entry = sessionEntry(inventory, requestedPath)
  const canonical = inventory.entries.filter((candidate) => candidate.authority === "canonical")
  const conflicts = reviewConflicts(entry, canonical)
  if (conflicts.length > 0) {
    return {
      action: "conflict",
      sourcePath: entry.path,
      conflicts: conflicts.map((candidate) => candidate.path),
    }
  }
  const existing =
    entry.fingerprint === undefined
      ? undefined
      : canonical.find((candidate) => candidate.fingerprint === entry.fingerprint)
  if (existing !== undefined) {
    return { action: "exists", sourcePath: entry.path, targetPath: existing.path, conflicts: [] }
  }
  const source = await readManagedFile(projectRoot, entry.path)
  if (!source.exists || source.contents === undefined) {
    throw new Error(`Session knowledge record disappeared: ${entry.path}`)
  }
  if (!isKnowledgeKind(entry.kind))
    throw new Error(`Unsupported session knowledge kind: ${entry.kind}`)
  const kind = entry.kind
  const targetPath = join(
    LOCAL_CANONICAL_DIRECTORY,
    recordDirectory(kind),
    basename(entry.path),
  ).replaceAll("\\", "/")
  const result = await writeManagedFile(
    projectRoot,
    targetPath,
    await promotedDocument(projectRoot, entry.path, source.contents),
  )
  return {
    action: result === "created" ? "promoted" : "exists",
    sourcePath: entry.path,
    targetPath,
    conflicts: [],
  }
}

export async function rejectKnowledge(
  projectRoot: string,
  requestedPath: string,
): Promise<KnowledgeRejectionReceipt> {
  const inventory = await discoverProjectKnowledge(projectRoot)
  const entry = sessionEntry(inventory, requestedPath)
  if (!isKnowledgeActive(entry)) return { action: "exists", path: entry.path }
  const source = await readManagedFile(projectRoot, entry.path)
  if (!source.exists || source.contents === undefined) {
    throw new Error(`Session knowledge record disappeared: ${entry.path}`)
  }
  await writeManagedFile(
    projectRoot,
    entry.path,
    replaceFrontmatterField(source.contents, "status", "rejected"),
  )
  return { action: "rejected", path: entry.path }
}

export function manifestKnowledgeDirectory(
  manifest: SkaldProjectManifest | undefined,
): string | undefined {
  return manifest?.sources.find((source) => source.kind === "knowledge")?.path
}
