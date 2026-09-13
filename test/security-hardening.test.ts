import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensureAgentMcpConfig } from "../src/agents/mcp"
import { mcpExecutableSha256, prepareMcpServer, runMcpTool } from "../src/engine"
import {
  assertSafeManagedPathPlatform,
  supportsSafeManagedPaths,
  writeManagedFile,
} from "../src/fs/safe-file"
import { isTrustedMcpExecutable, trustMcpExecutable } from "../src/trust"

let fixtureRoot: string | undefined
const originalTrustDirectory = process.env["SKALD_TRUST_DIRECTORY"]

setDefaultTimeout(15_000)

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
  delete process.env["SKALD_TEST_PARENT_SECRET"]
  delete process.env["SKALD_MCP_TIMEOUT_MS"]
  if (originalTrustDirectory === undefined) delete process.env["SKALD_TRUST_DIRECTORY"]
  else process.env["SKALD_TRUST_DIRECTORY"] = originalTrustDirectory
})

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

test("does not pass unrelated parent secrets to an MCP backend", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-env-"))
  const fakeEngine = join(fixtureRoot, "fake-mcp.sh")
  await writeFile(
    fakeEngine,
    `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"id":2'*) printf '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"secret":"%s"}}}\\n' "$SKALD_TEST_PARENT_SECRET"; exit 0 ;;
  esac
done
`,
  )
  await chmod(fakeEngine, 0o755)
  process.env["SKALD_TEST_PARENT_SECRET"] = "must-not-cross"

  const result = await runMcpTool(
    fixtureRoot,
    { command: fakeEngine, args: [], env: { SKALD_TEST_PARENT_SECRET: "server-secret" } },
    "probe",
  )

  expect(result.exitCode).toBe(0)
  expect(result.response).toEqual({ secret: "" })
})

test("does not persist sensitive MCP environment values into agent config", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-agent-env-"))

  const result = await ensureAgentMcpConfig(
    fixtureRoot,
    "claude",
    {
      command: "/opt/skald-engine",
      args: [],
      env: {
        API_TOKEN: "secret-value",
        DATABASE_URL: "postgres://user:secret@db.invalid/app",
        CBM_KNOWLEDGE_DIR: "/tmp/knowledge",
      },
    },
    false,
  )
  const config = await readFile(join(fixtureRoot, ".mcp.json"), "utf8")

  expect(config).not.toContain("secret-value")
  expect(config).not.toContain("API_TOKEN")
  expect(config).not.toContain("postgres://user:secret@db.invalid/app")
  expect(config).not.toContain("DATABASE_URL")
  expect(config).toContain("CBM_KNOWLEDGE_DIR")
  expect(result.note).toContain("API_TOKEN")
  expect(result.note).toContain("DATABASE_URL")
})

test("fails closed where descriptor-safe managed paths are unavailable", () => {
  expect(supportsSafeManagedPaths("linux")).toBe(true)
  expect(supportsSafeManagedPaths("darwin")).toBe(true)
  expect(supportsSafeManagedPaths("win32")).toBe(false)
  expect(() => assertSafeManagedPathPlatform("C:\\project\\.skald\\config.json", "win32")).toThrow(
    "Safe managed paths are unavailable on win32",
  )
})

test("rejects a shared MCP runtime directory", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-runtime-"))
  await chmod(fixtureRoot, 0o755)

  await expect(
    prepareMcpServer(fixtureRoot, {
      command: "/opt/codebase-memory-mcp",
      args: [],
      env: { CBM_RUNTIME_DIR: fixtureRoot },
      trust: "explicit",
    }),
  ).rejects.toThrow("must not be group/world accessible")
})

