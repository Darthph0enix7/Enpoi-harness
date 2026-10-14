/**
 * enpoi-update-check — the update-run controller: prepare, apply, watch,
 * reconcile (docs/plan/ui-update-manifest.md P4, engine two-phase flags).
 *
 * One controller per plugin instance owns at most one run. The installed
 * engine's capability is probed once per boot ({@link UpdateRunController.probe}):
 * a two-phase engine gets `dsh update --channel <c> --prepare` (the staged
 * tree waits for `apply`), an older engine gets the one-shot
 * `dsh update --channel <c>` whose run includes the switch and restart —
 * the first in-app update on any pre-two-phase device must not fail on an
 * unknown flag.
 *
 * - `start` pins the channel and target from the current `available` status.
 *   On the two-phase rung the watcher follows the log; when the prepare
 *   process exits with `$PREFIX/harness/.staged-apply.json` written, the
 *   record rests at `phase: 'prepared'` (no process, nothing to watch) and the
 *   UI offers Restart to update. On the one-shot rung it runs straight
 *   through to a terminal phase and never becomes `prepared`.
 * - `apply` launches `dsh update --apply` against the staged tree; the watcher
 *   follows the switch/self-check/health steps to `success`, `failed`, or
 *   `rolledback`. A one-shot record is refused (its run owns the restart).
 * - A later plugin instance (the web service restarted mid-run — any rung's
 *   switch does this) resumes the watcher when the updater is still alive, and
 *   otherwise reconciles against the log tail, the staged marker, and the
 *   install identity ({@link reconcileRunRecord}). A prepared record survives
 *   a restart unchanged.
 *
 * Every mutating step is fail-soft at the file level (record writes never
 * throw), but `start`/`apply` are strict: they refuse with a typed
 * {@link RunRefusedError} when the precondition is missing (no update, a run
 * active, an update already prepared, nothing staged) or the launch fails.
 *
 * @module dsh-enpoi-update-check/run-service
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InstallIdentity } from './catalog.js'
import {
  defaultShimPath, launchUpdater, LaunchEnvironmentError, resolveRuntimePath, RUN_HOME_ENV,
  type LaunchOutcome, type LaunchRung, type LaunchUpdaterInput,
} from './launcher.js'
import { cancelEngineRun, type CancelEngineInput, type EngineCancelOutcome, type EngineCancelStatus } from './cancel.js'
import {
  isMarkerLive, isProcessLive, markerProgressAge, modeFromMarker, observedRecordFromMarker, phaseFromMarker, readRunMarker,
  type EngineRunMarker,
} from './marker.js'
import { probeEngineCapability, type EngineProbeResult } from './probe.js'
import {
  effectivePid, executingPhase, isPreparedPhase, isProcessAlive, isProgressStale, isRunActive, modeFlag,
  preparedRecord, progressAgeMs, readRunLog, readRunPid, readRunRecord, readStagedApply, reconcileRunRecord,
  RUN_STALE_WINDOW_MS, RUN_STEP_TOTAL, rungForMode, runLogPath, runPidPath, runRecordPath, sameRunRecord,
  stagedApplyReady, stagedTreeReady, writeRunRecord,
  type UpdatePhase, type UpdateRunMode, type UpdateRunRecord,
} from './run.js'
import type { UpdateCheckStatus } from './service.js'

/** Why `start`/`apply` refused; the Remote maps every case to `gateway/bad-request`. */
export type RunRefusalReason =
  | 'not-available'
  | 'already-running'
  | 'already-prepared'
  | 'not-prepared'
  | 'staged-tree-missing'
  | 'shim-missing'
  | 'launch-failed'

