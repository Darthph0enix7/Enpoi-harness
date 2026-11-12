/**
 * Process-local attempt-activity notifications.
 *
 * A provider can keep an attempt alive without producing a stream chunk:
 * gateways emit SSE comment frames and providers emit empty reasoning updates.
 * An adapter that observes those raw bytes reports a pulse through
 * {@link reportAttemptActivity} on the request's own `options.signal`; the
 * model-chain pre-commit timer subscribes with {@link onAttemptActivity} and
 * re-arms instead of treating provider silence as a dead route.
 *
 * Nothing here is persisted, serialized, forwarded to a consumer, or added to a
 * request: registrations live in process memory keyed by the attempt's
 * AbortSignal, and a pulse for an aborted or disposed attempt is ignored.
 *
 * @module @deepseek-ai/dsh-llm/attempt-activity
 */

/** One attempt-activity subscriber. */
type ActivityListener = () => void

/** Live listeners per attempt signal; a signal's entry disappears with its last registration. */
const listenersBySignal = new WeakMap<AbortSignal, Set<ActivityListener>>()

/**
 * Subscribe to raw provider activity for the attempt that owns `signal`.
 *
 * Registering against a missing or already-aborted signal returns a no-op
 * disposer. Adapters report on the same `options.signal` they receive, so a
 * stale attempt never reaches a later attempt's listeners.
 * @param signal - attempt-scoped signal carrying the request.
 * @param listener - called synchronously for every activity pulse.
 * @returns an idempotent disposer that removes this listener.
 */
export function onAttemptActivity(signal: AbortSignal | undefined, listener: ActivityListener): () => void {
  if (signal === undefined || signal.aborted) return () => {}
  let listeners = listenersBySignal.get(signal)
  if (listeners === undefined) {
    listeners = new Set()
    listenersBySignal.set(signal, listeners)
  }
  const registered = listeners
  registered.add(listener)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (!registered.delete(listener)) return
    if (registered.size === 0) listenersBySignal.delete(signal)
  }
}

/**
 * Report one raw provider activity pulse for the attempt that owns `signal`.
 *
 * A pulse after the attempt aborted or disposed its listeners is ignored. A
 * throwing listener is logged and skipped: an observer never breaks the
 * adapter's read loop.
 * @param signal - attempt-scoped signal carrying the request.
 */
export function reportAttemptActivity(signal: AbortSignal | undefined): void {
  if (signal === undefined || signal.aborted) return
  const listeners = listenersBySignal.get(signal)
  if (listeners === undefined) return
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error: unknown) {
      // A liveness observer must never break the provider's read loop, and a
      // broken stderr must not turn its diagnostic into a second failure.
      try {
        process.stderr.write(`[llm] attempt activity listener failed: ${error instanceof Error ? error.message : String(error)}\n`)
      } catch (_unwritableActivityDiagnostic) {
        // The observer failure is already contained.
      }
    }
  }
}
