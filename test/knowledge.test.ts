import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { ensureConfig } from "../src/config"
import { mcpExecutableSha256 } from "../src/engine"
import {
  discoverKnowledge,
  isKnowledgeActive,
  promoteKnowledge,
  recordKnowledge,
  rejectKnowledge,
  reviewKnowledge,
} from "../src/knowledge/store"
import { recordProjectIndex } from "../src/project/state"
import { trustMcpExecutable } from "../src/trust"

let fixtureRoot: string | undefined
let trustRoot: string | undefined
const originalTrustDirectory = process.env["SKALD_TRUST_DIRECTORY"]

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
  if (originalTrustDirectory === undefined) delete process.env["SKALD_TRUST_DIRECTORY"]
  else process.env["SKALD_TRUST_DIRECTORY"] = originalTrustDirectory
  if (trustRoot !== undefined) {
    await rm(trustRoot, { force: true, recursive: true })
    trustRoot = undefined
  }
})

test("discovers canonical revision-anchored knowledge and session records", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-"))
  await mkdir(join(fixtureRoot, ".git"))
  const canonicalRoot = join(fixtureRoot, "canonical")
  await mkdir(join(canonicalRoot, "adrs"), { recursive: true })
  await writeFile(
    join(canonicalRoot, "adrs", "ADR-001.md"),
    '---\ntitle: "Use MCP"\nlast_verified: 2026-09-11\nverified_at_rev:\n  core: "abc123"\n---\n\nUse the standard transport.\n',
  )

  const canonical = await discoverKnowledge(fixtureRoot, canonicalRoot)
  expect(canonical.entries).toEqual([
    {
      kind: "adr",
      path: "canonical/adrs/ADR-001.md",
      title: "Use MCP",
      summary: "Use the standard transport.",
      status: undefined,
      supersedes: [],
      dependsOn: [],
      origins: [],
      artifacts: [],
      lastVerified: "2026-09-11",
      authority: "canonical",
      freshness: "unknown",
    },
  ])

  const receipt = await recordKnowledge(fixtureRoot, {
    kind: "decision",
    title: "Keep writes reviewable",
    summary: "Session discoveries stay separate from canonical records.",
    sourceRefs: ["src/context/server.ts"],
  })
  expect(receipt.authority).toBe("session")
  expect(await readFile(join(fixtureRoot, ".skald", "knowledge", receipt.path), "utf8")).toContain(
    "Keep writes reviewable",
  )
  const session = await discoverKnowledge(fixtureRoot)
  expect(session.entries[0]?.authority).toBe("session")
})

test("does not write into a configured canonical knowledge root", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-readonly-"))
  await mkdir(join(fixtureRoot, ".git"))
  const canonicalRoot = join(fixtureRoot, "canonical")
  await mkdir(canonicalRoot)

  await expect(
    recordKnowledge(
      fixtureRoot,
      {
        kind: "adr",
        title: "No canonical writes",
        summary: "Canonical knowledge requires maintainer review.",
      },
      canonicalRoot,
    ),
  ).rejects.toThrow("read-only")
})

test("requires a fresh trusted index before writing under the manifest policy", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-verify-"))
  const git = (args: readonly string[]) =>
    Bun.spawnSync(["git", "-C", fixtureRoot as string, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Skald Test",
        GIT_AUTHOR_EMAIL: "skald-test@example.invalid",
        GIT_COMMITTER_NAME: "Skald Test",
        GIT_COMMITTER_EMAIL: "skald-test@example.invalid",
      },
    })
  expect(git(["init", "-q"]).exitCode).toBe(0)
  await writeFile(join(fixtureRoot, "tracked.txt"), "stable\n")
  expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)

  const backend = join(fixtureRoot, "backend.sh")
  await writeFile(backend, "#!/bin/sh\n")
  await chmod(backend, 0o755)
  const server = {
    command: backend,
    args: [] as const,
    trust: "explicit" as const,
    sha256: await mcpExecutableSha256(backend),
  }
  expect(git(["add", "backend.sh"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "backend"]).exitCode).toBe(0)
  trustRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-trust-"))
  process.env["SKALD_TRUST_DIRECTORY"] = trustRoot
  await trustMcpExecutable(fixtureRoot, server)
  await ensureConfig(fixtureRoot, false, server)

  await expect(
    recordKnowledge(fixtureRoot, {
      kind: "observation",
      title: "Requires verification",
      summary: "A manifest with require-verify must not write before indexing.",
    }),
  ).rejects.toThrow("fresh verified index")

  await recordProjectIndex(fixtureRoot, server, "fast", "indexed", undefined)
  const receipt = await recordKnowledge(fixtureRoot, {
    kind: "observation",
    title: "Verified write",
    summary: "A fresh trusted index permits a session knowledge write.",
  })
  expect(receipt.action).toBe("created")
})

