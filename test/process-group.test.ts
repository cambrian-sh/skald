import { expect, test } from "bun:test"
import { signalProcessGroup } from "../src/process"

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let contents = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("Process closed before reporting its descendant PID")
      contents += decoder.decode(chunk.value, { stream: true })
      const newline = contents.indexOf("\n")
      if (newline >= 0) return contents.slice(0, newline)
    }
  } finally {
    reader.releaseLock()
  }
}

test("signals the full detached process group, including spawned descendants", async () => {
  const script = [
    'const descendant = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })',
    'process.stdout.write(String(descendant.pid) + "\\n")',
    'process.on("SIGTERM", () => {})',
    "descendant.exited.then(() => process.exit(0))",
    "setInterval(() => {}, 1000)",
  ].join(";")
  const leader = Bun.spawn([process.execPath, "-e", script], {
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const stdout = leader.stdout
  if (typeof stdout !== "object" || stdout === null) {
    leader.kill("SIGKILL")
    throw new Error("Detached process stdout is unavailable")
  }
  const descendantPid = Number.parseInt(await readLine(stdout), 10)

  try {
    expect(Number.isInteger(descendantPid)).toBe(true)
    await signalProcessGroup(leader.pid, "SIGTERM")
    await leader.exited
    expect(processIsAlive(descendantPid)).toBe(false)
  } finally {
    if (leader.exitCode === null) leader.kill("SIGKILL")
    if (Number.isInteger(descendantPid) && processIsAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL")
    }
  }
})