test("allows a normal Cambrian knowledge directory outside the private runtime", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-knowledge-"))
  const knowledgeDirectory = join(fixtureRoot, "cambrian-knowledge")
  await mkdir(knowledgeDirectory, { mode: 0o755 })

  const prepared = await prepareMcpServer(fixtureRoot, {
    command: "/opt/codebase-memory-mcp",
    args: [],
    env: { CBM_KNOWLEDGE_DIR: knowledgeDirectory },
    trust: "explicit",
  })

  expect(prepared.env?.["CBM_KNOWLEDGE_DIR"]).toBe(knowledgeDirectory)
})

test("merges concurrent trust approvals without losing either entry", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-trust-concurrent-"))
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, "trust")
  const first = join(fixtureRoot, "first-engine")
  const second = join(fixtureRoot, "second-engine")
  await writeFile(first, "#!/bin/sh\n")
  await writeFile(second, "#!/bin/sh\n")
  await chmod(first, 0o755)
  await chmod(second, 0o755)
  const firstServer = {
    command: first,
    args: [],
    sha256: await mcpExecutableSha256(first),
  }
  const secondServer = {
    command: second,
    args: [],
    sha256: await mcpExecutableSha256(second),
  }

  await Promise.all([
    trustMcpExecutable(fixtureRoot, firstServer),
    trustMcpExecutable(fixtureRoot, secondServer),
  ])

  expect(await isTrustedMcpExecutable(fixtureRoot, firstServer)).toBe(true)
  expect(await isTrustedMcpExecutable(fixtureRoot, secondServer)).toBe(true)
})

test("does not execute a pinned backend after its file is replaced", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-pinned-"))
  const backend = join(fixtureRoot, "backend.sh")
  const marker = join(fixtureRoot, "executed")
  await writeFile(backend, `#!/bin/sh\nprintf '%s' executed > '${marker}'\n`)
  await chmod(backend, 0o755)
  const trustedDigest = await mcpExecutableSha256(backend)
  await writeFile(backend, `#!/bin/sh\nprintf '%s' replaced > '${marker}'\n`)
  await chmod(backend, 0o755)

  const result = await runMcpTool(
    fixtureRoot,
    { command: backend, args: [], sha256: trustedDigest },
    "probe",
  )

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("changed after it was trusted")
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("rejects an MCP response that exceeds the transport limit", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-output-"))
  process.env["SKALD_MCP_TIMEOUT_MS"] = "1000"

  const result = await runMcpTool(
    fixtureRoot,
    {
      command: process.execPath,
      args: ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    },
    "probe",
  )

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("MCP response exceeds")
})

test("bounds MCP stderr captured during a failed request", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-stderr-"))
  process.env["SKALD_MCP_TIMEOUT_MS"] = "1000"

  const result = await runMcpTool(
    fixtureRoot,
    {
      command: process.execPath,
      args: [
        "-e",
        [
          "let responded = false",
          'process.stderr.write("x".repeat(2 * 1024 * 1024))',
          'process.stdin.on("data", chunk => { if (!responded && chunk.toString().includes("\\"id\\":1")) { responded = true; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }) + "\\n") } })',
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
    },
    "probe",
  )

  expect(result.exitCode).toBe(1)
  expect(result.stderr.length).toBeLessThan(65_000)
  expect(result.stderr).toContain("stream truncated")
})

test("terminates MCP descendants after a timeout", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-descendant-"))
  process.env["SKALD_MCP_TIMEOUT_MS"] = "1000"
  const script = [
    'const child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })',
    'process.stderr.write(String(child.pid) + "\\n")',
    'process.on("SIGTERM", () => {})',
    "let initialized = false",
    'process.stdin.on("data", chunk => { if (!initialized && chunk.toString().includes("\\"id\\":1")) { initialized = true; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }) + "\\n") } })',
    "setInterval(() => {}, 1000)",
  ].join(";")

  const result = await runMcpTool(
    fixtureRoot,
    { command: process.execPath, args: ["-e", script] },
    "probe",
  )
  const descendantPid = Number.parseInt(result.stderr.trim(), 10)

  try {
    expect(result.exitCode).toBe(1)
    expect(Number.isInteger(descendantPid)).toBe(true)
    expect(processIsAlive(descendantPid)).toBe(false)
  } finally {
    if (Number.isInteger(descendantPid) && processIsAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL")
    }
  }
})

