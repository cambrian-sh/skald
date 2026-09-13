import type { ExistingMcpServer } from "./agents/discover"
import { discoverExistingMcpServer } from "./agents/discover"
import type { McpServerDefinition } from "./agents/mcp"
import { readConfiguredMcpServer, readProjectManifest } from "./config"
import type { SkaldProjectManifest } from "./context/contract"
import {
  attestExecutableMcpServer,
  type EngineProbe,
  locateMcpEngine,
  probeMcpEngine,
  resolveMcpServer,
} from "./engine"
import { readManagedFile } from "./fs/safe-file"
import {
  discoverProjectKnowledge,
  isKnowledgeActive,
  manifestKnowledgeDirectory,
} from "./knowledge/store"
import { discoverProject } from "./project/discover"
import { assessProjectFreshness, currentGitSnapshot, readProjectState } from "./project/state"
import { discoverStandards } from "./standards/discover"
import { isTrustedKnowledgeDirectory, isTrustedMcpExecutable } from "./trust"

export type DoctorCheckStatus = "pass" | "warn" | "fail"

export type DoctorCheck = {
  readonly name: string
  readonly status: DoctorCheckStatus
  readonly message: string
}

export type DoctorReport = {
  readonly command: "doctor"
  readonly status: DoctorCheckStatus
  readonly projectRoot: string
  readonly checks: readonly DoctorCheck[]
  readonly engine: EngineProbe | undefined
  readonly standards: {
    readonly instructions: number
    readonly skills: number
    readonly truncated: boolean
  }
  readonly knowledge: {
    readonly root: string
    readonly entries: number
    readonly truncated: boolean
  }
  readonly freshness: {
    readonly status: "fresh" | "stale" | "degraded" | "unknown"
    readonly currentRevision?: string
    readonly indexedRevision?: string
    readonly workingTree: "clean" | "dirty" | "unknown"
    readonly detail: string
  }
}

function statusFor(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail"
  if (checks.some((check) => check.status === "warn")) return "warn"
  return "pass"
}

function serverKnowledgeDirectory(server: McpServerDefinition | undefined): string | undefined {
  return server?.env?.["CBM_KNOWLEDGE_DIR"]
}

function matchingProject(engine: EngineProbe, projectRoot: string): boolean {
  return engine.projects.some((project) => project.rootPath === projectRoot)
}

