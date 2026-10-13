/**
 * enpoi-update-check — the update-run record, log parser, and restart
 * reconcile (docs/plan/ui-update-manifest.md P4).
 *
 * One run is one detached `dsh update` process. The host writes
 * `$DSH_HOME/update-check/run.json` before launch and refreshes it while the
 * process lives; the updater's stdout+stderr land in
 * `$DSH_HOME/update-check/run.log`, and the `[N/9]` step markers plus the
 * terminal result lines in that log are the progress contract. The current
 * engine prints exactly nine numbered steps on every update path
 * ("Every path prints the same nine numbered phases", scripts/install.sh):
 *
 * | step | phase       | engine step label |
 * |------|-------------|-------------------|
 * | 1    | `fetch`     | environment: existing install |
 * | 2    | `fetch`     | source: <channel> archive |
 * | 3    | `verify`    | pnpm: corepack |
 * | 4    | `unpack`    | dependencies and build |
 * | 5    | `deps`      | transport (delta / full release apply / prebuilt / source build) |
 * | 6    | `profile`   | profile: <name> |
 * | 7    | `profile`   | home, dependencies and migrations |
 * | 8    | `switch`    | switch, service and backfill |
 * | 9    | `selfcheck` | self-check (+ health proof) |
 *
 * Terminal phases come from the log's result lines, checked in this order:
 * `rolled back` (failure that restored the previous tree) → `result:
 * 'rolledback'`; `successfully updated` or `already up to date` → `result:
 * 'success'`; any other `FAILED`/`✗ ERROR:` line → `result: 'failed'`. The
 * phases `done`, `failed`, and `rolledback` are the terminal phase names that
 * mirror those results.
 *
 * Everything here is decorator-free and I/O-light so the profile vitest
 * pipeline exercises the parser, the record store, and the reconcile directly.
 *
 * @module dsh-enpoi-update-check/run
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { compareVersions, type InstallIdentity } from './catalog.js'

/** Progress phases a run reports; `starting` precedes the first log step. */
export type UpdatePhase =
  | 'starting'
  | 'fetch'
  | 'verify'
  | 'unpack'
  | 'deps'
  | 'profile'
  | 'switch'
  | 'selfcheck'
  | 'done'
  | 'failed'
  | 'rolledback'

/** Terminal outcomes of a run. */
export type UpdateRunResult = 'success' | 'failed' | 'rolledback'

/** Engine step total the current updater prints. */
export const RUN_STEP_TOTAL = 9

/**
 * Step-band to phase table, indexed by `step - 1` (see the module table for
 * the engine step each band names).
 */
export const STEP_PHASES: readonly UpdatePhase[] = [
  'fetch',
  'fetch',
  'verify',
  'unpack',
  'deps',
  'profile',
  'profile',
  'switch',
  'selfcheck',
]

/** The terminal phase that mirrors one result. */
export function phaseForResult(result: UpdateRunResult): UpdatePhase {
  return result === 'success' ? 'done' : result
}

/** Phase band for a 1-based step number; unknown numbers degrade to `fetch`. */
export function phaseForStep(step: number): UpdatePhase {
  if (!Number.isFinite(step) || step < 1) return 'starting'
  return STEP_PHASES[Math.min(Math.trunc(step), RUN_STEP_TOTAL) - 1] ?? 'fetch'
}

/** One update run as persisted in `run.json` and returned over the Remote. */
export interface UpdateRunRecord {
  /** Unique run id; also the `dsh-update-<runId>` unit/label suffix. */
  readonly runId: string
  /** Target release version pinned at launch (e.g. `0.1.7-enpoi.2.84`). */
  readonly target: string
  /** Channel pinned at launch (`stable` or `beta`). */
  readonly channel: string
  /** Current progress phase; starts `starting` and ends terminal. */
  readonly phase: UpdatePhase
  /** Current 1-based engine step; 0 before the first `[N/9]` marker. */
  readonly step: number
  /** Engine step total as last seen in the log (9 for the current engine). */
  readonly steps: number
  /** Last non-empty log line, shown verbatim by the UI. */
  readonly lastLine: string
  /** Run start time, ISO 8601. */
  readonly startedAt: string
  /** Updater process id; null when the launcher reported none. */
  readonly pid: number | null
  /** Absolute path of the run log the UI tails. */
  readonly logPath: string
  /** Terminal result, or null while the run is active. */
  readonly result: UpdateRunResult | null
  /** Launcher rung that started the process (`systemd-run|launchctl|setsid|spawn`). */
  readonly rung: string
  /** Bounded tail of the log (last {@link LOG_TAIL_LINES} non-empty lines). */
  readonly logTail: readonly string[]
  /** Completion time, ISO 8601; absent while the run is active. */
  readonly finishedAt?: string
  /** Human-readable terminal explanation for a failed/rolled-back run. */
  readonly reason?: string
}

