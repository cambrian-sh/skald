import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

type FilesystemError = Error & { readonly code?: string }
type FileStats = Awaited<ReturnType<typeof lstat>>
type ManagedContents = string | Uint8Array

const NO_FOLLOW = constants.O_NOFOLLOW
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW
const MAX_MANAGED_FILE_BYTES = 4 * 1024 * 1024
const MAX_MANAGED_BINARY_BYTES = 512 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export type UnsafePathReason = "outside_project" | "symlink" | "not_directory" | "not_file"

export class UnsafePathError extends Error {
  readonly name = "UnsafePathError"

  constructor(
    readonly path: string,
    readonly reason: UnsafePathReason,
  ) {
    super(`Refusing unsafe managed path (${reason}): ${path}`)
  }
}

export class ConcurrentFileChangeError extends Error {
  readonly name = "ConcurrentFileChangeError"

  constructor(readonly path: string) {
    super(`Managed file changed while it was being updated: ${path}`)
  }
}

export class ManagedPathUnavailableError extends Error {
  readonly name = "ManagedPathUnavailableError"

  constructor(
    readonly path: string,
    readonly platform: string,
  ) {
    super(`Safe managed paths are unavailable on ${platform}: ${path}`)
  }
}

export type ManagedFile = {
  readonly relativePath: string
  readonly absolutePath: string
  readonly exists: boolean
  readonly contents?: string
}

export type ManagedWriteResult = "created" | "updated" | "exists"

function isFilesystemError(error: unknown): error is FilesystemError {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

function isMissing(error: unknown): boolean {
  return isFilesystemError(error) && error.code === "ENOENT"
}

function isSymlinkError(error: unknown): boolean {
  return isFilesystemError(error) && error.code === "ELOOP"
}

function managedPath(projectRoot: string, relativePath: string): string {
  const root = resolve(projectRoot)
  const absolute = resolve(root, relativePath)
  const within = relative(root, absolute)
  if (isAbsolute(relativePath) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new UnsafePathError(absolute, "outside_project")
  }
  return absolute
}

async function verifyProjectRoot(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot)
  const stats = await lstat(root)
  if (stats.isSymbolicLink()) throw new UnsafePathError(root, "symlink")
  if (!stats.isDirectory()) throw new UnsafePathError(root, "not_directory")
  return root
}

export function supportsSafeManagedPaths(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "darwin" || platform.endsWith("bsd")
}

export function assertSafeManagedPathPlatform(
  path: string,
  platform: string = process.platform,
): void {
  if (!supportsSafeManagedPaths(platform)) throw new ManagedPathUnavailableError(path, platform)
}

function descriptorDirectory(): string {
  return process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"
}

function descriptorPath(fileDescriptor: number, child?: string): string {
  const directory = descriptorDirectory()
  return child === undefined
    ? join(directory, String(fileDescriptor))
    : join(directory, String(fileDescriptor), child)
}

async function openDirectoryPath(path: string): Promise<FileHandle> {
  try {
    return await open(path, DIRECTORY_FLAGS)
  } catch (error) {
    if (isSymlinkError(error)) throw new UnsafePathError(path, "symlink")
    if (isFilesystemError(error) && error.code === "ENOTDIR") {
      throw new UnsafePathError(path, "not_directory")
    }
    throw error
  }
}

