/**
 * `TavilySearchProvider`: a `WebSearchProvider` backed by Tavily's Search API
 * (`POST /search` with `Authorization: Bearer`). It maps `content` to `snippet`,
 * normalizes `published_date` to ISO-8601, and maps a requested generated
 * `answer` to `content`. A result without a usable `content` stays as a
 * URL-only source rather than being dropped.
 * @module @deepseek-ai/dsh-web-search-tavily/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  TavilyAnswerMode,
  TavilyError,
  TavilyResult,
  TavilySearchDepth,
  TavilySearchRequest,
  TavilySearchResponse,
  TavilyTimeRange,
  TavilyTopic,
} from './types.ts'

/** Stable id this provider registers under. */
export const TAVILY_PROVIDER_ID = 'tavily'

/** Default Tavily endpoint base; `/search` is the operation. */
export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'

/** Default retrieval depth: Tavily balances relevance and latency at `basic`. */
export const TAVILY_DEFAULT_SEARCH_DEPTH: TavilySearchDepth = 'basic'

/** Tavily's hard per-request result ceiling; a larger request is clamped to it. */
export const TAVILY_MAX_RESULTS = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface TavilySearchProviderOptions {
  /** Literal Tavily API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Tavily API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval depth sent as Tavily's `search_depth`. */
  searchDepth: TavilySearchDepth
  /** Default result count when a request carries no `maxResults`. */
  maxResults?: number
  /** Request a generated answer (`true`/`basic` quick, `advanced` detailed). */
  includeAnswer?: TavilyAnswerMode
  /** Recency window sent as Tavily's `time_range`. */
  timeRange?: TavilyTimeRange
  /** Search category sent as Tavily's `topic`. */
  topic?: TavilyTopic
}

/**
 * Map one Tavily `results[]` entry to a normalized source. Tavily always
 * returns a URL, so a result without a usable `content` stays as a URL-only
 * source rather than being dropped.
 *
 * @param result - one entry of Tavily's `results[]`.
 * @returns the normalized source.
 */
export function mapTavilyResult(result: TavilyResult): WebSearchSource {
  const content = result.content?.trim()
  const publishedAt = isoTimestamp(result.published_date)
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...content !== undefined && content.length > 0 ? { snippet: content } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a Tavily response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; a non-empty generated `answer` becomes
 *   `content`, and the web service owns the final `maxResults` truncation, so
 *   `truncated` is always `false`.
 */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  const sources = (response.results ?? []).map(mapTavilyResult)
  const answer = response.answer
  return {
    ...answer != null && answer.length > 0 ? { content: answer } : {},
    sources,
    truncated: false,
  }
}

/**
 * Normalize a provider date to an ISO-8601 instant, or `undefined` when the
 * text names no parseable calendar date. Tavily's `published_date` is an
 * RFC 1123-style string ("Tue, 11 Mar 2025 17:00:00 GMT"); the seam types
 * `publishedAt` as ISO-8601, so a parseable value is converted and an
 * unparseable one is dropped rather than passed through as a lie.
 */
function isoTimestamp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  const milliseconds = Date.parse(trimmed)
  if (Number.isNaN(milliseconds)) return undefined
  return new Date(milliseconds).toISOString()
}

/** Read Tavily's human-readable error detail from its varying error envelopes. */
function errorDetail(parsed: TavilyError): string | undefined {
  const detail = parsed.detail
  if (typeof detail === 'string' && detail.length > 0) return detail
  if (typeof detail === 'object' && !Array.isArray(detail)) {
    const nested = detail.error
    if (nested !== undefined && nested.length > 0) return nested
  }
  if (parsed.error !== undefined && parsed.error.length > 0) return parsed.error
  return parsed.message
}

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = TAVILY_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new key would
   * make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => TavilySearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    // A vault-resolved key is only knowable at call time; a registered resolver
    // is all this check can prove. A keyless resolver fails on first search.
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && (options.maxResults === undefined || isPositiveInteger(options.maxResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options)
    // A per-request bound wins over the configured default; either may be absent.
    // Tavily rejects `max_results > 20`, so the request is clamped to its ceiling
    // and the seam still enforces the final bound on the way back.
    const maxResults = request.maxResults ?? options.maxResults
    const body: TavilySearchRequest = {
      query: request.query,
      search_depth: options.searchDepth,
      ...maxResults !== undefined ? { max_results: Math.min(maxResults, TAVILY_MAX_RESULTS) } : {},
      ...options.includeAnswer !== undefined ? { include_answer: options.includeAnswer } : {},
      ...options.timeRange !== undefined ? { time_range: options.timeRange } : {},
      ...options.topic !== undefined ? { topic: options.topic } : {},
    }
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Tavily API error (HTTP ${status})`
      try {
        const parsed = await response.json() as TavilyError
        const detail = errorDetail(parsed)
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as TavilySearchResponse
      return mapTavilyResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved key.
   */
  private async apiKey(options: TavilySearchProviderOptions): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await options.resolveApiKey?.()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `Tavily search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `Tavily search has no API key for "${options.apiKeyEnv ?? 'TAVILY_API_KEY'}"; store it through the credentials service`
      + ' (the Web Search settings page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True for a request limit that can be sent to Tavily (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
