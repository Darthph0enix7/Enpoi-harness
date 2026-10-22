import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  apply as applyKeeper,
  createCheckpointService,
  getCheckpointService,
  latestCheckpoint,
  openToolBatch,
  resetKeeperRouteHealth,
  type Config,
} from '../src/index'

beforeEach(() => { resetKeeperRouteHealth() })

/**
 * Minimal session mock with a real surface fold for message events: `append`
 * honours `surfaceOp` (append / replace) so the checkpoint's one-live-node
 * contract is observable. `snapshotEvents(from)` honours the branded
 * `SessionLogOffset` read (it is a number) like the real Session.
 */
interface MockEvent {
  type: string
  seq: number
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

function makeSession(id = 'batch-session') {
  const log: MockEvent[] = []
  const nodes: number[] = []
  let nextSeq = 0
  const append = vi.fn((type: string, data: unknown, intent?: { surfaceOp?: unknown; sourceEventSeqs?: number[] }) => {
    const seq = nextSeq
    nextSeq += 1
    const event: MockEvent = { type, seq, data }
    if (intent?.surfaceOp !== undefined) event.surfaceOp = intent.surfaceOp
    if (intent?.sourceEventSeqs !== undefined) event.sourceEventSeqs = intent.sourceEventSeqs
    log.push(event)
    if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
      const op = intent?.surfaceOp
      if (op === undefined || op === 'append') {
        nodes.push(seq)
      } else if (typeof op === 'object' && op !== null) {
        const { startSeq, endSeq } = op as { startSeq: number; endSeq: number }
        const kept = nodes.filter((node) => node < startSeq || node > endSeq)
        kept.push(seq)
        kept.sort((left, right) => left - right)
        nodes.length = 0
        nodes.push(...kept)
      }
    }
    return event
  })
  const session = {
    id,
    header: { createdAt: Date.UTC(2026, 9, 22) },
    get seq() { return nextSeq },
    events: log,
    surface: { nodes },
    snapshotEvents: (from: unknown = 0, to?: number) => log.slice(Number(from) || 0, to ?? log.length),
    eventAt: (seq: number) => log[seq],
    requestContext: () => undefined,
    append,
  }
  return session
}

type MockSession = ReturnType<typeof makeSession>

/** Seed the preamble every scenario shares: a user turn and an assistant call. */
function seedTurn(session: MockSession): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { content: 'run the batch', source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Running a tool.' }] } }, { surfaceOp: 'append' })
}

/** Append one durable tool call (the real payload shape: `callId`). */
function appendToolCall(session: MockSession, callId: string): MockEvent {
  return session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"true"}' })
}

/** Append one durable tool result (the real payload shape: `message.toolCallId`). */
function appendToolResult(session: MockSession, callId: string): MockEvent {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', name: 'bash' },
      toolCallId: callId,
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    },
  }, { surfaceOp: 'append' })
}

/** The keeper's own checkpoint surface messages. */
function keeperMessages(session: MockSession): MockEvent[] {
  return session.events.filter((event) => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } }).source?.kind === 'enpoi-keeper')
}

/** Durable checkpoint events (one per refresh). */
function checkpointEvents(session: MockSession): MockEvent[] {
  return session.events.filter((event) => event.type === 'state/checkpoint')
}

const logIndex = (session: MockSession, event: MockEvent): number => session.events.indexOf(event)

/** Drain the queued flush microtask (plus one timer turn for safety). */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const baseConfig: Config = {
  provider: 'freellmapi',
  model: 'auto',
  fallbackProvider: 'antigravity',
  fallbackModel: 'gemini-3.7-flash-tiered',
  leaseMs: 45_000,
  maxInputEvents: 80,
  maxOutputTokens: 2048,
  structuralDistanceK: 24,
  minRefreshMs: 60_000,
  negativeCacheMs: 120_000,
  claimsBatchSize: 8,
  claimsBatchMinutes: 5,
  checkpointStaleEvents: 12,
  checkpointStaleHours: 24,
}

const BRIEF_A = '🎯 ACTIVE GOAL: first refresh\n- a checkpoint rendered while the tool batch is open'
const BRIEF_B = '🎯 ACTIVE GOAL: second refresh\n- the newest deferred checkpoint text must win'

/** ctx mock: a keeper-enabled settings reader, a scripted llm, and hooks. */
function makeCtx(briefs: string[] = []) {
  let call = 0
  const stream = async function* () {
    const brief = briefs.length === 0 ? BRIEF_A : briefs[Math.min(call, briefs.length - 1)]!
    call += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: brief }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: brief } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ capabilities: { tools: {} }, personas: {} }) }
      return undefined
    },
    llm: { stream: vi.fn(stream) },
    logger: { info: vi.fn(), warn: vi.fn() },
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
    effect: (factory: () => unknown) => factory(),
    setInterval: vi.fn(() => ({})),
    setTimeout: vi.fn(() => ({})),
  }
  return { ctx, handlers }
}

