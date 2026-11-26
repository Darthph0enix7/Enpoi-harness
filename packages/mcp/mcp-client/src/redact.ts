/**
 * Secret redaction and bounded error formatting for MCP connection logs,
 * tool results, and error diagnostics.
 *
 * @module @deepseek-ai/dsh-mcp-client/redact
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Maximum code points kept in normalized MCP error messages. */
export const MAX_MCP_ERROR_CHARS = 512

/** Replacement marker substituted for redacted secret substrings. */
export const REDACTED_MARKER = '[REDACTED]'

const MAX_DYNAMIC_SECRETS = 512
/** Default credential header names, matched case-insensitively. */
export const DEFAULT_SECRET_HEADER_NAMES = ['authorization', 'proxy-authorization', 'x-api-key', 'cookie'] as const
/** Default minimum length of a credential or authorization payload. */
export const DEFAULT_SECRET_HEADER_MIN_LENGTH = 8
const SENSITIVE_ENV_NAME = /(?:key|password|secret|token|auth|bearer|credential)/i
const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic|Token|ApiKey)\s+(.+)$/i
const INLINE_AUTH_PATTERN = /\b(Bearer|Basic)\s+[-\w.~+/=]{6,}/gi

/**
 * Reject weak credentials rather than send values too short to mask safely.
 * @param value - Configured or dynamically supplied credential header value.
 * @param minimum - Minimum length of both the header and any recognized authorization payload.
 * @returns Whether the header can be sent and redacted.
 */
export function acceptsSecretHeader(value: string, minimum: number): boolean {
  const header = value.trim()
  const payload = /^(?:Bearer|Basic|Token|ApiKey)(?:\s+(.*))?$/i.exec(header)
  return header.length >= minimum && (payload === null || (payload[1] ?? '').length >= minimum)
}

/**
 * Tracks static config secrets and dynamically resolved header values so any
 * echoed token or header is scrubbed before entering logs or model results.
 */
export class SecretRedactor {
  /** A remote error can echo routing metadata even when results must preserve it. */
  hasDynamicHeaders = false
  private readonly staticSecrets = new Set<string>()
  private readonly dynamicSecrets = new Set<string>()

  constructor(private readonly parent?: SecretRedactor) {}

  /**
   * Register a configured or dynamically resolved HTTP header value.
   * @param value - HTTP header value.
   * @param dynamic - whether the value belongs to a dynamic request.
   */
  addHeader(value: string, dynamic = true): void {
    this.addEntry(value, dynamic)
  }

  /**
   * Register a configured stdio environment value.
   * @param name - environment variable name.
   * @param value - environment variable value.
   */
  addEnv(name: string, value: string): void {
    if (SENSITIVE_ENV_NAME.test(name)) this.addEntry(value, false)
  }

  private addEntry(value: string, isDynamic: boolean): void {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    this.recordSecret(trimmed, isDynamic)
    const token = AUTH_SCHEME_VALUE.exec(trimmed)?.[1]
    if (token !== undefined) this.recordSecret(token, isDynamic)
  }

  private recordSecret(secret: string, isDynamic: boolean): void {
    if (!isDynamic) {
      this.staticSecrets.add(secret)
      return
    }
    if (this.staticSecrets.has(secret)) return
    if (this.dynamicSecrets.has(secret)) {
      this.dynamicSecrets.delete(secret)
      this.dynamicSecrets.add(secret)
      return
    }
    if (this.dynamicSecrets.size >= MAX_DYNAMIC_SECRETS) {
      const oldest = this.dynamicSecrets.values().next().value
      /* v8 ignore next -- dynamicSecrets is non-empty when size >= MAX_DYNAMIC_SECRETS */
      if (oldest !== undefined) this.dynamicSecrets.delete(oldest)
    }
    this.dynamicSecrets.add(secret)
  }

  /**
   * Scrub all tracked secrets and inline bearer/basic tokens from text.
   * @param text - untrusted text from an MCP server or transport error.
   * @returns redacted text.
   */
  redact(text: string): string {
    let out = text
    const all = [...this.secrets()].sort((a, b) => b.length - a.length)
    for (const secret of all) {
      if (out.includes(secret)) {
        out = out.replaceAll(secret, REDACTED_MARKER)
      }
    }
    return out.replace(INLINE_AUTH_PATTERN, `$1 ${REDACTED_MARKER}`)
  }

  private * secrets(): Iterable<string> {
    if (this.parent !== undefined) yield* this.parent.secrets()
    yield* this.staticSecrets
    yield* this.dynamicSecrets
  }

  /**
   * Detect known credential material without mutating a schema.
   * @param text - text to test.
   * @returns whether redaction would change the text.
   */
  hasSecret(text: string): boolean {
    return this.redact(text) !== text
  }

  /**
   * Recursively redact string leaves in a lossless JSON value.
   * @param value - JSON value returned by an MCP server.
   * @returns a copy with secret substrings replaced by `[REDACTED]`.
   */
  redactJson(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.redact(value)
    if (Array.isArray(value)) return value.map(item => this.redactJson(item))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [this.redact(k), this.redactJson(v)]))
    }
    return value
  }
}

/**
 * Bound text by Unicode code points so surrogate pairs are never split.
 * @param text - input text.
 * @param maxChars - maximum code points.
 * @returns bounded text with an ellipsis when truncated.
 */
export function boundText(text: string, maxChars: number = MAX_MCP_ERROR_CHARS): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/**
 * Extract a redacted, bounded diagnostic string from an arbitrary thrown value.
 * @param error - caught thrown value.
 * @param redactor - secret redactor, if available.
 * @param fallback - fallback message when extraction yields nothing.
 * @param maxChars - maximum code points.
 * @returns bounded, secret-free diagnostic text.
 */
export function formatBoundedError(
  error: unknown,
  redactor?: SecretRedactor,
  fallback: string = 'request failed',
  maxChars: number = MAX_MCP_ERROR_CHARS,
): string {
  if (redactor?.hasDynamicHeaders === true) return boundText(fallback, maxChars)
  let raw: string
  try {
    if (error instanceof Error) {
      raw = String(error)
    } else if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
      raw = error.message
    } else {
      raw = String(error)
    }
  } catch {
    raw = fallback
  }
  const normalized = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()
  const redacted = redactor === undefined ? normalized : redactor.redact(normalized)
  const effective = redacted.length > 0 ? redacted : fallback
  return boundText(effective, maxChars)
}

/**
 * Sanitize an error for propagation without retaining a raw cause or SDK fields.
 * @param error - caught thrown value.
 * @param redactor - secret redactor.
 * @param fallback - fallback message when empty after redaction.
 * @returns a fresh redacted Error.
 */
export function sanitizeError(
  error: unknown,
  redactor: SecretRedactor,
  fallback: string = 'MCP connection error',
): Error {
  if (redactor.hasDynamicHeaders) return new Error(fallback)
  let raw: string
  try {
    raw = error instanceof Error ? error.message : String(error)
  } catch {
    return new Error(fallback)
  }
  const bounded = boundText(redactor.redact(raw).trim() || fallback)
  return new Error(bounded)
}
