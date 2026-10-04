/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a SearXNG
 * instance's JSON API (`GET {baseURL}/search?format=json`). It is keyless: the
 * instance owns authentication and rate limiting, so there is no credential to
 * resolve. It maps `content` to `snippet` and normalizes `publishedDate` to
 * ISO-8601, keeping a URL-only source when the instance returns no usable text.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  SearxngError,
  SearxngResult,
  SearxngSafeSearch,
  SearxngSearchResponse,
  SearxngTimeRange,
} from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * Refusal detail for HTTP 403: many public instances leave the JSON output
 * format disabled, so `/search?format=json` answers with a bare 403 (and an
 * HTML body) instead of results. Naming the trap saves the caller from
 * debugging an instance that is otherwise healthy.
 */
const JSON_FORMAT_REFUSED_MESSAGE = 'SearXNG instance refused the request (HTTP 403);'
  + ' many public instances disable the JSON output format — enable "json" under the instance\'s'
  + ' search.formats setting or use another instance'

/** Resolved provider options (the plugin's `apply` supplies constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Instance base URL; `/search` is appended. */
  baseURL: string
  /** Comma-separated SearXNG categories, e.g. `general,news`. */
  categories?: string
  /** Language code sent as `language`; `auto` defers to the instance. */
  language?: string
  /** Recency window sent as `time_range`. */
  timeRange?: SearxngTimeRange
  /** Engine names sent as a comma-separated `engines` parameter. */
  engines?: readonly string[]
  /** Safe-search level sent as `safesearch`: `0` none, `1` moderate, `2` strict. */
  safesearch?: SearxngSafeSearch
}

/**
 * Map one SearXNG `results[]` entry to a normalized source. SearXNG always
 * returns a URL, so a result without a usable `content` stays as a URL-only
 * source rather than being dropped.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource {
  const content = result.content?.trim()
  const publishedAt = isoTimestamp(result.publishedDate)
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...content !== undefined && content.length > 0 ? { snippet: content } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; SearXNG returns no generated answer, so
 *   `content` is omitted and the web service owns the final `maxResults`
 *   truncation, so `truncated` is always `false`.
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? []).map(mapSearxngResult)
  return { sources, truncated: false }
}

/**
 * Normalize a provider date to an ISO-8601 instant, or `undefined` when the
 * text names no parseable calendar date. SearXNG's `publishedDate` varies by
 * engine and may be relative or absent; the seam types `publishedAt` as
 * ISO-8601, so an unparseable value is dropped rather than passed through as a
 * lie.
 */
function isoTimestamp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  const milliseconds = Date.parse(trimmed)
  if (Number.isNaN(milliseconds)) return undefined
  return new Date(milliseconds).toISOString()
}

/** True for an endpoint base this provider can call: a parseable http(s) URL. */
function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => SearxngSearchProviderOptions) {}

  /** Usable while the configured instance base is a parseable http(s) URL. */
  available(): boolean {
    const options = this.resolveOptions()
    return isHttpUrl(options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const params = new URLSearchParams({ q: request.query, format: 'json' })
    if (options.categories !== undefined) params.set('categories', options.categories)
    if (options.language !== undefined) params.set('language', options.language)
    if (options.timeRange !== undefined) params.set('time_range', options.timeRange)
    if (options.engines !== undefined && options.engines.length > 0) params.set('engines', options.engines.join(','))
    if (options.safesearch !== undefined) params.set('safesearch', String(options.safesearch))
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search?${params.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = status === 403 ? JSON_FORMAT_REFUSED_MESSAGE : `SearXNG API error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearxngError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) {
          message = status === 403 ? `${JSON_FORMAT_REFUSED_MESSAGE}: ${detail}` : detail
        }
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the status line (or the JSON-format trap above) already
        // carries the failure; a non-JSON refusal body only costs the detail.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}
