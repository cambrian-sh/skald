import type { ContextItem } from "./contract"

export const DEFAULT_CONTEXT_MAX_CHARS = 48_000
const MIN_CONTEXT_MAX_CHARS = 4_000
const MAX_CONTEXT_MAX_CHARS = 1_000_000

export type ContextSelection = {
  readonly items: readonly ContextItem[]
  readonly usedChars: number
  readonly truncated: boolean
}

function tokenize(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term, index, values) => term.length > 0 && values.indexOf(term) === index)
}

function queryTerms(query: string | undefined): readonly string[] {
  return query === undefined ? [] : tokenize(query)
}

function kindWeight(kind: ContextItem["kind"]): number {
  switch (kind) {
    case "architecture":
      return 400
    case "instruction":
      return 300
    case "skill":
      return 200
    case "knowledge":
      return 100
  }
}

function relevance(item: ContextItem, terms: readonly string[], position: number): number {
  let score = kindWeight(item.kind) - position / 1000
  if (item.authority === "canonical") score += 30
  if (item.authority === "session") score += 10
  if (item.freshness === "stale") score -= 30
  if (item.freshness === "unknown") score -= 10
  const title = new Set(tokenize(item.title))
  const summary = new Set(tokenize(item.summary))
  const sources = new Set(tokenize(item.sourceRefs.join(" ")))
  for (const term of terms) {
    if (title.has(term)) score += 90
    if (summary.has(term)) score += 30
    if (sources.has(term)) score += 10
  }
  return score
}

function matches(item: ContextItem, terms: readonly string[]): boolean {
  const searchable = new Set(tokenize(`${item.title} ${item.summary} ${item.sourceRefs.join(" ")}`))
  return terms.some((term) => searchable.has(term))
}

function itemSize(item: ContextItem): number {
  return JSON.stringify(item).length
}

export function selectContextItems(
  items: readonly ContextItem[],
  query: string | undefined,
  limit: number,
  maxChars: number = DEFAULT_CONTEXT_MAX_CHARS,
): ContextSelection {
  const terms = queryTerms(query)
  const maxItems = Math.max(1, Math.min(50, Math.floor(limit)))
  const budget = Math.max(
    MIN_CONTEXT_MAX_CHARS,
    Math.min(MAX_CONTEXT_MAX_CHARS, Math.floor(maxChars)),
  )
  const ranked = items
    .map((item, position) => ({ item, score: relevance(item, terms, position), position }))
    .filter(({ item }) => terms.length === 0 || matches(item, terms))
    .sort((left, right) => right.score - left.score || left.position - right.position)
  const selected: ContextItem[] = []
  let usedChars = 0
  let truncated = ranked.length > maxItems
  for (const candidate of ranked) {
    if (selected.length >= maxItems) break
    const size = itemSize(candidate.item)
    if (usedChars + size > budget) {
      truncated = true
      continue
    }
    selected.push(candidate.item)
    usedChars += size
  }
  if (selected.length < ranked.length) truncated = true
  return { items: selected, usedChars, truncated }
}
