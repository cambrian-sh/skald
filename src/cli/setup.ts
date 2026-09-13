import { basename } from "node:path"

import { discoverExistingMcpServer } from "../agents/discover"
import { readConfiguredMcpServer } from "../config"
import { conformMcpEngine, prepareMcpServer } from "../engine"
import { installProjectEngine } from "../engine/project"
import { discoverProject } from "../project/discover"
import type { SetupCommand } from "./command"
import { runInit } from "./init"

export async function runSetupCommand(command: SetupCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const existing = await discoverExistingMcpServer(discovery.root)
  const persisted = await readConfiguredMcpServer(discovery.root)
  const configured = persisted ?? existing?.server
  let mcpCommand = command.mcpCommand
  let mcpArgs = command.mcpArgs
  let mcpEnv = command.mcpEnv
  let automaticallySelectedBackend = false

  if (mcpCommand === undefined && !command.dryRun) {
    if (command.enginePackage !== undefined) {
      throw new Error(
        "The managed setup channel is Afşin's pinned engine; use --mcp-command for a custom backend",
      )
    }
    const installed = await installProjectEngine(discovery.root)
    mcpCommand = installed.path
    automaticallySelectedBackend = true
    if (configured !== undefined) {
      if (
        mcpArgs.length === 0 &&
        basename(configured.command).startsWith("codebase-memory-mcp") &&
        configured.args.length > 0
      ) {
        mcpArgs = configured.args
      }
      const knowledgeDirectory = configured.env?.["CBM_KNOWLEDGE_DIR"]
      if (Object.keys(mcpEnv).length === 0 && knowledgeDirectory !== undefined) {
        mcpEnv = { CBM_KNOWLEDGE_DIR: knowledgeDirectory }
      }
    }
  }

  if (automaticallySelectedBackend && mcpCommand !== undefined) {
    const compatibilityServer = await prepareMcpServer(discovery.root, {
      command: mcpCommand,
      args: mcpArgs,
      trust: "explicit",
      ...(Object.keys(mcpEnv).length === 0 ? {} : { env: mcpEnv }),
    })
    const compatibility = await conformMcpEngine(discovery.root, compatibilityServer)
    if (!compatibility.available || !compatibility.compatible) {
      throw new Error(`Managed engine compatibility check failed: ${compatibility.detail}`)
    }
  }

  return runInit({
    ...command,
    kind: "init",
    trigger: "setup",
    ...(mcpCommand === undefined ? {} : { mcpCommand }),
    mcpArgs,
    mcpEnv,
  })
}
