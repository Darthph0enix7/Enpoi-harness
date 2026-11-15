/** Connection generation readiness, cancellation, and continuous recovery. */
import { resolveConnectionConfig, type ConnectionRecoveryConfig } from '../recovery-config.ts'

export type { ConnectionRecoveryConfig } from '../recovery-config.ts'

/** Stable Host facts delivered by one established Remote event generation. */
export interface ConnectionHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  readonly home: string
}

/** One successfully established Host generation. */
export interface ConnectionGeneration {
  /** Monotone generation number within this Client runtime. */
  readonly id: number
  /** Host facts carried by this generation's opening frame. */
  readonly host: ConnectionHostInfo
}

const MANUAL_RECONNECT = new Error('connection: manual reconnect requested')
const NETWORK_STATE_CHANGED = new Error('connection: browser network state changed')

/** Cross-bundle marker for a generation failure that automatic retry cannot repair. */
const TERMINAL_CONNECTION_FAILURE = Symbol.for('dsh.connection.terminal-failure')

/**
 * A generation failure that automatic retry cannot repair. Connection stops
 * the automatic ladder, publishes an actionable terminal diagnosis, and waits
 * for an explicit reconnect or page reload instead of retrying forever.
 */
export class ConnectionTerminalError extends Error {
  readonly [TERMINAL_CONNECTION_FAILURE] = true

