/** Session-log verification and self-heal: corrupted fixtures report and repair. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionController from '../src/index.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'
import {
  repairSessionLog,
  verifySessionLog,
  type SessionVerifyEvent,
} from '../src/session-verify.ts'
import { emptyIterationFoldState } from '../src/iteration-fold.ts'

const defaults = {
  defaultModelSelection: () => ({ fixture: true, provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** A live controller session with one variant and its marker. */
async function rpcHarness(): Promise<{ controller: SessionController; sessionId: SessionId; session: NonNullable<ReturnType<Context['sessions']['get']>> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const sessionId = SessionId('verify-rpc-session')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const events: SessionEvent[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({ meta: header, events }),
  }) as never)
  const controller = createSessionTestController(ctx, defaults)
  const session = ctx.sessions.create(sessionId, { meta: header })
  const v1 = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v1' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const v2 = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'v2' }],
    source: { kind: 'user' },
  }), { surfaceOp: { op: 'replace', startSeq: v1.seq, endSeq: v1.seq }, sourceEventSeqs: [v1.seq] })
  session.append('revert/iteration', {
    groupAnchor: v1.seq, previousSeq: v1.seq, variantSeq: v2.seq, startSeq: v1.seq, endSeq: v1.seq, cause: 'commit',
  }, { ignorable: true })
  return { controller, sessionId, session }
}

function user(seq: number, text: string, surfaceOp?: unknown, sourceKind = 'user', sourceEventSeqs?: unknown): SessionVerifyEvent {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind } },
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...sourceEventSeqs === undefined ? {} : { sourceEventSeqs },
  }
}

function marker(seq: number, data: Record<string, unknown>): SessionVerifyEvent {
  return { type: 'revert/iteration', seq, time: seq, data, ignorable: true }
}

/** v1 → v2 commit, marker at 2, answer at 3. */
function healthyLog(): SessionVerifyEvent[] {
  return [
    user(0, 'v1', 'append'),
    user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }, 'user', [0]),
    marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
    { type: 'assistant/message', seq: 3, time: 3, data: {}, surfaceOp: 'append' },
  ]
}

describe('verifySessionLog', () => {
  it('passes a healthy log and reports its committed length', () => {
    const report = verifySessionLog({ events: healthyLog() })
    expect(report.ok).toBe(true)
    expect(report.issues).toEqual([])
    expect(report.committedEventCount).toBe(4)
  })

  it('reports a truncated log tail as an uncommitted record', () => {
    const events: SessionVerifyEvent[] = [...healthyLog(), { seq: 4 }]
    const report = verifySessionLog({ events })
    expect(report.ok).toBe(false)
    expect(report.committedEventCount).toBe(4)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'torn-tail', repairable: true }))
  })

  it('reports a committed sequence gap as an error the committed prefix cannot repair', () => {
    const events: SessionVerifyEvent[] = [...healthyLog(), { type: 'user/message', seq: 9, time: 9, data: {} }]
    const report = verifySessionLog({ events })
    expect(report.committedEventCount).toBe(4)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'sequence-gap', repairable: false }))
  })

  it('reports a marker naming a missing event', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      marker(4, { groupAnchor: 0, previousSeq: 99, variantSeq: 99, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ]
    const report = verifySessionLog({ events })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'missing-marker-target', seq: 4 }))
  })

  it('warns about a pre-marker user-origin replacement without breaking the log', () => {
    const events: SessionVerifyEvent[] = [
      user(0, 'v1', 'append'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }, 'user', [0]),
      { type: 'assistant/message', seq: 2, time: 2, data: {}, surfaceOp: 'append' },
    ]
    const report = verifySessionLog({ events })
    expect(report.ok).toBe(true)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'missing-marker', severity: 'warning' }))
  })

  it('reports an orphan image/offload target', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      { type: 'image/offload', seq: 4, time: 4, data: { targets: [{ seq: 99, imageIndexes: [0] }] } },
    ]
    const report = verifySessionLog({ events })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'orphan-offload-target', seq: 4 }))
  })

  it('reports a malformed and unreachable branch list', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      user(4, 'v3', { op: 'replace', startSeq: 1, endSeq: 3 }, 'user', [1, 3]),
      {
        type: 'revert/branch',
        seq: 5,
        time: 5,
        data: {
          groupAnchor: 0, variantSeq: 1, previousVariantSeq: 1,
          startSeq: 1, endSeq: 3, shadowedSeqs: [1, 3], restoredSeqs: [0, 0],
        },
      },
      {
        type: 'revert/branch',
        seq: 6,
        time: 6,
        data: {
          groupAnchor: 0, variantSeq: 4, previousVariantSeq: 1,
          startSeq: 4, endSeq: 4, shadowedSeqs: [99], restoredSeqs: [1, 3],
        },
      },
    ]
    const report = verifySessionLog({ events })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'malformed-branch-list', seq: 5 }))
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'unreachable-branch-record', seq: 6 }))
  })

  it('reports a compaction checkpoint citing a missing event', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      user(4, 'checkpoint', { op: 'replace', startSeq: 1, endSeq: 3 }, 'compact-checkpoint', [1, 3, 99]),
    ]
    const report = verifySessionLog({ events })
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'missing-checkpoint-source', seq: 4 }))
  })

  it('reports a caller index that diverges from a fresh fold', () => {
    const report = verifySessionLog({ events: healthyLog(), index: emptyIterationFoldState() })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'fold-divergence' }))
  })

  it('reports a caller surface that diverges from the fresh fold', () => {
    const report = verifySessionLog({ events: healthyLog(), nodes: [SessionSeq(0)] })
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'surface-fold-divergence', repairable: true }))
  })
})

