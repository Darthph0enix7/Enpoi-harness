/**
 * enpoi-memory — Stage 4 Consumption: FTS5 retrieval.
 *
 * A3.3: FTS query sanitization (no operator injection / syntax crashes).
 * A3.4: origin-weighted ranking.
 * L2: workspace scoping — `origin = 'compaction'` rows are visible only to a
 * caller working in the cwd recorded in their provenance (configurable).
 * Ranking is coverage-aware: query-term coverage and an exact-phrase hit sort
 * before the weighted BM25 score, and recency plus the caller's project cwd
 * (when provenance records one) act as bounded tie-breakers. The AND miss
 * falls back to OR recall only for rows matching at least two content terms
 * once the query has three or more.
 *
 * Memory is tool-driven: nothing here injects; `memory_search` renders hits.
 *
 * @module dsh-enpoi-memory/retriever
 */
import type { DatabaseSync } from 'node:sqlite'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import type { ClaimRow } from './db'

/** Doc 38 memory parameters — resolved fresh per call (hot-swap). */
export interface MemoryParams {
  retrieverTopK: number
  retrieverCharBudget: number
}

export const MEMORY_PARAM_DEFAULTS: MemoryParams = {
  retrieverTopK: 10,
  retrieverCharBudget: 1200,
}

/**
 * Scope of one memory search.
 * `cwd` is the caller's workspace; `scopeCompaction` applies the
 * compaction-origin workspace predicate when true.
 */
export interface MemoryScope {
  readonly cwd?: string
  readonly scopeCompaction: boolean
}

/** Read memory parameters from `enpoi-orchestration.parameters.memory` (clamped). */
export function getMemoryParams(ctx: unknown): MemoryParams {
  const d = MEMORY_PARAM_DEFAULTS
  try {
    const settings = (ctx as { get?: (name: string) => unknown } | undefined)?.get?.('settings')
    const doc = readOrchestrationDocument(settings as SettingsDocumentReader | undefined)
    const p = (doc?.parameters as { memory?: Partial<MemoryParams> } | undefined)?.memory
    if (p === undefined || typeof p !== 'object') return d
    const clamp = (v: unknown, fallback: number, min: number, max: number): number =>
      typeof v === 'number' && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : fallback
    return {
      retrieverTopK: clamp(p.retrieverTopK, d.retrieverTopK, 1, 20),
      retrieverCharBudget: clamp(p.retrieverCharBudget, d.retrieverCharBudget, 200, 4000),
    }
  } catch {
    return d
  }
}

/** Oracle fix 1: weight by origin+trust, NOT raw source_trust (verified_execution
 * covers keeper AND worker claims — the origin string tells them apart). */
function getOriginWeight(origin: string, trust: string): number {
  if (trust === 'operator' || origin === 'orchestrator') return 1.5
  if (origin.startsWith('worker')) return 1.2
  if (origin === 'keeper') return 1.0
  if (origin === 'legacy') return 1.0
  return 1.0
}

const CATEGORY_BOOST: Record<string, number> = {
  RULES: 1.4,
  CONSTRAINTS: 1.3,
  ARCHITECTURE: 1.2,
  NAMING: 1.1,
  CONFIG_VALUES: 1.0,
  PROJECT: 0.9,
}

/**
 * The SQL fragment + parameters restricting compaction-origin rows to one
 * workspace. `origin != 'compaction'` rows always pass.
 * @param scope - the caller's scope; `undefined` or `scopeCompaction: false`
 *   applies no workspace predicate.
 * @returns the predicate (empty string when unscoped) and its bound value.
 */
export function compactionScopeClause(scope?: MemoryScope): { sql: string; params: string[] } {
  if (scope === undefined || !scope.scopeCompaction) return { sql: '', params: [] }
  return {
    sql: `(c.origin != 'compaction' OR (json_valid(c.provenance) AND json_extract(c.provenance, '$.cwd') = ?))`,
    params: [scope.cwd ?? ''],
  }
}

/** A3.3: tokenize a free-text query into safe FTS5 content terms (grammar words dropped, quoted, AND-joined). */
export function sanitizeFtsQuery(query: string): string {
  const terms = queryTerms(query)
  if (terms.length === 0) return ''
  return terms.map(t => `"${t.replace(/"/g, '')}"`).join(' AND ')
}

/** Split free text into lowercase lookup tokens (2+ letters, digits, `_`, `-`). */
function rawTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
}