export async function diagnoseProject(startPath: string): Promise<DoctorReport> {
  const discovery = await discoverProject(startPath)
  const checks: DoctorCheck[] = []
  const standards = await discoverStandards(discovery.root)
  const stateRead = await readProjectState(discovery.root)
  const currentSnapshot = await currentGitSnapshot(discovery.root)
  let freshness = assessProjectFreshness(stateRead.state, currentSnapshot)
  checks.push({ name: "project", status: "pass", message: `Git project: ${discovery.root}` })
  checks.push({
    name: "standards",
    status: standards.truncated ? "warn" : "pass",
    message: `${standards.instructions.length} instruction file(s), ${standards.skills.length} skill(s) discovered`,
  })
  if (stateRead.warning !== undefined) {
    checks.push({ name: "freshness", status: "warn", message: stateRead.warning })
  }
  let persisted: SkaldProjectManifest | undefined
  let existing: ExistingMcpServer | undefined
  try {
    persisted = await readProjectManifest(discovery.root)
    existing = await discoverExistingMcpServer(discovery.root)
  } catch (error) {
    checks.push({
      name: "configuration",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const persistedServer = await readConfiguredMcpServer(discovery.root).catch(() => undefined)
  const configuredServer = persistedServer ?? existing?.server
  let server: McpServerDefinition | undefined
  try {
    server = await resolveMcpServer(discovery.root, undefined, configuredServer, true)
  } catch (error) {
    checks.push({
      name: "engine",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  if (persisted === undefined) {
    checks.push({
      name: "manifest",
      status: "warn",
      message: "No versioned .skald/config.json manifest found",
    })
  } else {
    checks.push({
      name: "manifest",
      status: "pass",
      message: "Versioned Skald manifest is present",
    })
  }

  try {
    const bootstrap = await readManagedFile(discovery.root, ".skald/context.md")
    checks.push({
      name: "bootstrap",
      status: bootstrap.exists ? "pass" : "warn",
      message: bootstrap.exists
        ? "Project context bootstrap is present"
        : "Project context bootstrap is missing",
    })
  } catch (error) {
    checks.push({
      name: "bootstrap",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const configuredKnowledgeDirectory =
    serverKnowledgeDirectory(server) ??
    manifestKnowledgeDirectory(persisted) ??
    process.env["CBM_KNOWLEDGE_DIR"]
  let knowledgeDirectory = configuredKnowledgeDirectory
  let knowledgeTrustWarning: string | undefined
  try {
    if (!(await isTrustedKnowledgeDirectory(discovery.root, configuredKnowledgeDirectory))) {
      knowledgeDirectory = undefined
      knowledgeTrustWarning =
        "External knowledge directory is not trusted; pass --mcp-env CBM_KNOWLEDGE_DIR=<path> to approve it"
    }
  } catch (error) {
    knowledgeDirectory = undefined
    checks.push({
      name: "knowledge-trust",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const knowledge = await discoverProjectKnowledge(discovery.root, knowledgeDirectory)
  const inactiveKnowledge = knowledge.entries.filter((entry) => !isKnowledgeActive(entry)).length
  checks.push({
    name: "knowledge",
    status:
      knowledgeTrustWarning !== undefined || knowledge.truncated || inactiveKnowledge > 0
        ? "warn"
        : knowledge.entries.length > 0
          ? "pass"
          : "warn",
    message:
      knowledgeTrustWarning ??
      (knowledge.entries.length > 0
        ? `${knowledge.entries.length} durable knowledge file(s) discovered${inactiveKnowledge > 0 ? `, ${inactiveKnowledge} inactive` : ""}`
        : "No durable knowledge records discovered"),
  })

  let engine: EngineProbe | undefined
  if (server !== undefined) {
    const candidate = await locateMcpEngine(discovery.root, server.command)
    try {
      const attestedServer = await attestExecutableMcpServer(discovery.root, server, true)
      const executableServer =
        attestedServer !== undefined &&
        (await isTrustedMcpExecutable(discovery.root, attestedServer))
          ? { ...attestedServer, trust: "explicit" as const }
          : undefined
      if (executableServer === undefined) {
        freshness = assessProjectFreshness(stateRead.state, currentSnapshot, {
          command: server.command,
          sha256: undefined,
        })
        checks.push({
          name: "engine",
          status: "fail",
          message:
            attestedServer === undefined || candidate === undefined
              ? `Engine is not executable: ${server.command}`
              : `Engine requires explicit trust before execution: ${candidate}`,
        })
      } else {
        freshness = assessProjectFreshness(stateRead.state, currentSnapshot, {
          command: executableServer.command,
          sha256: executableServer.sha256,
        })
        engine = await probeMcpEngine(discovery.root, executableServer)
        checks.push({
          name: "engine",
          status: engine.available && engine.compatible ? "pass" : "fail",
          message: engine.detail,
        })
        if (engine.available && engine.compatible) {
          checks.push({
            name: "index",
            status: matchingProject(engine, discovery.root) ? "pass" : "warn",
            message: matchingProject(engine, discovery.root)
              ? "Project is present in the backend index"
              : "Project is not present in the backend index; run `skald engine index`",
          })
        }
      }
    } catch (error) {
      checks.push({
        name: "engine",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  checks.push({
    name: "freshness",
    status: freshness.status === "fresh" ? "pass" : "warn",
    message: freshness.detail,
  })

  return {
    command: "doctor",
    status: statusFor(checks),
    projectRoot: discovery.root,
    checks,
    engine,
    standards: {
      instructions: standards.instructions.length,
      skills: standards.skills.length,
      truncated: standards.truncated,
    },
    knowledge: {
      root: knowledge.root,
      entries: knowledge.entries.length,
      truncated: knowledge.truncated,
    },
    freshness: {
      status: freshness.status,
      ...(freshness.currentRevision === undefined
        ? {}
        : { currentRevision: freshness.currentRevision }),
      ...(freshness.indexedRevision === undefined
        ? {}
        : { indexedRevision: freshness.indexedRevision }),
      workingTree: freshness.workingTree,
      detail: freshness.detail,
    },
  }
}

export function printDoctorReport(report: DoctorReport): void {
  console.log(`Doctor: ${report.status}`)
  console.log(`Project: ${report.projectRoot}`)
  for (const check of report.checks)
    console.log(`${check.status.toUpperCase()}: ${check.name} - ${check.message}`)
}
