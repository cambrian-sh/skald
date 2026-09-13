import { buildContextBundle } from "../context/server"
import { discoverProject } from "../project/discover"

const MAX_HOOK_INPUT_CHARS = 64_000
const MAX_HOOK_CONTEXT_CHARS = 8_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readHookInput(): Promise<string> {
  const decoder = new TextDecoder()
  let input = ""
  for await (const chunk of Bun.stdin.stream()) {
    if (input.length < MAX_HOOK_INPUT_CHARS) {
      input += decoder.decode(chunk, { stream: true }).slice(0, MAX_HOOK_INPUT_CHARS - input.length)
    }
  }
  if (input.length < MAX_HOOK_INPUT_CHARS)
    input += decoder.decode().slice(0, MAX_HOOK_INPUT_CHARS - input.length)
  return input
}

function hookContext(bundle: Awaited<ReturnType<typeof buildContextBundle>>): string {
  const lines = [
    `Skald context for ${bundle.projectRoot}`,
    `Index freshness: ${bundle.freshness.status} (${bundle.freshness.detail})`,
    ...bundle.items.map((item) => `${item.kind}: ${item.title}\n${item.summary}`),
  ]
  if (bundle.warnings.length > 0) lines.push(`Warnings: ${bundle.warnings.join("; ")}`)
  return lines.join("\n\n").slice(0, MAX_HOOK_CONTEXT_CHARS)
}

export async function runClaudeSessionStartHook(): Promise<number> {
  try {
    const input = await readHookInput()
    let cwd = process.cwd()
    try {
      const parsed: unknown = JSON.parse(input)
      if (isRecord(parsed) && typeof parsed["cwd"] === "string") cwd = parsed["cwd"]
    } catch {
      cwd = process.cwd()
    }
    const project = await discoverProject(cwd)
    const bundle = await buildContextBundle(project.root, undefined, 12, {
      maxChars: MAX_HOOK_CONTEXT_CHARS,
    })
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: hookContext(bundle),
        },
      }),
    )
  } catch (error) {
    console.error(
      `Skald session context hook unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return 0
}
