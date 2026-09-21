/**
 * Section-level status line for the Dynamic settings panels.
 *
 * A failure raised by any panel lives here instead of in panel-local state, so
 * it survives that panel unmounting on a tab switch; `DynamicSettings` renders
 * the single message once above the active panel. A panel clears it when the
 * operator starts a new action.
 */
import { useSyncExternalStore } from 'react'

let message: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Publish one operator-facing status line.
 * @param next - the message to show, or `null` to clear it.
 */
export function setStatus(next: string | null): void {
  if (next === message) return
  message = next
  emit()
}

/**
 * Synchronous reader of the current status line.
 * @returns the latest message, or `null`.
 */
export function getStatus(): string | null {
  return message
}

function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Reactive status reader for the settings section.
 * @returns the latest message, or `null`.
 */
export function useStatus(): string | null {
  return useSyncExternalStore(subscribeStatus, getStatus)
}
