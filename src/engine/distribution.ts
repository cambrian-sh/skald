import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join, parse, relative, resolve, sep } from "node:path"

const DEFAULT_ENGINE_PACKAGE = "codebase-memory-mcp@0.10.8"
const MAX_ENGINE_ARCHIVE_BYTES = 64 * 1024 * 1024
const PINNED_ENGINE_RELEASES = {
  "codebase-memory-mcp@0.10.8": {
    tarball: "https://registry.npmjs.org/codebase-memory-mcp/-/codebase-memory-mcp-0.10.8.tgz",
    integrity:
      "sha512-a1u0JEmev0BzQ/br3PSaD6Qxfomi7j+okGvNw9Jwx0/goF2lhFO1fitka+3nP73WUj+yIfrPGw1yOfB0wUTmAw==",
  },
} as const
const ENGINE_CACHE_DIRECTORY = ".cache/skald/engines"
const INSTALL_TIMEOUT_MS = 15 * 60_000
const MAX_INSTALL_OUTPUT_CHARS = 64_000
const ENGINE_BINARY_NAME =
  process.platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp"

export type ManagedEngineInstallResult = {
  readonly action: "installed" | "exists"
  readonly packageSpec: string
  readonly path: string
  readonly sha256: string
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function isPrivateMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0
}

function isProcessGone(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false
  return (
    error.code === "ESRCH" || error.code === "ECHILD" || error.code === "ERR_PROCESS_NOT_RUNNING"
  )
}

function packageSpec(): string {
  const configured = process.env["SKALD_ENGINE_PACKAGE"]?.trim()
  return configured === undefined || configured.length === 0 ? DEFAULT_ENGINE_PACKAGE : configured
}

function validatePackageSpec(value: string): void {
  if (!/^codebase-memory-mcp@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(
      "Managed engine packages must use an exact version such as codebase-memory-mcp@0.10.8",
    )
  }
}

function expectedPackageVersion(spec: string): string {
  return spec.slice("codebase-memory-mcp@".length)
}

async function verifiedInstallSpec(staging: string, spec: string): Promise<string> {
  const release = PINNED_ENGINE_RELEASES[spec as keyof typeof PINNED_ENGINE_RELEASES]
  if (release === undefined) {
    throw new Error(
      `No verified release metadata is available for ${spec}; use --mcp-command for a custom engine`,
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(release.tarball, { signal: controller.signal })
    if (!response.ok)
      throw new Error(`Pinned engine archive download failed: HTTP ${response.status}`)
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10)
    if (Number.isFinite(contentLength) && contentLength > MAX_ENGINE_ARCHIVE_BYTES) {
      throw new Error("Pinned engine archive exceeds the safety limit")
    }
    if (response.body === null) throw new Error("Pinned engine archive has no response body")
    const archive = join(staging, "codebase-memory-mcp.tgz")
    const handle = await open(archive, "w", 0o600)
    const reader = response.body.getReader()
    const digest = createHash("sha512")
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_ENGINE_ARCHIVE_BYTES) {
          throw new Error("Pinned engine archive exceeds the safety limit")
        }
        digest.update(chunk.value)
        await handle.write(chunk.value)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    const actual = digest.digest("base64")
    const expected = release.integrity.slice("sha512-".length)
    if (actual !== expected) throw new Error("Pinned engine archive integrity verification failed")
    return `file:${archive}`
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Pinned engine archive download timed out")
    }
    await rm(join(staging, "codebase-memory-mcp.tgz"), { force: true })
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function verifyInstalledPackage(staging: string, spec: string): Promise<void> {
  const metadataPath = join(staging, "node_modules", "codebase-memory-mcp", "package.json")
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"))
  } catch {
    throw new Error("Managed engine package metadata is missing or invalid")
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>)["name"] !== "codebase-memory-mcp" ||
    (metadata as Record<string, unknown>)["version"] !== expectedPackageVersion(spec)
  ) {
    throw new Error(`Managed engine package did not resolve to ${spec}`)
  }
}

function packageKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

function cacheRoot(): string {
  return join(homedir(), ENGINE_CACHE_DIRECTORY)
}

function managedDirectory(value: string): string {
  return join(cacheRoot(), packageKey(value))
}

function binaryPath(directory: string): string {
  return join(directory, "node_modules", "codebase-memory-mcp", "bin", ENGINE_BINARY_NAME)
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory)
  const root = parse(absolute).root
  const components = relative(root, absolute)
    .split(sep)
    .filter((component) => component.length > 0)
  let current = root
  for (const component of components) {
    current = join(current, component)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Managed engine cache path is not a real directory: ${current}`)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(current, { mode: 0o700 })
    }
  }
  const stats = await lstat(absolute)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed engine cache must be a private directory: ${absolute}`)
  }
  if (!isPrivateMode(stats.mode)) await chmod(absolute, 0o700)
  const uid = process.getuid?.()
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`Managed engine cache is not owned by the current user: ${absolute}`)
  }
}

async function isRegularExecutable(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return (
      stats.isFile() &&
      !stats.isSymbolicLink() &&
      (process.platform === "win32" || (stats.mode & 0o111) !== 0)
    )
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

async function sha256(path: string): Promise<string> {
  const contents = await readFile(path)
  return createHash("sha256").update(contents).digest("hex")
}

async function readOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return ""
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (output.length < MAX_INSTALL_OUTPUT_CHARS) {
        output += decoder
          .decode(chunk.value, { stream: true })
          .slice(0, MAX_INSTALL_OUTPUT_CHARS - output.length)
      }
    }
    if (output.length < MAX_INSTALL_OUTPUT_CHARS)
      output += decoder.decode().slice(0, MAX_INSTALL_OUTPUT_CHARS - output.length)
    return output
  } finally {
    reader.releaseLock()
  }
}

function installEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of [
    "BUN_INSTALL",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "TMP",
    "TMPDIR",
  ]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function bunExecutable(): string {
  const executable = Bun.which("bun")
  if (executable !== undefined && executable !== null) return executable
  if (process.execPath.endsWith("/bun") || process.execPath.endsWith("\\bun.exe")) {
    return process.execPath
  }
  throw new Error("Managed engine installation requires Bun to be available on PATH")
}

async function runPackageInstall(staging: string, spec: string): Promise<void> {
  const installSpec = await verifiedInstallSpec(staging, spec)
  const child = Bun.spawn(
    [bunExecutable(), "add", `--cwd=${staging}`, "--no-save", "--trust", installSpec],
    {
      env: installEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    },
  )
  const stdout = readOutput(child.stdout)
  const stderr = readOutput(child.stderr)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), INSTALL_TIMEOUT_MS)
  })
  const completed = Promise.all([child.exited, stdout, stderr]).then(
    ([exitCode, output, error]) => ({
      kind: "completed" as const,
      exitCode,
      output,
      error,
    }),
  )
  const result = await Promise.race([completed, timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (result === "timeout") {
    await stopPackageInstall(child)
    throw new Error(`Managed engine installation timed out after ${INSTALL_TIMEOUT_MS} ms`)
  }
  if (result.exitCode !== 0) {
    const detail = `${result.error}\n${result.output}`.trim()
    throw new Error(`Managed engine installation failed${detail.length === 0 ? "" : `: ${detail}`}`)
  }
  await verifyInstalledPackage(staging, spec)
}

async function stopPackageInstall(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const signal = async (name: NodeJS.Signals): Promise<void> => {
    try {
      if (process.platform === "win32") {
        child.kill(name)
        const treeKiller = Bun.spawn(
          ["taskkill", "/PID", String(child.pid), "/T", ...(name === "SIGKILL" ? ["/F"] : [])],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        )
        await Promise.race([treeKiller.exited, new Promise((resolve) => setTimeout(resolve, 250))])
      } else {
        process.kill(-child.pid, name)
      }
    } catch (error) {
      if (!isProcessGone(error)) throw error
    }
  }
  await signal("SIGTERM")
  const terminated = await Promise.race([
    child.exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ])
  if (!terminated) await signal("SIGKILL")
  await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 250))])
}

export function defaultManagedEnginePackage(): string {
  return DEFAULT_ENGINE_PACKAGE
}

export function managedEnginePackageFromEnvironment(): string {
  return packageSpec()
}

export async function locateManagedEngine(spec = packageSpec()): Promise<string | undefined> {
  validatePackageSpec(spec)
  const path = binaryPath(managedDirectory(spec))
  return (await isRegularExecutable(path)) ? path : undefined
}

export async function locateAnyManagedEngine(): Promise<string | undefined> {
  const configured = process.env["SKALD_ENGINE_PACKAGE"]?.trim()
  if (configured !== undefined && configured.length > 0) {
    return locateManagedEngine(configured)
  }
  const preferred = await locateManagedEngine()
  if (preferred !== undefined) return preferred
  try {
    const stats = await lstat(cacheRoot())
    if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined
    const entries = await readdir(cacheRoot(), { withFileTypes: true })
    const candidates: { readonly path: string; readonly modifiedAt: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const path = binaryPath(join(cacheRoot(), entry.name))
      if (await isRegularExecutable(path)) {
        candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs })
      }
    }
    candidates.sort(
      (left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path),
    )
    return candidates[0]?.path
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export async function installManagedEngine(
  options: { readonly packageSpec?: string; readonly upgrade?: boolean } = {},
): Promise<ManagedEngineInstallResult> {
  const spec = options.packageSpec?.trim() || packageSpec()
  validatePackageSpec(spec)
  await ensurePrivateDirectory(cacheRoot())
  const directory = managedDirectory(spec)
  const target = binaryPath(directory)
  if (!options.upgrade && (await isRegularExecutable(target))) {
    return { action: "exists", packageSpec: spec, path: target, sha256: await sha256(target) }
  }

  const staging = await mkdtemp(join(cacheRoot(), ".install-"))
  let published = false
  try {
    await runPackageInstall(staging, spec)
    const source = binaryPath(staging)
    if (!(await isRegularExecutable(source))) {
      throw new Error("Managed engine package did not publish a usable native executable")
    }
    const digest = await sha256(source)
    const backup = `${directory}.previous-${Date.now().toString(36)}`
    let movedExisting = false
    try {
      if (options.upgrade && (await isRegularExecutable(target))) {
        await rename(directory, backup)
        movedExisting = true
      }
      await rename(staging, directory)
      published = true
    } catch (error) {
      if (movedExisting) {
        try {
          await rename(backup, directory)
        } catch {
          return Promise.reject(error)
        }
      }
      throw error
    }
    if (!(await isRegularExecutable(target)))
      throw new Error("Published managed engine failed file verification")
    if (movedExisting) await rm(backup, { recursive: true, force: true })
    return { action: "installed", packageSpec: spec, path: binaryPath(directory), sha256: digest }
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true })
  }
}
