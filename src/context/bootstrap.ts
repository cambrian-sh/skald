import { mkdtemp, readFile, rm } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import { currentSkaldServer, DEFAULT_CONTEXT_SERVER, type McpServerDefinition } from "../agents/mcp"
import {
  managedFileIsExecutable,
  readManagedFile,
  writeManagedBytes,
  writeManagedFile,
} from "../fs/safe-file"

export const CONTEXT_BOOTSTRAP_PATH = ".skald/context.md"
export const CONTEXT_RUNTIME_PATH = ".skald/context-runtime.mjs"
export const CONTEXT_RUNTIME_BINARY_PATH = ".skald/context-runtime"

const CONTEXT_BOOTSTRAP = `# Skald project context

Before changing code, retrieve relevant project context from the \`skald-context\` MCP server.
Use the backend graph for structural questions, and verify source files before relying on a
decision or observation. Treat stale or unknown knowledge as a lead that needs verification.

After a meaningful architectural discovery, record it explicitly as session knowledge with
the \`record_project_knowledge\` tool. Session knowledge is not canonical until a maintainer
reviews and promotes it.
`

export type BootstrapResult = {
  readonly path: string
  readonly action: "created" | "exists" | "would_create"
}

export type ContextRuntime = {
  readonly path: string
  readonly action: "created" | "updated" | "exists" | "would_create" | "unavailable"
  readonly server: McpServerDefinition
  readonly note?: string
}

type ContextRuntimePlan = {
  readonly runtime: ContextRuntime
  readonly contents?: string
  readonly binarySource?: string
}

function bunExecutable(): string {
  const executable = Bun.which("bun")
  if (executable !== undefined && executable !== null) return executable
  if (basename(process.execPath) === "bun" || basename(process.execPath) === "bun.exe") {
    return process.execPath
  }
  throw new Error("Project-local context runtime requires Bun")
}

function localContextServer(projectRoot: string): McpServerDefinition {
  return {
    command: bunExecutable(),
    args: [resolve(projectRoot, CONTEXT_RUNTIME_PATH), "serve"],
    serverName: "skald-context",
  }
}

function binaryContextServer(projectRoot: string): McpServerDefinition {
  return {
    command: resolve(projectRoot, CONTEXT_RUNTIME_BINARY_PATH),
    args: ["serve"],
    serverName: "skald-context",
  }
}

function isCompiledSkald(server: McpServerDefinition | undefined): boolean {
  const executableName = basename(process.execPath).toLowerCase()
  const isStandaloneExecutable = executableName !== "bun" && executableName !== "bun.exe"
  return (
    isStandaloneExecutable &&
    server !== undefined &&
    resolve(server.command) === resolve(process.execPath) &&
    ((server.args.length === 1 && server.args[0] === "serve") ||
      (server.args.length === 2 &&
        server.args[1] === "serve" &&
        server.args[0]?.startsWith("/$bunfs/") === true))
  )
}

async function bundledContextRuntime(): Promise<string | undefined> {
  const entrypoint = resolve(import.meta.dir, "../cli.ts")
  const outputDirectory = await mkdtemp(
    join(process.env["TMPDIR"] ?? "/tmp", "skald-context-build-"),
  )
  try {
    const build = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      format: "esm",
      outdir: outputDirectory,
      naming: "context-runtime.mjs",
      minify: true,
      sourcemap: "none",
      env: "disable",
    })
    if (!build.success) return undefined
    const output = build.outputs[0]
    return output === undefined ? undefined : await readFile(output.path, "utf8")
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
}

