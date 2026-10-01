import { describe, expect, it } from 'vitest'
import { Session } from '../src/client/sessions/session.ts'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRevertFold, RevertFileOutcome } from '../src/types.ts'
import { foldRevertEvents, revertFoldValue } from '../src/revert-fold.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'
import { entries, ev } from './event-script.client.ts'
import { hostRevertFold } from './remote/history.client.ts'

const SID = 'revert-fold-test' as SessionId

/** Minimal structural snapshot slice the ChatView filter reads. */
interface RevertFilterSnapshot {
  readonly revertFromSeq: number | null
  readonly revertShadowRanges: readonly { readonly start: number; readonly end: number }[]
}

/** ChatView's hide predicate over a session snapshot (ChatView.tsx:116-134). */
function hidden(snapshot: RevertFilterSnapshot, seq: number): boolean {
  if (snapshot.revertFromSeq !== null && seq >= snapshot.revertFromSeq) return true
  return snapshot.revertShadowRanges.some(range => seq >= range.start && seq < range.end)
}

/** Open one Session over a window whose page carries an independently folded host block. */
async function openWith(
  windowEvents: readonly unknown[],
  fold: SessionRevertFold,
  hasMore = true,
): Promise<Session> {
  const api = new FakeApiClient()
  const session = new Session(SID, fakeRemote(api))
  api.onHistory = () => Promise.resolve(ok({
    records: entries(windowEvents as never[]),
    hasMore,
    revert: fold,
  } as never))
  await session.open()
  return session
}

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

