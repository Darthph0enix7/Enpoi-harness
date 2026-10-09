import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { PoolEngine } from '../src/pool.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

/** The Kilo preset shape: a hand-declared OpenAI-compatible route whose key is optional. */
const KILO = (baseURL: string) => ({
  providers: {
    kilo: {
      displayName: 'Kilo Gateway',
      api: 'openai-completions',
      baseURL,
      keyless: true,
      apiKeyEnv: 'KILO_API_KEY',
      models: [{ id: 'kilo-auto/free', contextWindow: 128000, maxTokens: 8192 }],
    },
  },
})

async function harness(baseURL: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, KILO(baseURL))
  return ctx
}

describe('keyless provider routes', () => {
  it('resolves keyless as a profile capability with its env ref kept', () => {
    const kilo = resolveProfiles(KILO('https://api.kilo.ai/api/gateway').providers as never).get('kilo')
    expect(kilo?.keyless).toBe(true)
    expect(kilo?.apiKeyEnv).toBe('KILO_API_KEY')
    expect(resolveProfiles({ deepseek: {} }).get('deepseek')?.keyless).toBe(false)
  })

  it('serves a mocked turn with no credential and no Authorization header', async () => {
    vi.stubEnv('KILO_API_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { provider: 'kilo', model: 'kilo-auto/free', messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(1)
    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  // Live probe (2026-09-27, https://api.kilo.ai/api/gateway/chat/completions):
  //   anonymous kilo-auto/free            -> 200
  //   anonymous + `authorization: Bearer bogus-probe-key`
  //                                       -> 401 {"error":{"code":"INVALID_TOKEN", ...}}
  // A stored/ambient/env key therefore BREAKS a keyless route, so none may be
  // sent unless the route is explicitly configured for BYOK (keyless dropped).
  it('never sends a stored or env-provided key on a keyless route', async () => {
    vi.stubEnv('KILO_API_KEY', 'bogus-probe-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { provider: 'kilo', model: 'kilo-auto/free', messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('sends a provided key only on an explicit BYOK route (keyless dropped)', async () => {
    vi.stubEnv('KILO_API_KEY', 'paid-key')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        kilo: {
          api: 'openai-completions',
          baseURL: server.url,
          apiKeyEnv: 'KILO_API_KEY',
          models: [{ id: 'kilo-auto/free' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'kilo', model: 'kilo-auto/free', messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer paid-key')
  })

  it("carries the provider's own code and message through an AUTH failure", async () => {
    const server = await mockServer([{
      status: 401,
      body: JSON.stringify({ error: { code: 'PAID_MODEL_AUTH_REQUIRED', message: 'You need to sign in to use this model.' } }),
    }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { provider: 'kilo', model: 'kilo-auto/free', messages: [] })

    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'AUTH', message: 'PAID_MODEL_AUTH_REQUIRED: You need to sign in to use this model.' },
    })
    expect(server.headers[0]?.authorization).toBeUndefined()
  })

  it('still fails a required env ref clearly when it is unset', async () => {
    vi.stubEnv('PI_REQUIRED_KEY', '')
    const server = await mockServer([{ events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: {
        kilo: {
          api: 'openai-completions',
          baseURL: server.url,
          apiKeyEnv: 'PI_REQUIRED_KEY',
          models: [{ id: 'kilo-auto/free' }],
        },
      },
    })

    const result = await assemble(ctx, { provider: 'kilo', model: 'kilo-auto/free', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(server.requests).toHaveLength(0)
  })

  it('ends a keyless pool route terminally on 401 without cooling or rotating identities', async () => {
    const server = await mockServer([
      { status: 401, body: JSON.stringify({ error: { message: 'Unauthorized' } }) },
      { events: textEvents },
    ])
    const engine = new PoolEngine({
      stateDir: await mkdtemp(join(tmpdir(), 'keyless-spec-')),
      saveDebounceMs: 5,
    })
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        kilo: {
          api: 'openai-completions',
          baseURL: server.url,
          keyless: true,
          models: [{ id: 'kilo-auto/free' }],
          pool: {
            identities: [
              { id: 'anon', credentialRef: 'ANON_KEY', priority: 1 },
              { id: 'second', credentialRef: 'SECOND_KEY', priority: 2 },
            ],
          },
        },
      } as never),
      resolveApiKey: () => Promise.resolve(undefined),
      pool: engine,
      // Both identities resolve: a keyless route must still attempt them
      // anonymously rather than send the resolved credentials.
      resolveCredential: async (ref: string) => ref === 'ANON_KEY' ? 'stored-anon-key' : 'stored-second-key',
      log: () => {},
      auth: memoryAuth(),
    })

    const drain = async (): Promise<void> => {
      for await (const _chunk of adapter.stream({ provider: 'kilo', model: 'kilo-auto/free', messages: [] })) {
        // The failure is terminal; no chunk is expected before it.
      }
    }
    await expect(drain()).rejects.toMatchObject({ code: 'AUTH' })
    // One attempt: the second identity is not another key to try.
    expect(server.requests).toHaveLength(1)
    expect(server.headers[0]?.authorization).toBeUndefined()
    expect(engine.cooldownRemaining('kilo', 'anon', 'kilo-auto/free')).toBe(0)
    expect(engine.cooldownRemaining('kilo', 'second', 'kilo-auto/free')).toBe(0)
  })

  it('refuses keyless over a protocol that cannot omit its auth header', () => {
    expect(() => resolveProfiles({
      anthropic: {
        api: 'anthropic-messages',
        baseURL: 'https://api.anthropic.com',
        keyless: true,
        models: [{ id: 'claude-x' }],
      },
    } as never)).toThrow(/keyless.*anthropic-messages/)
  })

  it.each(['openai-completions', 'openai-responses'] as const)(
    'accepts keyless over the anonymous-capable protocol %s',
    (api) => {
      const profiles = resolveProfiles({
        keylessRoute: {
          api,
          baseURL: 'https://gateway.example/v1',
          keyless: true,
          models: [{ id: 'free-model' }],
        },
      } as never)
      expect(profiles.get('keylessRoute')?.keyless).toBe(true)
    },
  )
})
