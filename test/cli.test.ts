import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { locateProjectEngineSource } from "../src/engine/project"

let fixtureRoot: string | undefined
const standaloneCli = process.env["SKALD_TEST_STANDALONE_CLI"]?.trim()
const hasManagedSetupEngine =
  (await locateProjectEngineSource(resolve(import.meta.dir, ".."))) !== undefined ||
  (standaloneCli !== undefined && standaloneCli.length > 0)
const originalTrustDirectory = process.env["SKALD_TRUST_DIRECTORY"]
const testTrustDirectory = join(tmpdir(), `skald-cli-trust-${process.pid}`)
process.env["SKALD_TRUST_DIRECTORY"] = testTrustDirectory

function testEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, SKALD_TRUST_DIRECTORY: testTrustDirectory, ...overrides }
}

setDefaultTimeout(15_000)

function isProcessGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "ECHILD" || error.code === "ERR_PROCESS_NOT_RUNNING")
  )
}

async function stopChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode === null) {
    try {
      child.kill("SIGTERM")
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
  }
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 1_000)),
  ])
  if (!exited && child.exitCode === null) {
    try {
      child.kill("SIGKILL")
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
  }
  await child.exited
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("context runtime closed before responding")
      buffer += decoder.decode(chunk.value, { stream: true })
      const newline = buffer.indexOf("\n")
      if (newline >= 0) return buffer.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

afterAll(async () => {
  await rm(testTrustDirectory, { force: true, recursive: true })
  if (originalTrustDirectory === undefined) delete process.env["SKALD_TRUST_DIRECTORY"]
  else process.env["SKALD_TRUST_DIRECTORY"] = originalTrustDirectory
})

test("prints a machine-readable init dry-run", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-"))
  await mkdir(join(fixtureRoot, ".git"))
  await writeFile(join(fixtureRoot, "AGENTS.md"), "# Project instructions")

  const result = Bun.spawnSync(
    ["bun", "run", "src/cli.ts", "init", "--dry-run", "--json", "--root", fixtureRoot],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )
  const output = new TextDecoder().decode(result.stdout)

  expect(result.exitCode).toBe(0)
  expect(output).toContain('"command":"init"')
  expect(output).toContain('"dryRun":true')
  expect(output).toContain('"instructionFiles"')
})

test("creates the project config during init", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-init-"))
  await mkdir(join(fixtureRoot, ".git"))

  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "init",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      "/opt/skald-engine",
      "--mcp-env",
      "CBM_KNOWLEDGE_DIR=/tmp/skald-knowledge",
    ],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )
  const configPath = join(fixtureRoot, ".skald", "config.json")
  const output = new TextDecoder().decode(result.stdout)

  expect(result.exitCode).toBe(0)
  expect(output).toContain('"dryRun":false')
  expect(output).toContain('"configAction":"created"')
  expect(output).toContain('"mcpConfigs"')
  expect(output).toContain('"agent":"claude"')
  expect(existsSync(configPath)).toBe(true)
  expect(existsSync(join(fixtureRoot, ".mcp.json"))).toBe(true)
  expect(existsSync(join(fixtureRoot, "opencode.json"))).toBe(true)
  expect(existsSync(join(fixtureRoot, ".skald", "context-runtime.mjs"))).toBe(true)
  expect(existsSync(join(fixtureRoot, ".codex"))).toBe(false)
  const config = await readFile(configPath, "utf8")
  expect(config).toContain('"command": "')
  expect(config).toContain("/opt/skald-engine")
  expect(config).toContain("/tmp/skald-knowledge")
})

test("persists a runnable project-local context runtime", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-runtime-"))
  await mkdir(join(fixtureRoot, ".git"))

  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "init",
      "--json",
      "--no-index",
      "--root",
      fixtureRoot,
      "--agents",
      "claude",
    ],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )
  expect(result.exitCode).toBe(0)

  const child = Bun.spawn([process.execPath, ".skald/context-runtime.mjs", "serve"], {
    cwd: fixtureRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const stdin = child.stdin
    const stdout = child.stdout
    if (
      typeof stdin !== "object" ||
      stdin === null ||
      typeof stdin.write !== "function" ||
      typeof stdout !== "object" ||
      stdout === null
    ) {
      throw new Error("context runtime stdio is unavailable")
    }
    await stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
    )
    const line = await readFirstLine(stdout)
    const response = JSON.parse(line) as { result?: { protocolVersion?: string } }
    expect(response.result?.protocolVersion).toBe("2025-06-18")
  } finally {
    await stopChild(child)
  }
})