test("allows a session write when the manifest explicitly chooses warn", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-warn-"))
  await mkdir(join(fixtureRoot, ".git"))
  await ensureConfig(fixtureRoot, false)
  const configPath = join(fixtureRoot, ".skald", "config.json")
  const contents = await readFile(configPath, "utf8")
  await writeFile(
    configPath,
    contents.replace('"beforeWrite": "require-verify"', '"beforeWrite": "warn"'),
  )

  const receipt = await recordKnowledge(fixtureRoot, {
    kind: "observation",
    title: "Warn policy",
    summary: "The project explicitly permits recording before a verified index exists.",
  })

  expect(receipt.action).toBe("created")
})

test("covers a Cambrian-sized knowledge set without a premature byte cutoff", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-size-"))
  await mkdir(join(fixtureRoot, ".git"))
  const canonicalRoot = join(fixtureRoot, "canonical")
  await mkdir(join(canonicalRoot, "adrs"), { recursive: true })
  const body = "x".repeat(700 * 1024)
  const document = (title: string) => `---\ntitle: "${title}"\n---\n\n${body}\n`
  await writeFile(join(canonicalRoot, "adrs", "ADR-001.md"), document("First"))
  await writeFile(join(canonicalRoot, "adrs", "ADR-002.md"), document("Second"))

  const inventory = await discoverKnowledge(fixtureRoot, canonicalRoot)

  expect(inventory.entries).toHaveLength(2)
  expect(inventory.truncated).toBe(false)
})

test("marks a symlinked knowledge root as unsafe without following it", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-symlink-"))
  await mkdir(join(fixtureRoot, ".git"))
  const target = join(fixtureRoot, "outside")
  await mkdir(join(target, "adrs"), { recursive: true })
  await symlink(target, join(fixtureRoot, "knowledge"))

  const inventory = await discoverKnowledge(fixtureRoot, "knowledge")
  expect(inventory.entries).toHaveLength(0)
  expect(inventory.truncated).toBe(true)
})

test("deduplicates identical session discoveries across repeated writes", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-dedupe-"))
  await mkdir(join(fixtureRoot, ".git"))
  const input = {
    kind: "observation" as const,
    title: "The graph is derived",
    summary: "The graph is rebuilt from source and is not canonical truth.",
    sourceRefs: ["src/engine.ts"],
  }

  const first = await recordKnowledge(fixtureRoot, input)
  const second = await recordKnowledge(fixtureRoot, input)
  const inventory = await discoverKnowledge(fixtureRoot)

  expect(first.action).toBe("created")
  expect(second.action).toBe("exists")
  expect(second.path).toBe(first.path)
  expect(second.fingerprint).toBe(first.fingerprint)
  expect(inventory.entries.filter((entry) => entry.authority === "session")).toHaveLength(1)
})

test("writes every Cambrian knowledge kind to its compatible directory", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-kinds-"))
  await mkdir(join(fixtureRoot, ".git"))
  const kinds = [
    ["component", "components"],
    ["contract", "contracts"],
    ["investigation", "investigations"],
    ["research", "research"],
  ] as const

  for (const [kind, directory] of kinds) {
    const receipt = await recordKnowledge(fixtureRoot, {
      kind,
      title: `${kind} record`,
      summary: `A ${kind} session record.`,
    })
    expect(receipt.path.startsWith(`${directory}/`)).toBe(true)
  }
  const inventory = await discoverKnowledge(fixtureRoot)
  for (const [kind, directory] of kinds) {
    expect(
      inventory.entries.some(
        (entry) =>
          entry.authority === "session" &&
          entry.kind === kind &&
          entry.path.includes(`.skald/knowledge/${directory}/`),
      ),
    ).toBe(true)
  }
})