test("does not execute an implicit repository-local engine during init", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-trust-"))
  await mkdir(join(fixtureRoot, ".git"))
  const engineDirectory = join(fixtureRoot, "build", "c-afsin")
  const marker = join(fixtureRoot, "repo-engine-executed")
  await mkdir(engineDirectory, { recursive: true })
  await writeFile(
    join(engineDirectory, "codebase-memory-mcp"),
    `#!/bin/sh
printf '%s' executed > '${marker}'
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
    *'"id":2'*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"indexed":true}}}' ; exit 0 ;;
  esac
done
`,
  )
  await chmod(join(engineDirectory, "codebase-memory-mcp"), 0o755)

  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", "init", "--json", "--root", fixtureRoot],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { HOME: join(fixtureRoot, "home"), PATH: "/usr/bin:/bin" },
    },
  )

  expect(result.exitCode).toBe(0)
  expect(await Bun.file(marker).exists()).toBe(false)
  const claudeConfig = await readFile(join(fixtureRoot, ".mcp.json"), "utf8")
  expect(claudeConfig).toContain('"skald-context"')
  expect(claudeConfig).not.toContain(join(engineDirectory, "codebase-memory-mcp"))
})

test("does not follow a raced parent directory symlink outside the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-engine-path-race-"))
  fixtureRoot = root
  const managedDirectory = join(root, "managed")
  const outsideDirectory = join(root, "outside")
  await mkdir(managedDirectory)
  await mkdir(outsideDirectory)

  const flip = (async () => {
    for (let index = 0; index < 500; index += 1) {
      await rm(managedDirectory, { force: true, recursive: true })
      try {
        await symlink(outsideDirectory, managedDirectory)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      await rm(managedDirectory, { force: true, recursive: true })
      try {
        await mkdir(managedDirectory)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
    }
  })()
  const writes = Promise.all(
    Array.from({ length: 500 }, (_, index) =>
      writeManagedFile(root, "managed/config.json", `payload-${index}`).catch(() => undefined),
    ),
  )
  await Promise.all([flip, writes])

  expect(await Bun.file(join(outsideDirectory, "config.json")).exists()).toBe(false)
})

test("rejects an oversized managed text write before creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-engine-write-limit-"))
  fixtureRoot = root
  const target = join(root, "managed", "config.json")

  await expect(
    writeManagedFile(root, "managed/config.json", "x".repeat(4 * 1024 * 1024 + 1)),
  ).rejects.toThrow("exceeds 4194304 bytes")
  expect(await Bun.file(target).exists()).toBe(false)
})

test("does not publish a partial newly created managed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "skald-engine-atomic-create-"))
  fixtureRoot = root
  const target = join(root, "managed", "config.json")
  const bytes = 3 * 1024 * 1024
  const modulePath = resolve(import.meta.dir, "../src/fs/safe-file.ts")
  const script = [
    `import { writeManagedFile } from ${JSON.stringify(modulePath)}`,
    `await writeManagedFile(${JSON.stringify(root)}, "managed/config.json", "x".repeat(${bytes}))`,
  ].join(";")
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "ignore",
    stderr: "ignore",
  })
  let interrupted = false
  try {
    while (child.exitCode === null) {
      const size = await fileSize(target)
      if (size !== undefined) {
        if (size !== bytes) {
          interrupted = true
          child.kill("SIGKILL")
        }
        break
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0))
    }
    expect(await child.exited).toBe(0)
    expect(interrupted).toBe(false)
    expect(await fileSize(target)).toBe(bytes)
    expect((await readdir(join(root, "managed"))).some((name) => name.endsWith(".tmp"))).toBe(false)
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
})
