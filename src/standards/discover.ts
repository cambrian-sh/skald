import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"

const IGNORED_DIRECTORIES = [
  ".cache",
  ".git",
  ".next",
  ".skald",
  ".venv",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "target",
  "tmp",
  "vendor",
] as const
const SKILL_FILENAME = "SKILL.md"
const DEFAULT_MAX_DIRECTORIES = 10_000
const DEFAULT_MAX_DEPTH = 32

const SKILL_ROOTS = [
  { path: ".agents/skills", source: "agents" },
  { path: ".skills", source: "skills" },
  { path: ".claude/skills", source: "claude" },
  { path: ".opencode/skills", source: "opencode" },
  { path: ".github/skills", source: "github" },
] as const

export type InstructionSource =
  | "agents-md"
  | "claude-md"
  | "gemini-md"
  | "copilot-instructions"
  | "cursor-rule"

export type SkillSource = (typeof SKILL_ROOTS)[number]["source"]

export type InstructionFile = {
  readonly kind: "instruction"
  readonly path: string
  readonly source: InstructionSource
}

export type SkillFile = {
  readonly kind: "skill"
  readonly path: string
  readonly skillId: string
  readonly source: SkillSource
}

export type StandardsInventory = {
  readonly instructions: readonly InstructionFile[]
  readonly skills: readonly SkillFile[]
  readonly truncated: boolean
}

export type StandardsDiscoveryOptions = {
  readonly maxDirectories?: number
  readonly maxDepth?: number
}

function normalizedPath(path: string): string {
  return path.split(sep).join("/")
}

function instructionSource(path: string): InstructionSource | undefined {
  if (path === ".github/copilot-instructions.md") return "copilot-instructions"
  if (path.startsWith(".github/instructions/") && path.endsWith(".instructions.md")) {
    return "copilot-instructions"
  }
  if (path.startsWith(".cursor/rules/") && (path.endsWith(".mdc") || path.endsWith(".md"))) {
    return "cursor-rule"
  }
  if (path === ".cursorrules") return "cursor-rule"

  const filename = basename(path)
  if (filename === "AGENTS.md") return "agents-md"
  if (filename === "CLAUDE.md" || filename === "CLAUDE.local.md") return "claude-md"
  if (filename === "GEMINI.md") return "gemini-md"
  return undefined
}

function skillSource(path: string): (typeof SKILL_ROOTS)[number] | undefined {
  for (const root of SKILL_ROOTS) {
    if (path === root.path || path.startsWith(`${root.path}/`)) return root
  }
  return undefined
}

function skillId(root: string, filePath: string): string | undefined {
  const skillDirectory = dirname(relative(root, filePath))
  if (skillDirectory === "." || skillDirectory === "") return undefined
  return normalizedPath(skillDirectory)
}

function shouldIgnoreDirectory(name: string): boolean {
  for (const ignoredDirectory of IGNORED_DIRECTORIES) {
    if (name === ignoredDirectory) return true
  }
  return false
}

async function walk(
  projectRoot: string,
  currentPath: string,
  instructions: InstructionFile[],
  skills: SkillFile[],
  state: { directoriesVisited: number; truncated: boolean },
  options: Required<StandardsDiscoveryOptions>,
  depth: number,
): Promise<void> {
  if (state.directoriesVisited >= options.maxDirectories || depth > options.maxDepth) {
    state.truncated = true
    return
  }
  state.directoriesVisited += 1
  let entries: readonly Dirent[]
  try {
    entries = await readdir(currentPath, { withFileTypes: true })
  } catch (error) {
    if (isFilesystemError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      state.truncated = true
      return
    }
    throw error
  }
  for (const entry of entries) {
    const absolutePath = join(currentPath, entry.name)
    const relativePath = normalizedPath(relative(projectRoot, absolutePath))

    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry.name)) {
        await walk(projectRoot, absolutePath, instructions, skills, state, options, depth + 1)
      }
      continue
    }
    if (!entry.isFile()) continue

    const source = instructionSource(relativePath)
    if (source !== undefined) {
      instructions.push({ kind: "instruction", path: relativePath, source })
      continue
    }

    if (entry.name !== SKILL_FILENAME) continue
    const skillRoot = skillSource(relativePath)
    if (skillRoot === undefined) continue
    const id = skillId(skillRoot.path, relativePath)
    if (id === undefined) continue
    skills.push({ kind: "skill", path: relativePath, skillId: id, source: skillRoot.source })
  }
}

type FilesystemError = Error & { readonly code?: string }

function isFilesystemError(error: unknown): error is FilesystemError {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

export async function discoverStandards(
  projectRoot: string,
  options: StandardsDiscoveryOptions = {},
): Promise<StandardsInventory> {
  const instructions: InstructionFile[] = []
  const skills: SkillFile[] = []
  const state = { directoriesVisited: 0, truncated: false }
  const limits = {
    maxDirectories: options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  }
  await walk(projectRoot, projectRoot, instructions, skills, state, limits, 0)

  instructions.sort((left, right) => left.path.localeCompare(right.path))
  skills.sort((left, right) => left.path.localeCompare(right.path))
  return { instructions, skills, truncated: state.truncated }
}
