import { readProjectManifest } from "../config"
import { buildContextBundle, refreshProject, serveContextMcp } from "../context/server"
import { diagnoseProject, printDoctorReport } from "../doctor"
import { reconcileKnowledge, syncKnowledge } from "../knowledge/reconcile"
import {
  manifestKnowledgeDirectory,
  promoteKnowledge,
  recordKnowledge,
  rejectKnowledge,
  reviewKnowledge,
} from "../knowledge/store"
import { discoverProject } from "../project/discover"
import { isTrustedKnowledgeDirectory, trustKnowledgeDirectory } from "../trust"
import type { CliCommand } from "./command"

type DoctorCommand = Extract<CliCommand, { readonly kind: "doctor" }>
type ContextCommand = Extract<CliCommand, { readonly kind: "context" }>
type MemoryRecordCommand = Extract<CliCommand, { readonly kind: "memory-record" }>
type MemoryReviewCommand = Extract<CliCommand, { readonly kind: "memory-review" }>
type MemoryDecisionCommand = Extract<
  CliCommand,
  { readonly kind: "memory-promote" | "memory-reject" }
>
type ServeCommand = Extract<CliCommand, { readonly kind: "serve" }>
type KnowledgeCommand = Extract<
  CliCommand,
  { readonly kind: "knowledge-reconcile" | "knowledge-sync" | "knowledge-index" }
>

export async function runDoctorCommand(command: DoctorCommand): Promise<number> {
  const report = await diagnoseProject(command.root ?? process.cwd())
  if (command.json) console.log(JSON.stringify(report))
  else printDoctorReport(report)
  return report.status === "fail" ? 1 : 0
}

export async function runContextCommand(command: ContextCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const bundle = await buildContextBundle(discovery.root, command.query, 20, {
    ...(command.path === undefined ? {} : { path: command.path }),
    ...(command.maxChars === undefined ? {} : { maxChars: command.maxChars }),
  })
  if (command.json) console.log(JSON.stringify(bundle))
  else {
    console.log(`Project: ${bundle.projectRoot}`)
    console.log(`Freshness: ${bundle.freshness.status} (${bundle.freshness.detail})`)
    console.log(
      `Context budget: ${bundle.budget.usedChars}/${bundle.budget.maxChars} characters${
        bundle.budget.truncated ? " (truncated)" : ""
      }`,
    )
    for (const item of bundle.items) console.log(`${item.kind}: ${item.title} - ${item.summary}`)
    for (const warning of bundle.warnings) console.log(`Warning: ${warning}`)
  }
  return 0
}

export async function runMemoryRecordCommand(command: MemoryRecordCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const receipt = await recordKnowledge(discovery.root, {
    kind: command.recordKind,
    title: command.title,
    summary: command.summary,
    ...(command.sourceRefs.length === 0 ? {} : { sourceRefs: command.sourceRefs }),
  })
  if (command.json) console.log(JSON.stringify(receipt))
  else console.log(`Recorded ${receipt.kind} knowledge in ${receipt.path}`)
  return 0
}

export async function runMemoryReviewCommand(command: MemoryReviewCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const review = await reviewKnowledge(discovery.root)
  if (command.json) console.log(JSON.stringify(review))
  else {
    console.log(`Pending: ${review.pending}; conflicts: ${review.conflicts}`)
    for (const record of review.records) {
      console.log(`${record.status}: ${record.path} - ${record.title}`)
      for (const conflict of record.conflicts) console.log(`  conflicts with: ${conflict}`)
    }
  }
  return 0
}

export async function runMemoryDecisionCommand(command: MemoryDecisionCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  if (command.kind === "memory-promote") {
    const receipt = await promoteKnowledge(discovery.root, command.recordPath)
    if (command.json) console.log(JSON.stringify(receipt))
    else
      console.log(
        receipt.action === "conflict"
          ? `Promotion blocked by conflict: ${receipt.conflicts.join(", ")}`
          : `${receipt.action === "exists" ? "Already promoted" : "Promoted"}: ${receipt.targetPath ?? receipt.sourcePath}`,
      )
    return receipt.action === "conflict" ? 1 : 0
  }
  const receipt = await rejectKnowledge(discovery.root, command.recordPath)
  if (command.json) console.log(JSON.stringify(receipt))
  else {
    console.log(`${receipt.action === "exists" ? "Already rejected" : "Rejected"}: ${receipt.path}`)
  }
  return 0
}

