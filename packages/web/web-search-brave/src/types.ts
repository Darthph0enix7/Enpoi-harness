/**
 * Wire types for the Brave Web Search API (`GET
 * https://api.search.brave.com/res/v1/web/search`). Types only — no runtime
 * code. Brave nests results under `web.results[]`; each entry carries a URL,
 * optional title and description, and a `page_age` whose text is not guaranteed
 * to be ISO-8601.
 *
 * @module @deepseek-ai/dsh-web-search-brave/types
 */

/** One entry of Brave's `web.results[]`. */
export interface BraveWebResult {
  url: string
  title?: string | null
  description?: string | null
  /** Brave's page-age text; only an ISO-8601-parseable value reaches `publishedAt`. */
  page_age?: string | null
}

/** Brave's web search response envelope. */
export interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[]
  } | null
}

/** Brave's error envelope (best-effort; fields vary by failure). */
export interface BraveError {
  error?: {
    detail?: string
    status?: number
  } | null
  message?: string
}
