/** Browser network and wake-event wiring for connection recovery. */
import type { ConnectionState } from './connection.ts'
import {
  DEFAULT_WAKE_RECONNECT_DEBOUNCE_MS,
  DEFAULT_WAKE_STALE_THRESHOLD_MS,
  resolveConnectionConfig,
  type ConnectionRecoveryConfig,
} from '../recovery-config.ts'

/** Debounce merging the burst of events one wake produces into one reconnect attempt. */
export const WAKE_RECONNECT_DEBOUNCE_MS = DEFAULT_WAKE_RECONNECT_DEBOUNCE_MS

/**
 * A connected generation that has received no inbound frame for this long is
 * treated as probably dead on wake. The default is 30 s, deliberately above a
 * plausible single slow-frame transit and no longer a copy of two Host
 * heartbeat intervals; a deployment that knows its Host heartbeat budget can
 * override `wakeStaleThresholdMs` through the recovery options. The window
 * counts every frame the Client receives on any Remote stream, including the
 * Host's capability-negotiated application heartbeat.
 */
export const WAKE_STALE_THRESHOLD_MS = DEFAULT_WAKE_STALE_THRESHOLD_MS

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
  /**
   * Whether the connected generation ever received an application heartbeat
   * frame. A generation whose Host never sent one must not be replaced by the
   * silence watchdog alone: an older Host ignores the negotiated heartbeat
   * request, so a merely idle generation looks stale every window. A carrier
   * that cannot observe heartbeats omits this member, and the watchdog keeps
   * its legacy frame-staleness behavior.
   */
  hasObservedInboundHeartbeat?(): boolean
  /**
   * Bounded per-tab offset added to the wake reconnect debounce.
   * @returns milliseconds in [0, the configured stagger cap); omitted means 0.
   */
  wakeJitterMs?(): number
  /**
   * Elapsed time of the handshake currently in flight, or undefined while no
   * physical attempt is running (for example during backoff or offline).
   * @returns milliseconds since the current generation started.
   */
  connectingForMs(): number | undefined
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
 * `online` and `offline` are debounced by `networkDebounceMs`, so an
 * interface flap does not abort a healthy generation or restart the retry
 * ladder several times. A visible `visibilitychange` or `pageshow` (including
 * bfcache restores) requests one immediate reconnect, debounced across the
 * burst one wake produces. A wake skips the request before the first outcome,
 * while a connected generation has received a frame within
 * `wakeStaleThresholdMs`, while the browser reports offline, or while a
 * handshake started less than `wakeConnectingGraceMs` ago; a generation
 * waiting in backoff or disconnected is still replaced at once.
 *
 * One low-frequency watchdog reconnects a connected generation that received
 * no frame for `watchdogStaleMs`, coalescing repeated ticks into one request.
 * It arms only for a generation that reported at least one inbound heartbeat
 * frame: a Host that ignores the negotiated heartbeat request never sends one,
 * and such an idle generation keeps relying on host close, wake, and online
 * recovery instead of a reconnect every window.
 *
 * @param controller - recovery operations of the owned connection loop.
 * @param getState - current recovery state, read when a timer fires.
 * @param config - validated recovery timing overrides.
 * @returns disposer removing every listener and cancelling every pending timer.
 */
export function watchBrowserNetwork(
  controller: BrowserNetworkController,
  getState: () => ConnectionState | undefined,
  config: ConnectionRecoveryConfig = {},
): () => void {
  const win = (globalThis as { readonly window?: BrowserWakeWindow }).window
  const nav = win?.navigator
  if (win === undefined || nav === undefined || nav.onLine === undefined) return () => {}
  const doc = (globalThis as { readonly document?: BrowserWakeDocument }).document
  const resolved = resolveConnectionConfig(config)
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let networkTimer: ReturnType<typeof setTimeout> | undefined
  let reportedAvailable = nav.onLine
  let watchdogFired = false
  const cancelWake = (): void => {
    if (wakeTimer === undefined) return
    clearTimeout(wakeTimer)
    wakeTimer = undefined
  }
  const cancelNetwork = (): void => {
    if (networkTimer === undefined) return
    clearTimeout(networkTimer)
    networkTimer = undefined
  }
  /**
   * A pending backoff always publishes a state, so `undefined` means the first
   * attempt is still in flight. A connected generation needs recovery only
   * once it has gone stale; a fresh one is the healthy path. A connecting
   * generation is replaced at once only when no handshake is in flight
   * (backoff) or when that handshake already exceeded its wake grace.
   */
  const needsRecovery = (): boolean => {
    const state = getState()
    if (state === undefined) return false
    if (state === 'connected') return controller.isProbablyStale(resolved.wakeStaleThresholdMs)
    if (state === 'disconnected') return true
    const connectingFor = controller.connectingForMs()
    return connectingFor === undefined || connectingFor >= resolved.wakeConnectingGraceMs
  }
  const attemptWake = (): void => {
    wakeTimer = undefined
    if (nav.onLine !== true || !needsRecovery()) return
    controller.reconnect()
  }
  const scheduleWake = (): void => {
    if (wakeTimer !== undefined || nav.onLine !== true || !needsRecovery()) return
    wakeTimer = setTimeout(attemptWake, resolved.wakeReconnectDebounceMs + (controller.wakeJitterMs?.() ?? 0))
  }
  /** Apply the network state the browser reports when the debounce closes. */
  const applyNetwork = (): void => {
    networkTimer = undefined
    const available = nav.onLine === true
    if (available === reportedAvailable) return
    reportedAvailable = available
    controller.setNetworkAvailable(available)
  }
  const scheduleNetwork = (): void => {
    if (networkTimer !== undefined) return
    networkTimer = setTimeout(applyNetwork, resolved.networkDebounceMs)
  }
  const online = (): void => {
    if (reportedAvailable && nav.onLine === true) {
      cancelNetwork()
      return
    }
    scheduleNetwork()
  }
  const offline = (): void => {
    cancelWake()
    scheduleNetwork()
  }
  const pageShow = (): void => { scheduleWake() }
  const watchdog = setInterval(() => {
    if (nav.onLine !== true || getState() !== 'connected'
      || controller.hasObservedInboundHeartbeat?.() === false
      || !controller.isProbablyStale(resolved.watchdogStaleMs)) {
      watchdogFired = false
      return
    }
    if (watchdogFired) return
    watchdogFired = true
    controller.reconnect()
  }, resolved.watchdogIntervalMs)
  const removeDocumentListeners: Array<() => void> = []
  if (doc !== undefined) {
    const visibilityChange = (): void => {
      if (doc.visibilityState !== 'visible') return
      scheduleWake()
    }
    doc.addEventListener('visibilitychange', visibilityChange)
    removeDocumentListeners.push(() => { doc.removeEventListener('visibilitychange', visibilityChange) })
  }
  controller.setNetworkAvailable(reportedAvailable)
  win.addEventListener('online', online)
  win.addEventListener('offline', offline)
  win.addEventListener('pageshow', pageShow)
  return () => {
    cancelWake()
    cancelNetwork()
    clearInterval(watchdog)
    win.removeEventListener('online', online)
    win.removeEventListener('offline', offline)
    win.removeEventListener('pageshow', pageShow)
    for (const remove of removeDocumentListeners) remove()
  }
}