test("refreshes the project-local context runtime on a repeatable init", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-runtime-update-"))
  await mkdir(join(fixtureRoot, ".git"))
  const args = [
    "bun",
    "run",
    "src/cli.ts",
    "init",
    "--json",
    "--no-index",
    "--root",
    fixtureRoot,
    "--agents",
    "claude",
    "--mcp-command",
    "/opt/skald-engine",
  ]

  const first = Bun.spawnSync(args, {
    cwd: resolve(import.meta.dir, ".."),
    env: testEnvironment(),
  })
  const second = Bun.spawnSync(args, {
    cwd: resolve(import.meta.dir, ".."),
    env: testEnvironment(),
  })

  expect(first.exitCode).toBe(0)
  expect(second.exitCode).toBe(0)
  expect(new TextDecoder().decode(second.stdout)).toContain('"action":"updated"')
})

test("installs Codex globally only through the explicit global command", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-codex-global-"))
  const fakeHome = join(fixtureRoot, "home")
  const codexHome = join(fixtureRoot, "codex-home")
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "agents",
      "install",
      "codex",
      "--global",
      "--json",
      "--mcp-command",
      "/opt/skald-engine",
      "--mcp-arg",
      "serve",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({
        CODEX_HOME: codexHome,
        HOME: fakeHome,
      }),
    },
  )
  const output = new TextDecoder().decode(result.stdout)
  const configPath = join(codexHome, "config.toml")

  expect(result.exitCode).toBe(0)
  expect(output).toContain('"command":"agents install"')
  expect(output).toContain('"action":"created"')
  expect(await readFile(configPath, "utf8")).toBe(
    `[mcp_servers.skald-context]\ncommand = "${process.execPath}"\nargs = ["${resolve(import.meta.dir, "../src/cli.ts")}", "serve"]\n`,
  )
  expect(existsSync(join(fakeHome, ".codex", "config.toml"))).toBe(false)
})

test("routes a trusted Codex backend through Skald's verified runtime", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-codex-supervised-"))
  const codexHome = join(fixtureRoot, "codex-home")
  const backend = join(fixtureRoot, "backend.sh")
  const entrypoint = resolve(import.meta.dir, "../src/cli.ts")
  await writeFile(backend, "#!/bin/sh\n")
  await chmod(backend, 0o755)

  const result = Bun.spawnSync(
    [
      process.execPath,
      entrypoint,
      "agents",
      "install",
      "codex",
      "--global",
      "--json",
      "--mcp-command",
      backend,
    ],
    {
      cwd: fixtureRoot,
      env: testEnvironment({ CODEX_HOME: codexHome }),
    },
  )
  const contents = await readFile(join(codexHome, "config.toml"), "utf8")

  expect(result.exitCode).toBe(0)
  expect(contents).toContain(
    `[mcp_servers.skald]\ncommand = "${process.execPath}"\nargs = ["${entrypoint}", "backend"]\n`,
  )
  expect(contents).toContain(
    `[mcp_servers.skald-context]\ncommand = "${process.execPath}"\nargs = ["${entrypoint}", "serve"]\n`,
  )
})

test("can configure Codex before the backend is installed", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-codex-default-"))
  const codexHome = join(fixtureRoot, "codex-home")
  const result = Bun.spawnSync(
    ["bun", "run", "src/cli.ts", "agents", "install", "codex", "--global", "--json"],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({ CODEX_HOME: codexHome }),
    },
  )

  expect(result.exitCode).toBe(0)
  expect(await readFile(join(codexHome, "config.toml"), "utf8")).toMatch(
    /\[mcp_servers\.skald-context\]/,
  )
})

test("does not leave a partial init when an agent config is invalid", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-atomic-"))
  await mkdir(join(fixtureRoot, ".git"))
  await writeFile(join(fixtureRoot, "opencode.json"), '{"mcp": [}\n')

  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "init",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      "/bin/sh",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({ SKALD_TRUST_DIRECTORY: join(fixtureRoot, "trust") }),
    },
  )

  expect(result.exitCode).toBe(1)
  expect(existsSync(join(fixtureRoot, ".skald"))).toBe(false)
  expect(existsSync(join(fixtureRoot, ".mcp.json"))).toBe(false)
  expect(existsSync(join(fixtureRoot, "trust", "trust.json"))).toBe(false)
})

