/**
 * Wire types for the Jina Reader API (`GET https://r.jina.ai/<target-url>`).
 * Types only — no runtime code. Reader answers `text/plain` Markdown by
 * default; refusals answer a JSON envelope with a machine `code`/`status` and
 * a human `message`.
 *
 * @module @deepseek-ai/dsh-web-fetch-jina/types
 */

/** Browser engine sent as Jina's `X-Engine`; omitted = Jina's automatic choice. */
export type JinaEngine = 'browser' | 'direct' | 'cf-browser-rendering'

/** Jina's JSON error envelope for refusals (authentication, validation, rate limits). */
export interface JinaError {
  code?: number
  name?: string
  status?: number
  message?: string
  readableMessage?: string
}
