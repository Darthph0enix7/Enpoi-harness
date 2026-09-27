/**
 * Compaction-policy readout: the effective token threshold and retained tail
 * for the selected summariser route, derived from the live parameter group,
 * the persona assignment, and the model catalog.
 */
import { describe, expect, it } from 'vitest'
import {
  compactionModels,
  deriveCompactionPolicy,
  getCompactionPolicy,
  refreshCompactionPolicy,
  subscribeCompactionPolicy,
} from '../src/client/compaction-policy.ts'
import type { CompactionPolicyReadout } from '../src/client/compaction-policy.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PARAM_DEFAULTS } from '../src/client/params-store.ts'

const PARAMS = PARAM_DEFAULTS.compaction

const CATALOG: ModelCatalog = {
  default: { provider: 'alpha', model: 'big' },
  routableProviders: ['alpha'],
  groups: [
    {
      id: 'alpha',
      name: 'Alpha',
      models: [
        { id: 'big', name: 'Big', contextWindow: 1_000_000, maxTokens: 32_000 },
        { id: 'small', name: 'Small', contextWindow: 32_000 },
      ],
    },
  ],
  failures: [],
}

describe('compaction model catalog indexing', () => {
  it('keys catalog models by provider/model', () => {
    const models = compactionModels(CATALOG)
    expect(models.get('alpha/big')).toEqual({ contextWindow: 1_000_000, maxTokens: 32_000 })
    expect(models.get('alpha/small')).toEqual({ contextWindow: 32_000 })
    expect(compactionModels(undefined).size).toBe(0)
  })
})

describe('effective compaction policy derivation', () => {
  it('derives the threshold and retained tail for an assigned route', () => {
    const readout = deriveCompactionPolicy(
      PARAMS,
      { provider: 'alpha', model: 'big' },
      null,
      compactionModels(CATALOG),
    )
    // 1M window: reserve min(65536, 500000) = 65536; threshold min(800000, 868928).
    expect(readout).toMatchObject({
      route: 'alpha/big',
      contextWindow: 1_000_000,
      outputReserveTokens: 65_536,
      thresholdTokens: 800_000,
      retainTokens: Math.floor((1_000_000 - 65_536) * 0.16),
    })
    expect(readout.problem).toBeUndefined()
  })

  it('labels the inherited session model and falls back to the catalog default', () => {
    const readout = deriveCompactionPolicy(
      PARAMS,
      null,
      CATALOG.default,
      compactionModels(CATALOG),
    )
    expect(readout.route).toBe('session model alpha/big')
    expect(readout.thresholdTokens).toBe(800_000)

    const unknown = deriveCompactionPolicy(PARAMS, null, null, new Map())
    expect(unknown.route).toBe('session model')
    expect(unknown.problem).toContain('no model window known')
  })

  it('reports a chain route without numbers and a windowless route as a problem', () => {
    const chain = deriveCompactionPolicy(
      PARAMS,
      { provider: 'alpha', model: 'big', chain: 'fast' },
      null,
      compactionModels(CATALOG),
    )
    expect(chain.route).toBe('chain fast')
    expect(chain.thresholdTokens).toBeUndefined()

    const windowless = deriveCompactionPolicy(
      { ...PARAMS },
      { provider: 'alpha', model: 'mystery' },
      null,
      compactionModels(CATALOG),
    )
    expect(windowless.problem).toContain('no context window')
  })

  it('honours an absolute tail floor and reports invalid combinations', () => {
    const absolute = deriveCompactionPolicy(
      { ...PARAMS, retainTokens: 20_000 },
      { provider: 'alpha', model: 'big' },
      null,
      compactionModels(CATALOG),
    )
    expect(absolute.retainTokens).toBe(20_000)

    const conflict = deriveCompactionPolicy(
      { ...PARAMS, retainTokens: 900_000 },
      { provider: 'alpha', model: 'big' },
      null,
      compactionModels(CATALOG),
    )
    expect(conflict.problem).toContain('must stay below the 800000-token threshold')

    // The shipped 65,536 headroom exceeds a 32k window's pressure budget.
    const headroom = deriveCompactionPolicy(
      PARAMS,
      { provider: 'alpha', model: 'small' },
      null,
      compactionModels(CATALOG),
    )
    expect(headroom.problem).toContain('no pressure budget')

    // A non-positive headroom is ignored by the backend, so it must not read out.
    const ignoredHeadroom = deriveCompactionPolicy(
      { ...PARAMS, headroomTokens: 0 },
      { provider: 'alpha', model: 'big' },
      null,
      compactionModels(CATALOG),
    )
    expect(ignoredHeadroom.problem).toContain('positive integer')
  })
})

describe('compaction policy store', () => {
  it('refreshes subscribers from the supplied inputs', () => {
    const seen: CompactionPolicyReadout[] = []
    const unsubscribe = subscribeCompactionPolicy(() => { seen.push(getCompactionPolicy()) })
    refreshCompactionPolicy(
      PARAMS,
      { provider: 'alpha', model: 'big' },
      null,
      CATALOG,
    )
    expect(getCompactionPolicy().route).toBe('alpha/big')
    expect(seen.at(-1)?.thresholdTokens).toBe(800_000)
    unsubscribe()
    refreshCompactionPolicy(PARAMS, null, CATALOG.default, CATALOG)
    expect(getCompactionPolicy().route).toBe('session model alpha/big')
    expect(seen).toHaveLength(1)
  })
})
