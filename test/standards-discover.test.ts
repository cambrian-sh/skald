import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverStandards } from "../src/standards/discover"

let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("discovers shared instructions and portable skills", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-standards-"))
  await mkdir(join(fixtureRoot, ".git"))
  await mkdir(join(fixtureRoot, ".agents", "skills", "review"), { recursive: true })
  await mkdir(join(fixtureRoot, ".skills", "security"), { recursive: true })
  await mkdir(join(fixtureRoot, ".opencode", "skills", "release"), { recursive: true })
  await mkdir(join(fixtureRoot, ".github", "instructions"), { recursive: true })
  await mkdir(join(fixtureRoot, ".cursor", "rules"), { recursive: true })
  await writeFile(join(fixtureRoot, "AGENTS.md"), "# Project instructions")
  await writeFile(join(fixtureRoot, "CLAUDE.md"), "# Claude instructions")
  await writeFile(join(fixtureRoot, ".cursorrules"), "# Cursor compatibility")
  await writeFile(
    join(fixtureRoot, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\n---",
  )
  await writeFile(
    join(fixtureRoot, ".opencode", "skills", "release", "SKILL.md"),
    "---\nname: release\n---",
  )
  await writeFile(join(fixtureRoot, ".skills", "security", "SKILL.md"), "---\nname: security\n---")
  await writeFile(
    join(fixtureRoot, ".github", "instructions", "testing.instructions.md"),
    "# Testing",
  )
  await writeFile(join(fixtureRoot, ".cursor", "rules", "typescript.mdc"), "# TypeScript")

  const inventory = await discoverStandards(fixtureRoot)

  expect(inventory.instructions.map((file) => file.path)).toEqual([
    ".cursor/rules/typescript.mdc",
    ".cursorrules",
    ".github/instructions/testing.instructions.md",
    "AGENTS.md",
    "CLAUDE.md",
  ])
  expect(inventory.skills.map((skill) => skill.path)).toEqual([
    ".agents/skills/review/SKILL.md",
    ".opencode/skills/release/SKILL.md",
    ".skills/security/SKILL.md",
  ])
  expect(inventory.truncated).toBe(false)
})

test("reports when discovery reaches its configured repository limit", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-standards-limit-"))
  await mkdir(join(fixtureRoot, ".git"))
  await mkdir(join(fixtureRoot, "nested"))
  await writeFile(join(fixtureRoot, "nested", "AGENTS.md"), "# Nested instructions")

  const inventory = await discoverStandards(fixtureRoot, { maxDirectories: 1 })

  expect(inventory.truncated).toBe(true)
})
