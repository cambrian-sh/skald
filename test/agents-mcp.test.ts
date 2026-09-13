import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensureCodexGlobalMcpConfig } from "../src/agents/codex"
import { ensureAgentMcpConfig, type McpServerDefinition } from "../src/agents/mcp"
import { UnsafePathError } from "../src/fs/safe-file"

let fixtureRoot: string | undefined

type ServerMap = Record<string, unknown> & {
  skald?: unknown
  existing?: unknown
}

function defaultContextServer(): { command: string; args: string[] } {
  const bunx = Bun.which("bunx")
  return bunx === undefined || bunx === null
    ? {
        command: process.execPath,
        args: ["x", "--no-install", "--bun", "@cambrian/skald", "serve"],
      }
    : { command: bunx, args: ["--no-install", "--bun", "@cambrian/skald", "serve"] }
}

const server: McpServerDefinition = {
  command: "/opt/skald-engine",
  args: ["serve", "--stdio"],
  env: { CBM_KNOWLEDGE_DIR: "/tmp/skald-knowledge" },
}

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("creates a project-local Claude MCP config", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-claude-"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "claude", server, false)
  const contents = JSON.parse(await readFile(join(fixtureRoot, ".mcp.json"), "utf8")) as {
    mcpServers: ServerMap
  }

  expect(result).toEqual({ agent: "claude", action: "created", path: ".mcp.json" })
  expect(contents.mcpServers.skald).toEqual({
    command: "/opt/skald-engine",
    args: ["serve", "--stdio"],
    env: { CBM_KNOWLEDGE_DIR: "/tmp/skald-knowledge" },
  })
})

test("routes a trusted backend through the project runtime", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-supervised-"))

  await ensureAgentMcpConfig(
    fixtureRoot,
    "claude",
    { ...server, trust: "explicit", sha256: "a".repeat(64) },
    false,
    { command: "bun", args: [".skald/context-runtime.mjs", "serve"] },
    { superviseBackend: true },
  )
  const contents = JSON.parse(await readFile(join(fixtureRoot, ".mcp.json"), "utf8")) as {
    mcpServers: ServerMap
  }

  expect(contents.mcpServers.skald).toEqual({
    command: "bun",
    args: [".skald/context-runtime.mjs", "backend"],
  })
})

test("merges Claude MCP config without replacing unrelated servers", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-claude-merge-"))
  const existing = { mcpServers: { existing: { command: "existing-server" } } }
  await writeFile(join(fixtureRoot, ".mcp.json"), JSON.stringify(existing, null, 2).concat("\n"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "claude", server, false)
  const contents = JSON.parse(await readFile(join(fixtureRoot, ".mcp.json"), "utf8")) as {
    mcpServers: ServerMap
  }

  expect(result.action).toBe("updated")
  expect(contents.mcpServers.existing).toEqual({ command: "existing-server" })
  expect(contents.mcpServers.skald).toBeDefined()
  expect(contents.mcpServers["skald-context"]).toEqual({
    ...defaultContextServer(),
  })
})

test("installs the opt-in Claude SessionStart context hook", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-claude-hook-"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "claude", server, false, undefined, {
    installHooks: true,
  })
  const settings = JSON.parse(
    await readFile(join(fixtureRoot, ".claude", "settings.json"), "utf8"),
  ) as {
    hooks: {
      SessionStart: readonly {
        matcher: string
        hooks: readonly { type: string; command: string }[]
      }[]
    }
  }

  expect(result.note).toContain("Claude SessionStart hook")
  expect(settings.hooks.SessionStart).toEqual([
    {
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command: `${process.execPath} ${resolve(fixtureRoot, ".skald/context-runtime.mjs")} hook claude-session-start`,
        },
      ],
    },
  ])
})

test("preserves an existing legacy codebase-memory-mcp entry", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-legacy-"))
  const existing = {
    mcpServers: { "codebase-memory-mcp": { command: "legacy-engine" } },
  }
  const serialized = JSON.stringify(existing, null, 2).concat("\n")
  await writeFile(join(fixtureRoot, ".mcp.json"), serialized)

  const result = await ensureAgentMcpConfig(fixtureRoot, "claude", server, false)

  expect(result).toEqual({
    agent: "claude",
    action: "updated",
    path: ".mcp.json",
    existingServer: "codebase-memory-mcp",
  })
  const contents = JSON.parse(await readFile(join(fixtureRoot, ".mcp.json"), "utf8")) as {
    mcpServers: { "codebase-memory-mcp": unknown; "skald-context": unknown }
  }
  expect(contents.mcpServers["codebase-memory-mcp"]).toEqual({ command: "legacy-engine" })
  expect(contents.mcpServers["skald-context"]).toEqual({
    ...defaultContextServer(),
  })
})

