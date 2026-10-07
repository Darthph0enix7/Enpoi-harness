/** Browser network and wake-event wiring for immediate connection recovery. */
import type { ConnectionState } from './connection.ts'

/** Debounce merging the burst of events one wake produces into one reconnect attempt. */
export const WAKE_RECONNECT_DEBOUNCE_MS = 100

/** Host WebSocket Ping interval default in ms (`DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS` in packages/api/gateway/src/index.ts). */
const HOST_HEARTBEAT_INTERVAL_MS = 2_000

/** Missed heartbeats after which the Host terminates a socket (`MAX_MISSED_HEARTBEATS` in packages/api/gateway/src/stream-server.ts). */
const HOST_TERMINATION_MISSED_HEARTBEATS = 2

/**
 * A connected generation that has received no inbound frame for this long is
 * treated as probably dead on wake. Derived from the Host's heartbeat policy:
 * {@link HOST_TERMINATION_MISSED_HEARTBEATS} × {@link HOST_HEARTBEAT_INTERVAL_MS}.
 * The window counts every frame the Client receives on any Remote stream. The
 * Host heartbeat itself is a WebSocket protocol Ping, which browser script
 * cannot observe, so a browser generation carrying no application traffic
 * reaches this window while still healthy; the wake path then errs toward one
 * reconnect. A Host-configured `websocketHeartbeatIntervalMs` override is not
 * visible to the Client, so this default-derived window always applies.
 */
export const WAKE_STALE_THRESHOLD_MS = HOST_HEARTBEAT_INTERVAL_MS * HOST_TERMINATION_MISSED_HEARTBEATS

/** Connection recovery operations driven by browser network and wake events. */
export interface BrowserNetworkController {
  /** Suspend automatic retries while offline; restart them when the network returns. */
  setNetworkAvailable(available: boolean): void
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /**
   * Whether the connected generation has gone without an inbound frame long enough to treat its socket as probably dead.
   * @param thresholdMs - staleness window in milliseconds.
   */
  isProbablyStale(thresholdMs: number): boolean
}

/** Window surface consumed by {@link watchBrowserNetwork}. */
interface BrowserWakeWindow {
  readonly navigator?: { readonly onLine?: boolean }
  addEventListener(type: 'online' | 'offline' | 'pageshow', listener: () => void): void
  removeEventListener(type: 'online' | 'offline' | 'pageshow', listener: () => void): void
}

/** Document surface consumed by {@link watchBrowserNetwork}. */
interface BrowserWakeDocument {
  readonly visibilityState?: string
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Bind browser network and wake events to connection recovery.
 *
 * `online` and `offline` drive `setNetworkAvailable`. A visible
 * `visibilitychange` or `pageshow` (including bfcache restores) requests one
 * immediate reconnect, debounced across the burst one wake produces; the
 * attempt is skipped before the first outcome, while a connected generation
 * has received an inbound frame within {@link WAKE_STALE_THRESHOLD_MS}, or
 * while the browser reports no network access. A runtime without these events
 * keeps the controller's backoff loop as its only recovery path.
 *
 * @param controller - recovery operations of the owned connection loop.
 * @param getState - current recovery state, read when a wake attempt fires.
 * @returns disposer removing every listener and cancelling a pending attempt.
 */
export function watchBrowserNetwork(
  controller: BrowserNetworkController,
  getState: () => ConnectionState | undefined,
): () => void {
  const win = (globalThis as { readonly window?: BrowserWakeWindow }).window
  const nav = win?.navigator
  if (win === undefined || nav === undefined || nav.onLine === undefined) return () => {}
  const doc = (globalThis as { readonly document?: BrowserWakeDocument }).document
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  const cancelWake = (): void => {
    if (wakeTimer === undefined) return
    clearTimeout(wakeTimer)
    wakeTimer = undefined
  }
  /**
   * A pending backoff always publishes a state, so `undefined` means the first
   * attempt is still in flight. A connected generation needs recovery only
   * once it has gone stale; a fresh one is the healthy path.
   */
  const needsRecovery = (): boolean => {
    const state = getState()
    if (state === undefined) return false
    if (state !== 'connected') return true
    return controller.isProbablyStale(WAKE_STALE_THRESHOLD_MS)
  }
  const attemptWake = (): void => {
    wakeTimer = undefined
    if (nav.onLine !== true || !needsRecovery()) return
    controller.reconnect()
  }
  const scheduleWake = (): void => {
    if (wakeTimer !== undefined || nav.onLine !== true || !needsRecovery()) return
    wakeTimer = setTimeout(attemptWake, WAKE_RECONNECT_DEBOUNCE_MS)
  }
  const online = (): void => { controller.setNetworkAvailable(true) }
  const offline = (): void => {
    cancelWake()
    controller.setNetworkAvailable(false)
  }
  const pageShow = (): void => { scheduleWake() }
  const removeDocumentListeners: Array<() => void> = []
  if (doc !== undefined) {
    const visibilityChange = (): void => {
      if (doc.visibilityState !== 'visible') return
      scheduleWake()
    }
    doc.addEventListener('visibilitychange', visibilityChange)
    removeDocumentListeners.push(() => { doc.removeEventListener('visibilitychange', visibilityChange) })
  }
  controller.setNetworkAvailable(nav.onLine)
  win.addEventListener('online', online)
  win.addEventListener('offline', offline)
  win.addEventListener('pageshow', pageShow)
  return () => {
    cancelWake()
    win.removeEventListener('online', online)
    win.removeEventListener('offline', offline)
    win.removeEventListener('pageshow', pageShow)
    for (const remove of removeDocumentListeners) remove()
  }
}
