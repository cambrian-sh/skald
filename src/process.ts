export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  const result = Bun.spawnSync(["/bin/kill", "-s", signal, `-${pid}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  })
  if (result.exitCode === 0) return

  const detail = new TextDecoder().decode(result.stderr).trim()
  if (detail.includes("No such process")) return
  throw new Error(
    `Could not signal process group ${pid} with ${signal}${detail.length === 0 ? "" : `: ${detail}`}`,
  )
}
