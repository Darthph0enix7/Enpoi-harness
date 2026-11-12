/**
 * Provider-neutral stream liveness through the real pi-ai SDK.
 *
 * A gateway can keep an HTTP response alive with SSE comment frames and
 * provider updates that pi-ai accepts but renders as no assistant event. The
 * adapter's idle watchdog therefore has to observe transport bytes, not only
 * the semantic chunks `toStreamChunks` yields; these tests drive the shipped
 * adapter and the installed pi-ai SDK against a local HTTP endpoint.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmError, onAttemptActivity } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { PoolEngine } from '../src/pool.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

/** Long enough for a local loopback request, short enough to fail fast. */
const IDLE_MS = 200
/** Event cadence; five of these outlast the idle window. */
const PACE_MS = 50

/** An OpenAI-compatible delta pi-ai parses but renders as no assistant event. */
const EMPTY_REASONING = '{"choices":[{"delta":{"reasoning_content":""},"index":0,"finish_reason":null}]}'

/** One non-empty text delta in pi-ai's chat-completions shape. */
function textDelta(text: string): string {
  return `{"choices":[{"delta":{"content":${JSON.stringify(text)}},"index":0,"finish_reason":null}]}`
}

/** The terminal assistant event with usage. */
const STOP = '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}'
const DONE = '[DONE]'

/** Scripted stream: six no-event frames at {@link PACE_MS}, then the answer. */
const KEEPALIVE_SCRIPT = [
  EMPTY_REASONING,
  EMPTY_REASONING,
  EMPTY_REASONING,
  EMPTY_REASONING,
  EMPTY_REASONING,
  textDelta('hello'),
  STOP,
  DONE,
]

afterEach(async () => {
  await closeMockServers()
})

function adapterOf(providers: Record<string, PiAiProviderProfile>): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
    log: () => {},
  })
}

function route(baseURL: string, extra: Record<string, unknown> = {}): PiAiProviderProfile {
  return {
    api: 'openai-completions',
    baseURL,
    models: [{ id: 'deepseek-v4-flash', contextWindow: 65_536, maxTokens: 4096 }],
    ...extra,
  }
}

