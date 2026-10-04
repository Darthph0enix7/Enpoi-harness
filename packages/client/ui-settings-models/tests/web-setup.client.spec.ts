/**
 * The web-search step's pure catalogue and request builder: the v1 offer set,
 * pre-selection, endpoint judgement, mounted-provider lookup, and the apply
 * payload the step sends.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createModelsOperations } from '../src/client/operations.ts'
import {
  DEEPSEEK_WEB_KEY_REF, WEB_SEARCH_OFFERS, availableSearchOffers, initialSearchChoice,
  offerAvailable, offerKeyConfigured, providerMounted, webBaseURLFailure, webSetupWrites,
  type WebSetupStatus,
} from '../src/client/web-setup.ts'

/** A host status with overridable slots. */
function status(overrides: Partial<WebSetupStatus> = {}): WebSetupStatus {
  return {
    searchProvider: null,
    fetchProvider: null,
    mounted: [],
    credentials: {},
    ...overrides,
  }
}

describe('web setup catalogue', () => {
  it('carries the v1 offers in design order with their references and dashboards', () => {
    expect(WEB_SEARCH_OFFERS.map(offer => offer.id)).toEqual([
      'exa', 'brave', 'tavily', 'searxng', 'deepseek-official', 'none',
    ])
    const exa = WEB_SEARCH_OFFERS.find(offer => offer.id === 'exa')!
    expect(exa).toMatchObject({ group: 'premium', recommended: true, keyRef: 'EXA_API_KEY' })
    expect(exa.dashboardUrl).toContain('exa')
    expect(WEB_SEARCH_OFFERS.find(offer => offer.id === 'searxng')).toMatchObject({ needsBaseURL: true })
    expect(WEB_SEARCH_OFFERS.find(offer => offer.id === 'none')?.keyRef).toBeUndefined()
    expect(DEEPSEEK_WEB_KEY_REF).toBe('DEEPSEEK_API_KEY')
  })

  it('renders every v1 offer and keeps only DeepSeek native behind its credential', () => {
    for (const offer of WEB_SEARCH_OFFERS) {
      expect(offerAvailable(offer, false)).toBe(offer.id !== 'deepseek-official')
      expect(offerAvailable(offer, true)).toBe(true)
    }
  })

  it('lists the host-configurable offers, excluding the dead options', () => {
    const offers = availableSearchOffers(true)
    expect(offers.map(offer => offer.id)).toEqual([
      'exa', 'brave', 'tavily', 'searxng', 'deepseek-official', 'none',
    ])
    const withoutDeepSeek = availableSearchOffers(false)
    expect(withoutDeepSeek.map(offer => offer.id)).toEqual(['exa', 'brave', 'tavily', 'searxng', 'none'])
  })

  it('pre-selects the configured provider only when the step renders it', () => {
    expect(initialSearchChoice(status({ searchProvider: 'exa' }), false)).toBe('exa')
    expect(initialSearchChoice(status({ searchProvider: 'brave' }), false)).toBe('brave')
    // DeepSeek native without the shared key is not a rendered offer; falls back to default Exa.
    expect(initialSearchChoice(status({ searchProvider: 'deepseek-official' }), false)).toBe('exa')
    expect(initialSearchChoice(status({ searchProvider: 'deepseek-official' }), true)).toBe('deepseek-official')
    expect(initialSearchChoice(status({ searchProvider: 'unknown-provider' }), false)).toBe('exa')
    expect(initialSearchChoice(status(), false)).toBe('exa')
  })

  it('reads the mounted provider list by kind and id', () => {
    const mounted = status({
      mounted: [
        { kind: 'search', provider: 'exa' },
        { kind: 'fetch', provider: 'jina' },
      ],
    })
    expect(providerMounted(mounted, 'search', 'exa')).toBe(true)
    expect(providerMounted(mounted, 'fetch', 'jina')).toBe(true)
    // A same-named id under the other kind is not the provider asked for.
    expect(providerMounted(mounted, 'fetch', 'exa')).toBe(false)
    expect(providerMounted(mounted, 'search', 'jina')).toBe(false)
    expect(providerMounted(status(), 'search', 'exa')).toBe(false)
  })

  it('judges the self-hosted endpoint, keeping a blank field as keep-stored', () => {
    expect(webBaseURLFailure('')).toBeUndefined()
    expect(webBaseURLFailure('   ')).toBeUndefined()
    expect(webBaseURLFailure('http://127.0.0.1:8080')).toBeUndefined()
    expect(webBaseURLFailure('  https://search.example.net  ')).toBeUndefined()
    expect(webBaseURLFailure('not-a-url')).toBe('wizWebBaseUrlInvalid')
    expect(webBaseURLFailure('ftp://search.example.net')).toBe('wizWebBaseUrlInvalid')
  })

  it('reports a configured key only through the offer reference the host described', () => {
    const exa = WEB_SEARCH_OFFERS.find(offer => offer.id === 'exa')!
    const none = WEB_SEARCH_OFFERS.find(offer => offer.id === 'none')!
    expect(offerKeyConfigured(exa, status({ credentials: { EXA_API_KEY: { configured: true, writable: true } } }))).toBe(true)
    expect(offerKeyConfigured(exa, status({ credentials: { EXA_API_KEY: { configured: false, writable: true } } }))).toBe(false)
    expect(offerKeyConfigured(exa, status())).toBe(false)
    expect(offerKeyConfigured(none, status({ credentials: { EXA_API_KEY: { configured: true, writable: true } } }))).toBe(false)
  })

  it('builds the contract apply payload, omitting only the optional endpoint and key', () => {
    expect(webSetupWrites({
      search: 'exa',
      apiKey: 'sk-exa',
      fetch: 'http',
      searchEnabled: true,
      fetchEnabled: true,
    })).toEqual({
      search: { provider: 'exa', apiKey: 'sk-exa' },
      fetch: { provider: 'http' },
      toolToggles: { search: true, fetch: true },
    })

    // The off state and a blank endpoint travel as explicit nulls/false, so
    // the host never guesses whether an absent group meant "leave alone".
    expect(webSetupWrites({
      search: null,
      baseURL: '',
      apiKey: '',
      fetch: null,
      searchEnabled: false,
      fetchEnabled: false,
    })).toEqual({
      search: { provider: null },
      fetch: { provider: null },
      toolToggles: { search: false, fetch: false },
    })

    expect(webSetupWrites({
      search: 'searxng',
      baseURL: 'http://127.0.0.1:8080',
      fetch: 'jina',
      searchEnabled: false,
      fetchEnabled: true,
    })).toEqual({
      search: { provider: 'searxng', baseURL: 'http://127.0.0.1:8080' },
      fetch: { provider: 'jina' },
      toolToggles: { search: false, fetch: true },
    })
  })
})

