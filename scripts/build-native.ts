import { lstat, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

const platform = process.platform
const arch = process.arch === "x64" ? "amd64" : process.arch
if ((platform !== "linux" && platform !== "darwin") || (arch !== "amd64" && arch !== "arm64")) {
  throw new Error(`Native managed-file operations are unsupported on ${platform}/${arch}`)
}

const projectRoot = resolve(import.meta.dir, "..")
const includeDirectory = join(projectRoot, "node_modules", "node-api-headers", "include")
const source = join(projectRoot, "src", "fs", "safe-file-native.c")
const support = join(projectRoot, "src", "fs", "safe-file-native-support.c")
const outputDirectory = join(projectRoot, "vendor", "engine", "native", `${platform}-${arch}`)
const output = join(outputDirectory, "skald-safe-fs.node")
await mkdir(outputDirectory, { recursive: true })

const platformFlags =
  platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared"]
const compiler = Bun.spawnSync(
  [
    "cc",
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-unused-parameter",
    "-fPIC",
    ...platformFlags,
    "-DNAPI_VERSION=8",
    "-DNODE_GYP_MODULE_NAME=skald_safe_fs",
    "-I",
    includeDirectory,
    source,
    support,
    "-o",
    output,
  ],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
)
if (compiler.exitCode !== 0) {
  const detail = new TextDecoder().decode(compiler.stderr).trim()
  throw new Error(
    `Could not build Skald's native filesystem module${detail.length === 0 ? "" : `: ${detail}`}`,
  )
}

const stats = await lstat(output)
if (stats.isSymbolicLink() || !stats.isFile() || stats.size === 0) {
  throw new Error(`Native filesystem module is not a regular file: ${output}`)
}
console.log(`Built ${output} (${stats.size} bytes)`)
