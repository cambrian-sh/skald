import { DEFAULT_MCP_SERVER, type McpConfigAction, type McpServerDefinition } from "../agents/mcp"

export type McpCliOptions = {
  readonly command: string | undefined
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export function environmentValue(key: string): string | undefined {
  for (const [entryKey, value] of Object.entries(process.env)) {
    if (entryKey === key) return value
  }
  return undefined
}

export function parseEnvironmentAssignment(
  value: string,
): { readonly key: string; readonly value: string } | undefined {
  const separator = value.indexOf("=")
  if (separator <= 0) return undefined
  const key = value.slice(0, separator)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined
  return { key, value: value.slice(separator + 1) }
}

export function buildMcpServer(options: McpCliOptions): McpServerDefinition | undefined {
  const hasOverride =
    options.command !== undefined || options.args.length > 0 || Object.keys(options.env).length > 0
  if (!hasOverride) return undefined
  return {
    command: options.command ?? DEFAULT_MCP_SERVER.command,
    args: options.args,
    ...(Object.keys(options.env).length === 0 ? {} : { env: options.env }),
    trust: "explicit",
  }
}

export function mcpActionLabel(action: McpConfigAction): string {
  switch (action) {
    case "created":
      return "Created"
    case "updated":
      return "Updated"
    case "exists":
      return "Preserved"
    case "would_create":
      return "Would create"
    case "would_update":
      return "Would update"
    case "requires_global":
      return "Needs global config"
    default:
      return assertNever(action)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported MCP action: ${JSON.stringify(value)}`)
}
