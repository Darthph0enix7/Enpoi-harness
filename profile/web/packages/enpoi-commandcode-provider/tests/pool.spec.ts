/**
 * Native commandcode pool behavior: per-attempt CLI headers and auth (the CLI
 * set overriding attribution), rotation on quota 429s, per-model cooldown
 * isolation, the 413 same-identity retry (including its transport-failure
 * path), and the commit barrier that forbids rotating after the first content
 * delta.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { PoolEngine } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CommandCodeAdapterOptions, CommandCodePoolConfig, CommandCodeRouteProfile } from '../src/adapter.js'
import { CommandCodeAdapter } from '../src/adapter.js'
import { CatalogStore } from '../src/catalog.js'
import { COMMAND_CODE_CLI_HEADERS } from '../src/headers.js'

/** Fixed clock so cooldown assertions compare exact parsed durations. */
const BASE_TIME = 1_700_000_000_000

let stateDir: string
let engine: PoolEngine

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'commandcode-pool-'))
  engine = new PoolEngine({ stateDir, now: () => BASE_TIME, saveDebounceMs: 1 })
})

afterEach(async () => {
  await engine.flush()
  await rm(stateDir, { recursive: true, force: true })
})

const SSE_OK = [
  'data: {"type":"text-start","id":"t1"}',
  'data: {"type":"text-delta","id":"t1","text":"hello"}',
  'data: {"type":"text-end","id":"t1"}',
  'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1}}',
  '',
].join('\n')

const TWO_IDENTITIES: CommandCodePoolConfig = {
  identities: [
    { id: 'a', credentialRef: 'KEY_A', priority: 1 },
    { id: 'b', credentialRef: 'KEY_B', priority: 2 },
  ],
}

function routeProfile(pool: CommandCodePoolConfig = TWO_IDENTITIES): CommandCodeRouteProfile {
  return {
    route: 'commandcode',
    displayName: 'Command Code (pooled)',
    baseURL: 'https://vendor.invalid',
    keyless: false,
    userImageMaxPixels: 2048 * 2048,
    userImageMaxBytes: 1024 * 1024,
    pool,
  }
}

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** A fetch that replays one scripted response per call and records the request. */
function scriptedFetch(steps: Array<(request: CapturedRequest) => Response>): {
  fetchImpl: typeof fetch
  calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(init?.headers ?? {})) headers[key.toLowerCase()] = String(value)
    const request: CapturedRequest = { url: String(input), headers, body: String(init?.body ?? '') }
    calls.push(request)
    const step = steps[calls.length - 1]
    if (step === undefined) throw new Error(`unexpected fetch call ${String(calls.length)}`)
    return step(request)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function makeAdapter(overrides: Partial<CommandCodeAdapterOptions> & { fetchImpl: typeof fetch }): CommandCodeAdapter {
  const catalog = new CatalogStore({
    baseURL: 'http://catalog.invalid',
    snapshot: [{ id: 'm', name: 'M' }],
    fetchImpl: async () => {
      throw new Error('catalog offline in tests')
    },
  })
  return new CommandCodeAdapter({
    profiles: () => new Map([['commandcode', routeProfile()]]),
    catalogFor: () => catalog,
    resolveApiKey: async () => undefined,
    pool: engine,
    resolveCredential: async reference => (
      reference === 'KEY_A' ? 'key-a' : reference === 'KEY_B' ? 'key-b' : undefined
    ),
    ...overrides,
  })
}

function optionsFor(model: string, messages?: GenerateOptions['messages']): GenerateOptions {
  return {
    provider: 'commandcode',
    model,
    messages: messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi' }] } as never],
  }
}

async function run(
  adapter: CommandCodeAdapter,
  options: GenerateOptions,
): Promise<{ chunks: StreamChunk[]; error: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks, error }
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code
}

