import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  EXA_PROVIDER_ID,
  EXA_TEXT_FALLBACK_MAX_CHARS,
  WEB_SEARCH_EXA_SETTINGS_NAMESPACE,
  ExaSearchProvider,
} from '@deepseek-ai/dsh-web-search-exa'
import type { ExaSearchProviderOptions } from '@deepseek-ai/dsh-web-search-exa'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { mapExaResponse, mapExaResult } from '../src/provider.ts'

const baseOptions: ExaSearchProviderOptions = {
  apiKey: 'exa-key',
  baseURL: 'https://api.exa.test',
  searchType: 'auto',
  highlightsPerResult: 1,
}

/** A provider whose options snapshot is fixed for the test. */
function provider(overrides: Partial<ExaSearchProviderOptions> = {}): ExaSearchProvider {
  return new ExaSearchProvider(() => ({ ...baseOptions, ...overrides }))
}

/** A provider with no literal key and no resolver: a call must fail on the credential. */
function keyless(overrides: Partial<ExaSearchProviderOptions> = {}): ExaSearchProvider {
  const { apiKey: _apiKey, ...rest } = { ...baseOptions, ...overrides }
  return new ExaSearchProvider(() => rest)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The URL, init and parsed JSON body of one fetch call. */
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

describe('Exa result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapExaResult({
      url: 'https://a.test',
      title: 'A',
      publishedDate: '2026-01-01',
      highlights: ['salient sentence', 'second'],
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable highlight when text fallback is off', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: [] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', highlights: ['  '] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', text: 'page body' })).toBeUndefined()
  })

  it('falls back to a leading text excerpt when highlights are missing and text was requested', () => {
    expect(mapExaResult({ url: 'https://a.test', text: '  page body  ' }, true))
      .toEqual({ url: 'https://a.test', snippet: 'page body' })
  })

  it('prefers highlights over text and falls back when every highlight is blank', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: ['salient'], text: 'page body' }, true))
      .toEqual({ url: 'https://a.test', snippet: 'salient' })
    expect(mapExaResult({ url: 'https://a.test', highlights: [' '], text: 'page body' }, true))
      .toEqual({ url: 'https://a.test', snippet: 'page body' })
  })

  it('bounds the fallback excerpt and drops blank text', () => {
    const long = 'x'.repeat(EXA_TEXT_FALLBACK_MAX_CHARS + 100)
    expect(mapExaResult({ url: 'https://a.test', text: long }, true)?.snippet)
      .toBe('x'.repeat(EXA_TEXT_FALLBACK_MAX_CHARS))
    expect(mapExaResult({ url: 'https://a.test', text: '   ' }, true)).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', text: null }, true)).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapExaResult({ url: 'https://a.test', title: null, publishedDate: null, highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapExaResult({ url: 'https://a.test', title: '', publishedDate: '', highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response with the requested text fallback and filters sources', () => {
    const result = mapExaResponse({
      results: [
        { url: 'https://a.test', highlights: ['one'] },
        { url: 'https://b.test', text: 'page body' },
        { url: 'https://c.test' },
      ],
    }, true)
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test', snippet: 'page body' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('keeps dropping highlight-less entries when text was not requested', () => {
    expect(mapExaResponse({ results: [{ url: 'https://b.test', text: 'page body' }] }).sources).toEqual([])
  })

  it('tolerates a missing results array', () => {
    expect(mapExaResponse({}).sources).toEqual([])
  })

})

