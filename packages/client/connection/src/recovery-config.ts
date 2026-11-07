/** Shared validation for Host-configured and browser-local connection recovery. */
import z from '@deepseek-ai/schemastery'

/** Default delay before a slow handshake warning; matches the documented 3-second warning. */
export const DEFAULT_GENERATION_READY_WARN_MS = 3_000
/** Default bound on the debounce that merges one wake burst into a single recovery request. */
export const DEFAULT_WAKE_RECONNECT_DEBOUNCE_MS = 100
/** Default window with no inbound frame that makes a connected generation wake-stale. */
export const DEFAULT_WAKE_STALE_THRESHOLD_MS = 30_000
/** Default grace before a wake event may replace an attempt still completing its handshake. */
export const DEFAULT_WAKE_CONNECTING_GRACE_MS = 3_000
/** Default interval of the autonomous client liveness watchdog. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000
/** Default silence window the autonomous client liveness watchdog tolerates. */
export const DEFAULT_WATCHDOG_STALE_MS = 30_000
/** Default debounce applied to browser `online`/`offline` bursts. */
export const DEFAULT_NETWORK_DEBOUNCE_MS = 1_000
/** Default upper bound of the per-tab jitter added to scheduled reconnects. */
export const DEFAULT_RECONNECT_STAGGER_MS = 100
/** Default deadline for one unary RPC HTTP exchange. */
export const DEFAULT_RPC_TIMEOUT_MS = 45_000
/** Default continuous-readiness window before a lost generation resets the retry ladder. */
export const DEFAULT_STABLE_CONNECTION_MS = 30_000

/** Timing for generation readiness, retry progression, and browser recovery. */
export interface ConnectionRecoveryConfig {
  /** First-retry delay cap in ms; actual delay is 50–100% of the cap. Default: 500. */
  backoffBaseMs?: number
  /** Finite growth factor of at least 1 per failed attempt; 1 keeps a fixed cap. Default: 2. */
  backoffFactor?: number
  /** Maximum retry delay cap in ms; retries continue at this cap. Default: 10000. */
  backoffMaxMs?: number
  /**
   * Delay before reporting a slow handshake, without cancelling it. Default: 3000.
   * Omitted when readiness, failure, cancellation, or the hard deadline occurs first.
   */
  generationReadyWarnMs?: number
  /** Deadline in ms for readiness, including physical connection setup. Default: 15000. */
  generationReadyTimeoutMs?: number
  /**
   * Continuous readiness in ms before a lost generation resets the retry
   * ladder. A generation that becomes ready and then dies sooner keeps
   * climbing the jittered backoff; an explicit reconnect still restarts at 1.
   * Default: 30000.
   */
  stableConnectionMs?: number
  /** Debounce in ms merging one wake burst into one recovery request. Default: 100. */
  wakeReconnectDebounceMs?: number
  /**
   * Silence in ms after which a connected generation is treated as probably
   * dead on a wake event. Default: 30000, chosen above a plausible single
   * frame transit; never the old 4 s copy of two heartbeat intervals.
   */
  wakeStaleThresholdMs?: number
  /**
   * Grace in ms before a wake event may replace an attempt whose physical
   * handshake recently started. Default: 3000.
   */
  wakeConnectingGraceMs?: number
  /** Interval in ms of the autonomous client liveness watchdog. Default: 5000. */
  watchdogIntervalMs?: number
  /**
   * Silence in ms tolerated by the autonomous watchdog before one coalesced
   * reconnect. Default: 30000.
   */
  watchdogStaleMs?: number
  /** Debounce in ms coalescing browser `online`/`offline` bursts. Default: 1000. */
  networkDebounceMs?: number
  /**
   * Upper bound in ms of the random per-tab offset added to each wake
   * reconnect and to a retry after a generation that had reached ready, so
   * many tabs do not reconnect in lockstep. A first handshake that never
   * becomes ready keeps the plain 50%–100% retry jitter. Default: 100;
   * 0 disables the offset.
   */
  reconnectStaggerMs?: number
  /** Deadline in ms for one unary RPC HTTP exchange. Default: 45000. */
  rpcTimeoutMs?: number
}

// Browsers and Node share this maximum signed 32-bit timer delay.
const MAX_TIMER_MS = 2_147_483_647

/** Schema shared by the Host plugin and the Client's recovery input parser. */
export const ConnectionRecoveryConfigSchema: z<ConnectionRecoveryConfig> = z.object({
  backoffBaseMs: z.natural().min(1).max(MAX_TIMER_MS).default(500),
  backoffFactor: z.number().min(1).max(Number.MAX_VALUE).default(2),
  backoffMaxMs: z.natural().min(1).max(MAX_TIMER_MS).default(10_000),
  generationReadyWarnMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_GENERATION_READY_WARN_MS),
  generationReadyTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(15_000),
  stableConnectionMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_STABLE_CONNECTION_MS),
  wakeReconnectDebounceMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_WAKE_RECONNECT_DEBOUNCE_MS),
  wakeStaleThresholdMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_WAKE_STALE_THRESHOLD_MS),
  wakeConnectingGraceMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_WAKE_CONNECTING_GRACE_MS),
  watchdogIntervalMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_WATCHDOG_INTERVAL_MS),
  watchdogStaleMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_WATCHDOG_STALE_MS),
  networkDebounceMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_NETWORK_DEBOUNCE_MS),
  reconnectStaggerMs: z.natural().min(0).max(MAX_TIMER_MS).default(DEFAULT_RECONNECT_STAGGER_MS),
  rpcTimeoutMs: z.natural().min(1).max(MAX_TIMER_MS).default(DEFAULT_RPC_TIMEOUT_MS),
})

/**
 * Validate recovery input and supply every timing default before starting work.
 * @param config - Host configuration, page bootstrap data, or direct loop options.
 * @returns validated, complete recovery timing.
 */
export function resolveConnectionConfig(config: unknown = {}): Required<ConnectionRecoveryConfig> {
  const resolved = ConnectionRecoveryConfigSchema(config as ConnectionRecoveryConfig) as Required<ConnectionRecoveryConfig>
  if (!Number.isFinite(resolved.backoffFactor)) {
    throw new RangeError('connection recovery backoffFactor must be finite')
  }
  return resolved
}
