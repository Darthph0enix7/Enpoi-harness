import { describe, expect, it } from 'vitest'
import {
  PeerLatchFold,
  foldExecutionState,
  readExecutionStateValue,
  readHostLatch,
  type PeerFoldEvent,
} from '../src/latch.ts'

function event(seq: number, type: string, data: unknown): PeerFoldEvent {
  return { seq, time: seq * 10, type, data }
}

describe('derived execution latch', () => {
  it('matches the hand-built expectation across one turn lifecycle', () => {
    const events: PeerFoldEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'subagent/catalog', { version: 0, childId: 'child-a', childCreatedAt: 5, mode: 'one-shot' }),
    ]
    let state = foldExecutionState(events)
    expect(state).toMatchObject({
      latch: 'waiting_subagents',
      activeDescendants: 1,
      descendantsExact: false,
      source: 'derived',
    })

    events.push(event(2, 'user/message', {
      id: 'settled-a',
      source: { kind: 'subagent-settled', senderSessionId: 'child-a', form: 'notice', summary: 'done' },
    }))
    state = foldExecutionState(events)
    expect(state.latch).toBe('running')
    expect(state.activeDescendants).toBe(0)
    expect(state.descendantsExact).toBe(true)

    events.push(event(3, 'approval/asked', { id: 'ask-1', toolName: 'bash', callId: 'call-1', reason: 'rm' }))
    state = foldExecutionState(events)
    expect(state.latch).toBe('waiting_approval')

    events.push(event(4, 'approval/decided', { id: 'ask-1', outcome: 'allowed-once' }))
    events.push(event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    state = foldExecutionState(events)
    expect(state.latch).toBe('idle')
    expect(state.lastTurnEnd).toEqual({ turn: 1, reason: 'completed', at: 50 })
  })

  it('carries structured turn errors and human cancel attribution', () => {
    const state = foldExecutionState([
      event(0, 'turn/start', { turn: 4 }),
      event(1, 'turn/end', {
        turn: 4,
        reason: {
          kind: 'aborted',
          reason: { kind: 'user', participant: { kind: 'human', name: 'adam' } },
          error: { code: 'BALANCE', message: 'insufficient balance', provider: 'deepseek', model: 'flash' },
        },
      }),
    ])
    expect(state.lastTurnEnd).toMatchObject({
      turn: 4,
      reason: 'aborted',
      error: { code: 'BALANCE', message: 'insufficient balance', provider: 'deepseek', model: 'flash' },
    })
    expect(state.lastParticipantAction).toMatchObject({
      action: 'cancel',
      actor: { kind: 'human', name: 'adam' },
    })
    expect(state.latch).toBe('idle')
  })

  it('prefers host-latch facts and pending asks over the derived fold', () => {
    const fold = new PeerLatchFold()
    fold.apply(event(0, 'turn/start', { turn: 1 }))
    const state = fold.snapshot(
      [{ kind: 'question', askId: 'peer-ask' as never, questions: [], since: 1 }],
      {
        latch: 'waiting_approval',
        activeDescendants: 2,
        descendantsExact: true,
        since: 99,
      },
    )
    expect(state).toMatchObject({
      latch: 'waiting_approval',
      activeDescendants: 2,
      descendantsExact: true,
      source: 'host-latch',
      since: 99,
    })
    expect(state.pendingAsks).toHaveLength(1)
  })

  it('reads a host-published execution-state projection', () => {
    expect(readHostLatch({
      executionState: {
        latch: 'waiting_subagents',
        active_descendants: 3,
        descendants_exact: true,
        since: 12,
        model: { provider: 'deepseek', model: 'flash' },
      },
    })).toMatchObject({
      latch: 'waiting_subagents',
      activeDescendants: 3,
      descendantsExact: true,
      since: 12,
      model: { provider: 'deepseek', model: 'flash' },
    })
    expect(readHostLatch({ executionState: { latch: 'nonsense' } })).toBeUndefined()
    expect(readHostLatch(undefined)).toBeUndefined()
  })

  it('reads a session.executionState value structurally', () => {
    expect(readExecutionStateValue({
      latch: 'waiting_subagents',
      since: 7,
      source: 'host-latch',
      activeDescendants: 2,
      descendantsExact: true,
      pendingAsks: [],
      lastTurnEnd: { turn: 3, reason: 'completed', at: 9 },
      lastParticipantAction: { action: 'prompt', actor: { kind: 'peer', name: 'laptop' }, at: 10 },
      model: { provider: 'deepseek', model: 'flash' },
    })).toMatchObject({
      latch: 'waiting_subagents',
      activeDescendants: 2,
      descendantsExact: true,
      since: 7,
      lastTurnEnd: { turn: 3, reason: 'completed', at: 9 },
      lastParticipantAction: { action: 'prompt', actor: { kind: 'peer', name: 'laptop' }, at: 10 },
      model: { provider: 'deepseek', model: 'flash' },
    })
    expect(readExecutionStateValue({ latch: 'idle' })).toBeUndefined()
    expect(readExecutionStateValue(undefined)).toBeUndefined()
  })

  it('tracks model selection and peer prompt attribution', () => {
    const fold = new PeerLatchFold()
    fold.apply(event(0, 'model/selection', { provider: 'deepseek', model: 'flash', chain: 'fast' }))
    fold.recordPeerAction({
      action: 'prompt',
      actor: { kind: 'peer', name: 'server-orchestrator', device: 'serverlocal' },
      at: 42,
    })
    const state = fold.snapshot([])
    expect(state.model).toEqual({ provider: 'deepseek', model: 'flash', chain: 'fast' })
    expect(state.lastParticipantAction).toMatchObject({
      action: 'prompt',
      actor: { kind: 'peer', name: 'server-orchestrator', device: 'serverlocal' },
    })
  })
})
