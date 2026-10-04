/**
 * Live canary behavior: per-provider request construction, credential
 * placement, success/failure mapping, timeout, cancellation, and transport
 * failure. External HTTP is the only mocked input; the canary itself runs for
 * real.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { CANARY_TIMEOUT_MS, runHttpCanary } from '../src/canaries.ts'
import { providerSpec } from '../src/catalog.ts'
import type { WebSetupCanary, WebSetupFetch, WebSetupProviderSpec } from '../src/types.ts'

/** Catalog spec by search id; the catalog test owns the table. */
function spec(id: string): WebSetupProviderSpec {
  const found = providerSpec('search', id)
  if (found === undefined) throw new Error(`missing catalog search provider ${id}`)
  return found
}

/** Fetch-kind spec by id. */
function fetchSpec(id: string): WebSetupProviderSpec {
  const found = providerSpec('fetch', id)
  if (found === undefined) throw new Error(`missing catalog fetch provider ${id}`)
  return found
}

/** A spec whose canary is not an HTTP probe. */
function declaredOnly(specification: WebSetupProviderSpec, canary: WebSetupCanary): WebSetupProviderSpec {
  return { ...specification, canary }
}

/** Cast one malformed wire value to the declared union. */
function wireCanary(value: unknown): WebSetupCanary {
  return value as WebSetupCanary
}

/** Captured request for one fake fetch call. */
interface Captured {
  url: string
  init: RequestInit | undefined
  body: string | undefined
}

/** A fetch that records the request and answers with the given response. */
function capturingFetch(response: Response): { fetchImpl: WebSetupFetch; captured: Captured[] } {
  const captured: Captured[] = []
  const fetchImpl: WebSetupFetch = async (url, init) => {
    captured.push({ url, init, body: typeof init?.body === 'string' ? init.body : undefined })
    return response
  }
  return { fetchImpl, captured }
}

/** A fetch that waits for abort and rejects like a real aborted request. */
const hangingFetch: WebSetupFetch = (_url, init) => new Promise((_resolve, reject) => {
  const signal = init?.signal
  if (signal?.aborted) {
    reject(new Error('aborted'))
    return
  }
  signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
})

/** Run one canary with a fixed clock and no caller signal. */
function run(fetchImpl: WebSetupFetch, overrides: Partial<Parameters<typeof runHttpCanary>[0]> = {}) {
  return runHttpCanary({
    spec: spec('exa'),
    fetchImpl,
    now: () => 0,
    ...overrides,
  })
}

afterEach(() => {
  vi.useRealTimers()
})

it('posts the Exa canary with the candidate key and counts sources', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response(JSON.stringify({ results: [{}, {}] }), { status: 200 }))
  const result = await run(fetchImpl, { apiKey: 'exa-key' })
  expect(result).toMatchObject({ ok: true, status: 200, sourcesCount: 2 })
  expect(typeof result.latencyMs).toBe('number')
  expect(captured).toHaveLength(1)
  expect(captured[0]?.url).toBe('https://api.exa.ai/search')
  expect(captured[0]?.init?.method).toBe('POST')
  expect(captured[0]?.init?.redirect).toBe('error')
  expect(captured[0]?.init?.headers).toMatchObject({ authorization: 'Bearer exa-key' })
  expect(JSON.parse(captured[0]?.body ?? 'null')).toEqual({ query: 'test', numResults: 1 })
})

it('honors an Exa baseURL override without doubling the slash', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('{"results":[]}', { status: 200 }))
  const result = await run(fetchImpl, { baseURL: 'https://exa.internal/', apiKey: 'k' })
  expect(result.ok).toBe(true)
  expect(result.sourcesCount).toBe(0)
  expect(captured[0]?.url).toBe('https://exa.internal/search')
})

it('sends the Brave subscription header and counts web.results', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response(JSON.stringify({ web: { results: [{}] } }), { status: 200 }))
  const result = await run(fetchImpl, { spec: spec('brave'), apiKey: 'brave-key' })
  expect(result).toMatchObject({ ok: true, sourcesCount: 1 })
  expect(captured[0]?.url).toBe('https://api.search.brave.com/res/v1/web/search?q=test&count=1')
  expect(captured[0]?.init?.headers).toMatchObject({ 'X-Subscription-Token': 'brave-key' })
})

it('omits the Brave header without a key and reports no count for a payload without results', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('{}', { status: 200 }))
  const result = await run(fetchImpl, { spec: spec('brave') })
  expect(result.ok).toBe(true)
  expect(result.sourcesCount).toBeUndefined()
  const headers = captured[0]?.init?.headers as Record<string, string> | undefined
  expect(headers?.['X-Subscription-Token']).toBeUndefined()
  expect(headers?.authorization).toBeUndefined()
})

it('posts the Tavily canary with key in both documented accepted positions', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('{"results":[{}]}', { status: 200 }))
  const result = await run(fetchImpl, { spec: spec('tavily'), apiKey: 'tvly' })
  expect(result).toMatchObject({ ok: true, sourcesCount: 1 })
  expect(captured[0]?.url).toBe('https://api.tavily.com/search')
  expect(captured[0]?.init?.headers).toMatchObject({ authorization: 'Bearer tvly' })
  expect(JSON.parse(captured[0]?.body ?? 'null')).toEqual({ query: 'test', max_results: 1, api_key: 'tvly' })
})

it('omits the Tavily body key when none is given', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('{"results":[]}', { status: 200 }))
  const result = await run(fetchImpl, { spec: spec('tavily') })
  expect(result.ok).toBe(true)
  expect(JSON.parse(captured[0]?.body ?? 'null')).toEqual({ query: 'test', max_results: 1 })
})

