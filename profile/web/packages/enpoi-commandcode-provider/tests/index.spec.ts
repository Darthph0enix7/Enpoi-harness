/**
 * Plugin mount surface: every configured route joins the configurable-provider
 * directory under the plugin's settings namespace (the Keys card's address for
 * pool status), the pool operations answer for that namespace, and a bare
 * mount stays dormant.
 */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import * as CommandCode from '../src/index.js'

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
