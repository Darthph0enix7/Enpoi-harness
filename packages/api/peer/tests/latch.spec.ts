import { describe, expect, it } from 'vitest'
import {
  PEER_BUDGET_STOP_REASON,
  PeerLatchFold,
  RECENT_MODEL_HOPS_LIMIT,
  foldExecutionState,
  modelHopOf,
  modelHopReasonOf,
  readExecutionStateValue,
  readHostLatch,
  readModelSelectionProjection,
  readTokenUsageProjection,
  tokenBudgetOf,
  type PeerFoldEvent,
} from '../src/latch.ts'

function event(seq: number, type: string, data: unknown): PeerFoldEvent {
  return { seq, time: seq * 10, type, data }
}

/** One durable chain-failure record with prose that must never reach the peer wire. */
function attemptFailed(
  seq: number,
  provider: string,
  model: string,
  code: string,
  next: { readonly provider: string; readonly model: string },
  chain = 'free',
): PeerFoldEvent {
  return event(seq, 'llm/attempt-failed', {
    provider,
    model,
    code,
    message: `provider prose https://provider.example/request/${String(seq)}`,
    chain,
    link: seq,
    next,
  })
}

/** One assistant message naming the route that answered it. */
function answered(
  seq: number,
  turn: number,
  provider: string,
  model: string,
  options: { readonly chain?: string; readonly usage?: unknown } = {},
): PeerFoldEvent {
  return event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: {
      source: {
        kind: 'model',
        provider,
        model,
        ...(options.chain === undefined ? {} : { chain: options.chain }),
      },
      content: [],
    },
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  })
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

  it('rejects malformed host participant actions and non-peer participants', async () => {
    const { isPeerParticipant } = await import('../src/latch.ts')
    expect(readHostLatch({
      executionState: {
        latch: 'idle',
        activeDescendants: 0,
        lastParticipantAction: { action: 'teleport', actor: { kind: 'peer', name: 'x' }, at: 1 },
      },
    })?.lastParticipantAction).toBeUndefined()
    expect(readHostLatch({
      executionState: {
        latch: 'idle',
        activeDescendants: 0,
        lastParticipantAction: { action: 'prompt', actor: { kind: 'peer', name: 'x' } },
      },
    })?.lastParticipantAction).toBeUndefined()
    expect(isPeerParticipant({ kind: 'peer', name: 'laptop' })).toBe(true)
    expect(isPeerParticipant({ kind: 'peer' })).toBe(false)
    expect(isPeerParticipant(null)).toBe(false)
  })

  it('tolerates malformed durable records without inventing facts', () => {
    const fold = new PeerLatchFold()
    fold.apply(event(0, 'turn/start', null))
    fold.apply(event(0, 'subagent/catalog', { childId: 'early-child' }))
    fold.apply(event(1, 'turn/start', { turn: 1 }))
    fold.apply(event(2, 'turn/end', null))
    fold.apply(event(3, 'turn/end', { turn: 'x', reason: { kind: 'completed' } }))
    fold.apply(event(4, 'turn/end', { turn: Number.NaN, reason: { kind: 'completed' } }))
    fold.apply(event(5, 'turn/start', { turn: 2 }))
    fold.apply(event(6, 'assistant/message', null))
    fold.apply(event(7, 'llm/attempt-failed', null))
    fold.apply(event(8, 'approval/asked', null))
    fold.apply(event(9, 'approval/decided', null))
    fold.apply(event(10, 'approval/asked', { id: 'no-reason' }))
    fold.apply(event(11, 'approval/decided', {}))
    fold.apply(event(12, 'subagent/catalog', null))
    fold.apply(event(13, 'subagent/catalog', { childId: 'late-child' }))
    fold.apply(event(14, 'user/message', { source: { kind: 'user' } }))
    fold.apply(event(15, 'user/message', { source: { kind: 'user', participant: { kind: 'robot', name: 'x' } } }))
    fold.apply(event(16, 'user/message', { source: { kind: 'subagent-settled' } }))
    fold.apply(event(17, 'model/selection', null))
    fold.apply(event(18, 'model/selection', { provider: 'only-provider' }))
    fold.recordPeerAction(undefined)
    expect(fold.activeDescendants()).toBe(1)
    const state = fold.snapshot([])
    expect(state.lastTurnEnd).toBeUndefined()
    expect(state.recentModelHops).toBeUndefined()
    expect(state.model).toBeUndefined()
    // The reason-less approval stays pending, so a human must still act.
    expect(state.latch).toBe('waiting_approval')
    expect(state.lastParticipantAction).toMatchObject({
      action: 'prompt',
      actor: { kind: 'human', name: 'local' },
    })
  })

  it('reads every malformed carrier field defensively', () => {
    const base = { latch: 'idle', activeDescendants: 0, descendantsExact: true }
    expect(readExecutionStateValue({ ...base, lastTurnEnd: 'nope' })?.lastTurnEnd).toBeUndefined()
    expect(readExecutionStateValue({ ...base, lastTurnEnd: { reason: 'completed', at: 1 } })?.lastTurnEnd)
      .toBeUndefined()
    expect(readExecutionStateValue({
      ...base,
      lastTurnEnd: { turn: 1, reason: 'error', at: 1, error: {} },
    })?.lastTurnEnd).toEqual({ turn: 1, reason: 'error', at: 1 })
    expect(readExecutionStateValue({
      ...base,
      lastTurnEnd: { turn: 1, reason: 'error', at: 1, error: { code: 'X' } },
    })?.lastTurnEnd).toEqual({ turn: 1, reason: 'error', at: 1, error: { code: 'X', message: 'X' } })
    expect(readExecutionStateValue({
      ...base,
      lastTurnEnd: {
        turn: 1,
        reason: 'error',
        at: 1,
        error: { code: 'X', message: 'm', provider: 'p', model: 'm' },
      },
    })?.lastTurnEnd).toEqual({
      turn: 1,
      reason: 'error',
      at: 1,
      error: { code: 'X', message: 'm', provider: 'p', model: 'm' },
    })
    expect(readExecutionStateValue({
      ...base,
      lastParticipantAction: { action: 'prompt', at: 1 },
    })?.lastParticipantAction).toBeUndefined()
    expect(readExecutionStateValue({
      ...base,
      lastParticipantAction: { action: 'prompt', actor: { kind: 'peer', name: 'x', device: 'dev' }, at: 1, detail: 'd' },
    })?.lastParticipantAction).toEqual({
      action: 'prompt',
      actor: { kind: 'peer', name: 'x', device: 'dev' },
      at: 1,
      detail: 'd',
    })
    expect(readExecutionStateValue({
      ...base,
      lastParticipantAction: { action: 'prompt', actor: { kind: 'peer', name: 'x' }, at: 1 },
    })?.lastParticipantAction).toEqual({ action: 'prompt', actor: { kind: 'peer', name: 'x' }, at: 1 })
    expect(readExecutionStateValue({
      ...base,
      model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    })?.model).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(readModelSelectionProjection({ modelSelection: { lastUsed: { provider: 'p' }, next: null } }))
      .toBeUndefined()
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

describe('turn model attribution', () => {
  it('reports the answering route and counts the hops tried before it', () => {
    const state = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      attemptFailed(1, 'kilo', 'a', 'RATE_LIMIT', { provider: 'kilo', model: 'b' }),
      attemptFailed(2, 'kilo', 'b', 'SERVER', { provider: 'kilo', model: 'c' }),
      attemptFailed(3, 'kilo', 'c', 'TIMEOUT', { provider: 'kilo', model: 'd' }),
      answered(4, 1, 'kilo', 'd', {
        chain: 'free',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      }),
      event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(state.lastTurnEnd).toEqual({
      turn: 1,
      reason: 'completed',
      at: 50,
      ran: {
        provider: 'kilo',
        model: 'd',
        chain: 'free',
        hops: 3,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
    })
    expect(state.recentModelHops?.map(hop => [hop.from.model, hop.to?.model, hop.reason, hop.at])).toEqual([
      ['a', 'b', 'rate-limit', 10],
      ['b', 'c', 'error', 20],
      ['c', 'd', 'error', 30],
    ])
    expect(state.recentModelHops?.[0]?.chain).toBe('free')
  })

  it('resets the hop count between turns and keeps earlier hops in the recent window', () => {
    const state = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      attemptFailed(1, 'kilo', 'a', 'RATE_LIMIT', { provider: 'kilo', model: 'b' }),
      answered(2, 1, 'kilo', 'b', { usage: { inputTokens: 4, outputTokens: 2 } }),
      event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(4, 'turn/start', { turn: 2 }),
      answered(5, 2, 'openrouter', 'free', { chain: 'free' }),
      event(6, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(state.lastTurnEnd?.ran).toEqual({ provider: 'openrouter', model: 'free', chain: 'free', hops: 0 })
    expect(state.recentModelHops).toHaveLength(1)
  })

  it('omits `ran` for a turn no assistant message answered', () => {
    const state = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(state.lastTurnEnd).toEqual({ turn: 1, reason: 'completed', at: 10 })
  })

  it('keeps an interrupted turn without an answer unattributed and does not leak its hops', () => {
    const state = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      attemptFailed(1, 'kilo', 'a', 'SERVER', { provider: 'kilo', model: 'b' }),
      event(2, 'turn/end', {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'user', participant: { kind: 'human', name: 'adam' } } },
      }),
      event(3, 'turn/start', { turn: 2 }),
      answered(4, 2, 'kilo', 'b'),
      event(5, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ])
    expect(state.lastTurnEnd?.ran).toEqual({ provider: 'kilo', model: 'b', hops: 0 })
    expect(state.recentModelHops).toHaveLength(1)
    expect(state.recentModelHops?.[0]?.reason).toBe('error')
  })

  it('omits per-turn usage when the message carries none or a malformed sample', () => {
    const absent = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      answered(1, 1, 'kilo', 'a'),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(absent.lastTurnEnd?.ran).toEqual({ provider: 'kilo', model: 'a', hops: 0 })
    const malformed = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      answered(1, 1, 'kilo', 'a', { usage: { inputTokens: '3', outputTokens: 2 } }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(malformed.lastTurnEnd?.ran).toEqual({ provider: 'kilo', model: 'a', hops: 0 })
    const badCache = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      answered(1, 1, 'kilo', 'a', { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 'x' } }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(badCache.lastTurnEnd?.ran).toEqual({ provider: 'kilo', model: 'a', hops: 0 })
  })

  it('keeps only the newest hops and still counts every failure in the turn', () => {
    const events: PeerFoldEvent[] = [event(0, 'turn/start', { turn: 1 })]
    const total = RECENT_MODEL_HOPS_LIMIT + 8
    for (let index = 0; index < total; index += 1) {
      events.push(attemptFailed(
        index + 1,
        'kilo',
        `m${String(index)}`,
        'SERVER',
        { provider: 'kilo', model: `m${String(index + 1)}` },
      ))
    }
    events.push(answered(total + 1, 1, 'kilo', `m${String(total)}`))
    events.push(event(total + 2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const state = foldExecutionState(events)
    expect(state.lastTurnEnd?.ran?.hops).toBe(total)
    expect(state.recentModelHops).toHaveLength(RECENT_MODEL_HOPS_LIMIT)
    expect(state.recentModelHops?.[0]?.from.model).toBe(`m${String(total - RECENT_MODEL_HOPS_LIMIT)}`)
    expect(state.recentModelHops?.at(-1)?.from.model).toBe(`m${String(total - 1)}`)
  })

  it('ignores an assistant message with no route or outside an open turn', () => {
    const outside = foldExecutionState([
      answered(0, 1, 'kilo', 'a'),
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(outside.lastTurnEnd?.ran).toBeUndefined()
    const notModel = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'synthetic', provider: 'kilo', model: 'a' }, content: [] },
      }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(notModel.lastTurnEnd?.ran).toBeUndefined()
    const missingRoute = foldExecutionState([
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'assistant/message', {
        turn: 1,
        step: 1,
        message: { source: { kind: 'model', provider: 'kilo' }, content: [] },
      }),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])
    expect(missingRoute.lastTurnEnd?.ran).toBeUndefined()
  })

  it('keeps derived route attribution when the host latch supplies the terminal', () => {
    const fold = new PeerLatchFold()
    fold.apply(event(0, 'turn/start', { turn: 1 }))
    fold.apply(attemptFailed(1, 'kilo', 'a', 'RATE_LIMIT', { provider: 'kilo', model: 'b' }))
    fold.apply(answered(2, 1, 'kilo', 'b'))
    fold.apply(event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const hostLatch = {
      latch: 'idle' as const,
      activeDescendants: 0,
      descendantsExact: true,
      lastTurnEnd: { turn: 1, reason: 'completed' as const, at: 99 },
    }
    expect(fold.snapshot([], hostLatch).lastTurnEnd).toEqual({
      turn: 1,
      reason: 'completed',
      at: 99,
      ran: { provider: 'kilo', model: 'b', hops: 1 },
    })
    // A host terminal for another turn, or one that already carries `ran`,
    // is authoritative and never rewritten.
    expect(fold.snapshot([], { ...hostLatch, lastTurnEnd: { turn: 2, reason: 'completed', at: 100 } }).lastTurnEnd)
      .toEqual({ turn: 2, reason: 'completed', at: 100 })
    expect(fold.snapshot([], {
      ...hostLatch,
      lastTurnEnd: { turn: 1, reason: 'completed', at: 99, ran: { provider: 'x', model: 'y', hops: 0 } },
    }).lastTurnEnd).toEqual({ turn: 1, reason: 'completed', at: 99, ran: { provider: 'x', model: 'y', hops: 0 } })
  })

  it('stamps stop budget only on the turn the watcher stopped', () => {
    const watcherStop: PeerFoldEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', {
        turn: 1,
        reason: { kind: 'aborted', reason: { kind: 'hook', reason: PEER_BUDGET_STOP_REASON } },
      }),
    ]
    // The durable marker alone decides: no budget argument, so a restart that
    // re-folds the log reports the same stamp.
    expect(foldExecutionState(watcherStop).lastTurnEnd?.stop).toBe('budget')
    // A human cancel records a user cause and is never stamped, even when the
    // fold is asked about an over-budget session through its usage projections.
    const humanCancel: PeerFoldEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]
    expect(foldExecutionState(humanCancel).lastTurnEnd?.stop).toBeUndefined()
    expect(foldExecutionState(humanCancel).lastTurnEnd?.reason).toBe('aborted')
    const unmarked: PeerFoldEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }),
    ]
    expect(foldExecutionState(unmarked).lastTurnEnd?.stop).toBeUndefined()
    const completed: PeerFoldEvent[] = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(foldExecutionState(completed).lastTurnEnd?.stop).toBeUndefined()
    // A newer unmarked turn replaces the marked terminal, so the old stamp no
    // longer applies to what the caller reads.
    expect(foldExecutionState([
      ...watcherStop,
      event(2, 'turn/start', { turn: 2 }),
      event(3, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ]).lastTurnEnd?.stop).toBeUndefined()
  })

  it('stamps a host-latch terminal only when its turn carries the durable marker', () => {
    const fold = new PeerLatchFold()
    fold.apply(event(0, 'turn/start', { turn: 1 }))
    fold.apply(event(1, 'turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'hook', reason: PEER_BUDGET_STOP_REASON } },
    }))
    const hosted = fold.snapshot([], {
      latch: 'idle',
      activeDescendants: 0,
      descendantsExact: true,
      lastTurnEnd: { turn: 1, reason: 'aborted', at: 7 },
    })
    expect(hosted.lastTurnEnd).toEqual({ turn: 1, reason: 'aborted', at: 7, stop: 'budget' })
    // A host terminal for another turn is not rewritten.
    const other = fold.snapshot([], {
      latch: 'idle',
      activeDescendants: 0,
      descendantsExact: true,
      lastTurnEnd: { turn: 2, reason: 'aborted', at: 9 },
    })
    expect(other.lastTurnEnd).toEqual({ turn: 2, reason: 'aborted', at: 9 })
  })
})