export async function runServeCommand(command: ServeCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  await serveContextMcp(discovery.root)
  return 0
}

export async function runKnowledgeCommand(command: KnowledgeCommand): Promise<number> {
  const discovery = await discoverProject(command.root ?? process.cwd())
  const manifest = await readProjectManifest(discovery.root)
  const directory =
    command.knowledgeDirectory ??
    manifestKnowledgeDirectory(manifest) ??
    process.env["CBM_KNOWLEDGE_DIR"]
  if (directory !== undefined && !(await isTrustedKnowledgeDirectory(discovery.root, directory))) {
    if (command.knowledgeDirectory === undefined) {
      throw new Error(
        "External knowledge directory is not trusted; pass --knowledge-dir <path> explicitly",
      )
    }
    await trustKnowledgeDirectory(discovery.root, directory)
  }
  if (command.kind === "knowledge-reconcile") {
    const report = await reconcileKnowledge(discovery.root, directory, command.repositories)
    if (command.json) console.log(JSON.stringify(report))
    else {
      console.log(`Knowledge root: ${report.root}`)
      console.log(`Status: ${report.status}`)
      console.log(`Records: ${report.records}; active: ${report.activeRecords}`)
      for (const issue of report.issues)
        console.log(`${issue.severity}: ${issue.path}: ${issue.message}`)
    }
    return report.status === "fail" ? 1 : 0
  }
  const report = await syncKnowledge(discovery.root, directory, command.repositories, command.write)
  if (command.kind === "knowledge-index") {
    if (
      !command.write &&
      (report.stale.length > 0 || report.upgraded.length > 0 || report.status === "fail")
    ) {
      if (command.json) console.log(JSON.stringify({ command: "knowledge index", sync: report }))
      else {
        console.log(`Knowledge root: ${report.root}`)
        console.log(`Status: ${report.status}`)
        console.log(`Stale: ${report.stale.length}; upgrades: ${report.upgraded.length}`)
      }
      return 1
    }
    if (report.status === "fail") {
      if (command.json) console.log(JSON.stringify({ command: "knowledge index", sync: report }))
      else console.log(`Knowledge reconciliation failed: ${report.issues.length} issue(s)`)
      return 1
    }
    const index = await refreshProject(discovery.root, command.mode ?? "fast")
    const result = { command: "knowledge index", sync: report, index }
    if (command.json) console.log(JSON.stringify(result))
    else {
      console.log(`Knowledge root: ${report.root}`)
      console.log(`Sync: ${command.write ? "updated" : "checked"}`)
      console.log(`Index: ${index.status} (${command.mode ?? "fast"})`)
      console.log(index.detail)
    }
    return 0
  }
  if (command.json) console.log(JSON.stringify(report))
  else {
    console.log(`Knowledge root: ${report.root}`)
    console.log(`Status: ${report.status}`)
    console.log(`Records: ${report.records}; active: ${report.activeRecords}`)
    console.log(
      `${command.write ? "Updated" : "Stale"}: ${command.write ? report.updated.length : report.stale.length}`,
    )
    if (report.upgraded.length > 0) console.log(`Upgrades: ${report.upgraded.length}`)
    if (!command.write) console.log(`Fresh: ${report.fresh}`)
    for (const issue of report.issues)
      console.log(`${issue.severity}: ${issue.path}: ${issue.message}`)
  }
  if (!command.write) {
    return report.stale.length > 0 || report.upgraded.length > 0 || report.status === "fail" ? 1 : 0
  }
  return report.status === "fail" ? 1 : 0
}
