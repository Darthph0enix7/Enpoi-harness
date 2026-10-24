/**
 * Summariser capability coordination: conservative unknown-window framing,
 * size-class frame retries, route escalation, the route circuit breaker, the
 * guaranteed mechanical relief, and explicit unrecoverable failures.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine, { SUMMARIZER_CIRCUIT_OPEN_CODE } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmFailure,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'resilience': { kind: 'resilience' }
  }
}

const SIGNAL = new AbortController().signal
const MODEL = 'conversation-model'
const SEAT_PROVIDER = 'seat-provider'
const SEAT_MODEL = 'seat-model'

/** The measured live refusal: a 400 with no useful provider body. */
const SIZE_FAILURE: LlmFailure = {
  code: 'INVALID_REQUEST',
  message: 'llm-pi-ai: provider "kilo" request failed without failover (INVALID_REQUEST): '
    + '400 "The upstream provider was unable to process the request"',
}

/** Per-context document holder so a spec can replace the settings document in place. */
const documents = new WeakMap<Context, { current: Record<string, unknown> }>()

/** Provide (once) one structurally valid `enpoi-orchestration` document. */
function withDocument(ctx: Context, document: Record<string, unknown>): void {
  const existing = documents.get(ctx)
  if (existing !== undefined) {
    existing.current = document
    return
  }
  const holder = { current: document }
  documents.set(ctx, holder)
  ctx.reflect.provide('settings', {
    describe: () => [{ ns: 'enpoi-orchestration', value: holder.current }],
  })
}

/**
 * Adapter that records every request and either succeeds with one text summary
 * or ends the stream with a terminal failure.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly window: number | undefined
  private readonly failure: LlmFailure | undefined
  private readonly failuresRemaining: number

  constructor(window: number | undefined, failure?: LlmFailure, failFirstCalls = Number.POSITIVE_INFINITY) {
    super()
    this.window = window
    this.failure = failure
    this.failuresRemaining = failFirstCalls
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.window === undefined ? {} : { context: { contextWindow: this.window } },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.failure !== undefined && this.requests.length <= this.failuresRemaining) {
      yield { type: 'finish', reason: { kind: 'error', failure: this.failure } }
      return
    }
    const block: ContentBlock = { type: 'text', text: 'condensed summary' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Engine exposing the protected summariser hook for direct ladder tests. */
class ExposedEngine extends BasicCompactionEngine {
  runSummarize(input: SummarizationInput, owner: Agent): Promise<SummaryResult> {
    return this.summarize(input, owner, SIGNAL)
  }
}

/** Engine whose summarizer always fails with a non-size-class error. */
class OfflineSummaryEngine extends BasicCompactionEngine {
  protected override async summarize(): Promise<never> {
    throw new Error('summarizer offline')
  }
}