async function openStableDirectory(
  projectRoot: string,
  directory: string,
  create: boolean,
): Promise<FileHandle> {
  const root = await verifyProjectRoot(projectRoot)
  const absoluteDirectory = resolve(directory)
  const directoryRelative = relative(root, absoluteDirectory)
  if (
    isAbsolute(directoryRelative) ||
    directoryRelative === ".." ||
    directoryRelative.startsWith(`..${sep}`)
  ) {
    throw new UnsafePathError(absoluteDirectory, "outside_project")
  }

  let current = await openDirectoryPath(root)
  try {
    for (const part of directoryRelative.split(sep).filter(Boolean)) {
      const childPath = descriptorPath(current.fd, part)
      let next: FileHandle
      try {
        next = await openDirectoryPath(childPath)
      } catch (error) {
        if (!create || !isMissing(error)) throw error
        try {
          await mkdir(childPath, { mode: 0o700 })
        } catch (mkdirError) {
          if (!isFilesystemError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError
        }
        next = await openDirectoryPath(childPath)
      }
      await current.close()
      current = next
    }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}

async function ensureStableDirectory(directory: string): Promise<void> {
  const absoluteDirectory = resolve(directory)
  try {
    await verifyProjectRoot(absoluteDirectory)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const parentDirectory = dirname(absoluteDirectory)
  if (parentDirectory === absoluteDirectory)
    throw new Error(`Cannot create directory: ${directory}`)
  await ensureStableDirectory(parentDirectory)
  const parent = await openStableDirectory(parentDirectory, parentDirectory, false)
  try {
    const childPath = descriptorPath(parent.fd, basename(absoluteDirectory))
    try {
      await mkdir(childPath, { mode: 0o700 })
    } catch (error) {
      if (!isFilesystemError(error) || error.code !== "EEXIST") throw error
    }
    const child = await openDirectoryPath(childPath)
    await child.close()
  } finally {
    await parent.close()
  }
}

async function existingStatsAt(
  parent: FileHandle,
  filename: string,
  absolutePath: string,
): Promise<FileStats | undefined> {
  try {
    const stats = await lstat(descriptorPath(parent.fd, filename))
    if (stats.isSymbolicLink()) throw new UnsafePathError(absolutePath, "symlink")
    if (!stats.isFile()) throw new UnsafePathError(absolutePath, "not_file")
    return stats
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function syncDirectory(directory: FileHandle): Promise<void> {
  try {
    await directory.sync()
  } catch (error) {
    if (isFilesystemError(error) && error.code === "EINVAL") return
    throw error
  }
}

async function readUtf8Bounded(handle: FileHandle, path: string, limit: number): Promise<string> {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let position = 0
  let total = 0
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total + 1))
    const result = await handle.read(buffer, 0, buffer.byteLength, position)
    if (result.bytesRead === 0) break
    total += result.bytesRead
    if (total > limit) throw new Error(`Managed file exceeds ${limit} bytes: ${path}`)
    chunks.push(decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }))
    position += result.bytesRead
  }
  chunks.push(decoder.decode())
  return chunks.join("")
}

export async function readManagedFile(
  projectRoot: string,
  relativePath: string,
): Promise<ManagedFile> {
  const absolutePath = managedPath(projectRoot, relativePath)
  assertSafeManagedPathPlatform(absolutePath)
  let parent: FileHandle | undefined
  try {
    parent = await openStableDirectory(projectRoot, dirname(absolutePath), false)
    const handle = await open(
      descriptorPath(parent.fd, basename(absolutePath)),
      constants.O_RDONLY | NO_FOLLOW,
    )
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) throw new UnsafePathError(absolutePath, "not_file")
      if (stats.size > MAX_MANAGED_FILE_BYTES) {
        throw new Error(`Managed file exceeds ${MAX_MANAGED_FILE_BYTES} bytes: ${absolutePath}`)
      }
      return {
        relativePath,
        absolutePath,
        exists: true,
        contents: await readUtf8Bounded(handle, absolutePath, MAX_MANAGED_FILE_BYTES),
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error)) return { relativePath, absolutePath, exists: false }
    if (isSymlinkError(error)) throw new UnsafePathError(absolutePath, "symlink")
    throw error
  } finally {
    await parent?.close()
  }
}

export async function managedFileIsExecutable(
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  const absolutePath = managedPath(projectRoot, relativePath)
  assertSafeManagedPathPlatform(absolutePath)
  let parent: FileHandle | undefined
  try {
    parent = await openStableDirectory(projectRoot, dirname(absolutePath), false)
    const stats = await existingStatsAt(parent, basename(absolutePath), absolutePath)
    const mode =
      stats === undefined ? 0 : typeof stats.mode === "bigint" ? Number(stats.mode) : stats.mode
    return stats !== undefined && (process.platform === "win32" || (mode & 0o111) !== 0)
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  } finally {
    await parent?.close()
  }
}

