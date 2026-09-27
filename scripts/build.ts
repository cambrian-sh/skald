import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"

const platform = process.platform === "win32" ? "windows" : process.platform
const arch = process.arch === "x64" ? "amd64" : process.arch
const filename = platform === "windows" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp"
const engineRoot = resolve("vendor/engine")
const engineAsset = resolve(engineRoot, `${platform}-${arch}`, filename)
const nativeAddon = resolve(engineRoot, "native", `${platform}-${arch}`, "skald-safe-fs.node")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function verifyEngineAsset(): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(resolve(engineRoot, "manifest.json"), "utf8"))
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["engine"])) {
    throw new Error("Invalid bundled Afşin engine manifest")
  }
  const official = {
    name: "codebase-memory-mcp",
    channel: "afsin",
    ...AFSIN_ENGINE,
  } as const
  for (const [key, expected] of Object.entries(official)) {
    if (parsed["engine"][key] !== expected) throw new Error("Invalid bundled Afşin engine identity")
  }
  const assets = parsed["assets"]
  if (!Array.isArray(assets)) throw new Error("Invalid bundled Afşin engine asset list")
  const relativePath = `${platform}-${arch}/${filename}`
  const asset = assets.find(
    (candidate) => isRecord(candidate) && candidate["path"] === relativePath,
  )
  if (
    !isRecord(asset) ||
    typeof asset["sha256"] !== "string" ||
    typeof asset["bytes"] !== "number"
  ) {
    throw new Error(`Missing bundled Afşin engine asset for ${platform}/${arch}`)
  }
  const stats = await lstat(engineAsset)
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(`Bundled Afşin engine is not an executable file: ${engineAsset}`)
  }
  if (stats.size !== asset["bytes"] || (await sha256(engineAsset)) !== asset["sha256"]) {
    throw new Error(`Bundled Afşin engine digest does not match its manifest: ${engineAsset}`)
  }
}

async function verifyNativeAddon(): Promise<void> {
  const stats = await lstat(nativeAddon)
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
    throw new Error(`Native managed-filesystem addon is not a regular file: ${nativeAddon}`)
  }
}

try {
  await verifyEngineAsset()
} catch (error) {
  if (errorCode(error) === "ENOENT") {
    throw new Error(
      `Missing bundled Afşin engine asset for ${platform}/${arch}: ${engineAsset}. ` +
        "Stage it with bun run stage:engine before building a standalone Skald executable.",
    )
  }
  throw error
}

try {
  await verifyNativeAddon()
} catch (error) {
  if (errorCode(error) === "ENOENT") {
    throw new Error(
      `Missing native managed-filesystem addon for ${platform}/${arch}: ${nativeAddon}. ` +
        "Build it with bun run native:build before compiling Skald.",
    )
  }
  throw error
}

await mkdir("dist", { recursive: true })
const build = await Bun.build({
  entrypoints: ["src/cli.ts", engineAsset, nativeAddon],
  compile: { outfile: "dist/skald" },
  target: "bun",
})
if (!build.success) {
  for (const log of build.logs) console.error(log)
  process.exitCode = 1
} else {
  const digest = await sha256("dist/skald")
  await writeFile("dist/skald.sha256", `${digest}  skald\n`)
  console.log(
    `Built dist/skald with embedded ${platform}/${arch} Afşin engine and native filesystem addon (${digest})`,
  )
}