/** Mount the plugin and hand back the mounted service + its event hook. */
function mount(briefs: string[] = []) {
  const { ctx, handlers } = makeCtx(briefs)
  applyKeeper(ctx as never, baseConfig)
  const service = getCheckpointService()!
  const onEvent = handlers.get('session/event')!
  return { ctx, handlers, service, onEvent }
}

describe('enpoi-context-keeper openToolBatch probe', () => {
  it('reports unresolved calls and clears on the matching tool/result id', () => {
    const session = makeSession()
    expect(openToolBatch(session as never)).toBe(false)

    appendToolCall(session, 'call_1')
    expect(openToolBatch(session as never)).toBe(true)

    appendToolResult(session, 'call_1')
    expect(openToolBatch(session as never)).toBe(false)
  })

  it('stays open while any call of a parallel batch is unresolved', () => {
    const session = makeSession()
    appendToolCall(session, 'call_1')
    appendToolCall(session, 'call_2')
    appendToolResult(session, 'call_1')
    expect(openToolBatch(session as never)).toBe(true)
    appendToolResult(session, 'call_2')
    expect(openToolBatch(session as never)).toBe(false)
  })

  it('clears a dangling call only at a new step/turn barrier, never at step/end', () => {
    const session = makeSession()
    appendToolCall(session, 'call_dangling')
    session.append('step/end', { turn: 1, step: 1 })
    // Scheduler failure appends step/end with the call unresolved; a result can
    // still be appended by the resume-repair path, so this must stay open.
    expect(openToolBatch(session as never)).toBe(true)
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
    expect(openToolBatch(session as never)).toBe(true)
    session.append('turn/start', { turn: 2 })
    expect(openToolBatch(session as never)).toBe(false)
  })
})

