import { readConfiguredMcpServer } from "../config"
import { attestExecutableMcpServer, runMcpEngine } from "../engine"
import { discoverProject } from "../project/discover"
import { isTrustedMcpExecutable } from "../trust"

export async function runBackendCommand(root: string | undefined): Promise<number> {
  const discovery = await discoverProject(root ?? process.cwd())
  const configured = await readConfiguredMcpServer(discovery.root)
  if (configured === undefined) {
    throw new Error("No configured MCP backend is available for this project")
  }
  const attested = await attestExecutableMcpServer(discovery.root, configured, true)
  if (attested === undefined || !(await isTrustedMcpExecutable(discovery.root, attested))) {
    throw new Error("The configured MCP backend is unavailable or not trusted")
  }
  return runMcpEngine(discovery.root, { ...attested, trust: "explicit" }, [])
}
