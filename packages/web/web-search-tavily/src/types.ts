/**
 * Wire types for the Tavily Search API (`POST https://api.tavily.com/search`).
 * Types only — no runtime code. Tavily returns a flat `results[]` plus an
 * optional generated `answer`; each result carries a URL, optional title,
 * `content` snippet, relevance `score`, and an optional `published_date`.
 *
 * @module @deepseek-ai/dsh-web-search-tavily/types
 */

/** Retrieval depth sent as Tavily's `search_depth`. */
export type TavilySearchDepth = 'basic' | 'advanced'

/** Recency window sent as Tavily's `time_range`. */
export type TavilyTimeRange = 'day' | 'week' | 'month' | 'year'

/** Search category sent as Tavily's `topic`. */
export type TavilyTopic = 'general' | 'news' | 'finance'

/** Generated-answer request sent as Tavily's `include_answer`. */
export type TavilyAnswerMode = boolean | 'basic' | 'advanced'

/** Request body sent to Tavily's search endpoint. */
export interface TavilySearchRequest {
  query: string
  search_depth?: TavilySearchDepth
  /** Tavily's result-count control; the seam still enforces the bound on return. */
  max_results?: number
  include_answer?: TavilyAnswerMode
  time_range?: TavilyTimeRange
  topic?: TavilyTopic
}

/** One entry of Tavily's flat `results[]`. */
export interface TavilyResult {
  title?: string | null
  url: string
  content?: string | null
  score?: number
  /** Tavily's publication estimate; normalized to ISO-8601 before it reaches `publishedAt`. */
  published_date?: string | null
}

/** Tavily's search response envelope. */
export interface TavilySearchResponse {
  /** Generated answer; present only when `include_answer` was requested. */
  answer?: string | null
  results?: TavilyResult[]
}

/** Tavily's error envelope (best-effort; fields vary by failure). */
export interface TavilyError {
  detail?: { error?: string } | string | Array<{ msg?: string }>
  error?: string
  message?: string
}
