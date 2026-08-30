import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
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
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles(providers as Parameters<typeof resolveProfiles>[0]),
    resolveApiKey: () => Promise.resolve('unused'),
    pool: engine,
    resolveCredential: async reference => credentials[reference],
    log: () => {},
    auth: memoryAuth(),
  })
}

async function collect(adapter: PiAiAdapter, baseURL: string): Promise<{ chunks: unknown[] }> {
  const chunks: unknown[] = []
  const stream = adapter.stream({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    messages: [],
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
})