export async function prepareContextRuntime(
  projectRoot: string,
  dryRun: boolean,
): Promise<ContextRuntimePlan> {
  const existing = await readManagedFile(projectRoot, CONTEXT_RUNTIME_PATH)
  const binaryExists = await managedFileIsExecutable(projectRoot, CONTEXT_RUNTIME_BINARY_PATH)
  const currentServer = currentSkaldServer()
  const compiled = isCompiledSkald(currentServer)
  if (existing.exists && dryRun) {
    if (compiled) {
      return {
        runtime: {
          path: CONTEXT_RUNTIME_BINARY_PATH,
          action: binaryExists ? "exists" : "would_create",
          server: binaryContextServer(projectRoot),
        },
      }
    }
    return {
      runtime: {
        path: CONTEXT_RUNTIME_PATH,
        action: "exists",
        server: localContextServer(projectRoot),
      },
    }
  }
  if (dryRun) {
    if (compiled) {
      return {
        runtime: {
          path: CONTEXT_RUNTIME_BINARY_PATH,
          action: binaryExists ? "exists" : "would_create",
          server: binaryContextServer(projectRoot),
        },
      }
    }
    return {
      runtime: {
        path: CONTEXT_RUNTIME_PATH,
        action: "would_create",
        server: localContextServer(projectRoot),
      },
    }
  }
  let bundleError: string | undefined
  try {
    const contents = await bundledContextRuntime()
    if (contents !== undefined) {
      return {
        runtime: {
          path: CONTEXT_RUNTIME_PATH,
          action: existing.exists ? "updated" : "created",
          server: localContextServer(projectRoot),
        },
        contents,
      }
    }
  } catch (error) {
    bundleError = error instanceof Error ? error.message : String(error)
  }
  if (compiled && currentServer !== undefined) {
    return {
      runtime: {
        path: CONTEXT_RUNTIME_BINARY_PATH,
        action: binaryExists ? "exists" : "unavailable",
        server: binaryContextServer(projectRoot),
        ...(binaryExists || bundleError === undefined
          ? {}
          : {
              note: `Project-local bundling is unavailable; copying the standalone executable: ${bundleError}`,
            }),
      },
      ...(binaryExists ? {} : { binarySource: currentServer.command }),
    }
  }
  if (existing.exists) {
    return {
      runtime: {
        path: CONTEXT_RUNTIME_PATH,
        action: "exists",
        server: localContextServer(projectRoot),
        ...(bundleError === undefined
          ? {}
          : { note: `Could not refresh the project-local context runtime: ${bundleError}` }),
      },
    }
  }
  const fallback = currentServer
  const note =
    bundleError === undefined
      ? fallback === undefined
        ? "Could not create a project-local context runtime; the configured launcher must remain installed or cached."
        : "Project-local context bundling is unavailable; using the current Skald executable."
      : fallback === undefined
        ? `Could not create a project-local context runtime: ${bundleError}. The configured launcher must remain installed or cached.`
        : `Could not create a project-local context runtime: ${bundleError}. Using the current Skald executable.`
  return {
    runtime: {
      path: CONTEXT_RUNTIME_PATH,
      action: "unavailable",
      server: fallback ?? DEFAULT_CONTEXT_SERVER,
      note,
    },
  }
}

export async function publishContextRuntime(
  projectRoot: string,
  plan: ContextRuntimePlan,
): Promise<ContextRuntime> {
  if (plan.binarySource !== undefined) {
    const contents = await readFile(plan.binarySource)
    const result = await writeManagedBytes(
      projectRoot,
      CONTEXT_RUNTIME_BINARY_PATH,
      new Uint8Array(contents),
    )
    return {
      ...plan.runtime,
      action: result === "created" ? "created" : result === "updated" ? "updated" : "exists",
    }
  }
  if (plan.contents === undefined) return plan.runtime
  const result = await writeManagedFile(projectRoot, CONTEXT_RUNTIME_PATH, plan.contents)
  return {
    ...plan.runtime,
    action: result === "created" ? "created" : result === "updated" ? "updated" : "exists",
  }
}

export async function ensureContextBootstrap(
  projectRoot: string,
  dryRun: boolean,
): Promise<BootstrapResult> {
  const existing = await readManagedFile(projectRoot, CONTEXT_BOOTSTRAP_PATH)
  if (existing.exists) return { path: CONTEXT_BOOTSTRAP_PATH, action: "exists" }
  if (dryRun) return { path: CONTEXT_BOOTSTRAP_PATH, action: "would_create" }
  const result = await writeManagedFile(projectRoot, CONTEXT_BOOTSTRAP_PATH, CONTEXT_BOOTSTRAP)
  return {
    path: CONTEXT_BOOTSTRAP_PATH,
    action: result === "created" ? "created" : "exists",
  }
}
