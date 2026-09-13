import { basename } from "node:path"

function embeddedFileName(file: Blob): string | undefined {
  const name = Reflect.get(file, "name")
  return typeof name === "string" ? basename(name) : undefined
}

export async function bundledEngineBytes(): Promise<Uint8Array | undefined> {
  const files = [...(Bun.embeddedFiles ?? [])]
  const named = files.filter((file) => embeddedFileName(file)?.startsWith("codebase-memory-mcp"))
  const file = named.length === 1 ? named[0] : undefined
  if (file === undefined) return undefined
  const bytes = new Uint8Array(await file.arrayBuffer())
  return bytes.byteLength === 0 ? undefined : bytes
}
