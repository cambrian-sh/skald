import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureConfig, readConfiguredMcpServer, readProjectManifest } from "../src/config"
import { UnsafePathError } from "../src/fs/safe-file"

let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("creates the minimal config when it is missing", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-"))

  const result = await ensureConfig(fixtureRoot, false)
  const contents = await readFile(join(fixtureRoot, ".skald", "config.json"), "utf8")

  expect(result.action).toBe("created")
  expect(result.path).toBe(".skald/config.json")
  expect(contents).toContain('"onQuery": "refresh"')
  expect(contents.replace('"onQuery": "refresh"', '"onQuery": "warn"')).toBe(
    '{\n  "version": 2,\n  "project": {\n    "root": "."\n  },\n  "backend": {\n    "kind": "mcp",\n    "command": "codebase-memory-mcp",\n    "args": []\n  },\n  "sources": [\n    {\n      "kind": "repository",\n      "path": "."\n    },\n    {\n      "kind": "knowledge",\n      "path": ".skald/knowledge"\n    }\n  ],\n  "agents": [\n    "claude",\n    "codex",\n    "opencode"\n  ],\n  "context": {\n    "serverName": "skald-context",\n    "retrieval": "on-demand",\n    "writeSurface": ".skald/knowledge"\n  },\n  "freshness": {\n    "onQuery": "warn",\n    "beforeWrite": "require-verify"\n  }\n}\n',
  )
})

test("preserves an existing config", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-existing-"))
  const configDirectory = join(fixtureRoot, ".skald")
  const configPath = join(configDirectory, "config.json")
  const existingContents = `${JSON.stringify(
    {
      version: 2,
      project: { root: "." },
      backend: { kind: "mcp", command: "codebase-memory-mcp", args: [] },
      sources: [
        { kind: "repository", path: "." },
        { kind: "knowledge", path: ".skald/knowledge" },
      ],
      agents: ["claude", "codex", "opencode"],
      context: {
        serverName: "skald-context",
        retrieval: "on-demand",
        writeSurface: ".skald/knowledge",
      },
      freshness: { onQuery: "warn", beforeWrite: "require-verify" },
    },
    null,
    2,
  )}\n`
  await mkdir(configDirectory)
  await writeFile(configPath, existingContents)

  const result = await ensureConfig(fixtureRoot, false)
  const contents = await readFile(configPath, "utf8")

  expect(result.action).toBe("exists")
  expect(contents).toBe(existingContents)
})

test("accepts the warn policy for knowledge writes", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-warn-"))
  const configPath = join(fixtureRoot, ".skald", "config.json")
  await ensureConfig(fixtureRoot, false)
  const contents = await readFile(configPath, "utf8")
  await writeFile(
    configPath,
    contents.replace('"beforeWrite": "require-verify"', '"beforeWrite": "warn"'),
  )

  expect((await readProjectManifest(fixtureRoot))?.freshness.beforeWrite).toBe("warn")
})

test("updates only the backend when explicit engine configuration is requested", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-backend-update-"))
  const configDirectory = join(fixtureRoot, ".skald")
  const configPath = join(configDirectory, "config.json")
  await mkdir(configDirectory)
  await writeFile(
    configPath,
    '{\n  // Keep this project note.\n  "version": 2,\n  "project": { "root": "." },\n  "backend": { "kind": "mcp", "command": "old-engine", "args": [] },\n  "sources": [{ "kind": "repository", "path": "." }, { "kind": "knowledge", "path": ".skald/knowledge" }],\n  "agents": ["claude", "codex", "opencode"],\n  "context": { "serverName": "skald-context", "retrieval": "on-demand", "writeSurface": ".skald/knowledge" },\n  "freshness": { "onQuery": "warn", "beforeWrite": "require-verify" }\n}\n',
  )

  const result = await ensureConfig(
    fixtureRoot,
    false,
    {
      command: "/opt/afsin/codebase-memory-mcp",
      args: ["serve"],
      trust: "explicit",
      sha256: "a".repeat(64),
    },
    undefined,
    { updateBackend: true },
  )

  const contents = await readFile(configPath, "utf8")
  expect(result.action).toBe("updated")
  expect(contents).toContain("Keep this project note")
  expect(contents).toContain("/opt/afsin/codebase-memory-mcp")
  expect(contents).toContain(`"sha256": "${"a".repeat(64)}"`)
  expect(contents).not.toContain('"command": "old-engine"')
})

