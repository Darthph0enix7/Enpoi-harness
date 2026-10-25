import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  FIRST_RUN_SEED_VERSION, KILO_API, KILO_BASE_URL, KILO_DISPLAY_NAME, KILO_FREE_CHAIN_ID,
  KILO_KEY_REF, KILO_MODEL_ID, KILO_MODEL_NAME, KILO_PERSONA_IDS, KILO_ROUTE_ID, apply,
  Config as SeedConfig, kiloPersonaSeeds, kiloRouteValue, seedFirstRun, type SeedSettings,
} from '../src/index.ts'

/** Recorded settings writes plus the projection the seed reads. */
function fakeSettings(
  section: { user?: unknown } | undefined,
  orchestration = true,
): { settings: SeedSettings; writes: Array<{ ns: string; patch: object }> } {
  const writes: Array<{ ns: string; patch: object }> = []
  return {
    writes,
    settings: {
      describeNamespace: (ns: string) => {
        if (ns === 'enpoi-orchestration' && !orchestration) return undefined
        return section
      },
      update: async (ns, patch) => { writes.push({ ns, patch }) },
    },
  }
}

const OPTIONS = { provider: KILO_ROUTE_ID, model: KILO_MODEL_ID, chain: KILO_FREE_CHAIN_ID, version: FIRST_RUN_SEED_VERSION }

describe('first-run Kilo seed', () => {
  it('writes the keyless route, the default model, the personas, and the marker on a fresh document', async () => {
    const { settings, writes } = fakeSettings({ user: {} })
    await expect(seedFirstRun(settings, OPTIONS)).resolves.toBe('seeded')
    expect(writes.map(write => write.ns)).toEqual(['llm-pi-ai', 'agent-default-model', 'enpoi-orchestration', 'first-run'])
    expect(writes[0]?.patch).toEqual({
      providers: {
        kilo: {
          displayName: KILO_DISPLAY_NAME,
          api: KILO_API,
          baseURL: KILO_BASE_URL,
          apiKeyEnv: KILO_KEY_REF,
          keyless: true,
          models: [{ id: KILO_MODEL_ID, name: KILO_MODEL_NAME }],
        },
      },
    })
    // The measured working free model is the first attempt; the shipped free
    // group is the fallback rung behind it.
    expect(writes[1]?.patch).toEqual({ provider: 'kilo', model: KILO_MODEL_ID, chain: 'free' })
    expect(writes[2]?.patch).toEqual({ personas: kiloPersonaSeeds(KILO_ROUTE_ID, KILO_MODEL_ID) })
    expect(kiloPersonaSeeds(KILO_ROUTE_ID, KILO_MODEL_ID)['keeper']).toEqual({
      provider: KILO_ROUTE_ID,
      model: KILO_MODEL_ID,
      chain: KILO_FREE_CHAIN_ID,
    })
    expect(Object.keys(kiloPersonaSeeds(KILO_ROUTE_ID, KILO_MODEL_ID)).sort()).toEqual([...KILO_PERSONA_IDS].sort())
    expect(writes[3]?.patch).toEqual({ seedVersion: FIRST_RUN_SEED_VERSION })
  })

  it('honors route overrides and pins the personas to the seeded provider/model', async () => {
    const { settings, writes } = fakeSettings({ user: {} })
    const custom = {
      provider: 'local-gateway',
      model: 'custom/model',
      chain: 'paid-stable',
      version: FIRST_RUN_SEED_VERSION,
      displayName: 'Local Gateway',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:9999/v1',
      apiKeyEnv: 'LOCAL_GATEWAY_KEY',
      keyless: false,
    }
    await expect(seedFirstRun(settings, custom)).resolves.toBe('seeded')
    expect(writes[0]?.patch).toEqual({
      providers: {
        'local-gateway': {
          displayName: 'Local Gateway',
          api: 'openai-responses',
          baseURL: 'http://127.0.0.1:9999/v1',
          apiKeyEnv: 'LOCAL_GATEWAY_KEY',
          keyless: false,
          models: [{ id: 'custom/model', name: 'custom/model' }],
        },
      },
    })
    expect(writes[1]?.patch).toEqual({ provider: 'local-gateway', model: 'custom/model', chain: 'paid-stable' })
    expect(writes[2]?.patch).toEqual({
      personas: {
        keeper: { provider: 'local-gateway', model: 'custom/model', chain: 'paid-stable' },
        compaction: { provider: 'local-gateway', model: 'custom/model', chain: 'paid-stable' },
      },
    })
  })

  it('omits the chain when the configured group is blank', async () => {
    const { settings, writes } = fakeSettings({ user: {} })
    await expect(seedFirstRun(settings, { ...OPTIONS, chain: '' })).resolves.toBe('seeded')
    expect(writes[1]?.patch).toEqual({ provider: 'kilo', model: KILO_MODEL_ID })
    expect(writes[2]?.patch).toEqual({
      personas: {
        keeper: { provider: 'kilo', model: KILO_MODEL_ID },
        compaction: { provider: 'kilo', model: KILO_MODEL_ID },
      },
    })
  })

  it('skips the persona write when the fleet namespace is not mounted', async () => {
    const { settings, writes } = fakeSettings({ user: {} }, false)
    await expect(seedFirstRun(settings, OPTIONS)).resolves.toBe('seeded')
    expect(writes.map(write => write.ns)).toEqual(['llm-pi-ai', 'agent-default-model', 'first-run'])
  })

  it('never overwrites an install that already carries provider routes', async () => {
    const { settings, writes } = fakeSettings({ user: { providers: { anthropic: {} } } })
    await expect(seedFirstRun(settings, OPTIONS)).resolves.toBe('present')
    expect(writes).toEqual([{ ns: 'first-run', patch: { seedVersion: FIRST_RUN_SEED_VERSION } }])
  })

  it('reports an unmounted settings service or namespace without writing', async () => {
    const absentService = fakeSettings(undefined)
    await expect(seedFirstRun(undefined, OPTIONS)).resolves.toBe('unavailable')
    await expect(seedFirstRun(absentService.settings, OPTIONS)).resolves.toBe('unavailable')
    expect(absentService.writes).toEqual([])
  })

  it('builds a keyless route value whose model entry follows the configured model', () => {
    expect(kiloRouteValue(KILO_MODEL_ID)).toMatchObject({ keyless: true, apiKeyEnv: KILO_KEY_REF, baseURL: KILO_BASE_URL })
    expect(kiloRouteValue('other-model')).toMatchObject({ models: [{ id: 'other-model', name: 'other-model' }] })
  })

  it('keeps today\'s values as the route defaults', () => {
    expect(kiloRouteValue()).toMatchObject({
      displayName: KILO_DISPLAY_NAME,
      api: KILO_API,
      baseURL: KILO_BASE_URL,
      apiKeyEnv: KILO_KEY_REF,
      keyless: true,
    })
  })
})

