import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureAgentMcpConfig } from "../src/agents/mcp"
import { ensureConfig } from "../src/config"
import { buildContextBundle, handleMcpRequest } from "../src/context/server"
import { diagnoseProject } from "../src/doctor"
import { mcpExecutableSha256 } from "../src/engine"
import { recordKnowledge } from "../src/knowledge/store"
import { readProjectState, recordProjectIndex } from "../src/project/state"
import { trustMcpExecutable } from "../src/trust"

let fixtureRoot: string | undefined
let externalKnowledgeRoot: string | undefined
const originalTrustDirectory = process.env["SKALD_TRUST_DIRECTORY"]
const originalKnowledgeDirectory = process.env["CBM_KNOWLEDGE_DIR"]

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
  if (externalKnowledgeRoot !== undefined) {
    await rm(externalKnowledgeRoot, { force: true, recursive: true })
    externalKnowledgeRoot = undefined
  }
  if (originalTrustDirectory === undefined) delete process.env["SKALD_TRUST_DIRECTORY"]
  else process.env["SKALD_TRUST_DIRECTORY"] = originalTrustDirectory
  if (originalKnowledgeDirectory === undefined) delete process.env["CBM_KNOWLEDGE_DIR"]
  else process.env["CBM_KNOWLEDGE_DIR"] = originalKnowledgeDirectory
})

test("returns source content and configured Cambrian knowledge", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-"))
  await mkdir(join(fixtureRoot, ".git"))
  await mkdir(join(fixtureRoot, ".skills", "review"), { recursive: true })
  await writeFile(join(fixtureRoot, "AGENTS.md"), "Always verify architecture before editing.")
  await writeFile(
    join(fixtureRoot, ".skills", "review", "SKILL.md"),
    "Review changed behavior and tests.",
  )
  const knowledgeRoot = join(await realpath(fixtureRoot), "cambrian-knowledge")
  await mkdir(join(knowledgeRoot, "adrs"), { recursive: true })
  await writeFile(
    join(knowledgeRoot, "adrs", "ADR-001.md"),
    '---\ntitle: "MCP is the boundary"\nlast_verified: 2026-09-11\nverified_at_rev:\n  core: "abc123"\n---\n\nUse MCP instead of direct database access.\n',
  )
  await writeFile(
    join(fixtureRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "codebase-memory-mcp": {
          command: "/opt/cambrian/codebase-memory-mcp",
          env: { CBM_KNOWLEDGE_DIR: knowledgeRoot },
        },
      },
    }),
  )
  await recordKnowledge(fixtureRoot, {
    kind: "observation",
    title: "Session discovery remains visible",
    summary: "A session observation must remain available when canonical knowledge is external.",
  })

  const canonicalFixtureRoot = await realpath(fixtureRoot)
  const bundle = await buildContextBundle(canonicalFixtureRoot)
  const doctor = await diagnoseProject(canonicalFixtureRoot)

  expect(
    bundle.items.some(
      (item) => item.kind === "instruction" && item.summary.includes("verify architecture"),
    ),
  ).toBe(true)
  expect(
    bundle.items.some((item) => item.kind === "knowledge" && item.title === "MCP is the boundary"),
  ).toBe(true)
  expect(
    bundle.items.some(
      (item) => item.kind === "knowledge" && item.title === "Session discovery remains visible",
    ),
  ).toBe(true)
  expect(doctor.knowledge.entries).toBe(2)
  expect(bundle.items.every((item) => item.sourceRefs.length > 0)).toBe(true)
})

test("adds relevant structural graph context from the configured backend", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-graph-"))
  await mkdir(join(fixtureRoot, ".git"))
  const fakeBackend = join(fixtureRoot, "fake-backend.sh")
  await writeFile(
    fakeBackend,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *initialize*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}' ;;
    *list_projects*)
        printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"projects":[{"name":"fixture","root_path":"${fixtureRoot}"}]}}}'
      ;;
    *'"method":"tools/list"'*)
        printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"search_code"}]}}'
      ;;
    *search_code*)
        printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"rows":[{"name":"resolveMcpServer","file":"src/engine.ts"}],"total_results":1}}}'
      ;;
  esac