/**
 * English grammar words removed from queries before FTS construction, coverage
 * scoring, and phrase detection. They carry no retrieval signal and would
 * otherwise let an OR fallback match unrelated rows.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'been', 'being', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'may', 'me', 'might',
  'more', 'most', 'must', 'my', 'no', 'not', 'now', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'same', 'she',
  'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
])

/**
 * Scoring tokenizer aligned with SQLite unicode61's default fold: lowercase,
 * strip Unicode marks, and split punctuation (including `_` and `-`) so
 * identifiers follow FTS tokenization. Single-character letter/digit tokens
 * are kept because unicode61 indexes them. This is not a full unicode61
 * equivalence claim: unicode61's fold set is broader for some scripts, and
 * near-duplicate Jaccard keeps its own separator-preserving tokenizer.
 */
function scoringTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0)
}

/** Query scoring tokens in rank order after English grammar-word removal; duplicates preserved. */
function queryRankTokens(query: string): string[] {
  return scoringTokens(query).filter(token => !QUERY_STOPWORDS.has(token))
}

/** Deduplicate scoring terms for coverage counting. */
function dedupeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const term of terms) {
    if (seen.has(term)) continue
    seen.add(term)
    unique.push(term)
  }
  return unique
}

/** Bound the pairwise coverage prefilter for an unusually long query. */
const MAX_COVERAGE_FALLBACK_TERMS = 12

/** One quoted FTS term. */
function quotedTerm(term: string): string {
  return `"${term.replace(/"/g, '')}"`
}

/**
 * FTS fallback requiring at least two of the supplied terms: the OR of every
 * two-term AND pair. This filters the candidate window to rows that can pass
 * the coverage gate instead of letting single common terms consume it.
 */
function coverageFallbackMatch(terms: readonly string[]): string {
  const quoted = terms.map(quotedTerm)
  const pairs: string[] = []
  for (let left = 0; left < quoted.length; left += 1) {
    for (let right = left + 1; right < quoted.length; right += 1) {
      pairs.push(`(${quoted[left]} AND ${quoted[right]})`)
    }
  }
  return pairs.join(' OR ')
}

/**
 * Content terms of a free-text query: deduplicated lookup tokens with English
 * grammar words removed.
 * @param query - free-text query.
 * @returns unique content terms in query order.
 */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const token of rawTokens(query)) {
    if (QUERY_STOPWORDS.has(token) || seen.has(token)) continue
    seen.add(token)
    terms.push(token)
  }
  return terms
}

/** Token set used by the near-duplicate comparison (same split as the query terms). */
export function tokenSet(text: string): Set<string> {
  return new Set(rawTokens(text))
}

/**
 * Token-set Jaccard similarity of two facts (intersection / union).
 * Two empty token sets are similar only when both are empty.
 * @param left - first text.
 * @param right - second text.
 * @returns a value in [0, 1].
 */
