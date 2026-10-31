/**
 * Normalization for values thrown by a final LLM adapter boundary.
 *
 * @module @deepseek-ai/dsh-llm/adapter-failure
 */

import { HarnessError } from './error.ts'
import { parseProviderRetryAfterMs } from './provider-retry.ts'
import type { LlmFailure } from './types.ts'

/**
 * Detach serializable provider facts from a value thrown by an adapter.
 * @param value - arbitrary value thrown during adapter dispatch or iteration.
 * @returns immutable provider-neutral facts suitable for a terminal finish chunk.
 * @internal
 */
export function normalizeLlmFailure(value: unknown): LlmFailure {
  const error = value instanceof Error
    ? value
    : new HarnessError(thrownMessage(value), 'UNKNOWN', { cause: value })
  // Cross-package copies preserve own data but not class identity. Trust the
  // carried facts only when both own properties agree after validation.
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) {
    return withRetryHint(carried, retryHintOf(error))
  }
  const message = errorMessage(error)
  const retryAfterMs = retryHintOf(error)
  return Object.freeze({
    message,
    code: harnessErrorCode(error),
    ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
  })
}

/**
 * Pre-stream HTTP errors reach this boundary as SDK errors, not as a harness
 * `failure` snapshot: the SDK keeps the status, headers, and parsed body under
 * its own names. Recover the reset hint from those the same way every adapter
 * does, so a 429 rejected before streaming hands `llm-retry` the same window an
 * in-stream failure does.
 */
function retryHintOf(error: Error): number | undefined {
  let retryAfterHeader: string | null | undefined
  let body: unknown
  let message: string | undefined
  try {
    const headers: unknown = (error as { headers?: unknown }).headers
    if (typeof headers === 'object' && headers !== null
      && 'get' in headers && typeof (headers as { get?: unknown }).get === 'function') {
      const value = (headers as { get(name: string): unknown }).get('retry-after')
      if (typeof value === 'string') retryAfterHeader = value
    }
  } catch (_sdkHeadersTrap) {
    // A trapped headers getter simply yields no header hint.
  }
  try {
    const parsed: unknown = (error as { error?: unknown }).error
    if (parsed !== undefined) body = parsed
    else {
      const raw: unknown = (error as { body?: unknown }).body
      if (typeof raw === 'string' || (typeof raw === 'object' && raw !== null)) body = raw
    }
  } catch (_sdkBodyTrap) {
    // A trapped body getter simply yields no body hint.
  }
  try {
    message = error.message
  } catch (_sdkMessageGetter) {
    // A trapped message getter simply yields no text hint.
  }
  return parseProviderRetryAfterMs({ retryAfterHeader, body, message })
}

/** Attach a reset hint recovered beside a carried failure snapshot. */
function withRetryHint(failure: LlmFailure, hint: number | undefined): LlmFailure {
  if (failure.providerRetryAfterMs !== undefined || hint === undefined) return failure
  return Object.freeze({ ...failure, providerRetryAfterMs: hint })
}

/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch (_hostileThrownValue) {
    return 'LLM adapter failed'
  }
}

/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    const offloadImages = candidate.offloadImages
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))
      || (offloadImages !== undefined && (!Number.isSafeInteger(offloadImages) || offloadImages <= 0))) return undefined
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
      ...offloadImages === undefined ? {} : { offloadImages },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // The fallback below preserves a serializable failure beside the original Error.
  }
  return 'LLM adapter failed'
}

/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error: Error): string {
  return error instanceof HarnessError ? error.code : 'UNKNOWN'
}
