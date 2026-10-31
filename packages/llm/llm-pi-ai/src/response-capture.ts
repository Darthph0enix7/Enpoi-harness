/**
 * Per-attempt capture of the HTTP response pi-ai reduces to error text.
 *
 * pi-ai catches a provider's failed request itself: its `onResponse` hook runs
 * only after a response succeeded, and its catch block flattens a non-2xx SDK
 * error into `<status>: <body>` text before the harness sees it. The `fetch`
 * option is the last point where the `Response` still exists, so this module
 * wraps it for one attempt, records a non-2xx response's status and
 * `Retry-After` header, and returns the response untouched for the SDK to read.
 * Each attempt owns its recorder, so concurrent requests never share one.
 *
 * @module dsh-llm-pi-ai/response-capture
 */

import type { FetchFunction } from '@earendil-works/pi-ai'

/** Facts a non-2xx HTTP response contributes to one attempt's terminal failure. */
export interface HttpResponseFacts {
  /** Status of the last non-2xx response the attempt received. */
  readonly status?: number
  /** Raw `Retry-After` header of that response: integer seconds or an HTTP-date. */
  readonly retryAfterHeader?: string
}

/** One attempt's response record and the fetch that fills it. */
export interface ResponseCapture {
  /** Fetch to hand pi-ai; absent when the protocol cannot accept a custom implementation. */
  readonly fetch?: FetchFunction
  /** Recorded facts, or undefined when the attempt received no non-2xx response. */
  readonly facts: () => HttpResponseFacts | undefined
}

/**
 * Wire protocols whose pi-ai implementation passes `options.fetch` to its HTTP
 * client. Google's adapters reject a custom fetch and Bedrock ignores it, so
 * wrapping there would either fail a working request or record nothing.
 */
const CAPTURE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'mistral-conversations',
  'pi-messages',
])

/** Recorder for a protocol that accepts no custom fetch. */
const NO_CAPTURE: ResponseCapture = Object.freeze({ facts: () => undefined })

/**
 * Create the HTTP response recorder for one attempt.
 * @param api - the model's pi-ai wire protocol.
 * @returns a recorder whose `fetch` records each non-2xx response; `fetch` is
 *   absent for protocols that cannot accept a custom implementation.
 */
export function captureResponse(api: string): ResponseCapture {
  if (!CAPTURE_PROTOCOLS.has(api)) return NO_CAPTURE
  let recorded: HttpResponseFacts | undefined
  const fetch: FetchFunction = async (input, init) => {
    const response = await globalThis.fetch(input, init)
    if (response.ok) {
      // Clear on success: an auth refresh may issue a second request, and an
      // earlier rejection must not describe the attempt's final outcome.
      recorded = undefined
      return response
    }
    const retryAfter = response.headers.get('retry-after')
    recorded = {
      status: response.status,
      ...retryAfter === null ? {} : { retryAfterHeader: retryAfter },
    }
    return response
  }
  return Object.freeze({ fetch, facts: () => recorded })
}
