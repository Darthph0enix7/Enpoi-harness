import { describe, expect, it } from 'vitest'
import { Session } from '../src/client/sessions/session.ts'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'
import { entries, ev } from './event-script.client.ts'

const SID = 'revert-fold-test' as SessionId

/** One user-origin revert-commit replacement event. */
function revertCommit(seq: number, text: string, shadowed: number[]): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: `msg-${seq}`,
    },
    surfaceOp: { op: 'replace', startSeq: SessionSeq(shadowed[0]!), endSeq: SessionSeq(seq - 1) },
    sourceEventSeqs: shadowed.map(seqShadows => SessionSeq(seqShadows)),
  }
}

function userMessage(seq: number, text: string): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      role: 'user',
      id: `msg-${seq}`,
    },
    surfaceOp: 'append',
  }
}

function revertState(seq: number, fromSeq: number | null): Record<string, unknown> {
  return { type: 'revert/state', seq, time: Date.now(), data: { fromSeq } }
}

/** Fill a contiguous assistant turn between two user messages (seqs start..start+4). */
function assistantTurn(start: number, turn: number): Record<string, unknown>[] {
  return [
    ev.turnStart(SessionSeq(start), turn),
    ev.stepStart(SessionSeq(start + 1), turn),
    ev.assistant(SessionSeq(start + 2), turn, 'answer'),
    ev.stepEnd(SessionSeq(start + 3), turn),
    ev.turnEnd(SessionSeq(start + 4), turn),
  ] as unknown as Record<string, unknown>[]
}

describe('revert shadow fold (B4: sequential commit cycles & range-based hiding)', () => {
  it('unions shadowed ranges across ALL user-origin replacements, not just the latest', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    // Two revert→commit cycles over a CONTIGUOUS log (the journal stream
    // rejects discontinuous pages): first shadows 7..19 (start 7, replacement
    // seq 19), second shadows 21..33 (start 21, replacement seq 33).
    api.onHistory = () => Promise.resolve(ok({
      records: entries([
        userMessage(7, 'hello'),
        revertState(8, 7),
        ...assistantTurn(9, 1),
        ...assistantTurn(14, 2),
        revertCommit(19, 'goodbye', [7, 8, 9, 10, 18]),
        revertState(20, null),
        userMessage(21, 'second round'),
        revertState(22, 21),
        ...assistantTurn(23, 3),
        ...assistantTurn(28, 4),
        revertCommit(33, 'final', [21, 22, 23, 27, 32]),
        revertState(34, null),
      ] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    const snapshot = session.getSnapshot()
    // Both spans must be recorded as half-open ranges [start, replacement.seq).
    // A fractional anchor (e.g. turn-tail at 20.1) or trailing turn/end at 20 is inside [7, 21).
    expect(snapshot.revertShadowRanges).toEqual([
      { start: 7, end: 19 },
      { start: 21, end: 33 },
    ])
  })

  it('falls back to the window boundary when the window carries the revert/state event', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries([
        userMessage(7, 'hello'),
        revertState(8, 7),
      ] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    const snapshot = session.getSnapshot()
    expect(snapshot.revertFromSeq).toBe(7)
  })

  it('notifies immediately when a live revert/state event lands in an open session', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries([userMessage(7, 'hello')] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    expect(session.getSnapshot().revertFromSeq).toBe(null)
    let notified = false
    session.subscribe(() => { notified = true })
    // Push live revert/state event through the journal-change path.
    session.acceptEventChange({
      type: 'append',
      entry: { type: 'event', event: revertState(8, 7) as never },
    })
    // Microtask flush
    await Promise.resolve()
    expect(session.getSnapshot().revertFromSeq).toBe(7)
    expect(notified).toBe(true)
  })
})
