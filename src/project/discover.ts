import type { Dirent } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export type GitMarker = "directory" | "file" | "workspace"

export type ProjectDiscovery = {
  readonly root: string
  readonly gitMarker: GitMarker
}

export class ProjectNotFoundError extends Error {
  readonly name = "ProjectNotFoundError"

  constructor(readonly startPath: string) {
    super(`Could not find a Git project or workspace from ${startPath}`)
  }
}

type FilesystemError = Error & {
  readonly code?: string
}

function isFilesystemError(error: unknown): error is FilesystemError {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

async function readGitMarker(path: string): Promise<GitMarker | undefined> {
  try {
    const marker = await lstat(path)
    if (marker.isDirectory()) return "directory"
    if (marker.isFile()) return "file"
    return undefined
  } catch (error) {
    if (isFilesystemError(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

async function hasNestedGitRepository(path: string): Promise<boolean> {
  let entries: readonly Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isFilesystemError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
      return false
    }
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    if ((await readGitMarker(join(path, entry.name, ".git"))) !== undefined) return true
  }
  return false
}

export async function discoverProject(startPath: string): Promise<ProjectDiscovery> {
  let currentPath = resolve(startPath)
  try {
    currentPath = await realpath(currentPath)
  } catch (error) {
    if (!isFilesystemError(error) || error.code !== "ENOENT") throw error
  }
  const requestedPath = currentPath

  while (true) {
    const gitMarker = await readGitMarker(resolve(currentPath, ".git"))
    if (gitMarker !== undefined) {
      return { root: currentPath, gitMarker }
    }

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      if (await hasNestedGitRepository(requestedPath)) {
        return { root: requestedPath, gitMarker: "workspace" }
      }
      throw new ProjectNotFoundError(startPath)
    }
    currentPath = parentPath
  }
}