/** One parsed log tail. */
export interface ParsedRunLog {
  /** Highest `[N/M]` step seen, 0 before the first marker. */
  readonly step: number
  /** Step total from the marker (`M`), {@link RUN_STEP_TOTAL} before the first. */
  readonly steps: number
  /** Last non-empty line, verbatim. */
  readonly lastLine: string
  /** Up to {@link LOG_TAIL_LINES} last non-empty lines, oldest first. */
  readonly logTail: readonly string[]
  /** Phase from the step band, or the terminal phase once a result line appears. */
  readonly phase: UpdatePhase
  /** Terminal result when a result line was seen. */
  readonly result: UpdateRunResult | null
}

/** How many log lines the record carries for the UI's failure surface. */
export const LOG_TAIL_LINES = 40

/** How many bytes of the log a tail read inspects. */
export const LOG_TAIL_BYTES = 64 * 1024

const STEP_MARKER = /\[(\d+)\/(\d+)\]/
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/** Strip ANSI color codes and carriage returns from one log line. */
function plain(line: string): string {
  return line.replace(ANSI, '').replace(/\r/g, '').trimEnd()
}

/**
 * Classify one line as a terminal result line, or null. The patterns are
 * case-sensitive on purpose: the engine prints `FAILED`/`✗ ERROR:` for a hard
 * failure, while lowercase "failed" appears inside non-terminal warnings
 * ("profile dependency refresh failed").
 * @param line - plain (ANSI-stripped) log line.
 * @returns the result the line announces, or null.
 */
export function resultFromLine(line: string): UpdateRunResult | null {
  if (/rolled back/i.test(line)) return 'rolledback'
  if (/successfully updated|already up to date/i.test(line)) return 'success'
  if (/\bFAILED\b|✗\s*ERROR:/.test(line)) return 'failed'
  return null
}

/**
 * Parse a log tail into the progress contract.
 *
 * @param text - raw log tail (any number of lines).
 * @returns step/steps, the phase band for the highest step, the bounded line
 *   tail, and the terminal result when a result line is present (the last
 *   result line wins).
 */
export function parseRunLog(text: string): ParsedRunLog {
  const lines = text.split('\n').map(plain).filter(line => line.trim() !== '')
  let step = 0
  let steps = RUN_STEP_TOTAL
  let result: UpdateRunResult | null = null
  for (const line of lines) {
    const marker = STEP_MARKER.exec(line)
    if (marker !== null) {
      const seen = Number(marker[1])
      if (Number.isFinite(seen) && seen > step) step = seen
      const total = Number(marker[2])
      if (Number.isFinite(total) && total > 0) steps = total
    }
    result = resultFromLine(line) ?? result
  }
  const logTail = lines.slice(-LOG_TAIL_LINES)
  const lastLine = lines.at(-1) ?? ''
  return {
    step,
    steps,
    lastLine,
    logTail,
    phase: result === null ? phaseForStep(step) : phaseForResult(result),
    result,
  }
}

/**
 * Read the bounded log tail. A missing or unreadable log parses as empty, so
 * the watcher keeps the previous record instead of failing.
 *
 * @param logPath - run log path.
 * @param maxBytes - byte window read from the end (default {@link LOG_TAIL_BYTES}).
 * @returns the parsed tail.
 */
export function readRunLog(logPath: string, maxBytes = LOG_TAIL_BYTES): ParsedRunLog {
  let text = ''
  try {
    const size = statSync(logPath).size
    const start = Math.max(0, size - maxBytes)
    const descriptor = readFileSync(logPath)
    // Only the tail window is decoded; a partial first line is harmless (its
    // step marker may be cut, the line is still a valid last-line candidate).
    text = descriptor.subarray(start).toString('utf8')
  } catch {
    text = ''
  }
  return parseRunLog(text)
}