describe('webSetup operations binding', () => {
  /**
   * The page plugin's context with the optional namespace service provided or
   * absent. The binding reads `remote.webSetup` through `ctx.get`, so a real
   * context proves both the mounted and the not-mounted paths.
   */
  function ctxWith(face: object | undefined): Parameters<typeof createModelsOperations>[0] {
    const ctx = new Context()
    if (face !== undefined) ctx.provide('remote.webSetup', face)
    return ctx
  }

  it('reports a refused read when the namespace is not mounted', async () => {
    const operations = createModelsOperations(ctxWith(undefined))
    await expect(operations.webSetup.status()).resolves.toEqual({ kind: 'refused', message: '' })
    await expect(operations.webSetup.validateProvider({ kind: 'search', provider: 'exa' }))
      .resolves.toEqual({ kind: 'refused', message: '' })
    await expect(operations.webSetup.applySetup({ search: { provider: null } }))
      .resolves.toEqual({ kind: 'refused', message: '' })
  })

  it('passes the status projection through and reports a refused read', async () => {
    const status: WebSetupStatus = {
      searchProvider: 'exa',
      fetchProvider: 'http',
      mounted: [
        { kind: 'search', provider: 'exa' },
        { kind: 'fetch', provider: 'http' },
      ],
      credentials: { EXA_API_KEY: { configured: true, writable: true } },
    }
    const operations = createModelsOperations(ctxWith({ status: async () => ({ ok: true, value: status }) }))
    await expect(operations.webSetup.status()).resolves.toEqual({ kind: 'status', status })

    const failed = createModelsOperations(ctxWith({
      status: async () => ({ ok: false, error: { code: 'web-setup/unavailable', message: 'offline', details: {} } }),
    }))
    await expect(failed.webSetup.status()).resolves.toEqual({ kind: 'refused', message: 'offline' })
  })

  it('maps the canary value into validated, invalid, or refused', async () => {
    const run = async (result: object) =>
      createModelsOperations(ctxWith({ validateProvider: async () => result }))
        .webSetup.validateProvider({ kind: 'search', provider: 'exa' })

    await expect(run({ ok: true, value: { ok: true, status: 200, latencyMs: 5, sourcesCount: 3 } }))
      .resolves.toEqual({ kind: 'validated', latencyMs: 5 })
    await expect(run({ ok: true, value: { ok: true } })).resolves.toEqual({ kind: 'validated', latencyMs: 0 })
    await expect(run({ ok: true, value: { ok: false, error: 'bad key' } }))
      .resolves.toEqual({ kind: 'invalid', reason: 'bad key' })
    await expect(run({ ok: true, value: { ok: false } })).resolves.toEqual({ kind: 'invalid', reason: '' })
    await expect(run({ ok: false, error: { code: 'carrier', message: 'transport down', details: {} } }))
      .resolves.toEqual({ kind: 'refused', message: 'transport down' })
  })

  it('maps the apply value, its pending-restart object, and its refusal forms', async () => {
    const run = async (result: object) =>
      createModelsOperations(ctxWith({ applySetup: async () => result }))
        .webSetup.applySetup({ search: { provider: 'exa' } })

    await expect(run({ ok: true, value: { ok: true, applied: ['row:web-search-exa'] } }))
      .resolves.toEqual({ kind: 'applied', applied: ['row:web-search-exa'], pendingRestart: null })
    await expect(run({ ok: true, value: { ok: false, applied: ['credentials:EXA_API_KEY'], error: 'row refused' } }))
      .resolves.toEqual({ kind: 'refused', message: 'row refused' })
    await expect(run({ ok: true, value: { ok: false, applied: [] } }))
      .resolves.toEqual({ kind: 'refused', message: '' })
    // The host reports a failed hot apply as ok:false with pendingRestart: the
    // wizard treats it as accepted-but-latent and carries the host diagnostic.
    await expect(run({
      ok: true,
      value: { ok: false, applied: ['web.searchProvider'], pendingRestart: { ns: 'web', message: 'restart' } },
    })).resolves.toEqual({
      kind: 'applied',
      applied: ['web.searchProvider'],
      pendingRestart: { ns: 'web', message: 'restart' },
    })
    await expect(run({ ok: false, error: { code: 'carrier', message: 'transport down', details: {} } }))
      .resolves.toEqual({ kind: 'refused', message: 'transport down' })
  })
})
