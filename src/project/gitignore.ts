import { readManagedFile, writeManagedFile } from "../fs/safe-file"

const SKALD_GITIGNORE_PATH = ".skald/.gitignore"
const BEGIN_MARKER = "# >>> SKALD MANAGED IGNORE RULES >>>"
const END_MARKER = "# <<< SKALD MANAGED IGNORE RULES <<<"
const MANAGED_RULES = [
  "/engine/",
  "/r/",
  "/state.json",
  "/context-runtime*",
  "/knowledge/",
] as const
const MANAGED_BLOCK = [BEGIN_MARKER, ...MANAGED_RULES, END_MARKER] as const

export class SkaldGitignoreError extends Error {
  readonly name = "SkaldGitignoreError"

  constructor() {
    super(`Malformed Skald-managed block in ${SKALD_GITIGNORE_PATH}`)
  }
}

function markerIndexes(lines: readonly string[], marker: string): readonly number[] {
  return lines.flatMap((line, index) => (line === marker ? [index] : []))
}

function withManagedRules(existingContents: string): string {
  const lineEnding = existingContents.includes("\r\n") ? "\r\n" : "\n"
  const lines = existingContents.split(/\r?\n/)
  const startIndexes = markerIndexes(lines, BEGIN_MARKER)
  const endIndexes = markerIndexes(lines, END_MARKER)

  if (startIndexes.length === 0 && endIndexes.length === 0) {
    const separator =
      existingContents.length === 0 || existingContents.endsWith("\n") ? "" : lineEnding
    return `${existingContents}${separator}${MANAGED_BLOCK.join(lineEnding)}${lineEnding}`
  }

  const start = startIndexes[0]
  const end = endIndexes[0]
  if (
    startIndexes.length !== 1 ||
    endIndexes.length !== 1 ||
    start === undefined ||
    end === undefined ||
    start >= end
  ) {
    throw new SkaldGitignoreError()
  }

  return [...lines.slice(0, start), ...MANAGED_BLOCK, ...lines.slice(end + 1)].join(lineEnding)
}

export async function ensureSkaldGitignore(projectRoot: string, dryRun: boolean): Promise<void> {
  const existing = await readManagedFile(projectRoot, SKALD_GITIGNORE_PATH)
  const nextContents = withManagedRules(existing.contents ?? "")
  if (nextContents === (existing.contents ?? "")) return
  if (dryRun) return
  await writeManagedFile(projectRoot, SKALD_GITIGNORE_PATH, nextContents)
}
