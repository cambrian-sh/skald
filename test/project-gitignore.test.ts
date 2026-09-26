import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("keeps generated Skald runtime private while leaving promoted knowledge shareable", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skald-project-gitignore-"))
  fixtureRoot = projectRoot
  const git = (args: readonly string[]) =>
    Bun.spawnSync(["git", "-C", projectRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
  expect(git(["init", "--quiet"]).exitCode).toBe(0)
  await mkdir(join(projectRoot, ".skald"))
  await writeFile(join(projectRoot, ".skald", ".gitignore"), "# Keep local rules\n/local-cache/\n")

  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/cli.ts"),
      "init",
      "--root",
      projectRoot,
      "--no-index",
      "--agents",
      "claude",
      "--json",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, SKALD_TRUST_DIRECTORY: join(projectRoot, "trust") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(result.exitCode).toBe(0)

  const privatePaths = [
    ".skald/engine/codebase-memory-mcp",
    ".skald/engine/cache/graph.db",
    ".skald/engine/config/local.toml",
    ".skald/r/daemon.sock",
    ".skald/state.json",
    ".skald/context-runtime",
    ".skald/context-runtime.mjs",
    ".skald/knowledge/session.md",
  ]
  for (const path of privatePaths) {
    const file = join(projectRoot, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, "local Skald state\n")
  }
  const canonical = join(projectRoot, ".skald", "knowledge-canonical", "decision.md")
  await mkdir(dirname(canonical), { recursive: true })
  await writeFile(canonical, "# Approved decision\n")

  const status = git(["status", "--short", "--untracked-files=all"])
  const output = new TextDecoder().decode(status.stdout)
  const managedIgnore = await readFile(join(projectRoot, ".skald", ".gitignore"), "utf8")

  expect(status.exitCode).toBe(0)
  expect(managedIgnore).toContain("# Keep local rules")
  expect(managedIgnore).toContain("/local-cache/")
  expect(output).toContain(".skald/.gitignore")
  expect(output).toContain(".skald/knowledge-canonical/decision.md")
  for (const path of privatePaths) expect(output).not.toContain(path)
})