it('refuses the SearXNG canary without an instance baseURL, then probes format=json', async () => {
  const missing = await run(async () => new Response('{}'), { spec: spec('searxng') })
  expect(missing).toEqual({ ok: false, error: 'searxng requires the instance baseURL' })
  const { fetchImpl, captured } = capturingFetch(new Response('{"results":[{},{}]}', { status: 200 }))
  const result = await run(fetchImpl, { spec: spec('searxng'), baseURL: 'http://127.0.0.1:8888/', apiKey: 'ignored' })
  expect(result).toMatchObject({ ok: true, sourcesCount: 2 })
  expect(captured[0]?.url).toBe('http://127.0.0.1:8888/search?q=test&format=json')
})

it('probes Jina Reader as text with an optional bearer key', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('# Example', { status: 200 }))
  const result = await run(fetchImpl, { spec: fetchSpec('jina'), apiKey: 'jina-key' })
  expect(result).toMatchObject({ ok: true, status: 200 })
  expect(result.sourcesCount).toBeUndefined()
  expect(captured[0]?.url).toBe('https://r.jina.ai/https://example.com')
  expect(captured[0]?.init?.redirect).toBe('error')
  expect(captured[0]?.init?.headers).toMatchObject({ authorization: 'Bearer jina-key', accept: 'text/plain' })
})

it('honors a Jina baseURL override', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('ok', { status: 200 }))
  const result = await run(fetchImpl, { spec: fetchSpec('jina'), baseURL: 'http://reader.internal' })
  expect(result.ok).toBe(true)
  expect(captured[0]?.url).toBe('http://reader.internal/https://example.com')
})

it('maps a non-2xx status with its body excerpt to a failure value', async () => {
  const result = await run(async () => new Response('invalid api key\n', { status: 401, statusText: 'Unauthorized' }))
  expect(result).toMatchObject({ ok: false, status: 401 })
  expect(result.error).toBe('HTTP 401: invalid api key')
})

it('omits the excerpt for an empty refusal body', async () => {
  const result = await run(async () => new Response(null, { status: 429 }))
  expect(result).toMatchObject({ ok: false, status: 429 })
  expect(result.error).toBe('HTTP 429')
})

it('reports a 2xx body that is not JSON', async () => {
  const result = await run(async () => new Response('not json', { status: 200 }))
  expect(result).toEqual({ ok: false, status: 200, latencyMs: 0, error: 'response body was not JSON' })
})

it('times the probe out at the canary budget', async () => {
  vi.useFakeTimers()
  const pending = run(hangingFetch, { apiKey: 'k' })
  await vi.advanceTimersByTimeAsync(CANARY_TIMEOUT_MS)
  const result = await pending
  expect(result).toMatchObject({ ok: false, error: `probe timed out after ${CANARY_TIMEOUT_MS} ms` })
})

it('maps a caller cancellation to a cancelled probe', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await run(hangingFetch, { apiKey: 'k', signal: controller.signal })
  expect(result).toEqual({ ok: false, latencyMs: 0, error: 'probe cancelled' })
})

it('maps a transport failure to its message', async () => {
  const result = await run(async () => { throw new TypeError('fetch failed') })
  expect(result).toEqual({ ok: false, latencyMs: 0, error: 'fetch failed' })
})

it('reports a stringified transport failure for non-Error throws', async () => {
  const result = await run(async () => { throw 'boom' })
  expect(result).toEqual({ ok: false, latencyMs: 0, error: 'boom' })
})

it('refuses a non-HTTP canary kind', async () => {
  const result = await run(async () => new Response('{}'), {
    spec: declaredOnly(spec('deepseek-official'), { kind: 'credential' }),
  })
  expect(result).toEqual({ ok: false, error: 'no HTTP canary is declared for "deepseek-official"' })
})

it('ignores a whitespace-only baseURL override', async () => {
  const { fetchImpl, captured } = capturingFetch(new Response('{"results":[]}', { status: 200 }))
  const result = await run(fetchImpl, { baseURL: '   ', apiKey: 'k' })
  expect(result.ok).toBe(true)
  expect(captured[0]?.url).toBe('https://api.exa.ai/search')
})

it('reports ok without a source count when the payload carries no results array', async () => {
  const { fetchImpl } = capturingFetch(new Response('{}', { status: 200 }))
  const result = await run(fetchImpl, { apiKey: 'k' })
  expect(result).toEqual({ ok: true, status: 200, latencyMs: 0 })
})

it('reports ok without a count for a JSON null body', async () => {
  const result = await run(async () => new Response('null', { status: 200 }), { apiKey: 'k' })
  expect(result).toEqual({ ok: true, status: 200, latencyMs: 0 })
})

it('tolerates Brave payloads with a null body or a non-array result list', async () => {
  const nullBody = await run(async () => new Response('null', { status: 200 }), { spec: spec('brave') })
  expect(nullBody).toEqual({ ok: true, status: 200, latencyMs: 0 })
  const nonArray = await run(async () => new Response('{"web":{"results":"x"}}', { status: 200 }), { spec: spec('brave') })
  expect(nonArray).toEqual({ ok: true, status: 200, latencyMs: 0 })
})

it('refuses a malformed http-search canary provider without throwing', async () => {
  const result = await run(async () => new Response('{}'), {
    spec: declaredOnly(spec('exa'), wireCanary({ kind: 'http-search', provider: 'nope' })),
  })
  expect(result).toEqual({ ok: false, error: 'no HTTP canary is declared for "exa"' })
})

it('reports the status alone when the refusal body is unreadable', async () => {
  const stream = new ReadableStream({
    start(controller) { controller.error(new Error('stream broke')) },
  })
  const result = await run(async () => new Response(stream, { status: 502 }))
  expect(result).toEqual({ ok: false, status: 502, latencyMs: 0, error: 'HTTP 502' })
})