  /**
   * @param message - actionable diagnosis surfaced through the state seam.
   * @param options - optional contained cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConnectionTerminalError'
  }
}

/**
 * Whether a generation failure opted out of automatic retry.
 * @param error - value rejected by a generation source.
 * @returns true for {@link ConnectionTerminalError} from any bundle copy.
 */
export function isConnectionTerminalError(error: unknown): error is ConnectionTerminalError {
  return error instanceof Error && Reflect.get(error, TERMINAL_CONNECTION_FAILURE) === true
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/** Connection lifecycle state published after the first attempt has an outcome. */
export type ConnectionState =
  | 'connected'
  | 'disconnected'
  | 'connecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source reports ready, first connect included. */
  onConnected?: (host: ConnectionHostInfo) => void
  /**
   * State transitions after the initial attempt has an outcome. Equivalent
   * state/diagnosis pairs are deduplicated.
   * @param state - recovery lifecycle state.
   * @param diagnosis - actionable detail for a terminal disconnected state.
   */
  onStateChange?: (state: ConnectionState, diagnosis?: string) => void
  /** Start one fresh physical-carrier attempt before each logical retry. */
  onReconnectRequested?: () => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts. On abort it should stop
 * delivery, release its resources, and settle promptly. A source that does not
 * settle within `settleTimeoutMs` is retired: its callbacks are ignored and
 * recovery pauses once more than `maxRetiredGenerations` retired sources
 * remain, until one settles, instead of stacking unabortable work.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @param activity - report one inbound frame of this generation, refreshing
 * the liveness timestamp {@link ConnectionController.isProbablyStale} reads;
 * calls after this generation ends are ignored.
 * @param heartbeat - optional report of one inbound application heartbeat
 * frame of this generation. It also counts as activity and arms the autonomous
 * silence watchdog for this generation; calls after this generation ends are
 * ignored. A carrier that cannot observe heartbeat frames omits it, and the
 * watchdog stays disarmed for that generation.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (
  signal: AbortSignal,
  ready: (host: ConnectionHostInfo) => void,
  activity: () => void,
  heartbeat?: () => void,
) => Promise<void>

/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * Sink exceptions do not kill the generation loop.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private activeGenerationSettlement: Promise<void> | undefined
  private retryDelay: AbortController | null = null
  private running = false
  private runToken = 0
  private lifecycle = new AbortController()
  private readonly retiredGenerations = new Set<Promise<void>>()
  private manualWakePending = false
  private manualWaiter: (() => void) | undefined
  private exhaustedDiagnosis: string | undefined
  private immediateRetry = false
  private networkAvailable = true
  private lastState: ConnectionState | undefined
  private lastDiagnosis: string | undefined
  private lastActivityAt: number | undefined
  private heartbeatObserved = false
  private staggerNextRetry = false
  private attemptStartedAt: number | undefined
  private readyAt: number | undefined
  private readonly random: () => number
  private readonly staggerMs: number
  private readonly config: Required<ConnectionRecoveryConfig>

  /**
   * @param source - generation source owned by the physical carrier.
   * @param sinks - connection-state callbacks.
   * @param config - retry, readiness, and browser recovery timing.
   * @param random - uniform [0, 1) source for retry jitter and this tab's
   * reconnect stagger; defaults to `Math.random`.
   */
  constructor(
    private readonly source: ConnectionGenerationSource,
    private readonly sinks: ConnectionSinks = {},
    config: ConnectionRecoveryConfig = {},
    random: () => number = Math.random,
  ) {
    this.config = resolveConnectionConfig(config)
    this.random = random
    this.staggerMs = random() * this.config.reconnectStaggerMs
  }

  /** Idempotent: begin the connect/pump/reconnect loop. */
  start(): void {
    if (this.running) return
    this.running = true
    const token = ++this.runToken
    this.lifecycle = new AbortController()
    this.manualWakePending = false
    this.manualWaiter = undefined
    this.exhaustedDiagnosis = undefined
    this.lastState = undefined
    this.lastDiagnosis = undefined
    void this.loop(token)
  }

  /** Stop the loop, abort the current generation source, and wake every wait. */
  stop(): void {
    this.running = false
    this.runToken += 1
    this.lifecycle.abort()
    this.wakeManualRecovery()
    const settlement = this.activeGenerationSettlement
    if (settlement !== undefined) this.retireGeneration(settlement)
    this.current?.abort()
    this.current = null
    this.retryDelay?.abort()
    this.retryDelay = null
  }

  /**
   * Reset the retry sequence and replace the current generation or retry
   * delay immediately. A terminal resource diagnosis only wakes its wait; it
   * never emits connecting or spawns work while recovery capacity is absent.
   */
  reconnect(): void {
    if (!this.running) return
    this.attempt = 0
    this.immediateRetry = true
    this.wakeManualRecovery()
    if (this.exhaustedDiagnosis !== undefined) return
    this.emitState('connecting')
    if (!this.isRunning()) return
    this.current?.abort(MANUAL_RECONNECT)
    this.retryDelay?.abort(MANUAL_RECONNECT)
  }

  /**
   * Elapsed time of the physical handshake currently in flight.
   * @returns milliseconds since the current generation source started, or
   * undefined while the controller is waiting in backoff or offline and no
   * handshake is running.
   */
  connectingForMs(): number | undefined {
    return this.attemptStartedAt === undefined ? undefined : Date.now() - this.attemptStartedAt
  }

  /**
   * Whether no inbound frame has been observed within `thresholdMs`. The
   * timestamp advances when a generation reports ready and each time its
   * source reports an inbound frame; a loop that has not reported ready yet
   * counts as stale.
   * @param thresholdMs - staleness window in milliseconds.
   * @returns true when the last observed inbound frame is older than the window.
   */
  isProbablyStale(thresholdMs: number): boolean {
    return this.lastActivityAt === undefined || Date.now() - this.lastActivityAt > thresholdMs
  }

  /**
   * Whether the current generation ever received an inbound application
   * heartbeat frame. A Host that ignores the negotiated heartbeat request
   * never reports one, so the autonomous silence watchdog must stay disarmed
   * for that generation; host close, wake, and online recovery still apply.
   * @returns true after this generation reported at least one heartbeat.
   */
  hasObservedInboundHeartbeat(): boolean {
    return this.heartbeatObserved
  }

  /**
   * Bounded per-tab offset applied by the wake scheduler so several tabs do
   * not request a wake reconnect in lockstep.
   * @returns this tab's stagger in milliseconds, in [0, `reconnectStaggerMs`).
   */
  wakeJitterMs(): number {
    return this.staggerMs
  }

  /**
   * Suspend automatic retries while offline and restart backoff when the network returns.
   * @param available - whether the browser reports network access.
   */
  setNetworkAvailable(available: boolean): void {
    if (this.networkAvailable === available) return
    this.networkAvailable = available
    // Recovery after an outage resumes the existing retry ladder. Only a
    // generation that stayed ready for `stableConnectionMs` resets it (D1).
    this.immediateRetry = false
    if (!this.running) return
    if (this.exhaustedDiagnosis !== undefined) return
    this.emitState(available ? 'connecting' : 'disconnected')
    if (!this.isRunning()) return
    this.current?.abort(NETWORK_STATE_CHANGED)
    this.retryDelay?.abort(NETWORK_STATE_CHANGED)
  }

  private backoffCap(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    return Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
  }

  private backoffDelay(attempt: number, stagger: boolean): number {
    const cap = this.backoffCap(attempt)
    return cap / 2 + this.random() * (cap / 2) + (stagger ? this.staggerMs : 0)
  }

  /** Re-read retry inputs after a potentially reentrant state sink. */
  private isRetryInterrupted(immediate: boolean): boolean {
    return this.immediateRetry || (!this.networkAvailable && !immediate)
  }

  /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
  private isRunning(): boolean {
    return this.running
  }

  /** Whether the loop invocation that captured this token still owns the controller. */
  private isCurrent(token: number): boolean {
    return this.running && token === this.runToken
  }

  /** Re-read both mutable liveness guards after a potentially reentrant sink. */
  private isGenerationActive(token: number, controller: AbortController): boolean {
    return this.isCurrent(token) && !controller.signal.aborted
  }

  private async loop(token: number): Promise<void> {
    const lifecycle = this.lifecycle
    let retry = false
    while (this.isCurrent(token) && this.lifecycle === lifecycle) {
      // A generation that ignored cancellation is fenced and counted before
      // any retry/backoff work. Exhaustion publishes a truthful terminal
      // diagnosis instead of entering a connect attempt that can never start.
      await this.awaitRecoveryCapacity(token)
      if (!this.isCurrent(token)) return

      if (!this.networkAvailable && !this.immediateRetry) {
        const retryDelay = new AbortController()
        this.retryDelay = retryDelay
        this.emitState('disconnected')
        await waitForAbort(retryDelay.signal)
        if (this.retryDelay === retryDelay) this.retryDelay = null
        if (!this.isCurrent(token)) return
        retry = true
        continue
      }

      let manualAttempt = false
      if (retry) {
        const immediate = this.immediateRetry
        this.immediateRetry = false
        if (immediate) this.attempt = 0
        manualAttempt = immediate
        const attempt = ++this.attempt
        this.emitState('connecting')
        if (!this.isCurrent(token)) return
        if (this.isRetryInterrupted(immediate)) continue
        if (!immediate) {
          const retryDelay = new AbortController()
          this.retryDelay = retryDelay
          const delay = this.backoffDelay(attempt, this.staggerNextRetry)
          this.staggerNextRetry = false
          await sleep(delay, retryDelay.signal)
          if (this.retryDelay === retryDelay) this.retryDelay = null
          if (!this.isCurrent(token)) return
          if (retryDelay.signal.aborted) continue
        }
        console.warn(`[connection] connection lost, retry #${String(attempt)}`)
        this.callSink(() => { this.sinks.onReconnectRequested?.() })
        if (!this.isCurrent(token)) return
      }

      // A terminal capacity pause leaves the published state disconnected;
      // the resumed attempt announces connecting only now that it can start.
      if (this.lastState === 'disconnected' && this.networkAvailable) this.emitState('connecting')
      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac
      this.attemptStartedAt = Date.now()
      this.readyAt = undefined
      this.heartbeatObserved = false

      let sourceReady = false
      let generationFailure: Error | undefined
      let resolveReady!: (host: ConnectionHostInfo) => void
      let rejectReady!: (error: Error) => void
      let rejectSourceLost!: (error: Error) => void
      const ready = new Promise<ConnectionHostInfo>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const sourceLost = new Promise<never>((_resolve, reject) => {
        rejectSourceLost = reject
      })
      const reportActivity = (): void => {
        if (gen !== this.generation || !this.isGenerationActive(token, ac)) return
        this.lastActivityAt = Date.now()
      }
      const reportHeartbeat = (): void => {
        if (gen !== this.generation || !this.isGenerationActive(token, ac)) return
        this.heartbeatObserved = true
        this.lastActivityAt = Date.now()
      }
      const reportReady = (host: ConnectionHostInfo): void => {
        if (sourceReady || gen !== this.generation || !this.isGenerationActive(token, ac)) return
        sourceReady = true
        reportActivity()
        resolveReady(host)
      }

      const failed = new Promise<void>((resolve) => {
        const settle = (): void => {
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        void Promise.resolve()
          .then(() => this.source(ac.signal, reportReady, reportActivity, reportHeartbeat))
          .then(
            () => {
              const error = new Error('connection generation ended')
              if (!sourceReady) rejectReady(error)
              rejectSourceLost(error)
              settle()
            },
            (error: unknown) => {
              const failure = error instanceof Error
                ? error
                : new Error('connection generation failed', { cause: error })
              generationFailure = failure
              if (!sourceReady) rejectReady(failure)
              rejectSourceLost(failure)
              settle()
            },
          )
      })

      this.activeGenerationSettlement = failed
      try {
        const host = await Promise.race([
          waitForReady(ready, this.config, ac.signal),
          sourceLost,
        ])
        if (ac.signal.aborted) throw new Error('generation aborted during readiness handshake')
        // Readiness alone is not stability: the retry ladder is reset after
        // the generation proves it survived `stableConnectionMs`.
        this.readyAt = Date.now()
        this.emitState('connected')
        // A state sink may synchronously stop this controller.
        if (this.isGenerationActive(token, ac)) {
          this.callSink(() => { this.sinks.onConnected?.(host) })
        }
      } catch (error) {
        if (!ac.signal.aborted) ac.abort(error)
      }

      // A loss reported by the source settles immediately. A generation the
      // controller aborted (reconnect, offline, readiness deadline, stop) gets
      // one bounded settlement window instead of hanging the whole loop on a
      // source that ignores cancellation.
      if (ac.signal.aborted) {
        this.attemptStartedAt = undefined
        await this.quiesceGeneration(failed, token)
      } else {
        await failed
      }
      if (this.activeGenerationSettlement === failed) this.activeGenerationSettlement = undefined
      if (!this.isCurrent(token)) {
        ac.abort()
        return
      }
      this.attemptStartedAt = undefined

      // A typed terminal source failure (for example Gateway listener-task
      // capacity) leaves a visible diagnosis and waits for an explicit retry;
      // automatic backoff would only repeat the same exhausted condition.
      if (generationFailure !== undefined && isConnectionTerminalError(generationFailure)) {
        this.emitState('disconnected', generationFailure.message)
        await this.awaitManualRecovery(token)
        if (!this.isCurrent(token)) return
        retry = true
        continue
      }

      // Only a loss of a generation that actually reached ready staggers the
      // next retry; a never-ready first handshake keeps the narrower jitter.
      this.staggerNextRetry = this.readyAt !== undefined
      if (manualAttempt) this.attempt = 0
      else if (this.readyAt !== undefined
        && Date.now() - this.readyAt >= this.config.stableConnectionMs) {
        this.attempt = 0
      }
      this.readyAt = undefined
      retry = true
    }
  }

  /**
   * Wait one bounded settlement window for the aborted source. A source that
   * settles (the documented contract) frees the next attempt immediately. A
   * source that ignores abort is retired with its callbacks already fenced by
   * the generation number and aborted signal, so a fresh generation can start
   * without its late readiness or activity leaking into the new generation.
   * @param failed - settlement promise of the generation just aborted.
   * @param token - loop epoch that owns this generation.
   */
  private async quiesceGeneration(failed: Promise<void>, token: number): Promise<void> {
    const signal = this.lifecycle.signal
    const settlementMs = this.config.settleTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    try {
      const outcome = await Promise.race([
        failed.then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => { resolve('timeout') }, settlementMs)
        }),
        new Promise<'stopped'>((resolve) => {
          if (signal.aborted) {
            resolve('stopped')
            return
          }
          onAbort = () => { resolve('stopped') }
          signal.addEventListener('abort', onAbort, { once: true })
        }),
        // A manual reconnect wakes this wait too: retry is never inert while
        // the old source is still being retired. A stale loop from a previous
        // start must not register a competing waiter or consume the current
        // loop's wake.
        ...(this.isCurrent(token)
          ? [this.waitManualWake().then(() => 'manual' as const)]
          : []),
      ])
      if (outcome !== 'settled') {
        if (outcome === 'timeout' && this.isCurrent(token)) {
          console.warn(
            `[connection] generation source did not settle within ${String(settlementMs)}ms after abort; retiring it`,
          )
        }
        // Count every aborted-but-unsettled generation, including one left
        // behind by stop() or a stale loop; a later start must not erase the
        // abandoned resource from the controller's budget.
        this.retireGeneration(failed)
      }
    } finally {
      clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Hold a new attempt while the abandoned-source allowance is exceeded and
   * publish the actionable terminal diagnosis. Capacity returns automatically
   * when a retired source settles; an explicit reconnect wakes the wait so it
   * can re-check the budget, but a still-exhausted budget never starts work.
   * @param token - loop epoch that owns the wait.
   */
  private async awaitRecoveryCapacity(token: number): Promise<void> {
    while (this.isCurrent(token)
      && this.retiredGenerations.size > this.config.maxRetiredGenerations) {
      this.emitState('disconnected', this.retiredCapacityDiagnosis())
      await Promise.race([
        Promise.race([...this.retiredGenerations].map(pending => pending.then(() => undefined))),
        this.waitManualWake(),
        waitForAbort(this.lifecycle.signal),
      ])
      if (!this.isCurrent(token)) return
    }
    this.exhaustedDiagnosis = undefined
  }

  /** Count one aborted generation until its source actually settles. */
  private retireGeneration(settlement: Promise<void>): void {
    if (this.retiredGenerations.has(settlement)) return
    this.retiredGenerations.add(settlement)
    void settlement.then(() => { this.retiredGenerations.delete(settlement) })
  }

  /** Bounded exhaustion message: what happened, what state, what the user can do. */
  private retiredCapacityDiagnosis(): string {
    return `connection: recovery paused because ${String(this.retiredGenerations.size)} previous generation source(s) did not stop after cancellation (limit ${String(this.config.maxRetiredGenerations)}); reload the page to reset recovery`
  }

  /** Wait for an explicit reconnect request after a terminal generation failure. */
  private async awaitManualRecovery(token: number): Promise<void> {
    await Promise.race([this.waitManualWake(), waitForAbort(this.lifecycle.signal)])
    if (!this.isCurrent(token)) return
    this.exhaustedDiagnosis = undefined
  }

  /** Resolve the current manual-wake wait, or record a wake that arrived first. */
  private wakeManualRecovery(): void {
    const waiter = this.manualWaiter
    if (waiter !== undefined) {
      this.manualWaiter = undefined
      waiter()
      return
    }
    this.manualWakePending = true
  }

  /** One-shot manual wake shared by capacity and terminal waits. */
  private waitManualWake(): Promise<void> {
    if (this.manualWakePending) {
      this.manualWakePending = false
      return Promise.resolve()
    }
    return new Promise((resolve) => { this.manualWaiter = resolve })
  }

  /** Deduplicated state/diagnosis emission (sink isolation applies). */
  private emitState(state: ConnectionState, diagnosis?: string): void {
    if (this.lastState === state && this.lastDiagnosis === diagnosis) return
    this.lastState = state
    this.lastDiagnosis = diagnosis
    this.exhaustedDiagnosis = diagnosis
    this.callSink(() => this.sinks.onStateChange?.(state, diagnosis))
  }

  /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
  private callSink(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error('[connection] connection sink threw:', error)
    }
  }
}

/** Report a slow handshake before the hard deadline ends its generation. */
function waitForReady<T>(
  ready: Promise<T>,
  config: Required<ConnectionRecoveryConfig>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const warning = setTimeout(() => {
      console.warn(`[connection] generation is still not ready after ${String(config.generationReadyWarnMs)}ms`)
    }, config.generationReadyWarnMs)
    const timeout = setTimeout(() => {
      const error = new Error(`connection generation was not ready within ${String(config.generationReadyTimeoutMs)}ms`)
      console.warn(`[connection] ${error.message}; cancelling generation`)
      finish({ error })
    }, config.generationReadyTimeoutMs)
    const aborted = (): void => {
      finish({ error: new Error('connection generation aborted', { cause: signal.reason }) })
    }
    const finish = (outcome: { readonly value: T } | { readonly error: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(warning)
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.value)
    }
    signal.addEventListener('abort', aborted, { once: true })
    void ready.then(
      (value) => { finish({ value }) },
      (error: unknown) => {
        finish({ error: error as Error })
      },
    )
  })
}
