/**
 * enpoi-diagnostics — deterministic incident fingerprinting (doc 68 §L2).
 *
 * Fingerprinting is statistics-driven and contains no model: the message text
 * is normalized (ids, uuids, paths, numbers, durations, and timestamps become
 * placeholders), then hashed with its subject (kind + subsystem) so the same
 * failure always lands on the same stable fingerprint. The first-ever sighting
 * of a fingerprint is itself a signal; every recurrence bumps the pattern
 * rollup instead of creating an indistinguishable twin.
 *
 * @module dsh-enpoi-diagnostics/fingerprint
 */

import { createHash } from 'node:crypto'

/** Longest normalized text retained before hashing (larger inputs hash equal). */
export const MAX_NORMALIZED_CHARS = 400

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HEX_ID_RE = /\b(?:0x)?[0-9a-f]{16,}\b/gi
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g
const DURATION_RE = /\b\d+(?:\.\d+)?\s?(?:milliseconds?|msec|minutes?|mins|min|seconds?|secs|sec|hours?|hrs|hr|ms|m|h|s)\b/gi
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/](?:[\w.@+~-]+|\.{2})){2,}[\\/]?/g
const NUMBER_RE = /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g

/** One fingerprinted message: the normalized form, its stable hash, and its code. */
export interface Fingerprinted {
  /** Placeholder-substituted text actually hashed (never prompt content by construction). */
  readonly normalized: string
  /** Stable 16-hex identity; equal fingerprints are the same pattern. */
  readonly fingerprint: string
  /** Human-facing stable code derived from the same digest (e.g. `D1A2B3C`). */
  readonly code: string
}

/**
 * Normalize free text for stable comparison: ids, uuids, paths, numbers,
 * durations, and timestamps are replaced by placeholders and whitespace is
 * collapsed. The result is idempotent enough to hash twice safely.
 *
 * @param input - raw message text (may be truncated by the caller).
 * @returns the normalized text, capped at {@link MAX_NORMALIZED_CHARS}.
 */
export function normalizeMessage(input: string): string {
  let text = String(input ?? '')
  try {
    text = text.normalize('NFKC')
  } catch {
    // Exotic lone surrogates can reject normalization; the raw text still hashes.
  }
  text = text
    .replace(UUID_RE, '<uuid>')
    .replace(HEX_ID_RE, '<hex>')
    .replace(ISO_TS_RE, '<ts>')
    .replace(DURATION_RE, '<dur>')
    .replace(PATH_RE, '<path>')
    .replace(NUMBER_RE, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, MAX_NORMALIZED_CHARS)
}

/**
 * Fingerprint one message under its subject (kind, subsystem) so unrelated
 * subsystems never share a pattern.
 *
 * @param subject - stable scope for the hash, e.g. `log:dsh-mcp` or `tool-error:fs_read`.
 * @param message - raw message text.
 * @returns normalized text, fingerprint, and stable code.
 */
export function fingerprintMessage(subject: string, message: string): Fingerprinted {
  const normalized = normalizeMessage(message)
  const digest = createHash('sha256').update(`${subject}\u0000${normalized}`).digest('hex')
  return {
    normalized,
    fingerprint: digest.slice(0, 16),
    code: `D${digest.slice(0, 6).toUpperCase()}`,
  }
}