test("updates the configured knowledge source without replacing other manifest fields", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-knowledge-update-"))
  const configDirectory = join(fixtureRoot, ".skald")
  const configPath = join(configDirectory, "config.json")
  await mkdir(configDirectory)
  await writeFile(
    configPath,
    `{
  // Keep this project note.
  "version": 2,
  "project": { "root": "." },
  "backend": { "kind": "mcp", "command": "codebase-memory-mcp", "args": [] },
  "sources": [
    { "kind": "repository", "path": "." },
    { "kind": "knowledge", "path": ".skald/knowledge" }
  ],
  "agents": ["claude", "codex", "opencode"],
  "context": { "serverName": "skald-context", "retrieval": "on-demand", "writeSurface": ".skald/knowledge" },
  "freshness": { "onQuery": "warn", "beforeWrite": "require-verify" }
}
`,
  )

  const result = await ensureConfig(
    fixtureRoot,
    false,
    {
      command: "/opt/afsin/codebase-memory-mcp",
      args: [],
    },
    undefined,
    { knowledgeDirectory: "/opt/cambrian-knowledge", updateBackend: true },
  )

  const contents = await readFile(configPath, "utf8")
  expect(result.action).toBe("updated")
  expect(contents).toContain("Keep this project note")
  expect(contents).toContain('"path": "/opt/cambrian-knowledge"')
  expect(contents).toContain('"writeSurface": ".skald/knowledge"')
})

test("migrates a legacy v1 config while preserving comments and profile metadata", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-migrate-"))
  const configDirectory = join(fixtureRoot, ".skald")
  const configPath = join(configDirectory, "config.json")
  await mkdir(configDirectory)
  await writeFile(
    configPath,
    '{\n  // Keep this profile for existing tooling.\n  "version": 1,\n  "profile": "cambrian",\n  "mcp": { "command": "/opt/cambrian/codebase-memory-mcp", "args": ["serve", "--stdio"] }\n}\n',
  )

  const result = await ensureConfig(fixtureRoot, false, {
    command: "/opt/cambrian/codebase-memory-mcp",
    args: ["serve", "--stdio"],
  })
  const contents = await readFile(configPath, "utf8")

  expect(result.action).toBe("updated")
  expect(contents).toContain("Keep this profile for existing tooling")
  expect(contents).toContain('"version": 2')
  expect(contents).toContain('"profile": "cambrian"')
  expect(contents).toContain('"serverName": "skald-context"')
  expect((await readProjectManifest(fixtureRoot))?.version).toBe(2)
  expect((await readConfiguredMcpServer(fixtureRoot))?.args).toEqual(["serve", "--stdio"])
})

test("does not write during a dry run", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-dry-run-"))

  const result = await ensureConfig(fixtureRoot, true)

  expect(result.action).toBe("would_create")
  expect(existsSync(join(fixtureRoot, ".skald"))).toBe(false)
})

test("rejects a symlinked config directory without writing outside the project", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-symlink-"))
  const targetDirectory = join(fixtureRoot, "outside")
  await mkdir(targetDirectory)
  await symlink(targetDirectory, join(fixtureRoot, ".skald"))

  await expect(ensureConfig(fixtureRoot, false)).rejects.toBeInstanceOf(UnsafePathError)
  expect(existsSync(join(targetDirectory, "config.json"))).toBe(false)
})

test("reads the persisted MCP server for a repeatable setup", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-config-read-"))
  await mkdir(join(fixtureRoot, ".skald"))
  await writeFile(
    join(fixtureRoot, ".skald", "config.json"),
    JSON.stringify({
      version: 1,
      mcp: {
        command: "/opt/cambrian/codebase-memory-mcp",
        args: ["serve", "--stdio"],
        env: {
          CBM_KNOWLEDGE_DIR: "/opt/cambrian-knowledge",
          API_TOKEN: "must-not-be-loaded",
        },
      },
    }),
  )

  const server = await readConfiguredMcpServer(fixtureRoot)

  expect(server).toEqual({
    command: "/opt/cambrian/codebase-memory-mcp",
    args: ["serve", "--stdio"],
    env: { CBM_KNOWLEDGE_DIR: "/opt/cambrian-knowledge" },
  })
})
