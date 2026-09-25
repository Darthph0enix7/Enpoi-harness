/**
 * Coalesced `enpoi-orchestration` settings reads shared by this package's
 * settings-backed caches (persona, params, permissions, roles, capabilities).
 *
 * Every store reads through {@link readEnpoiNamespace}: one in-flight
 * `settings.describe` is shared by all concurrent callers, so several stores
 * re-reading in the same tick produce exactly one request. The triggers that
 * can miss a pushed `settings/document-updated` — a transport reconnect, the
 * tab becoming visible, a view mounting on a stale cache — call
 * {@link requestSettingsRefresh}, whose short debounce folds a burst into one
 * fan-out over the registered stores. A read that answers the revision the
 * last apply already saw changes nothing, and the stores skip their notify.
 */

/** One describe view of the enpoi-orchestration namespace, structural subset. */
export interface EnpoiNamespaceView {
  ns?: string
  /** Monotonic revision the namespace was read at; the whole-document fence. */
  revision?: number
  value?: Record<string, unknown>
  user?: Record<string, unknown>
}

/** One registered store re-read the triggers fan out to. */
export type SettingsRefreshApplier = () => void | Promise<void>

/** Trigger-burst debounce: a reconnect and a visibility flip fold into one read. */
const TRIGGER_DEBOUNCE_MS = 50

/** `document.visibilitychange` re-reads at most once per this window. */
const VISIBILITY_THROTTLE_MS = 2_000

/** A view mounting sooner than this after the last successful read reuses the cache. */
export const SETTINGS_MOUNT_STALE_MS = 2_000

let readSeq = 0
let inFlight: Promise<EnpoiNamespaceView | undefined> | undefined
let lastSuccessAt = 0
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let lastVisibleAt = 0
const appliers = new Map<string, SettingsRefreshApplier>()

/** Read the namespace through the live gateway, preferring the wire root's shared coalesced describe. */
async function describeEnpoiNamespace(): Promise<EnpoiNamespaceView | undefined> {
  readSeq += 1
  const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  if (typeof shared === 'function') {
    const value = await (shared as () => Promise<{ namespaces?: readonly unknown[] } | undefined>)()
    const namespaces = value?.namespaces
    return Array.isArray(namespaces)
      ? (namespaces as EnpoiNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
      : undefined
  }
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `enpoi-describe-${readSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json: unknown = await res.json()
  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
  return Array.isArray(namespaces)
    ? (namespaces as EnpoiNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
    : undefined
}

/**
 * Read the namespace, sharing one in-flight request with every concurrent
 * caller. A failed or malformed answer resolves `undefined`; the stores keep
 * their last snapshot.
 * @returns the enpoi-orchestration namespace view, or undefined.
 */
export function readEnpoiNamespace(): Promise<EnpoiNamespaceView | undefined> {
  if (inFlight === undefined) {
    inFlight = describeEnpoiNamespace()
      .then((view) => {
        if (view !== undefined) lastSuccessAt = Date.now()
        return view
      })
      .finally(() => {
        inFlight = undefined
      })
  }
  return inFlight
}

/**
 * Register one store's re-read under a stable key; a later registration for
 * the same key replaces the earlier one.
 * @param key - stable store name.
 * @param applier - the store's re-read.
 * @returns unregister function; it clears the row only while it still owns it.
 */
export function registerSettingsRefresh(key: string, applier: SettingsRefreshApplier): () => void {
  appliers.set(key, applier)
  return () => {
    if (appliers.get(key) === applier) appliers.delete(key)
  }
}

/** Fan one re-read out to every registered store (they share the in-flight describe). */
async function refreshRegisteredStores(): Promise<void> {
  const pending: Array<void | Promise<void>> = []
  for (const applier of appliers.values()) pending.push(applier())
  await Promise.all(pending)
}

/**
 * Schedule one debounced re-read of every registered store. A burst of
 * triggers folds into one fan-out; the fan-out always reads, even when some
 * other store's read landed first — that read is not this fan-out's, and
 * swallowing the trigger would leave the other stores on their stale snapshot.
 */
export function requestSettingsRefresh(): void {
  if (debounceTimer !== undefined) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    void refreshRegisteredStores()
  }, TRIGGER_DEBOUNCE_MS)
}

/**
 * The transport generation reset (live wiring: `ctx.on('connection/reset', …)`):
 * a page that reconnected may have missed pushes while the socket was down.
 */
export function handleSettingsReconnect(): void {
  requestSettingsRefresh()
}

/**
 * `document.visibilitychange`: a tab that becomes visible may have missed
 * pushes while backgrounded. Throttled so focus churn cannot storm the host.
 */
export function handleSettingsVisibility(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  const now = Date.now()
  if (now - lastVisibleAt < VISIBILITY_THROTTLE_MS) return
  lastVisibleAt = now
  requestSettingsRefresh()
}

/**
 * Attach the tab re-activation trigger to the document.
 * @returns disposer that removes the listener.
 */
export function installSettingsVisibilityListener(): () => void {
  if (typeof document === 'undefined') return () => {}
  const listener = (): void => { handleSettingsVisibility() }
  document.addEventListener('visibilitychange', listener)
  return () => { document.removeEventListener('visibilitychange', listener) }
}

/**
 * Whether a read succeeded within the last `maxAgeMs`.
 * @param maxAgeMs - the freshness window in milliseconds.
 * @returns whether the cache is current enough to paint without a read.
 */
export function isSettingsCacheFresh(maxAgeMs: number): boolean {
  return lastSuccessAt !== 0 && Date.now() - lastSuccessAt < maxAgeMs
}

/**
 * View-mount path: a fresher cache paints without a request; a stale one
 * schedules the shared re-read.
 * @param maxAgeMs - the freshness window in milliseconds.
 */
export function ensureSettingsFresh(maxAgeMs: number): void {
  if (isSettingsCacheFresh(maxAgeMs)) return
  requestSettingsRefresh()
}
