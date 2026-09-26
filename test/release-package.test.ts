import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  } finally {
    await rm(packageRoot, { force: true, recursive: true })
  }
})
