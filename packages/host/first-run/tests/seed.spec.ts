import { describe, expect, it } from 'vitest'
import {
  FIRST_RUN_SEED_VERSION, KILO_BASE_URL, KILO_KEY_REF, KILO_MODEL_ID, KILO_ROUTE_ID,
  kiloRouteValue, seedFirstRun, type SeedSettings,
} from '../src/index.ts'

/** Recorded settings writes plus the projection the seed reads. */
function fakeSettings(section: { user?: unknown } | undefined): { settings: SeedSettings; writes: Array<{ ns: string; patch: object }> } {
  const writes: Array<{ ns: string; patch: object }> = []
  return {
    writes,
    settings: {
      describeNamespace: () => section,
      update: async (ns, patch) => { writes.push({ ns, patch }) },
    },
  }
}

const OPTIONS = { provider: KILO_ROUTE_ID, model: KILO_MODEL_ID, version: FIRST_RUN_SEED_VERSION }

describe('first-run Kilo seed', () => {
  it('writes the keyless route, the default model, and the marker on a fresh document', async () => {
    const { settings, writes } = fakeSettings({ user: {} })
    await expect(seedFirstRun(settings, OPTIONS)).resolves.toBe('seeded')
    expect(writes.map(write => write.ns)).toEqual(['llm-pi-ai', 'agent-default-model', 'first-run'])
    expect(writes[0]?.patch).toEqual({
      providers: {
        kilo: {
          displayName: 'Kilo Gateway',
          api: 'openai-completions',
          baseURL: KILO_BASE_URL,
          apiKeyEnv: KILO_KEY_REF,
          keyless: true,
          models: [{ id: KILO_MODEL_ID, name: 'Kilo Auto (free)' }],
        },
      },
    })
    expect(writes[1]?.patch).toEqual({ provider: 'kilo', model: KILO_MODEL_ID })
    expect(writes[2]?.patch).toEqual({ seedVersion: FIRST_RUN_SEED_VERSION })
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
})
