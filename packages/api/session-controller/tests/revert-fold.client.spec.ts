import { describe, expect, it } from 'vitest'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
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
    surfaceOp: { op: 'replace', start: shadowed[0]!, end: seq - 1 },
    sourceEventSeqs: shadowed,
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

/** Fill a contiguous assistant turn between two user messages (seqs start..start+5). */
function assistantTurn(start: number, turn: number): Record<string, unknown>[] {
  return [
    ev.turnStart(start, turn),
    ev.stepStart(start + 1, turn),
    ev.chunkStart(start + 2, turn),
    ev.chunkText(start + 3, turn, 'answer'),
    ev.stepEnd(start + 4, turn),
    ev.turnEnd(start + 5, turn),
  ]
}

describe('revert shadow fold (B4: sequential commit cycles & range-based hiding)', () => {
  it('unions shadowed ranges across ALL user-origin replacements, not just the latest', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    // Two revert→commit cycles over a CONTIGUOUS log (the journal stream
    // rejects discontinuous pages): first shadows 7..21 (start 7, replacement
    // seq 21), second shadows 25..41 (start 25, replacement seq 41).
    api.onHistory = () => Promise.resolve(ok({
      records: entries([
        userMessage(7, 'hello'),
        revertState(8, 7),
        ...assistantTurn(9, 1),
        ...assistantTurn(15, 2),
        revertCommit(21, 'goodbye', [7, 8, 9, 10, 20]),
        revertState(22, null),
        userMessage(23, 'second round'),
        revertState(24, 23),
        ...assistantTurn(25, 3),
        ...assistantTurn(31, 4),
        revertCommit(37, 'final', [23, 24, 25, 30, 36]),
        revertState(38, null),
      ] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    const snapshot = session.getSnapshot()
    // Both spans must be recorded as half-open ranges [start, replacement.seq).
    // A fractional anchor (e.g. turn-tail at 20.1) or trailing turn/end at 20 is inside [7, 21).
    expect(snapshot.revertShadowRanges).toEqual([
      { start: 7, end: 21 },
      { start: 23, end: 37 },
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