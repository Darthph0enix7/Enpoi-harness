/**
 * enpoi: reconnect timing for terminal sockets. The browser terminal's own
 * socket is independent of the Gateway mux, so its retry ladder mirrors the
 * Connection package: exponential caps with 50%–100% jitter and a stability
 * window that resets the ladder only after a socket stayed open.
 */

/** Default first-retry delay cap for a terminal socket. */
export const TERMINAL_RECONNECT_BASE_MS = 500

/** Default maximum retry delay cap for a terminal socket. */
export const TERMINAL_RECONNECT_MAX_MS = 10_000

/** Default continuous-open window before a lost terminal socket resets its ladder. */
export const TERMINAL_STABLE_CONNECTION_MS = 30_000

/** Default application ping interval that keeps an idle terminal socket alive. */
export const TERMINAL_KEEPALIVE_INTERVAL_MS = 20_000

/** Tunables of one terminal socket's reconnect and keepalive timers. */
export interface TerminalSocketTiming {
  /** First-retry delay cap in milliseconds. */
  readonly reconnectBaseMs: number
  /** Maximum retry delay cap in milliseconds. */
  readonly reconnectMaxMs: number
  /** Continuous-open window that resets the retry ladder. */
  readonly stableConnectionMs: number
  /** Application ping interval; 0 disables the keepalive. */
  readonly keepaliveIntervalMs: number
  /** Uniform [0, 1) source for retry jitter. */
  readonly random: () => number
}

/** Caller-supplied overrides; omitted fields use the defaults above. */
export interface TerminalSocketTimingOptions {
  /** First-retry delay cap in milliseconds. Default: 500. */
  reconnectBaseMs?: number
  /** Maximum retry delay cap in milliseconds. Default: 10000. */
  reconnectMaxMs?: number
  /** Continuous-open window that resets the retry ladder. Default: 30000. */
  stableConnectionMs?: number
  /** Application ping interval in milliseconds; 0 disables it. Default: 20000. */
  keepaliveIntervalMs?: number
  /** Uniform [0, 1) source for retry jitter; defaults to `Math.random`. */
  random?: () => number
}

/** Resolve one positive finite timing field, failing loud on a disabling value. */
function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`enpoi-terminal: ${name} must be a non-negative finite number`)
  }
  return resolved
}

/**
 * Validate terminal socket timing before the first connection.
 * @param options - optional overrides.
 * @returns complete timing with defaults applied.
 */
export function resolveTerminalSocketTiming(
  options: TerminalSocketTimingOptions = {},
): TerminalSocketTiming {
  const reconnectBaseMs = positive(options.reconnectBaseMs, TERMINAL_RECONNECT_BASE_MS, 'reconnectBaseMs')
  const reconnectMaxMs = positive(options.reconnectMaxMs, TERMINAL_RECONNECT_MAX_MS, 'reconnectMaxMs')
  if (reconnectBaseMs === 0 || reconnectMaxMs < reconnectBaseMs) {
    throw new RangeError('enpoi-terminal: reconnectMaxMs must be at least a positive reconnectBaseMs')
  }
  return {
    reconnectBaseMs,
    reconnectMaxMs,
    stableConnectionMs: positive(options.stableConnectionMs, TERMINAL_STABLE_CONNECTION_MS, 'stableConnectionMs'),
    keepaliveIntervalMs: positive(options.keepaliveIntervalMs, TERMINAL_KEEPALIVE_INTERVAL_MS, 'keepaliveIntervalMs'),
    random: options.random ?? Math.random,
  }
}

/**
 * Delay before retry `attempt` (1-based): 50%–100% of the exponential cap.
 * @param attempt - consecutive retry number.
 * @param timing - resolved caps and jitter source.
 * @returns the delay in milliseconds.
 */
export function terminalReconnectDelay(attempt: number, timing: TerminalSocketTiming): number {
  const exponent = Math.max(0, attempt - 1)
  const cap = Math.min(timing.reconnectMaxMs, timing.reconnectBaseMs * 2 ** exponent)
  return cap / 2 + timing.random() * (cap / 2)
}
