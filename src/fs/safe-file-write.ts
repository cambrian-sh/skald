import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { basename, dirname } from "node:path"
import {
  closeDescriptor,
  ensureStableDirectory,
  existingStatsAt,
  openStableDirectory,
  requireNativeFileSystem,
  syncDescriptor,
  syncDirectory,
  writeDescriptor,
} from "./descriptor"
import type { NativeFileSystem } from "./native"
import { assertSafeManagedPathPlatform, managedPath } from "./safe-file-path"
import {
  ConcurrentFileChangeError,
  type FileStats,
  isFilesystemError,
  isMissing,
  type ManagedWriteResult,
} from "./safe-file-types"

const MAX_MANAGED_FILE_BYTES = 4 * 1024 * 1024
const MAX_MANAGED_BINARY_BYTES = 512 * 1024 * 1024
type ManagedContents = string | Uint8Array

function sameFile(left: FileStats, right: FileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function removeTemporaryFile(fileSystem: NativeFileSystem, parent: number, name: string): void {
  try {
    fileSystem.unlinkAt(parent, name)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function createManagedFileAt(
  fileSystem: NativeFileSystem,
  parent: number,
  absolutePath: string,
  contents: ManagedContents,
  mode = 0o600,
): Promise<ManagedWriteResult> {
  const filename = basename(absolutePath)
  const temporaryName = `.${filename}.${randomUUID()}.tmp`
  let temporaryCreated = false
  try {
    const descriptor = fileSystem.openFileAt(
      parent,
      temporaryName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    )
    temporaryCreated = true
    try {
      await writeDescriptor(descriptor, contents)
      await syncDescriptor(descriptor)
    } finally {
      await closeDescriptor(descriptor)
    }
    try {
      fileSystem.linkAt(parent, temporaryName, filename)
    } catch (error) {
      if (isFilesystemError(error) && error.code === "EEXIST") {
        const current = existingStatsAt(fileSystem, parent, filename, absolutePath)
        if (current !== undefined) return "exists"
      }
      throw error
    }
    await syncDirectory(parent)
    removeTemporaryFile(fileSystem, parent, temporaryName)
    temporaryCreated = false
    return "created"
  } finally {
    if (temporaryCreated) removeTemporaryFile(fileSystem, parent, temporaryName)
  }
}

async function replaceManagedFileAt(
  fileSystem: NativeFileSystem,
  parent: number,
  absolutePath: string,
  contents: ManagedContents,
  original: FileStats,
  mode: number | undefined,
): Promise<ManagedWriteResult> {
  const filename = basename(absolutePath)
  const temporaryName = `.${filename}.${randomUUID()}.tmp`
  const originalMode = original.mode
  let temporaryCreated = false
  try {
    const descriptor = fileSystem.openFileAt(
      parent,
      temporaryName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      (mode ?? originalMode) & 0o777,
    )
    temporaryCreated = true
    try {
      await writeDescriptor(descriptor, contents)
      await syncDescriptor(descriptor)
    } finally {
      await closeDescriptor(descriptor)
    }
    const latest = existingStatsAt(fileSystem, parent, filename, absolutePath)
    if (latest === undefined || !sameFile(original, latest)) {
      throw new ConcurrentFileChangeError(absolutePath)
    }
    fileSystem.renameAt(parent, temporaryName, filename)
    await syncDirectory(parent)
    temporaryCreated = false
    return "updated"
  } finally {
    if (temporaryCreated) removeTemporaryFile(fileSystem, parent, temporaryName)
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
  mode: number | undefined,
  maxBytes: number,
): Promise<ManagedWriteResult> {
  const absolutePath = managedPath(projectRoot, relativePath)
  assertSafeManagedPathPlatform(absolutePath)
  const size = typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength
  if (size > maxBytes) {
    throw new Error(`Managed file exceeds ${maxBytes} bytes: ${absolutePath}`)
  }
  const fileSystem = await requireNativeFileSystem(absolutePath)
  await ensureStableDirectory(fileSystem, projectRoot)
  const parent = await openStableDirectory(fileSystem, projectRoot, dirname(absolutePath), true)
  try {
    const original = existingStatsAt(fileSystem, parent, basename(absolutePath), absolutePath)
    if (original === undefined) {
      return await createManagedFileAt(fileSystem, parent, absolutePath, contents, mode)
    }
    return await replaceManagedFileAt(fileSystem, parent, absolutePath, contents, original, mode)
  } finally {
    fileSystem.close(parent)
  }
}
