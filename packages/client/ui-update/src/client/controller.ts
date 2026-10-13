/**
 * The in-app update controller: the pollable state behind the chrome
 * indicator, the dialog actions, the two-phase run, and the post-restart
 * reload. One instance per plugin apply.
 *
 * Flow: `start` runs the engine's prepare (`starting` → `preparing` →
 * `prepared`); the prepared record is a resting state the dialog turns into
 * [Restart to update]. `apply` runs the staged apply (`applying` →
 * `success | failed | rolledback`), whose switch restarts the service: the
 * reconnected page compares the install version, writes the one-time toast
 * payload, and reloads. Retry after a failed/rolled-back apply replays
 * `apply` while the staged marker survives, and re-prepares otherwise.
 *
 * Polling policy (cheap by design):
 * - `updateCheck.status` on mount, every {@link STATUS_POLL_MS} while the tab
 *   is visible, and on window focus / visibility restore (coalesced by
 *   {@link TRIGGER_MIN_GAP_MS} and single-flight);
 * - `updateCheck.run` once on mount (to discover a prepared record that
 *   outlived the tab), and every {@link RUN_POLL_MS} only while the engine
 *   process is executing (`starting`/`preparing`/`applying`). A prepared
 *   record does not change without a user action, so it is not polled.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { isExecutingPhase, updateCheckRpc, type UpdateCheckStatusWire, type UpdateRunWire } from './rpc.ts'

/** Status poll interval while the tab is visible. */
export const STATUS_POLL_MS = 60_000

/** Run poll interval while the engine process is executing. */
export const RUN_POLL_MS = 2_000

/** Minimum gap between trigger-driven status polls (focus / visibility). */
export const TRIGGER_MIN_GAP_MS = 1_000

/** Session key holding `{ from, target }` while a run is in flight. */
export const PENDING_KEY = 'dsh.update.pending.v1'

/** Session key holding `{ version }` until the post-reload toast is shown. */
export const TOAST_KEY = 'dsh.update.toast.v1'

/** The published UI state. */
export interface UpdateUiState {
  /** Latest check status, or null before the first read. */
  readonly status: UpdateCheckStatusWire | null
  /** Latest run record, or null when no run was ever started. */
  readonly run: UpdateRunWire | null
  /** Whether the dialog is open. */
  readonly dialogOpen: boolean
  /** Whether a start/apply/dismiss call is in flight. */
  readonly busy: boolean
  /** Displayable failure of the last action, cleared by the next action. */
  readonly actionError: string | null
  /** Version to announce once after an update landed, or null. */
  readonly toastVersion: string | null
}

/** Session-storage face (tests inject a map-backed stub). */
export interface UpdateStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Timer seam (tests drive it manually). */
export interface UpdateTimers {
  setInterval: (handler: () => void, delayMs: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  setTimeout: (handler: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
}

/** Document/window seam for visibility and focus triggers. */
export interface UpdateDom {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
  /** Present on the document only; the window seam leaves it undefined. */
  readonly visibilityState?: DocumentVisibilityState
}

/** Controller construction inputs. */
export interface UpdateControllerOptions {
  /** Remote caller; defaults to {@link updateCheckRpc}. */
  readonly rpc?: typeof updateCheckRpc
  /** Session storage; defaults to `window.sessionStorage`. */
  readonly storage?: UpdateStorage | undefined
  /** Timer seam; defaults to the globals. */
  readonly timers?: UpdateTimers
  /** Document seam; defaults to the page document when present. */
  readonly doc?: UpdateDom | undefined
  /** Window seam; defaults to the page window when present. */
  readonly win?: UpdateDom | undefined
  /** Reload seam; defaults to `window.location.reload()`. */
  readonly reload?: () => void
  /** Clock seam. */
  readonly now?: () => number
  /** Status poll interval override (tests). */
  readonly statusIntervalMs?: number
  /** Run poll interval override (tests). */
  readonly runIntervalMs?: number
}

const INITIAL: UpdateUiState = {
  status: null,
  run: null,
  dialogOpen: false,
  busy: false,
  actionError: null,
  toastVersion: null,
}

function defaultStorage(): UpdateStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    // Privacy modes can make sessionStorage access throw; the feature then
    // works without cross-reload memory.
    return undefined
  }
}

function defaultDom(kind: 'doc' | 'win'): UpdateDom | undefined {
  try {
    const value: unknown = kind === 'doc' ? globalThis.document : globalThis.window
    return value === undefined ? undefined : (value as UpdateDom)
  } catch {
    return undefined
  }
}

/** One pending marker: the install version when the run started, plus its target. */
interface PendingMarker {
  readonly from: string
  readonly target: string
}