test("reports Codex global fallback without writing project-local files", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-codex-"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "codex", server, false)

  expect(result.action).toBe("requires_global")
  expect(result.path).toBe("~/.codex/config.toml")
  expect(existsSync(join(fixtureRoot, ".codex"))).toBe(false)
})

test("does not touch an existing project-local Codex file", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-codex-existing-"))
  const configDirectory = join(fixtureRoot, ".codex")
  const configPath = join(configDirectory, "config.toml")
  const existing = '[mcp_servers.skald]\ncommand = "old-engine"\n'
  await mkdir(configDirectory)
  await writeFile(configPath, existing)

  const result = await ensureAgentMcpConfig(fixtureRoot, "codex", server, false)

  expect(result.action).toBe("requires_global")
  expect(await readFile(configPath, "utf8")).toBe(existing)
})

test("creates OpenCode MCP config in its current local shape", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-opencode-"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "opencode", server, false)
  const contents = JSON.parse(await readFile(join(fixtureRoot, "opencode.json"), "utf8")) as {
    mcp: { servers: ServerMap }
  }

  expect(result).toEqual({ agent: "opencode", action: "created", path: "opencode.json" })
  expect(contents.mcp.servers.skald).toEqual({
    type: "local",
    command: ["/opt/skald-engine", "serve", "--stdio"],
    disabled: false,
    environment: { CBM_KNOWLEDGE_DIR: "/tmp/skald-knowledge" },
  })
})

test("adds OpenCode MCP config to the v2 servers shape when present", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-opencode-v2-"))
  const existing = {
    mcp: { servers: { existing: { type: "remote", url: "https://example.test" } } },
  }
  await writeFile(
    join(fixtureRoot, "opencode.json"),
    JSON.stringify(existing, null, 2).concat("\n"),
  )

  const result = await ensureAgentMcpConfig(fixtureRoot, "opencode", server, false)
  const contents = JSON.parse(await readFile(join(fixtureRoot, "opencode.json"), "utf8")) as {
    mcp: { servers: ServerMap }
  }

  expect(result.action).toBe("updated")
  expect(contents.mcp.servers.existing).toEqual({ type: "remote", url: "https://example.test" })
  expect(contents.mcp.servers.skald).toBeDefined()
  expect(contents.mcp.servers["skald-context"]).toEqual({
    type: "local",
    command: [defaultContextServer().command, ...defaultContextServer().args],
    disabled: false,
  })
})

test("updates OpenCode JSONC without removing comments", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-opencode-jsonc-"))
  const existing = [
    "{",
    "  // Keep this project note.",
    '  "mcp": {',
    '    "existing": { "type": "remote", "url": "https://example.test" },',
    "  },",
    "}",
    "",
  ].join("\n")
  await writeFile(join(fixtureRoot, "opencode.jsonc"), existing)

  const result = await ensureAgentMcpConfig(fixtureRoot, "opencode", server, false)
  const contents = await readFile(join(fixtureRoot, "opencode.jsonc"), "utf8")

  expect(result).toEqual({ agent: "opencode", action: "updated", path: "opencode.jsonc" })
  expect(contents).toContain("// Keep this project note.")
  expect(contents).toContain('"skald"')
})

test("dry-run reports the Codex global fallback without creating files", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-dry-run-"))

  const result = await ensureAgentMcpConfig(fixtureRoot, "codex", server, true)

  expect(result.action).toBe("requires_global")
  expect(existsSync(join(fixtureRoot, ".codex"))).toBe(false)
})

test("creates a Codex global MCP entry in an injected config home", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-global-"))
  const configDirectory = join(fixtureRoot, "codex-home")

  const result = await ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath: "fake-codex-home/config.toml",
    server,
    dryRun: false,
  })
  const contents = await readFile(join(configDirectory, "config.toml"), "utf8")

  expect(result).toEqual({
    agent: "codex",
    action: "created",
    path: "fake-codex-home/config.toml",
  })
  expect(contents).toContain("[mcp_servers.skald]\n")
  expect(contents).toContain('command = "/opt/skald-engine"\n')
  expect(contents).toContain('args = ["serve", "--stdio"]\n')
  expect(contents).toContain(
    '[mcp_servers.skald.env]\nCBM_KNOWLEDGE_DIR = "/tmp/skald-knowledge"\n',
  )
})

