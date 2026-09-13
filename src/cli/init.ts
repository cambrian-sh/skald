import { resolve } from "node:path"
import { discoverExistingMcpServer } from "../agents/discover"
import { ensureAgentMcpConfig, type McpServerDefinition } from "../agents/mcp"
import {
  type EnsureConfigOptions,
  ensureConfig,
  readConfiguredMcpServer,
  readProjectManifest,
} from "../config"
import {
  ensureContextBootstrap,
  prepareContextRuntime,
  publishContextRuntime,
} from "../context/bootstrap"
import {
  attestExecutableMcpServer,
  indexProjectDetailed,
  indexResponseStatus,
  locateMcpEngine,
  prepareMcpServer,
  resolveMcpServer,
} from "../engine"
import { defaultProjectEngineServer, PROJECT_KNOWLEDGE_PATH } from "../engine/project"
import { ensureKnowledgeSyncHooks } from "../knowledge/hooks"
import { discoverProject } from "../project/discover"
import { recordProjectIndex } from "../project/state"
import { discoverStandards } from "../standards/discover"
import { isTrustedMcpExecutable, trustKnowledgeDirectory, trustMcpExecutable } from "../trust"
import { type InitCommand, type InitReport, printHumanReport } from "./command"
import { buildMcpServer } from "./mcp-options"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function withoutTrust(server: McpServerDefinition): McpServerDefinition {
  return {
    command: server.command,
    args: [...server.args],
    ...(server.env === undefined ? {} : { env: { ...server.env } }),
    ...(server.serverName === undefined ? {} : { serverName: server.serverName }),
    ...(server.sha256 === undefined ? {} : { sha256: server.sha256 }),
  }
}

