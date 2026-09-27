import { close, fsync, read, write } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { getNativeFileSystem, type NativeFileSystem } from "./native"
import { verifyProjectRoot } from "./safe-file-path"
import {
  type FileStats,
  isFilesystemError,
  isMissing,
  isSymlinkError,
  NativeFileSystemUnavailableError,
  UnsafePathError,
} from "./safe-file-types"

export async function requireNativeFileSystem(path: string): Promise<NativeFileSystem> {
  const fileSystem = await getNativeFileSystem()
  if (fileSystem === undefined) {
    throw new NativeFileSystemUnavailableError(path, process.platform, process.arch)
  }
  return fileSystem
}

function openDirectoryPath(fileSystem: NativeFileSystem, path: string): number {
  try {
    return fileSystem.openDirectory(path)
  } catch (error) {
    if (isSymlinkError(error)) throw new UnsafePathError(path, "symlink")
    if (isFilesystemError(error) && error.code === "ENOTDIR") {
      throw new UnsafePathError(path, "not_directory")
    }
    throw error
  }
}

function openDirectoryChild(
  fileSystem: NativeFileSystem,
  parent: number,
  name: string,
  path: string,
): number {
  try {
    return fileSystem.openDirectoryAt(parent, name)
  } catch (error) {
    if (isSymlinkError(error)) throw new UnsafePathError(path, "symlink")
    if (isFilesystemError(error) && error.code === "ENOTDIR") {
      throw new UnsafePathError(path, "not_directory")
    }
    throw error
  }
}

export async function openStableDirectory(
  fileSystem: NativeFileSystem,
  projectRoot: string,
  directory: string,
  create: boolean,
): Promise<number> {
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

  let current = openDirectoryPath(fileSystem, root)
  let currentPath = root
  try {
    for (const part of directoryRelative.split(sep).filter(Boolean)) {
      currentPath = `${currentPath}${sep}${part}`
      let next: number
      try {
        next = openDirectoryChild(fileSystem, current, part, currentPath)
      } catch (error) {
        if (!create || !isMissing(error)) throw error
        try {
          fileSystem.mkdirAt(current, part, 0o700)
        } catch (mkdirError) {
          if (!isFilesystemError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError
        }
        next = openDirectoryChild(fileSystem, current, part, currentPath)
      }
      const previous = current
      current = next
      fileSystem.close(previous)
    }
    return current
  } catch (error) {
    fileSystem.close(current)
    throw error
  }
}

export async function ensureStableDirectory(
  fileSystem: NativeFileSystem,
  directory: string,
): Promise<void> {
  const absoluteDirectory = resolve(directory)
  try {
    await verifyProjectRoot(absoluteDirectory)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const parentDirectory = dirname(absoluteDirectory)
  if (parentDirectory === absoluteDirectory) {
    throw new Error(`Cannot create directory: ${directory}`)
  }
  await ensureStableDirectory(fileSystem, parentDirectory)
  const parent = await openStableDirectory(fileSystem, parentDirectory, parentDirectory, false)
  try {
    const childName = basename(absoluteDirectory)
    try {
      fileSystem.mkdirAt(parent, childName, 0o700)
    } catch (error) {
      if (!isFilesystemError(error) || error.code !== "EEXIST") throw error
    }
    const child = fileSystem.openDirectoryAt(parent, childName)
    fileSystem.close(child)
  } finally {
    fileSystem.close(parent)
  }
}

export function existingStatsAt(
  fileSystem: NativeFileSystem,
  parent: number,
  filename: string,
  absolutePath: string,
): FileStats | undefined {
  try {
    const stats = fileSystem.statAt(parent, filename)
    if (stats.isSymlink) throw new UnsafePathError(absolutePath, "symlink")
    if (!stats.isFile) throw new UnsafePathError(absolutePath, "not_file")
    return stats
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function readDescriptor(
  descriptor: number,
  buffer: Buffer,
  position: number,
): Promise<number> {
  return await new Promise((resolveRead, rejectRead) => {
    read(descriptor, buffer, 0, buffer.byteLength, position, (error, bytesRead) => {
      if (error !== null) rejectRead(error)
      else resolveRead(bytesRead)
    })
  })
}

export async function writeDescriptor(
  descriptor: number,
  contents: string | Uint8Array,
): Promise<void> {
  const buffer: Uint8Array = typeof contents === "string" ? Buffer.from(contents, "utf8") : contents
  let offset = 0
  while (offset < buffer.byteLength) {
    const bytesWritten = await new Promise<number>((resolveWrite, rejectWrite) => {
      write(descriptor, buffer, offset, buffer.byteLength - offset, null, (error, count) => {
        if (error !== null) rejectWrite(error)
        else resolveWrite(count)
      })
    })
    if (bytesWritten === 0) throw new Error("Managed file write made no progress")
    offset += bytesWritten
  }
}

export async function syncDescriptor(descriptor: number): Promise<void> {
  await new Promise<void>((resolveSync, rejectSync) => {
    fsync(descriptor, (error) => {
      if (error !== null) rejectSync(error)
      else resolveSync()
    })
  })
}

export async function syncDirectory(descriptor: number): Promise<void> {
  try {
    await syncDescriptor(descriptor)
  } catch (error) {
    if (isFilesystemError(error) && error.code === "EINVAL") return
    throw error
  }
}

export async function closeDescriptor(descriptor: number): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    close(descriptor, (error) => {
      if (error !== null) rejectClose(error)
      else resolveClose()
    })
  })
}
