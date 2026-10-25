import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  EMPTY_RESPONSE_CODE,
  ENTITLEMENT_GATED_CODE,
  FREE_TIER_GATED_CODE,
  FREE_TIER_GATED_EXPLANATION,
  LLM_ATTEMPT_FAILED_EVENT,
  LlmAdapter,
  LlmError,
  MODEL_CHAIN_EXHAUSTED_CODE,
  ReasoningEffortId,
  resolveRetryPolicy,
  STREAM_CLOSED_CODE,
  type GenerateOptions,
  type LlmAttemptFailedEventData,
  type LlmResolvedModelInfo,
  type ResolvedModelChain,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'answered by the fallback link' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'answered by the fallback link' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A completed `stop` whose only text block is empty. */
const EMPTY_TEXT_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A completed `stop` that carries reasoning but no answer text or tool call. */
const REASONING_ONLY_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'thinking only' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking only' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** {@link SCRIPT} with its terminal chunk attributed to the link that answered it. */
function answeredBy(provider: string, model: string): StreamChunk[] {
  const finish = SCRIPT[SCRIPT.length - 1]
  if (finish?.type !== 'finish') throw new Error('SCRIPT must end with a finish chunk')
  return [...SCRIPT.slice(0, -1), { ...finish, answeringLink: { provider, model } }]
}

class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield* this.script
  }
}

class FailingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly failure: Error) {
    super()
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    throw this.failure
  }
}

/** Every model of an effort-test adapter advertises the same three levels. */
function effortReasoning(): NonNullable<LlmResolvedModelInfo['reasoning']> {
  return {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
      { id: ReasoningEffortId('max'), name: 'Max' },
    ],
  }
}

/** {@link ScriptedAdapter} whose models expose adapter-owned reasoning levels. */
class EffortScriptedAdapter extends ScriptedAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoning: effortReasoning() })
  }
}

/** {@link FailingAdapter} whose models expose adapter-owned reasoning levels. */
class EffortFailingAdapter extends FailingAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoning: effortReasoning() })
  }
}

/**
 * {@link ScriptedAdapter} advertising one level of its own and no other: a
 * request carrying any foreign effort id is rejected before provider I/O.
 */
class DefaultOnlyAdapter extends ScriptedAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('standard'), name: 'Standard' }],
        defaultEffort: ReasoningEffortId('standard'),
      },
    })
  }
}

/** {@link ScriptedAdapter} whose models expose a catalogue context window. */
class ContextScriptedAdapter extends ScriptedAdapter {
  constructor(script: StreamChunk[], private readonly windows: Readonly<Record<string, number>>) {
    super(script)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[model]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }
}

/** Emits nothing and stays pending until its request signal aborts. */
class HangingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const signal = options.signal
    return (async function* () {
      if (signal === undefined) throw new Error('hanging adapter needs a signal')
      await new Promise<never>((_resolve, reject) => {
        const stop = (): void => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('link aborted'))
        }
        if (signal.aborted) {
          stop()
          return
        }
        signal.addEventListener('abort', stop, { once: true })
      })
    })()
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function captureStderr(): { text: () => string } {
  const lines: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  })
  return { text: () => lines.join('') }
}

function provideChains(ctx: Context, resolve: (id: string) => ResolvedModelChain | undefined): void {
  ctx.provide('modelChains', { resolve })
}

/** One captured durable attempt record, as the session store received it. */
interface CapturedRecord {
  type: string
  data: unknown
}

/**
 * Structural stand-in for the optional session store the seam appends attempt
 * records to: only the live session `session-1` is addressable.
 */
function provideSessions(ctx: Context, records: CapturedRecord[]): void {
  ctx.provide('sessions', {
    get: (id: string) => id === 'session-1'
      ? {
        append: (type: string, data: unknown): { seq: number } => {
          records.push({ type, data })
          return { seq: records.length }
        },
      }
      : undefined,
  })
}

/** A session-stamped request, so the seam's attempt records have a log to enter. */
function request(options: Omit<GenerateOptions, 'sessionId'>): GenerateOptions {
  return { ...options, sessionId: 'session-1' } as GenerateOptions
}

/** Read one captured record as the event payload the seam wrote. */
function attemptRecord(record: CapturedRecord): LlmAttemptFailedEventData {
  expect(record.type).toBe(LLM_ATTEMPT_FAILED_EVENT)
  return record.data as LlmAttemptFailedEventData
}