test("uses matching verified revisions instead of document age", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-knowledge-revision-"))
  fixtureRoot = root
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
  const revision = new TextDecoder().decode(git(["rev-parse", "HEAD"]).stdout).trim()
  const projectKey = basename(root)
  const canonicalRoot = join(root, "canonical")
  await mkdir(join(canonicalRoot, "adrs"), { recursive: true })
  const document = (title: string, recordedRevision: string) =>
    `---\ntitle: "${title}"\nlast_verified: 2020-01-01\nverified_at_rev:\n  ${projectKey}: "${recordedRevision}"\n---\n\n${title}.\n`
  await writeFile(join(canonicalRoot, "adrs", "fresh.md"), document("Fresh", revision))
  await writeFile(join(canonicalRoot, "adrs", "stale.md"), document("Stale", "deadbeef"))

  const inventory = await discoverKnowledge(fixtureRoot, canonicalRoot)

  expect(inventory.entries.find((entry) => entry.title === "Fresh")?.freshness).toBe("fresh")
  expect(inventory.entries.find((entry) => entry.title === "Stale")?.freshness).toBe("stale")
})

test("reads the Cambrian contract index and marks superseded decisions inactive", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-compatibility-"))
  await mkdir(join(fixtureRoot, ".git"))
  const canonicalRoot = join(fixtureRoot, "canonical")
  await mkdir(join(canonicalRoot, "contracts"), { recursive: true })
  await mkdir(join(canonicalRoot, "adrs"), { recursive: true })
  await writeFile(
    join(canonicalRoot, "contracts", "INDEX.md"),
    "# Contracts\n\n| Contract | Covers | Status | Implemented by | Last verified |\n|----------|--------|--------|----------------|----------------|\n| 0098 | Entity links | implemented | ADR-0128 | 2026-09-11 |\n",
  )
  await writeFile(
    join(canonicalRoot, "adrs", "0010.md"),
    '---\ntitle: "Old decision"\nstatus: superseded\nsuperseded_by: "0011"\nlast_verified: 2026-09-11\n---\n\nDo not use this decision.\n',
  )

  const inventory = await discoverKnowledge(fixtureRoot, canonicalRoot)

  expect(inventory.entries).toHaveLength(2)
  expect(inventory.entries.some((entry) => entry.title.includes("Contract 0098"))).toBe(true)
  const superseded = inventory.entries.find((entry) => entry.title === "Old decision")
  expect(superseded?.freshness).toBe("stale")
  expect(superseded === undefined || isKnowledgeActive(superseded)).toBe(false)
})

test("reviews, promotes, and rejects session knowledge without mutating canonical roots", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-review-"))
  await mkdir(join(fixtureRoot, ".git"))

  const pending = await recordKnowledge(fixtureRoot, {
    kind: "decision",
    title: "Use a reviewed memory lane",
    summary: "Session discoveries need explicit promotion before becoming project truth.",
  })
  expect((await reviewKnowledge(fixtureRoot)).records[0]?.status).toBe("pending")

  const promoted = await promoteKnowledge(fixtureRoot, pending.path)
  expect(promoted.action).toBe("promoted")
  expect(promoted.targetPath).toContain(".skald/knowledge-canonical/decisions/")
  expect((await reviewKnowledge(fixtureRoot)).records[0]?.status).toBe("promoted")

  const rejected = await recordKnowledge(fixtureRoot, {
    kind: "observation",
    title: "Reject this observation",
    summary: "This observation is not reliable enough to retain.",
  })
  expect((await rejectKnowledge(fixtureRoot, rejected.path)).action).toBe("rejected")
  const reviewed = await reviewKnowledge(fixtureRoot)
  expect(
    reviewed.records.some(
      (record) => record.path.endsWith(rejected.path) && record.status === "rejected",
    ),
  ).toBe(true)
})

test("blocks promotion when a canonical record conflicts with a session record", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-conflict-"))
  await mkdir(join(fixtureRoot, ".git"))
  const pending = await recordKnowledge(fixtureRoot, {
    kind: "decision",
    title: "Conflicting decision",
    summary: "The session version says one thing.",
  })
  await mkdir(join(fixtureRoot, ".skald", "knowledge-canonical", "decisions"), { recursive: true })
  await writeFile(
    join(fixtureRoot, ".skald", "knowledge-canonical", "decisions", "existing.md"),
    "---\ntitle: Conflicting decision\nstatus: active\n---\n\nThe canonical version says another thing.\n",
  )

  const result = await promoteKnowledge(fixtureRoot, pending.path)

  expect(result.action).toBe("conflict")
  expect(result.conflicts).toHaveLength(1)
})
