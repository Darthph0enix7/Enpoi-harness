import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const configurations = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()
const initialConfigs = new WeakMap<Context, LlmPiAi.Options>()

/** Minimal foreign adapter: only needs to own a route the pi-ai plugin then wants. */
class StubAdapter extends LlmAdapter {

  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(
  dir: string,
  config: LlmPiAi.Options,
  options: { authorization?: boolean } = {},
): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  if (options.authorization === true) await ctx.plugin(AuthorizationService)
  initialConfigs.set(ctx, config)
  configurations.set(ctx, await liveConfig(ctx, LlmPiAi, config))
  return ctx
}

describe('login flows in a real composition', () => {
  it('offers a sign-in for a provider no route names, once the seam is mounted', async () => {
    const ctx = await boot(await home(), {}, { authorization: true })

    // Zero routes configured: signing in is what makes a route worth adding,
    // so the offer cannot wait for a profile to name the provider.
    const codex = ctx.authorization.describe(LlmPiAi.recordKeyFor('openai-codex'))
    expect(codex?.methods.map(method => method.id)).toEqual(['oauth'])
  })

  it('mounts without the seam, and simply offers no sign-in', async () => {
    const ctx = await boot(await home(), {})

    // A headless or ACP composition has no surface to sign in from; everything
    // else this plugin does still works.
    expect(ctx.get('authorization')).toBeUndefined()
    expect(ctx.llm.listConfigurableProviders().length).toBeGreaterThan(0)
  })
})

