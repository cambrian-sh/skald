#!/usr/bin/env bun

import { runAgentInstall, runAgentList } from "./cli/agents"
import { runBackendCommand } from "./cli/backend"
import { helpText, parseCommand } from "./cli/command"
import {
  runContextCommand,
  runDoctorCommand,
  runKnowledgeCommand,
  runMemoryDecisionCommand,
  runMemoryRecordCommand,
  runMemoryReviewCommand,
  runServeCommand,
} from "./cli/context"
import { runEngineCommand } from "./cli/engine"
import { runClaudeSessionStartHook } from "./cli/hooks"
import { runInit } from "./cli/init"
import { runSetupCommand } from "./cli/setup"
import { ProjectNotFoundError } from "./project/discover"
import { SKALD_VERSION } from "./version"

export async function runCli(args: readonly string[]): Promise<number> {
  const command = parseCommand(args)
  switch (command.kind) {
    case "help":
      console.log(helpText())
      return 0
    case "version":
      console.log(SKALD_VERSION)
      return 0
    case "error":
      console.error(command.message)
      console.error(helpText())
      return 2
    case "backend":
      return runBackendCommand(command.root)
    case "init":
      return runInit(command)
    case "setup":
      return runSetupCommand(command)
    case "hook-claude-session-start":
      return runClaudeSessionStartHook()
    case "serve":
      return runServeCommand(command)
    case "doctor":
      return runDoctorCommand(command)
    case "context":
      return runContextCommand(command)
    case "memory-record":
      return runMemoryRecordCommand(command)
    case "memory-review":
      return runMemoryReviewCommand(command)
    case "memory-promote":
    case "memory-reject":
      return runMemoryDecisionCommand(command)
    case "knowledge-reconcile":
    case "knowledge-sync":
    case "knowledge-index":
      return runKnowledgeCommand(command)
    case "agents-install":
      return runAgentInstall(command)
    case "agents-list":
      return runAgentList(command)
    case "engine-locate":
    case "engine-index":
    case "engine-conformance":
    case "engine-serve":
    case "engine-install":
      return runEngineCommand(command)
    default:
      return assertNever(command)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected CLI command: ${JSON.stringify(value)}`)
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(Bun.argv.slice(2))
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    if (error instanceof Error) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    console.error(String(error))
    process.exitCode = 1
  }
}

if (import.meta.main) void main()
