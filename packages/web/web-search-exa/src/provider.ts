/**
 * `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
 * highlight contents). It maps the first non-blank highlight to `snippet`, maps
 * `publishedDate` to `publishedAt`, falls back to a leading text excerpt when text was
 * requested and highlights are absent, and omits `content` because Exa returns no generated
 * answer.
 * @module @deepseek-ai/dsh-web-search-exa/provider
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
  ExaCategory,
  ExaContentsRequest,
  ExaError,
  ExaResult,
  ExaSearchRequest,
  ExaSearchResponse,
  ExaSearchType,
} from './types.ts'

/** Stable id this provider registers under. */
export const EXA_PROVIDER_ID = 'exa'

/** Default Exa search endpoint; `/search` is the operation. */
export const EXA_DEFAULT_BASE_URL = 'https://api.exa.ai'

/** Default retrieval mode: Exa balances quality and latency. */
export const EXA_DEFAULT_SEARCH_TYPE: ExaSearchType = 'auto'

/** Default number of highlight excerpts requested per result. */
export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1

/**
 * Character bound on the text excerpt used as a snippet when highlights are
 * absent. A highlight is a few sentences; an unbounded `text` field would
 * dominate the model-visible search result.
 */
export const EXA_TEXT_FALLBACK_MAX_CHARS = 500

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Categories Exa cannot combine with date or domain-exclusion filters. */
const EXA_UNFILTERABLE_CATEGORIES: ReadonlySet<ExaCategory> = new Set(['company', 'people'])

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface ExaSearchProviderOptions {
  /** Literal Exa API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current Exa API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Retrieval mode sent as Exa's `type`. */
  searchType: ExaSearchType
  /** Default result count when a request carries no `maxResults`. */
  numResults?: number
  /** Highlight excerpts requested per result; `1` sends Exa's boolean form. */
  highlightsPerResult: number
  /** Only results published after this ISO-8601 instant. */
  startPublishedDate?: string
  /** Only results published before this ISO-8601 instant. */
  endPublishedDate?: string
  /** Exa data-category focus. */
  category?: ExaCategory
  /** Restrict results to these domains or domain paths. */
  includeDomains?: readonly string[]
  /** Drop results from these domains or domain paths. */
  excludeDomains?: readonly string[]
  /** Force a live fetch instead of cached page content (`contents.maxAgeHours: 0`). */
  livecrawl?: boolean
  /** Request full page text, optionally capped by characters. */
  text?: { maxCharacters?: number }
  /** Request a generated per-page summary. */
  summary?: boolean
}

/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * usable snippet.
 *
 * @param result - one entry of Exa's `results[]`.
 * @param textFallback - when true, an entry without a usable highlight falls
 *   back to a leading excerpt of its requested `text`; otherwise the entry is
 *   dropped (the seam has no other field to derive a snippet from, and
 *   inventing one would lie).
 * @returns the normalized source, or `undefined` when neither a highlight nor
 *   a usable text excerpt exists.
 */
export function mapExaResult(result: ExaResult, textFallback = false): WebSearchSource | undefined {
  const snippet = result.highlights?.find(highlight => highlight.trim().length > 0)
    ?? (textFallback ? leadingTextExcerpt(result.text) : undefined)
  if (snippet === undefined) return undefined
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    snippet,
    ...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {},
  }
}

/**
 * Map an Exa response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /search` response body.
 * @param textFallback - whether the request asked for text, allowing a
 *   highlight-less entry to keep a leading text excerpt.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapExaResult}).
 */
export function mapExaResponse(response: ExaSearchResponse, textFallback = false): WebSearchResult {
  const sources = (response.results ?? [])
    .map(result => mapExaResult(result, textFallback))
    .filter((source): source is WebSearchSource => source !== undefined)
  // Exa returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** Bound a page's leading text to a snippet-sized excerpt, or undefined when blank. */
function leadingTextExcerpt(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed.length === 0) return undefined
  return trimmed.length > EXA_TEXT_FALLBACK_MAX_CHARS
    ? trimmed.slice(0, EXA_TEXT_FALLBACK_MAX_CHARS)
    : trimmed
}

