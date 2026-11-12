/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */

import { isContextWindowExceededError, isQuotaExceededError, LlmError, parseProviderRetryAfterMs, POLICY_REFUSAL_CODE, ProviderRequestId } from '@deepseek-ai/dsh-llm'

/** Structured refusal evidence read only from provider fields, never message prose. */
export interface ProviderRefusalEvidence {
  /** Provider field value that named the refusal (for example `content_filter`). */
  readonly reason: string
  /** Provider's own explanation when a structured field carried one. */
  readonly explanation?: string
}

/**
 * Stop/finish reasons and machine codes that name a policy refusal. The set is
 * bounded to provider vocabulary; ordinary assistant prose and error messages
 * never select a refusal.
 */
const POLICY_REFUSAL_SIGNALS: ReadonlySet<string> = new Set([
  'refusal',
  'content_filter',
  'content_filtered',
  'content_policy_violation',
  'responsible_ai_policy',
  'moderation_blocked',
  'safety',
  'sensitive',
  'prohibited_content',
  'spii',
  'guardrail_intervened',
  'blocklist',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'policy_refusal',
])

/** Read one object value without invoking accessors or treating arrays as envelopes. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one non-empty string field. */
function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Normalize provider vocabulary before exact membership checks. */
function signalName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** Read the provider's own refusal explanation from structured fields only. */
function explanationFrom(record: Record<string, unknown>): string | undefined {
  const refusal = record.refusal
  const refusalText = textOf(refusal)
  if (refusalText !== undefined) return refusalText
  const refusalRecord = recordOf(refusal)
  if (refusalRecord !== undefined) {
    const detail = textOf(refusalRecord.message) ?? textOf(refusalRecord.reason) ?? textOf(refusalRecord.explanation)
    if (detail !== undefined) return detail
  }
  const filter = record.content_filter
  const filterText = textOf(filter)
  if (filterText !== undefined) return filterText
  const filterRecord = recordOf(filter)
  if (filterRecord !== undefined) {
    const detail = textOf(filterRecord.message) ?? textOf(filterRecord.reason) ?? textOf(filterRecord.explanation)
    if (detail !== undefined) return detail
  }
  return textOf(record.message)
}

/** Whether one `content_filter` value is a positive structured signal. */
function isContentFilterSignal(value: unknown): boolean {
  if (value === true) return true
  if (textOf(value) !== undefined) return true
  const record = recordOf(value)
  if (record === undefined) return false
  return record.blocked === true
    || record.filtered === true
    || record.flagged === true
    || textOf(record.message) !== undefined
    || textOf(record.reason) !== undefined
    || textOf(record.explanation) !== undefined
}

/** Read refusal evidence from one structured record. */
function refusalFrom(record: Record<string, unknown>): ProviderRefusalEvidence | undefined {
  for (const field of ['finish_reason', 'stop_reason', 'code', 'type'] as const) {
    const value = record[field]
    if (typeof value !== 'string') continue
    const normalized = signalName(value)
    // OpenAI Responses documents policy stops as `incomplete.<reason>`; only a
    // known refusal reason under that form counts.
    const reason = normalized.startsWith('incomplete.') ? normalized.slice('incomplete.'.length) : normalized
    if (!POLICY_REFUSAL_SIGNALS.has(reason)) continue
    const explanation = explanationFrom(record)
    return { reason: value, ...explanation === undefined ? {} : { explanation } }
  }
  if (isContentFilterSignal(record.content_filter)) {
    const explanation = explanationFrom(record)
    return { reason: 'content_filter', ...explanation === undefined ? {} : { explanation } }
  }
  const refusal = record.refusal
  const refusalRecord = recordOf(refusal)
  if (refusal === true || textOf(refusal) !== undefined
    || (refusalRecord !== undefined && Object.keys(refusalRecord).length > 0)) {
    const explanation = explanationFrom(record)
    return { reason: 'refusal', ...explanation === undefined ? {} : { explanation } }
  }
  return undefined
}

/**
 * Read structured policy-refusal evidence from a provider response or in-band
 * event. Only named fields (`finish_reason`, `stop_reason`, `code`, `type`,
 * `content_filter`, `refusal`) count; assistant text and speculative prose do
 * not.
 * @param value - decoded provider response, error envelope, or stream event.
 * @returns bounded evidence, or undefined when no structured field names a refusal.
 */
export function providerRefusal(value: unknown): ProviderRefusalEvidence | undefined {
  const outer = recordOf(value)
  if (outer === undefined) return undefined
  for (const record of [outer, recordOf(outer.error), recordOf(outer.delta), recordOf(outer.message)]) {
    if (record === undefined) continue
    const evidence = refusalFrom(record)
    if (evidence !== undefined) return evidence
  }
  return undefined
}

/** Read only provider error fields used by bounded Files recovery.
 * @param raw - decoded HTTP error response.
 * @returns code, type, and message text, without unrelated response fields.
 */
export function providerErrorDetail(raw: unknown): string {
  const error = typeof raw === 'object' && raw !== null && 'error' in raw ? raw.error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const fields = error as Record<string, unknown>
  return [fields.code, fields.type, fields.message].filter((value): value is string => typeof value === 'string').join(' ')
}

/** Classify a provider error without trusting arbitrary response fields.
 * @param raw - decoded response or in-band error event.
 * @param status - HTTP status when the error preceded streaming.
 * @param headers - response headers for retry delay and request identity.
 * @param bodyText - raw response text, for a reset hint carried only as a flattened envelope.
 * @returns a stable error consumed by LlmRuntime and llm-retry.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers, bodyText?: string): LlmError {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as Record<string, unknown> : {}
  const message = typeof error.message === 'string' ? error.message : `DeepSeek Messages request failed (${status ?? 'stream error'})`
  const type = typeof error.type === 'string' ? error.type : ''
  const detail = `${type} ${typeof error.code === 'string' ? error.code : ''} ${message}`
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id')

  // A structured refusal is the provider's terminal answer to the request. It
  // wins before status or wording, so a 500 response whose explanation mentions
  // auth or quota cannot be reclassified as transient.
  const refusal = providerRefusal(raw)
  if (refusal !== undefined) {
    const explanation = refusal.explanation
      ?? (typeof error.message === 'string' && error.message.length > 0 ? error.message : undefined)
      ?? `DeepSeek Messages refused the request (${refusal.reason})`
    return new LlmError(explanation, POLICY_REFUSAL_CODE, {
      ...status === undefined ? {} : { status },
      ...id ? { requestId: ProviderRequestId(id) } : {},
    })
  }

  let code: string
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error'].includes(type)) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST'
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const delay = parseProviderRetryAfterMs({
    retryAfterHeader: headers?.get('retry-after'),
    body: raw,
    message: bodyText,
  })
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id ? { requestId: ProviderRequestId(id) } : {},
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
  })
}
