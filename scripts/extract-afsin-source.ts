import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"

const SOURCE_DIRECTORY = resolve(import.meta.dir, "../vendor/engine/source")
const SOURCE_MANIFEST = join(SOURCE_DIRECTORY, "manifest.json")

type SourceManifest = {
  readonly schemaVersion: 1
  readonly repository: string
  readonly commit: string
  readonly tree: string
  readonly archive: string
  readonly sha256: string
  readonly bytes: number
}

type VerifiedSource = {
  readonly archivePath: string
  readonly bytes: number
  readonly commit: string
  readonly sha256: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseManifest(value: unknown): SourceManifest {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== 1 ||
    value["repository"] !== AFSIN_ENGINE.repository ||
    value["commit"] !== AFSIN_ENGINE.commit ||
    typeof value["tree"] !== "string" ||
    typeof value["archive"] !== "string" ||
    typeof value["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["sha256"]) ||
    typeof value["bytes"] !== "number" ||
    !Number.isSafeInteger(value["bytes"]) ||
    value["bytes"] <= 0
  ) {
    throw new Error("Invalid pinned Afşin source manifest")
  }
  return {
    schemaVersion: 1,
    repository: value["repository"],
    commit: value["commit"],
    tree: value["tree"],
    archive: value["archive"],
    sha256: value["sha256"],
    bytes: value["bytes"],
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

export async function verifyAfshinSourceArchive(
  archivePath = join(SOURCE_DIRECTORY, "afsin-cf1d310a72320ec55e7b86a091561162567e55d2.tar.gz"),
): Promise<VerifiedSource> {
  const manifest = parseManifest(JSON.parse(await readFile(SOURCE_MANIFEST, "utf8")))
  if (manifest.archive !== resolve(archivePath).split("/").at(-1)) {
    throw new Error("Afşin source archive filename does not match its manifest")
  }
  const stats = await lstat(archivePath)
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Afşin source archive is not a regular file: ${archivePath}`)
  }
  if (stats.size !== manifest.bytes) {
    throw new Error(`Afşin source archive byte count mismatch: ${archivePath}`)
  }
  const digest = await sha256(archivePath)
  if (digest !== manifest.sha256) {
    throw new Error(`Afşin source archive SHA-256 mismatch: ${archivePath}`)
  }
  return {
    archivePath,
    bytes: manifest.bytes,
    commit: manifest.commit,
    sha256: digest,
  }
}

export async function extractAfshinSource(destination: string): Promise<VerifiedSource> {
  const verified = await verifyAfshinSourceArchive()
  const absoluteDestination = resolve(destination)
  await mkdir(dirname(absoluteDestination), { recursive: true })
  await mkdir(absoluteDestination)
  const result = Bun.spawnSync(
    ["tar", "-xzf", verified.archivePath, "-C", absoluteDestination, "--strip-components=1"],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  )
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim()
    throw new Error(
      `Could not extract pinned Afşin source${detail.length === 0 ? "" : `: ${detail}`}`,
    )
  }
  return verified
}

function destinationArgument(args: readonly string[]): string {
  const index = args.indexOf("--destination")
  if (index < 0) return resolve(".release/afsin-engine")
  const value = args[index + 1]?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error("--destination requires a directory")
  }
  return resolve(value)
}

if (import.meta.main) {
  try {
    const verified = await extractAfshinSource(destinationArgument(Bun.argv.slice(2)))
    console.log(
      `Extracted Afşin ${verified.commit} (${verified.bytes} bytes, SHA-256 ${verified.sha256})`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