/** Parse one storage JSON value into a plain record, or undefined. */
function readMarker(storage: UpdateStorage | undefined, key: string): Record<string, unknown> | undefined {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(key)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Owns polling, the dialog actions, and the restart detection.
 */
export class UpdateController {
  /** Published UI state, read by the indicator through the inject hook. */
  readonly store: SnapshotStore<UpdateUiState>

  private readonly options: UpdateControllerOptions
  private readonly rpc: typeof updateCheckRpc
  private readonly storage: UpdateStorage | undefined
  private readonly timers: UpdateTimers
  private readonly doc: UpdateDom | undefined
  private readonly win: UpdateDom | undefined
  private readonly now: () => number
  private readonly statusIntervalMs: number
  private readonly runIntervalMs: number
  private statusHandle: ReturnType<typeof setInterval> | null = null
  private runHandle: ReturnType<typeof setInterval> | null = null
  private statusInFlight: Promise<void> | null = null
  private runInFlight: Promise<void> | null = null
  private lastTriggerAt = Number.NEGATIVE_INFINITY
  private disposed = false
  private pending: PendingMarker | undefined

  /**
   * @param options - rpc, storage, timer, and DOM seams.
   */
  constructor(options: UpdateControllerOptions = {}) {
    this.options = options
    this.rpc = options.rpc ?? updateCheckRpc
    this.storage = 'storage' in options ? options.storage : defaultStorage()
    this.timers = options.timers ?? {
      setInterval: (handler, delayMs) => setInterval(handler, delayMs),
      clearInterval: (handle) => { clearInterval(handle) },
      setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
      clearTimeout: (handle) => { clearTimeout(handle) },
    }
    this.doc = 'doc' in options ? options.doc : defaultDom('doc')
    this.win = 'win' in options ? options.win : defaultDom('win')
    this.now = options.now ?? (() => Date.now())
    this.statusIntervalMs = options.statusIntervalMs ?? STATUS_POLL_MS
    this.runIntervalMs = options.runIntervalMs ?? RUN_POLL_MS
    this.store = createSnapshotStore<UpdateUiState>({ ...INITIAL })
    const pending = readMarker(this.storage, PENDING_KEY)
    if (pending !== undefined && typeof pending.from === 'string' && typeof pending.target === 'string') {
      this.pending = { from: pending.from, target: pending.target }
    }
    const toast = readMarker(this.storage, TOAST_KEY)
    if (toast !== undefined && typeof toast.version === 'string' && toast.version !== '') {
      this.update({ toastVersion: toast.version })
    }
    // Shown exactly once: the marker is consumed at construction.
    this.writeMarker(TOAST_KEY, undefined)
  }

  /** Attach triggers, read the status, and discover a run that outlived the tab. */
  mount(): void {
    if (this.disposed) return
    this.doc?.addEventListener('visibilitychange', this.onVisibility)
    this.win?.addEventListener('focus', this.onFocus)
    this.statusHandle = this.timers.setInterval(() => { this.onStatusTick() }, this.statusIntervalMs)
    void this.refreshStatus(true, true)
    void this.refreshRun()
  }

  /** Detach triggers and stop both polls. */
  dispose(): void {
    this.disposed = true
    if (this.statusHandle !== null) this.timers.clearInterval(this.statusHandle)
    if (this.runHandle !== null) this.timers.clearInterval(this.runHandle)
    this.statusHandle = null
    this.runHandle = null
    this.doc?.removeEventListener('visibilitychange', this.onVisibility)
    this.win?.removeEventListener('focus', this.onFocus)
  }

  /** Open the dialog and make sure a run's state has been read once. */
  open(): void {
    this.update({ dialogOpen: true, actionError: null })
    void this.refreshRun()
  }

  /** Close the dialog; an executing run keeps going in the background. */
  close(): void {
    this.update({ dialogOpen: false, actionError: null })
    this.stopRunPollIfIdle()
  }

  /** `[Update now]`: prepare the update (`updateCheck/start`). */
  start(): void {
    if (this.store.getSnapshot().busy) return
    const status = this.store.getSnapshot().status
    this.update({ busy: true, actionError: null })
    void this.rpc('updateCheck.start', {}).then((result) => {
      if (this.disposed) return
      if (!result.ok) {
        this.update({ busy: false, actionError: result.message })
        return
      }
      const run = result.value as UpdateRunWire
      this.pinPending(status, run)
      this.update({ busy: false, run, dialogOpen: true })
      this.ensureRunPoll()
    })
  }

  /** `[Restart to update]`: apply the staged update (`updateCheck/apply`). */
  apply(): void {
    if (this.store.getSnapshot().busy) return
    const status = this.store.getSnapshot().status
    this.update({ busy: true, actionError: null })
    void this.rpc('updateCheck.apply', {}).then((result) => {
      if (this.disposed) return
      if (!result.ok) {
        this.update({ busy: false, actionError: result.message })
        return
      }
      const applied = result.value as UpdateRunWire
      this.pinPending(status, applied)
      this.update({ busy: false, run: applied, dialogOpen: true })
      this.ensureRunPoll()
    })
  }

  /**
   * Retry a failed run: replay `apply` while the staged marker survived a
   * rolled-back/failed apply, and re-prepare otherwise.
   */
  retry(): void {
    const run = this.store.getSnapshot().run
    if (run !== null && run.mode === 'apply' && run.staged) this.apply()
    else this.start()
  }

  /** `[Skip this version]`: persist the dismissal and close the dialog. */
  skip(): void {
    const status = this.store.getSnapshot().status
    const version = status?.latest?.version
    if (version === undefined || this.store.getSnapshot().busy) return
    this.update({ busy: true, actionError: null })
    // The descriptor names its single parameter `request`; the args object
    // must mirror that name (see the rpc.ts descriptor table).
    void this.rpc('updateCheck.dismiss', { request: { version } }).then((result) => {
      if (this.disposed) return
      if (!result.ok) {
        this.update({ busy: false, actionError: result.message })
        return
      }
      this.update({
        busy: false,
        status: result.value as UpdateCheckStatusWire,
        dialogOpen: false,
      })
    })
  }

  /** Dismiss the one-time toast. */
  toastDone(): void {
    this.update({ toastVersion: null })
  }

  /**
   * A connection generation was established: after the apply's switch this is
   * how the page learns the service is back. Completion is judged by the
   * install version changing, not by the reconnect itself, so this read
   * bypasses the focus gap (a reconnect is a real event, not pointer chatter).
   */
  onConnectionReset(): void {
    if (this.pending === undefined) return
    void this.refreshStatus(true, true)
  }

  /**
   * One status read, single-flight and gap-limited for trigger calls.
   * @param trigger - whether this read came from a focus/visibility trigger.
   * @param force - bypass the trigger gap (mount and reconnect reads).
   */
  refreshStatus(trigger = false, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const at = this.now()
    if (trigger && !force && at - this.lastTriggerAt < TRIGGER_MIN_GAP_MS) return Promise.resolve()
    if (trigger) this.lastTriggerAt = at
    if (this.statusInFlight !== null) return this.statusInFlight
    this.statusInFlight = this.rpc('updateCheck.status', {}).then((result) => {
      if (this.disposed || !result.ok) return
      const status = result.value as UpdateCheckStatusWire
      this.update({ status })
      this.maybeCompleteUpdate()
    }).finally(() => { this.statusInFlight = null })
    return this.statusInFlight
  }

  /** One run read; starts/stops the run poll from the result (prepared never polls). */
  refreshRun(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.runInFlight !== null) return this.runInFlight
    this.runInFlight = this.rpc('updateCheck.run', {}).then((result) => {
      if (this.disposed || !result.ok) return
      const run = result.value === null || result.value === undefined ? null : result.value as UpdateRunWire
      this.update({ run })
      this.maybeCompleteUpdate()
      if (run !== null && isExecutingPhase(run.phase)) this.ensureRunPoll()
      else this.stopRunPollIfIdle()
    }).finally(() => { this.runInFlight = null })
    return this.runInFlight
  }

  /** Record the pre-run version so the post-switch reload can be detected. */
  private pinPending(status: UpdateCheckStatusWire | null, run: UpdateRunWire | null): void {
    const marker: PendingMarker = {
      from: status === null ? '' : status.current.version,
      target: run === null ? '' : run.target,
    }
    this.pending = marker
    this.writeMarker(PENDING_KEY, marker)
  }

  /** Reload and announce the new version once the server reports it. */
  private maybeCompleteUpdate(): void {
    const { status, run } = this.store.getSnapshot()
    if (this.pending === undefined || status === null) return
    const version = status.current.version
    // An empty `from` means the status was not loaded when the run started;
    // only the run's own success can complete the update in that case.
    const reached = this.pending.from !== '' && version !== '' && version !== this.pending.from
    const succeeded = run !== null && run.result === 'success'
    if (!reached && !succeeded) return
    if (version === '') return
    this.writeMarker(TOAST_KEY, { version })
    this.writeMarker(PENDING_KEY, undefined)
    this.pending = undefined
    ;(this.options.reload ?? (() => { window.location.reload() }))()
  }

  private ensureRunPoll(): void {
    if (this.disposed || this.runHandle !== null) return
    this.runHandle = this.timers.setInterval(() => { void this.refreshRun() }, this.runIntervalMs)
  }

  private stopRunPollIfIdle(): void {
    const { run } = this.store.getSnapshot()
    // Only an executing engine changes the record; prepared waits for the
    // user's restart and a terminal record never changes again.
    if (run !== null && isExecutingPhase(run.phase)) return
    if (this.runHandle !== null) {
      this.timers.clearInterval(this.runHandle)
      this.runHandle = null
    }
  }

  private onStatusTick(): void {
    if (this.doc?.visibilityState === 'hidden') return
    void this.refreshStatus()
  }

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === 'hidden') return
    void this.refreshStatus(true)
  }

  private readonly onFocus = (): void => {
    void this.refreshStatus(true)
  }

  private update(change: Partial<UpdateUiState>): void {
    this.store.update((state) => { Object.assign(state, change) })
  }

  private writeMarker(key: string, marker: { version: string } | PendingMarker | undefined): void {
    if (this.storage === undefined) return
    try {
      if (marker === undefined) this.storage.removeItem(key)
      else this.storage.setItem(key, JSON.stringify(marker))
    } catch {
      // A full or unavailable storage only loses cross-reload memory.
    }
  }
}
