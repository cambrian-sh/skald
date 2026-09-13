import { type McpAgent, type McpServerDefinition, persistableMcpEnvironment } from "../agents/mcp"

export const SKALD_MANIFEST_VERSION = 2 as const

export type QueryFreshnessPolicy = "warn" | "refresh"
export type WriteFreshnessPolicy = "warn" | "require-verify"
export type FreshnessPolicy = QueryFreshnessPolicy | WriteFreshnessPolicy

export type ProjectSource = {
  readonly kind: "repository" | "knowledge"
  readonly path: string
}

export type SkaldProjectManifest = {
  readonly version: typeof SKALD_MANIFEST_VERSION
  readonly project: {
    readonly root: "."
  }
  readonly backend: {
    readonly kind: "mcp"
    readonly command: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly serverName?: string
    readonly trust?: "explicit"
    readonly sha256?: string
  }
  readonly sources: readonly ProjectSource[]
  readonly agents: readonly McpAgent[]
  readonly context: {
    readonly serverName: string
    readonly retrieval: "on-demand"
    readonly writeSurface: string
  }
  readonly freshness: {
    readonly onQuery: QueryFreshnessPolicy
    readonly beforeWrite: WriteFreshnessPolicy
  }
  readonly standards?: {
    readonly instructions: readonly string[]
    readonly skills: readonly string[]
    readonly truncated: boolean
  }
}

export type ContextItem = {
  readonly kind: "instruction" | "skill" | "knowledge" | "architecture"
  readonly title: string
  readonly summary: string
  readonly sourceRefs: readonly string[]
  readonly authority: "canonical" | "derived" | "session"
  readonly freshness: "fresh" | "stale" | "unknown" | "not-applicable"
  readonly confidence: "high" | "medium" | "low"
}

export type ContextBundle = {
  readonly projectRoot: string
  readonly projectId: string
  readonly generatedAt: string
  readonly items: readonly ContextItem[]
  readonly warnings: readonly string[]
  readonly freshness: {
    readonly status: "fresh" | "stale" | "degraded" | "unknown"
    readonly currentRevision?: string
    readonly indexedRevision?: string
    readonly workingTree: "clean" | "dirty" | "unknown"
    readonly detail: string
  }
  readonly budget: {
    readonly maxChars: number
    readonly usedChars: number
    readonly truncated: boolean
  }
}

export type KnowledgeRecordKind =
  | "adr"
  | "decision"
  | "observation"
  | "measurement"
  | "component"
  | "contract"
  | "investigation"
  | "research"

export type KnowledgeRecordInput = {
  readonly kind: KnowledgeRecordKind
  readonly title: string
  readonly summary: string
  readonly sourceRefs?: readonly string[]
}

export type KnowledgeRecordReceipt = {
  readonly path: string
  readonly kind: KnowledgeRecordKind
  readonly authority: "session"
  readonly sourceRefs: readonly string[]
  readonly action: "created" | "exists"
  readonly fingerprint: string
}

export function manifestBackend(server: McpServerDefinition): SkaldProjectManifest["backend"] {
  const env = persistableMcpEnvironment(server.env)
  return {
    kind: "mcp",
    command: server.command,
    args: [...server.args],
    ...(env === undefined ? {} : { env: { ...env } }),
    ...(server.serverName === undefined ? {} : { serverName: server.serverName }),
    ...(server.trust === undefined ? {} : { trust: server.trust }),
    ...(server.sha256 === undefined ? {} : { sha256: server.sha256 }),
  }
}
