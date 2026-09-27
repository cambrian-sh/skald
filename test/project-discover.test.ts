import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverProject } from "../src/project/discover"

let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

describe("discoverProject", () => {
  test("finds the Git worktree from a nested directory", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "skald-project-"))
    await mkdir(join(fixtureRoot, ".git"))
    const nestedPath = join(fixtureRoot, "packages", "app")
    await mkdir(nestedPath, { recursive: true })

    const discovery = await discoverProject(nestedPath)

    expect(discovery.root).toBe(await realpath(fixtureRoot))
    expect(discovery.gitMarker).toBe("directory")
  })

  test("recognizes a Git worktree pointer file", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "skald-worktree-"))
    await writeFile(join(fixtureRoot, ".git"), "gitdir: /tmp/worktree-git")

    const discovery = await discoverProject(fixtureRoot)

    expect(discovery.root).toBe(await realpath(fixtureRoot))
    expect(discovery.gitMarker).toBe("file")
  })

  test("recognizes an explicit multi-repository workspace", async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "skald-workspace-"))
    await mkdir(join(fixtureRoot, "core", ".git"), { recursive: true })
    await mkdir(join(fixtureRoot, "ui", ".git"), { recursive: true })

    const discovery = await discoverProject(fixtureRoot)

    expect(discovery.root).toBe(await realpath(fixtureRoot))
    expect(discovery.gitMarker).toBe("workspace")
  })
})
