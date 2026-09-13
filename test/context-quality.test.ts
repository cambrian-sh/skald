import { expect, test } from "bun:test"
import type { ContextItem } from "../src/context/contract"
import { selectContextItems } from "../src/context/rank"

type BenchmarkCase = {
  readonly query: string
  readonly expected: string
}

const items: readonly ContextItem[] = [
  {
    kind: "architecture",
    title: "Resolver architecture",
    summary: "The resolver calls the parser and normalizes graph edges.",
    sourceRefs: ["src/resolver.ts"],
    authority: "canonical",
    freshness: "fresh",
    confidence: "high",
  },
  {
    kind: "knowledge",
    title: "Transport boundary",
    summary: "MCP transport remains the stable boundary for backend calls.",
    sourceRefs: ["knowledge/adrs/transport.md"],
    authority: "canonical",
    freshness: "fresh",
    confidence: "high",
  },
  {
    kind: "instruction",
    title: "Verification rules",
    summary: "Verify source files before relying on a discovery.",
    sourceRefs: ["AGENTS.md"],
    authority: "canonical",
    freshness: "not-applicable",
    confidence: "high",
  },
  {
    kind: "knowledge",
    title: "Retired resolver note",
    summary: "The old resolver path is no longer active.",
    sourceRefs: ["knowledge/old-resolver.md"],
    authority: "canonical",
    freshness: "stale",
    confidence: "low",
  },
]

const cases: readonly BenchmarkCase[] = [
  { query: "resolver", expected: "Resolver architecture" },
  { query: "transport", expected: "Transport boundary" },
  { query: "verification", expected: "Verification rules" },
]

test("keeps the context ranking benchmark precise and deterministic", () => {
  const reciprocalRanks: number[] = cases.map(({ query, expected }) => {
    const result = selectContextItems(items, query, 10, 4_000)
    const rank = result.items.findIndex((item) => item.title === expected)
    expect(rank).toBe(0)
    return rank === 0 ? 1 : 0
  })

  const meanReciprocalRank =
    reciprocalRanks.reduce((total, score) => total + score, 0) / reciprocalRanks.length
  expect(meanReciprocalRank).toBe(1)
})
