import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  SEARXNG_PROVIDER_ID,
  WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE,
  SearxngSearchProvider,
} from '@deepseek-ai/dsh-web-search-searxng'
import type { SearxngSearchProviderOptions } from '@deepseek-ai/dsh-web-search-searxng'
import * as searxngPlugin from '@deepseek-ai/dsh-web-search-searxng'
import { mapSearxngResponse, mapSearxngResult } from '../src/provider.ts'

const baseOptions: SearxngSearchProviderOptions = {
  baseURL: 'https://searx.test',
}

/** A provider whose options snapshot is fixed for the test. */
function provider(overrides: Partial<SearxngSearchProviderOptions> = {}): SearxngSearchProvider {
  return new SearxngSearchProvider(() => ({ ...baseOptions, ...overrides }))
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The URL, init, headers and query parameters of one fetch call. */
function requestAt(fetchMock: Mock, index = 0): {
  url: string
  init: RequestInit
  header: (name: string) => string | null
  params: URLSearchParams
} {
  const [input, init = {}] = fetchMock.mock.calls[index] as [RequestInfo | URL, RequestInit?]
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init.headers)
  return { url, init, header: name => headers.get(name), params: new URL(url).searchParams }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SearXNG result mapping', () => {
  it('maps a full result entry with an ISO publishedDate', () => {
    expect(mapSearxngResult({
      url: 'https://a.test',
      title: 'A',
      content: 'salient sentence',
      publishedDate: '2026-01-01T00:00:00.000Z',
    })).toEqual({
      url: 'https://a.test',
      title: 'A',
      snippet: 'salient sentence',
      publishedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('normalizes a date-only publishedDate to an ISO instant', () => {
    expect(mapSearxngResult({ url: 'https://a.test', publishedDate: '2026-01-01' }))
      .toEqual({ url: 'https://a.test', publishedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('drops relative or unparseable publishedDate text instead of lying about the type', () => {
    expect(mapSearxngResult({ url: 'https://a.test', publishedDate: '2 days ago' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', publishedDate: 'not a date' }))
      .toEqual({ url: 'https://a.test' })
  })

  it('drops blank, null and absent publishedDate values', () => {
    expect(mapSearxngResult({ url: 'https://a.test', publishedDate: '   ' })).toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', publishedDate: null })).toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('omits null/empty titles and keeps URL-only sources without content', () => {
    expect(mapSearxngResult({ url: 'https://a.test', title: null, content: null }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', title: '', content: '' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test', content: '   ' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapSearxngResult({ url: 'https://a.test' })).toEqual({ url: 'https://a.test' })
  })

  it('trims the content used as the snippet', () => {
    expect(mapSearxngResult({ url: 'https://a.test', content: '  page body  ' }))
      .toEqual({ url: 'https://a.test', snippet: 'page body' })
  })

  it('maps a response and tolerates a missing results array', () => {
    expect(mapSearxngResponse({
      results: [{ url: 'https://a.test', content: 'one' }, { url: 'https://b.test' }],
    })).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
    expect(mapSearxngResponse({}).sources).toEqual([])
  })
})

describe('SearxngSearchProvider availability', () => {
  it('is available for parseable http and https instance bases', () => {
    expect(provider().available()).toBe(true)
    expect(provider({ baseURL: 'http://searx.local:8080' }).available()).toBe(true)
  })

  it('is unavailable when the base URL is unparseable', () => {
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
    expect(provider({ baseURL: '' }).available()).toBe(false)
  })

  it('is unavailable for a non-http scheme', () => {
    expect(provider({ baseURL: 'ftp://searx.test' }).available()).toBe(false)
  })
})

describe('SearxngSearchProvider request mapping', () => {
  it('sends a keyless GET with the query and JSON format only', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', content: 'hi' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider().search({ query: 'hello world' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, header, params } = requestAt(fetchMock)
    expect(url).toBe('https://searx.test/search?q=hello+world&format=json')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(header('accept')).toBe('application/json')
    expect(header('authorization')).toBeNull()
    expect(params.get('q')).toBe('hello world')
    expect(params.get('format')).toBe('json')
    expect([...params.keys()].sort()).toEqual(['format', 'q'])
  })

  it('forwards categories, language, time range, engines and safesearch when configured', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({
      categories: 'general,news',
      language: 'de-DE',
      timeRange: 'week',
      engines: ['google', 'bing'],
      safesearch: 0,
    }).search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.get('categories')).toBe('general,news')
    expect(params.get('language')).toBe('de-DE')
    expect(params.get('time_range')).toBe('week')
    expect(params.get('engines')).toBe('google,bing')
    expect(params.get('safesearch')).toBe('0')
  })

  it('omits every filter parameter when unset', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.has('categories')).toBe(false)
    expect(params.has('language')).toBe(false)
    expect(params.has('time_range')).toBe(false)
    expect(params.has('engines')).toBe(false)
    expect(params.has('safesearch')).toBe(false)
  })

  it('omits an empty engines list rather than sending a blank parameter', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ engines: [] }).search({ query: 'q' })
    expect(requestAt(fetchMock).params.has('engines')).toBe(false)
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().search({ query: 'q' }, controller.signal)
    expect(requestAt(fetchMock).init.signal).toBe(controller.signal)
  })

  it('does not send a result-count parameter; the seam enforces maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test' }] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q', maxResults: 1 })
    const { params } = requestAt(fetchMock)
    expect([...params.keys()].sort()).toEqual(['format', 'q'])
  })
})

