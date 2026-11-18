import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PeerRoutingService } from '@deepseek-ai/dsh-api-peer/types'
import { apply, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../src/index.ts'

/** Settings document the real catalogue reader projects. */
const LLM_DOCUMENT = {
  providers: {
    kilo: {
      models: [
        { id: 'free', cost: { input: 0, output: 0 }, tools: true, contextWindow: 131_072, reasoningEfforts: { minimal: 'minimal' } },
        { id: 'paid', cost: { input: 1, output: 1 }, tools: true },
        { id: 'gated', cost: { input: 0, output: 0 }, gated: true },
      ],
    },
    groq: { models: [{ id: 'llama', cost: { input: 0, output: 0 }, tools: true }] },
  },
}

/** The chain projection the modelChains plugin publishes. */
const CHAINS = {
  free: {
    label: 'Free',
    selectors: [{ adopt: true }],
    members: [{ provider: 'kilo', model: 'free' }, { provider: 'groq', model: 'llama' }],
  },
}

/** A context whose `get` answers the supplied seams. */
function makeContext(seams: {
  settings?: unknown
  catalogRules?: unknown
  llm?: unknown
}) {
  const provided = new Map<string, unknown>()
  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return seams.settings
      if (ns === 'catalogRules') return seams.catalogRules
      if (ns === 'llm') return seams.llm
      return undefined
    },
    provide: (name: string, value: unknown) => { provided.set(name, value) },
  }
  return { ctx, provided }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('enpoi-peer-routing apply wiring', () => {
  it('provides peerRouting over the live settings, rules engine, and route health', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const settings = {
      get: (ns: string) => ns === 'llm-pi-ai' ? LLM_DOCUMENT : undefined,
      readArtifact: (key: string) => key === 'modelChains.resolved' ? { value: CHAINS } : undefined,
    }
    const catalogRules = {
      catalogue: () => [
        { provider: 'kilo', id: 'free', cost: { input: 0, output: 0 }, tools: true, contextWindow: 131_072 },
        { provider: 'kilo', id: 'paid', cost: { input: 1, output: 1 }, tools: true },
        { provider: 'kilo', id: 'gated', cost: { input: 0, output: 0 }, gated: true },
        { provider: 'groq', id: 'llama', cost: { input: 0, output: 0 }, tools: true },
      ],
      expandRawSelector: () => ({ links: [{ provider: 'kilo', model: 'free' }, { provider: 'groq', model: 'llama' }] }),
    }
    const llm = { routeHealth: () => [{ provider: 'kilo', model: 'free', coolingUntil: Date.now() + 60_000 }] }
    const { ctx, provided } = makeContext({ settings, catalogRules, llm })
    apply(ctx as never)
    const service = provided.get('peerRouting') as PeerRoutingService
    expect(provided.has('peerRouting')).toBe(true)

    await expect(service.evaluate({ allowChains: ['free'], requireZeroPrice: true }, { provider: '', model: '', chain: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'groq', model: 'llama', chain: 'free' } })
    await expect(service.evaluate({ allowModels: ['kilo/*'], requireZeroPrice: true }, { provider: 'kilo', model: 'paid' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/paid' })

    const discovery = await service.discover({ allowChains: ['free'], allowModels: ['*'] }, {})
    expect(discovery.chains[0]?.members).toEqual([
      { provider: 'kilo', model: 'free', state: 'cooldown', cooldownUntil: expect.any(Number) },
      { provider: 'groq', model: 'llama', state: 'ready' },
    ])
    expect(discovery.models.map(model => `${model.provider}/${model.model}`)).toEqual(['groq/llama', 'kilo/free', 'kilo/paid'])
    expect(discovery.models.find(model => model.model === 'free')?.reasoningEfforts).toEqual(['minimal'])
  })

  it('falls back to the raw catalogue and empty chain/health views without optional seams', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const settings = { get: (ns: string) => ns === 'llm-pi-ai' ? LLM_DOCUMENT : undefined }
    const { ctx, provided } = makeContext({ settings })
    apply(ctx as never, { defaultLimit: 2, maxLimit: 2 })
    const service = provided.get('peerRouting') as PeerRoutingService

    // No rules engine: the price is unprovable, so a price requirement refuses.
    await expect(service.evaluate({ allowModels: ['kilo/*'], requireZeroPrice: true }, { provider: 'kilo', model: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'price-unproven', denied: 'kilo/free' })
    // Without the requirement the raw catalogue row is selectable and honest.
    const discovery = await service.discover({ allowModels: ['*'], allowChains: ['free'] }, {})
    expect(discovery.chains).toEqual([])
    expect(discovery.models.find(model => model.model === 'free')).toMatchObject({ zeroPrice: 'unknown', trainsOnData: 'yes' })
    // The configured two-row page is applied and cursor pagination continues.
    expect(discovery.models).toHaveLength(2)
    expect(discovery.nextCursor).toBeDefined()
    const next = await service.discover({ allowModels: ['*'] }, { cursor: discovery.nextCursor })
    expect(next.models).toHaveLength(1)
    expect(next.models[0]?.model).not.toBe(discovery.models[0]?.model)
  })

  it('fails closed when the optional seams throw or answer malformed values', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const settings = {
      get: (ns: string) => ns === 'llm-pi-ai' ? LLM_DOCUMENT : undefined,
      readArtifact: () => { throw new Error('artifact down') },
    }
    const catalogRules = {
      catalogue: () => { throw new Error('rules down') },
      expandRawSelector: () => { throw new Error('selector down') },
    }
    const llm = { routeHealth: () => { throw new Error('health down') } }
    const { ctx, provided } = makeContext({ settings, catalogRules, llm })
    apply(ctx as never)
    const service = provided.get('peerRouting') as PeerRoutingService

    // A broken rules engine answers NO catalogue: the manual gate cannot be bypassed.
    await expect(service.evaluate({ allowModels: ['*'] }, { provider: 'kilo', model: 'free' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'kilo/free' })
    expect((await service.discover({ allowChains: ['free'], allowModels: ['*'] }, {})).chains).toEqual([])

    // A throwing route-health read means "nothing is cooling", and a non-array
    // view is treated the same way.
    const healthy = makeContext({
      settings,
      catalogRules: { catalogue: () => [{ provider: 'kilo', id: 'free', cost: { input: 0, output: 0 } }], expandRawSelector: () => ({ links: [] }) },
      llm: { routeHealth: () => 'not-an-array' },
    })
    apply(healthy.ctx as never)
    const healthyService = healthy.provided.get('peerRouting') as PeerRoutingService
    await expect(healthyService.evaluate({ allowModels: ['*'] }, { provider: 'kilo', model: 'free' }))
      .resolves.toEqual({ allowed: true, selection: { provider: 'kilo', model: 'free' } })
  })

  it('serves no route when the settings service is absent', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { ctx, provided } = makeContext({})
    apply(ctx as never)
    const service = provided.get('peerRouting') as PeerRoutingService
    await expect(service.evaluate({ allowModels: ['*'] }, { provider: 'p', model: 'm' }))
      .resolves.toEqual({ allowed: false, reason: 'unknown-route', denied: 'p/m' })
    expect((await service.discover({ allowModels: ['*'] }, {})).models).toEqual([])
  })

  it('ships bounded page defaults', () => {
    expect(DEFAULT_PAGE_LIMIT).toBe(100)
    expect(MAX_PAGE_LIMIT).toBe(500)
  })
})
