/**
 * Projection-backfill behavior: the fold-and-skip pass over the corpus
 * (idempotent, resumable), live-session safety, unsupported-log
 * classification, and missing requested ids. The projection cache and the
 * persistence backend are object stubs: this spec owns the pass's control
 * flow, while the cache package's own spec owns the fold and the durable
 * write.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { backfillProjectionCache } from '../src/projection-backfill.ts'
import type { SessionRecord } from '../src/types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'backfill-test/marks': { marks: string[] }
  }
  interface SessionProjectionStateMap {
    'backfill-test/marks': { marks: string[] }
  }
}

const MARKS = 'backfill-test/marks'

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

function markEvent(seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq + 1, data: { turn: 1 } }
}

/** A balanced log of `turns` completed turns; no synthetic closers are added. */
function balancedLog(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: events.length, data: { turn } })
    events.push({
      type: 'turn/end',
      seq: SessionSeq(events.length),
      time: events.length,
      data: { turn, reason: { kind: 'completed' } },
    })
  }
  return events
}

interface StoredEntry {
  header: SessionHeader
  events: SessionEvent[]
}

const counters = { open: 0, read: 0 }

/** Object-stub persistence: only the members the cold read touches. */
function stubPersistence(
  store: Map<SessionIdType, StoredEntry>,
  unsupported: ReadonlySet<string>,
  broken: ReadonlySet<string>,
) {
  return {
    stat: (id: SessionIdType) => {
      const entry = store.get(id)
      return Promise.resolve(entry === undefined
        ? undefined
        : { header: structuredClone(entry.header), revision: 'r1' })
    },
    open: (id: SessionIdType, _access: string) => {
      counters.open += 1
      if (unsupported.has(id)) {
        const error = new Error('legacy log')
        error.name = 'SessionFormatUnsupportedError'
        return Promise.reject(error)
      }
      if (broken.has(id)) return Promise.reject(new Error('backend read failed'))
      const entry = store.get(id)
      if (entry === undefined) return Promise.reject(new Error(`no stored session "${id}"`))
      const snapshot = structuredClone(entry)
      return Promise.resolve({
        header: snapshot.header,
        inheritedEventCount: SessionLogOffset(0),
        read: () => {
          counters.read += 1
          return Promise.resolve({ eventState: 'detached', events: structuredClone(snapshot.events) })
        },
        close: () => Promise.resolve(),
      })
    },
  }
}

/** Object-stub cache: a served-rows map plus the reindex sink the pass calls. */
function stubCache() {
  const rows = new Map<string, Record<string, { ver: number; val: unknown }>>()
  const reindexed: string[] = []
  return {
    rows,
    reindexed,
    cachedSnapshot: (meta: SessionHeader, keys?: readonly string[]) => {
      const record = rows.get(meta.id)
      if (record === undefined) return undefined
      const values: Record<string, unknown> = {}
      for (const [key, row] of Object.entries(record)) {
        if (keys !== undefined && !keys.includes(key)) continue
        values[key] = row.val
      }
      return { asOfSeq: SessionSeq(0), values }
    },
    reindex: (meta: SessionHeader, _inherited: unknown, events: readonly SessionEvent[]) => {
      reindexed.push(meta.id)
      rows.set(meta.id, { [MARKS]: { ver: 1, val: { marks: [String(events.length)] } } })
      return Promise.resolve({ asOfSeq: SessionSeq(0), values: {} })
    },
  }
}

const contexts: Context[] = []

interface HarnessOptions {
  liveIds?: readonly string[]
  unsupported?: readonly string[]
  broken?: readonly string[]
}