async function collect(adapter: PiAiAdapter, signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const stream = adapter.stream({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    messages: [],
    ...signal === undefined ? {} : { signal },
  })
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function finishReasonOf(chunks: readonly StreamChunk[]): unknown {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  if (finish === undefined) throw new Error('stream produced no finish chunk')
  return finish.reason
}

describe('pi-ai stream liveness', () => {
  it('keeps the real SDK request on its active chain link past the 15-second silence budget', async () => {
    const server = await mockServer([{
      events: [textDelta('still here'), STOP, DONE],
      firstEventDelayMs: 16_000,
      keepAliveMs: 100,
    }])
    const adapter = adapterOf({
      deepseek: route(server.url, { streamIdleTimeoutMs: 1_000 }),
      backup: route(server.url, { streamIdleTimeoutMs: 1_000 }),
    })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek', 'backup'], adapter)
    ctx.provide('modelChains', {
      resolve: (id: string) => id === 'local-activity'
        ? { id, links: [
          { provider: 'deepseek', model: 'deepseek-v4-flash' },
          { provider: 'backup', model: 'deepseek-v4-flash' },
        ] }
        : undefined,
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek', model: 'deepseek-v4-flash', messages: [], chain: 'local-activity',
    })) chunks.push(chunk)
    expect(finishReasonOf(chunks)).toEqual({ kind: 'stop' })
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['still here'])
    expect(server.requests).toHaveLength(1)
  }, 25_000)

  it('keeps a single-route stream alive across empty updates and SSE keepalives', async () => {
    const server = await mockServer([{
      events: KEEPALIVE_SCRIPT,
      delayMs: PACE_MS,
      keepAliveMs: PACE_MS / 2,
    }])
    const adapter = adapterOf({ deepseek: route(server.url, { streamIdleTimeoutMs: IDLE_MS }) })
    const controller = new AbortController()
    let pulses = 0
    const dispose = onAttemptActivity(controller.signal, () => { pulses += 1 })
    const chunks = await collect(adapter, controller.signal).finally(dispose)

    expect(finishReasonOf(chunks)).toEqual({ kind: 'stop' })
    // Empty provider updates and comment frames never become user-visible
    // content: only the real text delta survives.
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toEqual([])
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['hello'])
    expect(server.requests).toHaveLength(1)
    expect(pulses).toBeGreaterThan(0)
  })

  it('keeps a route alive on raw transport bytes before any SSE frame completes', async () => {
    const server = await mockServer([{
      fragments: [':', ' ', 'p', 'i', 'n', 'g', '\n', '\n'],
      events: [textDelta('hello'), STOP, DONE],
      delayMs: PACE_MS,
    }])
    const adapter = adapterOf({ deepseek: route(server.url, { streamIdleTimeoutMs: IDLE_MS }) })

    const chunks = await collect(adapter)

    // Eight fragments at PACE_MS span twice the idle window while the SDK can
    // dispatch no event: only the response body's bytes prove liveness.
    expect(finishReasonOf(chunks)).toEqual({ kind: 'stop' })
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['hello'])
  })

  it('still times out a stream that sends no bytes after the response head', async () => {
    const server = await mockServer([{
      events: [textDelta('late'), STOP, DONE],
      firstEventDelayMs: IDLE_MS * 3,
    }])
    const adapter = adapterOf({ deepseek: route(server.url, { streamIdleTimeoutMs: IDLE_MS }) })

    const error = await collect(adapter).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('TIMEOUT')
    expect(server.paths).toEqual(['/chat/completions'])
    await expect(server.responseClosed).resolves.toBeUndefined()
    expect(server.closedResponses).toBe(1)
  })

  it('times out a request stalled before the response head', async () => {
    const server = await mockServer([{
      events: [textDelta('late'), STOP, DONE],
      headersDelayMs: IDLE_MS * 3,
    }])
    const adapter = adapterOf({ deepseek: route(server.url, { streamIdleTimeoutMs: IDLE_MS }) })

    const error = await collect(adapter).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('TIMEOUT')
    // The SDK got as far as the wire; the timeout closed its request.
    expect(server.paths).toEqual(['/chat/completions'])
    await expect(server.responseClosed).resolves.toBeUndefined()
  })

  it('keeps a pooled-route stream alive across transport activity', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'pi-liveness-'))
    const engine = new PoolEngine({ stateDir, saveDebounceMs: 5 })
    try {
      const server = await mockServer([{
        events: KEEPALIVE_SCRIPT,
        delayMs: PACE_MS,
        keepAliveMs: PACE_MS / 2,
      }])
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles({
          deepseek: route(server.url, {
            streamIdleTimeoutMs: IDLE_MS,
            pool: {
              identities: [
                { id: 'first', credentialRef: 'KEY_ONE' },
                { id: 'second', credentialRef: 'KEY_TWO' },
              ],
            },
          }),
        }),
        resolveApiKey: () => Promise.resolve('unused'),
        resolveCredential: reference => Promise.resolve(reference === 'KEY_ONE' ? 'key-one' : 'key-two'),
        pool: engine,
        auth: memoryAuth(),
        log: () => {},
      })

      const controller = new AbortController()
      let pulses = 0
      const dispose = onAttemptActivity(controller.signal, () => { pulses += 1 })
      const chunks = await collect(adapter, controller.signal).finally(dispose)

      expect(finishReasonOf(chunks)).toEqual({ kind: 'stop' })
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)).toEqual(['hello'])
      // The activity is liveness only: the first identity commits and no
      // sibling key is spent.
      expect(server.requests).toHaveLength(1)
      expect(server.headers[0]?.authorization).toBe('Bearer key-one')
      expect(engine.cooldownRemaining('deepseek', 'first', 'deepseek-v4-flash')).toBe(0)
      expect(pulses).toBeGreaterThan(0)
    } finally {
      await engine.flush().catch(() => {})
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  it('aborts a caller-cancelled stream and closes the provider request', async () => {
    const server = await mockServer([{
      events: Array.from({ length: 20 }, () => EMPTY_REASONING),
      delayMs: 20,
      keepAliveMs: 15,
    }])
    const adapter = adapterOf({ deepseek: route(server.url, { streamIdleTimeoutMs: IDLE_MS }) })
    const controller = new AbortController()
    const reading = collect(adapter, controller.signal)
    setTimeout(() => { controller.abort('test cancellation') }, PACE_MS)

    const chunks = await reading

    expect(finishReasonOf(chunks)).toEqual(expect.objectContaining({ kind: 'aborted' }))
    await expect(server.responseClosed).resolves.toBeUndefined()
    expect(server.closedResponses).toBe(1)
  })
})
