import type { NativeFileStats } from "./native"

export type FilesystemError = Error & { readonly code?: string }
export type FileStats = NativeFileStats
export type ManagedContents = string | Uint8Array

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

export class NativeFileSystemUnavailableError extends Error {
  readonly name = "NativeFileSystemUnavailableError"

  constructor(
    readonly path: string,
    readonly platform: string,
    readonly arch: string,
  ) {
    super(
      `Native managed-file operations are unavailable for ${platform}/${arch}: ${path}. ` +
        "Reinstall Skald's matching platform package or executable; source checkouts can run bun run native:build.",
    )
  }
}

export type ManagedFile = {
  readonly relativePath: string
  readonly absolutePath: string
  readonly exists: boolean
  readonly contents?: string
}

export type ManagedWriteResult = "created" | "updated" | "exists"

export function isFilesystemError(error: unknown): error is FilesystemError {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

export function isMissing(error: unknown): boolean {
  return isFilesystemError(error) && error.code === "ENOENT"
}

export function isSymlinkError(error: unknown): boolean {
  return isFilesystemError(error) && error.code === "ELOOP"
}
