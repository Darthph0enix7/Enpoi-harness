// contextCompactions projection: committed summarizing compactions, their
// newest shadow span, and the in-flight lifecycle held between start and end.

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextCompactionsProjection } from '@deepseek-ai/dsh-token-meter/client'
import { contextCompactionsProjectionDefinition } from '../src/compaction-projection.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): ContextCompactionsProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextCompactions
  if (value === undefined) throw new Error('contextCompactions projection is not registered')
  return value
}

const MANUAL = 'manual-command' as CommandId

interface CompactionFacts {
  readonly id: string
  readonly provider?: string
  readonly shadowedNodes?: number
  readonly shadowedTokens?: number
  readonly error?: string
  readonly manual?: boolean
}

/** Append one complete or truncated compaction lifecycle in the backend's order. */
function appendCompaction(session: Session, facts: CompactionFacts): void {
  session.append('compaction/start', {
    compactionId: CompactionId(facts.id),
    turn: null,
    ...(facts.manual === true ? { sourceCommandId: MANUAL } : {}),
  })
  if (facts.shadowedNodes !== undefined || facts.provider !== undefined) {
    session.append('compaction/summary', {
      compactionId: CompactionId(facts.id),
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
      shadowedSeqs: Array.from({ length: facts.shadowedNodes ?? 0 }, () => SessionSeq(0)),
      shadowedTokenCount: facts.shadowedTokens ?? 0,
      provider: facts.provider ?? 'mock',
      model: facts.provider === '' ? '' : 'mock-model',
    })
  }
  if (facts.error !== undefined || facts.shadowedNodes !== undefined || facts.provider !== undefined) {
    session.append('compaction/end', {
      compactionId: CompactionId(facts.id),
      turn: null,
      ...(facts.error === undefined ? {} : { error: facts.error }),
    })
  }
}

describe('contextCompactions session projection', () => {
  it('serves zeros for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 0 })
  })

  it('ignores events outside the compaction lifecycle', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 0 })
  })

  it('counts a committed summarizing compaction and records its shadow span', async () => {
    const { ctx, session } = await harness()
    appendCompaction(session, { id: 'c1', shadowedNodes: 4, shadowedTokens: 1_200, manual: true })
    const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')!
    expect(projected(ctx, session)).toEqual({
      count: 1,
      mechanicalCount: 0,
      failedCount: 0,
      last: {
        endSeq: end.seq,
        at: end.time,
        shadowedNodes: 4,
        shadowedTokens: 1_200,
        manual: true,
        mechanical: false,
      },
    })
  })

  it('counts a mechanical stub in count and mechanicalCount and marks it mechanical', async () => {
    const { ctx, session } = await harness()
    appendCompaction(session, { id: 'c1', provider: '', shadowedNodes: 2, shadowedTokens: 50 })
    const value = projected(ctx, session)
    expect(value).toMatchObject({
      count: 1,
      mechanicalCount: 1,
      failedCount: 0,
      last: { shadowedNodes: 2, shadowedTokens: 50, manual: false, mechanical: true },
    })
  })

  it('reports an errored end as failed without committing it', async () => {
    const { ctx, session } = await harness()
    appendCompaction(session, { id: 'c1', error: 'provider down' })
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 1 })
  })

  it('keeps a failed attempt out of last even when an earlier compaction committed', async () => {
    const { ctx, session } = await harness()
    appendCompaction(session, { id: 'c1', shadowedNodes: 3, shadowedTokens: 90 })
    const first = projected(ctx, session)
    appendCompaction(session, { id: 'c2', error: 'provider down' })
    const value = projected(ctx, session)
    expect(value.count).toBe(1)
    expect(value.failedCount).toBe(1)
    expect(value.last).toEqual(first.last)
  })

  it('holds the in-flight compaction without publishing it', async () => {
    const { ctx, session } = await harness()
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: 1 })
    session.append('compaction/summary', {
      compactionId: CompactionId('c1'),
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
      shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
      shadowedTokenCount: 400,
      provider: 'mock',
      model: 'mock-model',
    })
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 0 })
  })

  it('folds a summary whose start is absent from the window and keeps its own command flag', async () => {
    const { ctx, session } = await harness()
    session.append('compaction/summary', {
      compactionId: CompactionId('c1'),
      sourceCommandId: MANUAL,
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(1) },
      shadowedSeqs: [SessionSeq(0), SessionSeq(1)],
      shadowedTokenCount: 200,
      provider: '',
      model: '',
    })
    expect(projected(ctx, session).count).toBe(0)
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
    expect(projected(ctx, session)).toMatchObject({
      count: 1,
      mechanicalCount: 1,
      failedCount: 0,
      last: { shadowedNodes: 2, shadowedTokens: 200, manual: true, mechanical: true },
    })
  })

  it('drops a success end that produced no summary without counting it', async () => {
    const { ctx, session } = await harness()
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: 1 })
    session.append('compaction/end', { compactionId: CompactionId('c1'), turn: 1 })
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 0 })
    // An end with no open lifecycle at all also leaves the committed view alone.
    session.append('compaction/end', { compactionId: CompactionId('stray'), turn: null })
    expect(projected(ctx, session)).toEqual({ count: 0, mechanicalCount: 0, failedCount: 0 })
  })

  it('keeps the published view reference across in-flight lifecycle events', async () => {
    const { session } = await harness()
    let state = contextCompactionsProjectionDefinition.init()
    const before = contextCompactionsProjectionDefinition.wire.view(state)
    session.append('compaction/start', { compactionId: CompactionId('c1'), turn: 1 })
    state = contextCompactionsProjectionDefinition.apply(state, session.snapshotEvents()[0]!)
    expect(contextCompactionsProjectionDefinition.wire.view(state)).toBe(before)
    session.append('compaction/summary', {
      compactionId: CompactionId('c1'),
      summary: [{ type: 'text', text: 'checkpoint' }],
      shadowedRange: { start: SessionSeq(0), end: SessionSeq(0) },
      shadowedSeqs: [SessionSeq(0)],
      shadowedTokenCount: 10,
      provider: 'mock',
      model: 'mock-model',
    })
    state = contextCompactionsProjectionDefinition.apply(state, session.snapshotEvents()[1]!)
    expect(contextCompactionsProjectionDefinition.wire.view(state)).toBe(before)
  })

  it('folds replay deterministically from the same events', async () => {
    const { ctx, session } = await harness()
    appendCompaction(session, { id: 'c1', shadowedNodes: 2, shadowedTokens: 10, manual: true })
    appendCompaction(session, { id: 'c2', error: 'boom' })
    appendCompaction(session, { id: 'c3', provider: '', shadowedNodes: 5, shadowedTokens: 80 })
    const events = session.snapshotEvents()
    const fold = (): ContextCompactionsProjection => {
      let state = contextCompactionsProjectionDefinition.init()
      for (const event of events) state = contextCompactionsProjectionDefinition.apply(state, event)
      return contextCompactionsProjectionDefinition.wire.view(state)
    }
    const once = fold()
    expect(fold()).toEqual(once)
    expect(once).toEqual(projected(ctx, session))
    expect(once).toMatchObject({ count: 2, mechanicalCount: 1, failedCount: 1 })
  })
})
