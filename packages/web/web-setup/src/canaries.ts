/**
 * Live provider canaries for `webSetup.validateProvider`. Every probe is an
 * external HTTP request bounded by {@link CANARY_TIMEOUT_MS}; the candidate
 * credential is one-shot (or resolved from the vault) and never persisted
 * here. HTTP, parse, and transport failures map to the result value.
 *
 * @module @deepseek-ai/dsh-web-setup/canaries
 */

import type { WebSetupFetch, WebSetupProviderSpec, WebSetupValidation } from './types.ts'

/** Upper bound on one live probe; the wizard's "Verify & Connect" budget. */
export const CANARY_TIMEOUT_MS = 5_000

/** Canary query; fixed so the provider performs the cheapest billable unit. */
const CANARY_QUERY = 'test'

/** Refusal bodies are diagnostics, not data; only a short excerpt crosses back. */
const EXCERPT_CHARS = 200

/** One prepared HTTP probe: URL, request init, and payload-level source counter. */
interface HttpProbe {
  url: string
  init: RequestInit
  /** Counts sources in a parsed body; `undefined` means the provider declares no source list. */
  parse?: (body: unknown) => number | undefined
}

/** Inputs of one canary run. */
export interface CanaryOptions {
  spec: WebSetupProviderSpec
  /** One-shot key from the request, or the vault-resolved value. */
  apiKey?: string
  /** Endpoint override the candidate row would use. */
  baseURL?: string
  fetchImpl: WebSetupFetch
  now: () => number
  /** Caller cancellation (the Remote carrier's signal). */
  signal?: AbortSignal
}

/** Drop one trailing slash so a path append never doubles it. */
function trimBase(baseURL: string): string {
  return baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
}

/** Strip one terminal slash and trim; an unusable override is reported, not used. */
function normalizeBaseURL(baseURL: string | undefined): string | undefined {
  if (baseURL === undefined) return undefined
  const trimmed = baseURL.trim()
  if (trimmed === '') return undefined
  return trimBase(trimmed)
}

/** Count a top-level `results` array, the shape Exa, Tavily, and SearXNG return. */
function resultsLength(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const results = (body as { results?: unknown }).results
  return Array.isArray(results) ? results.length : undefined
}

/** Count Brave's `web.results` array. */
function braveResultsLength(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const web = (body as { web?: unknown }).web
  if (web === null || typeof web !== 'object') return undefined
  const results = (web as { results?: unknown }).results
  return Array.isArray(results) ? results.length : undefined
}

/** Prepare the provider-specific request, or report why it cannot be built. */
function buildProbe(options: CanaryOptions): HttpProbe | { error: string } {
  const { spec, apiKey } = options
  const baseURL = normalizeBaseURL(options.baseURL)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined && apiKey !== '') headers.authorization = `Bearer ${apiKey}`
  switch (spec.canary.kind) {
    case 'http-search': {
      switch (spec.canary.provider) {
        case 'exa': {
          return {
            url: `${baseURL ?? 'https://api.exa.ai'}/search`,
            init: {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({ query: CANARY_QUERY, numResults: 1 }),
              redirect: 'error',
            },
            parse: resultsLength,
          }
        }
        case 'brave': {
          const requestHeaders: Record<string, string> = { ...headers }
          if (apiKey !== undefined && apiKey !== '') requestHeaders['X-Subscription-Token'] = apiKey
          return {
            url: `https://api.search.brave.com/res/v1/web/search?q=${CANARY_QUERY}&count=1`,
            init: { method: 'GET', headers: requestHeaders, redirect: 'error' },
            parse: braveResultsLength,
          }
        }
        case 'tavily': {
          // Tavily documents `Authorization: Bearer`; older keys were accepted in
          // the body as `api_key`. The canary sends both so either generation
          // answers, and the documented header is the one the adapter will use.
          return {
            url: 'https://api.tavily.com/search',
            init: {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({
                query: CANARY_QUERY,
                max_results: 1,
                ...apiKey === undefined || apiKey === '' ? {} : { api_key: apiKey },
              }),
              redirect: 'error',
            },
            parse: resultsLength,
          }
        }
        case 'searxng': {
          if (baseURL === undefined) return { error: 'searxng requires the instance baseURL' }
          return {
            url: `${baseURL}/search?q=${CANARY_QUERY}&format=json`,
            init: { method: 'GET', headers, redirect: 'error' },
            parse: resultsLength,
          }
        }
        default:
          // The catalog narrows this union; a malformed wire value still reports cleanly.
          return { error: `no HTTP canary is declared for "${spec.id}"` }
      }
    }
    case 'http-fetch': {
      return {
        url: `${baseURL ?? 'https://r.jina.ai'}/https://example.com`,
        init: { method: 'GET', headers: { ...headers, accept: 'text/plain' }, redirect: 'error' },
      }
    }
    case 'credential':
    case 'none':
      break
  }
  return { error: `no HTTP canary is declared for "${spec.id}"` }
}

/** Read a short single-line excerpt of a refusal body; unreadable bodies add nothing. */
async function excerptOf(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.replace(/\s+/gu, ' ').trim().slice(0, EXCERPT_CHARS)
  } catch {
    // A refused body may be an aborted stream; the status line alone is the report.
    return ''
  }
}

/**
 * Run the provider's declared HTTP canary.
 *
 * The probe never throws: timeout, cancellation, transport, non-2xx, and body
 * parse failures all resolve to a {@link WebSetupValidation} with `ok: false`
 * and a human-readable `error`. A 2xx response with a source counter reports
 * `sourcesCount`; Jina's text response reports none.
 * @param options - provider spec, key/baseURL override, fetch surface, clock, and caller signal.
 * @returns the probe outcome.
 */
export async function runHttpCanary(options: CanaryOptions): Promise<WebSetupValidation> {
  const probe = buildProbe(options)
  if ('error' in probe) return { ok: false, error: probe.error }
  const started = options.now()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`probe timed out after ${CANARY_TIMEOUT_MS} ms`))
  }, CANARY_TIMEOUT_MS)
  const outer = options.signal
  const forwardAbort = (): void => { controller.abort(outer?.reason) }
  if (outer !== undefined) {
    if (outer.aborted) forwardAbort()
    else outer.addEventListener('abort', forwardAbort, { once: true })
  }
  try {
    const response = await options.fetchImpl(probe.url, { ...probe.init, signal: controller.signal })
    const status = response.status
    const latencyMs = Math.round(options.now() - started)
    if (!response.ok) {
      const excerpt = await excerptOf(response)
      return {
        ok: false,
        status,
        latencyMs,
        error: `HTTP ${status}${excerpt === '' ? '' : `: ${excerpt}`}`,
      }
    }
    if (probe.parse === undefined) return { ok: true, status, latencyMs }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      // A 2xx body that is not JSON cannot answer the source count; report the status it carried.
      return { ok: false, status, latencyMs, error: 'response body was not JSON' }
    }
    const sourcesCount = probe.parse(body)
    return { ok: true, status, latencyMs, ...(sourcesCount === undefined ? {} : { sourcesCount }) }
  } catch (error) {
    const latencyMs = Math.round(options.now() - started)
    if (controller.signal.aborted) {
      const cancelled = outer?.aborted === true
      return { ok: false, latencyMs, error: cancelled ? 'probe cancelled' : `probe timed out after ${CANARY_TIMEOUT_MS} ms` }
    }
    return { ok: false, latencyMs, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', forwardAbort)
  }
}
