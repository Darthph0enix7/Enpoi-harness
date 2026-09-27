/**
 * Live settings, the compaction summariser seat, window-aware framing, and
 * the deterministic mechanical fallback.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import {
  applySettingsOverrides,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import {
  readCompactionSettings,
  resolveCompactionSeat,
} from '@deepseek-ai/dsh-compaction-basic/src/settings.ts'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'conversation-model'
const SEAT = 'seat-model'
const SEAT_PROVIDER = 'seat-provider'

/** Per-context document holder so a spec can replace the document in place. */
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

/** Context with the LLM runtime, projection registry, meter, and one adapter. */
function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return ctx
}

/** Recording adapter: known window, deterministic text summary. */
class RecordingAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined

  constructor(
    private readonly contextWindow: number,
    private readonly text = 'condensed summary',
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    const block: ContentBlock = { type: 'text', text: this.text }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Engine whose summarizer always fails, to force the mechanical fallback. */
class FailingSummaryEngine extends BasicCompactionEngine {
  protected override async summarize(): Promise<never> {
    throw new Error('summarizer offline')
  }
}

/** Closed two-message turns followed by one open turn. */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`settings-${turns}-${text.length}`))
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
        content: [{ type: 'text', text: `answer ${turn} ${text}` }],
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

function preStep(ctx: Context, owner: Agent, signal = SIGNAL) {
  return agentEvents(ctx, owner).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

describe('compaction settings reads', () => {
  it('reads and validates parameters.compaction field by field', () => {
    const ctx = createContext()
    withDocument(ctx, {
      parameters: {
        compaction: {
          thresholdRatio: 0.5,
          retainRatio: 0.1,
          headroomTokens: 1024,
          retainTokens: 64,
          pruneThresholdChars: 4096,
          pruneHeadChars: 2048,
          pruneTailChars: 512,
        },
      },
    })
    expect(readCompactionSettings(ctx)).toEqual({
      thresholdRatio: 0.5,
      retainRatio: 0.1,
      headroomTokens: 1024,
      retainTokens: 64,
      pruneThresholdChars: 4096,
      pruneHeadChars: 2048,
      pruneTailChars: 512,
    })
  })

  it('omits invalid values, the unset zero retention, and missing documents', () => {
    const ctx = createContext()
    expect(readCompactionSettings(ctx)).toEqual({})
    withDocument(ctx, {
      parameters: {
        compaction: {
          thresholdRatio: 0,
          retainRatio: 2,
          headroomTokens: 1.5,
          retainTokens: 0,
          pruneThresholdChars: -1,
          pruneHeadChars: 'many',
          pruneTailChars: -3,
        },
      },
    })
    expect(readCompactionSettings(ctx)).toEqual({})
    withDocument(ctx, { parameters: { compaction: 'nonsense' } })
    expect(readCompactionSettings(ctx)).toEqual({})
  })

  it('fails open when the settings service throws', () => {
    const ctx = createContext()
    ctx.reflect.provide('settings', {
      describe: () => { throw new Error('settings offline') },
    })
    expect(readCompactionSettings(ctx)).toEqual({})
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
  })

  it('resolves the compaction seat directly, through a chain, and fails open', () => {
    const ctx = createContext()
    expect(resolveCompactionSeat(ctx)).toBeUndefined()

    withDocument(ctx, { personas: { compaction: { provider: 'p', model: 'm' } } })
    expect(resolveCompactionSeat(ctx)).toEqual({ provider: 'p', model: 'm' })

    withDocument(ctx, {
      personas: { compaction: { chain: 'fast' } },
      chains: { fast: { links: [{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }] } },
    })
    expect(resolveCompactionSeat(ctx)).toEqual({ provider: 'p', model: 'm', chain: 'fast' })

    withDocument(ctx, { personas: { compaction: { chain: 'fast' } }, chains: { fast: { disabled: true } } })
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
    withDocument(ctx, { personas: { compaction: { chain: 'missing' } } })
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
    withDocument(ctx, { personas: { compaction: { chain: 'fast' } }, chains: { fast: { links: [{ model: 'm' }] } } })
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
    withDocument(ctx, { personas: { compaction: { provider: 'p' } } })
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
    withDocument(ctx, { personas: { compaction: 'keeper' } })
    expect(resolveCompactionSeat(ctx)).toBeUndefined()
  })

  it('overlays settings on the resolved config and rejects conflicting retention', () => {
    const config = resolveConfig({ headroomTokens: 1000, thresholdRatio: 0.8, retainRatio: 0.16 })
    expect(applySettingsOverrides(config, {})).toEqual(config)

    const overridden = applySettingsOverrides(config, {
      thresholdRatio: 0.5,
      retainRatio: 0.1,
      headroomTokens: 2048,
    })
    expect(overridden).toMatchObject({ thresholdRatio: 0.5, retainRatio: 0.1, headroomTokens: 2048 })

    // An absolute retention wins over the ratio, and an over-threshold ratio
    // falls back to the resolved config instead of failing the turn.
    expect(applySettingsOverrides(config, { retainRatio: 0.9, retainTokens: 128, thresholdRatio: 0.5 }))
      .toMatchObject({ retainTokens: 128 })
    expect(applySettingsOverrides(config, { thresholdRatio: 0.05 }))
      .toMatchObject({ thresholdRatio: 0.05, retainRatio: 0.16 })
  })
})

describe('settings-driven engine policy', () => {
  it('uses the live threshold ratio and the seat route for the summary call', async () => {
    const ctx = createContext()
    const conversationAdapter = new RecordingAdapter(100_000)
    const seatAdapter = new RecordingAdapter(100_000)
    ctx.llm.registerAdapter([MODEL], conversationAdapter)
    ctx.llm.registerAdapter([SEAT_PROVIDER], seatAdapter)
    withDocument(ctx, {
      parameters: { compaction: { thresholdRatio: 0.005, retainTokens: 1 } },
      personas: { compaction: { provider: SEAT_PROVIDER, model: SEAT } },
    })
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      headroomTokens: 0,
      maxTokens: 1000,
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = conversation(6, 'settings fixture '.repeat(60).trim())
    const result = await compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    // The seat route, not the conversation route, wrote the checkpoint.
    expect(seatAdapter.lastOptions?.provider).toBe(SEAT_PROVIDER)
    expect(seatAdapter.lastOptions?.model).toBe(SEAT)
    expect(conversationAdapter.lastOptions).toBeUndefined()
  })
})

describe('window-aware summariser framing', () => {
  it('caps the replay to a small summariser window and documents the gap', async () => {
    const ctx = createContext()
    const adapter = new RecordingAdapter(4_000)
    ctx.llm.registerAdapter([SEAT_PROVIDER], adapter)
    const session = conversation(6, 'region text '.repeat(80).trim())
    const compact = new BasicCompactionEngine(ctx, {
      auto: false,
      summarizationProvider: 'seat-provider',
      summarizationModel: SEAT,
      maxTokens: 1_000,
      headroomTokens: 0,
    })
    const nodes = [...session.surface.nodes]
    const nodeCount = nodes.length
    const result = await compact.compactRegion(
      nodes[0]!,
      nodes[nodeCount - 2]!,
      agent(session),
      SIGNAL,
    )
    const sent = adapter.lastOptions?.messages ?? []
    // Clipped: a suffix of the region + the instruction, fewer than replayed.
    expect(sent.length).toBeLessThan(nodeCount)
    expect(sent.at(-1)?.role).toBe('user')
    const sentText = JSON.stringify(sent)
    expect(sentText).toContain(`answer ${nodeCount / 2 - 1} `)
    expect(sentText).not.toContain('user 1 ')
    // The durable checkpoint documents which seqs were not condensed.
    const checkpoint = session.snapshotEvents().findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'compact-checkpoint')
    expect(JSON.stringify(checkpoint)).toContain('[compaction coverage]')
    expect(JSON.stringify(checkpoint)).toContain('session_event_search')
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
  })

  it('keeps the raw replay without a framing budget and still clips without a meter', async () => {
    const ctx = createContext()
    const adapter = new RecordingAdapter(10_000)
    ctx.llm.registerAdapter([MODEL], adapter)
    const session = conversation(2)
    const input = { messages: session.deriveMessages() }
    await summarizeWithLlm(ctx, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 100,
    }, input, agent(session), SIGNAL)
    expect(adapter.lastOptions?.messages).toHaveLength(input.messages.length + 1)

    // A budget with no meter at all still frames deterministically.
    const meterless = new Context()
    void new LlmRuntime(meterless)
    const sparse = new RecordingAdapter(1_000)
    meterless.llm.registerAdapter([MODEL], sparse)
    await summarizeWithLlm(meterless, {
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 100,
    }, input, agent(session), SIGNAL, { inputBudgetTokens: 1 })
    expect(sparse.lastOptions?.messages.length).toBeLessThan(input.messages.length + 1)
  })
})

