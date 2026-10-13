/**
 * enpoi-update-check — the update-run controller: start, watch, reconcile
 * (docs/plan/ui-update-manifest.md P4).
 *
 * One controller per plugin instance owns at most one run. `start` pins the
 * channel and target from the current `available` status, writes `run.json`,
 * truncates `run.log`, and launches the installed `dsh` shim detached through
 * {@link launchUpdater}. A watcher then polls the log tail (1 s) and the
 * wrapper pid file, refreshing the record until the updater exits:
 *
 * - a terminal log line sets `result` (`success | failed | rolledback`) and
 *   the matching terminal phase;
 * - an exit without a terminal line records `failed` with the last line as the
 *   reason;
 * - a later plugin instance (the web service restarted mid-run) resumes the
 *   watcher when the updater is still alive, and otherwise reconciles against
 *   the install identity ({@link reconcileRunRecord}).
 *
 * Every mutating step is fail-soft at the file level (record writes never
 * throw), but `start` itself is strict: it refuses with a typed
 * {@link RunRefusedError} when no update is available, another run is active,
 * or the shim is missing.
 *
 * @module dsh-enpoi-update-check/run-service
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InstallIdentity } from './catalog.js'
import { defaultShimPath, launchUpdater, type LaunchOutcome, type LaunchRung, type LaunchUpdaterInput } from './launcher.js'
import {
  effectivePid, isProcessAlive, isRunActive, phaseForResult, readRunLog, readRunPid, readRunRecord, reconcileRunRecord,
  RUN_STEP_TOTAL, runLogPath, runPidPath, runRecordPath, sameRunRecord, writeRunRecord,
  type UpdateRunRecord,
} from './run.js'
import type { UpdateCheckStatus } from './service.js'

/** Why `start` refused; the Remote maps every case to `gateway/bad-request`. */
export type RunRefusalReason = 'not-available' | 'already-running' | 'shim-missing' | 'launch-failed'

/** A start refusal with a displayable reason. */
export class RunRefusedError extends Error {
  /** Structured refusal reason. */
  readonly reason: RunRefusalReason

  /**
   * @param reason - structured refusal reason.
   * @param message - human-readable reason (surfaced to the operator).
   */
  constructor(reason: RunRefusalReason, message: string) {
    super(message)
    this.name = 'RunRefusedError'
    this.reason = reason
  }
}