/**
 * Build the `contents` object for one request. Exa's modern default highlight
 * form is the boolean `true`; an explicit count uses the still-accepted
 * `highlightsPerUrl`, because Exa offers no non-deprecated count control.
 */
function buildContents(options: ExaSearchProviderOptions): ExaContentsRequest {
  return {
    highlights: options.highlightsPerResult === 1 ? true : { highlightsPerUrl: options.highlightsPerResult },
    ...options.text !== undefined
      ? { text: options.text.maxCharacters === undefined ? true : { maxCharacters: options.text.maxCharacters } }
      : {},
    ...options.summary === true ? { summary: true } : {},
    ...options.livecrawl === true ? { maxAgeHours: 0 } : {},
  }
}

/**
 * Reject the filter combination Exa answers with HTTP 400 before spending a
 * request: `company` and `people` support only a limited filter set and reject
 * `startPublishedDate`, `endPublishedDate`, and `excludeDomains`
 * (https://exa.ai/docs/reference/search).
 */
function assertSupportedFilters(options: ExaSearchProviderOptions): void {
  if (options.category === undefined || !EXA_UNFILTERABLE_CATEGORIES.has(options.category)) return
  const unsupported = [
    ...options.startPublishedDate !== undefined ? ['startPublishedDate'] : [],
    ...options.endPublishedDate !== undefined ? ['endPublishedDate'] : [],
    ...options.excludeDomains !== undefined && options.excludeDomains.length > 0 ? ['excludeDomains'] : [],
  ]
  if (unsupported.length === 0) return
  throw new WebError(
    `Exa category "${options.category}" does not support ${unsupported.join(', ')} (HTTP 400)`
    + '; remove the unsupported filters or choose a different category',
    'WEB_PROVIDER_ERROR',
  )
}

/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new key would
   * make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => ExaSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    // A vault-resolved key is only knowable at call time; a registered resolver
    // is all this check can prove. A keyless resolver fails on first search.
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && isValidBaseUrl(options.baseURL)
      && isPositiveInteger(options.highlightsPerResult)
      && (options.numResults === undefined || isPositiveInteger(options.numResults))
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    assertSupportedFilters(options)
    const apiKey = await this.apiKey(options)
    // A per-request bound wins over the configured default; either may be absent.
    const numResults = request.maxResults ?? options.numResults
    const body: ExaSearchRequest = {
      query: request.query,
      type: options.searchType,
      contents: buildContents(options),
      ...numResults !== undefined ? { numResults } : {},
      ...options.startPublishedDate !== undefined ? { startPublishedDate: options.startPublishedDate } : {},
      ...options.endPublishedDate !== undefined ? { endPublishedDate: options.endPublishedDate } : {},
      ...options.category !== undefined ? { category: options.category } : {},
      ...options.includeDomains !== undefined && options.includeDomains.length > 0
        ? { includeDomains: options.includeDomains }
        : {},
      ...options.excludeDomains !== undefined && options.excludeDomains.length > 0
        ? { excludeDomains: options.excludeDomains }
        : {},
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
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Exa API error (HTTP ${status})`
      try {
        const parsed = await response.json() as ExaError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as ExaSearchResponse
      return mapExaResponse(payload, options.text !== undefined)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the key and the endpoint it is sent to come from one section.
   * @returns the resolved key.
   */
  private async apiKey(options: ExaSearchProviderOptions): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await options.resolveApiKey?.()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Exa search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `Exa search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new WebError(
      `Exa search has no API key for "${options.apiKeyEnv ?? 'EXA_API_KEY'}"; store it through the credentials service`
      + ' (the Web Search settings page writes it), export it in the launching environment, or set a literal'
      + ' "apiKey" in the web-search-exa config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
