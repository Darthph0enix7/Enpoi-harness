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