it('injects the CLI headers and rotates to the next identity on a quota 429', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(429, JSON.stringify({ error: { message: 'Weekly usage limit reached. Resets in 3h 25m.' } })),
    () => sseResponse(SSE_OK),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  const { chunks, error } = await run(adapter, optionsFor('m'))
  expect(error).toBeUndefined()
  expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  expect(scripted.calls).toHaveLength(2)

  const first = scripted.calls[0]
  expect(first?.url).toBe('https://vendor.invalid/alpha/generate')
  expect(first?.headers['x-command-code-version']).toBe('1.54.0')
  expect(first?.headers['x-cli-environment']).toBe('production')
  expect(first?.headers['x-project-slug']).toBe('opencode')
  expect(first?.headers['user-agent']).toBe('cli')
  expect(first?.headers.authorization).toBe('Bearer key-a')
  expect(first?.headers['x-api-key']).toBe('key-a')

  const second = scripted.calls[1]
  expect(second?.headers.authorization).toBe('Bearer key-b')
  expect(second?.headers['x-api-key']).toBe('key-b')
  expect(second?.headers['x-command-code-version']).toBe('1.54.0')

  // The vendor's shorthand reset hint drives the pool cooldown.
  expect(engine.cooldownRemaining('commandcode', 'a', 'm')).toBe((3 * 3600 + 25 * 60) * 1000)
  expect(engine.cooldownRemaining('commandcode', 'b', 'm')).toBe(0)
})

it('overrides attribution with the four CLI headers, including user-agent: cli', async () => {
  const scripted = scriptedFetch([() => sseResponse(SSE_OK)])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  // Attribution would otherwise send the harness user-agent and trip the gate.
  expect(attributionHeaders()['user-agent']).not.toBe('cli')
  await run(adapter, optionsFor('m'))

  const headers = scripted.calls[0]?.headers ?? {}
  for (const [name, value] of Object.entries(COMMAND_CODE_CLI_HEADERS)) {
    expect(headers[name]).toBe(value)
  }
  expect(headers['user-agent']).toBe('cli')
})

it('keeps cooldowns isolated per model', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(429, JSON.stringify({ error: { message: 'quota' } })),
    () => sseResponse(SSE_OK),
    () => sseResponse(SSE_OK),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  await run(adapter, optionsFor('model-a'))
  expect(engine.cooldownRemaining('commandcode', 'a', 'model-a')).toBe(30_000)
  expect(engine.cooldownRemaining('commandcode', 'a', 'model-b')).toBe(0)

  // model-b starts at priority-1 again: the model-a 429 did not cool it.
  await run(adapter, optionsFor('model-b'))
  expect(scripted.calls).toHaveLength(3)
  expect(scripted.calls[2]?.headers.authorization).toBe('Bearer key-a')
})

