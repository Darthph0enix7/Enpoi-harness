import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../src/db'
import { makePipeline } from '../src/pipeline'

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
})
