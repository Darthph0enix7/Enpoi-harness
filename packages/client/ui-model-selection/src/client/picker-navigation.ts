/**
 * Keyboard navigation helpers for the model picker list.
 *
 * Collapsed sections do not render their rows, so the focus walk only sees
 * visible, selectable rows. Rule-hidden rows carry no navigation marker and
 * therefore cannot receive focus. Type-ahead searches the same visible set by
 * the model name recorded on each row.
 */

/** Idle time after which type-ahead starts a fresh buffer. */
export const TYPE_AHEAD_RESET_MS = 600

/** Which edge or direction a keyboard move targets. */
export type PickerNavMove = 'next' | 'previous' | 'first' | 'last'

/** One type-ahead keystroke state. */
export interface TypeAheadState {
  /** Characters typed since the last reset, lower-cased. */
  buffer: string
  /** Timestamp of the last keystroke. */
  at: number
}

/**
 * Every visible navigation target under the picker's scroll container.
 * @param root - the scrolling list element, or null before it mounts.
 * @returns focusable row and header controls in document order.
 */
export function pickerNavTargets(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return []
  return [...root.querySelectorAll<HTMLElement>('[data-model-nav]')]
    .filter(element => !element.hasAttribute('disabled'))
}

/**
 * Move focus to the next, previous, first, or last visible row.
 * @param root - the scrolling list element.
 * @param move - direction or edge to land on.
 * @returns the focused element, or null when the list has no visible rows.
 */
export function movePickerFocus(root: HTMLElement | null, move: PickerNavMove): HTMLElement | null {
  const targets = pickerNavTargets(root)
  if (targets.length === 0) return null
  const current = document.activeElement
  const index = current instanceof HTMLElement ? targets.indexOf(current) : -1
  const nextIndex = move === 'first'
    ? 0
    : move === 'last'
      ? targets.length - 1
      : move === 'next'
        ? index < 0 || index === targets.length - 1 ? 0 : index + 1
        : index <= 0 ? targets.length - 1 : index - 1
  const target = targets[nextIndex]
  /* v8 ignore next 2 -- nextIndex is bounded by the non-empty targets array; the guard satisfies noUncheckedIndexedAccess. */
  if (target === undefined) return null
  target.focus()
  return target
}

/**
 * Append one printable key to the type-ahead buffer, resetting an aged buffer.
 * @param state - buffer before the keystroke.
 * @param key - the printable key value.
 * @param now - current timestamp in milliseconds.
 * @returns the next buffer and the keyboard's activation time.
 */
export function typeAheadQuery(state: TypeAheadState, key: string, now: number): TypeAheadState {
  const aged = now - state.at > TYPE_AHEAD_RESET_MS
  const buffer = aged ? key.toLowerCase() : state.buffer + key.toLowerCase()
  return { buffer, at: now }
}

/**
 * Find the next row whose name starts with the type-ahead buffer.
 * @param targets - visible navigation targets in document order.
 * @param query - lower-cased type-ahead buffer.
 * @param current - element that currently has focus, when it is a target.
 * @returns the matching target after the current position, wrapping once.
 */
export function nextTypeAheadTarget(
  targets: readonly HTMLElement[],
  query: string,
  current: HTMLElement | null,
): HTMLElement | null {
  if (query === '') return null
  const from = current === null ? -1 : targets.indexOf(current)
  const start = from + 1
  for (const target of [...targets.slice(start), ...targets.slice(0, start)]) {
    const name = target.dataset.modelName
    if (name === undefined) continue
    if (typeAheadMatches(name, query)) return target
  }
  return null
}

/**
 * Match a type-ahead buffer against the display name's start or any segment
 * start, so `p` reaches "DeepSeek-V4-Pro" without retyping the prefix.
 * @param name - lower-cased model name recorded on the row.
 * @param query - lower-cased type-ahead buffer.
 * @returns whether the row should receive focus.
 */
function typeAheadMatches(name: string, query: string): boolean {
  if (name.startsWith(query)) return true
  return name.split(/[\s\-_/]+/).some(segment => segment.startsWith(query))
}
