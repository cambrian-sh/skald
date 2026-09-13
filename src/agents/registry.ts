export const AGENT_IDS = ["claude", "codex", "opencode"] as const

export type AgentAdapterId = (typeof AGENT_IDS)[number]
export type AgentCapability = "project-mcp" | "global-mcp" | "hooks"

export type AgentAdapterDescriptor = {
  readonly id: AgentAdapterId
  readonly name: string
  readonly capabilities: readonly AgentCapability[]
  readonly projectConfig: string | undefined
  readonly globalConfig: string | undefined
  readonly hooks: "opt-in" | "unsupported"
}

export const AGENT_ADAPTERS: readonly AgentAdapterDescriptor[] = [
  {
    id: "claude",
    name: "Claude Code",
    capabilities: ["project-mcp", "hooks"],
    projectConfig: ".mcp.json",
    globalConfig: undefined,
    hooks: "opt-in",
  },
  {
    id: "codex",
    name: "Codex",
    capabilities: ["global-mcp"],
    projectConfig: undefined,
    globalConfig: "$CODEX_HOME/config.toml",
    hooks: "unsupported",
  },
  {
    id: "opencode",
    name: "OpenCode",
    capabilities: ["project-mcp"],
    projectConfig: "opencode.json or opencode.jsonc",
    globalConfig: undefined,
    hooks: "unsupported",
  },
]

export function isAgentAdapterId(value: string): value is AgentAdapterId {
  return AGENT_IDS.some((id) => id === value)
}

export function agentAdapter(id: AgentAdapterId): AgentAdapterDescriptor {
  const descriptor = AGENT_ADAPTERS.find((candidate) => candidate.id === id)
  if (descriptor === undefined) throw new Error(`Missing agent adapter: ${id}`)
  return descriptor
}
