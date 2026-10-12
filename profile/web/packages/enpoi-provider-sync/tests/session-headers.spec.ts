// @vitest-environment node
/**
 * Routing-affinity enforcement (opencode Zen Go): a configured provider block
 * that predates the requirement converges on the next sync pass — the key
 * names the header, the value stays per-request, and the write is idempotent,
 * revision-fenced, and never creates an unconfigured route.
 */
import { describe, expect, it, vi } from 'vitest'
import { enforceSessionHeaders } from '../src/index.ts'

const WANTED = { 'opencode-go': 'x-opencode-session', opencode: 'x-opencode-session' }

function seam(providers: Record<string, unknown>, mutateImpl?: (ns: string, ops: unknown, revision?: number) => Promise<void>) {
  const mutations: { ns: string; ops: unknown; revision?: number }[] = []
  return {
    mutations,
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: { providers } }],
      mutate: async (ns: string, ops: unknown, revision?: number) => {
        mutations.push({ ns, ops, revision })
        if (mutateImpl !== undefined) return await mutateImpl(ns, ops, revision)
      },
    },
  }
}

describe('enforceSessionHeaders', () => {
  it('writes the header on a configured route that lacks it, once', async () => {
    const { settings, mutations } = seam({
      'opencode-go': { api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1' },
      opencode: { sessionHeader: 'x-opencode-session' },
      deepseek: { api: 'openai-completions' },
    })
    const written = await enforceSessionHeaders(settings as never, WANTED)
    expect(written).toEqual(['opencode-go'])
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.ns).toBe('llm-pi-ai')
    expect(mutations[0]?.revision).toBe(7)
    expect(mutations[0]?.ops).toEqual([
      { op: 'set', path: ['providers', 'opencode-go', 'sessionHeader'], value: 'x-opencode-session' },
    ])
  })

  it('never touches a route that is already correct, unconfigured, or unmapped', async () => {
    const { settings, mutations } = seam({
      opencode: { sessionHeader: 'x-opencode-session' },
      deepseek: { api: 'openai-completions' },
    })
    const written = await enforceSessionHeaders(settings as never, WANTED)
    expect(written).toEqual([])
    expect(mutations).toEqual([])
  })

  it('retries a concurrent settings conflict, then converges', async () => {
    let conflicts = 1
    const { settings, mutations } = seam({
      'opencode-go': { api: 'openai-completions' },
    }, async () => {
      if (conflicts > 0) {
        conflicts -= 1
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
    })
    const written = await enforceSessionHeaders(settings as never, WANTED)
    expect(written).toEqual(['opencode-go'])
    expect(mutations).toHaveLength(2)
  })

  it('logs a persistent failure without throwing (fail-soft)', async () => {
    const log = vi.fn()
    const { settings } = seam({ 'opencode-go': { api: 'openai-completions' } }, async () => {
      throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
    })
    const written = await enforceSessionHeaders(settings as never, WANTED, log)
    expect(written).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not write the session header'))
  })
})
