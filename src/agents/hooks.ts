import { resolve } from "node:path"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"

import { ConfigParseError, ConfigShapeError } from "../errors"
import { readManagedFile, writeManagedFile } from "../fs/safe-file"
import type { McpServerDefinition } from "./mcp"

const CLAUDE_SETTINGS_PATH = ".claude/settings.json"

type JsonObject = Record<string, unknown>

export type HookConfigResult = {
  readonly action: "created" | "updated" | "exists" | "would_create" | "would_update"
  readonly path: string
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSettings(contents: string): JsonObject {
  const errors: ParseError[] = []
  const value: unknown = parse(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ConfigParseError(CLAUDE_SETTINGS_PATH, "JSON or JSONC")
  if (!isObject(value)) throw new ConfigShapeError(CLAUDE_SETTINGS_PATH, "root must be an object")
  return value
}

function hasSkaldHook(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group["hooks"]) &&
      group["hooks"].some(
        (hook) =>
          isObject(hook) &&
          hook["type"] === "command" &&
          typeof hook["command"] === "string" &&
          hook["command"].includes(".skald/context-runtime") &&
          hook["command"].includes("hook claude-session-start"),
      ),
  )
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function sessionStartCommand(
  projectRoot: string,
  contextServer: McpServerDefinition | undefined,
): string {
  const server =
    contextServer ??
    ({
      command: process.execPath,
      args: [resolve(projectRoot, ".skald/context-runtime.mjs"), "serve"],
    } satisfies McpServerDefinition)
  const args = [...server.args]
  const serveIndex = args.lastIndexOf("serve")
  if (serveIndex >= 0) args[serveIndex] = "hook"
  else args.push("hook")
  args.push("claude-session-start")
  return [server.command, ...args].map(shellWord).join(" ")
}

function sessionStartHook(command: string): JsonObject {
  return {
    matcher: "startup|resume|clear|compact",
    hooks: [{ type: "command", command }],
  }
}

export async function ensureClaudeSessionHook(
  projectRoot: string,
  dryRun: boolean,
  contextServer?: McpServerDefinition,
): Promise<HookConfigResult> {
  const command = sessionStartCommand(projectRoot, contextServer)
  const existing = await readManagedFile(projectRoot, CLAUDE_SETTINGS_PATH)
  if (!existing.exists) {
    if (dryRun) return { action: "would_create", path: CLAUDE_SETTINGS_PATH }
    const contents = `${JSON.stringify({ hooks: { SessionStart: [sessionStartHook(command)] } }, null, 2)}\n`
    const result = await writeManagedFile(projectRoot, CLAUDE_SETTINGS_PATH, contents)
    return { action: result === "created" ? "created" : "exists", path: CLAUDE_SETTINGS_PATH }
  }
  const contents = existing.contents ?? ""
  const config = parseSettings(contents)
  const hooks = config["hooks"]
  if (hooks !== undefined && !isObject(hooks)) {
    throw new ConfigShapeError(CLAUDE_SETTINGS_PATH, "hooks must be an object")
  }
  const sessionStart = hooks === undefined ? undefined : hooks["SessionStart"]
  if (sessionStart !== undefined && !Array.isArray(sessionStart)) {
    throw new ConfigShapeError(CLAUDE_SETTINGS_PATH, "hooks.SessionStart must be an array")
  }
  if (hasSkaldHook(sessionStart)) return { action: "exists", path: CLAUDE_SETTINGS_PATH }
  const next =
    sessionStart === undefined
      ? [sessionStartHook(command)]
      : [...sessionStart, sessionStartHook(command)]
  const edits = [
    {
      path: ["hooks", "SessionStart"],
      value: next,
    },
  ]
  if (dryRun) return { action: "would_update", path: CLAUDE_SETTINGS_PATH }
  const nextContents = edits.reduce(
    (current, edit) =>
      applyEdits(
        current,
        modify(current, edit.path, edit.value, {
          formattingOptions: {
            eol: contents.includes("\r\n") ? "\r\n" : "\n",
            insertFinalNewline: true,
            insertSpaces: true,
            tabSize: 2,
          },
        }),
      ),
    contents,
  )
  const result = await writeManagedFile(projectRoot, CLAUDE_SETTINGS_PATH, nextContents)
  return { action: result === "updated" ? "updated" : "exists", path: CLAUDE_SETTINGS_PATH }
}

export const claudeSessionStartCommand = "hook claude-session-start"
