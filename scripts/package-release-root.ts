import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"
import { SUPPORTED_TARGETS } from "./release-targets"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`)
  return value
}

async function requireDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Release package path is not a directory: ${path}`)
  }
}

async function validateManifest(manifestPath: string): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
  if (!isRecord(parsed) || parsed["schemaVersion"] !== 1 || !isRecord(parsed["engine"])) {
    throw new Error("Invalid aggregated Afşin engine manifest")
  }
  const official = { name: "codebase-memory-mcp", channel: "afsin", ...AFSIN_ENGINE } as const
  for (const [key, expected] of Object.entries(official)) {
    if (parsed["engine"][key] !== expected) {
      throw new Error("Aggregated manifest does not identify the pinned Afşin engine")
    }
  }
  const assets = parsed["assets"]
  if (!Array.isArray(assets) || assets.length !== SUPPORTED_TARGETS.length) {
    throw new Error("Aggregated manifest must contain exactly one asset for every supported target")
  }
  const found = new Set<string>()
  for (const target of SUPPORTED_TARGETS) {
    const key = `${target.platform}/${target.arch}`
    const path = `${target.platform}-${target.arch}/codebase-memory-mcp`
    const asset = assets.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate["platform"] === target.platform &&
        candidate["arch"] === target.arch,
    )
    if (
      !isRecord(asset) ||
      asset["path"] !== path ||
      typeof asset["sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset["sha256"]) ||
      typeof asset["bytes"] !== "number" ||
      !Number.isSafeInteger(asset["bytes"]) ||
      asset["bytes"] <= 0
    ) {
      throw new Error(`Aggregated manifest is missing a valid Afşin binary for ${key}`)
    }
    found.add(key)
  }
  if (found.size !== SUPPORTED_TARGETS.length) {
    throw new Error("Aggregated engine targets are not unique")
  }
}

async function pack(directory: string, output: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "pm", "pack", "--destination", output], {
    cwd: directory,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) throw new Error("Could not pack the universal Skald package")
}

const args = Bun.argv.slice(2)
try {
  const manifestOption = args.includes("--manifest")
    ? resolve(requiredOption(args, "--manifest"))
    : resolve("vendor/engine/manifest.json")
  await validateManifest(manifestOption)
  const parsed: unknown = JSON.parse(await readFile("package.json", "utf8"))
  if (
    !isRecord(parsed) ||
    parsed["name"] !== "@cambrian/skald" ||
    typeof parsed["version"] !== "string" ||
    !isRecord(parsed["repository"]) ||
    parsed["repository"]["url"] !== "https://github.com/cambrian-sh/skald.git"
  ) {
    throw new Error("Root package manifest has an invalid name or version")
  }
  const output = resolve(requiredOption(args, "--output"))
  await requireDirectory(output)
  const root = join(output, "root")
  await requireDirectory(root)
  const optionalDependencies: Record<string, string> = {}
  for (const target of SUPPORTED_TARGETS) {
    optionalDependencies[`@cambrian/skald-engine-${target.platform}-${target.arch}`] =
      parsed["version"]
  }
  const packageManifest: Record<string, unknown> = {
    ...parsed,
    files: [
      "README.md",
      "ARCHITECTURE.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "RELEASING.md",
      "SECURITY.md",
      "LICENSE",
      "product.md",
      "src",
      "vendor/engine/README.md",
      "vendor/engine/AFSIN-LICENSE",
      "vendor/engine/manifest.json",
    ],
    optionalDependencies,
  }
  delete packageManifest["scripts"]
  delete packageManifest["devDependencies"]
  await writeFile(join(root, "package.json"), `${JSON.stringify(packageManifest, null, 2)}\n`)
  await cp("README.md", join(root, "README.md"))
  await cp("ARCHITECTURE.md", join(root, "ARCHITECTURE.md"))
  await cp("CHANGELOG.md", join(root, "CHANGELOG.md"))
  await cp("CONTRIBUTING.md", join(root, "CONTRIBUTING.md"))
  await cp("product.md", join(root, "product.md"))
  await cp("RELEASING.md", join(root, "RELEASING.md"))
  await cp("SECURITY.md", join(root, "SECURITY.md"))
  await cp("LICENSE", join(root, "LICENSE"))
  await cp("src", join(root, "src"), { recursive: true })
  await requireDirectory(join(root, "vendor", "engine"))
  await cp("vendor/engine/README.md", join(root, "vendor", "engine", "README.md"))
  await cp("vendor/engine/AFSIN-LICENSE", join(root, "vendor", "engine", "AFSIN-LICENSE"))
  await cp(manifestOption, join(root, "vendor", "engine", "manifest.json"))
  await pack(root, output)
  console.log(
    JSON.stringify({
      status: "packed",
      package: parsed["name"],
      version: parsed["version"],
      nativeTargets: SUPPORTED_TARGETS.map(({ platform, arch }) => `${platform}-${arch}`),
    }),
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