describe('deterministic mechanical fallback', () => {
  it('frees space, keeps the turn alive, and never masks the transcript', async () => {
    const ctx = createContext()
    ctx.llm.registerAdapter([MODEL], new RecordingAdapter(10_000))
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    new FailingSummaryEngine(ctx, {
      auto: true,
      headroomTokens: 0,
      maxTokens: 8192,
      thresholdRatio: 0.05,
      retainTokens: 90,
    })
    const session = conversation(4)
    const before = [...session.surface.nodes]
    const beforeTokens = ctx.tokenMeter.measure(session).totalTokens

    await expect(preStep(ctx, agent(session))).resolves.toEqual({ kind: 'enter', messages: [] })

    // The turn survives (the pre-step decision is unchanged) and space is freed.
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(beforeTokens)
    const events = session.snapshotEvents()
    // Transcript intact: every pre-existing event is still logged.
    for (const seq of before) expect(events.some(event => event.seq === seq)).toBe(true)
    // UI rule: the replacement is a compact-checkpoint, never a user/compaction
    // span, so the chat fold renders every row (doc 66 §3h).
    const replacement = events.findLast(event => event.type === 'user/message'
      && event.data.source?.kind === 'compact-checkpoint')
    expect(replacement).toBeDefined()
    expect(JSON.stringify(replacement)).toContain('session_event_search')
    expect(events.some(event => event.type === 'revert/state')).toBe(false)
    expect(events.findLast(event => event.type === 'compaction/end')?.data)
      .not.toHaveProperty('error')
    // The turn survives every warning: nothing aborts the step. The pressure
    // guard's informational "cannot relieve pressure" warning is a refusal to
    // retry, not an aborted step.
    expect(warnings
      .filter(message => !message.includes('cannot relieve pressure'))
      .every(message => message.includes('continuing the turn'))).toBe(true)
  })

  it('never manufactures a stub larger than the freed span', async () => {
    const ctx = createContext()
    ctx.llm.registerAdapter([MODEL], new RecordingAdapter(10_000))
    const compact = new FailingSummaryEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192 })
    const session = Session.create(SessionId('tiny-span'))
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
    const nodes = session.surface.nodes

    // No balanced prefix of the tiny span beats the stub: the original error
    // surfaces instead of a useless replacement.
    await expect(compact.compactRegion(nodes[0]!, nodes[1]!, agent(session), SIGNAL))
      .rejects.toThrow('summarizer offline')
    expect(session.snapshotEvents().some(event => event.type === 'compaction/end'
      && event.data.error !== undefined)).toBe(true)
  })
})