describe('model-hop derivation', () => {
  // The real code vocabulary: every literal the LLM runtime chain can escalate
  // on (`CHAIN_ESCALATION_CODES`), the retry/terminal codes, and the adapter
  // codes the DeepSeek transport emits. No TypeScript union exists for `code`,
  // so this table is the exhaustive contract of the closed mapping.
  const EXPECTED: Readonly<Record<string, string>> = {
    RATE_LIMIT: 'rate-limit',
    PROVIDER_POOL_EXHAUSTED: 'rate-limit',
    AUTH: 'unavailable',
    FREE_TIER_GATED: 'unavailable',
    ENTITLEMENT_GATED: 'unavailable',
    INVALID_CREDENTIAL: 'unavailable',
    MISSING_CREDENTIAL: 'unavailable',
    QUOTA: 'unavailable',
    ACCOUNT_QUOTA: 'unavailable',
    NO_ADAPTER: 'unavailable',
    UNKNOWN_MODEL: 'unavailable',
    PROVIDER_MODEL_OUTAGE: 'unavailable',
    EMPTY_RESPONSE: 'error',
    STREAM_CUT: 'error',
    STREAM_CLOSED: 'error',
    SERVER: 'error',
    TIMEOUT: 'error',
    TRANSPORT: 'error',
    CONTEXT_WINDOW_EXCEEDED: 'error',
    INVALID_REQUEST: 'error',
    POLICY_REFUSAL: 'error',
    MODEL_CHAIN_EXHAUSTED: 'error',
    IMAGE_OFFLOAD_REQUIRED: 'error',
    ABORTED: 'error',
    UNKNOWN: 'error',
    BAD_REQUEST: 'error',
    HTTP_500: 'error',
  }

  it('maps every real failure code into the closed hop vocabulary', () => {
    for (const [code, reason] of Object.entries(EXPECTED)) {
      expect(modelHopReasonOf(code), code).toBe(reason)
    }
    expect(modelHopReasonOf('SOMETHING_NEW')).toBe('error')
    // No durable code represents a skipped cooling route yet.
    expect(Object.values(EXPECTED)).not.toContain('cooldown')
  })

  it('drops provider prose and keeps only the allow-listed hop fields', () => {
    const hop = modelHopOf(attemptFailed(7, 'kilo', 'a', 'RATE_LIMIT', { provider: 'openrouter', model: 'b' }))
    expect(hop).toEqual({
      from: { provider: 'kilo', model: 'a' },
      to: { provider: 'openrouter', model: 'b' },
      reason: 'rate-limit',
      chain: 'free',
      at: 70,
    })
    expect(JSON.stringify(hop)).not.toContain('provider.example')
    expect(JSON.stringify(hop)).not.toContain('prose')
  })

  it('repeats the route for a credential-pool rotation and rejects malformed records', () => {
    expect(modelHopOf(event(3, 'llm/attempt-failed', {
      provider: 'kilo',
      model: 'a',
      code: 'AUTH',
      message: 'gate',
      identity: 'one',
      next: { identity: 'two' },
    }))).toEqual({
      from: { provider: 'kilo', model: 'a' },
      to: { provider: 'kilo', model: 'a' },
      reason: 'unavailable',
      at: 30,
    })
    expect(modelHopOf(event(4, 'llm/attempt-failed', { provider: 'kilo', model: 'a' }))).toBeUndefined()
    expect(modelHopOf(event(5, 'llm/attempt-failed', { provider: 'kilo', model: 'a', code: 'SERVER', next: {} })))
      .toMatchObject({ to: { provider: 'kilo', model: 'a' } })
    // No `next` object at all: the route pair has no successor to report.
    expect(modelHopOf(event(6, 'llm/attempt-failed', { provider: 'kilo', model: 'a', code: 'SERVER' })))
      .toEqual({ from: { provider: 'kilo', model: 'a' }, reason: 'error', at: 60 })
    expect(modelHopOf({ time: 1, data: null })).toBeUndefined()
  })
})

