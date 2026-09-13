import { expect, test } from "bun:test"
import type { ContextItem } from "../src/context/contract"
import { selectContextItems } from "../src/context/rank"

function item(
  kind: ContextItem["kind"],
  title: string,
  summary: string,
  authority: ContextItem["authority"] = "canonical",
): ContextItem {
  return {
    kind,
    title,
    summary,
    sourceRefs: [title],
    authority,
    freshness: "not-applicable",
    confidence: "high",
  }
}

test("ranks the relevant structural context before unrelated guidance", () => {
  const result = selectContextItems(
    [
      item("instruction", "General rules", "Use the repository conventions."),
      item("architecture", "Resolver graph", "The resolver calls the parser."),
      item("knowledge", "Old deployment", "The deployment was moved last year."),
    ],
    "resolver",
    10,
  )

  expect(result.items[0]?.title).toBe("Resolver graph")
  expect(result.items).toHaveLength(1)
  expect(result.truncated).toBe(false)
})

test("reports when the deterministic context budget omits sources", () => {
  const result = selectContextItems(
    [
      item("instruction", "First", "x".repeat(2_000)),
      item("instruction", "Second", "y".repeat(2_000)),
    ],
    undefined,
    10,
    4_000,
  )

  expect(result.items).toHaveLength(1)
  expect(result.usedChars).toBeLessThanOrEqual(4_000)
  expect(result.truncated).toBe(true)
})

test("matches query terms at token boundaries and reports serialized size", () => {
  const itemValue = item("knowledge", "Concatenate values", "The value is concatenated safely.")
  const result = selectContextItems([itemValue], "cat", 10, 4_000)
  expect(result.items).toHaveLength(0)
  expect(result.usedChars).toBe(0)

  const selected = selectContextItems([itemValue], "concatenate", 10, 4_000)
  expect(selected.items).toEqual([itemValue])
  expect(selected.usedChars).toBe(JSON.stringify(itemValue).length)
})