/** Timer seam (tests drive the watcher with fake timers). */
export interface RunTimers {
  setInterval: (handler: () => void, delayMs: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
}

/** Controller construction inputs. */
export interface UpdateRunControllerOptions {
  /** Harness home (`$DSH_HOME`): the update-check directory lives here. */
  readonly home: string
  /** Read the install identity at call time (the state file changes on update). */
  readonly readIdentity: () => InstallIdentity
  /** Read the current check status (the core's snapshot). */
  readonly readStatus: () => UpdateCheckStatus
  /** Launch seam; defaults to {@link launchUpdater}. */
  readonly launch?: (input: LaunchUpdaterInput) => LaunchOutcome
  /** Shim resolution seam; defaults to {@link resolveShimPath}. */
  readonly resolveShim?: (home: string) => string | null
  /** Clock seam. */
  readonly now?: () => Date
  /** Run id seam (tests inject a fixed id). */
  readonly runId?: () => string
  /** Watcher tick, milliseconds (default 1 s). */
  readonly pollIntervalMs?: number
  /** Timer seam. */
  readonly timers?: RunTimers
  /** Process-liveness seam (tests stub it). */
  readonly isAlive?: (pid: number) => boolean
  /** Launcher-rung seams forwarded to the launch ladder. */
  readonly platform?: NodeJS.Platform
  readonly hasCommand?: (command: string) => boolean
  readonly uid?: number
  /** Called after each record change (the plugin logs it). */
  readonly onUpdate?: (record: UpdateRunRecord) => void
}

/** How long a run may show no sign of life (pid file, log content) before it is failed. */
export const RUN_START_GRACE_MS = 15_000

/** Resolve the installed `dsh` shim: the recorded binDir first, then `~/.local/bin/dsh`. */
export function resolveShimPath(home: string): string | null {
  let binDir = ''
  try {
    // The state file is the source the updater itself reads; a read failure
    // just falls back to the conventional shim location.
    const state = JSON.parse(
      readFileSync(join(home, 'harness', 'install-state.json'), 'utf8'),
    ) as { binDir?: unknown }
    binDir = typeof state.binDir === 'string' ? state.binDir : ''
  } catch {
    binDir = ''
  }
  const candidates = [...(binDir === '' ? [] : [join(binDir, 'dsh')]), defaultShimPath()]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Owns the one active run: start gating, the watcher, and boot reconcile.
 */
export class UpdateRunController {
  private readonly options: UpdateRunControllerOptions
  private readonly now: () => Date
  private record: UpdateRunRecord | null = null
  private loaded = false
  private watcher: ReturnType<typeof setInterval> | null = null
  private readonly timers: RunTimers

  /**
   * @param options - home, identity/status readers, launch and timer seams.
   */
  constructor(options: UpdateRunControllerOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.timers = options.timers ?? {
      setInterval: (handler, delayMs) => setInterval(handler, delayMs),
      clearInterval: handle => clearInterval(handle),
    }
  }

  /** The current record (from memory, or the persisted state on first read). */
  run(): UpdateRunRecord | null {
    if (!this.loaded) {
      this.loaded = true
      this.record = readRunRecord(runRecordPath(this.options.home))
    }
    return this.record
  }

  /**
   * Boot reconcile: resolve a record left by a dead watcher. Idempotent.
   * @returns the reconciled record, or null when none exists.
   */
  reconcile(): UpdateRunRecord | null {
    const current = this.run()
    if (current === null) return null
    if (current.result === null && this.isAliveRecord(current)) {
      // The updater outlived the old watcher: resume watching.
      this.watch(current)
      return current
    }
    const { record, changed } = reconcileRunRecord(
      current,
      this.options.readIdentity(),
      this.now,
      this.options.isAlive === undefined ? this.options.home : undefined,
    )
    if (changed) this.persist(record)
    return record
  }

  /**
   * Start one update run.
   *
   * @returns the freshly persisted record (phase `starting`).
   * @throws RunRefusedError when no update is available, a run is active, the
   *   shim is missing, or the launch rung fails.
   */
  start(): UpdateRunRecord {
    this.reconcile()
    const status = this.options.readStatus()
    if (status.state !== 'available' || status.latest === undefined) {
      throw new RunRefusedError(
        'not-available',
        `updateCheck.start: no update is available (state=${status.state})`,
      )
    }
    const active = this.run()
    if (active !== null && active.result === null && this.isAliveRecord(active)) {
      throw new RunRefusedError(
        'already-running',
        `updateCheck.start: an update is already running (run ${active.runId}, step ${String(active.step)}/${String(active.steps)})`,
      )
    }
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home)
    if (shim === null) {
      throw new RunRefusedError(
        'shim-missing',
        `updateCheck.start: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`,
      )
    }
    const runId = (this.options.runId ?? (() => randomUUID().replace(/-/g, '').slice(0, 10)))()
    const home = this.options.home
    const logPath = runLogPath(home)
    const pidFile = runPidPath(home)
    const base: UpdateRunRecord = {
      runId,
      target: status.latest.version,
      channel: status.current.channel,
      phase: 'starting',
      step: 0,
      steps: RUN_STEP_TOTAL,
      lastLine: '',
      startedAt: this.now().toISOString(),
      pid: null,
      logPath,
      result: null,
      rung: 'pending',
      logTail: [],
    }
    // A new run owns a fresh log; reconcile never deletes it, start does.
    try {
      writeFileSync(logPath, '')
      rmSync(pidFile, { force: true })
    } catch {
      // The wrapper recreates both; a stale log only confuses the tail.
    }
    this.record = base
    this.loaded = true
    this.persist(base)
    this.launch(base, shim)
    return this.run() ?? base
  }

  /** Stop the watcher (plugin unload). The updater itself keeps running. */
  dispose(): void {
    this.stopWatcher()
  }

  /** Launch through the ladder, persist the outcome, and start watching. */
  private launch(record: UpdateRunRecord, shim: string): void {
    const home = this.options.home
    let outcome: LaunchOutcome
    try {
      outcome = (this.options.launch ?? launchUpdater)({
        home,
        shim,
        channel: record.channel,
        runId: record.runId,
        logPath: record.logPath,
        pidFile: runPidPath(home),
        ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
        ...(this.options.hasCommand === undefined ? {} : { hasCommand: this.options.hasCommand }),
        ...(this.options.uid === undefined ? {} : { uid: this.options.uid }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failed: UpdateRunRecord = {
        ...record,
        phase: 'failed',
        result: 'failed',
        finishedAt: this.now().toISOString(),
        reason: `could not launch the updater: ${message}`,
      }
      this.persist(failed)
      throw new RunRefusedError('launch-failed', `updateCheck.start: could not launch the updater: ${message}`)
    }
    const started: UpdateRunRecord = {
      ...record,
      rung: outcome.rung satisfies LaunchRung,
      pid: outcome.pid,
    }
    this.persist(started)
    this.watch(started)
  }

  /** Resume/replace the watcher for one record. */
  private watch(record: UpdateRunRecord): void {
    this.stopWatcher()
    this.record = record
    this.loaded = true
    const handle = this.timers.setInterval(() => { this.tick() }, this.options.pollIntervalMs ?? 1_000)
    handle.unref?.()
    this.watcher = handle
    this.tick()
  }

  private stopWatcher(): void {
    if (this.watcher !== null) {
      this.timers.clearInterval(this.watcher)
      this.watcher = null
    }
  }

  /** One watcher tick: refresh progress from the log tail and judge liveness. */
  private tick(): void {
    const record = this.record
    if (record === null || record.result !== null) {
      if (record !== null && !this.isAliveRecord(record)) this.stopWatcher()
      return
    }
    const parsed = readRunLog(record.logPath)
    const wrapperPid = readRunPid(runPidPath(this.options.home))
    const pid = wrapperPid ?? record.pid
    const alive = pid !== null && (this.options.isAlive ?? isProcessAlive)(pid)
    const startedAtMs = Date.parse(record.startedAt)
    const withinGrace = wrapperPid === null
      && Number.isFinite(startedAtMs)
      && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS
    let next: UpdateRunRecord = {
      ...record,
      step: parsed.step > 0 ? parsed.step : record.step,
      steps: parsed.steps,
      lastLine: parsed.lastLine === '' ? record.lastLine : parsed.lastLine,
      phase: parsed.step > 0 ? parsed.phase : record.phase,
      logTail: parsed.logTail,
      pid,
    }
    if (parsed.result !== null) {
      next = {
        ...next,
        result: parsed.result,
        phase: phaseForResult(parsed.result),
        finishedAt: this.now().toISOString(),
        ...(parsed.result === 'success' ? {} : { reason: parsed.lastLine }),
      }
      this.persist(next)
      if (!alive) this.stopWatcher()
      return
    }
    if (!alive && !withinGrace) {
      next = {
        ...next,
        phase: 'failed',
        result: 'failed',
        finishedAt: this.now().toISOString(),
        reason: parsed.lastLine === ''
          ? 'the updater exited before writing any output'
          : `the updater exited before reporting a result (last line: ${parsed.lastLine})`,
      }
      this.persist(next)
      this.stopWatcher()
      return
    }
    this.persist(next)
  }

  /** Persist when changed and publish to the plugin. */
  private persist(record: UpdateRunRecord): void {
    const previous = this.record
    this.record = record
    if (previous === null || !sameRunRecord(previous, record)) {
      writeRunRecord(runRecordPath(this.options.home), record)
      this.options.onUpdate?.(record)
    }
  }

  /** Whether a record has a live process by the controller's liveness seam. */
  private isAliveRecord(record: UpdateRunRecord): boolean {
    if (this.options.isAlive === undefined) return isRunActive(this.options.home, record)
    const pid = effectivePid(this.options.home, record)
    return pid !== null && this.options.isAlive(pid)
  }
}
