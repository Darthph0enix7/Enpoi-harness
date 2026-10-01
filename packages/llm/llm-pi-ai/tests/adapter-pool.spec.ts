import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LLM_ATTEMPT_FAILED_EVENT, LlmError } from '@deepseek-ai/dsh-llm'
import type { AttemptRecordSink } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { PoolEngine } from '../src/pool.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
})

let stateDir: string
async function engineOf(): Promise<PoolEngine> {
  stateDir = await mkdtemp(join(tmpdir(), 'adapter-pool-spec-'))
  return new PoolEngine({ stateDir, saveDebounceMs: 5 })
}

const POOLED_PROVIDERS = (baseURL: string) => ({
  deepseek: {
    baseURL,
    pool: {
      identities: [
        { id: 'exhausted', credentialRef: 'POOL_KEY_A', priority: 1 },
        { id: 'healthy', credentialRef: 'POOL_KEY_B', priority: 2 },
      ],
    },
  },
})

function pooledAdapter(
  providers: Record<string, unknown>,
  engine: PoolEngine,
  credentials: Record<string, string | undefined>,
  attemptRecords?: () => AttemptRecordSink | undefined,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers as Parameters<typeof resolveProfiles>[0]),
    resolveApiKey: () => Promise.resolve('unused'),
    pool: engine,
    resolveCredential: async reference => credentials[reference],
    log: () => {},
    ...attemptRecords === undefined ? {} : { attemptRecords },
    auth: memoryAuth(),
  })
}

async function collect(adapter: PiAiAdapter, baseURL: string, sessionId?: string): Promise<{ chunks: unknown[] }> {
  const chunks: unknown[] = []
  const stream = adapter.stream({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    messages: [],
    ...sessionId === undefined ? {} : { sessionId: sessionId as never },
  })
  for await (const chunk of stream) chunks.push(chunk)
  void baseURL
  return { chunks }
}