done
`,
  )
  await chmod(fakeBackend, 0o755)
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, ".trust")
  await trustMcpExecutable(fixtureRoot, {
    command: fakeBackend,
    args: [],
    sha256: await mcpExecutableSha256(fakeBackend),
  })
  await writeFile(
    join(fixtureRoot, ".mcp.json"),
    `${JSON.stringify({ mcpServers: { skald: { command: fakeBackend, args: [] } } })}\n`,
  )
  await ensureConfig(fixtureRoot, false, { command: fakeBackend, args: [], trust: "explicit" })

  const bundle = await buildContextBundle(fixtureRoot, "resolver")

  const graph = bundle.items.find((item) => item.kind === "architecture")
  expect(graph?.title).toBe("Code graph matches: resolver")
  expect(graph?.summary).toContain("resolveMcpServer")
  expect(bundle.warnings).not.toContain("Backend context unavailable: this project is not indexed")
})

test("does not read an untrusted external knowledge directory", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-external-"))
  externalKnowledgeRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-external-"))
  await mkdir(join(fixtureRoot, ".git"))
  await mkdir(join(externalKnowledgeRoot, "adrs"), { recursive: true })
  await writeFile(
    join(externalKnowledgeRoot, "adrs", "ADR-EXTERNAL.md"),
    "---\ntitle: External secret\n---\n\nThis must not be loaded.\n",
  )
  delete process.env["CBM_KNOWLEDGE_DIR"]
  await ensureConfig(fixtureRoot, false, {
    command: "/opt/cambrian/codebase-memory-mcp",
    args: [],
    env: { CBM_KNOWLEDGE_DIR: externalKnowledgeRoot },
  })

  const bundle = await buildContextBundle(fixtureRoot)

  expect(bundle.items.some((item) => item.title === "External secret")).toBe(false)
  expect(bundle.warnings.some((warning) => warning.includes("not trusted"))).toBe(true)
})

test("serves context and records session knowledge over MCP", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-mcp-"))
  await mkdir(join(fixtureRoot, ".git"))

  const initialized = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  })
  expect(initialized?.result).toBeDefined()

  const listed = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  })
  if (listed === undefined) throw new Error("tools/list did not return a response")
  const tools = (listed.result as { tools: readonly { name: string }[] }).tools
  expect(tools.map((tool) => tool.name)).toEqual([
    "project_context",
    "project_refresh",
    "project_doctor",
    "record_project_knowledge",
    "project_knowledge_audit",
  ])

  const audited = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "project_knowledge_audit", arguments: {} },
  })
  if (audited === undefined) throw new Error("project_knowledge_audit did not return a response")
  const auditText = (audited.result as { content: readonly [{ text: string }] }).content[0].text
  expect(JSON.parse(auditText)).toHaveProperty("issues")

  const recorded = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "record_project_knowledge",
      arguments: {
        kind: "observation",
        title: "Context is explicit",
        summary: "Agents should record discoveries instead of relying on chat history.",
      },
    },
  })
  if (recorded === undefined) throw new Error("record_project_knowledge did not return a response")
  const text = (recorded.result as { content: readonly [{ text: string }] }).content[0].text
  expect(JSON.parse(text)).toMatchObject({ kind: "observation", authority: "session" })
  expect(text).toContain("investigations")
})

test("returns standard JSON-RPC error codes for invalid requests", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-errors-"))
  await mkdir(join(fixtureRoot, ".git"))

  const unknown = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 1,
    method: "unknown/method",
  })
  const invalidTool = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {},
  })

  expect(unknown?.error?.code).toBe(-32601)
  expect(invalidTool?.error?.code).toBe(-32602)
  expect((await handleMcpRequest(fixtureRoot, { id: 3, method: "ping" }))?.error?.code).toBe(-32600)
  expect((await handleMcpRequest(fixtureRoot, { jsonrpc: "2.0", id: 4 }))?.error?.code).toBe(-32600)
})

test("refreshes the trusted backend and records the project state", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-refresh-"))
  await mkdir(join(fixtureRoot, ".git"))
  const fakeBackend = join(fixtureRoot, "fake-backend.sh")
  await writeFile(
    fakeBackend,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *'"id":2'*)
      case "$line" in
        *list_projects*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"projects":[{"name":"fixture","root_path":"${fixtureRoot}"}]}}}' ;;
        *) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"project":"fixture","status":"indexed"}}}' ;;
      esac
      exit 0
      ;;
  esac
done
`,
  )
  await chmod(fakeBackend, 0o755)
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, ".trust")
  await trustMcpExecutable(fixtureRoot, {
    command: fakeBackend,
    args: [],
    sha256: await mcpExecutableSha256(fakeBackend),
  })
  await ensureConfig(fixtureRoot, false, {
    command: fakeBackend,
    args: [],
    trust: "explicit",
  })

  const response = await handleMcpRequest(fixtureRoot, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "project_refresh", arguments: { mode: "fast" } },
  })
  if (response === undefined) throw new Error("project_refresh did not return a response")
  const text = (response.result as { content: readonly [{ text: string }] }).content[0].text
  expect(JSON.parse(text)).toMatchObject({ status: "unknown", workingTree: "unknown" })
  expect(await Bun.file(join(fixtureRoot, ".skald", "state.json")).exists()).toBe(true)
})

