/**
 * One parser for the provider reset hints the ecosystem actually sends.
 *
 * A reset hint arrives in four shapes, and the unit differs by shape:
 *
 * | Shape | Field | Unit |
 * | --- | --- | --- |
 * | HTTP response header | `Retry-After` | integer seconds, or an HTTP-date |
 * | Anthropic Messages body | `retry_after` | seconds |
 * | gateway body | `retry_after_ms` | milliseconds |
 * | flattened error text | any of the above inside a JSON envelope | as its field |
 *
 * The unit rule is not a guess: live `meridian` (Claude Max) attempts carried
 * `retry_after` values that fell exactly one unit per second of wall time
 * (17 360 → 17 337 over 34 s), and 17 337 units is the ≈4 h 49 m Claude Max
 * window. Reading `retry_after` as milliseconds would have retried in 17 s.
 *
 * @module @deepseek-ai/dsh-llm/provider-retry
 */

/** Longest provider reset accepted from any source: seven days. */
const PROVIDER_RESET_MAX_MS = 7 * 24 * 60 * 60 * 1_000

/** The header/body/message shapes one provider failure may carry its reset hint in. */
export interface ProviderRetryAfterSources {
  /** Raw `Retry-After` header value: numeric seconds or an HTTP-date. */
  readonly retryAfterHeader?: string | null | undefined
  /** Decoded response body or in-band error event; `error` may wrap the fields. */
  readonly body?: unknown
  /** Flattened error text that may contain a JSON envelope (`<status>: <json>`). */
  readonly message?: string | undefined
  /** Clock used to resolve an HTTP-date; defaults to `Date.now`. */
  readonly now?: number
}

/** One parsed JSON envelope: the outer object and its optional nested `error`. */
interface Envelope {
  readonly outer: Record<string, unknown>
  readonly inner?: Record<string, unknown>
}

/**
 * Recover a provider reset delay from every shape the ecosystem uses.
 *
 * Precedence: the HTTP header is authoritative because it is the transport's
 * own instruction; then the response body; then a JSON envelope embedded in a
 * flattened error message. Within one envelope `retry_after_ms` wins over
 * Anthropic's `retry_after` seconds. A nested `error` record is read before its
 * top-level sibling. Non-finite, zero, negative, and past-date values are
 * ignored; every accepted value is clamped to seven days.
 * @param sources - the header, body, and/or flattened message one failure carries.
 * @returns the reset delay in milliseconds, or undefined when no usable hint exists.
 */
export function parseProviderRetryAfterMs(sources: ProviderRetryAfterSources): number | undefined {
  const header = headerDelayMs(sources.retryAfterHeader, sources.now ?? Date.now())
  if (header !== undefined) return header
  for (const candidate of [sources.body, sources.message]) {
    const envelope = asEnvelope(candidate)
    if (envelope === undefined) continue
    const delay = envelopeDelayMs(envelope)
    if (delay !== undefined) return delay
  }
  return undefined
}

/** Parse the transport header: numeric seconds, or an HTTP-date relative to now. */
function headerDelayMs(raw: string | null | undefined, now: number): number | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) return scaleMs(Number(value), 1_000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return clampMs(date - now)
}

/** Read `retry_after_ms` (ms) then `retry_after` (seconds) from one envelope. */
function envelopeDelayMs(envelope: Envelope): number | undefined {
  for (const [field, scale] of [['retry_after_ms', 1], ['retry_after', 1_000]] as const) {
    for (const record of [envelope.inner, envelope.outer]) {
      const value = record?.[field]
      const delay = scaleMs(value, scale)
      if (delay !== undefined) return delay
    }
  }
  return undefined
}

/** Accept a JSON object or a string carrying one; a string is parsed from its first `{`. */
function asEnvelope(value: unknown): Envelope | undefined {
  if (typeof value === 'string') return jsonEnvelope(value)
  if (typeof value !== 'object' || value === null) return undefined
  const outer = value as Record<string, unknown>
  return {
    outer,
    ...typeof outer.error === 'object' && outer.error !== null
      ? { inner: outer.error as Record<string, unknown> }
      : {},
  }
}

/** Extract the outermost JSON object from flattened error text. */
function jsonEnvelope(text: string): Envelope | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (_nonJsonErrorText) {
    return undefined
  }
  return asEnvelope(parsed)
}

/** Scale one finite positive value, rejecting everything else, and clamp to seven days. */
function scaleMs(value: unknown, scale: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const milliseconds = value * scale
  return Number.isFinite(milliseconds) ? clampMs(milliseconds) : undefined
}

/** Clamp one already-positive delay to the accepted window. */
function clampMs(milliseconds: number): number | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
  return Math.min(milliseconds, PROVIDER_RESET_MAX_MS)
}
