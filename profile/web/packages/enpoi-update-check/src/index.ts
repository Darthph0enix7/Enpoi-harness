/**
 * enpoi-update-check — host-side update check (docs/plan/ui-update-manifest.md
 * P2) and the in-app update run (P4).
 *
 * What it owns:
 * - The periodic catalog check: a jittered boot check (~30 s base) and a
 *   jittered interval (default every 6 h) against the install's channel
 *   (`stable` or `beta`, from `$DSH_HOME/harness/install-state.json`).
 * - The install-vs-newest comparison and the `unknown | current | available |
 *   dismissed` status, exposed as the `updateCheck` Typert Remote namespace
 *   (`status`, `checkNow`, `dismiss`).
 * - The one update run: `updateCheck.start` pins the target and launches the
 *   installed shim detached (`updateCheck/run` reports the record while the
 *   watcher refreshes it); a boot reconcile resolves a run whose watcher died
 *   with the previous service instance.
 * - The persisted per-install skip record
 *   (`$DSH_HOME/update-check/dismissed.json`); a newer catalog version re-arms.
 *
 * The check is advisory; the run is operator-triggered exactly once, at the
 * [Update now] click. Every failure is fail-soft — the check keeps its last
 * successful comparison, and a failed run leaves a readable record plus log
 * tail for Retry. There is no client push in this profile plugin family, so
 * status and run are pollable through the Remote namespace only; the P3 UI
 * surface owns the polling cadence.
 *
 * @module dsh-enpoi-update-check
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { fetchCatalog, readInstallIdentity } from './catalog.js'
import { UpdateCheckService } from './remote.js'
import { UpdateRunController } from './run-service.js'
import { UpdateCheckCore, startUpdateCheckSchedule } from './service.js'
import { readDismissedVersion, writeDismissedVersion } from './store.js'

/** Cordis plugin name. */
export const name = 'enpoi-update-check'

/** Nothing is required at plugin scope: the check must attach on a bare tree. */
export const inject: string[] = []

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Detach every Config field into plain values (idempotent on pre-0.1.7 plain configs). */
function plainConfig<T extends object>(config: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config)) {
    out[key] = typeof (field as { get?: () => unknown } | undefined)?.get === 'function'
      ? (field as { get: () => unknown }).get()
      : field
  }
  return out as T
}

/** Plugin configuration (schemastery-validated by the loader; live-editable). */
export interface Config {
  /** Schedule automatic checks (default true). Manual `updateCheck.checkNow` still works when false. */
  enabled?: Volatile<boolean>
  /** Check interval in minutes (default 360; clamped to 1–10080). */
  intervalMinutes?: Volatile<number>
  /** Jitter bound in seconds added to the boot delay and every interval (default 300; clamped to 0–3600). */
  jitterSeconds?: Volatile<number>
}

/**
 * Schemastery validator for {@link Config}. Every field is `.volatile()`: the
 * merged settings service derives live forms from this schema and persists
 * edits through the active profile patch without remounting the plugin.
 */