export function jaccard(left: string, right: string): number {
  const a = tokenSet(left)
  const b = tokenSet(right)
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

interface RankedClaim extends ClaimRow {
  score: number
}

/** Scored row before the public projection: coverage and phrase decide rank. */
interface ScoredClaim extends RankedClaim {
  matched: number
  exactPhrase: boolean
  stamp: number
}

/** One FTS query against `claims`, scoped by the caller's workspace. */
function ftsRows(db: DatabaseSync, match: string, scope?: MemoryScope): Array<ClaimRow & { rank: number }> {
  const filter = compactionScopeClause(scope)
  return db.prepare(`
    SELECT c.*, bm25(claims_fts) AS rank
    FROM claims_fts JOIN claims c ON c.rowid = claims_fts.rowid
    WHERE claims_fts MATCH ? AND c.state IN ('committed','tentative')${filter.sql === '' ? '' : ` AND ${filter.sql}`}
    ORDER BY rank LIMIT 20
  `).all(match, ...filter.params) as unknown as Array<ClaimRow & { rank: number }>
}

/** Bounded weight for a same-project tie-break; relevance still dominates. */
const PROJECT_MATCH_BOOST = 1.1
const PROJECT_MISMATCH_FACTOR = 0.95
/** Recency can move a score by at most this fraction. */
const RECENCY_TIE_BOOST = 0.05
/** Exact full-query phrase factor inside one coverage tier. */
const PHRASE_SCORE_BOOST = 1.5
/** Coverage factor inside one matched-term tier (zero when no unique terms). */
const COVERAGE_SCORE_WEIGHT = 2

/** Project cwd recorded in a claim's provenance, when it is a non-blank string. */
function provenanceCwd(provenance: string): string | undefined {
  if (provenance === '') return undefined
  try {
    const parsed: unknown = JSON.parse(provenance)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const cwd = (parsed as Record<string, unknown>).cwd
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
  } catch {
    // Provenance is display/ranking metadata; malformed JSON never fails a search.
    return undefined
  }
}

/** Bounded project preference: same recorded cwd as the caller, else a small penalty. */
function projectFactor(provenance: string, scopeCwd: string | undefined): number {
  if (scopeCwd === undefined || scopeCwd === '') return 1
  const cwd = provenanceCwd(provenance)
  if (cwd === undefined) return 1
  return cwd === scopeCwd ? PROJECT_MATCH_BOOST : PROJECT_MISMATCH_FACTOR
}

/** Newest candidate in the set gets the full bounded recency boost. */
function recencyFactor(stamp: number, oldest: number, newest: number): number {
  if (newest <= oldest) return 1
  return 1 + RECENCY_TIE_BOOST * ((stamp - oldest) / (newest - oldest))
}

/**
 * Oracle Q4/A3.4: coverage-aware, origin-weighted BM25 search over committed +
 * tentative. The AND pass is precise. When it misses, OR recall keeps only rows
 * matching at least two content terms for queries of three or more terms, so a
 * single unrelated common term cannot become a hit. FTS owns result membership;
 * the approximate JS scorer below ranks those rows and may under-count scripts
 * whose case folding it does not reproduce. Matched-term count and an exact
 * full-query phrase sort first; the weighted score (origin, category, recency,
 * caller-project cwd) settles the remaining order.
 * @param db - the memory database.
 * @param query - free-text query.
 * @param limit - maximum hits; a non-finite or non-positive value returns no hits.
 * @param scope - workspace scope for compaction-origin rows.
 * @returns ranked claims, best first.
 */
export function searchMemory(db: DatabaseSync, query: string, limit = 10, scope?: MemoryScope): RankedClaim[] {
  const rankTerms = queryRankTokens(query)
  const terms = dedupeTerms(rankTerms)
  const match = sanitizeFtsQuery(query)
  if (match === '' || terms.length === 0) return []
  if (!Number.isFinite(limit) || limit < 1) return []
  const take = Math.floor(limit)
  let rows = ftsRows(db, match, scope)
  if (rows.length === 0 && terms.length > 1) {
    const fallbackTerms = terms.slice(0, MAX_COVERAGE_FALLBACK_TERMS)
    const orMatch = terms.length === 2
      ? fallbackTerms.map(quotedTerm).join(' OR ')
      : coverageFallbackMatch(fallbackTerms)
    rows = ftsRows(db, orMatch, scope)
  }
  if (rows.length === 0) return []
  const phrase = rankTerms.join(' ')
  const stamps = rows.map(row => row.committed_at ?? row.created_at)
  const oldest = Math.min(...stamps)
  const newest = Math.max(...stamps)
  return rows
    .map((row): ScoredClaim => {
      const factTokens = scoringTokens(row.fact)
      const factTermSet = new Set(factTokens)
      const matched = terms.reduce((count, term) => count + (factTermSet.has(term) ? 1 : 0), 0)
      const coverage = matched / terms.length
      const exactPhrase = ` ${factTokens.join(' ')} `.includes(` ${phrase} `)
      const stamp = row.committed_at ?? row.created_at
      const relevance = (-(row.rank as unknown as number)) * getOriginWeight(row.origin, row.source_trust) * (CATEGORY_BOOST[row.category] ?? 1.0)
      return {
        ...row,
        matched,
        exactPhrase,
        stamp,
        score: relevance
          * (1 + COVERAGE_SCORE_WEIGHT * coverage)
          * (exactPhrase ? PHRASE_SCORE_BOOST : 1)
          * projectFactor(row.provenance, scope?.cwd)
          * recencyFactor(stamp, oldest, newest),
      }
    })
    .sort((a, b) => b.matched - a.matched
      || Number(b.exactPhrase) - Number(a.exactPhrase)
      || b.score - a.score
      || b.stamp - a.stamp)
    .slice(0, take)
}

/**
 * Existing facts that share FTS terms with `fact`, under the same workspace
 * scope. Used by the compaction-facts subscriber for near-duplicate
 * suppression; candidates are capped (newest first) so one write never scans
 * the whole table.
 * @param db - the memory database.
 * @param fact - the candidate fact text.
 * @param scope - workspace scope for compaction-origin rows.
 * @returns candidate fact texts (committed + tentative claims).
 */
export function nearDuplicateCandidates(db: DatabaseSync, fact: string, scope?: MemoryScope): string[] {
  const terms = [...tokenSet(fact)]
  if (terms.length === 0) return []
  const match = terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
  const filter = compactionScopeClause(scope)
  try {
    const rows = db.prepare(`
      SELECT c.fact FROM claims_fts JOIN claims c ON c.rowid = claims_fts.rowid
      WHERE claims_fts MATCH ? AND c.state IN ('committed','tentative')${filter.sql === '' ? '' : ` AND ${filter.sql}`}
      ORDER BY c.created_at DESC LIMIT 50
    `).all(match, ...filter.params) as unknown as Array<{ fact: string }>
    return rows.map(row => row.fact)
  } catch {
    // A hostile query must never fail the host write path.
    return []
  }
}
