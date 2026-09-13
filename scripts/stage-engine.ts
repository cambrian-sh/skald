import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"

const MAX_ENGINE_BYTES = 512 * 1024 * 1024
const MANIFEST_NAME = "manifest.json"

type EngineAsset = {
  readonly platform: string
  readonly arch: string
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

type EngineManifest = {
  readonly schemaVersion: number
  readonly engine: Record<string, unknown>
  readonly assets: EngineAsset[]
}

const OFFICIAL_ENGINE = {
  name: "codebase-memory-mcp",
  channel: "afsin",
  ...AFSIN_ENGINE,
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name)?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`)
  return value
}

function validatePart(value: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value)) throw new Error(`Invalid ${name}: ${value}`)
  return value.toLowerCase()
}

function engineFilename(platform: string): string {
  return platform === "windows" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp"
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function regularEngineInput(path: string): Promise<void> {
  const stats = await lstat(path)
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error(`Engine input is not a regular file: ${path}`)
  if (stats.size > MAX_ENGINE_BYTES)
    throw new Error(`Engine input exceeds ${MAX_ENGINE_BYTES} bytes`)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(`Output is not a directory: ${path}`)
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) throw error
    await mkdir(path, { recursive: true, mode: 0o755 })
  }
}

async function readManifest(path: string): Promise<EngineManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Invalid engine manifest: ${path}`)
  const record = parsed as Record<string, unknown>
  const engine = record["engine"]
  const assetsValue = record["assets"]
  if (
    record["schemaVersion"] !== 1 ||
    typeof engine !== "object" ||
    engine === null ||
    Array.isArray(engine) ||
    !Array.isArray(assetsValue)
  )
    throw new Error(`Invalid engine manifest: ${path}`)
  const engineRecord = engine as Record<string, unknown>
  for (const [key, expected] of Object.entries(OFFICIAL_ENGINE)) {
    if (engineRecord[key] !== expected) throw new Error(`Invalid official engine manifest: ${path}`)
  }
  const assets = assetsValue
  if (
    !assets.every(
      (asset): asset is EngineAsset =>
        isRecord(asset) &&
        typeof asset["platform"] === "string" &&
        typeof asset["arch"] === "string" &&
        typeof asset["path"] === "string" &&
        /^[a-f0-9]{64}$/.test(String(asset["sha256"])) &&
        typeof asset["bytes"] === "number" &&
        Number.isSafeInteger(asset["bytes"]) &&
        asset["bytes"] > 0,
    )
  )
    throw new Error(`Invalid engine asset manifest: ${path}`)
  return {
    schemaVersion: record["schemaVersion"] as number,
    engine: engineRecord,
    assets,
  }
}

async function stage(args: readonly string[]): Promise<EngineAsset> {
  const binary = resolve(requiredOption(args, "--binary"))
  const platform = validatePart(requiredOption(args, "--platform"), "platform")
  const arch = validatePart(requiredOption(args, "--arch"), "arch")
  const output = resolve(option(args, "--output") ?? "vendor/engine")
  await regularEngineInput(binary)
  const manifestPath = join(output, MANIFEST_NAME)
  const manifest = await readManifest(manifestPath)
  const assetDirectory = join(output, `${platform}-${arch}`)
  const filename = engineFilename(platform)
  const target = join(assetDirectory, filename)
  await ensureDirectory(output)
  await ensureDirectory(assetDirectory)
  const temporary = `${target}.tmp-${process.pid}`
  await rm(temporary, { force: true })
  const targetBackup = `${target}.backup-${process.pid}`
  const manifestTemp = `${manifestPath}.tmp-${process.pid}`
  await rm(targetBackup, { force: true })
  await rm(manifestTemp, { force: true })
  let targetBackedUp = false
  let targetPublished = false
  try {
    await Bun.write(temporary, Bun.file(binary))
    await chmod(temporary, 0o700)
    const digest = await hashFile(temporary)
    const stagedStats = await lstat(temporary)
    try {
      const targetStats = await lstat(target)
      if (targetStats.isSymbolicLink() || !targetStats.isFile())
        throw new Error(`Engine output is not a regular file: ${target}`)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const asset: EngineAsset = {
      platform,
      arch,
      path: `${platform}-${arch}/${filename}`,
      sha256: digest,
      bytes: stagedStats.size,
    }
    const assets = manifest.assets.filter(
      (candidate) => !(candidate.platform === platform && candidate.arch === arch),
    )
    assets.push(asset)
    await writeFile(manifestTemp, `${JSON.stringify({ ...manifest, assets }, null, 2)}\n`, {
      mode: 0o644,
    })
    try {
      await rename(target, targetBackup)
      targetBackedUp = true
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    await rename(temporary, target)
    targetPublished = true
    await rename(manifestTemp, manifestPath)
    return asset
  } catch (error) {
    if (targetPublished) await rm(target, { force: true })
    if (targetBackedUp) {
      await rename(targetBackup, target)
      targetBackedUp = false
    }
    throw error
  } finally {
    await rm(temporary, { force: true })
    await rm(manifestTemp, { force: true })
    if (targetBackedUp) await rm(targetBackup, { force: true })
  }
}

try {
  const asset = await stage(Bun.argv.slice(2))
  console.log(JSON.stringify({ status: "staged", asset }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
