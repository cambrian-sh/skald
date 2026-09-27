import { lstat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { ManagedPathUnavailableError, UnsafePathError } from "./safe-file-types"

export function managedPath(projectRoot: string, relativePath: string): string {
  const root = resolve(projectRoot)
  const absolute = resolve(root, relativePath)
  const within = relative(root, absolute)
  if (isAbsolute(relativePath) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new UnsafePathError(absolute, "outside_project")
  }
  return absolute
}

export async function verifyProjectRoot(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot)
  const stats = await lstat(root)
  if (stats.isSymbolicLink()) throw new UnsafePathError(root, "symlink")
  if (!stats.isDirectory()) throw new UnsafePathError(root, "not_directory")
  return root
}

export function supportsSafeManagedPaths(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "darwin"
}

export function assertSafeManagedPathPlatform(
  path: string,
  platform: string = process.platform,
): void {
  if (!supportsSafeManagedPaths(platform)) throw new ManagedPathUnavailableError(path, platform)
}
