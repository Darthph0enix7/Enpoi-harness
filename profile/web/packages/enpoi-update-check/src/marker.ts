/**
 * enpoi-update-check — the engine run marker (`$PREFIX/harness/.update-run.json`).
 *
 * The running installer is the marker's sole writer (scripts/install.sh); the
 * plugin reads it to observe an update started outside the UI (e.g. a plain
 * `dsh update` in a terminal) and to relay the engine's cancel outcome. The
 * field set is the engine's CLI/UI contract: `runId, pid, mode, step, steps,
 * phase, startedAt, logPath, version, target`, where mode is
 * `plain|prepare|apply|one-shot` and phase runs `running → switching →
 * applying → done` with `failed|rolledback|cancelled` terminal.
 *
 * A dead (or zombie) pid makes the marker STALE: it never blocks anything and
 * the next run replaces it, so the observer reports nothing for a stale
 * marker — except the cancel relay, which deliberately reads the terminal
 * `cancelled` phase a cancel just wrote.
 *
 * @module dsh-enpoi-update-check/marker
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isProgressStale, progressAgeMs, readRunLog, RUN_STALE_WINDOW_MS, rungForMode, stagedApplyReady,
  type UpdatePhase, type UpdateRunMode, type UpdateRunRecord, type UpdateRunResult,
} from './run.js'

/** Marker file name under `<prefix>/harness`. */
export const RUN_MARKER_FILE = '.update-run.json'

/** Marker path for one install prefix. */
export function runMarkerPath(prefix: string): string {
  return join(prefix, 'harness', RUN_MARKER_FILE)
}

/** The engine's run modes as the marker records them. */
export type MarkerMode = 'plain' | 'prepare' | 'apply' | 'one-shot'

/** The engine's marker phases. */
export type MarkerPhase = 'running' | 'switching' | 'applying' | 'done' | 'failed' | 'rolledback' | 'cancelled'

/** One parsed marker document. */
export interface EngineRunMarker {
  readonly runId: string
  readonly pid: number
  readonly mode: MarkerMode
  readonly step: number
  readonly steps: number
  readonly phase: MarkerPhase
  readonly startedAt: string
  readonly logPath: string
  readonly version: string
  readonly target: string
}

const MARKER_MODES: readonly MarkerMode[] = ['plain', 'prepare', 'apply', 'one-shot']
const MARKER_PHASES: readonly MarkerPhase[] = ['running', 'switching', 'applying', 'done', 'failed', 'rolledback', 'cancelled']

/** Whether a raw value is one of the engine's marker modes. */
function isMarkerMode(value: unknown): value is MarkerMode {
  return typeof value === 'string' && (MARKER_MODES as readonly string[]).includes(value)
}

/** Whether a raw value is one of the engine's marker phases. */
function isMarkerPhase(value: unknown): value is MarkerPhase {
  return typeof value === 'string' && (MARKER_PHASES as readonly string[]).includes(value)
}

/**
 * Read the engine marker, or null when absent/unreadable/not a marker.
 * @param prefix - install prefix (the marker lives beside `harness/current`).
 * @returns the parsed marker, or null.
 */
export function readRunMarker(prefix: string): EngineRunMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runMarkerPath(prefix), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    if (typeof raw.runId !== 'string' || typeof raw.pid !== 'number' || !Number.isFinite(raw.pid)) return null
    if (!isMarkerMode(raw.mode) || !isMarkerPhase(raw.phase)) return null
    return {
      runId: raw.runId,
      pid: Math.trunc(raw.pid),
      mode: raw.mode,
      step: typeof raw.step === 'number' && Number.isFinite(raw.step) ? raw.step : 0,
      steps: typeof raw.steps === 'number' && raw.steps > 0 ? raw.steps : 0,
      phase: raw.phase,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
      logPath: typeof raw.logPath === 'string' ? raw.logPath : '',
      version: typeof raw.version === 'string' ? raw.version : '',
      target: typeof raw.target === 'string' ? raw.target : '',
    }
  } catch {
    return null
  }
}

/**
 * Whether a process is alive and not a zombie — the engine's `pid_live`
 * (`kill -0` guarded, then `ps -o stat=` / `/proc/<pid>/stat` state `Z*`).
 * @param pid - process id.
 * @param platform - platform selector (tests).
 * @returns true when the process exists and is not a zombie.
 */
export function isProcessLive(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      // The comm field may contain spaces/parens; the state is the first field
      // after the last ')'.
      const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]
      return state !== undefined && !state.startsWith('Z') && state !== 'X'
    } catch {
      return false
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return out !== '' && !out.startsWith('Z') && !out.startsWith('X')
  } catch {
    // Without ps the signal probe above still proves existence; zombie
    // detection is impossible here, so the process counts as live.
    return true
  }
}

