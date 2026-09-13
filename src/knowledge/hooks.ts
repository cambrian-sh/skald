import { relative, resolve, sep } from "node:path"
import type { McpServerDefinition } from "../agents/mcp"
import { readManagedFile, writeManagedBytes } from "../fs/safe-file"
import { discoverKnowledgeRepositories, type KnowledgeRepository } from "./reconcile"

const HOOK_MARKER = "# skald-knowledge-sync"

export type KnowledgeHookResult = {
  readonly repository: string
  readonly path: string
  readonly action: "created" | "updated" | "exists" | "would_create" | "would_update" | "skipped"
  readonly note?: string
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function runtimeArguments(
  contextServer: McpServerDefinition,
  projectRoot: string,
  knowledgeRoot: string,
  repositories: readonly KnowledgeRepository[],
  operation: "sync" | "index",
): string {
  const args = [...contextServer.args]
  const serveIndex = args.lastIndexOf("serve")
  if (serveIndex >= 0) args.splice(serveIndex, 1)
  args.push(
    "knowledge",
    operation,
    "--write",
    "--root",
    resolve(projectRoot),
    "--knowledge-dir",
    resolve(knowledgeRoot),
  )
  for (const repository of repositories) {
    args.push("--repo", `${repository.origin}=${resolve(repository.path)}`)
  }
  return [contextServer.command, ...args].map(shellWord).join(" ")
}

async function gitHooksDirectory(repository: string): Promise<string | undefined> {
  const result = Bun.spawnSync(["git", "-C", repository, "rev-parse", "--git-path", "hooks"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return undefined
  const value = new TextDecoder().decode(result.stdout).trim()
  return value.length === 0 ? undefined : resolve(repository, value)
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`))
}

export async function ensureKnowledgeSyncHooks(
  projectRoot: string,
  knowledgeRoot: string,
  contextServer: McpServerDefinition,
  dryRun: boolean,
  explicitRepositories: readonly KnowledgeRepository[] = [],
): Promise<readonly KnowledgeHookResult[]> {
  const repositories = await discoverKnowledgeRepositories(
    projectRoot,
    knowledgeRoot,
    explicitRepositories,
  )
  const uniqueRepositories = [
    ...new Map(repositories.map((repository) => [resolve(repository.path), repository])).values(),
  ]
  const results: KnowledgeHookResult[] = []
  for (const repository of uniqueRepositories) {
    const hooksDirectory = await gitHooksDirectory(repository.path)
    if (hooksDirectory === undefined || !isWithin(repository.path, hooksDirectory)) {
      results.push({
        repository: repository.path,
        path: ".git/hooks/post-commit",
        action: "skipped",
        note: "Git uses a hooks directory outside this repository; Skald did not write it",
      })
      continue
    }
    const operation = resolve(repository.path) === resolve(knowledgeRoot) ? "index" : "sync"
    const command = runtimeArguments(
      contextServer,
      projectRoot,
      knowledgeRoot,
      repositories,
      operation,
    )
    const hookPath = resolve(hooksDirectory, "post-commit")
    const relativeHookPath = relative(repository.path, hookPath)
    const existing = await readManagedFile(repository.path, relativeHookPath)
    if (existing.exists && (existing.contents ?? "").includes(HOOK_MARKER)) {
      results.push({ repository: repository.path, path: relativeHookPath, action: "exists" })
      continue
    }
    const block = `${HOOK_MARKER}\n${command} >/dev/null 2>&1 || true\n`
    const current = existing.contents?.replace(/\s*$/, "") ?? "#!/bin/sh"
    const next = `${current}\n\n${block}`
    const action = existing.exists ? "would_update" : "would_create"
    if (!dryRun) {
      const write = await writeManagedBytes(
        repository.path,
        relativeHookPath,
        new TextEncoder().encode(`${next}\n`),
        0o700,
      )
      results.push({
        repository: repository.path,
        path: relativeHookPath,
        action: write === "created" ? "created" : write === "updated" ? "updated" : "exists",
      })
    } else {
      results.push({ repository: repository.path, path: relativeHookPath, action })
    }
  }
  return results
}
