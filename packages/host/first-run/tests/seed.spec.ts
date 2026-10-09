import { describe, expect, it } from 'vitest'
import {
  FIRST_RUN_SEED_VERSION, KILO_API, KILO_BASE_URL, KILO_DISPLAY_NAME, KILO_KEY_REF, KILO_MODEL_ID,
  KILO_PERSONA_IDS, KILO_ROUTE_ID, kiloPersonaSeeds, kiloRouteValue, seedFirstRun, type SeedSettings,
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

const OPTIONS = { provider: KILO_ROUTE_ID, model: KILO_MODEL_ID, version: FIRST_RUN_SEED_VERSION }

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
          models: [{ id: KILO_MODEL_ID, name: 'Kilo Auto (free)' }],
        },
      },
    })
    expect(writes[1]?.patch).toEqual({ provider: 'kilo', model: KILO_MODEL_ID })
    expect(writes[2]?.patch).toEqual({ personas: kiloPersonaSeeds(KILO_ROUTE_ID, KILO_MODEL_ID) })
    expect(Object.keys(kiloPersonaSeeds(KILO_ROUTE_ID, KILO_MODEL_ID)).sort()).toEqual([...KILO_PERSONA_IDS].sort())
    expect(writes[3]?.patch).toEqual({ seedVersion: FIRST_RUN_SEED_VERSION })
  })

  it('honors route overrides and pins the personas to the seeded provider/model', async () => {
    const { settings, writes } = fakeSettings({ user: {} })
    const custom = {
      provider: 'local-gateway',
      model: 'custom/model',
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
    expect(writes[1]?.patch).toEqual({ provider: 'local-gateway', model: 'custom/model' })
    expect(writes[2]?.patch).toEqual({
      personas: {
        keeper: { provider: 'local-gateway', model: 'custom/model' },
        compaction: { provider: 'local-gateway', model: 'custom/model' },
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
