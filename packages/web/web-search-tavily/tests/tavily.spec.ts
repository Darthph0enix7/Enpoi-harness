import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_MAX_RESULTS,
  TAVILY_PROVIDER_ID,
  WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE,
  TavilySearchProvider,
} from '@deepseek-ai/dsh-web-search-tavily'
import type { TavilySearchProviderOptions } from '@deepseek-ai/dsh-web-search-tavily'
import * as tavilyPlugin from '@deepseek-ai/dsh-web-search-tavily'
import { mapTavilyResponse, mapTavilyResult } from '../src/provider.ts'

const baseOptions: TavilySearchProviderOptions = {
  apiKey: 'tavily-key',
  baseURL: 'https://api.tavily.test',
  searchDepth: TAVILY_DEFAULT_SEARCH_DEPTH,
}

/** A provider whose options snapshot is fixed for the test. */
function provider(overrides: Partial<TavilySearchProviderOptions> = {}): TavilySearchProvider {
  return new TavilySearchProvider(() => ({ ...baseOptions, ...overrides }))
}

/** A provider with no literal key and no resolver: a call must fail on the credential. */
function keyless(overrides: Partial<TavilySearchProviderOptions> = {}): TavilySearchProvider {
  const { apiKey: _apiKey, ...rest } = { ...baseOptions, ...overrides }
  return new TavilySearchProvider(() => rest)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The URL, init, headers and parsed JSON body of one fetch call. */
function requestAt(fetchMock: Mock, index = 0): {
  url: string
  init: RequestInit
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit]
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tavily result mapping', () => {
  it('maps a full result entry and normalizes an RFC 1123 published_date to ISO', () => {
    expect(mapTavilyResult({
      url: 'https://a.test',
      title: 'A',
      content: 'salient sentence',
      score: 0.8,
      published_date: 'Tue, 11 Mar 2025 17:00:00 GMT',
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'salient sentence',
      publishedAt: '2025-03-11T17:00:00.000Z',
    })
  })

  it('normalizes a date-only published_date to an ISO instant', () => {
    expect(mapTavilyResult({ url: 'https://a.test', published_date: '2025-03-11' }))
      .toEqual({ url: 'https://a.test', publishedAt: '2025-03-11T00:00:00.000Z' })
  })

  it('drops unparseable, blank, null and absent published_date values', () => {
    expect(mapTavilyResult({ url: 'https://a.test', published_date: 'not a date' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', published_date: '   ' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', published_date: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('omits null/empty titles and keeps URL-only sources without content', () => {
    expect(mapTavilyResult({ url: 'https://a.test', title: null, content: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', title: '', content: '' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapTavilyResult({ url: 'https://a.test', content: '   ' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('trims the content used as the snippet', () => {
    expect(mapTavilyResult({ url: 'https://a.test', content: '  page body  ' }))
      .toEqual({ url: 'https://a.test', snippet: 'page body' })
  })

  it('maps a generated answer to content and tolerates a missing results array', () => {
    expect(mapTavilyResponse({
      answer: 'generated answer',
      results: [{ url: 'https://a.test', content: 'one' }, { url: 'https://b.test' }],
    })).toEqual({
      content: 'generated answer',
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
    expect(mapTavilyResponse({}).sources).toEqual([])
    expect(mapTavilyResponse({}).content).toBeUndefined()
  })

  it('omits content for an empty or null answer', () => {
    expect(mapTavilyResponse({ answer: '' }).content).toBeUndefined()
    expect(mapTavilyResponse({ answer: null }).content).toBeUndefined()
  })
})

describe('TavilySearchProvider availability', () => {
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

  it('is misconfigured when maxResults is set but not a positive integer', () => {
    expect(provider({ maxResults: 0 }).available()).toBe(false)
    expect(provider({ maxResults: 1.5 }).available()).toBe(false)
  })

  it('is available when maxResults is unset', () => {
    expect(provider({}).available()).toBe(true)
  })
})

describe('TavilySearchProvider request mapping', () => {
  it('sends a POST with the query, default depth and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider().search({ query: 'hello' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, headers, body } = requestAt(fetchMock)
    expect(url).toBe('https://api.tavily.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(headers['authorization']).toBe('Bearer tavily-key')
    expect(headers['content-type']).toBe('application/json')
    expect(body).toEqual({ query: 'hello', search_depth: 'basic' })
  })

  it('sends the configured advanced depth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ searchDepth: 'advanced' }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({ search_depth: 'advanced' })
  })

  it('lets a request maxResults win over the configured default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ maxResults: 7 }).search({ query: 'q', maxResults: 2 })
    expect(requestAt(fetchMock).body).toMatchObject({ max_results: 2 })
  })

  it('falls back to the configured maxResults when a request omits it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ maxResults: 7 }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({ max_results: 7 })
  })

  it('omits max_results when neither the request nor the config sets one', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    expect(requestAt(fetchMock).body).not.toHaveProperty('max_results')
  })

  it('clamps a request above Tavily\'s ceiling to 20', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q', maxResults: 50 })
    expect(requestAt(fetchMock).body).toMatchObject({ max_results: TAVILY_MAX_RESULTS })
  })

  it('forwards include_answer, time_range and topic when configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ includeAnswer: 'advanced', timeRange: 'week', topic: 'news' }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({
      include_answer: 'advanced',
      time_range: 'week',
      topic: 'news',
    })
  })

  it('forwards the boolean include_answer form', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ includeAnswer: true }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({ include_answer: true })
  })

  it('omits include_answer, time_range and topic when unset', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    const { body } = requestAt(fetchMock)
    expect(body).not.toHaveProperty('include_answer')
    expect(body).not.toHaveProperty('time_range')
    expect(body).not.toHaveProperty('topic')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().search({ query: 'q' }, controller.signal)
    expect(requestAt(fetchMock).init.signal).toBe(controller.signal)
  })
})

