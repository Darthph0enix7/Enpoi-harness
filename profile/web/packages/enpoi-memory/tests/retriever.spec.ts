import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../src/db'
import { makePipeline } from '../src/pipeline'
import { jaccard, nearDuplicateCandidates, sanitizeFtsQuery, searchMemory, tokenSet } from '../src/retriever'

let db: DatabaseSync

beforeEach(() => {
  const m = require('node:os').tmpdir()
  process.env.DSH_MEMORY_DB = `${m}/enpoi-mem-ret-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  db = openMemoryDb()
})

afterEach(() => {
  db.close()
  try { require('node:fs').unlinkSync(process.env.DSH_MEMORY_DB ?? '') } catch { /* ok */ }
  delete process.env.DSH_MEMORY_DB
})

function compactionProvenance(cwd: string): string {
  return JSON.stringify({
    source: 'compaction',
    sessionId: 'session-x',
    compactionId: 'cmp-1',
    cwd,
    shadowedRange: { start: 1, end: 9 },
    summaryRoute: 'mock/mock',
  })
}

describe('retriever — FTS sanitization (A3.3)', () => {
  it('strips FTS operator characters', () => {
    const q = sanitizeFtsQuery('the "cache" (hot) AND vs OR *wild*:x')
    expect(q).not.toMatch(/[()*:']/) // raw operators stripped (wrapping quotes are FTS-safe)
    expect(q).toContain('"cache"') // quoted safe terms kept
    expect(q).toContain('AND')
  })

  it('empty/too-short query → empty match', () => {
    expect(sanitizeFtsQuery('')).toBe('')
    expect(sanitizeFtsQuery('o')).toBe('') // single char dropped
  })
})

describe('retriever — workspace scoping of compaction facts (L2)', () => {
  beforeEach(async () => {
    const p = makePipeline(db)
    await p.intake([
      { fact: 'cloudflare tunnel id is 9db9e1f7 alpha workspace decision', category: 'ARCHITECTURE' },
    ], { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('/work/a') })
    await p.intake([
      { fact: 'cloudflare tunnel id is 9db9e1f7 beta workspace decision', category: 'ARCHITECTURE' },
    ], { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('/work/b') })
    await p.intake([
      { fact: 'cloudflare tunnel id is 9db9e1f7 operator workspace ruling', category: 'ARCHITECTURE' },
    ], { origin: 'orchestrator', trust: 'operator' })
  })

  it('returns compaction rows for the caller cwd only, and non-compaction rows everywhere', () => {
    const scoped = searchMemory(db, 'cloudflare tunnel id', 10, { cwd: '/work/a', scopeCompaction: true })
    const rowsA = scoped.filter(row => row.origin === 'compaction')
    expect(rowsA).toHaveLength(1)
    expect(JSON.parse(rowsA[0]!.provenance).cwd).toBe('/work/a')
    // The operator fact is not compaction-scoped: it stays visible.
    expect(scoped.some(row => row.origin === 'orchestrator')).toBe(true)

    const rowsB = searchMemory(db, 'cloudflare tunnel id', 10, { cwd: '/work/b', scopeCompaction: true })
    expect(rowsB.filter(row => row.origin === 'compaction')).toHaveLength(1)
    expect(JSON.parse(rowsB.filter(row => row.origin === 'compaction')[0]!.provenance).cwd).toBe('/work/b')

    const rowsC = searchMemory(db, 'cloudflare tunnel id', 10, { cwd: '/work/elsewhere', scopeCompaction: true })
    expect(rowsC.filter(row => row.origin === 'compaction')).toHaveLength(0)
    expect(rowsC.some(row => row.origin === 'orchestrator')).toBe(true)
  })

  it('an unscoped search returns every compaction row', () => {
    const unscoped = searchMemory(db, 'cloudflare tunnel id', 10)
    expect(unscoped.filter(row => row.origin === 'compaction')).toHaveLength(2)
    const explicitlyOff = searchMemory(db, 'cloudflare tunnel id', 10, { cwd: '/work/a', scopeCompaction: false })
    expect(explicitlyOff.filter(row => row.origin === 'compaction')).toHaveLength(2)
  })

  it('a caller without a cwd only sees no-cwd compaction rows', async () => {
    const p = makePipeline(db)
    await p.intake([
      { fact: 'headerless workspace fact about cloudflare tunnel quarantine', category: 'PROJECT' },
    ], { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('') })
    const hits = searchMemory(db, 'quarantine', 10, { scopeCompaction: true })
    expect(hits.filter(row => row.origin === 'compaction')).toHaveLength(1)
    const other = searchMemory(db, 'quarantine', 10, { cwd: '/work/a', scopeCompaction: true })
    expect(other.filter(row => row.origin === 'compaction')).toHaveLength(0)
  })
})

describe('retriever — scoring tokenizer aligns with SQLite unicode61', () => {
  it('splits underscore identifiers for coverage instead of keeping one token', async () => {
    const p = makePipeline(db)
    const fact = 'Jarvis_V2 bootstrap credentials live in the vault'
    await p.intake([{ fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'Jarvis V2 bootstrap settings', 10)

    expect(hits.map(hit => hit.fact)).toContain(fact)
  })

  it('splits hyphenated identifiers and keeps single-character digits', async () => {
    const p = makePipeline(db)
    const fact = 'eu-central-3 deployment'
    await p.intake([{ fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'eu central 3 widget', 10)

    expect(hits.map(hit => hit.fact)).toContain(fact)
  })

  it('folds accents for German and Turkish identifiers without changing near-duplicate tokenization', async () => {
    const p = makePipeline(db)
    const cases = [
      { fact: 'café widget', query: 'cafe widget datei' },
      { fact: 'über widget', query: 'uber widget datei' },
      { fact: 'İstanbul widget', query: 'istanbul widget datei' },
    ]
    for (const entry of cases) {
      await p.intake([{ fact: entry.fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })
    }

    for (const entry of cases) {
      expect(searchMemory(db, entry.query, 10).map(hit => hit.fact)).toContain(entry.fact)
    }
    // The near-duplicate contract keeps `_`/`-` inside tokens.
    expect([...tokenSet('Jarvis_V2 eu-central-3')]).toEqual(['jarvis_v2', 'eu-central-3'])
  })

  it('keeps an FTS-matched long-s spelling that the approximate scorer cannot fold', async () => {
    const p = makePipeline(db)
    const fact = 'ſun marker'
    await p.intake([{ fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'sun marker widget', 10)

    expect(hits.map(hit => hit.fact)).toContain(fact)
  })

  it('keeps an FTS-matched Greek final-sigma spelling that the approximate scorer cannot fold', async () => {
    const p = makePipeline(db)
    const fact = 'ος key'
    await p.intake([{ fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'οσ key widget', 10)

    expect(hits.map(hit => hit.fact)).toContain(fact)
  })

  it('keeps repeated query tokens for phrase matching while coverage deduplicates them', async () => {
    const p = makePipeline(db)
    await p.intake([
      { fact: 'cache cache key', category: 'PROJECT' },
      { fact: 'cache key', category: 'PROJECT' },
    ], { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'cache cache key', 10)

    expect(hits[0]!.fact).toBe('cache cache key')
  })

  it('prefilters coverage so single-term candidates cannot consume the fallback window', async () => {
    const p = makePipeline(db)
    const common: Array<{ fact: string; category: string }> = []
    for (let index = 0; index < 25; index += 1) {
      common.push({ fact: `alpha common fact ${index}`, category: 'PROJECT' })
      common.push({ fact: `beta common fact ${index}`, category: 'PROJECT' })
      common.push({ fact: `gamma common fact ${index}`, category: 'PROJECT' })
    }
    const relevant = `beta gamma ${'filler '.repeat(30)}relevant`
    common.push({ fact: relevant, category: 'PROJECT' })
    await p.intake(common, { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'alpha beta gamma', 10)

    expect(hits.map(hit => hit.fact)).toEqual([relevant])
  })
})

describe('retriever — near-duplicate primitives', () => {
  it('tokenSet drops short tokens and lowercases', () => {
    expect([...tokenSet('The Cache key is A-1')]).toEqual(['the', 'cache', 'key', 'is', 'a-1'])
    expect(tokenSet('o x yz')).toEqual(new Set(['yz']))
  })

  it('jaccard is 1 for identical token sets and 0 for disjoint ones', () => {
    expect(jaccard('redis key prefix', 'prefix key redis')).toBe(1)
    expect(jaccard('redis key prefix', 'cloudflare tunnel id')).toBe(0)
    expect(jaccard('', '')).toBe(1)
  })

  it('nearDuplicateCandidates shares the workspace scope filter', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'the archive bucket is eu-central-3', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('/work/a') })
    const local = nearDuplicateCandidates(db, 'the archive bucket is eu-central-3', { cwd: '/work/a', scopeCompaction: true })
    expect(local).toContain('the archive bucket is eu-central-3')
    const foreign = nearDuplicateCandidates(db, 'the archive bucket is eu-central-3', { cwd: '/work/b', scopeCompaction: true })
    expect(foreign).toEqual([])
  })
})

describe('retriever — coverage and bounded tie-break ranking', () => {
  it('ranks a multi-term project fact and excludes unrelated single common terms from OR fallback', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'Jarvis_V2 bootstrap phase0 credentials live in the vault', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    await p.intake([{ fact: 'RWTH CLAIX credentials are issued by the university', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    await p.intake([{ fact: 'the skills loader wrote unrelated planning notes', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'Jarvis_V2 bootstrap phase0 credentials planning', 10, { cwd: '/work/jarvis', scopeCompaction: true })

    expect(hits[0]!.fact).toContain('Jarvis_V2')
    expect(hits.some(hit => hit.fact.startsWith('RWTH'))).toBe(false)
    expect(hits.some(hit => hit.fact.startsWith('the skills loader'))).toBe(false)
  })

  it('handles ordinary natural-language wording by dropping grammar words', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'Jarvis_V2 bootstrap credentials live in the vault', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    await p.intake([{ fact: 'RWTH CLAIX credentials rotate every year', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'what did we decide about the Jarvis_V2 bootstrap credentials?', 10)

    expect(hits[0]!.fact).toBe('Jarvis_V2 bootstrap credentials live in the vault')
    expect(hits.some(hit => hit.fact.startsWith('RWTH'))).toBe(false)
  })

  it('prefers an exact query phrase over the same terms scattered', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'bootstrap phase0 credentials planning for Jarvis_V2', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    await p.intake([{ fact: 'planning notes put credentials after phase0 bootstrap', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })

    const hits = searchMemory(db, 'bootstrap phase0 credentials planning', 10)

    expect(hits).toHaveLength(2)
    expect(hits[0]!.fact).toBe('bootstrap phase0 credentials planning for Jarvis_V2')
  })

  it('uses recency only as a bounded tie-break between otherwise equal coverage', async () => {
    const p = makePipeline(db)
    const newer = await p.intake([{ fact: 'alpha fact project newer', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    const older = await p.intake([{ fact: 'alpha fact project older', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })
    db.prepare('UPDATE claims SET created_at = ?, committed_at = ? WHERE id = ?').run(2_000, 2_000, newer[0]!.id)
    db.prepare('UPDATE claims SET created_at = ?, committed_at = ? WHERE id = ?').run(1_000, 1_000, older[0]!.id)

    const hits = searchMemory(db, 'fact project', 10)

    expect(hits.map(hit => hit.fact)).toEqual(['alpha fact project newer', 'alpha fact project older'])
  })

  it('prefers the caller project cwd recorded in provenance as a bounded tie-break', async () => {
    const p = makePipeline(db)
    const local = await p.intake([{ fact: 'alpha fact project local', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator', provenance: JSON.stringify({ source: 'memory_save', sessionId: 's1', cwd: '/work/a' }) })
    const foreign = await p.intake([{ fact: 'alpha fact project foreign', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator', provenance: JSON.stringify({ source: 'memory_save', sessionId: 's2', cwd: '/work/b' }) })
    db.prepare('UPDATE claims SET created_at = 1_000, committed_at = 1_000 WHERE id IN (?, ?)').run(local[0]!.id, foreign[0]!.id)

    expect(searchMemory(db, 'fact project', 10, { cwd: '/work/a', scopeCompaction: true })[0]!.fact)
      .toBe('alpha fact project local')
    expect(searchMemory(db, 'fact project', 10, { cwd: '/work/b', scopeCompaction: true })[0]!.fact)
      .toBe('alpha fact project foreign')
  })

  it('bounds OR-fallback recall to rows covering at least two content terms and respects the limit', async () => {
    const p = makePipeline(db)
    for (const fact of ['alpha beta one', 'beta gamma two', 'alpha gamma three', 'delta only common term']) {
      await p.intake([{ fact, category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })
    }

    const hits = searchMemory(db, 'alpha beta gamma delta', 2)

    expect(hits).toHaveLength(2)
    expect(hits.every(hit => hit.fact !== 'delta only common term')).toBe(true)
  })

  it('keeps compaction workspace scoping unchanged under coverage ranking', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'Jarvis_V2 bootstrap credentials alpha workspace', category: 'ARCHITECTURE' }],
      { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('/work/a') })
    await p.intake([{ fact: 'Jarvis_V2 bootstrap credentials beta workspace', category: 'ARCHITECTURE' }],
      { origin: 'compaction', trust: 'verified_execution', provenance: compactionProvenance('/work/b') })

    const hits = searchMemory(db, 'Jarvis_V2 bootstrap credentials planning', 10, { cwd: '/work/a', scopeCompaction: true })

    expect(hits.filter(hit => hit.origin === 'compaction')).toHaveLength(1)
    expect(JSON.parse(hits.find(hit => hit.origin === 'compaction')!.provenance).cwd).toBe('/work/a')
  })

  it('returns no hits for a non-finite or non-positive limit instead of slicing from the end', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'archive bucket alpha', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' })

    expect(searchMemory(db, 'archive bucket', -1)).toEqual([])
    expect(searchMemory(db, 'archive bucket', Number.NaN)).toEqual([])
    expect(searchMemory(db, 'archive bucket', 0)).toEqual([])
    expect(searchMemory(db, 'archive bucket', 1)).toHaveLength(1)
  })
})