describe('usage, budget, and selection projections', () => {
  it('maps the token-usage projection into the four peer buckets', () => {
    expect(readTokenUsageProjection({
      tokenUsage: { uncachedInputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 },
    })).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 })
    expect(readTokenUsageProjection({})).toBeUndefined()
    expect(readTokenUsageProjection(undefined)).toBeUndefined()
    expect(readTokenUsageProjection({ tokenUsage: { uncachedInputTokens: 1, outputTokens: 2 } })).toBeUndefined()
    expect(readTokenUsageProjection({
      tokenUsage: { uncachedInputTokens: -1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })).toBeUndefined()
  })

  it('computes the ceiling view only for a valid ceiling and reports whether usage was read', () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
    expect(tokenBudgetOf(usage, undefined)).toBeUndefined()
    expect(tokenBudgetOf(usage, -1)).toBeUndefined()
    expect(tokenBudgetOf(usage, 1.5)).toBeUndefined()
    // An unreadable projection is reported as unmetered, not as a spent ceiling.
    expect(tokenBudgetOf(undefined, 10)).toEqual({
      maxTotalTokens: 10,
      usedTokens: 0,
      exceeded: false,
      metered: false,
    })
    expect(tokenBudgetOf(usage, 10)).toEqual({
      maxTotalTokens: 10,
      usedTokens: 10,
      exceeded: true,
      metered: true,
    })
    expect(tokenBudgetOf(usage, 11)).toEqual({
      maxTotalTokens: 11,
      usedTokens: 10,
      exceeded: false,
      metered: true,
    })
    expect(tokenBudgetOf(undefined, 0)).toEqual({
      maxTotalTokens: 0,
      usedTokens: 0,
      exceeded: false,
      metered: false,
    })
  })

  it('reads the effective selection from the projection wire view, not a raw pending key', () => {
    // The wire view is `{ lastUsed, next }` with `next = pending ?? lastUsed`;
    // the old reader looked for `pending` and therefore dropped a pending switch.
    expect(readModelSelectionProjection({
      modelSelection: {
        lastUsed: { provider: 'deepseek', model: 'flash' },
        next: { provider: 'kilo', model: 'free', chain: 'free' },
      },
    })).toEqual({ provider: 'kilo', model: 'free', chain: 'free' })
    expect(readModelSelectionProjection({
      modelSelection: {
        lastUsed: { provider: 'deepseek', model: 'flash' },
        next: null,
      },
    })).toEqual({ provider: 'deepseek', model: 'flash' })
    // A host publishing state instead of the view keeps `pending` authoritative.
    expect(readModelSelectionProjection({
      modelSelection: {
        lastUsed: { provider: 'deepseek', model: 'flash' },
        pending: { provider: 'kilo', model: 'free' },
      },
    })).toEqual({ provider: 'kilo', model: 'free' })
    expect(readModelSelectionProjection({ modelSelection: { lastUsed: null, next: null } })).toBeUndefined()
    expect(readModelSelectionProjection({})).toBeUndefined()
    expect(readModelSelectionProjection(undefined)).toBeUndefined()
  })
})