describe('TavilySearchProvider credentials', () => {
  it('uses the literal key without consulting the resolver', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ resolveApiKey }).search({ query: 'q' })
    expect(requestAt(fetchMock).headers['authorization']).toBe('Bearer tavily-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('fails at call time with an actionable credential error naming the ref', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    let caught: unknown
    try {
      await keyless().search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/no API key for "TAVILY_API_KEY"/)
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

describe('TavilySearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the nested detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, { status: 401 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Unauthorized: missing or invalid API key.' }))
  })

  it('reads a string detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'rate limited' }, { status: 429 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('falls back to a top-level error or message when detail carries no text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: { status: 400 }, error: 'top-level error' }, { status: 400 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'top-level error' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'top-level message' }, { status: 400 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'top-level message' }))
  })

  it('keeps the status-line message for an array detail or an empty envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: [{ msg: 'Input should be a valid string' }] }, { status: 422 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 422)' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Tavily API error (HTTP 500)' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Tavily API error (HTTP 502)' }))
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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
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

describe('web-search-tavily plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, { apiKey: 'tavily-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in tavilyPlugin).toBe(false)
  })

  it('threads depth, maxResults, answer, time range and topic into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    const fiber = await ctx.plugin(tavilyPlugin, {
      apiKey: 'tavily-key',
      searchDepth: 'advanced',
      maxResults: 9,
      includeAnswer: 'basic',
      timeRange: 'month',
      topic: 'finance',
    })
    await ctx.web.search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({
      search_depth: 'advanced',
      max_results: 9,
      include_answer: 'basic',
      time_range: 'month',
      topic: 'finance',
    })
    await fiber.dispose()
  })

  it('falls back to $TAVILY_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      const fiber = await ctx.plugin(tavilyPlugin, { apiKey: '' })
      await ctx.web.search({ query: 'q' })
      const { url, headers, body } = requestAt(fetchMock)
      expect(url).toBe(`${TAVILY_DEFAULT_BASE_URL}/search`)
      expect(headers['authorization']).toBe('Bearer env-key')
      expect(body).toEqual({ query: 'q', search_depth: 'basic' })
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('treats an empty launch-environment value as no key', async () => {
    const prev = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = ''
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = prev
    }
  })

  it('stays selected with no key and fails at call time naming the ref', async () => {
    const prev = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      await ctx.plugin(tavilyPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.TAVILY_API_KEY = prev
    }
  })

  it('names the configured credential reference when no key resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
    await ctx.plugin(tavilyPlugin, { apiKeyEnv: 'MY_TAVILY_KEY' })
    let caught: unknown
    try {
      await ctx.web.search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toContain('"MY_TAVILY_KEY"')
  })

  it('resolves the vault credential per search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    let current = 'stored-key'
    const resolve = vi.fn(async (_ref: string) => ({ value: current }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: TAVILY_PROVIDER_ID })
      ctx.provide('credentials', { resolve } as never)
      await ctx.plugin(tavilyPlugin, {})

      await ctx.web.search({ query: 'first' })
      current = 'rotated-key'
      await ctx.web.search({ query: 'second' })

      const auth = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['authorization'])
      expect(auth).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['TAVILY_API_KEY', 'TAVILY_API_KEY'])
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.TAVILY_API_KEY
      else process.env.TAVILY_API_KEY = previous
    }
  })
})

describe('web-search-tavily settings description', () => {
  it('describes the namespace with every option volatile and the key secret redacted', () => {
    expect(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE).toBe('web-search-tavily')
    const fields = [
      'apiKey', 'apiKeyEnv', 'baseURL', 'searchDepth', 'maxResults', 'includeAnswer', 'timeRange', 'topic',
    ] as const
    for (const field of fields) {
      expect(tavilyPlugin.Config.dict![field]!.meta.volatile, field).toBe(true)
    }
    expect(tavilyPlugin.Config.dict!.apiKey!.meta).toMatchObject({ role: 'secret' })
    expect(tavilyPlugin.Config.dict!.apiKeyEnv!.meta).toMatchObject({ role: 'credential-ref', default: 'TAVILY_API_KEY' })
    expect(tavilyPlugin.Config.dict!.searchDepth!.meta).toMatchObject({ default: TAVILY_DEFAULT_SEARCH_DEPTH })

    const described = redactSecrets(tavilyPlugin.Config as z<never>, {
      apiKey: 'sk-secret',
      apiKeyEnv: 'TAVILY_API_KEY',
      searchDepth: 'basic',
    })
    expect(described.value).not.toHaveProperty('apiKey')
    expect(described.value).toMatchObject({ apiKeyEnv: 'TAVILY_API_KEY', searchDepth: 'basic' })
    expect(described.secrets).toEqual([{ path: ['apiKey'], set: true }])
  })
})
