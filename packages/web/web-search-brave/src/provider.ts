/**
 * `BraveSearchProvider`: a `WebSearchProvider` backed by Brave's Web Search API
 * (`GET /res/v1/web/search` with `X-Subscription-Token`). It maps `description`
 * to `snippet` and normalizes `page_age` to ISO-8601, dropping Brave's relative
 * age text ("2 days ago") because the seam types `publishedAt` as an ISO-8601
 * instant. Brave returns no generated answer, so `content` is omitted.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { BraveError, BraveSearchResponse, BraveWebResult } from './types.ts'

/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave endpoint base; `/res/v1/web/search` is the operation. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com'

/** Default result count when a request carries no `maxResults`. */
export const BRAVE_DEFAULT_COUNT = 10

/** Brave's hard per-request result ceiling; a larger request is clamped to it. */
export const BRAVE_MAX_COUNT = 20

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface BraveSearchProviderOptions {
  /** Literal Brave API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Brave API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/res/v1/web/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  count: number
  /**
   * Deployment-level freshness window (`pd`, `pw`, `pm`, `py`, or an ISO-8601
   * range). The seam's request has no recency field, so this cannot vary per
   * query without a seam change.
   */
  freshness?: string
  /** Two-letter country code sent as Brave's `country`. */
  country?: string
  /** Search-language code sent as Brave's `search_lang`. */
  searchLang?: string
}

/**
 * Map one Brave `web.results[]` entry to a normalized source. Brave always
 * returns a URL, so a result without a usable description stays as a URL-only
 * source rather than being dropped.
 *
 * @param result - one entry of Brave's `web.results[]`.
 * @returns the normalized source.
 */
export function mapBraveResult(result: BraveWebResult): WebSearchSource {
  const description = result.description?.trim()
  const publishedAt = isoTimestamp(result.page_age)
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...description !== undefined && description.length > 0 ? { snippet: description } : {},
    ...publishedAt !== undefined ? { publishedAt } : {},
  }
}

/**
 * Map a Brave response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /res/v1/web/search` response body.
 * @returns the normalized result. Brave returns no generated answer, so
 *   `content` is omitted; the web service owns the final `maxResults`
 *   truncation, so `truncated` is always `false`.
 */
export function mapBraveResponse(response: BraveSearchResponse): WebSearchResult {
  const sources = (response.web?.results ?? []).map(mapBraveResult)
  return { sources, truncated: false }
}

/**
 * Normalize provider age text to an ISO-8601 instant, or `undefined` when the
 * text names no parseable calendar date. Brave's `page_age` is not guaranteed
 * to be ISO-8601 ("2 days ago"); the seam types `publishedAt` as ISO-8601, so
 * relative text is dropped rather than converted to a fabricated timestamp.
 */
function isoTimestamp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  const milliseconds = Date.parse(trimmed)
  if (Number.isNaN(milliseconds)) return undefined
  return new Date(milliseconds).toISOString()
}

/** The Brave-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new key would
   * make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => BraveSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    // A vault-resolved key is only knowable at call time; a registered resolver
    // is all this check can prove. A keyless resolver fails on first search.
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.count)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options)
    // A per-request bound wins over the configured default; either may be absent.
    // Brave rejects `count > 20`, so the request is clamped to its ceiling and
    // the seam still enforces the final bound on the way back.
    const count = Math.min(request.maxResults ?? options.count, BRAVE_MAX_COUNT)
    const params = new URLSearchParams({ q: request.query, count: String(count) })
    if (options.freshness !== undefined) params.set('freshness', options.freshness)
    if (options.country !== undefined) params.set('country', options.country)
    if (options.searchLang !== undefined) params.set('search_lang', options.searchLang)
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/res/v1/web/search?${params.toString()}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'x-subscription-token': apiKey,
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Brave API error (HTTP ${status})`
      try {
        const parsed = await response.json() as BraveError
        const detail = parsed.error?.detail ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as BraveSearchResponse
      return mapBraveResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved key.
   */
  private async apiKey(options: BraveSearchProviderOptions): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await options.resolveApiKey?.()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `Brave search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `Brave search has no API key for "${options.apiKeyEnv ?? 'BRAVE_API_KEY'}"; store it through the credentials service`
      + ' (the Web Search settings page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-brave config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True for a request limit that can be sent to Brave (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