test("reuses the existing Cambrian Claude engine for other agent configs", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-cambrian-"))
  await mkdir(join(fixtureRoot, ".git"))
  await mkdir(join(fixtureRoot, ".claude"))
  const claudeConfig = join(fixtureRoot, ".claude", ".mcp.json")
  const existing = JSON.stringify(
    {
      mcpServers: {
        "codebase-memory-mcp": {
          command: "/opt/cambrian/codebase-memory-mcp",
          env: { CBM_KNOWLEDGE_DIR: "/opt/cambrian-knowledge" },
        },
      },
    },
    null,
    2,
  )
  await writeFile(claudeConfig, existing)

  const result = Bun.spawnSync(
    ["bun", "run", "src/cli.ts", "init", "--json", "--root", fixtureRoot],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )
  const output = new TextDecoder().decode(result.stdout)
  const contextRuntimePath = resolve(fixtureRoot, ".skald/context-runtime.mjs")
  const bunExecutable = Bun.which("bun") ?? process.execPath
  const opencode = JSON.parse(await readFile(join(fixtureRoot, "opencode.json"), "utf8")) as {
    mcp: {
      servers: {
        "skald-context": { type: string; command: string[]; disabled: boolean }
      }
    }
  }

  expect(result.exitCode).toBe(0)
  const claude = JSON.parse(await readFile(claudeConfig, "utf8")) as {
    mcpServers: {
      "codebase-memory-mcp": { command: string; env: Record<string, string> }
      "skald-context": { command: string; args: string[] }
    }
  }
  expect(claude.mcpServers["codebase-memory-mcp"]).toEqual({
    command: "/opt/cambrian/codebase-memory-mcp",
    env: { CBM_KNOWLEDGE_DIR: "/opt/cambrian-knowledge" },
  })
  expect(claude.mcpServers["skald-context"]).toEqual({
    command: bunExecutable,
    args: [contextRuntimePath, "serve"],
  })
  expect(existsSync(join(fixtureRoot, ".skald", "context-runtime.mjs"))).toBe(true)
  expect(output).toContain('"path":".claude/.mcp.json"')
  expect(opencode.mcp.servers["skald-context"]).toEqual({
    type: "local",
    command: [bunExecutable, contextRuntimePath, "serve"],
    disabled: false,
  })
})

test.skipIf(hasManagedSetupEngine)(
  "refuses setup without the Afşin engine before changing project files",
  async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-setup-no-engine-"))
    await mkdir(join(fixtureRoot, ".git"))

    const result = Bun.spawnSync(
      [
        "bun",
        "run",
        "src/cli.ts",
        "setup",
        "--no-index",
        "--agents",
        "claude",
        "--json",
        "--root",
        fixtureRoot,
      ],
      { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
    )

    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "The Skald release does not contain the Afşin engine",
    )
    expect(existsSync(join(fixtureRoot, ".skald"))).toBe(false)
    expect(existsSync(join(fixtureRoot, ".mcp.json"))).toBe(false)
  },
)

test.skipIf(!hasManagedSetupEngine)(
  "preserves Cambrian knowledge when setup replaces an existing absolute engine",
  async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-cambrian-setup-"))
    await mkdir(join(fixtureRoot, ".git"))
    await mkdir(join(fixtureRoot, ".claude"))
    const knowledgeDirectory = join(fixtureRoot, "canonical-knowledge")
    await mkdir(knowledgeDirectory)
    await writeFile(
      join(fixtureRoot, ".claude", ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            "codebase-memory-mcp": {
              command:
                "/home/doruk/Code/cambrian/codebase-memory-mcp/build/c-afsin/codebase-memory-mcp",
              env: { CBM_KNOWLEDGE_DIR: knowledgeDirectory },
            },
          },
        },
        null,
        2,
      ),
    )

    const invocation =
      standaloneCli === undefined || standaloneCli.length === 0
        ? ["bun", "run", "src/cli.ts"]
        : [standaloneCli]
    const result = Bun.spawnSync(
      [...invocation, "setup", "--no-index", "--agents", "claude", "--json", "--root", fixtureRoot],
      { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
    )

    expect(result.exitCode).toBe(0)
    const manifest = JSON.parse(
      await readFile(join(fixtureRoot, ".skald", "config.json"), "utf8"),
    ) as {
      backend: { command: string; env?: Record<string, string> }
      sources: { kind: string; path: string }[]
    }
    expect(manifest.backend.command).toBe(
      join(fixtureRoot, ".skald", "engine", "codebase-memory-mcp"),
    )
    expect(manifest.backend.env?.["CBM_KNOWLEDGE_DIR"]).toBe(knowledgeDirectory)
    expect(manifest.sources.find((source) => source.kind === "knowledge")?.path).toBe(
      knowledgeDirectory,
    )
  },
)

