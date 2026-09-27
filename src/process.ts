type ChildProcess = Pick<ReturnType<typeof Bun.spawn>, "pid" | "exitCode" | "kill">
type ProcessGroupSignaler = (pid: number, signal: NodeJS.Signals) => boolean

function processGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      if (error.code === "ESRCH") return true
      if (error.code === "EPERM") return false
    }
    throw error
  }
}

export function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  signalGroup: ProcessGroupSignaler = processGroupSignal,
): void {
  if (signalGroup(child.pid, signal)) return
  if (child.exitCode === null) child.kill(signal)
}
