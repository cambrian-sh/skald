import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runKnowledgeCommand } from "../src/cli/context"
import { ensureConfig } from "../src/config"
import { mcpExecutableSha256 } from "../src/engine"
import { ensureKnowledgeSyncHooks } from "../src/knowledge/hooks"
import { reconcileKnowledge, syncKnowledge } from "../src/knowledge/reconcile"
import { trustMcpExecutable } from "../src/trust"

let fixtureRoot: string | undefined
const testTrustDirectory = join(
  await realpath(tmpdir()),
  `skald-knowledge-reconcile-trust-${process.pid}`,
)
process.env["SKALD_TRUST_DIRECTORY"] = testTrustDirectory

function git(args: readonly string[]) {
  return Bun.spawnSync(["git", "-C", fixtureRoot as string, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Skald Test",
      GIT_AUTHOR_EMAIL: "skald-test@example.invalid",
      GIT_COMMITTER_NAME: "Skald Test",
      GIT_COMMITTER_EMAIL: "skald-test@example.invalid",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function setupRepository(): Promise<{ readonly root: string; readonly knowledge: string }> {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-knowledge-reconcile-"))
  const root = fixtureRoot
  const knowledge = join(root, "knowledge")
  await mkdir(join(knowledge, "adrs"), { recursive: true })
  expect(git(["init", "-q"]).exitCode).toBe(0)
  await writeFile(join(root, "tracked.txt"), "initial\n")
  return { root, knowledge }
}

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

afterAll(async () => {
  await rm(testTrustDirectory, { force: true, recursive: true })
})

describe("knowledge reconciliation", () => {
  test("detects broken supersession chains and duplicate identifiers", async () => {
    const { root, knowledge } = await setupRepository()
    await writeFile(
      join(knowledge, "adrs", "old.md"),
      "---\nid: '0001'\ntitle: Old\nstatus: superseded\nsuperseded_by: '9999'\n---\n\nOld.\n",
    )
    await writeFile(
      join(knowledge, "adrs", "duplicate.md"),
      "---\nid: '0001'\ntitle: Duplicate\nstatus: active\n---\n\nDuplicate.\n",
    )
    const report = await reconcileKnowledge(root, knowledge)

    expect(report.status).toBe("fail")
    expect(report.issues.some((issue) => issue.code === "duplicate_identifier")).toBe(true)
    expect(report.issues.some((issue) => issue.code === "missing_supersession_target")).toBe(true)
  })

  test("syncs an anchored artifact only after the artifact changes", async () => {
    const { root, knowledge } = await setupRepository()
    expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)
    const oldRevision = new TextDecoder().decode(git(["rev-parse", "HEAD"]).stdout).trim()
    await writeFile(
      join(knowledge, "adrs", "tracked.md"),
      `---\nid: '0002'\ntitle: Tracked\nstatus: implemented\norigin: [project]\nverified_at_rev: "${oldRevision.slice(0, 7)}"\nartifacts:\n  - name: tracked.txt\n---\n\nTracked.\n`,
    )
    expect(git(["add", "."]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "knowledge"]).exitCode).toBe(0)
    await writeFile(join(root, "tracked.txt"), "changed\n")
    expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "change"]).exitCode).toBe(0)

    const check = await syncKnowledge(root, knowledge)
    expect(check.checkOnly).toBe(true)
    expect(check.stale).toContain("knowledge/adrs/tracked.md")

    const synced = await syncKnowledge(root, knowledge, [], true)
    expect(synced.updated).toContain("knowledge/adrs/tracked.md")
    const contents = await readFile(join(knowledge, "adrs", "tracked.md"), "utf8")
    const currentRevision = new TextDecoder().decode(git(["rev-parse", "HEAD"]).stdout).trim()
    expect(contents).toContain(`project: "${currentRevision}"`)
  })

  test("installs an idempotent post-commit sync hook without replacing existing content", async () => {
    const { root, knowledge } = await setupRepository()
    const hooks = join(root, ".git", "hooks")
    const hookPath = join(hooks, "post-commit")
    await writeFile(hookPath, "#!/bin/sh\nexisting-hook\n")
    expect(Bun.spawnSync(["git", "-C", knowledge, "init", "-q"]).exitCode).toBe(0)

    const first = await ensureKnowledgeSyncHooks(
      root,
      knowledge,
      { command: "/usr/bin/bun", args: ["/tmp/context-runtime.mjs", "serve"] },
      false,
      [{ origin: "project", path: root }],
    )
    const second = await ensureKnowledgeSyncHooks(
      root,
      knowledge,
      { command: "/usr/bin/bun", args: ["/tmp/context-runtime.mjs", "serve"] },
      false,
      [{ origin: "project", path: root }],
    )
    const contents = await readFile(hookPath, "utf8")
    const knowledgeHook = join(knowledge, ".git", "hooks", "post-commit")
    const knowledgeContents = await readFile(knowledgeHook, "utf8")
    const mode = (await stat(hookPath)).mode & 0o777

    expect(first.find((hook) => hook.repository === root)?.action).toBe("updated")
    expect(second.find((hook) => hook.repository === root)?.action).toBe("exists")
    expect(contents).toContain("existing-hook")
    expect(contents.match(/# skald-knowledge-sync/g)?.length).toBe(1)
    expect(contents).toContain("knowledge sync --write")
    expect(knowledgeContents).toContain("knowledge index --write")
    expect(mode).toBe(0o700)
  })

  test("carries Cambrian evidence-based status upgrades into the sync report", async () => {
    const { root, knowledge } = await setupRepository()
    await writeFile(
      join(knowledge, "adrs", "upgrade.md"),
      "---\nid: '0003'\ntitle: Upgrade\nstatus: accepted\ngate_passed: true\n---\n\nUpgrade.\n",
    )

    const check = await syncKnowledge(root, knowledge)
    expect(check.upgraded).toContain("knowledge/adrs/upgrade.md")

    const synced = await syncKnowledge(root, knowledge, [], true)
    expect(synced.upgraded).toContain("knowledge/adrs/upgrade.md")
    expect(await readFile(join(knowledge, "adrs", "upgrade.md"), "utf8")).toContain(
      "status: implemented",
    )
  })

  test("runs the knowledge index lane through sync and the configured backend", async () => {
    const { root, knowledge } = await setupRepository()
    expect(git(["add", "tracked.txt"]).exitCode).toBe(0)
    expect(git(["commit", "-qm", "initial"]).exitCode).toBe(0)
    await writeFile(
      join(knowledge, "adrs", "index.md"),
      "---\nid: '0004'\ntitle: Index\nstatus: accepted\ngate_passed: true\n---\n\nIndex.\n",
    )
    const backend = join(root, "backend.sh")
    await writeFile(
      backend,
      `#!/bin/sh
while IFS= read -r request; do
  case "$request" in
    *'"id":1'*) printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}' ;;
    *'"id":2'*) printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"project":"fixture","status":"indexed"}}}'; exit 0 ;;
  esac
done
`,
    )
    await chmod(backend, 0o755)
    const sha256 = await mcpExecutableSha256(backend)
    await trustMcpExecutable(await realpath(root), { command: backend, args: [], sha256 })
    await ensureConfig(root, false, { command: backend, args: [], trust: "explicit", sha256 })

    const status = await runKnowledgeCommand({
      kind: "knowledge-index",
      root,
      knowledgeDirectory: knowledge,
      repositories: [],
      write: true,
      json: false,
      mode: "fast",
    })

    expect(status).toBe(0)
    expect(await readFile(join(knowledge, "adrs", "index.md"), "utf8")).toContain(
      "status: implemented",
    )
  })
})
