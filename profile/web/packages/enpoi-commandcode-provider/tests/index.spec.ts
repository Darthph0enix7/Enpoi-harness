/**
 * Plugin mount surface: every configured route joins the configurable-provider
 * directory under the plugin's settings namespace (the Keys card's address for
 * pool status), the pool operations answer for that namespace, a registered
 * model discovery answers the Models page, and a bare mount stays dormant.
 */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import * as CommandCode from '../src/index.js'
import { contextWindowOf, maxOutputTokensOf, modalitiesOf, parseCatalog } from '../src/catalog.js'
import { manifestById } from '../../enpoi-heavy-providers/src/manifests.js'
import { useDetectedInstance, type HeavyDeps } from '../../enpoi-heavy-providers/src/planner.js'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mount(config: unknown): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandCode, config)
  return ctx
}

it('registers each configured route in the Keys-card directory with pool operations', async () => {
  const ctx = await mount({
    providers: {
      commandcode: {
        displayName: 'Command Code (keypool)',
        baseURL: 'http://127.0.0.1:8899/commandcode',
        keyless: true,
      },
    },
  })

  expect(ctx.llm.listConfigurableProviders()).toEqual([{
    provider: 'commandcode',
    displayName: 'Command Code (keypool)',
    settingsNs: 'commandcode-provider',
    settingsPath: ['providers', 'commandcode'],
    declared: true,
  }])
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['commandcode'])
  // The registered namespace answers with the route's (empty) identity pool.
  await expect(ctx.llm.poolStatus('commandcode-provider', 'commandcode')).resolves.toEqual([])
})

it('withdraws the directory entry when the plugin fiber is disposed', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  const fiber = ctx.plugin(CommandCode, {
    providers: { commandcode: { baseURL: 'http://127.0.0.1:8899/commandcode', keyless: true } },
  })
  await fiber
  expect(ctx.llm.listConfigurableProviders()).toHaveLength(1)

  await fiber.dispose()
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
  expect(ctx.llm.listProviders()).toEqual([])
})

it('stays dormant and registers nothing without a configured route', async () => {
  const ctx = await mount({})
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
  expect(ctx.llm.listProviders()).toEqual([])
})

/** The bundled catalog snapshot as the provider package ships it. */
function bundledCatalog() {
  return parseCatalog(JSON.parse(readFileSync(new URL('../catalog.snapshot.json', import.meta.url), 'utf8')) as unknown)
}

it('model discovery answers the whole bundled catalog with capacities and modalities', async () => {
  const ctx = await mount({
    providers: {
      commandcode: {
        displayName: 'Command Code (direct)',
        api: 'commandcode/alpha-generate',
        baseURL: 'https://api.commandcode.ai',
        apiKeyEnv: 'COMMANDCODE_KEY_1',
        pool: { strategy: 'priority-sticky', identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1' }] },
      },
    },
  })
  const snapshot = bundledCatalog()
  expect(snapshot.length).toBeGreaterThan(1)

  // A configured route answers the Models page's Refresh/Test Connection.
  const models = await ctx.llm.discoverModels('commandcode-provider', { provider: 'commandcode', baseURL: 'https://api.commandcode.ai' })
  expect(models.map(model => model.id)).toEqual(snapshot.map(entry => entry.id))

  // A draft route (Add Provider, no route stored yet) answers the same catalog.
  const draft = await ctx.llm.discoverModels('commandcode-provider', { baseURL: 'https://api.commandcode.ai' })
  expect(draft.map(model => model.id)).toEqual(expect.arrayContaining(snapshot.map(entry => entry.id)))

  const entry = snapshot.find(candidate => modalitiesOf(candidate)?.includes('image'))!
  const discovered = models.find(model => model.id === entry.id)!
  expect(discovered.contextWindow).toBe(contextWindowOf(entry))
  expect(discovered.maxTokens).toBe(maxOutputTokensOf(entry))
  expect(discovered.inputModalities).toEqual(modalitiesOf(entry))
})

it('a fresh direct-route install writes every catalog model into the route', async () => {
  const ctx = await mount({
    providers: {
      commandcode: {
        displayName: 'Command Code (direct)',
        api: 'commandcode/alpha-generate',
        baseURL: 'https://api.commandcode.ai',
        apiKeyEnv: 'COMMANDCODE_KEY_1',
        pool: { strategy: 'priority-sticky', identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1' }] },
      },
    },
  })
  const snapshot = bundledCatalog()
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const deps: HeavyDeps = {
    home: '/tmp',
    dshHome: '/tmp/.dsh',
    settings: {
      describe: () => [{ ns: 'commandcode-provider', revision: 1, value: { providers: {} } }],
      mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
    },
    llm: ctx.llm,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'ok' }),
    runStep: async () => ({ exitCode: 0, output: '' }),
  }

  const outcome = await useDetectedInstance(deps, manifestById('commandcode')!)

  expect(outcome.models).toHaveLength(snapshot.length)
  expect(mutations).toHaveLength(1)
  const written = mutations[0]!.ops[0] as { path: string[]; value: { models: Array<Record<string, unknown>> } }
  expect(mutations[0]!.ns).toBe('commandcode-provider')
  expect(written.path).toEqual(['providers', 'commandcode'])
  expect(written.value.models.map(model => model.id)).toEqual(snapshot.map(entry => entry.id))
  const first = written.value.models[0]!
  expect(first.contextWindow).toBe(contextWindowOf(snapshot[0]))
  expect(first.maxTokens).toBe(maxOutputTokensOf(snapshot[0]))
  expect(first.input).toEqual(modalitiesOf(snapshot[0]))

  // The written profile validates against the plugin's live route schema and
  // keeps every model's capacities.
  const validated = CommandCode.Config({ providers: { commandcode: written.value as never } })
  const providers = (validated.providers as unknown as {
    get: () => Record<string, { models: readonly Record<string, unknown>[] }>
  }).get()
  expect(providers.commandcode!.models).toHaveLength(snapshot.length)
  expect(providers.commandcode!.models[0]!.contextWindow).toBe(contextWindowOf(snapshot[0]))
})

it('declares its wire protocol as a single-value union for the route schema', () => {
  type UnionNode = { type: string; list?: { value?: unknown }[] }
  const api = (CommandCode.Config as unknown as {
    dict: { providers: { inner: { dict: { api: UnionNode } } } }
  }).dict.providers.inner.dict.api
  expect(api.type).toBe('union')
  expect(api.list?.map(member => member.value)).toEqual(['commandcode/alpha-generate'])
})

it('answers an identity test with the structured 501 unavailability without spending quota', async () => {
  const ctx = await mount({
    providers: {
      commandcode: {
        baseURL: 'https://api.commandcode.ai',
        apiKeyEnv: 'COMMANDCODE_KEY_1',
        pool: { identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1' }] },
      },
    },
  })
  const result = await ctx.llm.poolTestIdentity('commandcode-provider', 'commandcode', 'key-1')
  expect(result.ok).toBe(false)
  expect(result.status).toBe(501)
  expect(result.error).toContain('scripts/live-gate.mjs')
})