describe('ExaSearchProvider availability', () => {
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

  it('is misconfigured when highlightsPerResult is not a positive integer', () => {
    expect(provider({ highlightsPerResult: 0 }).available()).toBe(false)
    expect(provider({ highlightsPerResult: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(provider({ numResults: -1 }).available()).toBe(false)
  })
})

describe('ExaSearchProvider request mapping', () => {
  it('sends the modern boolean highlights form, type, numResults and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', highlights: ['hi'] }] }))
    vi.stubGlobal('fetch', fetchMock)

    await provider({ searchType: 'fast' }).search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, headers, body } = requestAt(fetchMock)
    expect(url).toBe('https://api.exa.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(headers['authorization']).toBe('Bearer exa-key')
    expect(body).toEqual({
      query: 'hello',
      type: 'fast',
      contents: { highlights: true },
      numResults: 5,
    })
  })

  it('sends an explicit highlight count through highlightsPerUrl', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ highlightsPerResult: 3 }).search({ query: 'q' })
    expect(requestAt(fetchMock).body.contents).toEqual({ highlights: { highlightsPerUrl: 3 } })
  })

  it('requests text with a character cap and with defaults when no cap is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ text: { maxCharacters: 800 } }).search({ query: 'capped' })
    await provider({ text: {} }).search({ query: 'uncapped' })
    expect(requestAt(fetchMock, 0).body.contents).toEqual({ highlights: true, text: { maxCharacters: 800 } })
    expect(requestAt(fetchMock, 1).body.contents).toEqual({ highlights: true, text: true })
  })

  it('requests a summary and a live fetch only when enabled', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ summary: true, livecrawl: true }).search({ query: 'fresh' })
    await provider({ summary: false, livecrawl: false }).search({ query: 'cached' })
    expect(requestAt(fetchMock, 0).body.contents).toEqual({ highlights: true, summary: true, maxAgeHours: 0 })
    expect(requestAt(fetchMock, 1).body.contents).toEqual({ highlights: true })
  })

  it('forwards date, category and domain filters', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({
      startPublishedDate: '2025-01-01T00:00:00.000Z',
      endPublishedDate: '2025-12-31T00:00:00.000Z',
      category: 'news',
      includeDomains: ['example.com', '*.docs.example.com'],
      excludeDomains: ['*.spam.test'],
    }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({
      startPublishedDate: '2025-01-01T00:00:00.000Z',
      endPublishedDate: '2025-12-31T00:00:00.000Z',
      category: 'news',
      includeDomains: ['example.com', '*.docs.example.com'],
      excludeDomains: ['*.spam.test'],
    })
  })

  it('omits empty domain filters', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ includeDomains: [], excludeDomains: [] }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).not.toHaveProperty('includeDomains')
    expect(requestAt(fetchMock).body).not.toHaveProperty('excludeDomains')
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ numResults: 7 }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({ numResults: 7 })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ numResults: 7 }).search({ query: 'q', maxResults: 2 })
    expect(requestAt(fetchMock).body).toMatchObject({ numResults: 2 })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider().search({ query: 'q' })
    expect(requestAt(fetchMock).body).not.toHaveProperty('numResults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().search({ query: 'q' }, controller.signal)
    expect(requestAt(fetchMock).init.signal).toBe(controller.signal)
  })
})

