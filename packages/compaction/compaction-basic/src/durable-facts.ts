/**
 * Grammar and parser for the `## Durable Facts` section of a model-written
 * compaction summary.
 *
 * Pure and dependency-free: the compaction backend writes the section, the
 * memory plugin reads it back from `compaction/summary`, and both sides share
 * this one contract (allowed direction: enpoi-memory imports this subpath;
 * this package never imports enpoi-memory).
 *
 * @module @deepseek-ai/dsh-compaction-basic/durable-facts
 */

/** Exact Markdown heading that opens the durable-facts section. */
export const DURABLE_FACTS_HEADING = '## Durable Facts'

/** Fact kinds the summarizer is allowed to emit. */
export const DURABLE_FACT_KINDS = ['decision', 'constraint', 'requirement', 'fact'] as const

/** One classified durable fact. */
export type DurableFactKind = typeof DURABLE_FACT_KINDS[number]

/** Longest accepted fact text; longer items are dropped, never truncated. */
export const DURABLE_FACT_MAX_CHARS = 400

/** One self-contained durable fact parsed from a summary. */
export interface DurableFact {
  readonly kind: DurableFactKind
  readonly text: string
}

/** One parsed item; the kind capture is validated against the union below. */
const ITEM_PATTERN = /^\s*[-*]\s*\[(decision|constraint|requirement|fact)\]\s+(.+?)\s*$/i

/** Kind membership check for the case-insensitive capture. */
function isDurableFactKind(value: string): value is DurableFactKind {
  return (DURABLE_FACT_KINDS as readonly string[]).includes(value)
}

/**
 * Parse the Durable Facts section of one model-written summary (text blocks
 * joined with '').
 *
 * Never throws. Returns `[]` when the section is absent, `(none)`, or
 * malformed. The section ends at the next line starting with `## ` or the end
 * of the text. Items match
 * `/^\s*[-*]\s*\[(decision|constraint|requirement|fact)\]\s+(.+?)\s*$/i`;
 * item whitespace is collapsed, items longer than {@link DURABLE_FACT_MAX_CHARS}
 * are dropped, case-insensitive exact duplicates are removed, and insertion
 * order is kept.
 * @param summaryText - the complete summary text written by the model.
 * @returns the parsed facts in emission order; never throws.
 */
export function parseDurableFacts(summaryText: string): DurableFact[] {
  try {
    if (typeof summaryText !== 'string' || summaryText.length === 0) return []
    const lines = summaryText.split(/\r?\n/)
    const facts: DurableFact[] = []
    const seen = new Set<string>()
    let inSection = false
    // A fact may be wrapped by the model across physical lines; continuation
    // lines (never a bullet or heading) join the item until a blank line.
    let pending: { kind: DurableFactKind; parts: string[] } | undefined
    const flush = (): void => {
      if (pending === undefined) return
      const text = pending.parts.join(' ').replace(/\s+/g, ' ').trim()
      const kind = pending.kind
      pending = undefined
      if (text.length === 0 || text.length > DURABLE_FACT_MAX_CHARS) return
      if (text.toLowerCase() === '(none)') return
      const dedupeKey = `${kind}\u0000${text.toLowerCase()}`
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      facts.push({ kind, text })
    }
    for (const line of lines) {
      if (!inSection) {
        if (line.trim() === DURABLE_FACTS_HEADING) inSection = true
        continue
      }
      // The section ends at the next Markdown heading of the same or higher level.
      if (line.startsWith('## ')) break
      if (line.trim() === '') {
        flush()
        continue
      }
      const match = ITEM_PATTERN.exec(line)
      if (match === null) {
        // Wrapped prose belongs to the item above; a new bullet does not.
        if (pending !== undefined && !/^\s*[-*]/.test(line)) pending.parts.push(line.trim())
        continue
      }
      flush()
      const rawKind = match[1]
      const rawText = match[2]
      if (rawKind === undefined || rawText === undefined) continue
      const kind = rawKind.toLowerCase()
      if (!isDurableFactKind(kind)) continue
      pending = { kind, parts: [rawText] }
    }
    flush()
    return facts
  } catch {
    // Hostile input (a Proxy, a throwing coercion) must never fail a host path.
    return []
  }
}