function group(id: string, ...links: Array<[string, string]>): ResolvedModelChain {
  return { id, links: links.map(([provider, model]) => ({ provider, model })) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('model-group failover', () => {
  it('re-issues a retryable pre-commit failure on the next link and yields one clean stream', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError('link a is down', 'RATE_LIMIT'))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'stable' ? group('stable', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const request = {
      provider: 'chain-a',
      model: 'm-a',
      chain: 'stable',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    } as GenerateOptions
    const chunks = await collect(ctx.llm.stream(request))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(failing.calls).toHaveLength(1)
    expect(answering.calls).toHaveLength(1)
    expect(answering.calls[0]?.provider).toBe('chain-b')
    expect(answering.calls[0]?.model).toBe('m-b')
    expect(answering.calls[0]?.messages).toBe(request.messages)
    expect(stderr.text()).toContain(
      '[model-chain] stable: link 1 chain-a/m-a → RETRYABLE (RATE_LIMIT) → link 2 chain-b/m-b',
    )
  })

  it('ignores legacy attempts/onCut keys on a resolved group', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError('link a is down', 'RATE_LIMIT'))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    // The documented snapshot still carries these keys for fork consumers, but
    // the core loop reads neither: one attempt per link, then the next link.
    const withLegacyPolicies = {
      id: 'legacy',
      links: [{ provider: 'chain-a', model: 'm-a' }, { provider: 'chain-b', model: 'm-b' }],
      attempts: 2,
      onCut: 'continue' as const,
    }
    provideChains(ctx, id => id === 'legacy' ? withLegacyPolicies : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'legacy',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    // `attempts: 2` does not add a per-link retry; `onCut: continue` does not
    // change the pre-commit escalation that kills this link.
    expect(failing.calls).toHaveLength(1)
    expect(answering.calls).toHaveLength(1)
  })

  it('rotates a link whose model is not configured on its provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError(
      'pi-ai provider "chain-a" has no configured model "stale-model"', 'UNKNOWN_MODEL',
    ))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'stale' ? group('stale', ['chain-a', 'stale-model'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'stale-model',
      chain: 'stale',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(answering.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] stale: link 1 chain-a/stale-model → RETRYABLE (UNKNOWN_MODEL) → link 2 chain-b/m-b',
    )
  })

  it('dispatches a link with its declared effort over the request effort', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new EffortFailingAdapter(new LlmError('link a is down', 'RATE_LIMIT'))
    const answering = new EffortScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'efforts' ? {
      id: 'efforts',
      links: [
        { provider: 'chain-a', model: 'm-a', effort: 'high' },
        { provider: 'chain-b', model: 'm-b', effort: 'max' },
      ],
    } : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'efforts',
      reasoningEffort: ReasoningEffortId('low'),
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    // The running link's own effort wins over the request's; the fallback link
    // carries its declared effort too.
    expect(failing.calls[0]?.reasoningEffort).toBe('high')
    expect(answering.calls[0]?.reasoningEffort).toBe('max')
  })

  it('runs a fallback link on its own default when it declares no effort and cannot accept the request effort', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new EffortFailingAdapter(new LlmError('link a is down', 'RATE_LIMIT'))
    const answering = new DefaultOnlyAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'foreign-effort' ? group('foreign-effort', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'foreign-effort',
      reasoningEffort: ReasoningEffortId('low'),
      messages: [],
    }))

    // The active link keeps the request's effort; the fallback declares none
    // and its adapter does not advertise "low", so it must run on its own
    // default instead of rejecting the inherited id.
    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(failing.calls[0]?.reasoningEffort).toBe('low')
    expect(answering.calls[0]?.reasoningEffort).toBe('standard')
  })

  it('inherits the request effort on the active link when the group declares none', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new EffortFailingAdapter(new LlmError('link a is down', 'RATE_LIMIT'))
    const answering = new EffortScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'inherit' ? {
      id: 'inherit',
      links: [
        { provider: 'chain-a', model: 'm-a' },
        { provider: 'chain-b', model: 'm-b', effort: 'max' },
      ],
    } : undefined)
    captureStderr()

    await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'inherit',
      reasoningEffort: ReasoningEffortId('low'),
      messages: [],
    }))

    // The active link keeps inheriting the request's effort; the fallback
    // link carries its own declared effort.
    expect(failing.calls[0]?.reasoningEffort).toBe('low')
    expect(answering.calls[0]?.reasoningEffort).toBe('max')
  })

  it('rejects a link effort the link model does not advertise before provider I/O', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const named = new EffortScriptedAdapter(SCRIPT)
    const fallback = new EffortScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], named)
    ctx.llm.registerAdapter(['chain-b'], fallback)
    provideChains(ctx, id => id === 'invalid-effort' ? {
      id: 'invalid-effort',
      links: [
        { provider: 'chain-a', model: 'm-a', effort: 'ultra' },
        { provider: 'chain-b', model: 'm-b' },
      ],
    } : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'invalid-effort',
      messages: [],
    }))

    // The exact-model check is the same one a seat's effort passes: an
    // unadvertised level fails before provider I/O instead of clamping,
    // and it is not a failover class.
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'provider "chain-a" model "m-a" does not support reasoning effort "ultra"',
          code: 'UNSUPPORTED_REASONING_EFFORT',
          provider: 'chain-a',
          model: 'm-a',
        },
      },
    })
    expect(named.calls).toHaveLength(0)
    expect(fallback.calls).toHaveLength(0)
  })

  it('does not report an answering link when the request route answered its own link', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], answering)
    ctx.llm.registerAdapter(['chain-b'], new FailingAdapter(new LlmError('must not run', 'RATE_LIMIT')))
    provideChains(ctx, id => id === 'own' ? group('own', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'own',
      messages: [],
    }))

    expect(chunks).toStrictEqual(SCRIPT)
  })

  it('leaves a plain single-model request byte-identical', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['solo'], new ScriptedAdapter(SCRIPT))
    captureStderr()

    const chunks = await collect(ctx.llm.stream({ provider: 'solo', model: 'm', messages: [] }))

    expect(chunks).toStrictEqual(SCRIPT)
  })

  it('never rotates a fatal failure and yields that link failure unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError('bad tool schema', 'INVALID_REQUEST'))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'fatal' ? group('fatal', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'fatal',
      messages: [],
    }))

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'bad tool schema', code: 'INVALID_REQUEST', provider: 'chain-a', model: 'm-a' },
      },
    })
    expect(answering.calls).toHaveLength(0)
    expect(stderr.text()).not.toContain('[model-chain] fatal')
  })

  it('cuts a hung link at its pre-commit budget and escalates', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const hanging = new HangingAdapter()
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], hanging)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'slow' ? group('slow', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const draining = collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'slow',
      messages: [],
    }))
    await vi.advanceTimersByTimeAsync(15_000)
    const chunks = await draining

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(hanging.calls).toHaveLength(1)
    expect(stderr.text()).toContain('link 1 chain-a/m-a → RETRYABLE (TIMEOUT) → link 2 chain-b/m-b')
  })

  it('stops after the overall chain budget and names every attempted link', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const hanging = new HangingAdapter()
    const routes = ['chain-a', 'chain-b', 'chain-c', 'chain-d', 'chain-e']
    ctx.llm.registerAdapter(routes, hanging)
    provideChains(ctx, id => id === 'blackhole'
      ? group('blackhole', ...routes.map(route => [route, `${route}-model`] as [string, string]))
      : undefined)
    captureStderr()

    const draining = collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'chain-a-model',
      chain: 'blackhole',
      messages: [],
    }))
    for (let step = 0; step < 5; step += 1) await vi.advanceTimersByTimeAsync(15_000)
    const chunks = await draining

    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected error finish')
    expect(finish.reason.failure.code).toBe(MODEL_CHAIN_EXHAUSTED_CODE)
    expect(finish.reason.failure.message).toContain('link 4 chain-d/chain-d-model')
    expect(finish.reason.failure.message).not.toContain('chain-e')
    expect(hanging.calls.map(call => call.provider)).toEqual(['chain-a', 'chain-b', 'chain-c', 'chain-d'])
  })

  it('keeps the single-model path with one warning when no chains service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['solo'], answering)
    const stderr = captureStderr()

    const request = { provider: 'solo', model: 'm', chain: 'unmounted', messages: [] } as GenerateOptions
    const chunks = await collect(ctx.llm.stream(request))
    for (const _chunk of await collect(ctx.llm.stream(request))) { /* second call must not warn again */ }

    expect(chunks).toEqual(SCRIPT)
    expect(answering.calls[0]?.provider).toBe('solo')
    expect(stderr.text()).toContain(
      "[model-chain] unmounted: no model-chains service is mounted; using the request's own model",
    )
    expect(stderr.text().match(/\[model-chain\] unmounted/g)).toHaveLength(1)
  })

  it('keeps the single-model path for an unknown group and for a group with no usable links', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['solo'], answering)
    provideChains(ctx, id => id === 'empty' ? { id, links: [] } : undefined)
    const stderr = captureStderr()

    const unknown = await collect(ctx.llm.stream({ provider: 'solo', model: 'm', chain: 'ghost', messages: [] }))
    const empty = await collect(ctx.llm.stream({ provider: 'solo', model: 'm', chain: 'empty', messages: [] }))

    expect(unknown).toEqual(SCRIPT)
    expect(empty).toEqual(SCRIPT)
    expect(answering.calls).toHaveLength(2)
    expect(stderr.text()).toContain('[model-chain] ghost: the group id is not declared')
    expect(stderr.text()).toContain('[model-chain] empty: the group declares no usable links')
  })

  it('records the link that answered in the wire capture', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dsh-wire-chain-'))
    const previousLog = process.env.DSH_WIRE_LOG
    process.env.DSH_WIRE_LOG = join(target, 'wire-last.json')
    try {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['chain-a'], new FailingAdapter(new LlmError('link a is down', 'SERVER')))
      ctx.llm.registerAdapter(['chain-b'], new ScriptedAdapter(SCRIPT))
      provideChains(ctx, id => id === 'wired' ? group('wired', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
      captureStderr()

      await collect(ctx.llm.stream({ provider: 'chain-a', model: 'm-a', chain: 'wired', messages: [] }))

      let captured: { provider?: string; model?: string } | undefined
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          captured = JSON.parse(await readFile(join(target, 'wire-last.json'), 'utf8')) as { provider?: string }
          if (captured.provider === 'chain-b') break
        } catch {
          // The capture is fire-and-forget; retry until the write lands.
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(captured).toMatchObject({ provider: 'chain-b', model: 'm-b' })
    } finally {
      if (previousLog === undefined) delete process.env.DSH_WIRE_LOG
      else process.env.DSH_WIRE_LOG = previousLog
      await rm(target, { recursive: true, force: true })
    }
  })

  it('escalates a closed stream even when the dead link policy does not list STREAM_CLOSED', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new class extends FailingAdapter {
      override providerRetryPolicy(): ResolvedRetryPolicy {
        // The provider policy alone would not rotate this code; the chain's
        // own escalation set must.
        return resolveRetryPolicy({ mode: 'normal', retryableCodes: ['RATE_LIMIT'] }, 'closed policy')
      }
    }(new LlmError('SSE stream ended without [DONE]', STREAM_CLOSED_CODE))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'closed' ? group('closed', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'closed',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(failing.calls).toHaveLength(1)
    expect(answering.calls).toHaveLength(1)
    expect(stderr.text()).toContain('link 1 chain-a/m-a → RETRYABLE (STREAM_CLOSED) → link 2 chain-b/m-b')
  })

  it('names the failed link on the durable record and the chain outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const records: CapturedRecord[] = []
    provideSessions(ctx, records)
    ctx.llm.registerAdapter(['chain-a'], new FailingAdapter(new LlmError('a is down', 'RATE_LIMIT')))
    ctx.llm.registerAdapter(['chain-b'], new FailingAdapter(new LlmError('b died mid-answer', 'SERVER')))
    provideChains(ctx, id => id === 'dead' ? group('dead', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream(request({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'dead',
      messages: [],
    })))

    // The escalated attempt names the route that failed, not the route that
    // asked for it and not the chain.
    expect(records).toHaveLength(1)
    expect(attemptRecord(records[0]!)).toEqual({
      provider: 'chain-a',
      model: 'm-a',
      code: 'RATE_LIMIT',
      message: 'a is down',
      chain: 'dead',
      link: 1,
      next: { provider: 'chain-b', model: 'm-b' },
    })
    // The terminal outcome of an exhausted chain names its last failed link.
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected error finish')
    expect(finish.reason.failure).toMatchObject({
      code: MODEL_CHAIN_EXHAUSTED_CODE,
      provider: 'chain-b',
      model: 'm-b',
    })
  })

  it('stamps the failed link route on a single-link chain outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['chain-a'], new FailingAdapter(new LlmError('a is down', 'RATE_LIMIT')))
    provideChains(ctx, id => id === 'solo-link' ? group('solo-link', ['chain-a', 'm-a']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'solo-link',
      messages: [],
    }))

    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'a is down', code: 'RATE_LIMIT', provider: 'chain-a', model: 'm-a' },
      },
    })
  })

  it('writes one durable attempt record per escalated failure, not per chunk', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const records: CapturedRecord[] = []
    provideSessions(ctx, records)
    ctx.llm.registerAdapter(['chain-a'], new FailingAdapter(new LlmError('a is down', 'RATE_LIMIT')))
    ctx.llm.registerAdapter(['chain-b'], new FailingAdapter(new LlmError('b is down', 'TRANSPORT')))
    let recordsWhenAnswering = -1
    const answering = new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        // Both dead attempts are durable before the link that answers starts.
        recordsWhenAnswering = records.length
        yield* SCRIPT
      }
    }()
    ctx.llm.registerAdapter(['chain-c'], answering)
    provideChains(ctx, id => id === 'three'
      ? group('three', ['chain-a', 'm-a'], ['chain-b', 'm-b'], ['chain-c', 'm-c'])
      : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream(request({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'three',
      messages: [],
    })))

    expect(chunks).toEqual(answeredBy('chain-c', 'm-c'))
    expect(recordsWhenAnswering).toBe(2)
    expect(records.map(record => attemptRecord(record))).toEqual([
      {
        provider: 'chain-a',
        model: 'm-a',
        code: 'RATE_LIMIT',
        message: 'a is down',
        chain: 'three',
        link: 1,
        next: { provider: 'chain-b', model: 'm-b' },
      },
      {
        provider: 'chain-b',
        model: 'm-b',
        code: 'TRANSPORT',
        message: 'b is down',
        chain: 'three',
        link: 2,
        next: { provider: 'chain-c', model: 'm-c' },
      },
    ])
  })

  it('writes no attempt record for a committed generation that then failed', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const records: CapturedRecord[] = []
    provideSessions(ctx, records)
    const committed = new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'died mid-answer', code: 'SERVER' } },
        }
      }
    }()
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], committed)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'committed' ? group('committed', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream(request({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'committed',
      messages: [],
    })))

    // The generation committed before it failed: the chain never escalates,
    // so nothing durable names it as an attempt left behind.
    expect(records).toHaveLength(0)
    expect(answering.calls).toHaveLength(0)
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'died mid-answer', code: 'SERVER', provider: 'chain-a', model: 'm-a' },
      },
    })
  })

  it('names the route on a terminal single-model failure without a chain', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const records: CapturedRecord[] = []
    provideSessions(ctx, records)
    ctx.llm.registerAdapter(['solo'], new FailingAdapter(new LlmError('solo is down', 'SERVER')))
    captureStderr()

    const chunks = await collect(ctx.llm.stream(request({ provider: 'solo', model: 'm', messages: [] })))

    // No chain, no escalation, and no durable record — but the common
    // single-model failure still names the provider/model that failed.
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'solo is down', code: 'SERVER', provider: 'solo', model: 'm' },
      },
    })
    expect(records).toHaveLength(0)
  })

  it('tries the request route first when the group does not name it, then members in order', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const primary = new FailingAdapter(new LlmError('primary is down', 'RATE_LIMIT'))
    const firstMember = new FailingAdapter(new LlmError('first member is down', 'RATE_LIMIT'))
    const secondMember = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['primary'], primary)
    ctx.llm.registerAdapter(['chain-a'], firstMember)
    ctx.llm.registerAdapter(['chain-b'], secondMember)
    provideChains(ctx, id => id === 'free' ? group('free', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'primary',
      model: 'm-primary',
      chain: 'free',
      messages: [],
    }))

    // The request's own route is an implicit first member even though the
    // group does not list it; only then do the declared members run in order.
    expect(primary.calls.map(call => `${call.provider}/${call.model}`)).toEqual(['primary/m-primary'])
    expect(firstMember.calls.map(call => `${call.provider}/${call.model}`)).toEqual(['chain-a/m-a'])
    expect(secondMember.calls.map(call => `${call.provider}/${call.model}`)).toEqual(['chain-b/m-b'])
    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(stderr.text()).toContain(
      '[model-chain] free: link 1 primary/m-primary → RETRYABLE (RATE_LIMIT) → link 2 chain-a/m-a',
    )
    expect(stderr.text()).toContain(
      '[model-chain] free: link 2 chain-a/m-a → RETRYABLE (RATE_LIMIT) → link 3 chain-b/m-b',
    )
  })

  it('does not duplicate a request route already listed in the group', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError('named link is down', 'RATE_LIMIT'))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'named' ? group('named', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'named',
      messages: [],
    }))

    expect(failing.calls).toHaveLength(1)
    expect(answering.calls).toHaveLength(1)
    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
  })

  it.each([
    ['an empty text block', EMPTY_TEXT_SCRIPT],
    ['reasoning-only content', REASONING_ONLY_SCRIPT],
  ] as const)('escalates %s on a completed stop as EMPTY_RESPONSE', async (_label, emptyScript) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const empty = new ScriptedAdapter(emptyScript)
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], empty)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'empty-stop' ? group('empty-stop', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'empty-stop',
      messages: [],
    }))

    // Pre-commit chunks from the empty link may already have reached the
    // consumer; the answering link still supplies the complete terminal answer.
    const expected = answeredBy('chain-b', 'm-b')
    expect(chunks.slice(-expected.length)).toEqual(expected)
    expect(answering.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] empty-stop: link 1 chain-a/m-a → RETRYABLE (EMPTY_RESPONSE) → link 2 chain-b/m-b',
    )
  })

  it('classifies a sign-in wall as AUTH and skips the rest of that provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const signedOut = new FailingAdapter(new LlmError(
      '400: {"error":{"code":"PAID_MODEL_AUTH_REQUIRED","message":"You need to sign in to use this model."}}',
      'AUTH',
    ))
    const otherProvider = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], signedOut)
    ctx.llm.registerAdapter(['chain-b'], otherProvider)
    provideChains(ctx, id => id === 'signin' ? group(
      'signin',
      ['chain-a', 'm-a'],
      ['chain-a', 'm-a-2'],
      ['chain-b', 'm-b'],
    ) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'signin',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    // AUTH is provider-level: chain-a's second model was not tried.
    expect(signedOut.calls).toHaveLength(1)
    expect(otherProvider.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] signin: link 1 chain-a/m-a → RETRYABLE (AUTH) → link 3 chain-b/m-b',
    )
  })

  it('keeps a condemned provider skipped after another provider fails', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const signedOut = new FailingAdapter(new LlmError('sign in required', 'AUTH'))
    const rateLimited = new FailingAdapter(new LlmError('rate limited', 'RATE_LIMIT'))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], signedOut)
    ctx.llm.registerAdapter(['chain-b'], rateLimited)
    ctx.llm.registerAdapter(['chain-c'], answering)
    // chain-a returns after chain-b in the group; its AUTH gate still stands.
    provideChains(ctx, id => id === 'late-auth' ? group(
      'late-auth',
      ['chain-a', 'm-a'],
      ['chain-b', 'm-b'],
      ['chain-a', 'm-a-2'],
      ['chain-c', 'm-c'],
    ) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'late-auth',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-c', 'm-c'))
    expect(signedOut.calls).toHaveLength(1)
    expect(rateLimited.calls).toHaveLength(1)
    expect(answering.calls).toHaveLength(1)
  })

  it('skips the rest of a free-tier-gated provider and serves the next provider', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const gated = '403 {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}'
    const failing = new FailingAdapter(new LlmError(
      `${gated} — ${FREE_TIER_GATED_EXPLANATION}`,
      FREE_TIER_GATED_CODE,
    ))
    const sibling = new ScriptedAdapter(SCRIPT)
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    ctx.llm.registerAdapter(['chain-a-2'], sibling)
    provideChains(ctx, id => id === 'gated' ? group(
      'gated',
      ['chain-a', 'm-a'],
      ['chain-a', 'm-a-2'],
      ['chain-b', 'm-b'],
    ) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'gated',
      messages: [],
    }))

    // The gate belongs to the provider, so its sibling model is skipped and a
    // different provider is allowed to serve the request.
    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(sibling.calls).toHaveLength(0)
    expect(answering.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] gated: link 1 chain-a/m-a → RETRYABLE (FREE_TIER_GATED) → link 3 chain-b/m-b',
    )
  })

  it('escalates a context window overflow to the next (larger) member', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const tooSmall = new FailingAdapter(new LlmError('input exceeds the model context window', CONTEXT_WINDOW_EXCEEDED_CODE))
    const larger = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], tooSmall)
    ctx.llm.registerAdapter(['chain-b'], larger)
    provideChains(ctx, id => id === 'overflow' ? group('overflow', ['chain-a', 'm-small'], ['chain-b', 'm-large']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-small',
      chain: 'overflow',
      messages: [],
    }))

    expect(chunks).toEqual(answeredBy('chain-b', 'm-large'))
    expect(larger.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] overflow: link 1 chain-a/m-small → RETRYABLE (CONTEXT_WINDOW_EXCEEDED) → link 2 chain-b/m-large',
    )
  })

  it('surfaces the same failures as honest errors on a single-model request', async () => {
    const cases: Array<[LlmAdapter, string]> = [
      [new ScriptedAdapter(EMPTY_TEXT_SCRIPT), EMPTY_RESPONSE_CODE],
      [new FailingAdapter(new LlmError('sign in required', 'AUTH')), 'AUTH'],
      [new FailingAdapter(new LlmError('free tier gated', FREE_TIER_GATED_CODE)), FREE_TIER_GATED_CODE],
      [new FailingAdapter(new LlmError('context too small', CONTEXT_WINDOW_EXCEEDED_CODE)), CONTEXT_WINDOW_EXCEEDED_CODE],
    ]
    captureStderr()
    for (const [adapter, code] of cases) {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['solo'], adapter)
      const chunks = await collect(ctx.llm.stream({ provider: 'solo', model: 'm', messages: [] }))
      const finish = chunks.at(-1)
      if (finish?.type !== 'finish' || finish.reason.kind !== 'error') throw new Error('expected an error finish')
      expect(finish.reason.failure.code).toBe(code)
      expect(finish.reason.failure.provider).toBe('solo')
      expect(finish.reason.failure.model).toBe('m')
    }
  })

  it('skips a member whose known context window is smaller than the estimated request', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const tooSmall = new ContextScriptedAdapter(SCRIPT, { 'm-small': 1 })
    const large = new ContextScriptedAdapter(SCRIPT, { 'm-large': 100_000 })
    ctx.llm.registerAdapter(['chain-a'], tooSmall)
    ctx.llm.registerAdapter(['chain-b'], large)
    provideChains(ctx, id => id === 'prefilter' ? group('prefilter', ['chain-a', 'm-small'], ['chain-b', 'm-large']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-small',
      chain: 'prefilter',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000) }] }],
    }))

    expect(tooSmall.calls).toHaveLength(0)
    expect(large.calls).toHaveLength(1)
    expect(chunks).toEqual(answeredBy('chain-b', 'm-large'))
  })

  it('tries every member in order when the prefilter finds them all too small', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const first = new ContextScriptedAdapter(SCRIPT, { 'm-a': 1 })
    const second = new ContextScriptedAdapter(SCRIPT, { 'm-b': 1 })
    ctx.llm.registerAdapter(['chain-a'], first)
    ctx.llm.registerAdapter(['chain-b'], second)
    provideChains(ctx, id => id === 'all-small' ? group('all-small', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'all-small',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000) }] }],
    }))

    // The prefilter is advisory: with no member large enough, the first member
    // still runs in order rather than the request giving up.
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
    expect(chunks).toStrictEqual(SCRIPT)
  })

  it('escalates an identity entitlement gate to the next chain link', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const failing = new FailingAdapter(new LlmError(
      '403 An active OpenCode Go subscription is required to use Go models.',
      ENTITLEMENT_GATED_CODE,
    ))
    const answering = new ScriptedAdapter(SCRIPT)
    ctx.llm.registerAdapter(['chain-a'], failing)
    ctx.llm.registerAdapter(['chain-b'], answering)
    provideChains(ctx, id => id === 'entitled' ? group('entitled', ['chain-a', 'm-a'], ['chain-b', 'm-b']) : undefined)
    const stderr = captureStderr()

    const chunks = await collect(ctx.llm.stream({
      provider: 'chain-a',
      model: 'm-a',
      chain: 'entitled',
      messages: [],
    }))

    // Identity/account gate, not a dead route: the next link is tried.
    expect(chunks).toEqual(answeredBy('chain-b', 'm-b'))
    expect(answering.calls).toHaveLength(1)
    expect(stderr.text()).toContain(
      '[model-chain] entitled: link 1 chain-a/m-a → RETRYABLE (ENTITLEMENT_GATED) → link 2 chain-b/m-b',
    )
  })
})