/** Closed two-message turns followed by one open turn. */
function conversation(turns = 4, text = 'fixture detail '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`resilience-${turns}-${text.length}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

/** Idle agent stub that runs maintenance immediately, for `/compact`. */
function maintenanceAgent(session: Session): Agent {
  return {
    session,
    options: {},
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(SIGNAL)
    },
  } as unknown as Agent
}

/** One replayed user message per entry, for direct summariser framing tests. */
function replayInput(count: number, text = 'detail '.repeat(40).trim()): SummarizationInput {
  return {
    messages: Array.from({ length: count }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `${text} ${index}` }],
      source: { kind: 'resilience' },
    })),
  }
}

/** Priced route-token total of one pre-measurement span snapshot. */
function pricedSpan(
  prices: ReadonlyMap<SessionSeq, number>,
  seqs: readonly SessionSeq[],
): number {
  return seqs.reduce((total, seq) => total + (prices.get(seq) ?? 0), 0)
}

/** The latest summary event's recorded provider/model and shadowed range. */
function latestSummary(session: Session) {
  return session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
}

describe('unknown summariser window', () => {
  it('frames a conservative budget, marks the clip, and keeps the newest replay as a prefix', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    const adapter = new ScriptedAdapter(undefined)
    ctx.llm.registerAdapter([MODEL], adapter)
    const compact = new ExposedEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
      summarizerUnknownWindowTokens: 2_000,
    })
    const input = replayInput(60)

    const result = await compact.runSummarize(input, agent(conversation(1)))

    expect(result.windowClipped).toBe(true)
    expect(result.conservativeWindowClip).toBe(true)
    const sent = adapter.requests[0]?.messages ?? []
    // The instruction is appended after the replay; the replay itself is a
    // strict, byte-identical suffix of the input, never the whole region.
    const replay = sent.slice(0, -1)
    expect(replay.length).toBeLessThan(input.messages.length)
    expect(replay).toEqual(input.messages.slice(input.messages.length - replay.length))
    expect(replay.at(-1)).toEqual(input.messages.at(-1))
  })

  it('documents the conservative cap in the durable checkpoint note', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    ctx.llm.registerAdapter([MODEL], new ScriptedAdapter(undefined))
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
      summarizerUnknownWindowTokens: 300,
    })
    const session = conversation(10, 'detail '.repeat(10).trim())
    const nodes = [...session.surface.nodes]

    await compact.compactRegion(nodes[0]!, nodes.at(-2)!, agent(session), SIGNAL)

    const replacement = session.snapshotEvents().findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'compact-checkpoint')
    expect(JSON.stringify(replacement)).toContain('could not be resolved')
    expect(JSON.stringify(replacement)).toContain('session_event_search')
  })
})

describe('size-class frame retries and route escalation', () => {
  it('shrinks the same compaction, then summarizes on the session route and keeps the tail', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    withDocument(ctx, { personas: { compaction: { provider: SEAT_PROVIDER, model: SEAT_MODEL } } })
    const seat = new ScriptedAdapter(200_000, SIZE_FAILURE)
    const sessionRoute = new ScriptedAdapter(200_000)
    ctx.llm.registerAdapter([SEAT_PROVIDER], seat)
    ctx.llm.registerAdapter([MODEL], sessionRoute)
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
    })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const start = nodes[0]!
    const end = nodes[5]!

    const result = await compact.compactRegion(start, end, agent(session), SIGNAL)

    // The seat route rejected twice, each time with a smaller frame.
    expect(seat.requests).toHaveLength(2)
    expect(seat.requests.every(request => request.provider === SEAT_PROVIDER)).toBe(true)
    expect(seat.requests[1]!.messages.length).toBeLessThan(seat.requests[0]!.messages.length)

    // The escalated attempt names the session's own route and shrinks again.
    expect(sessionRoute.requests).toHaveLength(1)
    expect(sessionRoute.requests[0]?.provider).toBe(MODEL)
    expect(sessionRoute.requests[0]?.model).toBe(MODEL)
    expect(sessionRoute.requests[0]!.messages.length).toBeLessThan(seat.requests[1]!.messages.length)

    // The tail survives verbatim and is what the successful frame carried.
    const sentReplay = sessionRoute.requests[0]!.messages.slice(0, -1)
    expect(JSON.stringify(sentReplay.at(-1))).toContain('assistant 3')
    expect(JSON.stringify(sentReplay)).not.toContain('fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail fixture detail user 1')

    // The committed region is the smaller suffix: older nodes stay on the surface.
    expect(result.shadowedSeqs.at(-1)).toBe(end)
    expect(result.shadowedSeqs.length).toBeLessThan(6)
    expect(result.shadowedSeqs[0]).not.toBe(start)
    expect(session.surface.nodes).toContain(start)
    expect(latestSummary(session)?.data).toMatchObject({ provider: MODEL, model: MODEL })
  })
})

describe('mechanical fallback relief', () => {
  it('frees at least the configured share of the selected span', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    const compact = new OfflineSummaryEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
      mechanicalFallbackFreeShare: 0.5,
    })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]
    const start = nodes[0]!
    const end = nodes[5]!
    const beforeMeasurement = ctx.tokenMeter.measure(session)
    const before = beforeMeasurement.totalTokens
    const prices = new Map(beforeMeasurement.nodes.map(node => [node.seq, node.tokens]))
    const spanTokens = pricedSpan(prices, [start, ...nodes.slice(1, 6)])
    const startIdx = nodes.indexOf(start)
    const endIdx = nodes.indexOf(end)
    const spanSeqs = nodes.slice(startIdx, endIdx + 1)

    await compact.compactRegion(start, end, agent(session), SIGNAL)

    const after = ctx.tokenMeter.measure(session).totalTokens
    const freed = before - after
    const summary = latestSummary(session)
    const dropped = pricedSpan(prices, summary!.data.shadowedSeqs)
    const stubTokens = dropped - freed
    expect(stubTokens).toBeGreaterThan(0)
    expect(spanSeqs.length).toBe(6)
    if (summary!.data.shadowedRange.start !== start) {
      // Mid-span cut: the freed tokens are at least the guaranteed share.
      expect(freed).toBeGreaterThanOrEqual(Math.ceil(spanTokens * 0.5))
    } else {
      // Clamp: the whole selected span is the maximum relief available.
      expect(freed).toBeGreaterThan(stubTokens)
    }
    expect(freed).toBeGreaterThan(0)
    expect(session.surface.nodes).toContain(end)
  })
})

describe('summariser route circuit breaker', () => {
  it('stops paying a failing route at K and re-probes after a configuration change', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    const adapter = new ScriptedAdapter(100_000, SIZE_FAILURE)
    ctx.llm.registerAdapter([MODEL], adapter)
    const config: BasicCompactionConfig = {
      auto: true,
      headroomTokens: 0,
      maxTokens: 8192,
      summarizerCircuitFailures: 2,
    }
    const compact = new ExposedEngine(ctx, config)
    const session = conversation(1)
    const owner = agent(session)
    const input = replayInput(2)

    await expect(compact.runSummarize(input, owner)).rejects.toThrow(/400/)
    await expect(compact.runSummarize(input, owner)).rejects.toThrow(/400/)
    expect(adapter.requests).toHaveLength(2)

    // The circuit is open: the route is not called again, and the reason is a
    // stable class a mechanical checkpoint can record.
    await expect(compact.runSummarize(input, owner)).rejects.toMatchObject({
      code: SUMMARIZER_CIRCUIT_OPEN_CODE,
    })
    expect(adapter.requests).toHaveLength(2)

    // A revision of the routed configuration is a different route target: it
    // re-probes instead of inheriting the open breaker.
    withDocument(ctx, { personas: { compaction: { provider: SEAT_PROVIDER, model: SEAT_MODEL } } })
    const seat = new ScriptedAdapter(100_000)
    ctx.llm.registerAdapter([SEAT_PROVIDER], seat)
    await compact.runSummarize(input, owner)
    expect(seat.requests).toHaveLength(1)
  })

  it('re-enables the same route on an explicit /compact', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    const adapter = new ScriptedAdapter(100_000, SIZE_FAILURE, 2)
    ctx.llm.registerAdapter([MODEL], adapter)
    const compact = new ExposedEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
      summarizerCircuitFailures: 2,
    })
    const session = conversation(4)
    session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    const input = replayInput(2)
    const owner = agent(session)

    await expect(compact.runSummarize(input, owner)).rejects.toThrow(/400/)
    await expect(compact.runSummarize(input, owner)).rejects.toThrow(/400/)
    expect(adapter.requests).toHaveLength(2)

    // /compact resets the breaker and the route answers on the next paid call.
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(compact.compactNow(maintenanceAgent(session), SIGNAL)).resolves.not.toBeNull()
    expect(adapter.requests).toHaveLength(3)
  })

  it('records the open circuit on the mechanical checkpoint it forces', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    ctx.llm.registerAdapter([MODEL], new ScriptedAdapter(100_000, SIZE_FAILURE))
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
      summarizerCircuitFailures: 1,
      summarizerFrameRetries: 0,
    })
    const session = conversation(4)
    const nodes = [...session.surface.nodes]

    await compact.compactRegion(nodes[0]!, nodes[5]!, agent(session), SIGNAL)

    expect(latestSummary(session)?.data).toMatchObject({
      provider: '',
      model: '',
      summarizationFailure: { code: 'INVALID_REQUEST' },
    })
  })
})

describe('unrecoverable compaction', () => {
  it('closes with an explicit failure and never fabricates a summary', async () => {
    const ctx = newContext(['session_event_search', 'session_event_read'])
    const compact = new OfflineSummaryEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 8192,
    })
    const session = Session.create(SessionId('unrecoverable'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tiny' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const nodes = [...session.surface.nodes]

    await expect(compact.compactRegion(nodes[0]!, nodes[1]!, agent(session), SIGNAL))
      .rejects.toThrow('summarizer offline')
    const events = session.snapshotEvents()
    expect(events.findLast(event => event.type === 'compaction/end')?.data.error)
      .toContain('summarizer offline')
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
  })
})

describe('resilience configuration', () => {
  it('resolves shipped defaults and rejects out-of-range bounds', () => {
    expect(resolveConfig({})).toMatchObject({
      summarizerUnknownWindowTokens: 16_384,
      summarizerFrameRetries: 2,
      summarizerFrameShrinkRatio: 0.5,
      summarizerEscalationFailures: 2,
      summarizerCircuitFailures: 4,
      mechanicalFallbackFreeShare: 0.5,
    })
    expect(() => resolveConfig({ summarizerUnknownWindowTokens: 0 }))
      .toThrow(/summarizerUnknownWindowTokens.*positive integer/)
    expect(() => resolveConfig({ summarizerFrameRetries: -1 }))
      .toThrow(/summarizerFrameRetries.*non-negative integer/)
    expect(() => resolveConfig({ summarizerFrameShrinkRatio: 1 }))
      .toThrow(/summarizerFrameShrinkRatio.*\(0, 1\)/)
    expect(() => resolveConfig({ summarizerEscalationFailures: 0 }))
      .toThrow(/summarizerEscalationFailures.*positive integer/)
    expect(() => resolveConfig({ summarizerCircuitFailures: 0 }))
      .toThrow(/summarizerCircuitFailures.*positive integer/)
    expect(() => resolveConfig({ mechanicalFallbackFreeShare: 0 }))
      .toThrow(/mechanicalFallbackFreeShare.*\(0, 1\]/)
  })
})

/** Fresh context with the runtime, projections, meter, and visible recall tools. */
function newContext(visibleTools: readonly string[]): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const visible = new Set(visibleTools)
  ctx.reflect.provide('tools', {
    get: (name: string) => visible.has(name) ? { name } : undefined,
  })
  return ctx
}
