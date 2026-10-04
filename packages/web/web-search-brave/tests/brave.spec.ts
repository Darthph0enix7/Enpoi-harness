import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_MAX_COUNT,
  BRAVE_PROVIDER_ID,
  WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE,
  BraveSearchProvider,
} from '@deepseek-ai/dsh-web-search-brave'
import type { BraveSearchProviderOptions } from '@deepseek-ai/dsh-web-search-brave'
import * as bravePlugin from '@deepseek-ai/dsh-web-search-brave'
import { mapBraveResponse, mapBraveResult } from '../src/provider.ts'

const baseOptions: BraveSearchProviderOptions = {
  apiKey: 'brave-key',
  baseURL: 'https://api.brave.test',
  count: BRAVE_DEFAULT_COUNT,
}

/** A provider whose options snapshot is fixed for the test. */
function provider(overrides: Partial<BraveSearchProviderOptions> = {}): BraveSearchProvider {
  return new BraveSearchProvider(() => ({ ...baseOptions, ...overrides }))
}

/** A provider with no literal key and no resolver: a call must fail on the credential. */
function keyless(overrides: Partial<BraveSearchProviderOptions> = {}): BraveSearchProvider {
  const { apiKey: _apiKey, ...rest } = { ...baseOptions, ...overrides }
  return new BraveSearchProvider(() => rest)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The URL, init, headers and query parameters of one fetch call. */
function requestAt(fetchMock: Mock, index = 0): {
  url: string
  init: RequestInit
  headers: Record<string, string>
  params: URLSearchParams
} {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit]
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    params: new URL(url).searchParams,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave result mapping', () => {
  it('maps a full result entry with an ISO page_age', () => {
    expect(mapBraveResult({
      url: 'https://a.test',
      title: 'A',
      description: 'salient sentence',
      page_age: '2026-01-01T00:00:00.000Z',
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'salient sentence',
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('normalizes a date-only page_age to an ISO instant', () => {
    expect(mapBraveResult({ url: 'https://a.test', page_age: '2026-01-01' }))
      .toEqual({ url: 'https://a.test', publishedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('drops relative or unparseable page_age text instead of lying about the type', () => {
    expect(mapBraveResult({ url: 'https://a.test', page_age: '2 days ago' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test', page_age: 'not a date' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('drops blank, null and absent page_age values', () => {
    expect(mapBraveResult({ url: 'https://a.test', page_age: '   ' })).toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test', page_age: null })).toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('omits null/empty titles and keeps URL-only sources without a description', () => {
    expect(mapBraveResult({ url: 'https://a.test', title: null, description: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test', title: '', description: '' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapBraveResult({ url: 'https://a.test', description: '   ' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('trims the description used as the snippet', () => {
    expect(mapBraveResult({ url: 'https://a.test', description: '  page body  ' }))
      .toEqual({ url: 'https://a.test', snippet: 'page body' })
  })

  it('maps a response and tolerates a missing web or results array', () => {
    expect(mapBraveResponse({
      web: { results: [{ url: 'https://a.test', description: 'one' }, { url: 'https://b.test' }] },
    })).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
    expect(mapBraveResponse({}).sources).toEqual([])
    expect(mapBraveResponse({ web: null }).sources).toEqual([])
    expect(mapBraveResponse({ web: {} }).sources).toEqual([])
  })
})

describe('BraveSearchProvider availability', () => {
  it('is unavailable without a key and without a resolver', () => {
    expect(keyless().available()).toBe(false)
  })

  it('is available with a literal key', () => {
    expect(provider().available()).toBe(true)
  })

  it('proves only that a resolver is registered, not that it holds a key', () => {
    expect(provider({ apiKey: '', resolveApiKey: async () => undefined }).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when count is not a positive integer', () => {
    expect(provider({ count: 0 }).available()).toBe(false)
    expect(provider({ count: 1.5 }).available()).toBe(false)
  })
})

describe('BraveSearchProvider request mapping', () => {
  it('sends a GET with the query, default count and subscription-token auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [{ url: 'https://a.test', description: 'hi' }] } }))
    vi.stubGlobal('fetch', fetchMock)

    await provider().search({ query: 'hello world' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, headers, params } = requestAt(fetchMock)
    expect(url).toBe('https://api.brave.test/res/v1/web/search?q=hello+world&count=10')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(headers['x-subscription-token']).toBe('brave-key')
    expect(headers['accept']).toBe('application/json')
    expect(params.get('q')).toBe('hello world')
    expect(params.get('count')).toBe('10')
  })

  it('lets a request maxResults win over the configured count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ count: 7 }).search({ query: 'q', maxResults: 2 })
    expect(requestAt(fetchMock).params.get('count')).toBe('2')
  })

  it('clamps a request above Brave\'s ceiling to 20', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q', maxResults: 50 })
    expect(requestAt(fetchMock).params.get('count')).toBe(String(BRAVE_MAX_COUNT))
  })

  it('forwards freshness, country and search language when configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ freshness: 'pw', country: 'DE', searchLang: 'de' }).search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.get('freshness')).toBe('pw')
    expect(params.get('country')).toBe('DE')
    expect(params.get('search_lang')).toBe('de')
  })

  it('omits freshness, country and search language when unset', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.has('freshness')).toBe(false)
    expect(params.has('country')).toBe(false)
    expect(params.has('search_lang')).toBe(false)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().search({ query: 'q' }, controller.signal)
    expect(requestAt(fetchMock).init.signal).toBe(controller.signal)
  })
})

describe('BraveSearchProvider credentials', () => {
  it('uses the literal key without consulting the resolver', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ resolveApiKey }).search({ query: 'q' })
    expect(requestAt(fetchMock).headers['x-subscription-token']).toBe('brave-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('fails at call time with an actionable credential error naming the ref', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    let caught: unknown
    try {
      await keyless().search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/no API key for "BRAVE_API_KEY"/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats an empty resolved credential as missing', async () => {
    await expect(provider({ apiKey: '', resolveApiKey: async () => '' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
  })

  it('maps a credential resolution failure to WEB_PROVIDER_ERROR', async () => {
    let caught: unknown
    try {
      await keyless({ resolveApiKey: () => Promise.reject(new Error('vault offline')) }).search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/vault offline/)
  })

  it('maps an abort during credential resolution to WEB_ABORTED', async () => {
    await expect(keyless({ resolveApiKey: () => Promise.reject(new DOMException('aborted', 'AbortError')) }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('BraveSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { detail: 'bad key' } }, { status: 401 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('falls back to a top-level message when the error envelope has no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'rate limited' }, { status: 429 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Brave API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Brave API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a timeout-shaped rejection to WEB_PROVIDER_ERROR, not WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: {} } }, { status: 200 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-brave plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bravePlugin).toBe(false)
  })

  it('threads count, freshness, country and search language into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, {
      apiKey: 'brave-key',
      count: 5,
      freshness: 'pm',
      country: 'US',
      searchLang: 'en',
    })
    await ctx.web.search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.get('count')).toBe('5')
    expect(params.get('freshness')).toBe('pm')
    expect(params.get('country')).toBe('US')
    expect(params.get('search_lang')).toBe('en')
    await fiber.dispose()
  })

  it('falls back to $BRAVE_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      const fiber = await ctx.plugin(bravePlugin, { apiKey: '' })
      await ctx.web.search({ query: 'q' })
      const { url, headers, params } = requestAt(fetchMock)
      expect(url.startsWith(`${BRAVE_DEFAULT_BASE_URL}/res/v1/web/search?`)).toBe(true)
      expect(headers['x-subscription-token']).toBe('env-key')
      expect(params.get('count')).toBe(String(BRAVE_DEFAULT_COUNT))
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = prev
    }
  })

  it('treats an empty launch-environment value as no key', async () => {
    const prev = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = ''
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      await ctx.plugin(bravePlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = prev
    }
  })

  it('stays selected with no key and fails at call time naming the ref', async () => {
    const prev = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      await ctx.plugin(bravePlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.BRAVE_API_KEY = prev
    }
  })

  it('names the configured credential reference when no key resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    await ctx.plugin(bravePlugin, { apiKeyEnv: 'MY_BRAVE_KEY' })
    let caught: unknown
    try {
      await ctx.web.search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toContain('"MY_BRAVE_KEY"')
  })

  it('resolves the vault credential per search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    let current = 'stored-key'
    const resolve = vi.fn(async (_ref: string) => ({ value: current }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      ctx.provide('credentials', { resolve } as never)
      await ctx.plugin(bravePlugin, {})

      await ctx.web.search({ query: 'first' })
      current = 'rotated-key'
      await ctx.web.search({ query: 'second' })

      const auth = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['x-subscription-token'])
      expect(auth).toEqual(['stored-key', 'rotated-key'])
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['BRAVE_API_KEY', 'BRAVE_API_KEY'])
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = previous
    }
  })
})

describe('web-search-brave settings description', () => {
  it('describes the namespace with every option volatile and the key secret redacted', () => {
    expect(WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE).toBe('web-search-brave')
    const fields = [
      'apiKey', 'apiKeyEnv', 'baseURL', 'count', 'freshness', 'country', 'searchLang',
    ] as const
    for (const field of fields) {
      expect(bravePlugin.Config.dict![field]!.meta.volatile, field).toBe(true)
    }
    expect(bravePlugin.Config.dict!.apiKey!.meta).toMatchObject({ role: 'secret' })
    expect(bravePlugin.Config.dict!.apiKeyEnv!.meta).toMatchObject({ role: 'credential-ref', default: 'BRAVE_API_KEY' })
    expect(bravePlugin.Config.dict!.count!.meta).toMatchObject({ default: BRAVE_DEFAULT_COUNT })

    const described = redactSecrets(bravePlugin.Config as z<never>, {
      apiKey: 'sk-secret',
      apiKeyEnv: 'BRAVE_API_KEY',
      count: 10,
    })
    expect(described.value).not.toHaveProperty('apiKey')
    expect(described.value).toMatchObject({ apiKeyEnv: 'BRAVE_API_KEY', count: 10 })
    expect(described.secrets).toEqual([{ path: ['apiKey'], set: true }])
  })
})
