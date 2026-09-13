import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  conformMcpEngine,
  indexResponseStatus,
  locateMcpEngine,
  probeMcpEngine,
  resolveExecutableMcpServer,
  runMcpTool,
} from "../src/engine"
import { defaultManagedEnginePackage, installManagedEngine } from "../src/engine/distribution"
import {
  defaultProjectEngineServer,
  installProjectEngine,
  PROJECT_ENGINE_PATH,
  projectEngineEnvironment,
  projectEngineRuntimeDirectory,
} from "../src/engine/project"
import { EngineIntegrityError } from "../src/errors"

let fixtureRoot: string | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("locates a project-local Cambrian engine before using PATH", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-"))
  const enginePath = join(fixtureRoot, "build", "c-afsin", "codebase-memory-mcp")
  await mkdir(join(fixtureRoot, "build", "c-afsin"), { recursive: true })
  await writeFile(enginePath, "#!/bin/sh\n")
  await chmod(enginePath, 0o755)

  const result = await locateMcpEngine(fixtureRoot, "codebase-memory-mcp")

  expect(result).toBe(enginePath)
})

test("uses the Afşin engine and all engine state from the project boundary", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-project-engine-"))
  const source = join(fixtureRoot, "afsin-engine")
  await writeFile(source, "#!/bin/sh\n")
  await chmod(source, 0o755)

  const server = defaultProjectEngineServer(fixtureRoot)
  const environment = projectEngineEnvironment(fixtureRoot)
  const installed = await installProjectEngine(fixtureRoot, { source })

  expect(server.command).toBe(join(fixtureRoot, PROJECT_ENGINE_PATH))
  expect(environment["CBM_KNOWLEDGE_DIR"]).toBe(join(fixtureRoot, ".skald", "knowledge"))
  expect(environment["CBM_CACHE_DIR"]).toBe(join(fixtureRoot, ".skald", "engine", "cache"))
  expect(installed.channel).toBe("afsin")
  expect(installed.commit).toBe("cf1d310a72320ec55e7b86a091561162567e55d2")
  expect(await readFile(installed.path, "utf8")).toBe("#!/bin/sh\n")
})

test("rejects an engine whose trusted digest no longer matches", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-integrity-"))
  const enginePath = join(fixtureRoot, "engine")
  await writeFile(enginePath, "#!/bin/sh\n")
  await chmod(enginePath, 0o755)

  await expect(
    resolveExecutableMcpServer(
      fixtureRoot,
      { command: enginePath, args: [], trust: "explicit", sha256: "0".repeat(64) },
      true,
    ),
  ).rejects.toBeInstanceOf(EngineIntegrityError)
})

test("marks incomplete backend coverage as degraded", () => {
  expect(indexResponseStatus({ status: "indexed" })).toBe("indexed")
  expect(indexResponseStatus({ skipped: { count: 2 } })).toBe("degraded")
  expect(indexResponseStatus({ parse_partial: [{ path: "src/parser.ts" }] })).toBe("degraded")
  expect(indexResponseStatus({ skipped_count: 1, parse_partial_count: 0 })).toBe("degraded")
})

test("requires the indexing and retrieval MCP contract", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-contract-"))
  const enginePath = join(fixtureRoot, "engine.sh")
  await writeFile(
    enginePath,
    `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *'"id":2'*list_projects*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"projects":[]}}}' ;;
    *'"id":3'*tools/list*) printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"list_projects"},{"name":"index_repository"},{"name":"search_graph"}]}}' ;;
  esac
done
`,
  )
  await chmod(enginePath, 0o755)

  const result = await probeMcpEngine(fixtureRoot, { command: enginePath, args: [] })

  expect(result.available).toBe(true)
  expect(result.compatible).toBe(true)
  expect(result.missingTools).toEqual([])
  expect(result.tools).toContain("search_graph")
})

