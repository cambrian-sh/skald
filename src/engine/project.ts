import { createHash } from "node:crypto"
import { access, constants } from "node:fs"
import { chmod, lstat, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { McpServerDefinition } from "../agents/mcp"
import { writeManagedBytes } from "../fs/safe-file"
import { bundledEngineBytes } from "./embedded"

export const AFSIN_ENGINE = {
  repository: "https://github.com/afsin-asf/codebase-memory-mcp",
  commit: "cf1d310a72320ec55e7b86a091561162567e55d2",
  releaseLine: "0.10.8",
} as const

export const PROJECT_ENGINE_PATH = ".skald/engine/codebase-memory-mcp"
export const PROJECT_KNOWLEDGE_PATH = ".skald/knowledge"
export const PROJECT_ENGINE_CACHE_PATH = ".skald/engine/cache"
export const PROJECT_ENGINE_CONFIG_PATH = ".skald/engine/config"
export const PROJECT_ENGINE_RUNTIME_PATH = ".skald/r"

const RUNTIME_SOCKET_PATH_BUDGET = 96
const AFSIN_SOCKET_NAME_BUDGET = 32

const ENGINE_FILENAME =
  process.platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp"

export type ProjectEngineInstallResult = {
  readonly action: "installed" | "exists"
  readonly path: string
  readonly sha256: string
  readonly channel: "afsin"
  readonly commit: string
}

function isExecutable(path: string): Promise<boolean> {
  return lstat(path)
    .then((stats) => {
      if (!stats.isFile() || stats.isSymbolicLink()) return false
      return new Promise<boolean>((resolveAccess) => {
        access(path, constants.X_OK, (error) => resolveAccess(error === null))
      })
    })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
      throw error
    })
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function sha256Bytes(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex")
}

function pathByteLength(path: string): number {
  return new TextEncoder().encode(path).byteLength
}

function fitsAfshinUnixSocket(projectRuntime: string): boolean {
  return pathByteLength(projectRuntime) + 1 + AFSIN_SOCKET_NAME_BUDGET < RUNTIME_SOCKET_PATH_BUDGET
}

function shortRuntimeDirectory(projectRoot: string): string {
  const projectKey = createHash("sha256")
    .update(`${resolve(projectRoot)}\0${AFSIN_ENGINE.commit}`)
    .digest("hex")
    .slice(0, 16)
  const candidates = [process.env["XDG_RUNTIME_DIR"]?.trim(), "/tmp"]
  for (const parent of candidates) {
    if (parent === undefined || parent.length === 0) continue
    const candidate = resolve(parent, `skald-${projectKey}`)
    if (fitsAfshinUnixSocket(candidate)) return candidate
  }
  return resolve("/tmp", `skald-${projectKey}`)
}

export function projectEngineRuntimeDirectory(projectRoot: string): string {
  const projectRuntime = resolve(projectRoot, PROJECT_ENGINE_RUNTIME_PATH)
  if (process.platform === "win32" || fitsAfshinUnixSocket(projectRuntime)) {
    return projectRuntime
  }
  return shortRuntimeDirectory(projectRoot)
}

function embeddedCandidates(): readonly string[] {
  const packageRoots = [
    resolve(import.meta.dir, "../../vendor/engine"),
    resolve(import.meta.dir, "../vendor/engine"),
    resolve(dirname(process.execPath), "vendor/engine"),
  ]
  const platform = process.platform === "win32" ? "windows" : process.platform
  const architecture = process.arch === "x64" ? "amd64" : process.arch
  const target = `${platform}-${architecture}`
  const optionalPackage = resolve(
    import.meta.dir,
    `../../../skald-engine-${target}`,
    "vendor",
    "engine",
    target,
    ENGINE_FILENAME,
  )
  const nestedOptionalPackage = resolve(
    import.meta.dir,
    "../../node_modules",
    "@cambrian",
    `skald-engine-${target}`,
    "vendor",
    "engine",
    target,
    ENGINE_FILENAME,
  )
  return [
    ...packageRoots.map((root) => resolve(root, target, ENGINE_FILENAME)),
    optionalPackage,
    nestedOptionalPackage,
  ]
}

export async function locateProjectEngineSource(projectRoot: string): Promise<string | undefined> {
  const installed = resolve(projectRoot, PROJECT_ENGINE_PATH)
  const candidates = [...embeddedCandidates(), installed]
  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutable(candidate)) return candidate
  }
  return undefined
}

export function projectEngineEnvironment(
  projectRoot: string,
  knowledgeDirectory = PROJECT_KNOWLEDGE_PATH,
): Readonly<Record<string, string>> {
  return {
    CBM_ALLOWED_ROOT: resolve(projectRoot),
    CBM_CACHE_DIR: resolve(projectRoot, PROJECT_ENGINE_CACHE_PATH),
    CBM_CONFIG_DIR: resolve(projectRoot, PROJECT_ENGINE_CONFIG_PATH),
    CBM_KNOWLEDGE_DIR: resolve(projectRoot, knowledgeDirectory),
    CBM_RUNTIME_DIR: projectEngineRuntimeDirectory(projectRoot),
  }
}

export function defaultProjectEngineServer(projectRoot: string): McpServerDefinition {
  return {
    command: resolve(projectRoot, PROJECT_ENGINE_PATH),
    args: [],
    env: projectEngineEnvironment(projectRoot),
  }
}

export async function installProjectEngine(
  projectRoot: string,
  options: { readonly source?: string; readonly upgrade?: boolean } = {},
): Promise<ProjectEngineInstallResult> {
  const target = resolve(projectRoot, PROJECT_ENGINE_PATH)
  const embedded = options.source === undefined ? await bundledEngineBytes() : undefined
  const source =
    options.source === undefined
      ? await locateProjectEngineSource(projectRoot)
      : resolve(options.source)
  let sourceSha256: string
  let contents: Uint8Array
  if (embedded !== undefined) {
    sourceSha256 = sha256Bytes(embedded)
    contents = embedded
  } else {
    if (source === undefined || !(await isExecutable(source))) {
      throw new Error(
        `The Skald release does not contain the Afşin engine for ${process.platform}/${process.arch}; ` +
          "use a platform release or pass --mcp-command for a custom engine",
      )
    }
    sourceSha256 = await sha256(source)
    contents = new Uint8Array(await readFile(source))
  }
  if (!options.upgrade && (await isExecutable(target)) && (await sha256(target)) === sourceSha256) {
    return {
      action: "exists",
      path: target,
      sha256: sourceSha256,
      channel: "afsin",
      commit: AFSIN_ENGINE.commit,
    }
  }
  const result = await writeManagedBytes(
    projectRoot,
    PROJECT_ENGINE_PATH,
    new Uint8Array(contents),
    0o700,
  )
  await chmod(target, 0o700)
  return {
    action: result === "created" || result === "updated" ? "installed" : "exists",
    path: target,
    sha256: sourceSha256,
    channel: "afsin",
    commit: AFSIN_ENGINE.commit,
  }
}