test("locates and indexes the configured MCP engine", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-engine-"))
  await mkdir(join(fixtureRoot, ".git"))
  const fakeEngine = join(fixtureRoot, "fake-mcp.sh")
  await writeFile(
    fakeEngine,
    `#!/bin/sh
read initialize
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}'
read initialized
read call
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"indexed":true}}}'
`,
  )
  await chmod(fakeEngine, 0o755)

  const locate = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "engine",
      "locate",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      "/bin/true",
    ],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )
  const index = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "engine",
      "index",
      "--json",
      "--root",
      fixtureRoot,
      "--mode",
      "full",
      "--mcp-command",
      "/bin/sh",
      "--mcp-arg",
      join(fixtureRoot, "fake-mcp.sh"),
    ],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )

  expect(locate.exitCode).toBe(0)
  expect(new TextDecoder().decode(locate.stdout)).toContain('"engine":"/bin/true"')
  expect(index.exitCode).toBe(0)
  expect(new TextDecoder().decode(index.stdout)).toContain('"mode":"full"')
  expect(existsSync(join(fixtureRoot, ".skald", "state.json"))).toBe(true)
})

test("does not publish project integration when the initial index fails", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-index-failure-"))
  await mkdir(join(fixtureRoot, ".git"))
  const fakeEngine = join(fixtureRoot, "fake-mcp.sh")
  await writeFile(
    fakeEngine,
    `#!/bin/sh
read initialize
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}'
read initialized
read call
printf '%s\\n' '{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"index failed"}}'
`,
  )
  await chmod(fakeEngine, 0o755)

  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "init",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      fakeEngine,
    ],
    { cwd: resolve(import.meta.dir, ".."), env: testEnvironment() },
  )

  expect(result.exitCode).toBe(1)
  expect(new TextDecoder().decode(result.stderr)).toContain("MCP engine index failed")
  expect(existsSync(join(fixtureRoot, ".skald"))).toBe(false)
  expect(existsSync(join(fixtureRoot, ".mcp.json"))).toBe(false)
  expect(existsSync(join(fixtureRoot, "trust", "trust.json"))).toBe(false)
})

test("fails fast when an MCP backend does not respond", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-engine-timeout-"))
  await mkdir(join(fixtureRoot, ".git"))

  const started = performance.now()
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "engine",
      "index",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      "/bin/sleep",
      "--mcp-arg",
      "30",
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({ SKALD_MCP_TIMEOUT_MS: "100" }),
    },
  )

  expect(result.exitCode).toBe(1)
  expect(performance.now() - started).toBeLessThan(5000)
  expect(new TextDecoder().decode(result.stdout)).toContain("timed out")
})

test("escalates cleanup when an MCP backend ignores termination", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-engine-kill-"))
  await mkdir(join(fixtureRoot, ".git"))

  const started = performance.now()
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "engine",
      "index",
      "--json",
      "--root",
      fixtureRoot,
      "--mcp-command",
      "bun",
      "--mcp-arg",
      "-e",
      "--mcp-arg",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({ SKALD_MCP_TIMEOUT_MS: "100" }),
    },
  )

  expect(result.exitCode).toBe(1)
  expect(performance.now() - started).toBeLessThan(5000)
  expect(new TextDecoder().decode(result.stdout)).toContain("timed out")
})

test("doctor fails fast when the configured MCP backend does not respond", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-doctor-timeout-"))
  await mkdir(join(fixtureRoot, ".git"))
  await writeFile(
    join(fixtureRoot, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { skald: { command: "/bin/sleep", args: ["30"] } } })}\n`,
  )

  const started = performance.now()
  const result = Bun.spawnSync(
    ["bun", "run", "src/cli.ts", "doctor", "--json", "--root", fixtureRoot],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: testEnvironment({ SKALD_MCP_TIMEOUT_MS: "100" }),
    },
  )

  expect(result.exitCode).toBe(1)
  expect(performance.now() - started).toBeLessThan(5000)
  expect(new TextDecoder().decode(result.stdout)).toContain('"status":"fail"')
})

test("configures only the selected agents", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-cli-selected-agents-"))
  await mkdir(join(fixtureRoot, ".git"))

  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "src/cli.ts",
      "init",
      "--json",
      "--root",
      fixtureRoot,
      "--agents",
      "claude",
      "--mcp-command",
      "/opt/skald-engine",
    ],
    { cwd: resolve(import.meta.dir, "..") },
  )

  expect(result.exitCode).toBe(0)
  expect(existsSync(join(fixtureRoot, ".mcp.json"))).toBe(true)
  expect(existsSync(join(fixtureRoot, "opencode.json"))).toBe(false)
  expect(new TextDecoder().decode(result.stdout)).toContain('"agents":["claude"]')
})