/** One single-node checkpoint refresh: the declared span is exactly the replaced node. */
function checkpointRefresh(seq: number, replaced: number): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      content: [{ type: 'text', text: '### State checkpoint' }],
      source: { kind: 'enpoi-keeper' },
      role: 'user',
      id: `checkpoint-${seq}`,
    },
    surfaceOp: { op: 'replace', startSeq: replaced, endSeq: replaced },
    sourceEventSeqs: [replaced],
  }
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

  it('keeps every row for replacements no revert boundary claims', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    api.onHistory = () => Promise.resolve(ok({
      records: entries([
        userMessage(7, 'hello'),
        ...assistantTurn(8, 1),
        checkpointRefresh(13, 7),
      ] as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    // Product rule: a replacement is shadowed only while a user-activated
    // revert boundary is live. A keeper refresh (and any future edit/retry
    // writer) leaves every row visible, including the superseded message.
    expect(session.getSnapshot().revertShadowRanges).toEqual([])
    // An edit-and-resend carries a user source but no boundary: not a revert.
    session.acceptEventChange({
      type: 'append',
      entry: { type: 'event', event: revertCommit(19, 'edited', [7]) as never },
    })
    expect(session.getSnapshot().revertShadowRanges).toEqual([])
  })

  it('re-installs a replace window without accumulating duplicate shadow ranges', async () => {
    const api = new FakeApiClient()
    const session = new Session(SID, fakeRemote(api))
    const window = [
      userMessage(7, 'hello'),
      revertState(8, 7),
      ...assistantTurn(9, 1),
      revertCommit(14, 'goodbye', [7, 8, 9, 10, 13]),
      revertState(15, null),
    ]
    api.onHistory = () => Promise.resolve(ok({
      records: entries(window as never[]) as never[],
      hasMore: false,
    } as never))
    await session.open()
    expect(session.getSnapshot().revertShadowRanges).toEqual([{ start: 7, end: 14 }])
    // A gap-repair re-install carries the same complete window: the fold is
    // rebuilt, not layered, so the range is not duplicated.
    session.acceptEventChange({
      type: 'replace',
      entries: entries(window as never[]) as never,
      hasMore: false,
      page: { records: [], hasMore: false } as never,
    })
    expect(session.getSnapshot().revertShadowRanges).toEqual([{ start: 7, end: 14 }])
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

  it('keeps a shadow range when the opening window is cut inside (marker, settlement]', async () => {
    // The revert-while-running shape: `revert()` appends the marker M=8, the
    // cancelled turn settles an interrupted assistant message at L=9 > M, and
    // the next send commits R=10 with surfaceOp replace spanning [7, 9]. A page
    // cut inside (M, L] serves [9, 10] without M.
    const full = [
      userMessage(7, 'hello'),
      revertState(8, 7),
      ev.assistant(SessionSeq(9), 2, 'late interrupted settlement'),
      revertCommit(10, 'after the revert', [7, 8, 9]),
    ] as never[]
    const session = await openWith([full[2], full[3]], hostRevertFold(full, 10))
    const snapshot = session.getSnapshot()
    // The durable fold knows the commit shadowed [7, 10) even though neither
    // the anchor nor the marker is inside the loaded window.
    expect(snapshot.revertFromSeq).toBe(null)
    expect(snapshot.revertShadowRanges).toEqual([{ start: 7, end: 10 }])
    expect(hidden(snapshot, 9)).toBe(true)
    expect(hidden(snapshot, 7)).toBe(true)
    expect(hidden(snapshot, 10)).toBe(false)

    // Witness: a window-only fold over the same cut resurrects the shadowed
    // settlement, which is the defect the durable source removes.
    const legacy = await openWith([full[2], full[3]], {
      fromSeq: null, shadowRanges: [], conflicts: [], outcomes: {}, asOfSeq: -1,
    })
    expect(hidden(legacy.getSnapshot(), 9)).toBe(false)
  })

  it('keeps an armed boundary whose marker is outside the opening window', async () => {
    const full = [
      userMessage(7, 'hello'),
      revertState(8, 7),
      ev.assistant(SessionSeq(9), 1, 'still running'),
    ] as never[]
    const session = await openWith([full[2]], hostRevertFold(full, 9))
    const snapshot = session.getSnapshot()
    expect(snapshot.revertFromSeq).toBe(7)
    expect(hidden(snapshot, 9)).toBe(true)
  })

  it('keeps a pending file conflict and its outcomes outside the opening window', async () => {
    const full = [
      userMessage(7, 'hello'),
      revertState(8, 7),
      {
        type: 'revert/file-conflict', seq: 9, time: Date.now(),
        data: { conflictId: 'cf-1', targetKey: 'src/a.ts', displayPath: 'src/a.ts', state: 'conflict', reason: 'diverged' },
      },
      {
        type: 'revert/file-result', seq: 10, time: Date.now(),
        data: { revertSeq: 10, outcomes: { 'src/b.ts': { status: 'applied' } } },
      },
      ev.assistant(SessionSeq(11), 1, 'window start'),
    ] as never[]
    const session = await openWith([full[4]], hostRevertFold(full, 11))
    const snapshot = session.getSnapshot()
    expect(snapshot.revertFileConflicts.map(conflict => conflict.conflictId)).toEqual(['cf-1'])
    expect(snapshot.revertFileOutcomes).toEqual({ 'src/b.ts': { status: 'applied' } })

    const legacy = await openWith([full[4]], {
      fromSeq: null, shadowRanges: [], conflicts: [], outcomes: {}, asOfSeq: -1,
    })
    expect(legacy.getSnapshot().revertFileConflicts).toEqual([])
  })

  it.each([1, 2, 3, 5, 8, 13, 21, 34])(
    'flat and incremental folds agree at every step (seed %i)',
    async (seed) => {
      const events = randomScript(seed) as unknown as Parameters<typeof hostRevertFold>[0] & Parameters<typeof foldRevertEvents>[0]
      const cut = 10 + (seed % 8)
      const session = await openWith(events.slice(cut, cut + 2), hostRevertFold(events, cut - 1))
      expectFoldEquals(session, revertFoldValue(foldRevertEvents(events, cut + 1), cut + 1))
      for (let seq = cut + 2; seq < events.length; seq++) {
        session.acceptEventChange({
          type: 'append',
          entry: { type: 'event', event: events[seq] as never },
        })
        expectFoldEquals(session, revertFoldValue(foldRevertEvents(events, seq), seq))
      }
    },
  )

  it('does not resurrect outcomes and conflicts cleared by a later revert/state', async () => {
    // Explicit monoid witness: the durable prefix carries an outcome and a
    // conflict, a later revert/state resets both, and a new conflict lands in
    // the window. A naive prefix/suffix merge would keep the stale outcome.
    const events = [
      {
        type: 'revert/file-conflict', seq: 0, time: Date.now(),
        data: { conflictId: 'cf-old', targetKey: 'src/a.ts', displayPath: 'src/a.ts', state: 'conflict', reason: 'diverged' },
      },
      {
        type: 'revert/file-result', seq: 1, time: Date.now(),
        data: { revertSeq: 1, outcomes: { 'src/a.ts': { status: 'applied' } } },
      },
      revertState(2, 4),
      {
        type: 'revert/file-conflict', seq: 3, time: Date.now(),
        data: { conflictId: 'cf-new', targetKey: 'src/c.ts', displayPath: 'src/c.ts', state: 'conflict', reason: 'diverged' },
      },
      userMessage(4, 'anchor'),
      revertCommit(5, 'replacement', [4]),
    ] as never[]
    const session = await openWith([events[2], events[3]], hostRevertFold(events, 1))
    session.acceptEventChange({ type: 'append', entry: { type: 'event', event: events[4] as never } })
    session.acceptEventChange({ type: 'append', entry: { type: 'event', event: events[5] as never } })
    const snapshot = session.getSnapshot()
    expect(snapshot.revertFileOutcomes).toEqual({})
    expect(snapshot.revertFileConflicts.map(conflict => conflict.conflictId)).toEqual(['cf-new'])
    expect(snapshot.revertShadowRanges).toEqual([{ start: 4, end: 5 }])
    expectFoldEquals(session, revertFoldValue(foldRevertEvents(events), 5))
  })
})

/** One file-revert conflict event. */
function conflictEvent(seq: number, conflictId: string, targetKey: string): Record<string, unknown> {
  return {
    type: 'revert/file-conflict',
    seq,
    time: Date.now(),
    data: { conflictId, targetKey, displayPath: targetKey, state: 'conflict', reason: 'diverged' },
  }
}

/** One file-revert outcome event. */
function resultEvent(seq: number, targetKey: string, status: string): Record<string, unknown> {
  return {
    type: 'revert/file-result',
    seq,
    time: Date.now(),
    data: { revertSeq: seq, outcomes: { [targetKey]: { status } } satisfies Record<string, RevertFileOutcome> },
  }
}

/** Deterministic revert-heavy script; every seq is contiguous from 0. */
function randomScript(seed: number): Record<string, unknown>[] {
  let state = (seed * 2654435761) % 2147483647
  const rand = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const events: Record<string, unknown>[] = []
  let boundary: number | null = null
  while (events.length < 48) {
    const seq = events.length
    const roll = rand()
    if (roll < 0.2) {
      const from: number | null = boundary === null || rand() < 0.4 ? null : Math.floor(rand() * (seq + 1))
      events.push(revertState(seq, from))
      boundary = from
    } else if (roll < 0.4) {
      events.push(userMessage(seq, `prompt ${seq}`))
    } else if (roll < 0.56 && seq > 0) {
      events.push(revertCommit(seq, `replacement ${seq}`, [Math.floor(rand() * (seq + 1))]))
      if (boundary !== null) boundary = null
    } else if (roll < 0.7) {
      events.push(conflictEvent(seq, `cf-${seq}`, `file-${Math.floor(rand() * 3)}`))
    } else if (roll < 0.86) {
      events.push(resultEvent(seq, `file-${Math.floor(rand() * 3)}`, rand() < 0.5 ? 'pending_conflict' : 'applied'))
    } else {
      events.push(revertState(seq, null))
      boundary = null
    }
  }
  return events
}

function expectFoldEquals(session: Session, expected: SessionRevertFold): void {
  const snapshot = session.getSnapshot()
  expect({
    fromSeq: snapshot.revertFromSeq,
    shadowRanges: snapshot.revertShadowRanges,
    conflicts: snapshot.revertFileConflicts,
    outcomes: snapshot.revertFileOutcomes,
  }).toEqual({
    fromSeq: expected.fromSeq,
    shadowRanges: expected.shadowRanges,
    conflicts: expected.conflicts,
    outcomes: expected.outcomes,
  })
}
