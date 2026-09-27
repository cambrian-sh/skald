import { rmSync } from "node:fs"
import { lstat, mkdtemp, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const ADDON_NAME = "skald-safe-fs.node"
const require = createRequire(import.meta.url)

export type NativeFileStats = {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly size: number
  readonly isFile: boolean
  readonly isSymlink: boolean
}

export type NativeFileSystem = {
  readonly openDirectory: (path: string) => number
  readonly openDirectoryAt: (parent: number, name: string) => number
  readonly mkdirAt: (parent: number, name: string, mode: number) => void
  readonly openFileAt: (parent: number, name: string, flags: number, mode: number) => number
  readonly statAt: (parent: number, name: string) => NativeFileStats
  readonly linkAt: (parent: number, source: string, target: string) => void
  readonly renameAt: (parent: number, source: string, target: string) => void
  readonly unlinkAt: (parent: number, name: string) => void
  readonly close: (descriptor: number) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNativeFileSystem(value: unknown): value is NativeFileSystem {
  return (
    isRecord(value) &&
    typeof value["openDirectory"] === "function" &&
    typeof value["openDirectoryAt"] === "function" &&
    typeof value["mkdirAt"] === "function" &&
    typeof value["openFileAt"] === "function" &&
    typeof value["statAt"] === "function" &&
    typeof value["linkAt"] === "function" &&
    typeof value["renameAt"] === "function" &&
    typeof value["unlinkAt"] === "function" &&
    typeof value["close"] === "function"
  )
}

function embeddedName(file: Blob): string | undefined {
  const name = Reflect.get(file, "name")
  return typeof name === "string" ? basename(name) : undefined
}

function isModuleMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND"
}

function loadAddon(path: string): NativeFileSystem {
  const loaded: unknown = require(path)
  if (!isNativeFileSystem(loaded)) {
    throw new Error(`Native filesystem module has an incomplete API: ${path}`)
  }
  return loaded
}

async function loadEmbeddedAddon(): Promise<NativeFileSystem | undefined> {
  const candidates = [...(Bun.embeddedFiles ?? [])].filter((candidate) =>
    embeddedName(candidate)?.startsWith("skald-safe-fs"),
  )
  if (candidates.length === 0) return undefined
  if (candidates.length !== 1 || candidates[0]?.size === 0) {
    throw new Error("Standalone bundle contains an invalid set of native filesystem addons")
  }
  const [file] = candidates
  if (file === undefined) return undefined

  const directory = await mkdtemp(join(tmpdir(), "skald-native-fs-"))
  const path = join(directory, ADDON_NAME)
  try {
    await writeFile(path, new Uint8Array(await file.arrayBuffer()), {
      flag: "wx",
      mode: 0o700,
    })
    process.once("exit", () => rmSync(directory, { force: true, recursive: true }))
    return loadAddon(path)
  } catch (error) {
    rmSync(directory, { force: true, recursive: true })
    throw error
  }
}

async function loadSourceAddon(): Promise<NativeFileSystem | undefined> {
  if (process.platform !== "linux" && process.platform !== "darwin") return undefined
  const arch = process.arch === "x64" ? "amd64" : process.arch
  const target = `${process.platform}-${arch}`
  const localPath = resolve(import.meta.dir, "../../vendor/engine/native", target, ADDON_NAME)
  try {
    const stats = await lstat(localPath)
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Native filesystem module is not a regular file: ${localPath}`)
    }
    return loadAddon(localPath)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }

  const companion = `@cambrian/skald-engine-${target}/vendor/engine/native/${ADDON_NAME}`
  try {
    return loadAddon(require.resolve(companion))
  } catch (error) {
    if (isModuleMissing(error)) return undefined
    throw error
  }
}

async function loadNativeFileSystem(): Promise<NativeFileSystem | undefined> {
  const executableName = basename(process.execPath).toLowerCase()
  const isStandalone =
    Bun.isStandaloneExecutable || (executableName !== "bun" && executableName !== "bun.exe")
  if (isStandalone) return await loadEmbeddedAddon()
  return await loadSourceAddon()
}

let nativeFileSystemPromise: Promise<NativeFileSystem | undefined> | undefined

export function getNativeFileSystem(): Promise<NativeFileSystem | undefined> {
  nativeFileSystemPromise ??= loadNativeFileSystem()
  return nativeFileSystemPromise
}