/** A start/apply refusal with a displayable reason. */
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
  /** Prefix resolution seam; defaults to {@link resolvePrefix}. */
  readonly resolvePrefix?: (home: string) => string
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
  /** Environment the launch composes from (tests simulate `env -i`). */
  readonly baseEnv?: NodeJS.ProcessEnv
  /** User home probed for the nvm layout (tests use a scratch home). */
  readonly probeHomeDir?: string
  /** Engine capability probe seam; defaults to {@link probeEngineCapability}. */
  readonly probe?: (input: { shim: string; env: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<EngineProbeResult>
  /** Capability-probe bound, milliseconds (default 10 s). */
  readonly probeTimeoutMs?: number
  /** Engine-cancel seam; defaults to {@link cancelEngineRun}. */
  readonly cancelEngine?: (input: CancelEngineInput) => Promise<EngineCancelOutcome>
  /** Engine-cancel bound, milliseconds (default 30 s). */
  readonly cancelTimeoutMs?: number
  /** Called after each record change (the plugin logs it). */
  readonly onUpdate?: (record: UpdateRunRecord) => void
}

/** The `updateCheck/cancel` reply: the engine's outcome plus the record it leaves behind. */
export interface UpdateCancelOutcome {
  /** Engine outcome (`cancelled` / `refused` / `noop` / `failed`). */
  readonly status: EngineCancelStatus
  /** Human message: the engine's own words, or the local failure reason. */
  readonly message: string
  /** The record after the attempt (relayed into `cancelled` on success). */
  readonly record: UpdateRunRecord | null
}

/** How long a run may show no sign of life (pid file, log content) before it is failed. */
export const RUN_START_GRACE_MS = 15_000

/** Read the recorded install prefix from `install-state.json`, falling back to the home. */
export function resolvePrefix(home: string): string {
  try {
    const state = JSON.parse(
      readFileSync(join(home, 'harness', 'install-state.json'), 'utf8'),
    ) as { prefix?: unknown }
    return typeof state.prefix === 'string' && state.prefix !== '' ? state.prefix : home
  } catch {
    return home
  }
}

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
 * Owns the one run: prepare/apply gating, the watcher, and boot reconcile.
 */
export class UpdateRunController {
  private readonly options: UpdateRunControllerOptions
  private readonly now: () => Date
  private readonly prefix: string
  private record: UpdateRunRecord | null = null
  private loaded = false
  private watcher: ReturnType<typeof setInterval> | null = null
  private capability: Promise<EngineProbeResult> | null = null
  private startInFlight: Promise<UpdateRunRecord> | null = null
  private readonly timers: RunTimers

  /**
   * @param options - home, identity/status readers, launch and timer seams.
   */
  constructor(options: UpdateRunControllerOptions) {
    this.options = options
    this.now = options.now ?? (() => new Date())
    this.prefix = (options.resolvePrefix ?? resolvePrefix)(options.home)
    this.timers = options.timers ?? {
      setInterval: (handler, delayMs) => { return setInterval(handler, delayMs) },
      clearInterval: (handle) => { clearInterval(handle) },
    }
  }

  /**
   * The current run as the UI should see it: the plugin's own executing record
   * first, otherwise a live run observed from the engine marker (a
   * terminal-started update), otherwise the plugin's persisted record
   * (prepared or terminal). The marker costs one small file read per call and
   * is never watched host-side.
   */
  run(): UpdateRunRecord | null {
    // Every read heals: a stale record must never surface as an active run or
    // block a gate (the engine's own truth decides real liveness).
    this.healStaleOwn()
    const own = this.loadOwn()
    const current = own === null ? null : this.stagedTruth(own)
    if (current !== null && current.result === null && !isPreparedPhase(current.phase) && this.blockingRun(current)) return current
    return this.observeEngineRun() ?? current
  }

  /**
   * The `staged` flag is derived truth: it must match the staged record and
   * its tree on disk at read time. The engine archives a rolled-back tree as
   * `<dir>.failed-<ts>` while keeping the staged record, so a persisted
   * record that still reads `staged: true` (or a legacy `false` against a
   * complete tree) is corrected and persisted here — the UI's Retry/recover
   * decision must never be based on a stale flag.
   */
  private stagedTruth(record: UpdateRunRecord): UpdateRunRecord {
    const staged = stagedApplyReady(this.prefix)
    if (record.staged === staged) return record
    const next = { ...record, staged }
    this.persist(next)
    return next
  }

  /** The persisted plugin record (loaded once). */
  private loadOwn(): UpdateRunRecord | null {
    if (!this.loaded) {
      this.loaded = true
      this.record = readRunRecord(runRecordPath(this.options.home))
    }
    return this.record
  }

  /** Whether a marker names the same run as the persisted record (log path, or mode/target). */
  private markerMatchesRecord(record: UpdateRunRecord, marker: EngineRunMarker): boolean {
    if (record.logPath !== '' && marker.logPath !== '' && record.logPath === marker.logPath) return true
    if (modeFromMarker(marker.mode) !== record.mode) return false
    return record.target === '' || marker.target === '' || marker.target === record.target || marker.version === record.target
  }

  /** Synthesize a live record from the engine marker, or null when none is live. */
  private observeEngineRun(): UpdateRunRecord | null {
    const marker = readRunMarker(this.prefix)
    if (marker === null) return null
    if (!isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
      progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime()),
    })) return null
    return observedRecordFromMarker(marker, {
      prefix: this.prefix,
      channel: this.options.readIdentity().channel,
    })
  }

  /**
   * Whether the engine's own truth names a live run: a live non-terminal,
   * non-stalled marker, or the mkdir-fallback lock's live owner pid. The
   * flock file's presence means nothing (flock releases without removing it),
   * so it is never consulted.
   */
  private engineRunActive(): boolean {
    const marker = readRunMarker(this.prefix)
    if (marker !== null && isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
      progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime()),
    })) return true
    const lockPid = readRunPid(join(this.prefix, 'harness', '.update.lock.d', 'pid'))
    return lockPid !== null && (this.options.isAlive ?? isProcessLive)(lockPid)
  }

  /** Whether the engine's live run is the same run as the persisted record. */
  private engineRunActiveFor(record: UpdateRunRecord): boolean {
    if (!this.engineRunActive()) return false
    const marker = readRunMarker(this.prefix)
    return marker !== null && this.markerMatchesRecord(record, marker)
  }

  /**
   * Auto-heal a stale persisted record: not live by pid, and either the engine
   * agrees nothing runs or the engine runs something else. The record is
   * reconciled to a terminal state (success when the install already reached
   * the target, otherwise failed with a clear reason) and the dead pid file is
   * dropped, so no gate can refuse on state that is not real. Runs younger
   * than the start grace and prepared records are left alone.
   */
  private healStaleOwn(): void {
    const own = this.loadOwn()
    if (own === null || own.result !== null || isPreparedPhase(own.phase)) return
    const startedAtMs = Date.parse(own.startedAt)
    if (Number.isFinite(startedAtMs) && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS) return
    if (this.isAliveRecord(own) || this.engineRunActiveFor(own)) return
    const { record, changed } = reconcileRunRecord(own, this.options.readIdentity(), {
      home: this.options.home,
      prefix: this.prefix,
      now: this.now,
    }, { live: false })
    if (changed) this.persist(record)
    this.stopWatcher()
    try { rmSync(runPidPath(this.options.home), { force: true }) } catch { /* best effort */ }
  }

  /**
   * One installed-engine capability probe per controller (one plugin boot):
   * `dsh update --help` bounded, cached forever after. Failures default to
   * UNSUPPORTED, so the first update on an old engine uses the one-shot rung.
   * @returns the cached probe promise.
   */
  probe(): Promise<EngineProbeResult> {
    this.capability ??= this.runProbe()
    return this.capability
  }

  private async runProbe(): Promise<EngineProbeResult> {
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home)
    if (shim === null) {
      return { capability: 'unsupported', reason: `the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})` }
    }
    return await (this.options.probe ?? probeEngineCapability)({
      shim,
      env: this.probeEnvironment(),
      ...(this.options.probeTimeoutMs === undefined ? {} : { timeoutMs: this.options.probeTimeoutMs }),
    })
  }

  /** The probe's environment: the composed runtime PATH where one resolves, plus DSH_HOME/PREFIX. */
  private probeEnvironment(): NodeJS.ProcessEnv {
    const baseEnv = this.options.baseEnv ?? process.env
    const resolved = resolveRuntimePath({
      prefix: this.prefix,
      homeDir: this.options.probeHomeDir ?? homedir(),
      baseEnv,
      ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
    })
    return {
      ...baseEnv,
      ...(resolved.path === null ? {} : { PATH: resolved.path }),
      [RUN_HOME_ENV]: this.options.home,
      ...(this.prefix === '' ? {} : { PREFIX: this.prefix }),
    }
  }

  /**
   * Boot reconcile: resolve a record left by a dead watcher. Idempotent.
   * A prepared record survives untouched; a live updater resumes watching.
   * @returns the reconciled record, or null when none exists.
   */
  reconcile(): UpdateRunRecord | null {
    const current = this.loadOwn()
    if (current === null) return null
    if (current.result === null && !isPreparedPhase(current.phase) && this.blockingRun(current)) {
      // The updater outlived the old watcher: resume watching. When the engine
      // marker names the same live run, its pid/phase/step are authoritative
      // (the log-derived record may lag the switch).
      const marker = readRunMarker(this.prefix)
      const markerLive = marker !== null && isMarkerLive(marker, this.options.isAlive ?? isProcessLive, {
        progressAgeMs: markerProgressAge(marker, this.prefix, this.now().getTime()),
      })
      if (marker !== null && markerLive && this.markerMatchesRecord(current, marker)) {
        const merged: UpdateRunRecord = {
          ...current,
          pid: marker.pid,
          // The marker knows when the switch began even if the log parse lags;
          // `running` keeps the finer log-derived phase.
          phase: marker.phase === 'switching'
            ? 'applying'
            : marker.phase === 'running' ? current.phase : phaseFromMarker(marker.phase),
          step: marker.step > 0 ? marker.step : current.step,
          steps: marker.steps > 0 ? marker.steps : current.steps,
        }
        this.watch(merged)
        return merged
      }
      this.watch(current)
      return current
    }
    if (isPreparedPhase(current.phase) && stagedApplyReady(this.prefix)) return current
    // A non-live non-prepared record is stale by definition: reconcile with
    // strong liveness so a recycled pid cannot keep it active.
    const { record, changed } = reconcileRunRecord(current, this.options.readIdentity(), {
      home: this.options.home,
      prefix: this.prefix,
      now: this.now,
    }, { live: false })
    if (changed) this.persist(record)
    try { rmSync(runPidPath(this.options.home), { force: true }) } catch { /* best effort */ }
    return record
  }

  /**
   * Start one update run. The probe decides the rung: a two-phase engine gets
   * `dsh update --channel <c> --prepare` (the staged tree waits for `apply`),
   * an older engine gets the one-shot `dsh update --channel <c>` whose run
   * includes the switch and restart.
   *
   * A dismissed version is startable (the skip only hides the indicator), and
   * an already-prepared update is deliberately refused (`already-prepared`):
   * the staged target is pinned by the engine's record, so the offered action
   * is Restart to update, not prepare again.
   *
   * Single-flight (like `UpdateCheckCore.checkNow`): concurrent callers share
   * one gate+probe+begin pass, so two Update-now clicks in the probe window
   * launch exactly one engine — the loser of a double launch could only die
   * on the engine lock and leave a transient failed record.
   *
   * @returns the freshly persisted record.
   * @throws RunRefusedError when no update is available, a run is active, an
   *   update is already prepared, the shim is missing, or the launch fails
   *   (including a launch environment with no usable Node.js runtime).
   */
  start(): Promise<UpdateRunRecord> {
    if (this.startInFlight !== null) return this.startInFlight
    this.startInFlight = this.startOnce().finally(() => { this.startInFlight = null })
    return this.startInFlight
  }

  /** The gated prepare/one-shot pass behind {@link start}'s single flight. */
  private async startOnce(): Promise<UpdateRunRecord> {
    this.reconcile()
    const status = this.options.readStatus()
    // A dismissed version is startable: "Skip this version" only hides the
    // indicator, and the operator explicitly asking again (the Settings
    // control or a dialog on a skipped release) must be able to update.
    if ((status.state !== 'available' && status.state !== 'dismissed') || status.latest === undefined) {
      throw new RunRefusedError(
        'not-available',
        `updateCheck.start: no update is available (state=${status.state})`,
      )
    }
    const current = this.run()
    if (current !== null && current.result === null) {
      if (isPreparedPhase(current.phase)) {
        throw new RunRefusedError(
          'already-prepared',
          `updateCheck.start: update ${current.target} is already prepared; apply it instead`,
        )
      }
      // Strong liveness or the engine's own live run; a stale record was
      // already healed by run(), so this only refuses for something real.
      if (this.blockingRun(current)) {
        throw new RunRefusedError(
          'already-running',
          `updateCheck.start: an update is already running (run ${current.runId}, step ${String(current.step)}/${String(current.steps)})`,
        )
      }
    }
    const pin = { target: status.latest.version, channel: status.current.channel }
    const capability = await this.probe()
    // The probe await is a real gap: an engine run started elsewhere (or a
    // settled sibling call) can appear in it, so re-check before begin.
    const afterProbe = this.run()
    if (afterProbe !== null && afterProbe.result === null) {
      if (isPreparedPhase(afterProbe.phase)) {
        throw new RunRefusedError(
          'already-prepared',
          `updateCheck.start: update ${afterProbe.target} is already prepared; apply it instead`,
        )
      }
      if (this.blockingRun(afterProbe)) {
        throw new RunRefusedError(
          'already-running',
          `updateCheck.start: an update is already running (run ${afterProbe.runId}, step ${String(afterProbe.step)}/${String(afterProbe.steps)})`,
        )
      }
    }
    return capability.capability === 'supported'
      ? this.begin('prepare', pin)
      : this.begin('one-shot', pin)
  }

  /**
   * Apply the staged update (`dsh update --apply`).
   *
   * @returns the freshly persisted record.
   * @throws RunRefusedError when nothing is prepared, the record is a one-shot
   *   update (its run owns the restart), the staged record or its tree is
   *   missing/incomplete (`staged-tree-missing`), a run is active, the shim is
   *   missing, or the launch fails.
   */
  apply(): UpdateRunRecord {
    this.reconcile()
    const current = this.run()
    if (current !== null && this.blockingRun(current)) {
      throw new RunRefusedError(
        'already-running',
        `updateCheck.apply: an update is already running (run ${current.runId})`,
      )
    }
    if (current !== null && current.mode === 'one-shot') {
      throw new RunRefusedError(
        'not-prepared',
        `updateCheck.apply: run ${current.runId} is a one-shot update (this engine has no --prepare); there is nothing to apply — the run restarts the service itself when it switches`,
      )
    }
    // A failed apply with a valid staged marker is re-appliable without a new
    // prepare (the engine re-validates the staged record under its lock): this
    // is the recovery path the UI's "Clear update state & retry" uses.
    const revisableFailure = current !== null
      && current.result !== null && current.result !== 'success' && current.staged === true
    // The engine keeps the staged record after a rolled-back apply while its
    // failed tree is archived as `<dir>.failed-<ts>`: replaying `--apply`
    // against it fails forever with "the staged tree … is missing or
    // incomplete". The marker presence with a broken tree gets its own
    // refusal so the client re-prepares instead of replaying.
    const staged = readStagedApply(this.prefix)
    const stagedReady = staged !== null && stagedTreeReady(this.prefix, staged.treeDirName)
    if (current === null || (!isPreparedPhase(current.phase) && !revisableFailure)) {
      if (staged !== null && !stagedReady) {
        throw new RunRefusedError(
          'staged-tree-missing',
          `updateCheck.apply: the staged tree ${staged.treeDirName} is missing or incomplete; run Update now to prepare again`,
        )
      }
      throw new RunRefusedError(
        'not-prepared',
        'updateCheck.apply: no prepared update is staged; run Update now first',
      )
    }
    if (!stagedReady) {
      throw new RunRefusedError(
        'staged-tree-missing',
        staged === null
          ? 'updateCheck.apply: the staged update record is gone; run Update now to prepare again'
          : `updateCheck.apply: the staged tree ${staged.treeDirName} is missing or incomplete; run Update now to prepare again`,
      )
    }
    // Re-apply the version the staged record actually names (the failed
    // record's target may predate it).
    return this.begin('apply', {
      target: staged.version,
      channel: staged.channel,
    })
  }

  /**
   * Clear stale update state so a stuck failure can recover: refuses while
   * anything is genuinely live (the observer's view, the persisted record by
   * strong liveness, or the engine's own marker/mkdir-lock truth), then heals
   * the persisted record to a terminal state and drops the dead pid file. The
   * engine's marker and the staged tree are never touched, so a valid staged
   * update survives for an immediate re-apply.
   *
   * @returns the run record after clearing (terminal, or observed when the
   *   engine started something in the meantime).
   * @throws RunRefusedError when a live run or the engine's live lock exists.
   */
  clearStale(): UpdateRunRecord | null {
    const observed = this.observeEngineRun()
    if (observed !== null && this.isAliveRecord(observed)) {
      throw new RunRefusedError(
        'already-running',
        `updateCheck.clearStale: run ${observed.runId} is live (${observed.phase}); cancel it or wait`,
      )
    }
    const own = this.loadOwn()
    if (own !== null && this.isAliveRecord(own)) {
      throw new RunRefusedError(
        'already-running',
        `updateCheck.clearStale: run ${own.runId} is live (${own.phase}); cancel it or wait`,
      )
    }
    if (this.engineRunActive()) {
      throw new RunRefusedError(
        'already-running',
        'updateCheck.clearStale: the engine still holds a live update lock; wait for it or cancel it',
      )
    }
    if (own !== null && own.result === null && !isPreparedPhase(own.phase)) {
      const { record } = reconcileRunRecord(own, this.options.readIdentity(), {
        home: this.options.home,
        prefix: this.prefix,
        now: this.now,
      }, { live: false })
      this.persist(record)
      this.stopWatcher()
    }
    try { rmSync(runPidPath(this.options.home), { force: true }) } catch { /* best effort */ }
    return this.run()
  }

  /**
   * Cancel the live run through the engine's own `dsh update --cancel --json`
   * (bounded), so the pre-switch/sweep/refusal rules stay in the engine. On a
   * successful cancel the record is relayed into `cancelled`: the plugin's own
   * record when it started the run, otherwise one synthesized from the (now
   * terminal) engine marker.
   *
   * @returns the engine's outcome and the resulting record.
   * @throws RunRefusedError when the shim is missing.
   */
  async cancel(): Promise<UpdateCancelOutcome> {
    const current = this.run()
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home)
    if (shim === null) {
      throw new RunRefusedError(
        'shim-missing',
        `updateCheck.cancel: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`,
      )
    }
    const outcome = await (this.options.cancelEngine ?? cancelEngineRun)({
      shim,
      env: this.probeEnvironment(),
      ...(this.options.cancelTimeoutMs === undefined ? {} : { timeoutMs: this.options.cancelTimeoutMs }),
    })
    if (outcome.status !== 'cancelled') {
      return { status: outcome.status, message: outcome.message, record: current }
    }
    return { status: 'cancelled', message: outcome.message, record: this.relayCancelled(current) }
  }

  /**
   * Relay a successful engine cancel into the record the UI renders. A
   * terminal record is authoritative and is never overwritten: the run may
   * have finished (done/failed/rolledback) between the engine's eligibility
   * read and its kill, and that outcome must survive the cancel relay.
   */
  private relayCancelled(current: UpdateRunRecord | null): UpdateRunRecord | null {
    if (current !== null && current.result !== null) return current
    if (current !== null && current.observed !== true) {
      const next = this.terminalRecord(current, 'cancelled')
      this.persist(next)
      this.stopWatcher()
      return next
    }
    const marker = readRunMarker(this.prefix)
    if (marker === null) return current
    const record = observedRecordFromMarker(marker, {
      prefix: this.prefix,
      channel: this.options.readIdentity().channel,
    })
    this.loaded = true
    this.persist(record)
    return record
  }

  /** Stop the watcher (plugin unload). The updater itself keeps running. */
  dispose(): void {
    this.stopWatcher()
  }

  /** Persist a fresh record for `mode`, launch its engine invocation, and watch it. */
  private begin(mode: UpdateRunMode, pin: { target: string; channel: string }): UpdateRunRecord {
    const shim = (this.options.resolveShim ?? resolveShimPath)(this.options.home)
    if (shim === null) {
      throw new RunRefusedError(
        'shim-missing',
        `updateCheck.${mode === 'apply' ? 'apply' : 'start'}: the dsh shim was not found (checked the recorded binDir and ${defaultShimPath()})`,
      )
    }
    const home = this.options.home
    const logPath = runLogPath(home)
    const pidFile = runPidPath(home)
    const base: UpdateRunRecord = {
      runId: (this.options.runId ?? (() => randomUUID().replace(/-/g, '').slice(0, 10)))(),
      target: pin.target,
      channel: pin.channel,
      mode,
      rung: rungForMode(mode),
      phase: 'starting',
      step: 0,
      steps: RUN_STEP_TOTAL,
      lastLine: '',
      startedAt: this.now().toISOString(),
      pid: null,
      logPath,
      result: null,
      launcher: 'pending',
      staged: mode === 'apply' ? stagedApplyReady(this.prefix) : false,
      logTail: [],
    }
    // A new run owns a fresh log; reconcile never deletes it, begin does.
    // The directory is created here so a launch failure still leaves the
    // (empty) log the UI tails.
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      writeFileSync(logPath, '')
      rmSync(pidFile, { force: true })
    } catch {
      // The wrapper recreates both; a stale log only confuses the tail.
    }
    this.loaded = true
    this.persist(base)
    this.launch(base, shim)
    return this.run() ?? base
  }

  /** Launch through the ladder, persist the outcome, and start watching. */
  private launch(record: UpdateRunRecord, shim: string): void {
    const home = this.options.home
    let outcome: LaunchOutcome
    try {
      const input: LaunchUpdaterInput = {
        home,
        prefix: this.prefix,
        shim,
        flag: modeFlag(record.mode),
        ...(record.mode === 'apply' ? {} : { channel: record.channel }),
        runId: record.runId,
        logPath: record.logPath,
        pidFile: runPidPath(home),
        ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
        ...(this.options.hasCommand === undefined ? {} : { hasCommand: this.options.hasCommand }),
        ...(this.options.uid === undefined ? {} : { uid: this.options.uid }),
        ...(this.options.baseEnv === undefined ? {} : { baseEnv: this.options.baseEnv }),
        ...(this.options.probeHomeDir === undefined ? {} : { probeHomeDir: this.options.probeHomeDir }),
      }
      outcome = (this.options.launch ?? launchUpdater)(input)
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
      const verb = error instanceof LaunchEnvironmentError ? 'updateCheck.start' : `updateCheck.${record.mode === 'apply' ? 'apply' : 'start'}`
      throw new RunRefusedError('launch-failed', `${verb}: could not launch the updater: ${message}`)
    }
    const started: UpdateRunRecord = {
      ...record,
      launcher: outcome.rung satisfies LaunchRung,
      rung: rungForMode(record.mode),
      pid: outcome.pid,
      phase: executingPhase(record.mode),
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
    const staged = stagedApplyReady(this.prefix)
    const wrapperPid = readRunPid(runPidPath(this.options.home))
    const pid = wrapperPid ?? record.pid
    const alive = pid !== null && (this.options.isAlive ?? isProcessAlive)(pid)
    const startedAtMs = Date.parse(record.startedAt)
    const withinGrace = wrapperPid === null
      && Number.isFinite(startedAtMs)
      && this.now().getTime() - startedAtMs < RUN_START_GRACE_MS
    const base: UpdateRunRecord = {
      ...record,
      step: parsed.step > 0 ? parsed.step : record.step,
      steps: parsed.steps,
      lastLine: parsed.lastLine === '' ? record.lastLine : parsed.lastLine,
      logTail: parsed.logTail,
      pid,
      staged,
    }

    // The prepared resting state: nothing to watch while the marker exists; a
    // vanished marker means a new update must be prepared from scratch.
    if (isPreparedPhase(record.phase)) {
      if (staged) {
        this.persist(base)
        this.stopWatcher()
        return
      }
      this.persist(this.failedRecord(base, 'the staged update disappeared before it was applied'))
      this.stopWatcher()
      return
    }

    if (parsed.result !== null) {
      this.persist(this.terminalRecord(base, parsed.result))
      if (!alive) this.stopWatcher()
      return
    }

    if (!alive && !withinGrace) {
      if (record.mode === 'prepare' && staged) {
        this.persist(preparedRecord(base, this.now))
        this.stopWatcher()
        return
      }
      this.persist(this.failedRecord(
        base,
        parsed.lastLine === ''
          ? `the ${record.mode} run exited before writing any output`
          : `the ${record.mode} run exited before reporting a result (last line: ${parsed.lastLine})`,
      ))
      this.stopWatcher()
      return
    }

    this.persist({
      ...base,
      phase: alive || parsed.step > 0 ? executingPhase(record.mode) : record.phase,
    })
  }

  /** One failed record from the current tail. */
  private failedRecord(base: UpdateRunRecord, reason: string): UpdateRunRecord {
    return {
      ...base,
      phase: 'failed' satisfies UpdatePhase,
      result: 'failed',
      finishedAt: this.now().toISOString(),
      reason,
    }
  }

  /** One terminal record from the parsed result. */
  private terminalRecord(base: UpdateRunRecord, result: NonNullable<UpdateRunRecord['result']>): UpdateRunRecord {
    return {
      ...base,
      phase: result,
      result,
      finishedAt: this.now().toISOString(),
      ...(result === 'success' ? {} : { reason: base.lastLine === '' ? `the ${base.mode} run reported ${result}` : base.lastLine }),
    }
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
  /**
   * Strong liveness: terminal/prepared records are never live; the pid must be
   * live and non-zombie; and the run's own files must have moved inside the
   * stall window — a recycled pid or a dead process behind a live-looking pid
   * never blocks. Missing file evidence counts as live (never auto-heal on
   * absent evidence).
   */
  private isAliveRecord(record: UpdateRunRecord): boolean {
    if (record.result !== null || isPreparedPhase(record.phase)) return false
    const probe = this.options.isAlive ?? isProcessLive
    if (record.observed === true) {
      // The observed record's pid and log are the engine's own.
      if (record.pid === null || !probe(record.pid)) return false
      const age = progressAgeMs(record.logPath === '' ? [] : [record.logPath], this.now().getTime())
      return !isProgressStale(age)
    }
    // The wrapper pid file is the primary anchor for plugin-started runs; the
    // record's own pid is the fallback.
    const pid = effectivePid(this.options.home, record)
    if (pid === null || !probe(pid)) return false
    // Freshness evidence is the run log only: the pid file is written once at
    // launch and says nothing about progress.
    const age = progressAgeMs([record.logPath], this.now().getTime())
    return !isProgressStale(age)
  }

  /** Whether a run must block a new start/apply: strong liveness, or the engine's own live run matching it. */
  private blockingRun(record: UpdateRunRecord): boolean {
    if (record.result !== null || isPreparedPhase(record.phase)) return false
    return this.isAliveRecord(record) || this.engineRunActiveFor(record)
  }
}