/**
 * A live-document settings double plus the real plugin context pieces `apply`
 * touches. `marker` is the volatile the loader resolves before the seed runs,
 * so a later boot reads back whatever a previous seed stored.
 */
function applyHarness(initial: Record<string, unknown> = {}, marker?: string): {
  document: Record<string, unknown>
  writes: Array<{ ns: string; patch: object }>
  config: SeedConfig
  ctx: Context
} {
  const document = structuredClone(initial)
  const writes: Array<{ ns: string; patch: object }> = []
  const settings = {
    configure: () => {},
    describeNamespace: (ns: string) => ({ user: document[ns] }),
    update: async (ns: string, patch: object) => {
      writes.push({ ns, patch })
      document[ns] = { ...(document[ns] as Record<string, unknown> | undefined), ...patch }
    },
  }
  const ctx = new Context()
  ctx.provide('settings', settings as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const config: SeedConfig = {
    enabled: true,
    provider: KILO_ROUTE_ID,
    model: KILO_MODEL_ID,
    chain: KILO_FREE_CHAIN_ID,
    displayName: KILO_DISPLAY_NAME,
    api: KILO_API,
    baseURL: KILO_BASE_URL,
    apiKeyEnv: KILO_KEY_REF,
    keyless: true,
    seedVersion: { get: () => marker },
  }
  return { document, config, ctx, writes }
}

/** Let the plugin's fire-and-forget `loader.await().then(...)` chain settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('first-run seed marker', () => {
  it('writes the free default once per settings document and never re-adds a removed route', async () => {
    const harness = applyHarness()
    apply(harness.ctx, harness.config)
    await vi.waitFor(() => { expect(harness.writes).toHaveLength(4) })
    expect(harness.document['agent-default-model']).toEqual({
      provider: KILO_ROUTE_ID,
      model: KILO_MODEL_ID,
      chain: KILO_FREE_CHAIN_ID,
    })
    expect(harness.document['first-run']).toEqual({ seedVersion: FIRST_RUN_SEED_VERSION })

    // A later boot reads the stored marker. The operator removed the seeded
    // route in between, and the seed must not put it (or the default) back.
    delete harness.document['llm-pi-ai']
    delete harness.document['agent-default-model']
    const later = applyHarness(harness.document, FIRST_RUN_SEED_VERSION)
    apply(later.ctx, later.config)
    await settle()
    expect(later.writes).toEqual([])
    expect(later.document['llm-pi-ai']).toBeUndefined()
    expect(later.document['agent-default-model']).toBeUndefined()
    await harness.ctx.fiber.dispose()
    await later.ctx.fiber.dispose()
  })

  it('defaults the seed to the measured working free model and the shipped free group', () => {
    expect(SeedConfig({} as SeedConfig)).toMatchObject({
      provider: 'kilo',
      model: 'poolside/laguna-s-2.1:free',
      chain: 'free',
      keyless: true,
    })
  })
})