test("automatically refreshes a stale trusted index before context retrieval", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-auto-refresh-"))
  const git = (args: readonly string[]) =>
    Bun.spawnSync(["git", "-C", fixtureRoot as string, ...args], {
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
  await writeFile(join(fixtureRoot, "tracked.txt"), "initial\n")
  expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)

  const marker = join(fixtureRoot, "refreshed")
  const fakeBackend = join(fixtureRoot, "fake-backend.sh")
  await writeFile(
    fakeBackend,
    `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *initialize*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *index_repository*) printf '%s' refreshed > '${marker}'; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"project":"fixture","status":"indexed"}}}' ;;
    *list_projects*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"projects":[{"name":"fixture","root_path":"${fixtureRoot}"}]}}}' ;;
    *tools/list*) printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}' ;;
  esac
done
`,
  )
  await chmod(fakeBackend, 0o755)
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, ".trust")
  const server = {
    command: fakeBackend,
    args: [] as const,
    trust: "explicit" as const,
    sha256: await mcpExecutableSha256(fakeBackend),
  }
  await trustMcpExecutable(fixtureRoot, server)
  await ensureConfig(fixtureRoot, false, server)
  await recordProjectIndex(fixtureRoot, server, "fast", "indexed", "fixture")
  expect(git(["add", "-A"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "setup"]).exitCode).toBe(0)
  await writeFile(join(fixtureRoot, "tracked.txt"), "changed\n")
  expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "changed"]).exitCode).toBe(0)

  const bundle = await buildContextBundle(fixtureRoot)
  const state = await readProjectState(fixtureRoot)

  expect(await Bun.file(marker).exists()).toBe(true)
  expect(bundle.warnings).toContain(
    "Structural index automatically refreshed before context retrieval",
  )
  expect(state.state?.index?.indexedAt).toBeDefined()
  expect(state.state?.runs?.[0]?.trigger).toBe("automatic")
})

