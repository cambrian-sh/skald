import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"
import { SUPPORTED_TARGETS, type SupportedTarget } from "./release-targets"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name)?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`)
  return value
}

function targetFor(platform: string, arch: string): SupportedTarget {
  const target = SUPPORTED_TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  )
  if (target === undefined) throw new Error(`Unsupported release target: ${platform}-${arch}`)
  return target
}

function packageName(target: SupportedTarget): string {
  return `@cambrian/skald-engine-${target.platform}-${target.arch}`
}

function binaryName(target: SupportedTarget): string {
  return target.platform === "windows" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp"
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk)
  return hash.digest("hex")
}

async function assertBinary(
  path: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(`Release engine is not a regular executable file: ${path}`)
  }
  return { bytes: stats.size, sha256: await sha256(path) }
}

async function verifyStagedAsset(
  target: SupportedTarget,
  asset: { readonly bytes: number; readonly sha256: string },
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile("vendor/engine/manifest.json", "utf8"))
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["engine"])) {
    throw new Error("Invalid staged Afşin engine manifest")
  }
  const official = { name: "codebase-memory-mcp", channel: "afsin", ...AFSIN_ENGINE } as const
  for (const [key, expected] of Object.entries(official)) {
    if (parsed["engine"][key] !== expected) throw new Error("Invalid staged Afşin engine identity")
  }
  const assets = parsed["assets"]
  const path = `${target.platform}-${target.arch}/${binaryName(target)}`
  const manifestAsset =
    Array.isArray(assets) &&
    assets.find((candidate) => isRecord(candidate) && candidate["path"] === path)
  if (
    !isRecord(manifestAsset) ||
    manifestAsset["platform"] !== target.platform ||
    manifestAsset["arch"] !== target.arch ||
    manifestAsset["path"] !== path ||
    typeof manifestAsset["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifestAsset["sha256"]) ||
    manifestAsset["bytes"] !== asset.bytes ||
    manifestAsset["sha256"] !== asset.sha256
  ) {
    throw new Error(`Staged Afşin engine manifest does not match ${path}`)
  }
  return { schemaVersion: 1, engine: parsed["engine"], assets: [manifestAsset] }
}

async function packageDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Release package path is not a directory: ${path}`)
  }
}

async function readRootManifest(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile("package.json", "utf8"))
  if (
    !isRecord(parsed) ||
    typeof parsed["name"] !== "string" ||
    typeof parsed["version"] !== "string"
  ) {
    throw new Error("Root package manifest is missing name or version")
  }
  return parsed
}

async function writeEnginePackage(
  root: string,
  target: SupportedTarget,
  binary: string,
  asset: { readonly bytes: number; readonly sha256: string },
  manifest: Record<string, unknown>,
  version: string,
): Promise<void> {
  const targetPath = `${target.platform}-${target.arch}`
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: packageName(target),
        version,
        description: `Skald's pinned Afşin structural engine for ${target.platform}/${target.arch}`,
        repository: {
          type: "git",
          url: "https://github.com/cambrian-sh/skald.git",
        },
        license: "MIT",
        os: [target.os],
        cpu: [target.cpu],
        files: [
          `vendor/engine/${targetPath}/${binaryName(target)}`,
          "vendor/engine/AFSIN-LICENSE",
          "vendor/engine/manifest.json",
        ],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, "README.md"),
    `# ${packageName(target)}\n\nPinned native Afşin engine asset for Skald ${version}.\n\nSHA-256: ${asset.sha256}\nBytes: ${asset.bytes}\n`,
  )
  await packageDirectory(join(root, "vendor", "engine", targetPath))
  await cp(binary, join(root, "vendor", "engine", targetPath, binaryName(target)))
  await cp("vendor/engine/AFSIN-LICENSE", join(root, "vendor", "engine", "AFSIN-LICENSE"))
  await writeFile(
    join(root, "vendor", "engine", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function pack(directory: string, output: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "pm", "pack", "--destination", output], {
    cwd: directory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`Could not pack release package in ${directory}`)
}

const args = Bun.argv.slice(2)
try {
  const target = targetFor(requiredOption(args, "--platform"), requiredOption(args, "--arch"))
  const binary = resolve(requiredOption(args, "--binary"))
  const output = resolve(requiredOption(args, "--output"))
  const rootManifest = await readRootManifest()
  const version = rootManifest["version"]
  if (typeof version !== "string") throw new Error("Root package version is invalid")
  const asset = await assertBinary(binary)
  const manifest = await verifyStagedAsset(target, asset)
  await packageDirectory(output)
  const enginePackage = join(output, `engine-${target.platform}-${target.arch}`)
  await packageDirectory(enginePackage)
  await writeEnginePackage(enginePackage, target, binary, asset, manifest, version)
  await pack(enginePackage, output)
  console.log(
    JSON.stringify({
      status: "packed",
      target: `${target.platform}-${target.arch}`,
      packages: [packageName(target)],
      engine: asset,
    }),
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
