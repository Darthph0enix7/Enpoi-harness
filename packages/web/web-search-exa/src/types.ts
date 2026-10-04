/**
 * Wire types for the Exa search API (`POST https://api.exa.ai/search`). Types
 * only — no runtime code. Exa returns a flat `results[]`; each entry carries a
 * URL, optional title, optional `publishedDate`, and whichever content fields
 * the request asked for (`highlights[]`, `text`, `summary`).
 *
 * @module @deepseek-ai/dsh-web-search-exa/types
 */

/** Retrieval mode sent as Exa's `type`. */
export type ExaSearchType = 'instant' | 'fast' | 'auto' | 'deep-lite' | 'deep' | 'deep-reasoning'

/**
 * Exa data-category focus. `company` and `people` support only a limited
 * filter set and reject the date and domain-exclusion filters (HTTP 400).
 */
export type ExaCategory = 'company' | 'people' | 'publication' | 'news' | 'personal site' | 'financial report'

/** Content extraction options nested under `contents`. */
export interface ExaContentsRequest {
  /**
   * Highlight extraction. The modern default form is the boolean `true`; an
   * explicit per-result count uses Exa's still-accepted `highlightsPerUrl`.
   */
  highlights: true | { highlightsPerUrl: number }
  /** Full page text extraction; the object form caps the returned characters. */
  text?: true | { maxCharacters: number }
  /** Per-page generated summary. */
  summary?: true
  /** `0` fetches fresh content instead of cached page content. */
  maxAgeHours?: 0
}

/** Request body sent to Exa's search endpoint. */
export interface ExaSearchRequest {
  query: string
  type: ExaSearchType
  /** Exa's result-count control; the seam still enforces the bound on return. */
  numResults?: number
  /** Only results published after this ISO-8601 instant. */
  startPublishedDate?: string
  /** Only results published before this ISO-8601 instant. */
  endPublishedDate?: string
  category?: ExaCategory
  /** Up to 1,200 domains or domain paths, wildcard subdomains supported. */
  includeDomains?: readonly string[]
  /** Up to 1,200 domains or domain paths, wildcard subdomains supported. */
  excludeDomains?: readonly string[]
  contents: ExaContentsRequest
}

/** One entry of Exa's flat `results[]`. */
export interface ExaResult {
  url: string
  title?: string | null
  publishedDate?: string | null
  highlights?: string[]
  text?: string | null
}

/** Exa's search response envelope. */
export interface ExaSearchResponse {
  results?: ExaResult[]
}

/** Exa's error response envelope (best-effort; fields vary by failure). */
export interface ExaError {
  error?: string
  message?: string
}
