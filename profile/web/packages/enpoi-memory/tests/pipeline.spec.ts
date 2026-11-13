import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../src/db'
import { makePipeline } from '../src/pipeline'
import { searchMemory } from '../src/retriever'

let db: DatabaseSync
let tmp: string

beforeEach(() => {
  const m = require('node:os').tmpdir()
  const p = `${m}/enpoi-mem-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  process.env.DSH_MEMORY_DB = p
  db = openMemoryDb()
})

afterEach(() => {
  db.close()
  try { require('node:fs').unlinkSync(process.env.DSH_MEMORY_DB ?? '') } catch { /* ok */ }
  delete process.env.DSH_MEMORY_DB
})

/** Source record written by the compaction-facts subscriber after a clean endblock. */
function compactionSourceRecord(compactionId = 'c1'): string {
  return JSON.stringify({
    source: 'compaction',
    sessionId: 's1',
    compactionId,
    cwd: '/work/a',
    shadowedRange: { start: 1, end: 2 },
  })
}

/** Source record fix14 writes for a keeper batch after model settlement and live ownership check. */
function keeperSourceRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: 'keeper',
    sessionId: 'session-1',
    batchBasedOnSeq: 3,
    settled: true,
    ...overrides,
  })
}

/** Insert a tentative row with a raw source record (including SQL NULL) for reconcile cases. */
function insertTentative(id: string, sourceRecord: string | null, origin = 'compaction'): void {
  db.prepare(
    `INSERT INTO claims (id, fact, category, tags, state, source_trust, origin, provenance, created_at, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `fact ${id}`, 'PROJECT', '', 'tentative', 'untrusted_external', origin, sourceRecord, Date.now(), null)
}

describe('pipeline — CBDC state machine (I10)', () => {
  it('operator intake → committed immediately', async () => {
    const p = makePipeline(db)
    const rows = await p.intake([{ fact: 'the sky is blue', category: 'ARCHITECTURE' }], { origin: 'orchestrator', trust: 'operator' })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('committed')
  })

  it('untrusted intake → tentative, never auto-graduates', async () => {
    const p = makePipeline(db)
    const rows = await p.intake([{ fact: 'api endpoint x', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'untrusted_external' })
    expect(rows[0]!.state).toBe('tentative')
    const g = await p.graduate(rows[0]!.id)
    expect(g?.state).toBe('committed')
    expect(g?.source_trust).toBe('untrusted_external')
  })

  it('parentAborted → orphaned_cancelled (absorbing)', async () => {
    const p = makePipeline(db)
    const rows = await p.intake([{ fact: 'fact from dead run', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'verified_execution', parentAborted: true })
    expect(rows[0]!.state).toBe('orphaned_cancelled')
    const g = await p.graduate(rows[0]!.id)
    expect(g).toBeNull() // terminal
  })

  it('rescind is terminal; re-observed fact stays rescinded', async () => {
    const p = makePipeline(db)
    const rows = await p.intake([{ fact: 'obsolete rule', category: 'RULES' }], { origin: 'orchestrator', trust: 'operator' })
    await p.rescind(rows[0]!.id, 'test')
    const again = await p.intake([{ fact: 'obsolete rule', category: 'RULES' }], { origin: 'orchestrator', trust: 'operator' })
    expect(again).toHaveLength(0)
  })

  it('dedupe: same fact+category → no duplicate', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'redis key pattern', category: 'ARCHITECTURE' }], { origin: 'orchestrator', trust: 'operator' })
    const again = await p.intake([{ fact: 'redis key pattern', category: 'ARCHITECTURE' }], { origin: 'keeper', trust: 'verified_execution' })
    expect(again).toHaveLength(0)
  })

  it('>400 char facts rejected; empty rejected', async () => {
    const p = makePipeline(db)
    const long = await p.intake([{ fact: 'x'.repeat(401), category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })
    expect(long).toHaveLength(0)
    const empty = await p.intake([{ fact: '   ', category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })
    expect(empty).toHaveLength(0)
  })

  it('keeper category boundaries: RULES → PROJECT (A3.4)', async () => {
    const p = makePipeline(db)
    const rows = await p.intake([{ fact: 'must never restart', category: 'RULES' }], { origin: 'keeper', trust: 'verified_execution' })
    expect(rows[0]!.category).toBe('PROJECT')
  })

  it('operator facts cannot be superseded by keeper claims (A3.4)', async () => {
    const p = makePipeline(db)
    const ops = await p.intake([{ fact: 'the flag is off', category: 'CONSTRAINTS' }], { origin: 'orchestrator', trust: 'operator' })
    const keeper = await p.intake([{ fact: 'the flag is off', category: 'CONSTRAINTS' }], { origin: 'keeper', trust: 'verified_execution' })
    expect(keeper).toHaveLength(0)
    expect(ops[0]!.state).toBe('committed')
  })

  it('operator promotes a tentative claim; orphan revival on successful re-observation (Oracle fix 2)', async () => {
    const p = makePipeline(db)
    // untrusted worker files → tentative
    await p.intake([{ fact: 'the endpoint is x', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'untrusted_external' })
    const rows = p.list()
    expect(rows[0]!.state).toBe('tentative')
    // operator re-save of the same fact → promotes to committed (operator authority)
    const promoted = await p.intake([{ fact: 'the endpoint is x', category: 'PROJECT' }], { origin: 'orchestrator', trust: 'operator' })
    expect(promoted).toHaveLength(1)
    expect(promoted[0]!.state).toBe('committed')
    expect(promoted[0]!.source_trust).toBe('operator')
    // orphan revival: a cancelled run's claim, re-observed by a successful worker
    await p.intake([{ fact: 'the flag is y', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'verified_execution', parentAborted: true })
    const after = p.list().find(x => x.fact === 'the flag is y')
    expect(after?.state).toBe('orphaned_cancelled')
    const revived = await p.intake([{ fact: 'the flag is y', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'verified_execution' })
    expect(revived).toHaveLength(1)
    expect(revived[0]!.state).toBe('committed')
  })

  it('boot reconcile: tentative → orphaned_cancelled', async () => {
    const p = makePipeline(db)
    await p.intake([{ fact: 'leftover claim', category: 'PROJECT' }], { origin: 'worker:fixer', trust: 'untrusted_external' })
    const n = await p.reconcileBoot()
    expect(n).toBe(1)
    const rows = p.list()
    expect(rows[0]!.state).toBe('orphaned_cancelled')
  })

  it('boot reconcile preserves only settled compaction claims; generic tentative is orphaned', async () => {
    const p = makePipeline(db)
    const settled = await p.intake(
      [{ fact: 'settled compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord() },
    )
    const unproven = await p.intake(
      [{ fact: 'unproven compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external' },
    )
    const partial = await p.intake(
      [{ fact: 'partial compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: JSON.stringify({ source: 'compaction', compactionId: '' }) },
    )
    const malformed = await p.intake(
      [{ fact: 'malformed compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: '{not json' },
    )
    const wrongOrigin = await p.intake(
      [{ fact: 'keeper row with compaction source record', category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', provenance: compactionSourceRecord('c9') },
    )
    expect(await p.reconcileBoot()).toBe(4)
    expect(p.get(settled[0]!.id)!.state).toBe('tentative')
    for (const row of [unproven[0]!, partial[0]!, malformed[0]!, wrongOrigin[0]!]) {
      expect(p.get(row.id)!.state).toBe('orphaned_cancelled')
    }
    expect(await p.reconcileBoot()).toBe(0)
    expect(p.get(settled[0]!.id)!.state).toBe('tentative')
  })

  it('boot reconcile orphans every unproven or non-object source record without throwing', async () => {
    const p = makePipeline(db)
    const proven = await p.intake(
      [{ fact: 'proven settled compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('cmp_42') },
    )
    const unproven: Array<[string, string | null]> = [
      ['sql-null', null],
      ['json-null', 'null'],
      ['json-true', 'true'],
      ['json-number', '42'],
      ['json-string', '"compaction"'],
      ['json-array', '[]'],
      ['object-empty', '{}'],
      ['missing-id', JSON.stringify({ source: 'compaction' })],
      ['null-id', JSON.stringify({ source: 'compaction', compactionId: null })],
      ['empty-id', JSON.stringify({ source: 'compaction', compactionId: '' })],
      ['blank-id', JSON.stringify({ source: 'compaction', compactionId: '  \t\n ' })],
      ['number-id', JSON.stringify({ source: 'compaction', compactionId: 42 })],
      ['number-source', JSON.stringify({ source: 42, compactionId: 'cmp_42' })],
      ['wrong-source', JSON.stringify({ source: 'keeper', compactionId: 'cmp_42' })],
      ['malformed', '{not json'],
    ]
    for (const [suffix, sourceRecord] of unproven) insertTentative(`claim-unproven-${suffix}`, sourceRecord)
    const trimmedId = 'claim-proven-trimmed'
    insertTentative(trimmedId, JSON.stringify({ source: 'compaction', compactionId: ' \tcmp_42\n ' }))

    expect(await p.reconcileBoot()).toBe(unproven.length)
    expect(p.get(proven[0]!.id)!.state).toBe('tentative')
    expect(p.get(trimmedId)!.state).toBe('tentative')
    for (const [suffix] of unproven) {
      expect(p.get(`claim-unproven-${suffix}`)!.state).toBe('orphaned_cancelled')
    }
    expect(await p.reconcileBoot()).toBe(0)
    expect(p.get(proven[0]!.id)!.state).toBe('tentative')
    expect(p.get(trimmedId)!.state).toBe('tentative')
  })

  it('does not revive an already-orphaned settled compaction claim (documented limitation)', async () => {
    const p = makePipeline(db)
    const fact = 'previously orphaned settled compaction fact'
    const rows = await p.intake(
      [{ fact, category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('c5') },
    )
    const id = rows[0]!.id
    // Simulates a row orphaned by the pre-fix boot reconcile.
    db.prepare(`UPDATE claims SET state = 'orphaned_cancelled' WHERE id = ?`).run(id)

    expect(await p.reconcileBoot()).toBe(0)
    expect(p.get(id)!.state).toBe('orphaned_cancelled')
    const replay = await p.intake(
      [{ fact, category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('c5') },
    )
    expect(replay).toHaveLength(0)
    expect(p.get(id)!.state).toBe('orphaned_cancelled')
  })

  it('preserves only settled keeper claims with the exact source-record proof', async () => {
    const p = makePipeline(db)
    const validFacts = [
      ['keeper-default', keeperSourceRecord()],
      ['keeper-zero-seq', keeperSourceRecord({ batchBasedOnSeq: 0 })],
      ['keeper-padded-session', keeperSourceRecord({ sessionId: ' \tsession-1\n ' })],
    ] as const
    const validIds: string[] = []
    for (const [suffix, sourceRecord] of validFacts) {
      const rows = await p.intake(
        [{ fact: `settled keeper fact ${suffix}`, category: 'PROJECT' }],
        { origin: 'keeper', trust: 'untrusted_external', provenance: sourceRecord },
      )
      expect(rows[0]!.state).toBe('tentative')
      validIds.push(rows[0]!.id)
    }
    const compaction = await p.intake(
      [{ fact: 'settled compaction fact alongside keeper', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('c7') },
    )

    const badProofs: Array<[string, string | null]> = [
      ['missing-session', keeperSourceRecord({ sessionId: undefined })],
      ['blank-session', keeperSourceRecord({ sessionId: '  \t\n ' })],
      ['number-session', keeperSourceRecord({ sessionId: 42 })],
      ['missing-seq', keeperSourceRecord({ batchBasedOnSeq: undefined })],
      ['negative-seq', keeperSourceRecord({ batchBasedOnSeq: -1 })],
      ['real-seq', keeperSourceRecord({ batchBasedOnSeq: 1.5 })],
      ['string-seq', keeperSourceRecord({ batchBasedOnSeq: '3' })],
      ['bool-seq', keeperSourceRecord({ batchBasedOnSeq: true })],
      ['null-seq', keeperSourceRecord({ batchBasedOnSeq: null })],
      ['missing-settled', keeperSourceRecord({ settled: undefined })],
      ['false-settled', keeperSourceRecord({ settled: false })],
      ['one-settled', keeperSourceRecord({ settled: 1 })],
      ['string-settled', keeperSourceRecord({ settled: 'true' })],
      ['null-settled', keeperSourceRecord({ settled: null })],
      ['wrong-source', keeperSourceRecord({ source: 'compaction' })],
      ['malformed', '{not json'],
      ['json-null', 'null'],
      ['json-array', '[]'],
      ['json-scalar', '42'],
      ['keeper-with-compaction-proof', compactionSourceRecord('c9')],
    ]
    for (const [suffix, sourceRecord] of badProofs) {
      insertTentative(`claim-bad-${suffix}`, sourceRecord, 'keeper')
    }
    insertTentative('claim-compaction-with-keeper-proof', keeperSourceRecord(), 'compaction')

    expect(await p.reconcileBoot()).toBe(badProofs.length + 1)
    for (const id of validIds) {
      expect(p.get(id)!.state).toBe('tentative')
    }
    expect(p.get(compaction[0]!.id)!.state).toBe('tentative')
    for (const [suffix] of badProofs) {
      expect(p.get(`claim-bad-${suffix}`)!.state).toBe('orphaned_cancelled')
    }
    expect(p.get('claim-compaction-with-keeper-proof')!.state).toBe('orphaned_cancelled')
    expect(await p.reconcileBoot()).toBe(0)
  })

  it('keeps a settled keeper proof through a real SQLite reopen, repeated reconcile, global search, and confirm', async () => {
    const p = makePipeline(db)
    const rows = await p.intake(
      [{ fact: 'settled keeper fact across reopen', category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', provenance: keeperSourceRecord() },
    )
    const id = rows[0]!.id

    db.close()
    db = openMemoryDb()
    const reopened = makePipeline(db)
    expect(await reopened.reconcileBoot()).toBe(0)
    expect(await reopened.reconcileBoot()).toBe(0)
    expect(reopened.get(id)).toMatchObject({
      state: 'tentative',
      source_trust: 'untrusted_external',
      origin: 'keeper',
      committed_at: null,
    })

    // Keeper rows are not compaction-scoped: a different cwd still finds them.
    const hits = searchMemory(db, 'settled keeper reopen', 10, { cwd: '/other/ws', scopeCompaction: true })
    expect(hits.map(hit => hit.id)).toContain(id)

    const confirmed = await reopened.confirm(id)
    expect(confirmed).toMatchObject({ state: 'committed', source_trust: 'operator', origin: 'keeper' })
    expect(confirmed?.committed_at).not.toBeNull()
  })

  it('does not revive an already-orphaned settled keeper claim (conservative)', async () => {
    const p = makePipeline(db)
    const fact = 'superseded settled keeper fact'
    const rows = await p.intake(
      [{ fact, category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', provenance: keeperSourceRecord() },
    )
    const id = rows[0]!.id
    db.prepare(`UPDATE claims SET state = 'orphaned_cancelled', supersedes = 'claim-parent' WHERE id = ?`).run(id)

    expect(await p.reconcileBoot()).toBe(0)
    expect(p.get(id)!.state).toBe('orphaned_cancelled')
    const replay = await p.intake(
      [{ fact, category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', provenance: keeperSourceRecord() },
    )
    expect(replay).toHaveLength(0)
    expect(p.get(id)!.state).toBe('orphaned_cancelled')
  })

  it('boot reconcile never revives rescinded or orphaned claims', async () => {
    const p = makePipeline(db)
    const settled = await p.intake(
      [{ fact: 'rescinded compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('c2') },
    )
    await p.rescind(settled[0]!.id, 'test')
    const aborted = await p.intake(
      [{ fact: 'parent-aborted compaction fact', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', parentAborted: true, provenance: compactionSourceRecord('c3') },
    )
    const keeperSettled = await p.intake(
      [{ fact: 'rescinded keeper fact', category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', provenance: keeperSourceRecord() },
    )
    await p.rescind(keeperSettled[0]!.id, 'test')
    const keeperAborted = await p.intake(
      [{ fact: 'parent-aborted keeper fact', category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external', parentAborted: true, provenance: keeperSourceRecord() },
    )
    const operator = await p.intake(
      [{ fact: 'operator fact across boot', category: 'ARCHITECTURE' }],
      { origin: 'orchestrator', trust: 'operator' },
    )
    expect(aborted[0]!.state).toBe('orphaned_cancelled')
    expect(keeperAborted[0]!.state).toBe('orphaned_cancelled')
    expect(await p.reconcileBoot()).toBe(0)
    expect(p.get(settled[0]!.id)!.state).toBe('rescinded')
    expect(p.get(aborted[0]!.id)!.state).toBe('orphaned_cancelled')
    expect(p.get(keeperSettled[0]!.id)!.state).toBe('rescinded')
    expect(p.get(keeperAborted[0]!.id)!.state).toBe('orphaned_cancelled')
    expect(p.get(operator[0]!.id)).toMatchObject({ state: 'committed', source_trust: 'operator' })
  })

  it('explicit confirm commits a tentative claim with operator trust atomically', async () => {
    const p = makePipeline(db)
    const rows = await p.intake(
      [{ fact: 'tentative claim to confirm', category: 'PROJECT' }],
      { origin: 'compaction', trust: 'untrusted_external', provenance: compactionSourceRecord('c4') },
    )
    const confirmed = await p.confirm(rows[0]!.id)
    expect(confirmed).toMatchObject({
      id: rows[0]!.id,
      state: 'committed',
      source_trust: 'operator',
      origin: 'compaction',
    })
    expect(confirmed?.committed_at).not.toBeNull()
  })

  it('confirm leaves committed untrusted history untouched', async () => {
    const p = makePipeline(db)
    const now = Date.now()
    db.prepare(
      `INSERT INTO claims (id, fact, category, tags, state, source_trust, origin, provenance, created_at, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('claim-historical', 'historical committed untrusted fact', 'PROJECT', '', 'committed', 'untrusted_external', 'legacy', '', now, now)

    expect(await p.confirm('claim-historical')).toBeNull()
    expect(p.get('claim-historical')).toMatchObject({ state: 'committed', source_trust: 'untrusted_external' })
  })
})
