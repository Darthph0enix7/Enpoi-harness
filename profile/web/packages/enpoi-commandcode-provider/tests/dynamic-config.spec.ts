/**
 * Request-level dynamic route profiles: a settings edit committed through the
 * Loader's volatile-update seam reaches the next operation without remounting
 * the plugin — a new pool identity appears, a changed baseURL is honored by
 * the next catalog resolution, and a display-name edit re-registers in place.
 * A dormant mount wakes when settings supply its first route.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as CommandCode from '../src/index.js'
import { liveConfig } from './live-config.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  while (cleanups.length > 0) await cleanups.pop()!()
})

it('re-resolves route profiles from the volatile config without a remount', async () => {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)

  const requested: string[] = []
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('/catalog.json')) {
      return new Response(JSON.stringify([{ id: url.includes('127.0.0.1:8802') ? 'model-b' : 'model-a' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const live = await liveConfig(ctx, CommandCode, {
    providers: {
      commandcode: {
        displayName: 'Command Code (keypool)',
        baseURL: 'http://127.0.0.1:8801/commandcode',
        keyless: true,
      },
    },
  })
  expect(ctx.llm.listProviders()).toEqual([{ id: 'commandcode', name: 'Command Code (keypool)' }])
  expect((await ctx.llm.listModels('commandcode')).map(model => model.id)).toEqual(['model-a'])
  await expect(ctx.llm.poolStatus('commandcode-provider', 'commandcode')).resolves.toEqual([])

  // A settings edit of volatile fields commits into the running fiber; it must
  // not re-register routes, let alone remount the plugin.
  const registryEvents: unknown[] = []
  ctx.on('llm/adapters-updated', () => registryEvents.push(Date.now()))

  await live.update({
    providers: {
      commandcode: {
        baseURL: 'http://127.0.0.1:8802/commandcode',
        pool: { strategy: 'priority-sticky', identities: [{ id: 'sub-b', credentialRef: 'CC_SUB_B' }] },
      },
    },
  })
  expect(registryEvents).toHaveLength(0)

  // The Keys card sees the new identity; the changed baseURL is honored by the
  // next resolution, which builds a fresh catalog store for the new endpoint.
  await expect(ctx.llm.poolStatus('commandcode-provider', 'commandcode')).resolves.toMatchObject([
    { id: 'sub-b', credentialRef: 'CC_SUB_B' },
  ])
  expect((await ctx.llm.listModels('commandcode')).map(model => model.id)).toEqual(['model-b'])
  expect(requested).toContain('http://127.0.0.1:8802/commandcode/catalog.json')

  // A display-name edit is a registration-captured fact: the same adapter
  // re-registers in place, and the new name reaches the provider directory.
  // Each of the two registrations announces its own atomic swap.
  await live.update({ providers: { commandcode: { displayName: 'Command Code (edited)' } } })
  expect(registryEvents).toHaveLength(2)
  expect(ctx.llm.listProviders()).toEqual([{ id: 'commandcode', name: 'Command Code (edited)' }])
  expect(ctx.llm.listConfigurableProviders()).toEqual([{
    provider: 'commandcode',
    displayName: 'Command Code (edited)',
    settingsNs: 'commandcode-provider',
    settingsPath: ['providers', 'commandcode'],
    declared: true,
  }])
})

it('wakes a dormant mount for a settings-born route and withdraws it when the route leaves', async () => {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const live = await liveConfig(ctx, CommandCode, {})

  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toEqual([])

  await live.update({ providers: { commandcode: { baseURL: 'https://vendor.test/v1', keyless: true } } })
  expect(ctx.llm.listProviders()).toEqual([{ id: 'commandcode', name: 'commandcode' }])
  expect(ctx.llm.listConfigurableProviders()).toEqual([{
    provider: 'commandcode',
    displayName: 'commandcode',
    settingsNs: 'commandcode-provider',
    settingsPath: ['providers', 'commandcode'],
    declared: true,
  }])
  // The direct-vendor baseURL resolves the bundled snapshot without fetching.
  expect((await ctx.llm.listModels('commandcode')).length).toBeGreaterThan(0)

  await live.replace({ providers: {} })
  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})

it('refuses a settings write whose routes cannot be served and keeps the stored route', async () => {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const live = await liveConfig(ctx, CommandCode, {
    providers: { commandcode: { baseURL: 'https://vendor.test/v1', keyless: true } },
  })

  await expect(live.update({ providers: { commandcode: { baseURL: '' } } }))
    .rejects.toThrow('needs a non-empty baseURL')

  // The refused write did not displace the working route.
  expect(ctx.llm.listProviders()).toEqual([{ id: 'commandcode', name: 'commandcode' }])
  expect((await ctx.llm.listModels('commandcode')).length).toBeGreaterThan(0)
})
