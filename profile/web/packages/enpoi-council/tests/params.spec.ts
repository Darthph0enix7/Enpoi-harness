import { describe, expect, it } from 'vitest'
import { getCouncilParams, COUNCIL_PARAM_DEFAULTS } from '../src/params'
import { resolveKeeperParams, type Config } from '../../enpoi-context-keeper/src/index'
import { getMemoryParams, MEMORY_PARAM_DEFAULTS } from '../../enpoi-memory/src/retriever'

function settingsCtx(parameters: unknown) {
  return {
    get: (ns: string) => {
      if (ns === 'settings') {
        return { get: () => ({ parameters }) }
      }
      return undefined
    },
  }
}

describe('getCouncilParams (doc 38 hot-swap)', () => {
  it('returns defaults when settings are absent', () => {
    const ctx = { get: () => undefined }
    expect(getCouncilParams(ctx as never)).toEqual(COUNCIL_PARAM_DEFAULTS)
  })

  it('reads configured values fresh from settings', () => {
    const ctx = settingsCtx({
      council: { maxDebateTokens: 250_000, consensusThreshold: 0.9, defaultHideLimit: false },
    })
    const p = getCouncilParams(ctx as never)
    expect(p.maxDebateTokens).toBe(250_000)
    expect(p.consensusThreshold).toBe(0.9)
    expect(p.defaultHideLimit).toBe(false)
    // Unset keys keep defaults
    expect(p.defaultMaxRounds).toBe(6)
    expect(p.quorumFraction).toBeCloseTo(2 / 3)
  })

  it('clamps out-of-range values', () => {
    const ctx = settingsCtx({
      council: { maxDebateTokens: 10_000_000, debaterTimeoutMs: 1, quorumFraction: 2 },
    })
    const p = getCouncilParams(ctx as never)
    expect(p.maxDebateTokens).toBe(500_000)
    expect(p.debaterTimeoutMs).toBe(10_000)
    expect(p.quorumFraction).toBe(1.0)
  })

  it('falls back to defaults on malformed settings', () => {
    const ctx = settingsCtx({ council: 'garbage' })
    expect(getCouncilParams(ctx as never)).toEqual(COUNCIL_PARAM_DEFAULTS)
  })
})

describe('resolveKeeperParams (doc 38 hot-swap)', () => {
  const base: Config = {
    provider: 'freellmapi',
    model: 'auto',
    fallbackProvider: 'antigravity',
    fallbackModel: 'gemini-3.7-flash-tiered',
    leaseMs: 45_000,
    maxInputEvents: 80,
    maxOutputTokens: 2048,
    structuralDistanceK: 24,
    minRefreshMs: 60_000,
    negativeCacheMs: 120_000,
    claimsBatchSize: 8,
    claimsBatchMinutes: 5,
  }

  it('returns config unchanged when settings are absent', () => {
    const ctx = { get: () => undefined }
    expect(resolveKeeperParams(ctx as never, base)).toEqual(base)
  })

  it('overrides config from settings (hot-swap)', () => {
    const ctx = settingsCtx({
      keeper: { leaseMs: 30_000, maxOutputTokens: 1024, claimsBatchSize: 4 },
    })
    const p = resolveKeeperParams(ctx as never, base)
    expect(p.leaseMs).toBe(30_000)
    expect(p.maxOutputTokens).toBe(1024)
    expect(p.claimsBatchSize).toBe(4)
    expect(p.maxInputEvents).toBe(80) // unset keeps config
  })

  it('clamps out-of-range values', () => {
    const ctx = settingsCtx({
      keeper: { leaseMs: 1, maxOutputTokens: 100_000, claimsBatchMinutes: 999 },
    })
    const p = resolveKeeperParams(ctx as never, base)
    expect(p.leaseMs).toBe(15_000)
    expect(p.maxOutputTokens).toBe(4096)
    expect(p.claimsBatchMinutes).toBe(60)
  })
})

describe('getMemoryParams (doc 38 hot-swap)', () => {
  it('returns defaults when settings are absent', () => {
    expect(getMemoryParams({ get: () => undefined })).toEqual(MEMORY_PARAM_DEFAULTS)
  })

  it('reads configured values fresh from settings', () => {
    const ctx = settingsCtx({ memory: { retrieverTopK: 6, retrieverCharBudget: 800 } })
    const p = getMemoryParams(ctx as never)
    expect(p.retrieverTopK).toBe(6)
    expect(p.retrieverCharBudget).toBe(800)
  })

  it('clamps out-of-range values', () => {
    const ctx = settingsCtx({ memory: { retrieverTopK: 99, retrieverCharBudget: 1 } })
    const p = getMemoryParams(ctx as never)
    expect(p.retrieverTopK).toBe(20)
    expect(p.retrieverCharBudget).toBe(200)
  })
})