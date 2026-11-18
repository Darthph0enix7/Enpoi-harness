/**
 * Structural helpers shared by the peer-routing modules.
 *
 * @module dsh-enpoi-peer-routing/util
 */

/** Whether one value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
export function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
