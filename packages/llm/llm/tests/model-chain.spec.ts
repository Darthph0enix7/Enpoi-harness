import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  MODEL_CHAIN_EXHAUSTED_CODE,
  type GenerateOptions,
  type ResolvedModelChain,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'answered by the fallback link' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'answered by the fallback link' } },
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
      reason: { kind: 'error', failure: { message: 'bad tool schema', code: 'INVALID_REQUEST' } },
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
})
