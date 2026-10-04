import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  JINA_DEFAULT_BASE_URL,
  JINA_MAX_URL_LENGTH,
  JINA_PROVIDER_ID,
  WEB_FETCH_JINA_SETTINGS_NAMESPACE,
  JinaFetchProvider,
} from '@deepseek-ai/dsh-web-fetch-jina'
import type { JinaFetchProviderOptions } from '@deepseek-ai/dsh-web-fetch-jina'
import * as jinaPlugin from '@deepseek-ai/dsh-web-fetch-jina'
import { validateJinaUrl } from '../src/provider.ts'

const baseOptions: JinaFetchProviderOptions = {
  baseURL: 'https://r.jina.test',
}

/** A provider whose options snapshot is fixed for the test. */
function provider(overrides: Partial<JinaFetchProviderOptions> = {}): JinaFetchProvider {
  return new JinaFetchProvider(() => ({ ...baseOptions, ...overrides }))
}

function textResponse(body = 'Title: Example\n\nMarkdown Content:\nhello', init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' }, ...init })
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** The URL, init, headers and abort signal of one fetch call. */
function requestAt(fetchMock: Mock, index = 0): {
  url: string
  init: RequestInit
  header: (name: string) => string | null
} {
  const [input, init = {}] = fetchMock.mock.calls[index] as [RequestInfo | URL, RequestInit?]
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init.headers)
  return { url, init, header: name => headers.get(name) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validateJinaUrl', () => {
  it('accepts and canonicalizes http and https targets', () => {
    expect(validateJinaUrl('https://example.com')).toBe('https://example.com/')
    expect(validateJinaUrl('http://example.com/a?b=c')).toBe('http://example.com/a?b=c')
  })

  it('rejects an unparseable target with WEB_INVALID_URL', () => {
    expect(() => validateJinaUrl('not a url')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects a non-http(s) scheme with WEB_INVALID_URL', () => {
    expect(() => validateJinaUrl('ftp://example.com')).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects a target longer than the shared bound', () => {
    const long = `https://example.com/${'a'.repeat(JINA_MAX_URL_LENGTH)}`
    let caught: unknown
    try {
      validateJinaUrl(long)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_INVALID_URL' })
    if (!(caught instanceof Error)) throw new Error('validateJinaUrl did not throw')
    expect(caught.message).toContain(String(JINA_MAX_URL_LENGTH))
  })
})

describe('JinaFetchProvider availability', () => {
  it('is available keyless for parseable http and https endpoint bases', () => {
    expect(provider().available()).toBe(true)
    expect(provider({ baseURL: 'http://jina.local:8080' }).available()).toBe(true)
  })

  it('is unavailable when the endpoint base is unparseable or not http(s)', () => {
    expect(provider({ baseURL: 'not a url' }).available()).toBe(false)
    expect(provider({ baseURL: '' }).available()).toBe(false)
    expect(provider({ baseURL: 'ftp://r.jina.test' }).available()).toBe(false)
  })
})

describe('JinaFetchProvider request mapping', () => {
  it('prefixes the target onto the endpoint and requests plain text', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider().fetch({ url: 'https://example.com' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const { url, init, header } = requestAt(fetchMock)
    expect(url).toBe('https://r.jina.test/https://example.com/')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(header('accept')).toBe('text/plain')
    expect(header('authorization')).toBeNull()
    expect(header('x-engine')).toBeNull()
    expect(header('x-timeout')).toBeNull()
    expect(header('x-max-tokens')).toBeNull()
    expect(result).toEqual({
      url: 'https://example.com/',
      statusCode: 200,
      body: { kind: 'text', content: 'Title: Example\n\nMarkdown Content:\nhello' },
      truncated: false,
    })
  })

  it('trims one trailing endpoint slash so the target path never doubles it', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await provider({ baseURL: 'https://r.jina.test/' }).fetch({ url: 'https://example.com/x' })
    expect(requestAt(fetchMock).url).toBe('https://r.jina.test/https://example.com/x')
  })

  it('sends the configured engine, timeout and token cap headers', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await provider({ engine: 'direct', timeoutSeconds: 30, maxTokens: 500 }).fetch({ url: 'https://example.com' })
    const { header } = requestAt(fetchMock)
    expect(header('x-engine')).toBe('direct')
    expect(header('x-timeout')).toBe('30')
    expect(header('x-max-tokens')).toBe('500')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider().fetch({ url: 'https://example.com' }, controller.signal)
    expect(requestAt(fetchMock).init.signal).toBe(controller.signal)
  })
})

describe('JinaFetchProvider truncation', () => {
  it('reports no trim when no cap is configured, even with a usage header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('body', { headers: { 'x-usage-tokens': '99999' } })))
    await expect(provider().fetch({ url: 'https://example.com' })).resolves.toMatchObject({ truncated: false })
  })

  it('marks the result truncated when the usage count reaches the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('body', { headers: { 'x-usage-tokens': '500' } })))
    await expect(provider({ maxTokens: 500 }).fetch({ url: 'https://example.com' }))
      .resolves.toMatchObject({ truncated: true })
  })

  it('reports no trim when the usage count stays below the cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('body', { headers: { 'x-usage-tokens': '499' } })))
    await expect(provider({ maxTokens: 500 }).fetch({ url: 'https://example.com' }))
      .resolves.toMatchObject({ truncated: false })
  })

  it('does not claim a trim when the usage header is missing or not a number', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('body')))
    await expect(provider({ maxTokens: 500 }).fetch({ url: 'https://example.com' }))
      .resolves.toMatchObject({ truncated: false })
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('body', { headers: { 'x-usage-tokens': 'many' } })))
    await expect(provider({ maxTokens: 500 }).fetch({ url: 'https://example.com' }))
      .resolves.toMatchObject({ truncated: false })
  })
})