test("quotes custom Codex server names that contain TOML punctuation", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-global-custom-name-"))
  const configDirectory = join(fixtureRoot, "codex-home")
  const customServer = { ...server, serverName: "skald.custom" }

  await ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath: "fake-codex-home/config.toml",
    server: customServer,
    contextServer: { ...server, serverName: "context.custom" },
    dryRun: false,
  })
  const contents = await readFile(join(configDirectory, "config.toml"), "utf8")

  expect(contents).toContain('[mcp_servers."skald.custom"]\n')
  expect(contents).toContain('[mcp_servers."skald.custom".env]\n')
  expect(contents).toContain('[mcp_servers."context.custom"]\n')
  expect(Bun.TOML.parse(contents)).toMatchObject({
    mcp_servers: {
      "skald.custom": {
        command: "/opt/skald-engine",
        env: { CBM_KNOWLEDGE_DIR: "/tmp/skald-knowledge" },
      },
      "context.custom": { command: "/opt/skald-engine" },
    },
  })
})

test("appends Codex global MCP config without replacing existing settings", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-global-merge-"))
  const configDirectory = join(fixtureRoot, "codex-home")
  const configPath = join(configDirectory, "config.toml")
  const existing = '[projects."/tmp/project"]\ntrust_level = "trusted"\n'
  await mkdir(configDirectory)
  await writeFile(configPath, existing)

  const result = await ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath: "fake-codex-home/config.toml",
    server,
    dryRun: false,
  })
  const contents = await readFile(configPath, "utf8")

  expect(result.action).toBe("updated")
  expect(contents.startsWith(existing)).toBe(true)
  expect(contents).toContain("[mcp_servers.skald]\n")
  expect(contents).toContain('trust_level = "trusted"\n')
})

test("preserves an existing legacy Codex global entry", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-global-legacy-"))
  const configDirectory = join(fixtureRoot, "codex-home")
  const configPath = join(configDirectory, "config.toml")
  const existing = '[mcp_servers.codebase-memory-mcp]\ncommand = "legacy-engine"\n'
  await mkdir(configDirectory)
  await writeFile(configPath, existing)

  const result = await ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath: "fake-codex-home/config.toml",
    server,
    dryRun: false,
  })

  expect(result).toEqual({
    agent: "codex",
    action: "updated",
    path: "fake-codex-home/config.toml",
    existingServer: "codebase-memory-mcp",
  })
  const contents = await readFile(configPath, "utf8")
  expect(contents).toContain(existing)
  expect(contents).toContain("[mcp_servers.skald-context]\n")
})

test("rejects malformed Codex global config without changing it", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-global-invalid-"))
  const configDirectory = join(fixtureRoot, "codex-home")
  const configPath = join(configDirectory, "config.toml")
  const existing = "not valid toml =\n"
  await mkdir(configDirectory)
  await writeFile(configPath, existing)

  const operation = ensureCodexGlobalMcpConfig({
    configDirectory,
    displayPath: "fake-codex-home/config.toml",
    server,
    dryRun: false,
  })

  await expect(operation).rejects.toThrow("Cannot safely update")
  expect(await readFile(configPath, "utf8")).toBe(existing)
})

test("rejects a symlinked Claude config without changing its target", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-mcp-symlink-"))
  const targetPath = join(fixtureRoot, "target.json")
  const configPath = join(fixtureRoot, ".mcp.json")
  const existing = '{"mcpServers":{"existing":{"command":"keep"}}}\n'
  await writeFile(targetPath, existing)
  await symlink(targetPath, configPath)

  await expect(ensureAgentMcpConfig(fixtureRoot, "claude", server, false)).rejects.toBeInstanceOf(
    UnsafePathError,
  )
  expect(await readFile(targetPath, "utf8")).toBe(existing)
})

test("rejects a Codex config directory below a symlinked parent", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-codex-parent-symlink-"))
  const outside = join(fixtureRoot, "outside")
  const link = join(fixtureRoot, "linked-home")
  await mkdir(outside)
  await symlink(outside, link)

  await expect(
    ensureCodexGlobalMcpConfig({
      configDirectory: join(link, ".codex"),
      displayPath: "linked-home/.codex/config.toml",
      server,
      dryRun: false,
    }),
  ).rejects.toBeInstanceOf(UnsafePathError)
  expect(existsSync(join(outside, ".codex", "config.toml"))).toBe(false)
})
