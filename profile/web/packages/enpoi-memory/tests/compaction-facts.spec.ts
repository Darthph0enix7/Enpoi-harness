import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { openMemoryDb } from '../src/db'
import { makePipeline, type Pipeline } from '../src/pipeline'
import { registerCompactionFacts } from '../src/compaction-facts'
import { MEMORY_CONFIG_DEFAULTS, resolveMemoryConfig, type MemoryConfig } from '../src/config'

let db: DatabaseSync
let pipeline: Pipeline
let handlers: Map<string, Array<(...args: any[]) => void>>
let warnings: string[]
let dispose: (() => void) | undefined

beforeEach(() => {
  const m = require('node:os').tmpdir()
  process.env.DSH_MEMORY_DB = `${m}/enpoi-mem-cf-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  db = openMemoryDb()
  pipeline = makePipeline(db)
  handlers = new Map()
  warnings = []
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  try { db.close() } catch { /* a failure-containment test may already have closed it */ }
  try { require('node:fs').unlinkSync(process.env.DSH_MEMORY_DB ?? '') } catch { /* ok */ }
  delete process.env.DSH_MEMORY_DB
})

/** Minimal host ctx: event registration + the logger surface the subscriber uses. */
function fakeCtx() {
  const ctx = {
    logger: { warn: (line: string) => { warnings.push(line) }, error: () => {} },
    on(name: string, handler: (...args: any[]) => void) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {}
    },
  }
  return ctx as unknown as Context
}

function register(config: Partial<MemoryConfig> = {}): void {
  dispose = registerCompactionFacts(fakeCtx(), db, pipeline, resolveMemoryConfig(config))
}

function emit(name: string, ...args: unknown[]): void {
  for (const handler of handlers.get(name) ?? []) handler(...args)
}

interface FakeSession {
  id: string
  header: { cwd?: string; parentSession?: string }
}

function session(id = 's1', cwd: string | undefined = '/work/ws', parentSession?: string, headerCwd = true): FakeSession {
  return {
    id,
    header: {
      ...(headerCwd ? { cwd } : {}),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

const FACTS = [
  '## Durable Facts',
  '- [decision] Use SQLite WAL for the memory database',
  '- [constraint] memory.db has no schema version',
  '- [fact] The archive bucket is eu-central-3',
].join('\n')

function summaryEvent(
  compactionId = 'c1',
  text: string | string[] = FACTS,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'compaction/summary',
    data: {
      compactionId,
      summary: (Array.isArray(text) ? text : [text]).map(value => ({ type: 'text', text: value })),
      shadowedRange: { start: 3, end: 17 },
      provider: 'mock',
      model: 'mock-model',
      ...overrides,
    },
  }
}

function endEvent(compactionId = 'c1', error?: string): Record<string, unknown> {
  return {
    type: 'compaction/end',
    data: { compactionId, turn: 1, ...(error === undefined ? {} : { error }) },
  }
}

/** Let the scheduled `setImmediate` write run and the pipeline mutex drain. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 5))
}

describe('compaction facts subscriber — C2 trigger matrix', () => {
  it('writes parsed facts only after the matching compaction/end, with C3 identity', async () => {
    register()
    emit('session/event', session(), summaryEvent())
    expect(pipeline.list()).toHaveLength(0)

    emit('session/event', session(), endEvent())
    await settle()

    const rows = pipeline.list()
    expect(rows).toHaveLength(3)
    const provenance = JSON.parse(rows.find(row => row.fact.startsWith('Use SQLite'))!.provenance)
    expect(provenance).toEqual({
      source: 'compaction',
      sessionId: 's1',
      compactionId: 'c1',
      cwd: '/work/ws',
      shadowedRange: { start: 3, end: 17 },
      summaryRoute: 'mock/mock-model',
    })
    for (const row of rows) {
      expect(row.origin).toBe('compaction')
      expect(row.source_trust).toBe('verified_execution')
      expect(row.state).toBe('committed')
    }
    const decision = rows.find(row => row.fact.startsWith('Use SQLite'))!
    expect(decision.category).toBe('ARCHITECTURE')
    expect(decision.tags).toBe('compaction decision')
    const constraint = rows.find(row => row.fact.startsWith('memory.db'))!
    expect(constraint.category).toBe('PROJECT')
    expect(constraint.tags).toBe('compaction constraint')
  })

  it('joins text blocks with "" before parsing', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', ['## Durable Facts\n- [fact] alpha ', 'beta gamma']))
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list().map(row => row.fact)).toEqual(['alpha beta gamma'])
  })

  it('skips the mechanical stub (provider === "")', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', FACTS, { provider: '' }))
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list()).toHaveLength(0)
  })

  it('skips a summary carrying summarizationFailure', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', FACTS, {
      summarizationFailure: { code: 'LLM_ERROR', message: 'provider exploded' },
    }))
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list()).toHaveLength(0)
  })

  it('skips child sessions by default and captures them when enabled', async () => {
    register()
    emit('session/event', session('child', '/work/ws', 'parent-1'), summaryEvent('c1'))
    emit('session/event', session('child', '/work/ws', 'parent-1'), endEvent())
    await settle()
    expect(pipeline.list()).toHaveLength(0)

    register({ compactionFactsIncludeChildSessions: true })
    emit('session/event', session('child', '/work/ws', 'parent-1'), summaryEvent('c2'))
    emit('session/event', session('child', '/work/ws', 'parent-1'), endEvent('c2'))
    await settle()
    expect(pipeline.list()).toHaveLength(3)
  })

  it('drops held facts on a failed compaction/end and never writes them later', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1'))
    emit('session/event', session(), endEvent('c1', 'summarizer returned empty output'))
    await settle()
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list()).toHaveLength(0)
  })

  it('ignores an end for a different compaction id', async () => {
    register()
    emit('session/event', session(), summaryEvent('c2'))
    emit('session/event', session(), endEvent('c1'))
    await settle()
    expect(pipeline.list()).toHaveLength(0)

    emit('session/event', session(), endEvent('c2'))
    await settle()
    expect(pipeline.list()).toHaveLength(3)
  })

  it('caps one compaction at compactionFactsMax facts, keeping the first ones', async () => {
    register({ compactionFactsMax: 2 })
    emit('session/event', session(), summaryEvent())
    emit('session/event', session(), endEvent())
    await settle()

    // Creation timestamps can collide inside one write batch; compare as a set.
    expect(pipeline.list().map(row => row.fact).sort()).toEqual([
      'Use SQLite WAL for the memory database',
      'memory.db has no schema version',
    ].sort())
  })

  it('never writes when compactionFacts is off', async () => {
    register({ compactionFacts: false })
    emit('session/event', session(), summaryEvent())
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list()).toHaveLength(0)
  })

  it('drops held facts on plugin disposal and on session/disposed', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1'))
    dispose!()
    dispose = undefined
    emit('session/event', session(), endEvent('c1'))
    await settle()
    expect(pipeline.list()).toHaveLength(0)

    register()
    emit('session/event', session('s2'), summaryEvent('c2'))
    emit('session/disposed', session('s2'))
    emit('session/event', session('s2'), endEvent('c2'))
    await settle()
    expect(pipeline.list()).toHaveLength(0)
  })
})

describe('compaction facts subscriber — secret guard + near-duplicate suppression', () => {
  it('drops a fact carrying a credential and keeps the rest', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', [
      '## Durable Facts',
      '- [fact] deploy with sk-live-abcdefghijklmnop',
      '- [fact] deploy with make deploy',
    ].join('\n')))
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list().map(row => row.fact)).toEqual(['deploy with make deploy'])
  })

  it('suppresses a reworded duplicate of a fact saved by an earlier compaction', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', [
      '## Durable Facts',
      '- [fact] The archive bucket is eu-central-3 for backups',
    ].join('\n')))
    emit('session/event', session(), endEvent('c1'))
    await settle()
    expect(pipeline.list()).toHaveLength(1)

    // Same token set (Jaccard 1.0) → suppressed.
    emit('session/event', session(), summaryEvent('c2', [
      '## Durable Facts',
      '- [fact] the archive bucket is eu-central-3 for backups',
    ].join('\n')))
    emit('session/event', session(), endEvent('c2'))
    await settle()
    expect(pipeline.list()).toHaveLength(1)

    // Third consecutive consolidated compaction, same fact again (word order
    // differs, token set identical) → still one row.
    emit('session/event', session(), summaryEvent('c3', [
      '## Durable Facts',
      '- [fact] for backups the archive bucket is eu-central-3',
    ].join('\n')))
    emit('session/event', session(), endEvent('c3'))
    await settle()
    expect(pipeline.list()).toHaveLength(1)

    // Disjoint rewrite (Jaccard far below 0.8) → written.
    emit('session/event', session(), summaryEvent('c4', [
      '## Durable Facts',
      '- [fact] the archive bucket moved to eu-central-9',
    ].join('\n')))
    emit('session/event', session(), endEvent('c4'))
    await settle()
    expect(pipeline.list()).toHaveLength(2)
  })

  it('suppresses near-duplicates inside one compaction batch', async () => {
    register()
    emit('session/event', session(), summaryEvent('c1', [
      '## Durable Facts',
      '- [fact] the archive bucket is eu-central-3 for backups',
      '- [fact] the archive bucket is eu-central-3 for backups daily',
    ].join('\n')))
    emit('session/event', session(), endEvent())
    await settle()

    expect(pipeline.list()).toHaveLength(1)
  })

  it('a threshold of 1 only suppresses identical token sets', async () => {
    register({ compactionFactsNearDuplicate: 1 })
    emit('session/event', session(), summaryEvent('c1', [
      '## Durable Facts',
      '- [fact] the archive bucket is eu-central-3 for backups',
    ].join('\n')))
    emit('session/event', session(), endEvent('c1'))
    await settle()

    emit('session/event', session(), summaryEvent('c2', [
      '## Durable Facts',
      '- [fact] the archive bucket is eu-central-3 for backup',
    ].join('\n')))
    emit('session/event', session(), endEvent('c2'))
    await settle()

    expect(pipeline.list()).toHaveLength(2)
  })
})

describe('compaction facts subscriber — failure containment', () => {
  it('warns once per (session, compaction) and never rethrows', async () => {
    register()
    db.close()

    expect(() => {
      emit('session/event', session(), summaryEvent('c1'))
      emit('session/event', session(), endEvent('c1'))
    }).not.toThrow()
    await settle()

    // A second summary/end pair for the same id fails again; the warn-once
    // ledger keeps it to one line.
    emit('session/event', session(), summaryEvent('c1'))
    emit('session/event', session(), endEvent('c1'))
    await settle()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('enpoi-memory: compaction facts')
    expect(warnings[0]).toContain('s1/c1')
  })

  it('contains a throwing listener path instead of breaking the host dispatch', () => {
    register()
    const hostile = {
      type: 'compaction/summary',
      get data(): never { throw new Error('hostile event') },
    }
    expect(() => emit('session/event', session(), hostile)).not.toThrow()
    expect(warnings).toHaveLength(1)
  })
})

describe('memory config', () => {
  it('defaults match the documented values', () => {
    expect(resolveMemoryConfig(undefined)).toEqual(MEMORY_CONFIG_DEFAULTS)
    expect(MEMORY_CONFIG_DEFAULTS).toEqual({
      compactionFacts: true,
      compactionFactsIncludeChildSessions: false,
      compactionFactsMax: 12,
      compactionFactsNearDuplicate: 0.8,
      scopeCompactionFactsToWorkspace: true,
    })
  })

  it('clamps every bounded value and ignores malformed ones', () => {
    expect(resolveMemoryConfig({ compactionFactsMax: 0 }).compactionFactsMax).toBe(1)
    expect(resolveMemoryConfig({ compactionFactsMax: 99 }).compactionFactsMax).toBe(40)
    expect(resolveMemoryConfig({ compactionFactsMax: 3.9 }).compactionFactsMax).toBe(3)
    expect(resolveMemoryConfig({ compactionFactsNearDuplicate: 0 }).compactionFactsNearDuplicate).toBe(0.5)
    expect(resolveMemoryConfig({ compactionFactsNearDuplicate: 5 }).compactionFactsNearDuplicate).toBe(1)
    expect(resolveMemoryConfig({ compactionFactsMax: 'x' as unknown as number }).compactionFactsMax).toBe(12)
    expect(resolveMemoryConfig({ compactionFacts: 'yes' as unknown as boolean }).compactionFacts).toBe(true)
  })
})