it('rotates when an in-band error arrives before any content', async () => {
  const scripted = scriptedFetch([
    () => sseResponse('data: {"type":"error","message":"Weekly usage limit reached. Resets in 45m"}\n'),
    () => sseResponse(SSE_OK),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  const { chunks, error } = await run(adapter, optionsFor('m'))
  expect(error).toBeUndefined()
  expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  expect(scripted.calls).toHaveLength(2)
  expect(scripted.calls[0]?.headers.authorization).toBe('Bearer key-a')
  expect(scripted.calls[1]?.headers.authorization).toBe('Bearer key-b')
  expect(engine.cooldownRemaining('commandcode', 'a', 'm')).toBe(45 * 60_000)
})

it('never rotates after the first content delta commits', async () => {
  const scripted = scriptedFetch([
    // Content arrives, then the stream closes without a finish-step.
    () => sseResponse('data: {"type":"text-start","id":"t1"}\n'
      + 'data: {"type":"text-delta","id":"t1","text":"partial"}\n'
      + 'data: {"type":"text-end","id":"t1"}\n'),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  const { chunks, error } = await run(adapter, optionsFor('m'))
  expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
  expect(errorCode(error)).toBe('STREAM_CLOSED')
  // The failure is surfaced on the same attempt: no second identity is tried.
  expect(scripted.calls).toHaveLength(1)
})

it('retries a 413 once on the same identity with older images stripped', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(413, JSON.stringify({ error: { message: 'Payload too large' } })),
    () => sseResponse(SSE_OK),
  ])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    readImage: async ref => ({
      data: Uint8Array.of(Number(String(ref.name ?? '1').slice(-1)) + 1),
      mediaType: 'image/png',
    }),
  })
  const messages = [{
    role: 'user',
    content: [0, 1, 2].map(index => ({
      type: 'image',
      attachment: {
        attachmentId: `sha256:${String(index).padEnd(64, '0')}` as never,
        mediaType: 'image/png',
        bytes: 3,
        width: 8,
        height: 8,
        name: `img-${String(index)}`,
      },
    })),
  } as never]

  const { error } = await run(adapter, optionsFor('m', messages))
  expect(error).toBeUndefined()
  expect(scripted.calls).toHaveLength(2)
  // Both attempts stay on the priority-1 identity: no rotation.
  expect(scripted.calls[0]?.headers.authorization).toBe('Bearer key-a')
  expect(scripted.calls[1]?.headers.authorization).toBe('Bearer key-a')

  const imagesOf = (body: string): Array<Record<string, unknown>> => {
    const parsed = JSON.parse(body) as {
      params: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }
    }
    return parsed.params.messages
      .filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(part => part.type === 'image'))
  }
  expect(imagesOf(scripted.calls[0]?.body ?? '')).toHaveLength(3)
  const retried = imagesOf(scripted.calls[1]?.body ?? '')
  expect(retried).toHaveLength(1)
  // The newest image (index 2 -> payload byte 3 -> base64 "Aw==") is kept.
  expect(String(retried[0]?.image).endsWith('Aw==')).toBe(true)
})

it('surfaces the post-strip transport failure instead of the stale 413', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(413, JSON.stringify({ error: { message: 'Payload too large' } })),
    () => { throw new Error('socket hang up') },
  ])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    readImage: async () => ({ data: Uint8Array.of(1), mediaType: 'image/png' }),
    profiles: () => new Map([['commandcode', routeProfile({
      identities: [{ id: 'a', credentialRef: 'KEY_A' }],
    })]]),
  })
  // Two images so the 413 strip has an older one to remove and the same-key
  // retry actually fires.
  const messages = [{
    role: 'user',
    content: [0, 1].map(index => ({
      type: 'image',
      attachment: {
        attachmentId: `sha256:${String(index).padEnd(64, '0')}` as never,
        mediaType: 'image/png',
        bytes: 3,
        width: 8,
        height: 8,
        name: `img-${String(index)}`,
      },
    })),
  } as never]

  const { error } = await run(adapter, optionsFor('m', messages))
  // The retry's transport failure is the real outcome; the first 413 was
  // already superseded, so the pool reports the transport error.
  expect(errorCode(error)).toBe('PROVIDER_POOL_EXHAUSTED')
  expect((error as Error).message).toContain('socket hang up')
  expect((error as Error).message).not.toContain('Payload too large')
  expect(scripted.calls).toHaveLength(2)
})

it('fails request-level 400s without rotating or cooling a key', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(400, JSON.stringify({ error: { message: "The request is longer than the model's context length" } })),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('CONTEXT_WINDOW_EXCEEDED')
  expect(scripted.calls).toHaveLength(1)
  expect(engine.cooldownRemaining('commandcode', 'a', 'm')).toBe(0)
})

it('fails loud when no identity credential resolves', async () => {
  const scripted = scriptedFetch([])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    resolveCredential: async () => undefined,
  })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('MISSING_CREDENTIAL')
  // The failure names the Keys-card action; there is no anonymous fallback.
  expect((error as Error).message).toContain('Keys card')
  expect(scripted.calls).toHaveLength(0)
})

it('refuses a keyless route aimed at the non-loopback vendor with the Keys-card action', async () => {
  const scripted = scriptedFetch([])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    // A hand-written route that kept the legacy keyless flag but points at the
    // public vendor: it could only send the anonymous request the gate rejects.
    profiles: () => new Map([['commandcode', {
      ...routeProfile(),
      baseURL: 'https://api.commandcode.ai',
      pool: undefined,
      keyless: true,
    }]]),
  })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('MISSING_CREDENTIAL')
  expect((error as Error).message).toContain('keyless')
  expect((error as Error).message).toContain('Keys card')
  expect(scripted.calls).toHaveLength(0)
})

