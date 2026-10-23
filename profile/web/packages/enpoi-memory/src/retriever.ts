/**
 * enpoi-memory — Stage 4 Consumption: FTS5 retrieval.
 *
 * A3.3: FTS query sanitization (no operator injection / syntax crashes).
 * A3.4: origin-weighted ranking.
 * L2: workspace scoping — `origin = 'compaction'` rows are visible only to a
 * caller working in the cwd recorded in their provenance (configurable).
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

/** A3.3: tokenize a free-text query into safe FTS5 terms (quoted phrases, AND-joined). */
export function sanitizeFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
  if (terms.length === 0) return ''
  return terms.map(t => `"${t.replace(/"/g, '')}"`).join(' AND ')
}

/** Token set used by the near-duplicate comparison (same split as the query terms). */
export function tokenSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map(t => t.trim()).filter(t => t.length >= 2),
  )
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

/**
 * Oracle Q4/A3.4: origin-weighted BM25 search over committed + tentative.
 * AND first (precise); if nothing matches (natural-language queries rarely have
 * every term in ONE row), fall back to OR recall.
 * @param db - the memory database.
 * @param query - free-text query.
 * @param limit - maximum hits.
 * @param scope - workspace scope for compaction-origin rows.
 * @returns ranked claims, best first.
 */
export function searchMemory(db: DatabaseSync, query: string, limit = 10, scope?: MemoryScope): RankedClaim[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map(t => t.trim()).filter(t => t.length >= 2)
  const match = sanitizeFtsQuery(query)
  if (match === '') return []
  let rows = ftsRows(db, match, scope)
  if (rows.length === 0 && terms.length > 1) {
    const orMatch = terms.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
    rows = ftsRows(db, orMatch, scope)
  }
  return rows
    .map(r => ({
      ...r,
      score: (-(r.rank as unknown as number)) * getOriginWeight(r.origin, r.source_trust) * (CATEGORY_BOOST[r.category] ?? 1.0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
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
