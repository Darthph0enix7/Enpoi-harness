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
 * Deterministic request-shape rejections. The gateway reports some of these
 * with a 5xx status (or in-band, status `0`) although the body is a validation
 * sentence: retrying or rotating the identical request cannot succeed, so a
 * "500" carrying one of these is a request bug, not a transient fault. Each
 * pattern is narrow on purpose — the gateway's own dangling-tool-call
 * sentence, a schema key, a message-array validation clause, or the
 * client-error type — so ordinary transient 5xx bodies ("internal error",
 * "upstream timeout", plain HTML) keep their SERVER classification and retry.
 */
const REQUEST_SHAPE_PATTERNS: readonly RegExp[] = [
  // Gateway sentence for a history whose assistant tool call has no result.
  /tool result is missing for tool call/i,
  // Tool-result pairing/schema validation.
  /tool_call_id/i,
  // Provider-style message-array validation ("messages[2]: must be an object").
  // Plural only: the JSON key `"message"` plus a value starting with "Invalid"
  // must not match, or a transient 5xx like `{"message":"Invalid upstream
  // response"}` would stop rotating.
  /\bmessages\b[^.!?\n]{0,80}\b(?:must|required|invalid)\b/i,
  // OpenAI-shaped client-error type the gateway passes through.
  /invalid_request_error/i,
]

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
  // Auth and rate-limit statuses win over a validation-looking body: OpenAI-
  // shaped 401s carry `type: "invalid_request_error"` for a bad key, and a 429
  // is a rate condition regardless of wording — both must keep rotating.
  if (status === 401 || status === 402 || status === 403) return { code: 'AUTH', message }
  if (status === 429) return { code: 'RATE_LIMIT', message }
  // Status-independent request-shape check, before SERVER (and status 0): a
  // 500 whose body states a validation failure is still a request bug, because
  // the same body fails identically on every identity. The raw body is
  // included because the client-error `type` field is outside `message`.
  const shapeText = `${detail}\n${body}`
  if (REQUEST_SHAPE_PATTERNS.some(pattern => pattern.test(shapeText))) {
    return { code: 'INVALID_REQUEST', message }
  }
  if (status >= 500) return { code: 'SERVER', message }
  if (status === 0) return { code: 'SERVER', message }
  // 400 with validation/request wording: the request itself is wrong and
  // rotating keys or retrying would fail identically.
  return { code: 'INVALID_REQUEST', message }
}
