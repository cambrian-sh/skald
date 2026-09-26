import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assessProjectFreshness,
  currentGitSnapshot,
  type ProjectGitSnapshot,
  type ProjectState,
} from "../src/project/state"

const indexState: ProjectState = {
  version: 1,
  project: { root: "." },
  index: {
    status: "indexed",
    mode: "fast",
    engine: { command: "/opt/codebase-memory-mcp", sha256: "a".repeat(64) },
    revision: "abc123",
    workingTree: "clean",
    indexedAt: "2026-09-11T00:00:00.000Z",
  },
}

function snapshot(
  revision: string | undefined,
  workingTree: ProjectGitSnapshot["workingTree"],
): ProjectGitSnapshot {
  return { revision, workingTree }
}

test("marks an unchanged clean repository fresh", () => {
  expect(assessProjectFreshness(indexState, snapshot("abc123", "clean"))).toMatchObject({
    status: "fresh",
    currentRevision: "abc123",
    indexedRevision: "abc123",
  })
})

test("marks changed revisions and dirty trees stale", () => {
  expect(assessProjectFreshness(indexState, snapshot("def456", "clean")).status).toBe("stale")
  expect(assessProjectFreshness(indexState, snapshot("abc123", "dirty")).status).toBe("stale")
})

test("does not claim freshness when the repository state cannot be verified", () => {
  expect(assessProjectFreshness(indexState, snapshot(undefined, "unknown")).status).toBe("unknown")
  expect(assessProjectFreshness(undefined, snapshot("abc123", "clean")).status).toBe("unknown")
})

test("does not claim freshness when the indexed engine changes", () => {
  expect(
    assessProjectFreshness(indexState, snapshot("abc123", "clean"), {
      command: "/opt/codebase-memory-mcp",
      sha256: "b".repeat(64),
    }),
  ).toMatchObject({ status: "stale" })
  expect(
    assessProjectFreshness(indexState, snapshot("abc123", "clean"), {
      command: "/opt/codebase-memory-mcp",
      sha256: undefined,
    }),
  ).toMatchObject({ status: "unknown" })
})

test("classifies an oversized Git status as dirty instead of unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-project-state-large-status-"))
  try {
    const git = (args: readonly string[]) =>
      Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Skald Test",
          GIT_AUTHOR_EMAIL: "skald-test@example.invalid",
          GIT_COMMITTER_NAME: "Skald Test",
          GIT_COMMITTER_EMAIL: "skald-test@example.invalid",
        },
      })
    expect(git(["init", "-q"]).exitCode).toBe(0)
    await writeFile(join(root, "tracked.txt"), "tracked\n")
    expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)
    await Promise.all(
      Array.from({ length: 400 }, (_, index) =>
        writeFile(
          join(root, `untracked-${"x".repeat(180)}-${String(index).padStart(4, "0")}`),
          "x\n",
        ),
      ),
    )

    await expect(currentGitSnapshot(root)).resolves.toMatchObject({
      revision: expect.any(String),
      workingTree: "dirty",
    })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})

test("does not classify Skald-managed client files as project changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-project-state-managed-files-"))
  try {
    const git = (args: readonly string[]) =>
      Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Skald Test",
          GIT_AUTHOR_EMAIL: "skald-test@example.invalid",
          GIT_COMMITTER_NAME: "Skald Test",
          GIT_COMMITTER_EMAIL: "skald-test@example.invalid",
        },
      })
    expect(git(["init", "-q"]).exitCode).toBe(0)
    await writeFile(join(root, "tracked.txt"), "tracked\n")
    expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)
    await mkdir(join(root, ".claude"))
    await mkdir(join(root, ".opencode"))
    await mkdir(join(root, ".skald"))
    await writeFile(join(root, ".claude", ".mcp.json"), "{}\n")
    await writeFile(join(root, ".claude", "settings.json"), "{}\n")
    await writeFile(join(root, ".opencode", "opencode.json"), "{}\n")
    await writeFile(join(root, "opencode.json"), "{}\n")
    await writeFile(join(root, ".skald", "config.json"), "{}\n")

    await expect(currentGitSnapshot(root)).resolves.toMatchObject({
      revision: expect.any(String),
      workingTree: "clean",
    })
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
