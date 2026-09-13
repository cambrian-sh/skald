import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import type { McpServerDefinition } from "./agents/mcp"
import { ConcurrentFileChangeError, readManagedFile, writeManagedFile } from "./fs/safe-file"

const TRUST_VERSION = 1 as const
const TRUST_PATH = "trust.json"
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function trustDirectory(): string {
  const configured = process.env["SKALD_TRUST_DIRECTORY"]?.trim()
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".config", "skald")
    : resolve(configured)
}

type EngineTrust = {
  readonly projectRoot: string
  readonly command: string
  readonly args: readonly string[]
  readonly sha256: string
}

type KnowledgeTrust = {
  readonly projectRoot: string
  readonly path: string
}

type TrustDocument = {
  readonly version: typeof TRUST_VERSION
  readonly engines: readonly EngineTrust[]
  readonly knowledge: readonly KnowledgeTrust[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTrustEntry(value: unknown): value is EngineTrust {
  return (
    isRecord(value) &&
    typeof value["projectRoot"] === "string" &&
    typeof value["command"] === "string" &&
    (value["args"] === undefined ||
      (Array.isArray(value["args"]) && value["args"].every((item) => typeof item === "string"))) &&
    typeof value["sha256"] === "string" &&
    SHA256_PATTERN.test(value["sha256"])
  )
}

function isKnowledgeEntry(value: unknown): value is KnowledgeTrust {
  return (
    isRecord(value) && typeof value["projectRoot"] === "string" && typeof value["path"] === "string"
  )
}

function parseTrustDocument(value: unknown): TrustDocument {
  if (!isRecord(value) || value["version"] !== TRUST_VERSION) {
    throw new Error("Skald trust registry is malformed")
  }
  const engines = value["engines"]
  const knowledge = value["knowledge"]
  if (
    !Array.isArray(engines) ||
    !engines.every(isTrustEntry) ||
    !Array.isArray(knowledge) ||
    !knowledge.every(isKnowledgeEntry)
  ) {
    throw new Error("Skald trust registry is malformed")
  }
  return {
    version: TRUST_VERSION,
    engines: engines.map((entry) => ({
      ...entry,
      args: Array.isArray(entry.args) ? [...entry.args] : [],
    })),
    knowledge,
  }
}

async function readTrustDocument(): Promise<TrustDocument> {
  const existing = await readManagedFile(trustDirectory(), TRUST_PATH)
  if (!existing.exists) return { version: TRUST_VERSION, engines: [], knowledge: [] }
  try {
    return parseTrustDocument(JSON.parse(existing.contents ?? ""))
  } catch (error) {
    if (error instanceof Error && error.message === "Skald trust registry is malformed") {
      throw error
    }
    throw new Error("Skald trust registry is malformed", { cause: error })
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return resolve(path)
    }
    throw error
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

function within(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
}

async function writeTrustDocument(document: TrustDocument): Promise<void> {
  await writeManagedFile(trustDirectory(), TRUST_PATH, `${JSON.stringify(document, null, 2)}\n`)
}

function waitForTrustRetry(): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
}

async function updateTrustDocument(
  update: (document: TrustDocument) => {
    readonly document: TrustDocument
    readonly applied: (document: TrustDocument) => boolean
  },
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readTrustDocument()
    const next = update(current)
    if (next.applied(current)) return
    try {
      await writeTrustDocument(next.document)
    } catch (error) {
      if (!(error instanceof ConcurrentFileChangeError)) throw error
    }
    if (next.applied(await readTrustDocument())) return
    await waitForTrustRetry()
  }
  throw new Error("Could not update the Skald trust registry because it is changing concurrently")
}

function matchesEngine(
  entry: EngineTrust,
  projectRoot: string,
  command: string,
  args: readonly string[],
  sha256: string,
): boolean {
  return (
    samePath(entry.projectRoot, projectRoot) &&
    samePath(entry.command, command) &&
    JSON.stringify(entry.args) === JSON.stringify(args) &&
    entry.sha256 === sha256
  )
}

export async function trustMcpExecutable(
  projectRoot: string,
  server: McpServerDefinition,
): Promise<void> {
  if (server.sha256 === undefined || !SHA256_PATTERN.test(server.sha256)) {
    throw new Error("Cannot trust an MCP engine without a SHA-256 digest")
  }
  const entry: EngineTrust = {
    projectRoot: resolve(projectRoot),
    command: await canonicalPath(server.command),
    args: [...server.args],
    sha256: server.sha256,
  }
  await updateTrustDocument((document) => {
    const applied = (current: TrustDocument): boolean =>
      current.engines.some((candidate) =>
        matchesEngine(candidate, entry.projectRoot, entry.command, entry.args, entry.sha256),
      )
    if (applied(document)) return { document, applied }
    const engines = [...document.engines, entry].sort((left, right) =>
      `${left.projectRoot}\0${left.command}\0${JSON.stringify(left.args)}\0${left.sha256}`.localeCompare(
        `${right.projectRoot}\0${right.command}\0${JSON.stringify(right.args)}\0${right.sha256}`,
      ),
    )
    return { document: { ...document, engines }, applied }
  })
}

export async function isTrustedMcpExecutable(
  projectRoot: string,
  server: McpServerDefinition,
): Promise<boolean> {
  if (server.sha256 === undefined || !SHA256_PATTERN.test(server.sha256)) return false
  const document = await readTrustDocument()
  const command = await canonicalPath(server.command)
  return document.engines.some(
    (entry) =>
      samePath(entry.projectRoot, projectRoot) &&
      samePath(entry.command, command) &&
      JSON.stringify(entry.args) === JSON.stringify(server.args) &&
      entry.sha256 === server.sha256,
  )
}

export async function trustKnowledgeDirectory(projectRoot: string, path: string): Promise<void> {
  const entry: KnowledgeTrust = {
    projectRoot: resolve(projectRoot),
    path: await canonicalPath(resolve(projectRoot, path)),
  }
  await updateTrustDocument((document) => {
    const applied = (current: TrustDocument): boolean =>
      current.knowledge.some(
        (candidate) =>
          samePath(candidate.projectRoot, entry.projectRoot) &&
          samePath(candidate.path, entry.path),
      )
    if (applied(document)) return { document, applied }
    const knowledge = [...document.knowledge, entry].sort((left, right) =>
      `${left.projectRoot}\0${left.path}`.localeCompare(`${right.projectRoot}\0${right.path}`),
    )
    return { document: { ...document, knowledge }, applied }
  })
}

export async function isTrustedKnowledgeDirectory(
  projectRoot: string,
  path: string | undefined,
): Promise<boolean> {
  if (path === undefined || path.length === 0) return true
  const requested = resolve(projectRoot, path)
  const canonical = await canonicalPath(requested)
  if (within(projectRoot, canonical)) return true
  const environmentPath = process.env["CBM_KNOWLEDGE_DIR"]
  if (environmentPath !== undefined && samePath(await canonicalPath(environmentPath), canonical)) {
    return true
  }
  const document = await readTrustDocument()
  return document.knowledge.some(
    (entry) => samePath(entry.projectRoot, projectRoot) && samePath(entry.path, canonical),
  )
}