async function harness(entries: readonly StoredEntry[], options: HarnessOptions = {}) {
  counters.open = 0
  counters.read = 0
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const store = new Map(entries.map(entry => [entry.header.id, entry]))
  const cache = stubCache()
  ctx.provide('sessionPersistence', stubPersistence(
    store,
    new Set(options.unsupported ?? []),
    new Set(options.broken ?? []),
  ) as never)
  ctx.provide('sessionProjectionCache', cache as never)
  const records: SessionRecord[] = entries.map(entry => ({
    header: entry.header,
    live: options.liveIds?.includes(entry.header.id) ?? false,
    persisted: true,
  }))
  ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(records) } as never)
  for (const id of options.liveIds ?? []) {
    ctx.sessions.create(SessionId(id), { meta: { cwd: '/workspace' } })
  }
  return { ctx, cache }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('backfillProjectionCache', () => {
  it('folds unserved sessions and skips them on a second run', async () => {
    const { ctx, cache } = await harness([
      { header: header('a'), events: balancedLog(1) },
      { header: header('b'), events: balancedLog(2) },
    ])
    const first = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(first).toMatchObject({ total: 2, folded: 2, skippedServed: 0, failed: 0, stoppedEarly: false })
    expect(cache.rows.get('a')).toEqual({ [MARKS]: { ver: 1, val: { marks: ['2'] } } })
    expect(cache.rows.get('b')).toEqual({ [MARKS]: { ver: 1, val: { marks: ['4'] } } })

    const second = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(second).toMatchObject({ total: 2, folded: 0, skippedServed: 2, failed: 0 })
    expect(cache.reindexed).toEqual(['a', 'b'])
  })

  it('skips attached sessions and never reads their logs', async () => {
    const { ctx, cache } = await harness(
      [{ header: header('live'), events: [markEvent(0)] }],
      { liveIds: ['live'] },
    )
    const report = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(report).toMatchObject({ total: 1, folded: 0, skippedLive: 1, failed: 0 })
    expect(counters.open).toBe(0)
    expect(cache.rows.size).toBe(0)
  })

  it('reports an unsupported stored format and keeps folding the rest', async () => {
    const { ctx, cache } = await harness(
      [
        { header: header('legacy'), events: [markEvent(0)] },
        { header: header('ok'), events: [markEvent(0)] },
      ],
      { unsupported: ['legacy'] },
    )
    const report = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(report).toMatchObject({ total: 2, folded: 1, skippedUnsupported: 1, failed: 0 })
    expect(cache.reindexed).toEqual(['ok'])
  })

  it('counts a non-format failure and continues the pass', async () => {
    const { ctx, cache } = await harness(
      [
        { header: header('broken'), events: [markEvent(0)] },
        { header: header('ok'), events: [markEvent(0)] },
      ],
      { broken: ['broken'] },
    )
    const report = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(report).toMatchObject({ total: 2, folded: 1, failed: 1, skippedUnsupported: 0 })
    expect(report.failures).toEqual([{ sessionId: SessionId('broken'), reason: 'Error: backend read failed' }])
    expect(cache.reindexed).toEqual(['ok'])
  })

  it('stops at the limit and resumes with the still-unserved remainder', async () => {
    const { ctx } = await harness([
      { header: header('a'), events: [markEvent(0)] },
      { header: header('b'), events: [markEvent(0)] },
      { header: header('c'), events: [markEvent(0)] },
    ])
    const first = await backfillProjectionCache(ctx, { keys: [MARKS], limit: 1 })
    expect(first).toMatchObject({ folded: 1, stoppedEarly: true })
    const second = await backfillProjectionCache(ctx, { keys: [MARKS] })
    expect(second).toMatchObject({ folded: 2, skippedServed: 1, stoppedEarly: false })
  })

  it('reports requested ids persistence no longer holds', async () => {
    const { ctx } = await harness([{ header: header('here'), events: [markEvent(0)] }])
    const report = await backfillProjectionCache(ctx, {
      sessionIds: [SessionId('gone'), SessionId('here')],
      keys: [MARKS],
    })
    expect(report).toMatchObject({ total: 1, folded: 1, skippedMissing: 1 })
  })

  it('reports progress per examined session', async () => {
    const { ctx } = await harness([
      { header: header('a'), events: [markEvent(0)] },
      { header: header('live'), events: [markEvent(0)] },
    ], { liveIds: ['live'] })
    const outcomes: string[] = []
    await backfillProjectionCache(ctx, {
      keys: [MARKS],
      onProgress: progress => outcomes.push(`${String(progress.index)}:${String(progress.total)}:${progress.outcome}`),
    })
    expect(outcomes).toEqual(['0:2:folded', '1:2:skipped-live'])
  })
})