it('fails a single-key route with the credential reference and the Keys-card action', async () => {
  const scripted = scriptedFetch([])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    profiles: () => new Map([['commandcode', {
      ...routeProfile(),
      pool: undefined,
      keyless: false,
      apiKeyEnv: 'COMMANDCODE_KEY_1',
    }]]),
    resolveApiKey: async () => undefined,
  })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('MISSING_CREDENTIAL')
  expect((error as Error).message).toContain('COMMANDCODE_KEY_1')
  expect((error as Error).message).toContain('Keys card')
  expect(scripted.calls).toHaveLength(0)
})

it('keeps keyless loopback routes working (the legacy keypool posture)', async () => {
  const scripted = scriptedFetch([() => sseResponse(SSE_OK)])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    profiles: () => new Map([['commandcode', {
      ...routeProfile(),
      baseURL: 'http://127.0.0.1:8899/commandcode',
      pool: undefined,
      keyless: true,
    }]]),
  })

  const { error } = await run(adapter, optionsFor('m'))
  expect(error).toBeUndefined()
  expect(scripted.calls).toHaveLength(1)
  // A legacy keypool route sends no CLI headers of its own: the proxy owns
  // them downstream.
  expect(scripted.calls[0]?.headers['x-command-code-version']).toBeUndefined()
  expect(scripted.calls[0]?.headers.authorization).toBeUndefined()
})

it('requires resolved credentials even when the route still carries keyless', async () => {
  const scripted = scriptedFetch([])
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    profiles: () => new Map([['commandcode', { ...routeProfile(), keyless: true }]]),
    resolveCredential: async () => undefined,
  })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('MISSING_CREDENTIAL')
  expect(scripted.calls).toHaveLength(0)
})

it('fails without failover on a route-wide proxy gate', async () => {
  const scripted = scriptedFetch([
    () => jsonResponse(403, '{"error":{"message":"Proxy use detected"}}'),
  ])
  const adapter = makeAdapter({ fetchImpl: scripted.fetchImpl })

  const { error } = await run(adapter, optionsFor('m'))
  expect(errorCode(error)).toBe('PROXY_USE_DETECTED')
  // POLICY is route-wide: no second identity is burned and no key cools.
  expect(scripted.calls).toHaveLength(1)
  expect(engine.cooldownRemaining('commandcode', 'a', 'm')).toBe(0)
})

it('a single-key direct route sends the CLI headers and dual auth (no pool)', async () => {
  const scripted = scriptedFetch([() => sseResponse(SSE_OK)])
  const big = `data:image/png;base64,${'A'.repeat(600)}`
  const adapter = makeAdapter({
    fetchImpl: scripted.fetchImpl,
    pool: undefined,
    resolveApiKey: async () => 'key-single',
    profiles: () => new Map([['commandcode', {
      ...routeProfile(),
      baseURL: 'https://api.commandcode.ai',
      pool: undefined,
      keyless: false,
      apiKeyEnv: 'COMMANDCODE_KEY_1',
    }]]),
  })

  const { error } = await run(adapter, optionsFor('m', [
    { role: 'user', content: [{ type: 'text', text: `look ${big}` }] } as never,
  ]))
  expect(error).toBeUndefined()
  const headers = scripted.calls[0]?.headers ?? {}
  expect(headers['x-command-code-version']).toBe('1.54.0')
  expect(headers['x-cli-environment']).toBe('production')
  expect(headers['x-project-slug']).toBe('opencode')
  expect(headers['user-agent']).toBe('cli')
  expect(headers.authorization).toBe('Bearer key-single')
  expect(headers['x-api-key']).toBe('key-single')
  // A direct request is sanitized at the conversion seam even without a pool.
  expect(scripted.calls[0]?.body.includes(big)).toBe(false)
})