/** `update-check` directory under the harness home. */
export function updateCheckDir(home: string): string {
  return `${home}/update-check`
}

/** `run.json` path for one home. */
export function runRecordPath(home: string): string {
  return `${updateCheckDir(home)}/run.json`
}

/** `run.log` path for one home. */
export function runLogPath(home: string): string {
  return `${updateCheckDir(home)}/run.log`
}

/** `run.pid` path: the updater's own pid, written by the launch wrapper. */
export function runPidPath(home: string): string {
  return `${updateCheckDir(home)}/run.pid`
}

/** Whether a parsed JSON value looks like a run record. */
function isRunRecord(value: unknown): value is UpdateRunRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string'
    && typeof record.target === 'string'
    && typeof record.phase === 'string'
    && typeof record.startedAt === 'string'
    && typeof record.logPath === 'string'
    && (record.result === null || record.result === 'success' || record.result === 'failed' || record.result === 'rolledback')
}

/**
 * Read the run record, or null when absent/unreadable.
 * @param file - `run.json` path.
 * @returns the record, or null.
 */
export function readRunRecord(file: string): UpdateRunRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRunRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write the run record atomically (tmp + rename). A write failure is silent:
 * the run itself must proceed even when the state file cannot be updated.
 *
 * @param file - `run.json` path.
 * @param record - the record to persist.
 * @returns true when the record was written.
 */
export function writeRunRecord(file: string, record: UpdateRunRecord): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temporary = `${file}.tmp.${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

/** Read the pid written by the launch wrapper, or null when absent/unreadable. */
export function readRunPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Whether a process is alive (`kill(pid, 0)`), never throwing.
 * @param pid - process id.
 * @returns true when the process exists (or exists without permission).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid a record's liveness should be judged by: the wrapper pid first, the launch pid as fallback. */
export function effectivePid(home: string, record: UpdateRunRecord): number | null {
  // The wrapper's own pid survives every launcher rung (the shim is exec'd in
  // place), while the launch pid names the transient launcher client and dies
  // as soon as the scheduler hands the job off.
  const pid = readRunPid(runPidPath(home))
  return pid ?? record.pid
}

/** Whether a run is still active: no terminal result and a live process. */
export function isRunActive(home: string, record: UpdateRunRecord): boolean {
  if (record.result !== null) return false
  const pid = effectivePid(home, record)
  return pid !== null && isProcessAlive(pid)
}

/**
 * Reconcile one record left behind by a dead watcher (the service restarted
 * mid-run). Idempotent: a terminal record is returned unchanged.
 *
 * - A live process means the run continues under a new watcher: the record is
 *   returned unchanged (the caller resumes watching).
 * - The install version equals the target: the switch already happened, so the
 *   run is recorded `success`.
 * - Any other dead-process record without a terminal result is `failed` with
 *   an explicit reason; the log is left untouched for the UI's tail.
 *
 * @param record - the persisted record.
 * @param identity - the install identity read at reconcile time.
 * @param now - clock for `finishedAt`.
 * @returns the reconciled record and whether it changed.
 */
export function reconcileRunRecord(
  record: UpdateRunRecord,
  identity: InstallIdentity,
  now: () => Date = () => new Date(),
  home?: string,
): { record: UpdateRunRecord; changed: boolean } {
  if (record.result !== null) return { record, changed: false }
  if (home !== undefined && isRunActive(home, record)) return { record, changed: false }
  if (home === undefined) {
    const pid = record.pid
    if (pid !== null && isProcessAlive(pid)) return { record, changed: false }
  }
  const finishedAt = now().toISOString()
  if (identity.version !== '' && identity.version === record.target) {
    return {
      record: { ...record, phase: 'done', result: 'success', finishedAt },
      changed: true,
    }
  }
  const version = identity.version === '' ? 'unknown' : identity.version
  return {
    record: {
      ...record,
      phase: 'failed',
      result: 'failed',
      finishedAt,
      reason: `updater is no longer running and the install version (${version}) does not match the target (${record.target})`,
    },
    changed: true,
  }
}

/** Whether two records persist identically (skip redundant writes). */
export function sameRunRecord(left: UpdateRunRecord, right: UpdateRunRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Compare an installed version against a run target; null when uncomparable. */
export function targetReached(installed: string, target: string): boolean | null {
  const comparison = compareVersions(installed, target)
  return comparison === null ? null : comparison >= 0
}
