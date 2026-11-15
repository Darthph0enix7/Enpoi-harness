/**
 * Settings-owned projection of Connection's optional terminal diagnosis.
 * The core contract stays additive: an older Connection host without
 * `getDiagnosis` yields `undefined`, and the source subscribes to the same
 * state notifications (which carry state and diagnosis changes together).
 *
 * Free-form core diagnostics are sanitized here, before they reach shared UI:
 * control characters collapse, whitespace folds, and the detail clips to a
 * bounded length. The UI supplies localized labels and instructions; this
 * module never invents user-facing copy.
 * @module @deepseek-ai/dsh-client-ui-settings-general/src/client/connection-status
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Maximum characters of a free-form core diagnosis rendered in the details panel. */
export const CONNECTION_DIAGNOSIS_MAX_CHARS = 240

/**
 * Project the optional Connection diagnosis into a selector-hook source.
 * @param connection - installed Connection handle.
 * @returns observable diagnosis text; `undefined` when the host predates it.
 */
export function connectionDiagnosisSource(connection: ConnectionHandle): HostObservable<string | undefined> {
  return {
    getSnapshot: () => {
      try {
        return connection.state.getDiagnosis?.()
      } catch {
        // An older or branded proxy source without a readable getter is absent, not fatal.
        return undefined
      }
    },
    subscribe: listener => connection.state.subscribe(listener),
  }
}

/**
 * Sanitize one free-form core diagnosis for bounded presentation.
 * @param value - raw diagnosis from Connection.
 * @returns folded, clipped text, or undefined when empty.
 */
export function sanitizeConnectionDiagnosis(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const folded = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (folded === '') return undefined
  return folded.length <= CONNECTION_DIAGNOSIS_MAX_CHARS
    ? folded
    : `${folded.slice(0, CONNECTION_DIAGNOSIS_MAX_CHARS - 1)}…`
}
