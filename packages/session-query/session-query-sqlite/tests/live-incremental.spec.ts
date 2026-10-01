/** Incremental live indexing: appended-row writes must match the complete fold. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { buildSessionEventSearchDocumentState } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchDocument, SessionEventSurface } from '@deepseek-ai/dsh-session-query'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { LiveDocumentIndex } from '../src/live-documents.ts'

async function liveContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'startup' })
  return ctx
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function appendText(ctx: Context, id: string, text: string): void {
  const session = ctx.sessions.get(SessionId(id))
  if (session === undefined) throw new Error(`missing session ${id}`)
  session.append('user/message', userMessage(text), { surfaceOp: 'append' })
}

/** Sorted comparison copy: incremental state is keyed, the complete fold is ordered. */
function bySeq(documents: Iterable<SessionEventSearchDocument>): SessionEventSearchDocument[] {
  return [...documents].sort((left, right) => left.seq - right.seq)
}

describe('LiveDocumentIndex', () => {
  it('matches the complete fold across appends, replacements, and branch restores', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('fold-parity'), { seed: [{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 0,
      data: userMessage('seed needle'),
      surfaceOp: 'append',
    }] })
    const baseline = buildSessionEventSearchDocumentState(session.id, session.snapshotEvents())
    const index = new LiveDocumentIndex(
      session.id,
      baseline,
      session.snapshotEvents().length,
      session.snapshotEvents().at(-1),
    )
    const retained = new Map<SessionSeqType, SessionEventSearchDocument>()
    for (const document of baseline.documents) retained.set(document.seq, document)
    const applyDelta = (): void => {
      const delta = index.foldAppend(session.snapshotEvents())
      expect(delta).toBeDefined()
      for (const document of delta!.inserts) retained.set(document.seq, document)
      for (const change of delta!.surfaceChanges) {
        const previous = retained.get(change.seq)
        expect(previous).toBeDefined()
        retained.set(change.seq, { ...previous!, surface: change.surface })
      }
    }
    const expectParity = (): void => {
      const canonical = buildSessionEventSearchDocumentState(session.id, session.snapshotEvents())
      expect(bySeq(retained.values())).toEqual(bySeq(canonical.documents))
    }

    appendText(ctx, 'fold-parity', 'alpha needle')
    applyDelta()
    expectParity()
    appendText(ctx, 'fold-parity', 'beta needle')
    applyDelta()
    expectParity()

    const first = session.surface.nodes[1]!
    const second = session.surface.nodes[2]!
    const replacement = session.append('user/message', userMessage('replacement needle'), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: second },
      sourceEventSeqs: [first, second],
    })
    applyDelta()
    expectParity()

    appendText(ctx, 'fold-parity', 'gamma needle')
    applyDelta()
    expectParity()

    session.append('revert/branch', {
      groupAnchor: first,
      variantSeq: first,
      previousVariantSeq: replacement.seq,
      startSeq: replacement.seq,
      endSeq: replacement.seq,
      shadowedSeqs: [replacement.seq],
      restoredSeqs: [first, second],
    })
    applyDelta()
    expectParity()

    appendText(ctx, 'fold-parity', 'delta needle')
    applyDelta()
    expectParity()
    // The restored events stay classified shadowed exactly as the complete fold reports them.
    expect(retained.get(first)?.surface).toBe('shadowed')
    expect(retained.get(second)?.surface).toBe('shadowed')
  })

  it('reports a strict continuation only for a prefix that extends the folded window', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('fold-prefix'), { seed: [] })
    appendText(ctx, 'fold-prefix', 'one needle')
    const events = session.snapshotEvents()
    const baseline = buildSessionEventSearchDocumentState(session.id, events)
    const index = new LiveDocumentIndex(session.id, baseline, events.length, events.at(-1))
    expect(index.foldAppend([])).toBeUndefined()
    const truncated = [...events.slice(0, -1), { ...events.at(-1)!, time: 99 }]
    expect(index.foldAppend(truncated)).toBeUndefined()
    appendText(ctx, 'fold-prefix', 'two needle')
    expect(index.foldAppend(session.snapshotEvents())).toBeDefined()
  })
})

describe('SQLite live incremental writes', () => {
  it('keeps existing document rowids across appends and surface flips', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('incremental'), { seed: [{
      type: 'user/message',
      seq: SessionSeq(0),
      time: 0,
      data: userMessage('seed needle'),
      surfaceOp: 'append',
    }] })
    appendText(ctx, 'incremental', 'alpha needle')
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'alpha' })
    const db = (ctx.sessionQuery as unknown as { _db: DatabaseSync })._db
    const rows = (): Array<{ rowid: number; seq: number; surface: string }> =>
      db.prepare('SELECT rowid, CAST(seq AS INTEGER) AS seq, surface FROM temp.live_docs WHERE session_id = ? ORDER BY seq')
        .all(session.id) as unknown as Array<{ rowid: number; seq: number; surface: string }>
    const before = rows()
    expect(before.length).toBe(2)
    appendText(ctx, 'incremental', 'beta needle')
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'beta' })
    const after = rows()
    expect(after.length).toBe(before.length + 1)
    // A whole-session rewrite would reassign every rowid; the retained rows must keep theirs.
    expect(after.slice(0, before.length).map(row => row.rowid)).toEqual(before.map(row => row.rowid))

    const target = session.surface.nodes[1]!
    const shadowedRow = after.find(row => row.seq === target)!
    session.append('user/message', userMessage('replacement needle'), {
      surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
      sourceEventSeqs: [target],
    })
    await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'replacement' })
    const flipped = rows()
    expect(flipped.length).toBe(after.length + 1)
    const moved = flipped.find(row => row.rowid === shadowedRow.rowid)
    expect(moved?.surface).toBe('shadowed')
  })

  it('serves the same hits as a complete rebuild after mixed appends', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('parity-hits'), { seed: [] })
    for (const text of ['needle one', 'needle two', 'needle three']) {
      appendText(ctx, 'parity-hits', text)
      await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle' })
    }
    const target = session.surface.nodes[1]!
    session.append('user/message', userMessage('needle replacement'), {
      surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
      sourceEventSeqs: [target],
    })
    const page = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'needle' })
    const canonical = buildSessionEventSearchDocumentState(session.id, session.snapshotEvents())
    expect(page.items.map(item => item.seq).sort((left, right) => left - right))
      .toEqual(canonical.documents.map(document => document.seq).sort((left, right) => left - right))
    const surfaces = new Map(page.items.map(item => [item.seq, item.surface as SessionEventSurface]))
    expect(surfaces.get(target)).toBe('shadowed')
  })
})
