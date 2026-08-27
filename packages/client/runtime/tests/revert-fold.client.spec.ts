import { describe, expect, it } from 'vitest'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'
import { entries } from './event-script.client.ts'

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
  return { type: 'revert/state', seq, time: Date.now(), data: { fromSeq }, ignorable: true }
}

describe('revert shadow fold (B4: sequential commit cycles & range-based hiding)', () => {
  it('unions shadowed ranges across ALL user-origin replacements, not just the latest', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote())
    // Two revert→commit cycles: first shadows 7..21 (start 7, replacement seq 21),
    // second shadows 25..41 (start 25, replacement seq 41).
    api.onHistory = () => Promise.resolve(ok({
      events: entries([
        userMessage(7, 'hello'),
        revertState(8, 7),
        revertCommit(21, 'goodbye', [7, 8, 9, 10, 20]),
        revertState(22, null),
        userMessage(25, 'second round'),
        revertState(26, 25),
        revertCommit(41, 'final', [25, 26, 30, 40]),
        revertState(42, null),
      ] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    const snapshot = session.getSnapshot()
    // Both spans must be recorded as half-open ranges [start, replacement.seq).
    // A fractional anchor (e.g. turn-tail at 20.1) or trailing turn/end at 20 is inside [7, 21).
    expect(snapshot.revertShadowRanges).toEqual([
      { start: 7, end: 21 },
      { start: 25, end: 41 },
    ])
  })

  it('falls back to the host-mirrored boundary when the window has no revert/state event', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote())
    api.onHistory = () => Promise.resolve(ok({
      events: entries([userMessage(7, 'hello')] as never[]) as never[],
      hasMore: false,
      revertFromSeq: 7,
    } as never))
    await session.open()
    const snapshot = session.getSnapshot()
    expect(snapshot.revertFromSeq).toBe(7)
  })

  it('notifies immediately when a live revert/state event lands in an open session', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, api, fakeRemote())
    api.onHistory = () => Promise.resolve(ok({
      events: entries([userMessage(7, 'hello')] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    expect(session.getSnapshot().revertFromSeq).toBe(null)
    let notified = false
    session.subscribe(() => { notified = true })
    // Push live revert/state event
    session.handleMuxEnvelope('r1' as never, {
      type: 'session/event',
      sessionId: SID,
      event: revertState(8, 7) as never,
    })
    // Microtask flush
    await Promise.resolve()
    expect(session.getSnapshot().revertFromSeq).toBe(7)
    expect(notified).toBe(true)
  })
})