export const Config: Schema<Config> = Schema.object({
  enabled: live(Schema.boolean().default(true)),
  intervalMinutes: live(Schema.number().default(360)),
  jitterSeconds: live(Schema.number().default(300)),
})

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.trunc(numeric), min), max)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Mount the update check. A failure here disables the plugin loudly on stderr
 * and returns — it must never take the boot or a sibling plugin down with it.
 *
 * @param ctx - owning context.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  config = plainConfig(config)
  try {
    const homeResolver = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const resolveHome = typeof homeResolver === 'function' ? homeResolver : dshHomePath
    const home = resolveHome()
    const identity = readInstallIdentity(home)
    const dismissedPath = resolveHome('update-check', 'dismissed.json')
    const intervalMinutes = clamp(config.intervalMinutes, 1, 10_080, 360)
    const jitterSeconds = clamp(config.jitterSeconds, 0, 3_600, 300)

    const core = new UpdateCheckCore({
      identity,
      fetchCatalog: channel => fetchCatalog(channel),
      readDismissed: () => readDismissedVersion(dismissedPath),
      writeDismissed: version => { writeDismissedVersion(dismissedPath, version) },
      onFailure: message => { ctx.logger.debug(`enpoi-update-check: ${message}`) },
    })

    // The run controller owns the one active `dsh update` process. It
    // re-reads the install identity at call time: a run that switched the
    // tree while this service was restarting must reconcile against the NEW
    // state, not the identity captured at mount.
    const runs = new UpdateRunController({
      home,
      readIdentity: () => readInstallIdentity(home),
      readStatus: () => core.snapshot(),
      onUpdate: record => {
        ctx.logger.debug(`enpoi-update-check: run ${record.runId} phase=${record.phase} step=${String(record.step)}/${String(record.steps)}${record.result === null ? '' : ` result=${record.result}`}`)
      },
    })
    ctx.effect(() => () => { runs.dispose() }, 'enpoi-update-check.run-watcher')
    // Boot reconcile: resolve a run whose watcher died with the previous
    // service instance (mid-run restart). Idempotent and log-preserving.
    try {
      const reconciled = runs.reconcile()
      if (reconciled !== null) {
        ctx.logger.info(`enpoi-update-check: reconciled run ${reconciled.runId} (phase=${reconciled.phase}${reconciled.result === null ? '' : ` result=${reconciled.result}`})`)
      }
    } catch (error) {
      ctx.logger.debug(`enpoi-update-check: run reconcile failed — ${errorText(error)}`)
    }
    // Capability probe, once per plugin boot: a two-phase engine gets the
    // staged prepare/apply flow, an older engine the one-shot update. The
    // result is cached for the controller's lifetime; unsupported is logged
    // loudly because it selects a different, restart-in-run flow.
    void runs.probe().then((capability) => {
      if (capability.capability === 'supported') {
        ctx.logger.debug('enpoi-update-check: engine supports --prepare (two-phase rung)')
      } else {
        ctx.logger.info(`enpoi-update-check: engine does not support --prepare (one-shot rung) — ${capability.reason ?? 'no reason recorded'}`)
      }
    })

    // The status surface exists even when checks are disabled, so the operator
    // can still read the last result and call checkNow explicitly.
    ctx.plugin(UpdateCheckService, { core, runs })

    if (config.enabled !== false) {
      const stop = startUpdateCheckSchedule({
        run: () => { void core.checkNow() },
        intervalMs: intervalMinutes * 60_000,
        jitterMs: jitterSeconds * 1000,
      })
      ctx.effect(() => stop, 'enpoi-update-check.schedule')
    }

    const mounted = `enpoi-update-check mounted (home=${home} channel=${identity.channel} version=${identity.version === '' ? 'unknown' : identity.version} interval=${intervalMinutes}m checks=${config.enabled === false ? 'off' : 'on'})`
    process.stderr.write(`[enpoi-update-check] ${mounted}\n`)
    ctx.logger.info(`enpoi-update-check: ${mounted}`)
  } catch (error) {
    process.stderr.write(`[enpoi-update-check] disabled — ${errorText(error)}\n`)
  }
}