test("checks the complete Afşin tool and required-input contract", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-engine-afsin-contract-"))
  const enginePath = join(fixtureRoot, "engine.sh")
  const required: Record<string, readonly string[]> = {
    index_repository: ["repo_path"],
    search_graph: ["project"],
    query_graph: ["query", "project"],
    trace_path: ["function_name", "project"],
    get_code_snippet: ["qualified_name", "project"],
    get_graph_schema: ["project"],
    compare_graphs: ["base_project", "target_project"],
    get_architecture: ["project"],
    search_code: ["pattern", "project"],
    list_projects: [],
    delete_project: ["project"],
    index_status: ["project"],
    check_index_coverage: ["project"],
    detect_changes: ["project"],
    manage_adr: ["project"],
    ingest_traces: ["traces", "project"],
  }
  const catalog = JSON.stringify({
    tools: Object.entries(required).map(([name, fields]) => ({
      name,
      inputSchema: { type: "object", required: fields },
    })),
  })
  const response = (id: number, result: string): string =>
    JSON.stringify({ jsonrpc: "2.0", id, result: JSON.parse(result) })
  await writeFile(
    enginePath,
    `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '${response(1, '{"protocolVersion":"2025-06-18"}')}' ;;
    *'"id":2'*list_projects*) printf '%s\\n' '${response(2, '{"projects":[]}')}' ;;
    *'"id":3'*tools/list*) printf '%s\\n' '${JSON.stringify({ jsonrpc: "2.0", id: 3, result: JSON.parse(catalog) })}' ;;
    *'"id":2'*tools/list*) printf '%s\\n' '${JSON.stringify({ jsonrpc: "2.0", id: 2, result: JSON.parse(catalog) })}' ;;
  esac
done
`,
  )
  await chmod(enginePath, 0o755)

  const result = await conformMcpEngine(fixtureRoot, { command: enginePath, args: [] })

  expect(result.compatible).toBe(true)
  expect(result.missingTools).toEqual([])
  expect(result.schemaFailures).toEqual([])
  expect(result.unexpectedTools).toEqual([])
})

test("uses an immutable managed engine release by default", async () => {
  expect(defaultManagedEnginePackage()).toBe("codebase-memory-mcp@0.10.8")
  await expect(installManagedEngine({ packageSpec: "codebase-memory-mcp@latest" })).rejects.toThrow(
    "exact version",
  )
  await expect(installManagedEngine({ packageSpec: "codebase-memory-mcp@0.10.7" })).rejects.toThrow(
    "No verified release metadata",
  )
})

test("gives Afşin's engine a short project-scoped runtime rendezvous", async () => {
  fixtureRoot = await mkdtemp("/tmp/skald-engine-runtime-")
  const enginePath = join(fixtureRoot, "build", "c-afsin", "codebase-memory-mcp")
  await mkdir(join(fixtureRoot, "build", "c-afsin"), { recursive: true })
  await writeFile(
    enginePath,
    `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *'"id":2'*) printf '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"runtime":"%s"}}}\\n' "$CBM_RUNTIME_DIR"; exit 0 ;;
  esac
done
`,
  )
  await chmod(enginePath, 0o755)
  const inheritedRuntime = process.env["CBM_RUNTIME_DIR"]
  delete process.env["CBM_RUNTIME_DIR"]
  try {
    const result = await runMcpTool(fixtureRoot, { command: enginePath, args: [] }, "probe")
    const response = result.response
    const runtime = isRecord(response) ? response["runtime"] : undefined

    expect(result.exitCode).toBe(0)
    expect(typeof runtime).toBe("string")
    expect(runtime).toBe(projectEngineRuntimeDirectory(fixtureRoot))
    if (typeof runtime === "string") await rm(runtime, { force: true, recursive: true })
  } finally {
    if (inheritedRuntime === undefined) delete process.env["CBM_RUNTIME_DIR"]
    else process.env["CBM_RUNTIME_DIR"] = inheritedRuntime
  }
})

test("moves only oversized project runtimes to a short private rendezvous", () => {
  const longProjectRoot = `/tmp/${"deep-project-path/".repeat(12)}project`
  const runtime = projectEngineRuntimeDirectory(longProjectRoot)

  expect(runtime).not.toBe(join(longProjectRoot, ".skald", "r"))
  expect(runtime).toContain("skald-")
  expect(new TextEncoder().encode(runtime).byteLength).toBeLessThan(64)
})