describe('repairSessionLog', () => {
  it('drops a torn tail and rebuilds every derived fold', () => {
    const events: SessionVerifyEvent[] = [...healthyLog(), { seq: 4 }]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.events).toHaveLength(4)
    expect(result.applied.map(action => action.kind)).toContain('truncated-torn-tail')
    expect(result.nodes).toEqual([1, 3])
  })

  it('neutralizes a marker naming a missing event so the log replays', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      marker(4, { groupAnchor: 0, previousSeq: 99, variantSeq: 99, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.events).toHaveLength(5)
    expect(result.applied).toContainEqual(expect.objectContaining({ kind: 'neutralized-record', seq: 4 }))
    expect(result.events[4]?.type).toBe('verify/neutralized')
  })

  it('filters an orphan image/offload target and keeps the decision when images remain', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      {
        type: 'image/offload',
        seq: 4,
        time: 4,
        data: { targets: [{ seq: 1, imageIndexes: [0] }, { seq: 99, imageIndexes: [1] }] },
      },
    ]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.events[4]?.data).toEqual({ targets: [{ seq: 1, imageIndexes: [0] }] })
    expect(result.applied).toContainEqual(expect.objectContaining({ kind: 'filtered-references', seq: 4 }))
  })

  it('neutralizes an image/offload whose every target is orphaned', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      { type: 'image/offload', seq: 4, time: 4, data: { targets: [{ seq: 99, imageIndexes: [0] }] } },
    ]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.events[4]?.type).toBe('verify/neutralized')
  })

  it('neutralizes a malformed branch list and keeps the rest of the log replayable', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      user(4, 'v3', { op: 'replace', startSeq: 1, endSeq: 3 }, 'user', [1, 3]),
      {
        type: 'revert/branch',
        seq: 5,
        time: 5,
        data: {
          groupAnchor: 0, variantSeq: 1, previousVariantSeq: 1,
          startSeq: 1, endSeq: 3, shadowedSeqs: [1, 3], restoredSeqs: [0, 0],
        },
      },
    ]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.applied).toContainEqual(expect.objectContaining({ kind: 'neutralized-record', seq: 5 }))
    expect(result.events[5]?.type).toBe('verify/neutralized')
  })

  it('filters a dangling branch record and keeps the remaining restored branch', () => {
    const events: SessionVerifyEvent[] = [
      ...healthyLog(),
      {
        type: 'revert/branch',
        seq: 4,
        time: 4,
        data: {
          groupAnchor: 0, variantSeq: 0, previousVariantSeq: 1,
          startSeq: 1, endSeq: 3, shadowedSeqs: [1, 3], restoredSeqs: [0, 99],
        },
      },
    ]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(true)
    expect(result.events[4]?.data).toEqual({
      groupAnchor: 0, variantSeq: 0, previousVariantSeq: 1,
      startSeq: 1, endSeq: 3, shadowedSeqs: [1, 3], restoredSeqs: [0],
    })
  })

  it('rebuilds a divergent caller index and surface from the committed prefix', () => {
    const result = repairSessionLog({ events: healthyLog(), index: emptyIterationFoldState(), nodes: [SessionSeq(0)] })
    expect(result.report.ok).toBe(true)
    expect(result.applied.map(action => action.kind)).toEqual(['rebuilt-iteration-fold', 'rebuilt-surface-fold'])
    expect(result.nodes).toEqual([1, 3])
  })

  it('keeps an unrecoverable sequence gap failing loud', () => {
    const events: SessionVerifyEvent[] = [...healthyLog(), { type: 'user/message', seq: 9, time: 9, data: {} }]
    const result = repairSessionLog({ events })
    expect(result.report.ok).toBe(false)
    expect(result.report.issues).toContainEqual(expect.objectContaining({ kind: 'sequence-gap' }))
  })
})

describe('SessionController verifyLog/repairLog RPCs', () => {
  it('verifies a healthy live Session through the operator surface', async () => {
    const { controller, sessionId, session } = await rpcHarness()
    const value = await controller.verifyLog({ sessionId })
    expect(value.ok).toBe(true)
    expect(value.issues).toEqual([])
    expect(value.committedEventCount).toBe(session.seq)
  })

  it('reports a durable corruption, repairs the derived view, and never rewrites the log', async () => {
    const { controller, sessionId, session } = await rpcHarness()
    session.append('revert/iteration', {
      groupAnchor: 0, previousSeq: 0, variantSeq: 99, startSeq: 0, endSeq: 0, cause: 'commit',
    }, { ignorable: true })
    const verified = await controller.verifyLog({ sessionId })
    expect(verified.ok).toBe(false)
    expect(verified.issues).toContainEqual(expect.objectContaining({ kind: 'missing-marker-target' }))

    const repaired = await controller.repairLog({ sessionId })
    expect(repaired.ok).toBe(true)
    expect(repaired.repairs).toContainEqual(expect.objectContaining({ kind: 'neutralized-record' }))
    // The durable log still carries the corrupt marker: the repair is derived.
    const after = await controller.verifyLog({ sessionId })
    expect(after.ok).toBe(false)
    expect(session.snapshotEvents().some(event => event.type === 'revert/iteration' && 'variantSeq' in (event.data as object) && (event.data as { variantSeq: number }).variantSeq === 99)).toBe(true)
  })
})