export {
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_RAW_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  catalogUrl,
  commitsMatch,
  compareVersions,
  fetchCatalog,
  MIN_COMMIT_PREFIX,
  parseCatalogDocument,
  readInstallIdentity,
  type CatalogEntry,
  type InstallIdentity,
} from './catalog.js'
export {
  commandOnPath,
  defaultShimPath,
  launchPlan,
  launchUpdater,
  launchWrapper,
  LaunchEnvironmentError,
  listLaunchdJobs,
  removeLaunchdJob,
  resolveLaunchEnvironment,
  resolveRuntime,
  resolveRuntimePath,
  RUN_HOME_ENV,
  systemBinDirs,
  UPDATE_JOB_LABEL_PREFIX,
  UPDATE_MODE_ENV,
  updateJobLabel,
  wrapperArgs,
  type LaunchChild,
  type LaunchCommandResult,
  type LaunchCommandRun,
  type LaunchEnvironment,
  type LaunchOutcome,
  type LaunchPlanInput,
  type LaunchPlanStep,
  type LaunchRung,
  type LaunchSpawn,
  type LaunchUpdaterInput,
  type RuntimeProbe,
  type RuntimeSource,
} from './launcher.js'
export {
  CANCEL_OUTPUT_CAP,
  CANCEL_TIMEOUT_MS,
  cancelEngineRun,
  parseCancelJson,
  type CancelChild,
  type CancelEngineInput,
  type CancelSpawn,
  type EngineCancelOutcome,
  type EngineCancelStatus,
} from './cancel.js'
export {
  isMarkerLive,
  isProcessLive,
  markerProgressAge,
  modeFromMarker,
  observedRecordFromMarker,
  phaseFromMarker,
  readRunMarker,
  resultFromMarkerPhase,
  RUN_MARKER_FILE,
  runMarkerPath,
  type EngineRunMarker,
  type MarkerLivenessOptions,
  type MarkerMode,
  type MarkerPhase,
  type ObservedRecordContext,
} from './marker.js'
export {
  ENGINE_PROBE_OUTPUT_CAP,
  ENGINE_PROBE_TIMEOUT_MS,
  probeEngineCapability,
  type EngineCapability,
  type EngineProbeInput,
  type EngineProbeResult,
  type ProbeChild,
  type ProbeSpawn,
} from './probe.js'
export { UPDATE_CHECK_NAMESPACE, UpdateCheckService, type DismissRequest, type UpdateCheckServiceOptions } from './remote.js'
export {
  APPLY_SWITCH_STEP,
  effectivePid,
  executingPhase,
  hasStagedApply,
  isPreparedPhase,
  isProcessAlive,
  isRunActive,
  isTerminalPhase,
  fileMtimeMs,
  isProgressStale,
  LOG_TAIL_BYTES,
  LOG_TAIL_LINES,
  modeFlag,
  modeLabel,
  progressAgeMs,
  parseRunLog,
  phaseForResult,
  preparedRecord,
  readRunLog,
  readRunPid,
  readRunRecord,
  readStagedApply,
  reconcileRunRecord,
  resultFromLine,
  RUN_STALE_WINDOW_MS,
  RUN_STEP_TOTAL,
  rungForMode,
  runLogPath,
  runPidPath,
  runRecordPath,
  sameRunRecord,
  stagedApplyPath,
  stagedApplyReady,
  stagedTreeReady,
  terminalRecord,
  updateCheckDir,
  writeRunRecord,
  type ParsedRunLog,
  type ReconcileContext,
  type StagedApplyRecord,
  type UpdatePhase,
  type UpdateRunMode,
  type UpdateRunRecord,
  type UpdateRunResult,
  type UpdateRung,
} from './run.js'
export {
  resolvePrefix,
  resolveShimPath,
  RunRefusedError,
  RUN_START_GRACE_MS,
  UpdateRunController,
  type RunRefusalReason,
  type RunTimers,
  type UpdateCancelOutcome,
  type UpdateRunControllerOptions,
} from './run-service.js'
export {
  FIRST_CHECK_DELAY_MS,
  jitteredDelay,
  startUpdateCheckSchedule,
  UpdateCheckCore,
  type UpdateCheckCoreOptions,
  type UpdateCheckLatest,
  type UpdateCheckScheduleOptions,
  type UpdateCheckState,
  type UpdateCheckStatus,
  type UpdateCheckTimers,
} from './service.js'
export { readDismissedVersion, writeDismissedVersion, type DismissedRecord } from './store.js'
