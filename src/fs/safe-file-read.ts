import { constants, fstatSync } from "node:fs"
import { basename, dirname } from "node:path"
import {
  closeDescriptor,
  existingStatsAt,
  openStableDirectory,
  readDescriptor,
  requireNativeFileSystem,
} from "./descriptor"
import { assertSafeManagedPathPlatform, managedPath } from "./safe-file-path"
import { isMissing, isSymlinkError, type ManagedFile, UnsafePathError } from "./safe-file-types"

const MAX_MANAGED_FILE_BYTES = 4 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

async function readUtf8Bounded(descriptor: number, path: string, limit: number): Promise<string> {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let position = 0
  let total = 0

  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total + 1))
    const bytesRead = await readDescriptor(descriptor, buffer, position)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > limit) throw new Error(`Managed file exceeds ${limit} bytes: ${path}`)
    chunks.push(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }))
    position += bytesRead
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
  const fileSystem = await requireNativeFileSystem(absolutePath)
  let parent: number | undefined
  let descriptor: number | undefined
  try {
    parent = await openStableDirectory(fileSystem, projectRoot, dirname(absolutePath), false)
    descriptor = fileSystem.openFileAt(
      parent,
      basename(absolutePath),
      constants.O_RDONLY | constants.O_NONBLOCK,
      0,
    )
    const stats = fstatSync(descriptor)
    if (!stats.isFile()) throw new UnsafePathError(absolutePath, "not_file")
    if (stats.size > MAX_MANAGED_FILE_BYTES) {
      throw new Error(`Managed file exceeds ${MAX_MANAGED_FILE_BYTES} bytes: ${absolutePath}`)
    }
    return {
      relativePath,
      absolutePath,
      exists: true,
      contents: await readUtf8Bounded(descriptor, absolutePath, MAX_MANAGED_FILE_BYTES),
    }
  } catch (error) {
    if (isMissing(error)) return { relativePath, absolutePath, exists: false }
    if (isSymlinkError(error)) throw new UnsafePathError(absolutePath, "symlink")
    throw error
  } finally {
    try {
      if (descriptor !== undefined) await closeDescriptor(descriptor)
    } finally {
      if (parent !== undefined) fileSystem.close(parent)
    }
  }
}

export async function managedFileIsExecutable(
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  const absolutePath = managedPath(projectRoot, relativePath)
  assertSafeManagedPathPlatform(absolutePath)
  const fileSystem = await requireNativeFileSystem(absolutePath)
  let parent: number | undefined
  try {
    parent = await openStableDirectory(fileSystem, projectRoot, dirname(absolutePath), false)
    const stats = existingStatsAt(fileSystem, parent, basename(absolutePath), absolutePath)
    return stats !== undefined && (stats.mode & 0o111) !== 0
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  } finally {
    if (parent !== undefined) fileSystem.close(parent)
  }
}
