/**
 * Command Code failure classification.
 *
 * The native pool already rotates identities on real exhaustion
 * (401/402/403/429/quota wording) and stops on request-level rejections, so
 * the client's job is only to classify what reaches it: request-level errors
 * must NOT be retried or rotated, transient gateway failures may be. Codes
 * reuse the harness's canonical classes where one exists so retry policy and
 * model chains behave.
 *
 * @module dsh-enpoi-commandcode-provider/errors
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'

/** One classified Command Code failure. */
export interface CommandCodeFailure {
  /** Harness-routable failure code. */
  code: string
  /** Human-readable message (the gateway's own text when present). */
  message: string
}

/** Pull the message out of an error body (`{"error":{"message"}}` or `{"message"}`). */
export function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === 'string') return error
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string') return message
      }
      if (typeof record.message === 'string') return record.message
      if (typeof record.detail === 'string') return record.detail
    }
  } catch {
    // Non-JSON body: fall through to the raw text.
  }
  return body.trim().slice(0, 600)
}

/**
 * Classify one non-2xx Command Code response.
 * @param status - HTTP status; `0` for an in-band `error` event.
 * @param body - response body text.
 * @returns the code the harness should route on and the message to surface.
 */
export function classifyCommandCodeError(status: number, body: string): CommandCodeFailure {
  const message = errorMessageFromBody(body)
  const detail = `${status} ${message}`
  // The harness predicate covers structured overflow wording; the extra
  // pattern is the vendor's own request-level matcher ("... longer than the
  // model's context length"), which the gateway uses verbatim.
  if (isContextWindowExceededError(detail) || /longer than the model.*context|context length/i.test(detail)) {
    return { code: CONTEXT_WINDOW_EXCEEDED_CODE, message }
  }
  if (isQuotaExceededError(detail) || /reached your weekly usage limit|usage limit|insufficient credits/i.test(detail)) {
    return { code: QUOTA_EXCEEDED_CODE, message }
  }
  if (/Proxy use detected/i.test(detail)) {
    return {
      code: 'PROXY_USE_DETECTED',
      message: `${message} — the request reached the CLI-shaped endpoint without the provider's CLI headers; check that the adapter injected x-command-code-version / x-cli-environment / x-project-slug / user-agent: cli`,
    }
  }
  if (status === 401 || status === 402 || status === 403) return { code: 'AUTH', message }
  if (status === 429) return { code: 'RATE_LIMIT', message }
  if (status >= 500) return { code: 'SERVER', message }
  if (status === 0) return { code: 'SERVER', message }
  // 400 with validation/request wording: the request itself is wrong and
  // rotating keys or retrying would fail identically.
  return { code: 'INVALID_REQUEST', message }
}