describe('enpoi-context-keeper deferred checkpoint commit (tool-batch producer fix)', () => {
  it('never appends a checkpoint user message between tool/call and tool/result', async () => {
    const session = makeSession()
    seedTurn(session)
    const call = appendToolCall(session, 'call_mid_batch')
    const { service, onEvent } = mount()

    const result = await service.ensureCheckpoint(session as never)
    expect(result.ok).toBe(true)
    // The durable checkpoint landed; the surface message did not.
    expect(checkpointEvents(session)).toHaveLength(1)
    expect(keeperMessages(session)).toHaveLength(0)

    const toolResult = appendToolResult(session, 'call_mid_batch')
    onEvent(session, toolResult)
    await settle()

    const messages = keeperMessages(session)
    expect(messages).toHaveLength(1)
    const committed = logIndex(session, messages[0]!)
    expect(committed).toBeGreaterThan(logIndex(session, toolResult))
    expect(committed).toBeGreaterThan(logIndex(session, call))
    // Nothing of ours sits between the call and its result.
    const between = session.events
      .slice(logIndex(session, call) + 1, logIndex(session, toolResult))
      .filter((event) => event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'enpoi-keeper')
    expect(between).toHaveLength(0)
    // Exactly one live checkpoint node on the surface.
    expect(session.surface.nodes.filter((seq) => {
      const data = (session.eventAt(seq)?.data as { source?: { kind?: string } } | undefined)
      return data?.source?.kind === 'enpoi-keeper'
    })).toEqual([messages[0]!.seq])
  })

  it('commits immediately when no tool batch is open', async () => {
    const session = makeSession()
    seedTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
    const { service } = mount()

    const before = session.append.mock.calls.length
    const result = await service.ensureCheckpoint(session as never)
    expect(result.ok).toBe(true)
    const refreshCalls = session.append.mock.calls.slice(before)
    expect(refreshCalls.map((call) => call[0])).toEqual(['state/checkpoint', 'user/message'])
    const [, , intent] = refreshCalls[1] as [string, unknown, { surfaceOp?: unknown }]
    expect(intent).toEqual({ surfaceOp: 'append' })
    expect(keeperMessages(session)).toHaveLength(1)
    expect(openToolBatch(session as never)).toBe(false)
  })

  it('commits only the newest text once when two refreshes land in one batch', async () => {
    const session = makeSession()
    seedTurn(session)
    const call = appendToolCall(session, 'call_two_refreshes')
    const { service, onEvent } = mount([BRIEF_A, BRIEF_B])

    await service.ensureCheckpoint(session as never)
    await service.ensureCheckpoint(session as never, { force: true })
    expect(checkpointEvents(session)).toHaveLength(2) // v1 + v2, both durable
    expect(keeperMessages(session)).toHaveLength(0)

    const toolResult = appendToolResult(session, 'call_two_refreshes')
    onEvent(session, toolResult)
    await settle()

    const messages = keeperMessages(session)
    expect(messages).toHaveLength(1)
    const text = (messages[0]!.data as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(text).toContain('second refresh')
    expect(text).not.toContain('first refresh')
    expect(logIndex(session, messages[0]!)).toBeGreaterThan(logIndex(session, toolResult))
    expect(logIndex(session, call)).toBeLessThan(logIndex(session, messages[0]!))
  })

  it('does not commit into a batch that opens again before the flush runs', async () => {
    const session = makeSession()
    seedTurn(session)
    appendToolCall(session, 'call_one')
    const { service, onEvent } = mount()

    await service.ensureCheckpoint(session as never)
    // Batch one closes, then a fresh batch opens before any event is published.
    appendToolResult(session, 'call_one')
    const secondCall = appendToolCall(session, 'call_two')
    onEvent(session, secondCall)
    await settle()
    expect(keeperMessages(session)).toHaveLength(0) // call_two is still open

    const secondResult = appendToolResult(session, 'call_two')
    onEvent(session, secondResult)
    await settle()
    expect(keeperMessages(session)).toHaveLength(1)
    expect(logIndex(session, keeperMessages(session)[0]!)).toBeGreaterThan(logIndex(session, secondResult))
  })

  it('commits the pending text from the next ensureCheckpoint when no further event arrives', async () => {
    const session = makeSession()
    seedTurn(session)
    appendToolCall(session, 'call_silent')
    const { service } = mount()

    await service.ensureCheckpoint(session as never)
    expect(keeperMessages(session)).toHaveLength(0)
    // The batch closes, but the session publishes no event afterwards.
    const toolResult = appendToolResult(session, 'call_silent')

    await service.ensureCheckpoint(session as never)
    const messages = keeperMessages(session)
    expect(messages).toHaveLength(1)
    expect(logIndex(session, messages[0]!)).toBeGreaterThan(logIndex(session, toolResult))

    // Idempotent: a following wake never duplicates the commit.
    await service.ensureCheckpoint(session as never)
    expect(keeperMessages(session)).toHaveLength(1)
    expect(checkpointEvents(session)).toHaveLength(1)
  })

  it('drops a stale deferred text instead of resurrecting it over a newer checkpoint', async () => {
    const session = makeSession()
    seedTurn(session)
    appendToolCall(session, 'call_stale')
    const { ctx, service } = mount([BRIEF_A, BRIEF_B])

    await service.ensureCheckpoint(session as never) // deferred A, v1 in the log
    expect(keeperMessages(session)).toHaveLength(0)
    appendToolResult(session, 'call_stale') // batch closed, no event published

    // A second writer commits a newer checkpoint (v2, text B) first.
    const newer = createCheckpointService(ctx as never, baseConfig)
    await newer.ensureCheckpoint(session as never, { force: true })
    expect(latestCheckpoint(session as never)!.version).toBe(2)
    const committed = keeperMessages(session)
    expect(committed).toHaveLength(1)
    expect((committed[0]!.data as { content: Array<{ text?: string }> }).content[0]!.text).toContain('second refresh')

    // The stale pending A (v1) must not replace the newer node.
    const wake = await service.ensureCheckpoint(session as never)
    await settle()
    expect(wake.text).toContain('second refresh') // cache realigned, no stale text
    const after = keeperMessages(session)
    expect(after).toHaveLength(1)
    expect(after[0]!.seq).toBe(committed[0]!.seq)
    const text = (after[0]!.data as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(text).toContain('second refresh')
    expect(text).not.toContain('first refresh')
    expect(latestCheckpoint(session as never)!.version).toBe(2)
  })

  it('flushes through the live append publication boundary (real Session store)', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
    const { createToolResultMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      applyKeeper(ctx as never, baseConfig)
      const service = getCheckpointService()!
      const session = ctx.sessions.create(SessionId('live-batch-session'))
      session.append('turn/start', { turn: 1 })
      session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: 'run the live batch' }], source: { kind: 'user' } }),
        { surfaceOp: 'append' },
      )
      const callSeq = session.append('tool/call', {
        turn: 1, step: 1, callId: 'call_live', name: 'bash', arguments: '{"command":"true"}',
      }).seq

      // No llm service on this context: the deterministic template still yields
      // a checkpoint, which must be DEFERRED behind the open batch.
      const result = await service.ensureCheckpoint(session as never)
      expect(result.ok).toBe(true)
      expect(session.snapshotEvents().filter((event) => event.type === 'state/checkpoint')).toHaveLength(1)
      expect(session.snapshotEvents().filter((event) => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'enpoi-keeper')).toHaveLength(0)

      // The live append publishes `session/event` inside its own boundary; the
      // hook queues the flush as a microtask, so the nested checkpoint append
      // never trips "cannot reenter while another append is being published".
      const resultSeq = session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: 'call_live', content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] }).seq
      await settle()

      const committed = session.snapshotEvents().filter((event) => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'enpoi-keeper')
      expect(committed).toHaveLength(1)
      expect(committed[0]!.seq).toBeGreaterThan(resultSeq)
      expect(session.surface.nodes).toContain(committed[0]!.seq)
      expect(openToolBatch(session as never)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