describe('request-level dynamic profiles', () => {
  it('keeps stored catalog failures editable while isolating requests and validating changed providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const known = getBuiltinModels('openrouter').find(model => model.api === 'openai-completions')!
    const stored = { providers: { openrouter: {
      apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url,
      models: [{ id: known.id }, { id: '111' }],
    } } }
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_DYNAMIC_KEY: fake-key\n', { mode: 0o600 })
    const ctx = await boot(dir, stored)
    const failure = 'llm-pi-ai: provider "openrouter" model "111" needs an api; '
      + 'the installed catalog does not describe it, so set the route\'s api to the wire protocol its endpoint speaks'

    expect(ctx.llm.listProviders()).toEqual([{ id: 'openrouter', name: 'openrouter' }])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openrouter'], declared: false, error: failure,
    })
    expect((await ctx.llm.listModels('openrouter')).map(model => model.id)).toEqual([known.id])
    const bad = await assemble(ctx, { provider: 'openrouter', model: '111', messages: [] })
    expect(bad.finish).toMatchObject({ kind: 'error', failure: { code: 'INVALID_CONFIG', message: failure } })
    expect(server.requests).toHaveLength(0)
    const good = await assemble(ctx, { provider: 'openrouter', model: known.id, messages: [] })
    expect(good.message.content).toEqual([{ type: 'text', text: 'hello' }])

    await configurations.get(ctx)!.update({ providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openrouter', 'deepseek'])
    const beforeRejected: unknown = configurations.get(ctx)!.entry.options.config
    await expect(configurations.get(ctx)!.update({ providers: { openrouter: { displayName: 'Edited' } } })).rejects.toThrow(failure)
    expect(configurations.get(ctx)!.entry.options.config).toEqual(beforeRejected)

    const diagnostics: Array<string | undefined> = []
    ctx.on('llm/adapters-updated', () => {
      diagnostics.push(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'openrouter')?.error)
    })
    await configurations.get(ctx)!.update({ providers: { openrouter: { api: 'openai-completions' } } })
    expect(diagnostics).toEqual([undefined])
    expect(ctx.llm.listProviders()[0]).toEqual({ id: 'openrouter', name: 'openrouter' })
    const repaired = await assemble(ctx, { provider: 'openrouter', model: '111', messages: [] })
    expect(repaired.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.requests).toHaveLength(2)
  })

  it('allows removing an obsolete override and deleting a route whose catalog cannot be built', async () => {
    const dir = await home()
    const stored = { providers: {
      anthropic: { modelOverrides: { 'removed-model': { maxTokens: 4096 } } },
      'retired-route': {},
    } }
    const ctx = await boot(dir, stored)
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'anthropic')?.error)
      .toContain('modelOverrides names "removed-model"')
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'retired-route')?.error)
      .toContain('resolves no models')
    expect((await ctx.llm.listModels('anthropic')).length).toBeGreaterThan(0)
    await expect(ctx.llm.resolveModelInfo('anthropic', 'removed-model')).rejects.toThrow('modelOverrides names "removed-model"')
    await expect(ctx.llm.resolveModelInfo('retired-route', 'anything')).rejects.toThrow('resolves no models')
    await configurations.get(ctx)!.replace({ providers: { anthropic: {} } })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'anthropic', name: 'anthropic' }])
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'retired-route')).toBeUndefined()
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'anthropic')?.error).toBeUndefined()
  })

  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'version: 1\nrefs:\n  PI_DYNAMIC_KEY: pk-from-settings\n  PI_LIVE_KEY: live-key\n  PI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    // The exact product posture: `- id: llm-pi-ai` with no config at all.
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: every installed catalog provider is configurable
    // before any route exists, each addressed inside the providers dict.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.length).toBeGreaterThan(30)
    expect(directory).toContainEqual({
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    })
    await configurations.get(ctx)!.update({
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    await expect(ctx.llm.listModels('deepseek')).resolves.not.toHaveLength(0)

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer pk-from-settings')

    // Emptying the user layer returns the adapter to its dormant state.
    await configurations.get(ctx)!.replace(initialConfigs.get(ctx)!)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'version: 1\nrefs:\n  PI_LIVE_KEY: live-key\n  PI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: 'http://127.0.0.1:1/v1' } },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await configurations.get(ctx)!.update({
      providers: { deepseek: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'deepseek'])

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer live-key')

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await configurations.get(ctx)!.replace(initialConfigs.get(ctx)!)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const removed = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(removed.finish).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
  })

  it('rotates the per-request credential referenced by apiKeyEnv', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  PI_DYNAMIC_KEY: pk-one\n', { mode: 0o600 })
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.credentials.set(credentialRef('PI_DYNAMIC_KEY'), 'pk-two')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[1]?.authorization).toBe('Bearer pk-two')
  })

  it('re-registers routes in place when a captured retry policy changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await configurations.get(ctx)!.update({
      providers: {
        openai: {
          retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
        },
      },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('stores an unserviceable route with its diagnostic instead of refusing the write', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    // Shape-valid but unserviceable: a route the catalog does not ship and
    // that lists no models of its own. The write stores the route with its
    // catalog diagnostic so a configuration surface can repair it (fetch,
    // hand-enter, or delete its models); a direct request fails loud with the
    // same diagnostic before any network I/O.
    await configurations.get(ctx)!.update({ providers: { 'not-a-real-provider': {} } })
    const stored = ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'not-a-real-provider')
    expect(stored?.declared).toBe(true)
    expect(stored?.error).toContain('resolves no models')
    await expect(ctx.llm.resolveModelInfo('not-a-real-provider', 'anything')).rejects.toThrow(/resolves no models/)

    // Repairing the route with a serviceable model clears its diagnostic.
    await configurations.get(ctx)!.update({
      providers: { 'not-a-real-provider': {
        api: 'openai-completions',
        baseURL: 'https://acme.test/v1',
        models: [{ id: 'm-1' }],
      } },
    })
    expect(ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'not-a-real-provider')?.error)
      .toBeUndefined()

    // A self-contained profile error still refuses the write and leaves the
    // stored route set alone.
    await expect(configurations.get(ctx)!.update({
      providers: { openai: { headers: { 'bad header name': 'value' } } },
    })).rejects.toThrow(/provider "openai" header "bad header name" is not valid for Fetch/)
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['not-a-real-provider', 'openai'])

    // The empty-route allowance never opens the door to another catalog
    // failure: a changed set carrying one refuses whole, so its empty route
    // does not slip into the stored document beside it. Both catalog failure
    // kinds (a route-level override with no catalog, a model-level duplicate
    // id) keep the refusal.
    for (const broken of [
      { modelOverrides: { x: { maxTokens: 4096 } } },
      { api: 'openai-completions', baseURL: 'https://acme.test/v1', models: [{ id: 'a' }, { id: 'a' }] },
    ]) {
      await expect(configurations.get(ctx)!.update({ providers: {
        'empty-route': {},
        'broken-route': broken,
      } })).rejects.toThrow(/resolves no models/)
      expect(ctx.llm.listConfigurableProviders().find(candidate => candidate.provider === 'empty-route')).toBeUndefined()
    }
  })

  it('keeps serving its routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'version: 1\nrefs:\n  PI_LIVE_KEY: live-key\n  PI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, { providers: { openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` } } })
    // Another adapter owns `anthropic`; the registry must refuse to hand it over.
    ctx.llm.registerAdapter(['anthropic'], new StubAdapter())

    await configurations.get(ctx)!.update({
      providers: {
        openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` },
        anthropic: { apiKeyEnv: 'PI_OTHER_KEY' },
      },
    })

    // The conflicting swap was refused whole: the previous route set still
    // owns openai (an eager dispose would have dropped it), and anthropic
    // still belongs to its original adapter.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])

    // Reverting to the working configuration re-applies, even though its
    // facts equal the ones the registry already holds.
    await configurations.get(ctx)!.replace(initialConfigs.get(ctx)!)
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/responses', '/v1/responses'])
  })

  it('ignores a settings document that merely reorders its provider keys', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {}, anthropic: {} } })
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // Same routes, different YAML key order: nothing about the registration
    // changed, so no swap should happen at all.
    await configurations.get(ctx)!.update({ providers: { anthropic: {}, openai: {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
  })
})
