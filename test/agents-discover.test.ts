import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverExistingMcpServer } from "../src/agents/discover"

let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) {
    await rm(fixtureRoot, { force: true, recursive: true })
    fixtureRoot = undefined
  }
})

test("discovers the existing Cambrian Claude engine and knowledge environment", async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "skald-agent-discover-"))
  await mkdir(join(fixtureRoot, ".claude"))
  await writeFile(
    join(fixtureRoot, ".claude", ".mcp.json"),
    JSON.stringify(
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
    ),
  )

  const result = await discoverExistingMcpServer(fixtureRoot)

  expect(result).toEqual({
    agent: "claude",
    path: ".claude/.mcp.json",
    serverName: "codebase-memory-mcp",
    server: {
      command: "/opt/cambrian/codebase-memory-mcp",
      args: [],
      env: { CBM_KNOWLEDGE_DIR: "/opt/cambrian-knowledge" },
      serverName: "codebase-memory-mcp",
    },
  })
})