describe('ExaSearchProvider filters and credentials', () => {
  it('allows company/people categories when no unsupported filter is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await provider({ category: 'company', excludeDomains: [] }).search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({ category: 'company' })
  })

  it('rejects company/people categories combined with date or exclusion filters before dispatch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    for (const overrides of [
      { category: 'company' as const, startPublishedDate: '2025-01-01T00:00:00.000Z' },
      { category: 'people' as const, endPublishedDate: '2025-12-31T00:00:00.000Z' },
      { category: 'company' as const, excludeDomains: ['example.com'] },
    ]) {
      await expect(provider(overrides).search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the unsupported filters in the category guard message', async () => {
    let caught: unknown
    try {
      await provider({ category: 'people', startPublishedDate: '2025-01-01T00:00:00.000Z' }).search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toMatch(/does not support startPublishedDate/)
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
    expect(caught.message).toMatch(/no API key for "EXA_API_KEY"/)
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

describe('ExaSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(provider().search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 500)' }))
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

describe('web-search-exa plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in exaPlugin).toBe(false)
  })

  it('threads mode, contents and filter config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, {
      apiKey: 'exa-key',
      searchType: 'deep',
      highlightsPerResult: 2,
      numResults: 9,
      startPublishedDate: '2025-01-01T00:00:00.000Z',
      endPublishedDate: '2025-12-31T00:00:00.000Z',
      category: 'news',
      includeDomains: ['example.com'],
      excludeDomains: ['*.spam.test'],
      livecrawl: true,
      text: { maxCharacters: 400 },
      summary: true,
    })
    await ctx.web.search({ query: 'q' })
    expect(requestAt(fetchMock).body).toMatchObject({
      type: 'deep',
      numResults: 9,
      startPublishedDate: '2025-01-01T00:00:00.000Z',
      endPublishedDate: '2025-12-31T00:00:00.000Z',
      category: 'news',
      includeDomains: ['example.com'],
      excludeDomains: ['*.spam.test'],
      contents: {
        highlights: { highlightsPerUrl: 2 },
        text: { maxCharacters: 400 },
        summary: true,
        maxAgeHours: 0,
      },
    })
    await fiber.dispose()
  })

  it('leaves unset options out and keeps the default mode and contents', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    await ctx.web.search({ query: 'q' })
    const { body } = requestAt(fetchMock)
    expect(body).toEqual({ query: 'q', type: 'auto', contents: { highlights: true } })
    await fiber.dispose()
  })

  it('falls back to $EXA_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      const fiber = await ctx.plugin(exaPlugin, { apiKey: '' })
      await ctx.web.search({ query: 'q' })
      const { url, headers } = requestAt(fetchMock)
      expect(url).toBe('https://api.exa.ai/search')
      expect(headers['authorization']).toBe('Bearer env-key')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = prev
    }
  })

  it('stays selected with no key and fails at call time naming the ref', async () => {
    const prev = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(exaPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.EXA_API_KEY = prev
    }
  })

  it('names the configured credential reference when no key resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    await ctx.plugin(exaPlugin, { apiKeyEnv: 'MY_EXA_KEY' })
    let caught: unknown
    try {
      await ctx.web.search({ query: 'q' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
    if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
    expect(caught.message).toContain('"MY_EXA_KEY"')
  })

  it('resolves the vault credential per search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    let current = 'stored-key'
    const resolve = vi.fn(async (_ref: string) => ({ value: current }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      ctx.provide('credentials', { resolve } as never)
      await ctx.plugin(exaPlugin, {})

      await ctx.web.search({ query: 'first' })
      current = 'rotated-key'
      await ctx.web.search({ query: 'second' })

      const auth = fetchMock.mock.calls.map(([, init]) => ((init as RequestInit).headers as Record<string, string>)['authorization'])
      expect(auth).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['EXA_API_KEY', 'EXA_API_KEY'])
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = previous
    }
  })
})

describe('web-search-exa settings description', () => {
  it('describes the namespace with every option volatile and the key secret redacted', () => {
    expect(WEB_SEARCH_EXA_SETTINGS_NAMESPACE).toBe('web-search-exa')
    const fields = [
      'apiKey', 'apiKeyEnv', 'baseURL', 'searchType', 'numResults', 'highlightsPerResult',
      'startPublishedDate', 'endPublishedDate', 'category', 'includeDomains', 'excludeDomains',
      'livecrawl', 'text', 'summary',
    ] as const
    for (const field of fields) {
      expect(exaPlugin.Config.dict![field]!.meta.volatile, field).toBe(true)
    }
    expect(exaPlugin.Config.dict!.apiKey!.meta).toMatchObject({ role: 'secret' })
    expect(exaPlugin.Config.dict!.apiKeyEnv!.meta).toMatchObject({ role: 'credential-ref', default: 'EXA_API_KEY' })

    const described = redactSecrets(exaPlugin.Config as z<never>, {
      apiKey: 'sk-secret',
      apiKeyEnv: 'EXA_API_KEY',
      searchType: 'auto',
      highlightsPerResult: 1,
      includeDomains: [],
    })
    expect(described.value).not.toHaveProperty('apiKey')
    expect(described.value).toMatchObject({ apiKeyEnv: 'EXA_API_KEY', searchType: 'auto' })
    expect(described.secrets).toEqual([{ path: ['apiKey'], set: true }])
  })
})
