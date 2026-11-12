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
 * A healthy stream can produce no pi-ai event for a long time: gateways write
 * SSE comment keepalives, and providers stream empty reasoning updates that
 * pi-ai accepts without emitting an assistant event. The adapter's idle
 * watchdog therefore also watches the response body's bytes. This module owns
 * that observation because it already holds the one `Response` the SDK reads;
 * an observing pass-through body reports each chunk without buffering, reading
 * ahead, or changing the response's native fields.
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

/** Liveness reporting for the response body one attempt's SDK reads. */
export interface ResponseCaptureOptions {
  /**
   * Called once for every body chunk the SDK reads, including bytes that form
   * no pi-ai event (SSE comment keepalives and empty reasoning updates).
   */
  readonly onStreamActivity?: () => void
  /**
   * Aborts liveness reporting: chunks this response's body delivers after it
   * aborts do not invoke {@link onStreamActivity}. Tying it to the attempt that
   * owns the response keeps a torn-down attempt's late bytes from resetting a
   * later attempt's idle watchdog.
   */
  readonly activitySignal?: AbortSignal
}

/** One attempt's response record and the fetch that fills it. */
export interface ResponseCapture {
  /**
   * Fetch to hand pi-ai; absent when the protocol cannot accept a custom
   * implementation. With {@link ResponseCaptureOptions.onStreamActivity} it
   * also reports successful response body activity.
   */
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
 * Replace one response's own `body` accessor with a pass-through stream that
 * reports every read chunk. The same native `Response` is returned, so
 * `status`, `headers`, `url`, brand checks, and every SDK `this` binding stay
 * intact; a Proxy or a reconstructed `Response` would change those semantics.
 * The original body is locked only when the pass-through is first read or
 * cancelled, so a successful response the SDK consumes with `text()`, `json()`,
 * `arrayBuffer()`, or `clone()` keeps its native path. The wrapper reads one
 * chunk per demand with a zero-byte queue, so it does not prefill, buffer ahead,
 * or lock the original body before the SDK asks for it, and cancellation
 * reaches the original reader so the connection closes.
 *
 * @param response - successful response whose body the SDK is about to read.
 * @param activity - callback for each chunk read from the original body.
 * @param activitySignal - aborts `activity` when the owning attempt ends.
 * @returns `response`, with its `body` replaced when it has one.
 */
function observeStreamActivity(
  response: Response,
  activity: () => void,
  activitySignal: AbortSignal | undefined,
): Response {
  const body = response.body
  if (body === null) return response
  const report = activitySignal === undefined
    ? activity
    : (): void => {
      if (!activitySignal.aborted) activity()
    }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const readerOf = (): ReadableStreamDefaultReader<Uint8Array> => (reader ??= body.getReader())
  const observed = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const active = readerOf()
      try {
        const { done, value } = await active.read()
        if (done) {
          // No read is outstanding after EOF, so the lock can be released
          // without racing the consumer; the stream itself is now closed.
          active.releaseLock()
          controller.close()
          return
        }
        // Report the transport byte before handing it to the SDK: an empty
        // reasoning frame is still proof that the provider stream is alive.
        report()
        controller.enqueue(value)
      } catch (error) {
        // The read settled, so releasing here cannot fail on a pending
        // request; a closed controller (consumer cancelled first) ignores the
        // error while a live consumer observes the transport failure.
        active.releaseLock()
        controller.error(error)
      }
    },
    cancel(reason) {
      // No release after cancel: a source cancel may still be settling, and
      // the cancelled stream is unreachable after this call.
      return readerOf().cancel(reason)
    },
  }, { highWaterMark: 0 })
  Object.defineProperty(response, 'body', {
    configurable: true,
    get: () => observed,
  })
  return response
}

/**
 * Create the HTTP response recorder for one attempt.
 * @param api - the model's pi-ai wire protocol.
 * @param options - optional response-body liveness reporting.
 * @returns a recorder whose `fetch` records each non-2xx response and, when
 *   requested, reports successful response body activity; `fetch` is absent for
 *   protocols that cannot accept a custom implementation.
 */
export function captureResponse(api: string, options: ResponseCaptureOptions = {}): ResponseCapture {
  if (!CAPTURE_PROTOCOLS.has(api)) return NO_CAPTURE
  const onStreamActivity = options.onStreamActivity
  const activitySignal = options.activitySignal
  let recorded: HttpResponseFacts | undefined
  const fetch: FetchFunction = async (input, init) => {
    const response = await globalThis.fetch(input, init)
    if (response.ok) {
      // Clear on success: an auth refresh may issue a second request, and an
      // earlier rejection must not describe the attempt's final outcome.
      recorded = undefined
      return onStreamActivity === undefined
        ? response
        : observeStreamActivity(response, onStreamActivity, activitySignal)
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
