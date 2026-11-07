/** Restartable fixed-interval poll: every start runs one immediate tick, then one per interval. */
export interface IntervalPoll {
  /** Run one tick now and begin the interval; a second call while active is a no-op. */
  start(): void
  /** Stop the interval; a later start ticks immediately again. */
  stop(): void
  /** Whether the interval is currently running. */
  readonly active: boolean
}

/**
 * Build one pauseable interval. Hidden editor tabs and backgrounded pages stop
 * it instead of waking every second for a host `fsStat` they cannot display.
 * @param tick - the work one interval tick performs.
 * @param intervalMs - interval between ticks after the immediate one.
 * @returns the start/stop handle.
 */
export function createIntervalPoll(tick: () => void, intervalMs = 1000): IntervalPoll {
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    start(): void {
      if (timer !== undefined) return
      tick()
      timer = setInterval(tick, intervalMs)
    },
    stop(): void {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    get active(): boolean {
      return timer !== undefined
    },
  }
}
