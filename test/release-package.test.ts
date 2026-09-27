import { expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AFSIN_ENGINE } from "../src/engine/project"

const projectRoot = resolve(import.meta.dir, "..")
const targets = [
  { platform: "linux", arch: "amd64" },
  { platform: "linux", arch: "arm64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "amd64" },
] as const

setDefaultTimeout(60_000)

test("universal release package includes the linked maintainer and product docs", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "skald-release-package-"))
  const output = join(packageRoot, "output")
  const manifestPath = join(packageRoot, "engine-manifest.json")
  await mkdir(output)
  const manifest = {
    schemaVersion: 1,
    engine: { name: "codebase-memory-mcp", channel: "afsin", ...AFSIN_ENGINE },
    assets: targets.map(({ platform, arch }) => ({
      platform,
      arch,
      path: `${platform}-${arch}/codebase-memory-mcp`,
      sha256: "a".repeat(64),
      bytes: 1,
    })),
  }

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    const packed = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "scripts/package-release-root.ts",
        "--manifest",
        manifestPath,
        "--output",
        output,
      ],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
    )

    expect(packed.exitCode).toBe(0)
    const archive = join(output, "cambrian-skald-0.1.0.tgz")
    const entries = Bun.spawnSync(["tar", "-tzf", archive], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const names = new TextDecoder().decode(entries.stdout)

    expect(entries.exitCode).toBe(0)
    expect(names).toContain("package/CONTRIBUTING.md")
    expect(names).toContain("package/SECURITY.md")
    expect(names).toContain("package/ARCHITECTURE.md")
    expect(names).toContain("package/product.md")
    expect(names).toContain("package/CHANGELOG.md")
    expect(names).not.toContain("package/vendor/engine/native/skald-safe-fs.node")
  } finally {
    await rm(packageRoot, { force: true, recursive: true })
  }
})

test("platform engine companion includes the native managed-filesystem addon", async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "skald-engine-companion-")))
  const platform = process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "x64" ? "amd64" : "arm64"
  const output = join(fixture, "output")
  const engineRoot = join(fixture, "vendor", "engine")
  const binary = join(fixture, "engine")
  const addon = join(engineRoot, "native", `${platform}-${arch}`, "skald-safe-fs.node")
  const binaryBytes = Buffer.from("fake native Afşin engine")
  const addonBytes = Buffer.from("fake Skald Node-API addon")
  const digest = createHash("sha256").update(binaryBytes).digest("hex")

  try {
    await mkdir(engineRoot, { recursive: true })
    await mkdir(join(engineRoot, "native", `${platform}-${arch}`), { recursive: true })
    await mkdir(output)
    await cp(resolve(projectRoot, "LICENSE"), join(fixture, "LICENSE"))
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "@cambrian/skald",
        version: "0.1.0",
      }),
    )
    await writeFile(binary, binaryBytes)
    await chmod(binary, 0o755)
    await writeFile(addon, addonBytes)
    await writeFile(join(engineRoot, "AFSIN-LICENSE"), "fixture license")
    await writeFile(
      join(engineRoot, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        engine: { name: "codebase-memory-mcp", channel: "afsin", ...AFSIN_ENGINE },
        assets: [
          {
            platform: "linux",
            arch: "amd64",
            path: "linux-amd64/codebase-memory-mcp",
            sha256: digest,
            bytes: binaryBytes.byteLength,
          },
        ],
      })}\n`,
    )
    await mkdir(join(engineRoot, "linux-amd64"), { recursive: true })
    await cp(binary, join(engineRoot, "linux-amd64", "codebase-memory-mcp"))
    await chmod(join(engineRoot, "linux-amd64", "codebase-memory-mcp"), 0o755)
    const packed = Bun.spawnSync(
      [
        process.execPath,
        "run",
        resolve(projectRoot, "scripts/package-release.ts"),
        "--binary",
        binary,
        "--addon",
        addon,
        "--platform",
        platform,
        "--arch",
        arch,
        "--output",
        output,
      ],
      { cwd: fixture, stdout: "pipe", stderr: "pipe" },
    )
    if (packed.exitCode !== 0) {
      throw new Error(
        `Engine companion packaging failed: ${new TextDecoder().decode(packed.stderr)}`,
      )
    }

    const archive = join(output, `cambrian-skald-engine-${platform}-${arch}-0.1.0.tgz`)
    const entries = Bun.spawnSync(["tar", "-tzf", archive], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const names = new TextDecoder().decode(entries.stdout)
    expect(entries.exitCode).toBe(0)
    expect(names).toContain("package/LICENSE")
    expect(names).toContain("package/vendor/engine/AFSIN-LICENSE")
    expect(names).toContain(`package/vendor/engine/${platform}-${arch}/codebase-memory-mcp`)
    expect(names).toContain("package/vendor/engine/native/skald-safe-fs.node")
  } finally {
    await rm(fixture, { force: true, recursive: true })
  }
})