describe('SearxngSearchProvider error handling', () => {
  it('names the JSON-format refusal trap on a non-JSON 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>403 Forbidden</html>', { status: 403 })))
    let caught: unknown
    try {
      await provider().search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/JSON output format/)
    expect(caught.message).toMatch(/HTTP 403/)
  })

  it('keeps the JSON-format trap and appends a JSON error detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'format disabled' }, { status: 403 })))
    let caught: unknown
    try {
      await provider().search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/JSON output format/)
    expect(caught.message).toMatch(/format disabled/)
  })

  it('uses the provider error detail on other HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad query' }, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad query' }))
  })

  it('falls back to the message field when the error envelope has no error field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'instance offline' }, { status: 503 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'instance offline' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'SearXNG API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'SearXNG API error (HTTP 500)' }))
  })

  it('uses the provider error detail on 401 and 429 refusals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized instance' }, { status: 401 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'unauthorized instance' }))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'too many requests' }, { status: 429 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'too many requests' }))
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
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const response = new Response('{}', { status: 500 })
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-searxng plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, { baseURL: 'https://searx.test' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in searxngPlugin).toBe(false)
  })

  it('threads every filter into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    const fiber = await ctx.plugin(searxngPlugin, {
      baseURL: 'https://searx.test',
      categories: 'news',
      language: 'en-US',
      timeRange: 'month',
      engines: ['duckduckgo'],
      safesearch: 2,
    })
    await ctx.web.search({ query: 'q' })
    const { params } = requestAt(fetchMock)
    expect(params.get('categories')).toBe('news')
    expect(params.get('language')).toBe('en-US')
    expect(params.get('time_range')).toBe('month')
    expect(params.get('engines')).toBe('duckduckgo')
    expect(params.get('safesearch')).toBe('2')
    await fiber.dispose()
  })

  it('rejects a load without the required baseURL', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    let caught: unknown
    try {
      await ctx.plugin(searxngPlugin, {})
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error('plugin load did not reject')
    expect(caught.message).toMatch(/missing required value/)
  })

  it('stays selected with an unparseable baseURL and reports no usable provider', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    await ctx.plugin(searxngPlugin, { baseURL: 'not a url' })
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('does not resolve a credential: the search is keyless', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const resolve = vi.fn(async () => ({ value: 'unused-key' }))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: SEARXNG_PROVIDER_ID })
    ctx.provide('credentials', { resolve } as never)
    await ctx.plugin(searxngPlugin, { baseURL: 'https://searx.test' })
    await ctx.web.search({ query: 'q' })
    expect(resolve).not.toHaveBeenCalled()
    expect(requestAt(fetchMock).header('authorization')).toBeNull()
  })
})

describe('web-search-searxng settings description', () => {
  it('describes the namespace with every option volatile and a required baseURL', () => {
    expect(WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE).toBe('web-search-searxng')
    const fields = ['baseURL', 'categories', 'language', 'timeRange', 'engines', 'safesearch'] as const
    for (const field of fields) {
      expect(searxngPlugin.Config.dict![field]!.meta.volatile, field).toBe(true)
    }
    expect(searxngPlugin.Config.dict!.baseURL!.meta).toMatchObject({ required: true })
  })
})