describe('JinaFetchProvider credentials', () => {
  it('uses the literal key without consulting the resolver', async () => {
    const resolveApiKey = vi.fn(async () => 'resolved-key')
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await provider({ apiKey: 'literal-key', resolveApiKey }).fetch({ url: 'https://example.com' })
    expect(requestAt(fetchMock).header('authorization')).toBe('Bearer literal-key')
    expect(resolveApiKey).not.toHaveBeenCalled()
  })

  it('switches to bearer auth when the resolver returns a key', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await provider({ apiKey: '', resolveApiKey: async () => 'resolved-key' }).fetch({ url: 'https://example.com' })
    expect(requestAt(fetchMock).header('authorization')).toBe('Bearer resolved-key')
  })

  it('stays keyless when the resolver returns nothing, an empty key, or is absent', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await provider({ resolveApiKey: async () => undefined }).fetch({ url: 'https://example.com' })
    await provider({ resolveApiKey: async () => '' }).fetch({ url: 'https://example.com' })
    await provider().fetch({ url: 'https://example.com' })
    for (let index = 0; index < 3; index += 1) {
      expect(requestAt(fetchMock, index).header('authorization')).toBeNull()
    }
  })

  it('maps a credential resolution failure to WEB_PROVIDER_ERROR', async () => {
    let caught: unknown
    try {
      await provider({ resolveApiKey: () => Promise.reject(new Error('vault offline')) }).fetch({ url: 'https://example.com' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    if (!(caught instanceof Error)) throw new Error('fetch did not throw an Error')
    expect(caught.message).toMatch(/vault offline/)
  })

  it('maps an abort during credential resolution to WEB_ABORTED', async () => {
    await expect(provider({ resolveApiKey: () => Promise.reject(new DOMException('aborted', 'AbortError')) }).fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('JinaFetchProvider error handling', () => {
  it('uses the provider message from a JSON refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Invalid API key' }, { status: 401 })))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Invalid API key' }))
  })

  it('falls back to readableMessage when the envelope has no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ readableMessage: 'RateLimitedError: too many requests' }, { status: 429 })))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'RateLimitedError: too many requests' }))
  })

  it('keeps the status-line message when the JSON refusal carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 451 })))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Jina Reader error (HTTP 451)' }))
  })

  it('keeps the status-line message when the refusal body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Jina Reader error (HTTP 403)' }))
  })

  it('surfaces an abort during refusal-body parse as WEB_ABORTED', async () => {
    const response = new Response('{}', { status: 500 })
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a timeout-shaped rejection to WEB_PROVIDER_ERROR, not WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an unreadable success body to WEB_PROVIDER_ERROR', async () => {
    const response = new Response('body', { status: 200 })
    vi.spyOn(response, 'text').mockRejectedValue(new TypeError('terminated'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during the success-body read as WEB_ABORTED', async () => {
    const response = new Response('body', { status: 200 })
    vi.spyOn(response, 'text').mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', vi.fn(async () => response))
    await expect(provider().fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('rejects an invalid target before any request', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    await expect(provider().fetch({ url: 'ftp://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('web-fetch-jina plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse()))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
    const fiber = await ctx.plugin(jinaPlugin, {})
    await expect(ctx.web.fetch({ url: 'https://example.com' }))
      .resolves.toMatchObject({ statusCode: 200, body: { kind: 'text' } })
    await fiber.dispose()
    await expect(ctx.web.fetch({ url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in jinaPlugin).toBe(false)
  })

  it('defaults to the public Reader endpoint and threads engine, timeout and cap', async () => {
    const fetchMock = vi.fn(async () => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
    const fiber = await ctx.plugin(jinaPlugin, { engine: 'browser', timeoutSeconds: 20, maxTokens: 1000 })
    await ctx.web.fetch({ url: 'https://example.com' })
    const { url, header } = requestAt(fetchMock)
    expect(url).toBe(`${JINA_DEFAULT_BASE_URL}/https://example.com/`)
    expect(header('x-engine')).toBe('browser')
    expect(header('x-timeout')).toBe('20')
    expect(header('x-max-tokens')).toBe('1000')
    await fiber.dispose()
  })

  it('uses a literal plugin key and treats an empty literal as absent', async () => {
    const previous = process.env.JINA_API_KEY
    delete process.env.JINA_API_KEY
    try {
      const fetchMock = vi.fn(async () => textResponse())
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      const fiber = await ctx.plugin(jinaPlugin, { apiKey: 'literal-key' })
      await ctx.web.fetch({ url: 'https://example.com' })
      expect(requestAt(fetchMock).header('authorization')).toBe('Bearer literal-key')
      await fiber.dispose()

      const keylessMock = vi.fn(async () => textResponse())
      vi.stubGlobal('fetch', keylessMock)
      const keylessCtx = new Context()
      await keylessCtx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      const keylessFiber = await keylessCtx.plugin(jinaPlugin, { apiKey: '' })
      await keylessCtx.web.fetch({ url: 'https://example.com' })
      expect(requestAt(keylessMock).header('authorization')).toBeNull()
      await keylessFiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.JINA_API_KEY
      else process.env.JINA_API_KEY = previous
    }
  })

  it('falls back to $JINA_API_KEY and sends bearer auth when present', async () => {
    const prev = process.env.JINA_API_KEY
    process.env.JINA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => textResponse())
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      await ctx.plugin(jinaPlugin, {})
      await ctx.web.fetch({ url: 'https://example.com' })
      expect(requestAt(fetchMock).header('authorization')).toBe('Bearer env-key')
    } finally {
      if (prev === undefined) delete process.env.JINA_API_KEY
      else process.env.JINA_API_KEY = prev
    }
  })

  it('stays keyless when the launch environment value is empty or absent', async () => {
    const prev = process.env.JINA_API_KEY
    process.env.JINA_API_KEY = ''
    try {
      const fetchMock = vi.fn(async () => textResponse())
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      await ctx.plugin(jinaPlugin, {})
      await ctx.web.fetch({ url: 'https://example.com' })
      expect(requestAt(fetchMock).header('authorization')).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.JINA_API_KEY
      else process.env.JINA_API_KEY = prev
    }
  })

  it('resolves the vault credential per fetch so a stored or rotated key needs no restart', async () => {
    const previous = process.env.JINA_API_KEY
    delete process.env.JINA_API_KEY
    let current = 'stored-key'
    const resolve = vi.fn(async (_ref: string) => ({ value: current }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      ctx.provide('credentials', { resolve } as never)
      await ctx.plugin(jinaPlugin, {})

      await ctx.web.fetch({ url: 'https://example.com' })
      current = 'rotated-key'
      await ctx.web.fetch({ url: 'https://example.com' })

      const auth = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
      expect(auth).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['JINA_API_KEY', 'JINA_API_KEY'])
    } finally {
      await ctx.fiber.dispose()
      if (previous === undefined) delete process.env.JINA_API_KEY
      else process.env.JINA_API_KEY = previous
    }
  })

  it('resolves the configured credential reference through the vault', async () => {
    const previous = process.env.JINA_API_KEY
    delete process.env.JINA_API_KEY
    const resolve = vi.fn(async (_ref: string) => ({ value: 'vault-key' }))
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => textResponse())
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { fetchProvider: JINA_PROVIDER_ID })
      ctx.provide('credentials', { resolve } as never)
      const fiber = await ctx.plugin(jinaPlugin, { apiKeyEnv: 'MY_JINA_KEY' })
      await ctx.web.fetch({ url: 'https://example.com' })
      expect(resolve.mock.calls.map(([ref]) => ref)).toEqual(['MY_JINA_KEY'])
      expect(requestAt(fetchMock).header('authorization')).toBe('Bearer vault-key')
      await fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.JINA_API_KEY
      else process.env.JINA_API_KEY = previous
    }
  })
})

describe('web-fetch-jina settings description', () => {
  it('describes the namespace with every option volatile and the key secret redacted', () => {
    expect(WEB_FETCH_JINA_SETTINGS_NAMESPACE).toBe('web-fetch-jina')
    const fields = ['apiKey', 'apiKeyEnv', 'baseURL', 'engine', 'timeoutSeconds', 'maxTokens'] as const
    for (const field of fields) {
      expect(jinaPlugin.Config.dict![field]!.meta.volatile, field).toBe(true)
    }
    expect(jinaPlugin.Config.dict!.apiKey!.meta).toMatchObject({ role: 'secret' })
    expect(jinaPlugin.Config.dict!.apiKeyEnv!.meta).toMatchObject({ role: 'credential-ref', default: 'JINA_API_KEY' })
    expect(jinaPlugin.Config.dict!.maxTokens!.meta).toMatchObject({ min: 500 })

    const described = redactSecrets(jinaPlugin.Config as z<never>, {
      apiKey: 'jina-secret',
      apiKeyEnv: 'JINA_API_KEY',
      maxTokens: 1000,
    })
    expect(described.value).not.toHaveProperty('apiKey')
    expect(described.value).toMatchObject({ apiKeyEnv: 'JINA_API_KEY', maxTokens: 1000 })
    expect(described.secrets).toEqual([{ path: ['apiKey'], set: true }])
  })
})