test("does not repeatedly auto-refresh a dirty working tree", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-dirty-no-thrash-"))
  const git = (args: readonly string[]) =>
    Bun.spawnSync(["git", "-C", fixtureRoot as string, ...args], {
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
  await writeFile(join(fixtureRoot, "tracked.txt"), "initial\n")
  expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
  expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)

  const refreshMarker = join(fixtureRoot, "refresh-count")
  const fakeBackend = join(fixtureRoot, "fake-backend.sh")
  await writeFile(
    fakeBackend,
    `#!/bin/sh
count=0
if [ -f '${refreshMarker}' ]; then count=$(cat '${refreshMarker}'); fi
while IFS= read -r line; do
  case "$line" in
    *initialize*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *index_repository*) count=$((count + 1)); printf '%s' "$count" > '${refreshMarker}'; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"project":"fixture","status":"indexed"}}}' ;;
    *list_projects*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"projects":[{"name":"fixture","root_path":"${fixtureRoot}"}]}}}' ;;
    *tools/list*) printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}' ;;
  esac
done
`,
  )
  await chmod(fakeBackend, 0o755)
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, ".trust")
  const server = {
    command: fakeBackend,
    args: [] as const,
    trust: "explicit" as const,
    sha256: await mcpExecutableSha256(fakeBackend),
  }
  await trustMcpExecutable(fixtureRoot, server)
  await ensureConfig(fixtureRoot, false, server)
  await recordProjectIndex(fixtureRoot, server, "fast", "indexed", "fixture")
  await writeFile(join(fixtureRoot, "tracked.txt"), "changed\n")

  const first = await buildContextBundle(fixtureRoot)
  const second = await buildContextBundle(fixtureRoot)
  const marker = await Bun.file(refreshMarker)
    .text()
    .catch(() => "0")

  expect(marker).toBe("0")
  expect(first.warnings).toContain(
    "Automatic structural refresh skipped while the working tree has uncommitted changes; use project_refresh explicitly",
  )
  expect(second.warnings).toContain(
    "Automatic structural refresh skipped while the working tree has uncommitted changes; use project_refresh explicitly",
  )
})

test("reports unreadable discovered guidance instead of generic success", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-guidance-warning-"))
  await mkdir(join(fixtureRoot, ".git"))
  await writeFile(join(fixtureRoot, "AGENTS.md"), "#".repeat(4 * 1024 * 1024 + 1))

  const bundle = await buildContextBundle(fixtureRoot)

  expect(bundle.items).toHaveLength(1)
  expect(bundle.items[0]?.summary).toContain("Project instruction source")
  expect(bundle.warnings.some((warning) => warning.includes("AGENTS.md"))).toBe(true)
})

test("degrades context when a pinned backend binary changes", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-integrity-"))
  await mkdir(join(fixtureRoot, ".git"))
  const backend = join(fixtureRoot, "backend.sh")
  await writeFile(backend, "#!/bin/sh\nprintf '%s\\n' changed\n")
  await chmod(backend, 0o755)
  const originalDigest = await mcpExecutableSha256(backend)
  await writeFile(backend, "#!/bin/sh\nprintf '%s\\n' replaced\n")

  await ensureConfig(fixtureRoot, false, {
    command: backend,
    args: [],
    sha256: originalDigest,
  })
  await ensureAgentMcpConfig(
    fixtureRoot,
    "claude",
    {
      command: backend,
      args: [],
    },
    false,
  )

  const bundle = await buildContextBundle(fixtureRoot)

  expect(bundle.items).toHaveLength(0)
  expect(bundle.warnings.some((warning) => warning.includes("integrity"))).toBe(true)
})

test("does not treat a repository manifest trust flag as user authorization", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-context-manifest-trust-"))
  await mkdir(join(fixtureRoot, ".git"))
  const backend = join(fixtureRoot, "backend.sh")
  const marker = join(fixtureRoot, "executed")
  await writeFile(backend, ["#!/bin/sh", `printf '%s' executed > '${marker}'`, ""].join("\n"))
  await chmod(backend, 0o755)
  process.env["SKALD_TRUST_DIRECTORY"] = join(fixtureRoot, ".trust")
  await ensureConfig(fixtureRoot, false, {
    command: backend,
    args: [],
    trust: "explicit",
    sha256: await mcpExecutableSha256(backend),
  })

  const bundle = await buildContextBundle(fixtureRoot)

  expect(await Bun.file(marker).exists()).toBe(false)
  expect(bundle.warnings.some((warning) => warning.includes("requires explicit trust"))).toBe(true)
})