export async function runInit(command: InitCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const standards = await discoverStandards(discovery.root)
  const explicitServer = buildMcpServer({
    command: command.mcpCommand,
    args: command.mcpArgs,
    env:
      command.knowledgeDirectory === undefined
        ? command.mcpEnv
        : { ...command.mcpEnv, CBM_KNOWLEDGE_DIR: command.knowledgeDirectory },
  })
  const existing = await discoverExistingMcpServer(discovery.root)
  const persisted = await readConfiguredMcpServer(discovery.root)
  const manifest = await readProjectManifest(discovery.root)
  const defaultServer = defaultProjectEngineServer(discovery.root)
  const requestedServer = explicitServer ?? persisted ?? existing?.server ?? defaultServer
  const configuredExisting =
    persisted ?? (explicitServer === undefined ? (existing?.server ?? defaultServer) : undefined)
  const resolvedServer: McpServerDefinition = await resolveMcpServer(
    discovery.root,
    explicitServer,
    configuredExisting,
    true,
    { allowProjectLocal: true },
  )
  const attestedServer = await attestExecutableMcpServer(discovery.root, resolvedServer, true)
  const explicitKnowledge = explicitServer?.env?.["CBM_KNOWLEDGE_DIR"]
  let preparedAttestedServer: McpServerDefinition | undefined
  let trustedServer: McpServerDefinition | undefined
  if (attestedServer !== undefined) {
    preparedAttestedServer = await prepareMcpServer(
      discovery.root,
      explicitServer === undefined
        ? withoutTrust(attestedServer)
        : { ...attestedServer, trust: "explicit" },
      false,
    )
    if (explicitServer !== undefined) {
      trustedServer = { ...preparedAttestedServer, trust: "explicit" }
    } else if (await isTrustedMcpExecutable(discovery.root, attestedServer)) {
      trustedServer = { ...preparedAttestedServer, trust: "explicit" }
    }
  }
  const runtimeSource = trustedServer ?? preparedAttestedServer ?? resolvedServer
  const preparedServer = await prepareMcpServer(discovery.root, runtimeSource, false)
  const configuredServer =
    trustedServer === undefined
      ? { ...withoutTrust(preparedServer), command: requestedServer.command }
      : { ...preparedServer, command: requestedServer.command, trust: "explicit" as const }
  const plannedBootstrap = await ensureContextBootstrap(discovery.root, true)
  const plannedRuntime = await prepareContextRuntime(discovery.root, command.dryRun)
  const configuredKnowledgeDirectory =
    configuredServer.env?.["CBM_KNOWLEDGE_DIR"] ??
    manifest?.sources.find((source) => source.kind === "knowledge")?.path ??
    existing?.server.env?.["CBM_KNOWLEDGE_DIR"]
  const knowledgeDirectory =
    configuredKnowledgeDirectory === resolve(discovery.root, PROJECT_KNOWLEDGE_PATH)
      ? PROJECT_KNOWLEDGE_PATH
      : configuredKnowledgeDirectory
  const knowledgeRoot = resolve(discovery.root, knowledgeDirectory ?? PROJECT_KNOWLEDGE_PATH)
  const configOptions: EnsureConfigOptions =
    knowledgeDirectory === undefined
      ? { agents: command.agents, updateBackend: explicitServer !== undefined }
      : { agents: command.agents, knowledgeDirectory, updateBackend: explicitServer !== undefined }
  const plannedConfig = await ensureConfig(
    discovery.root,
    true,
    configuredServer,
    standards,
    configOptions,
  )
  const plannedMcpConfigs = await Promise.all(
    command.agents.map((agent) =>
      ensureAgentMcpConfig(
        discovery.root,
        agent,
        configuredServer,
        true,
        plannedRuntime.runtime.server,
        {
          includeBackend: trustedServer !== undefined,
          installHooks: command.hooks,
          superviseBackend: trustedServer !== undefined,
        },
      ),
    ),
  )
  const plannedKnowledgeHooks = command.hooks
    ? await ensureKnowledgeSyncHooks(
        discovery.root,
        knowledgeRoot,
        plannedRuntime.runtime.server,
        true,
      )
    : []
  const candidate = command.index
    ? await locateMcpEngine(discovery.root, resolvedServer.command, { allowProjectLocal: true })
    : undefined
  const executable = command.index ? trustedServer : undefined
  let index: InitReport["index"]
  if (!command.index) index = { action: "skipped", reason: "disabled" }
  else if (executable === undefined) {
    index = {
      action: "skipped",
      reason: candidate === undefined ? "engine-not-found" : "engine-not-trusted",
    }
  } else if (command.dryRun) index = { action: "would_index", mode: command.indexMode }
  else {
    const result = await indexProjectDetailed(discovery.root, executable, command.indexMode)
    const detail = result.exitCode === 0 ? "" : result.stderr.trim() || result.stdout.trim()
    if (result.exitCode === 0) {
      const response = result.response
      const backendProject =
        isRecord(response) && typeof response["project"] === "string"
          ? response["project"]
          : undefined
      await recordProjectIndex(
        discovery.root,
        executable,
        command.indexMode,
        indexResponseStatus(response),
        backendProject,
        command.trigger ?? "manual",
      )
    } else {
      throw new Error(`MCP engine index failed${detail.length === 0 ? "" : `: ${detail}`}`)
    }
    index = {
      action: "indexed",
      mode: command.indexMode,
      status: result.exitCode,
      ...(detail.length === 0 ? {} : { detail }),
    }
  }
  if (!command.dryRun) {
    if (explicitKnowledge !== undefined) {
      await trustKnowledgeDirectory(discovery.root, explicitKnowledge)
    }
    if (explicitServer !== undefined && preparedAttestedServer !== undefined) {
      await trustMcpExecutable(discovery.root, preparedAttestedServer)
    }
    await prepareMcpServer(discovery.root, runtimeSource, true)
  }
  const config = command.dryRun
    ? plannedConfig
    : await ensureConfig(discovery.root, false, configuredServer, standards, configOptions)
  const bootstrap = command.dryRun
    ? plannedBootstrap
    : await ensureContextBootstrap(discovery.root, false)
  const runtime = command.dryRun
    ? plannedRuntime.runtime
    : await publishContextRuntime(discovery.root, plannedRuntime)
  const mcpConfigs = command.dryRun
    ? plannedMcpConfigs
    : await Promise.all(
        command.agents.map((agent) =>
          ensureAgentMcpConfig(discovery.root, agent, configuredServer, false, runtime.server, {
            includeBackend: trustedServer !== undefined,
            installHooks: command.hooks,
            superviseBackend: trustedServer !== undefined,
          }),
        ),
      )
  const knowledgeHooks = command.hooks
    ? command.dryRun
      ? plannedKnowledgeHooks
      : await ensureKnowledgeSyncHooks(discovery.root, knowledgeRoot, runtime.server, false)
    : []
  const report: InitReport = {
    command: command.trigger === "setup" ? "setup" : "init",
    dryRun: command.dryRun,
    projectRoot: discovery.root,
    gitMarker: discovery.gitMarker,
    instructionFiles: standards.instructions,
    skills: standards.skills,
    standardsTruncated: standards.truncated,
    agents: command.agents,
    engine: {
      command: configuredServer.command,
      ...(configuredServer.sha256 === undefined ? {} : { sha256: configuredServer.sha256 }),
      trust:
        trustedServer === undefined
          ? attestedServer === undefined
            ? "unresolved"
            : "discovered"
          : configuredServer.trust === "explicit"
            ? "explicit"
            : "discovered",
    },
    configAction: config.action,
    configPath: ".skald/config.json",
    mcpConfigs,
    knowledgeHooks,
    bootstrapAction: bootstrap.action,
    contextRuntime: {
      path: runtime.path,
      action: runtime.action,
      ...(runtime.note === undefined ? {} : { note: runtime.note }),
    },
    index,
  }

  if (command.json) console.log(JSON.stringify(report))
  else printHumanReport(report)
  return report.index.action === "indexed" ? report.index.status : 0
}
