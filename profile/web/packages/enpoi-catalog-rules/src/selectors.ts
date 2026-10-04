/**
 * enpoi-catalog-rules — group selectors over the live catalogue.
 *
 * A model group (chain) may carry an explicit ordered member list plus
 * selectors. Selectors are evaluated against the live catalogue whenever the
 * chain or the picker resolves, so the hourly models.dev refresh cannot leave
 * curation stale. Matches are ordered best-first: known-cheapest price, then
 * larger context window, then provider/model id.
 *
 * `adopt` (default false) adopts the matches present at first evaluation and
 * holds newer matches as preview-only candidates; `true` opts in to continuous
 * adoption of new matches — auto-adoption is opt-in and announced.
 */

import {
  describePredicate, evaluatePredicate, isRecord, parseCatalogPredicate, resolvePrivacy,
  type CatalogEntry, type CatalogPredicate, type PrivacyOverrides,
} from './rules.ts'

/** One ordered selector inside a group/chain definition. */
export interface GroupSelector {
  /** Predicate clauses over catalogue entries (ANDed). */
  when: CatalogPredicate
  /** Continuous auto-adoption of new matches: opt-in (true), default false. */
  adopt?: boolean
  /** Operator-facing label used in previews and warnings. */
  label?: string
}

/** One resolved selector match. */
export interface SelectorMatch {
  /** Provider route id. */
  provider: string
  /** Model id. */
  model: string
}

/** One selector evaluation against a catalogue snapshot. */
export interface SelectorExpansion {
  /** Matched links, best-first, deduplicated. */
  links: readonly SelectorMatch[]
  /** Number of matched entries before dedupe. */
  matched: number
  /** Discipline warnings (an empty selector warns rather than silently emptying). */
  warnings: readonly string[]
}

/**
 * Parse one selector from untrusted data. `when` must be a non-array object;
 * `adopt` defaults to false (auto-adoption is opt-in); a blank label is dropped.
 * @param raw - the raw selector entry.
 * @param warn - warning sink for malformed entries.
 * @returns the parsed selector, or undefined when unusable.
 */
export function parseGroupSelector(raw: unknown, warn: (line: string) => void): GroupSelector | undefined {
  if (!isRecord(raw)) {
    warn('selector is not an object — ignored\n')
    return undefined
  }
  if (!isRecord(raw.when)) {
    warn('selector has no "when" object — ignored\n')
    return undefined
  }
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : undefined
  const warnings: string[] = []
  const when = parseCatalogPredicate(raw.when, 'selector', warnings)
  if (describePredicate(when) === 'empty predicate') {
    warn('selector has no recognized predicate clauses — ignored\n')
    return undefined
  }
  for (const line of warnings) warn(`${line}\n`)
  return Object.freeze({
    when: Object.freeze(when),
    adopt: raw.adopt === true,
    ...(label !== undefined ? { label } : {}),
  })
}

/** The worst-case known price of one entry (`max` of input/output), or undefined. */
function knownPrice(entry: CatalogEntry): number | undefined {
  const values = [entry.cost?.input, entry.cost?.output].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length === 0 ? undefined : Math.max(...values)
}

/**
 * Best-first comparator: known-cheapest price, then larger context, then id.
 * Unknown price/context sort after every known value.
 * @param left - ranked match.
 * @param right - ranked match.
 * @returns negative when the left match is better.
 */
function compareMatches(left: { entry: CatalogEntry }, right: { entry: CatalogEntry }): number {
  const leftPrice = knownPrice(left.entry)
  const rightPrice = knownPrice(right.entry)
  if (leftPrice !== rightPrice) {
    if (leftPrice === undefined) return 1
    if (rightPrice === undefined) return -1
    return leftPrice - rightPrice
  }
  const leftContext = left.entry.contextWindow
  const rightContext = right.entry.contextWindow
  if (leftContext !== rightContext) {
    if (leftContext === undefined) return 1
    if (rightContext === undefined) return -1
    return rightContext - leftContext
  }
  if (left.entry.provider !== right.entry.provider) return left.entry.provider.localeCompare(right.entry.provider)
  return left.entry.id.localeCompare(right.entry.id)
}

/** `provider/model` key of one match. */
export function selectorMatchKey(match: SelectorMatch): string {
  return `${match.provider}/${match.model}`
}

/**
 * Expand one selector against a catalogue snapshot.
 * @param selector - parsed selector.
 * @param entries - live catalogue snapshot.
 * @param privacy - document privacy overrides (merged with the curated seed).
 * @returns best-first matches, the raw match count, and warnings.
 */
export function expandSelector(
  selector: GroupSelector,
  entries: readonly CatalogEntry[],
  privacy?: PrivacyOverrides,
): SelectorExpansion {
  const matched: CatalogEntry[] = []
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, privacy)
    if (evaluatePredicate(entry, selector.when, verdict).matched) matched.push(entry)
  }
  const unique = new Map<string, CatalogEntry>()
  for (const entry of matched) {
    const key = `${entry.provider}/${entry.id}`
    if (!unique.has(key)) unique.set(key, entry)
  }
  const ranked = [...unique.values()].sort((left, right) => compareMatches({ entry: left }, { entry: right }))
  const links = ranked.map(entry => Object.freeze({ provider: entry.provider, model: entry.id }))
  const warnings: string[] = []
  if (links.length === 0) {
    const name = selector.label ?? describePredicate(selector.when)
    warnings.push(`selector "${name}" (${describePredicate(selector.when)}) matched no catalogue entries — group unchanged`)
  }
  return { links: Object.freeze(links), matched: matched.length, warnings: Object.freeze(warnings) }
}

/**
 * Describe one selector for previews and announcements.
 * @param selector - parsed selector.
 * @returns the label or predicate summary.
 */
export function describeSelector(selector: GroupSelector): string {
  return selector.label ?? describePredicate(selector.when)
}
