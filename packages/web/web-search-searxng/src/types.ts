/**
 * Wire types for the SearXNG JSON search API
 * (`GET {baseURL}/search?format=json`). Types only — no runtime code. SearXNG
 * serves a flat `results[]` whose entries carry a URL, optional title,
 * `content` text, and an optional `publishedDate`; refusals carry either an
 * `error` or `message` string.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** Recency window sent as SearXNG's `time_range`. */
export type SearxngTimeRange = 'day' | 'week' | 'month' | 'year'

/** Safe-search level sent as SearXNG's `safesearch`. */
export type SearxngSafeSearch = 0 | 1 | 2

/** One entry of SearXNG's flat `results[]`. */
export interface SearxngResult {
  title?: string | null
  url: string
  content?: string | null
  /** Publication estimate; normalized to ISO-8601 before it reaches `publishedAt`. */
  publishedDate?: string | null
}

/** SearXNG's search response envelope; answer, infobox, and timing fields are ignored. */
export interface SearxngSearchResponse {
  results?: SearxngResult[]
}

/** SearXNG's JSON error envelope (best-effort; the key varies by refusal). */
export interface SearxngError {
  error?: string
  message?: string
}