function sameFile(left: FileStats, right: FileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function createManagedFileAt(
  parent: FileHandle,
  absolutePath: string,
  contents: ManagedContents,
  mode = 0o600,
): Promise<ManagedWriteResult> {
  const filename = basename(absolutePath)
  const temporaryName = `.${filename}.${randomUUID()}.tmp`
  const temporaryPath = descriptorPath(parent.fd, temporaryName)
  const targetPath = descriptorPath(parent.fd, filename)
  let temporaryCreated = false
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      mode,
    )
    temporaryCreated = true
    try {
      if (typeof contents === "string") await handle.write(contents, 0, "utf8")
      else await handle.write(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporaryPath, targetPath)
    } catch (error) {
      if (isFilesystemError(error) && error.code === "EEXIST") {
        const current = await existingStatsAt(parent, filename, absolutePath)
        if (current !== undefined) return "exists"
      }
      throw error
    }
    await syncDirectory(parent)
    await removeTemporaryFile(temporaryPath)
    temporaryCreated = false
    return "created"
  } finally {
    if (temporaryCreated) await removeTemporaryFile(temporaryPath)
  }
}

async function replaceManagedFileAt(
  parent: FileHandle,
  absolutePath: string,
  contents: ManagedContents,
  original: FileStats,
  mode: number | undefined,
): Promise<ManagedWriteResult> {
  const filename = basename(absolutePath)
  const temporaryName = `.${filename}.${randomUUID()}.tmp`
  const temporaryPath = descriptorPath(parent.fd, temporaryName)
  const targetPath = descriptorPath(parent.fd, filename)
  const originalMode = typeof original.mode === "bigint" ? Number(original.mode) : original.mode
  let temporaryCreated = false
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      (mode ?? originalMode) & 0o777,
    )
    temporaryCreated = true
    try {
      if (typeof contents === "string") await handle.write(contents, 0, "utf8")
      else await handle.write(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    const latest = await existingStatsAt(parent, filename, absolutePath)
    if (latest === undefined || !sameFile(original, latest)) {
      throw new ConcurrentFileChangeError(absolutePath)
    }
    await rename(temporaryPath, targetPath)
    await syncDirectory(parent)
    temporaryCreated = false
    return "updated"
  } finally {
    if (temporaryCreated) await removeTemporaryFile(temporaryPath)
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

export async function writeManagedFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
): Promise<ManagedWriteResult> {
  return writeManagedContents(
    projectRoot,
    relativePath,
    contents,
    undefined,
    MAX_MANAGED_FILE_BYTES,
  )
}

export async function writeManagedBytes(
  projectRoot: string,
  relativePath: string,
  contents: Uint8Array,
  mode = 0o700,
): Promise<ManagedWriteResult> {
  return writeManagedContents(projectRoot, relativePath, contents, mode, MAX_MANAGED_BINARY_BYTES)
}

async function writeManagedContents(
  projectRoot: string,
  relativePath: string,
  contents: ManagedContents,
  mode?: number,
  maxBytes = MAX_MANAGED_FILE_BYTES,
): Promise<ManagedWriteResult> {
  const absolutePath = managedPath(projectRoot, relativePath)
  assertSafeManagedPathPlatform(absolutePath)
  const size = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength
  if (size > maxBytes) {
    throw new Error(`Managed file exceeds ${maxBytes} bytes: ${absolutePath}`)
  }
  await ensureStableDirectory(projectRoot)
  const parent = await openStableDirectory(projectRoot, dirname(absolutePath), true)
  try {
    const original = await existingStatsAt(parent, basename(absolutePath), absolutePath)
    if (original === undefined)
      return await createManagedFileAt(parent, absolutePath, contents, mode)
    return await replaceManagedFileAt(parent, absolutePath, contents, original, mode)
  } finally {
    await parent.close()
  }
}