describe('PiAiAdapter credential pools', () => {
  it('rotates to the next identity on a pre-commit quota failure and serves the answer', async () => {
    const server = await mockServer([
      { status: 429, body: JSON.stringify({ error: { message: 'Rate limit exceeded. Resets in 46min.' } }) },
      { events: textEvents },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    const { chunks } = await collect(adapter, server.url)

    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text-delta', text: 'hello' }),
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    // Both identities were tried, in order, with their own keys.
    expect(server.requests).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
    // The failed identity is cooling; the served one is clean.
    expect(engine.cooldownRemaining('deepseek', 'exhausted', 'deepseek-v4-flash')).toBeGreaterThan(0)
    expect(engine.cooldownRemaining('deepseek', 'healthy', 'deepseek-v4-flash')).toBe(0)
  })

  it('leaves one durable attempt record per rotation, naming the next identity', async () => {
    const server = await mockServer([
      { status: 429, body: JSON.stringify({ error: { message: 'Rate limit exceeded. Resets in 46min.' } }) },
      { events: textEvents },
    ])
    const engine = await engineOf()
    const records: { type: string; data: unknown; opts: unknown }[] = []
    const lookedUp: string[] = []
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    }, () => ({
      get: (id: string) => {
        lookedUp.push(id)
        return {
          append: (type: string, data: unknown, opts: unknown) => {
            records.push({ type, data, opts })
          },
        }
      },
    }))

    await collect(adapter, server.url, 'pool-session')

    // One record for the one rotation, durable as `llm/attempt-failed`.
    expect(records).toEqual([{
      type: LLM_ATTEMPT_FAILED_EVENT,
      data: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        identity: 'exhausted',
        code: 'RATE_LIMIT',
        message: '429: {"message":"Rate limit exceeded. Resets in 46min."}',
        next: { identity: 'healthy' },
      },
      opts: { ignorable: true },
    }])
    // Identity ids are durable routing facts; credential values never are.
    expect(lookedUp).toEqual(['pool-session'])
    expect(JSON.stringify(records)).not.toContain('key-a')
  })

  it('surfaces transient gateway model outages without burning the pool', async () => {
    const server = await mockServer([
      { status: 400, body: JSON.stringify({ error: { message: 'The supported API model names are: a, b.'
        + ' But you passed  deepseek-v4-flash.' } }) },
      { events: textEvents },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    await expect(collect(adapter, server.url)).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_OUTAGE',
    })
    // Exactly one attempt: rotation would cool every valid key for a gateway hiccup.
    expect(server.requests).toHaveLength(1)
    expect(engine.cooldownRemaining('deepseek', 'exhausted', 'deepseek-v4-flash')).toBe(0)
  })

  it('skips identities whose credential is missing and still serves the request', async () => {
    const server = await mockServer([{ events: textEvents }])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_B: 'key-b',
    })

    const { chunks } = await collect(adapter, server.url)
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(server.requests).toHaveLength(1)
    expect(server.headers[0]?.authorization).toBe('Bearer key-b')
  })

  it('fails with MISSING_CREDENTIAL when no enabled identity resolves', async () => {
    const server = await mockServer([])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {})

    await expect(collect(adapter, server.url)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
    })
    // Plain credential language naming the references to fill, never pool
    // vocabulary the configuration surface cannot act on.
    await expect(collect(adapter, server.url)).rejects.toThrow(
      /provider "deepseek" needs a credential, but none of its key-pool references \(POOL_KEY_A, POOL_KEY_B\) resolve/,
    )
    expect(server.requests).toHaveLength(0)
  })

  it('names the disabled pool when no identity is enabled', async () => {
    const server = await mockServer([])
    const engine = await engineOf()
    const adapter = pooledAdapter({
      deepseek: {
        baseURL: server.url,
        pool: { identities: [{ id: 'off', credentialRef: 'POOL_KEY_A', enabled: false }] },
      },
    }, engine, { POOL_KEY_A: 'key-a' })

    await expect(collect(adapter, server.url)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    await expect(collect(adapter, server.url)).rejects.toThrow(/has no enabled key-pool identity/)
    expect(server.requests).toHaveLength(0)
  })

  it('keeps serving after a cooldown expires (sticky recovery)', async () => {
    let now = 1_000_000
    const engine = new PoolEngine({ stateDir, now: () => now, saveDebounceMs: 5 })
    const server = await mockServer([
      { status: 429, body: JSON.stringify({ error: { message: 'quota. Resets in 1min.' } }) },
      { events: textEvents },
      { events: textEvents },
      { events: textEvents },
    ])
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    await collect(adapter, server.url)
    expect(server.requests).toHaveLength(2)

    // Priority-1 identity is cooling → next request goes straight to key-b.
    await collect(adapter, server.url)
    expect(server.headers[2]?.authorization).toBe('Bearer key-b')

    // After the reset window the sticky order resumes at key-a.
    now += 2 * 60_000
    await collect(adapter, server.url)
    expect(server.headers[3]?.authorization).toBe('Bearer key-a')
  })

  it('rejects an invalid pool configuration up front', () => {
    expect(() => resolveProfiles({
      deepseek: {
        baseURL: 'http://x',
        pool: { identities: [{ id: 'a', credentialRef: 'K' }, { id: 'a', credentialRef: 'K2' }] },
      },
    })).toThrow(/duplicate pool identity/)
    // An identities-less pool IS no pool (schemastery materializes absent
    // object keys' arrays as empty lists): it must resolve dormant, not throw.
    const dormant = resolveProfiles({
      deepseek: { baseURL: 'http://x', pool: { identities: [] } },
    })
    expect(dormant.get('deepseek')?.pool).toBeUndefined()
  })

  it('throws LlmError instances that carry stable codes', async () => {
    const server = await mockServer([
      { status: 400, body: JSON.stringify({ error: { message: '400: {"code":"invalid_request_error","message":"bad schema"}' } }) },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })
    const error = await collect(adapter, server.url).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('INVALID_REQUEST')
  })

  it('rotates past an entitlement-gated identity to an entitled one, cooling the gated identity long', async () => {
    const server = await mockServer([
      { status: 403, body: JSON.stringify({ error: { message: 'An active OpenCode Go subscription is required to use Go models.' } }) },
      { events: textEvents },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    const { chunks } = await collect(adapter, server.url)

    // The sibling identity served the request: the gate is identity-specific.
    expect(chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text-delta', text: 'hello' }),
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(server.requests).toHaveLength(2)
    expect(server.headers[0]?.authorization).toBe('Bearer key-a')
    expect(server.headers[1]?.authorization).toBe('Bearer key-b')
    // Gated identity rotated away and cooled for the long entitlement window.
    expect(engine.cooldownRemaining('deepseek', 'exhausted', 'deepseek-v4-flash')).toBeGreaterThan(5.9 * 3600_000)
    // Entitled identity is clean.
    expect(engine.cooldownRemaining('deepseek', 'healthy', 'deepseek-v4-flash')).toBe(0)
  })

  it('exhausts with an honest entitlement message when every identity is gated', async () => {
    const server = await mockServer([
      { status: 403, body: JSON.stringify({ error: { message: 'An active OpenCode Go subscription is required to use Go models.' } }) },
      { status: 403, body: JSON.stringify({ error: { message: 'An active OpenCode Go subscription is required to use Go models.' } }) },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    const error = await collect(adapter, server.url).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('PROVIDER_POOL_EXHAUSTED')
    // The message names the entitlement cause, not a generic pool failure.
    expect((error as LlmError).message).toContain('plan does not include this model')
    expect(server.requests).toHaveLength(2)
    expect(engine.cooldownRemaining('deepseek', 'exhausted', 'deepseek-v4-flash')).toBeGreaterThan(5.9 * 3600_000)
    expect(engine.cooldownRemaining('deepseek', 'healthy', 'deepseek-v4-flash')).toBeGreaterThan(5.9 * 3600_000)
  })

  it('still terminates on the route-wide free-tier gate (POLICY never rotates)', async () => {
    const server = await mockServer([
      { status: 403, body: JSON.stringify({ error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } }) },
    ])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })
    const error = await collect(adapter, server.url).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).failure.code).toBe('FREE_TIER_GATED')
    expect(server.requests).toHaveLength(1)
    expect(engine.cooldownRemaining('deepseek', 'exhausted', 'deepseek-v4-flash')).toBe(0)
  })

  it('records quota headers from a pooled response against the serving identity', async () => {
    const server = await mockServer([{
      events: textEvents,
      headers: {
        'x-ratelimit-remaining-requests': '8',
        'x-ratelimit-limit-requests': '10',
        'x-ratelimit-reset-requests': '30s',
      },
    }])
    const engine = await engineOf()
    const adapter = pooledAdapter(POOLED_PROVIDERS(server.url), engine, {
      POOL_KEY_A: 'key-a',
      POOL_KEY_B: 'key-b',
    })

    await collect(adapter, server.url)

    expect(engine.snapshot('deepseek')['exhausted']?.['deepseek-v4-flash']?.quota).toEqual({
      remainingFraction: 0.8,
      resetTime: '30s',
      source: 'headers',
    })
  })

  it('skips a CAPACITY backoff tier that would consume the pool deadline', async () => {
    const t0 = 1_000_000
    const sleeps: number[] = []
    const clampStateDir = await mkdtemp(join(tmpdir(), 'adapter-pool-clamp-'))
    const engine = new PoolEngine({
      stateDir: clampStateDir,
      now: () => t0,
      saveDebounceMs: 5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })
    // Both identities start cooling, so the pass probes both (priority-first)
    // and the first CAPACITY failure sees no healthy peer. Five prior CAPACITY
    // failures on the priority-1 identity select the 60 s tier.
    for (let attempt = 0; attempt < 5; attempt++) {
      engine.recordFailure('deepseek', 'exhausted', 'deepseek-v4-flash', 'CAPACITY', '503 server busy')
    }
    engine.recordFailure('deepseek', 'healthy', 'deepseek-v4-flash', 'CAPACITY', '503 server busy')
    const server = await mockServer([
      { status: 503, body: JSON.stringify({ error: { message: 'model is overloaded: server is busy (503)' } }) },
      { status: 503, body: JSON.stringify({ error: { message: 'model is overloaded: server is busy (503)' } }) },
    ])
    let clockCalls = 0
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles(POOLED_PROVIDERS(server.url) as Parameters<typeof resolveProfiles>[0]),
      resolveApiKey: () => Promise.resolve('unused'),
      pool: engine,
      resolveCredential: async reference => ({ POOL_KEY_A: 'key-a', POOL_KEY_B: 'key-b' })[reference],
      log: () => {},
      auth: memoryAuth(),
      poolDeadlineMs: 30_000,
      // The deadline is fixed at the first call; every later read is 25 s in,
      // leaving 5 s of the 30 s budget at the CAPACITY backoff.
      now: () => {
        clockCalls += 1
        return clockCalls === 1 ? t0 : t0 + 25_000
      },
    })

    await collect(adapter, server.url).catch(() => undefined)

    // The 60 s tier did not fit the 5 s left: no sleep, and the second identity
    // was still attempted before the deadline instead of being skipped.
    expect(sleeps).toEqual([])
    expect(server.requests).toHaveLength(2)
  })

  it('keeps a CAPACITY backoff tier that fits inside the pool deadline', async () => {
    const t0 = 1_000_000
    const sleeps: number[] = []
    const fitStateDir = await mkdtemp(join(tmpdir(), 'adapter-pool-fit-'))
    const engine = new PoolEngine({
      stateDir: fitStateDir,
      now: () => t0,
      saveDebounceMs: 5,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })
    // Two prior CAPACITY failures: the next one selects the 20 s tier.
    for (let attempt = 0; attempt < 2; attempt++) {
      engine.recordFailure('deepseek', 'exhausted', 'deepseek-v4-flash', 'CAPACITY', '503 server busy')
    }
    engine.recordFailure('deepseek', 'healthy', 'deepseek-v4-flash', 'CAPACITY', '503 server busy')
    const server = await mockServer([
      { status: 503, body: JSON.stringify({ error: { message: 'model is overloaded: server is busy (503)' } }) },
      { status: 503, body: JSON.stringify({ error: { message: 'model is overloaded: server is busy (503)' } }) },
    ])
    let clockCalls = 0
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles(POOLED_PROVIDERS(server.url) as Parameters<typeof resolveProfiles>[0]),
      resolveApiKey: () => Promise.resolve('unused'),
      pool: engine,
      resolveCredential: async reference => ({ POOL_KEY_A: 'key-a', POOL_KEY_B: 'key-b' })[reference],
      log: () => {},
      auth: memoryAuth(),
      poolDeadlineMs: 30_000,
      now: () => {
        clockCalls += 1
        return clockCalls === 1 ? t0 : t0 + 1_000
      },
    })

    await collect(adapter, server.url).catch(() => undefined)

    // 20 s fits in the 29 s left: the full tier is awaited.
    expect(sleeps).toEqual([20_000])
  })
})
