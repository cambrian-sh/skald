import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")

setDefaultTimeout(60_000)

function runBun(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("packaged runtime closed before responding")
      buffer += decoder.decode(chunk.value, { stream: true })
      const newline = buffer.indexOf("\n")
      if (newline >= 0) return buffer.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}

test("published package exposes a durable CLI and project runtime", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "skald-package-consumer-"))
  const consumer = join(packageRoot, "consumer")
  const project = join(consumer, "project")
  const trust = join(packageRoot, "trust")
  await mkdir(consumer)
  await mkdir(join(project, ".git"), { recursive: true })
  try {
    const packed = runBun(["pm", "pack", "--destination", packageRoot], projectRoot)
    expect(packed.exitCode).toBe(0)
    const archiveName = (await readdir(packageRoot)).find((name) => name.endsWith(".tgz"))
    expect(archiveName).toBeDefined()
    if (archiveName === undefined) throw new Error("package archive was not created")

    const installed = runBun(["add", `file:${join(packageRoot, archiveName)}`], consumer)
    expect(installed.exitCode).toBe(0)

    const version = runBun(["x", "--no-install", "skald", "--version"], consumer)
    expect(version.exitCode).toBe(0)
    expect(new TextDecoder().decode(version.stdout).trim()).toBe("0.1.0")

    const initialized = runBun(
      [
        "x",
        "--no-install",
        "skald",
        "init",
        "--no-index",
        "--agents",
        "claude",
        "--root",
        project,
        "--json",
      ],
      consumer,
      { ...process.env, SKALD_TRUST_DIRECTORY: trust },
    )
    expect(initialized.exitCode).toBe(0)
    const report = JSON.parse(new TextDecoder().decode(initialized.stdout)) as {
      readonly contextRuntime?: { readonly path?: string }
    }
    expect(report.contextRuntime?.path).toBe(".skald/context-runtime.mjs")

    const runtime = Bun.spawn([process.execPath, ".skald/context-runtime.mjs", "serve"], {
      cwd: project,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      if (typeof runtime.stdin !== "object" || runtime.stdin === null) {
        throw new Error("packaged runtime stdin is unavailable")
      }
      if (typeof runtime.stdout !== "object" || runtime.stdout === null) {
        throw new Error("packaged runtime stdout is unavailable")
      }
      await runtime.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
      )
      const response = JSON.parse(await firstLine(runtime.stdout)) as {
        readonly result?: { readonly protocolVersion?: string }
      }
      expect(response.result?.protocolVersion).toBe("2025-06-18")
    } finally {
      runtime.kill("SIGTERM")
      await runtime.exited
    }

    expect(await readFile(join(project, ".skald", "context-runtime.mjs"), "utf8")).toContain(
      "skald-context",
    )
  } finally {
    await rm(packageRoot, { force: true, recursive: true })
  }
})