/** Liveness inputs beyond the pid probe. */
export interface MarkerLivenessOptions {
  /**
   * How long ago the newest of the marker/log files moved. `undefined` means
   * no evidence was gathered (callers without a prefix): the marker then
   * counts as fresh rather than stalled. `null` means evidence was gathered
   * but nothing was readable: absent evidence never counts as live.
   */
  readonly progressAgeMs?: number | null
  /** Stall window override (tests). */
  readonly staleWindowMs?: number
}

/**
 * Whether a marker names a live engine run: terminal phases are never live
 * (regardless of a recycled pid), the pid must be live and non-zombie, and
 * the marker/log must have moved within the stall window when that evidence
 * is available. Gathered-but-absent evidence (`progressAgeMs: null`) is not
 * live either: a recycled pid behind deleted files must never keep a gate
 * refusing.
 *
 * @param marker - the parsed marker.
 * @param isAlive - process probe.
 * @param options - progress age/window.
 * @returns true only for a genuinely progressing run.
 */
export function isMarkerLive(
  marker: EngineRunMarker,
  isAlive: (pid: number) => boolean = isProcessLive,
  options: MarkerLivenessOptions = {},
): boolean {
  if (resultFromMarkerPhase(marker.phase) !== null) return false
  if (marker.pid <= 0 || !isAlive(marker.pid)) return false
  const age = options.progressAgeMs
  if (age === null) return false
  if (age !== undefined && isProgressStale(age, options.staleWindowMs ?? RUN_STALE_WINDOW_MS)) return false
  return true
}

/**
 * How long ago the marker or its log last moved, or null when neither is
 * readable (no evidence).
 * @param marker - the parsed marker.
 * @param prefix - install prefix (the marker path).
 * @param nowMs - current time in ms.
 * @returns age in ms, or null.
 */
export function markerProgressAge(marker: EngineRunMarker, prefix: string, nowMs: number): number | null {
  return progressAgeMs([runMarkerPath(prefix), ...(marker.logPath === '' ? [] : [marker.logPath])], nowMs)
}

/** The run mode a marker mode maps to in the plugin's record. */
export function modeFromMarker(mode: MarkerMode): UpdateRunMode {
  if (mode === 'prepare') return 'prepare'
  if (mode === 'apply') return 'apply'
  return 'one-shot'
}

/** The plugin phase a marker phase maps to. */
export function phaseFromMarker(phase: MarkerPhase): UpdatePhase {
  switch (phase) {
    case 'running': return 'preparing'
    case 'switching': return 'applying'
    case 'applying': return 'applying'
    case 'done': return 'success'
    case 'failed': return 'failed'
    case 'rolledback': return 'rolledback'
    case 'cancelled': return 'cancelled'
  }
}

/** The terminal result a marker phase names, or null while non-terminal. */
export function resultFromMarkerPhase(phase: MarkerPhase): UpdateRunResult | null {
  if (phase === 'done') return 'success'
  if (phase === 'failed' || phase === 'rolledback' || phase === 'cancelled') return phase
  return null
}

/** Inputs for {@link observedRecordFromMarker}. */
export interface ObservedRecordContext {
  /** Install prefix (`hasStagedApply` reads the staged marker here). */
  readonly prefix: string
  /** Channel for the observed record (the marker carries none). */
  readonly channel: string
  /** Read the engine log tail (seam; defaults to the bounded reader). */
  readonly readLog?: (logPath: string) => { lastLine: string; logTail: readonly string[] }
}

/**
 * Synthesize the plugin's run record from one marker document, so a run
 * started outside the UI renders through the existing client states. The
 * marker's mode maps to `one-shot` for `plain`/`one-shot` and to the
 * two-phase mode otherwise; `running` maps to the executing phase of that
 * mode and terminal phases to their mirrored phase/result.
 *
 * @param marker - the parsed marker.
 * @param context - prefix/channel and the log-reader seam.
 * @returns the observed record (`observed: true`).
 */
export function observedRecordFromMarker(marker: EngineRunMarker, context: ObservedRecordContext): UpdateRunRecord {
  const mode = modeFromMarker(marker.mode)
  const parsed = context.readLog === undefined
    ? (marker.logPath === '' ? { lastLine: '', logTail: [] } : readRunLog(marker.logPath))
    : context.readLog(marker.logPath)
  const result = resultFromMarkerPhase(marker.phase)
  const finishedAt = result === null ? undefined : (marker.startedAt === '' ? undefined : marker.startedAt)
  return {
    runId: marker.runId,
    target: marker.target !== '' ? marker.target : marker.version,
    channel: context.channel,
    mode,
    rung: rungForMode(mode),
    phase: phaseFromMarker(marker.phase),
    step: marker.step,
    steps: marker.steps === 0 ? 9 : marker.steps,
    lastLine: parsed.lastLine,
    startedAt: marker.startedAt,
    pid: marker.pid,
    logPath: marker.logPath,
    result,
    launcher: 'external',
    staged: stagedApplyReady(context.prefix),
    logTail: [...parsed.logTail],
    observed: true,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(result === null || result === 'success' ? {} : { reason: parsed.lastLine }),
  }
}
