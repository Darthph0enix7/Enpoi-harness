/**
 * enpoi-update-check — the update-run record, log parser, and restart
 * reconcile (docs/plan/ui-update-manifest.md P4, engine two-phase flags).
 *
 * One run is one detached `dsh update` process driving exactly one engine
 * flag. The host writes `$DSH_HOME/update-check/run.json` before launch and
 * refreshes it while the process lives; the updater's stdout+stderr land in
 * `$DSH_HOME/update-check/run.log`, and the `[N/9]` step markers plus the
 * terminal result lines in that log are the progress contract.
 *
 * | mode       | engine invocation          | witness                                    | phase |
 * |------------|----------------------------|--------------------------------------------|-------|
 * | `prepare`  | `dsh update --channel <c> --prepare` | `[1/9]`..`[7/9]`, then exit 0 with `$PREFIX/harness/.staged-apply.json` written | `starting` → `preparing` → `prepared` |
 * | `apply`    | `dsh update --apply`       | `[8/9] switch, service and backfill`, `[9/9] self-check`, the health proof, then the final result line | `applying` → `success` \| `failed` \| `rolledback` |
 * | `one-shot` | `dsh update --channel <c>` | the full `[1/9]`..`[9/9]` flow, then the final result line | `preparing` → `success` \| `failed` \| `rolledback` (never `prepared`) |
 *
 * A one-shot run exists for installs whose engine predates the two-phase
 * flags: the capability probe reports unsupported and the run includes the
 * switch and service restart itself. `rung` records which engine generation
 * the run targeted; `launcher` records the OS rung that started the process.
 *
 * The staged file is the prepare-success witness (the engine removes it on a
 * successful apply), and the install version equal to the run's target is the
 * post-restart success witness. Result lines are checked in this order:
 * `rolled back` → `rolledback`; `successfully updated` or `already up to
 * date` → `success`; any other `FAILED`/`✗ ERROR:` line → `failed`.
 *
 * Everything here is decorator-free and I/O-light so the profile vitest
 * pipeline exercises the parser, the record store, and the reconcile directly.
 *
 * @module dsh-enpoi-update-check/run
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstallIdentity } from './catalog.js'

/** The engine invocation a run drives. */
export type UpdateRunMode = 'prepare' | 'apply' | 'one-shot'

/** Which engine generation the run targets: the two-phase flags, or the legacy one-shot update. */
export type UpdateRung = 'two-phase' | 'one-shot'

/** Progress phases a run reports (the run.json contract, final). */
export type UpdatePhase =
  | 'starting'
  | 'preparing'
  | 'prepared'
  | 'applying'
  | 'success'
  | 'failed'
  | 'rolledback'
  | 'cancelled'

/** Terminal outcomes of a run. */
export type UpdateRunResult = 'success' | 'failed' | 'rolledback' | 'cancelled'

/** Engine step total the current updater prints. */
export const RUN_STEP_TOTAL = 9

/** Engine step at which the switch (and its service restart) begins. */
export const APPLY_SWITCH_STEP = 8

/** The progress phase while a run of `mode` is executing. A one-shot update prepares then switches in one run. */
export function executingPhase(mode: UpdateRunMode): 'preparing' | 'applying' {
  return mode === 'apply' ? 'applying' : 'preparing'
}

/** The terminal phase that mirrors one result. */
export function phaseForResult(result: UpdateRunResult): UpdatePhase {
  return result
}

/** Whether a phase is terminal (`result` is set). */
export function isTerminalPhase(phase: UpdatePhase): boolean {
  return phase === 'success' || phase === 'failed' || phase === 'rolledback' || phase === 'cancelled'
}

/** Whether a run is resting in the staged, restart-to-apply state. */
export function isPreparedPhase(phase: UpdatePhase): boolean {
  return phase === 'prepared'
}

/** The shim flag for a run mode; a one-shot update takes no phase flag. */
export function modeFlag(mode: UpdateRunMode): '--prepare' | '--apply' | 'one-shot' {
  if (mode === 'prepare') return '--prepare'
  if (mode === 'apply') return '--apply'
  return 'one-shot'
}

/** The engine generation a run mode targets. */
export function rungForMode(mode: UpdateRunMode): UpdateRung {
  return mode === 'one-shot' ? 'one-shot' : 'two-phase'
}

/** Human label for a run's engine invocation (failure reasons). */
export function modeLabel(mode: UpdateRunMode): string {
  return mode === 'one-shot' ? 'update' : mode
}

/** One update run as persisted in `run.json` and returned over the Remote. */
export interface UpdateRunRecord {
  /** Unique run id; also the `dsh-update-<runId>` unit/label suffix. */
  readonly runId: string
  /** Target release version pinned at launch (e.g. `0.1.7-enpoi.2.84`). */
  readonly target: string
  /** Channel pinned at launch (`stable` or `beta`). */
  readonly channel: string
  /** Which engine invocation this run drives. */
  readonly mode: UpdateRunMode
  /** Which engine generation the run targets. */
  readonly rung: UpdateRung
  /** Current progress phase; see the module table. */
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
  /** Terminal result, or null while the run is active or prepared. */
  readonly result: UpdateRunResult | null
  /** OS launcher rung that started the process (`systemd-run|launchctl|setsid|spawn`). */
  readonly launcher: string
  /** Whether `$PREFIX/harness/.staged-apply.json` exists at the last check. */
  readonly staged: boolean
  /** Bounded tail of the log (last {@link LOG_TAIL_LINES} non-empty lines). */
  readonly logTail: readonly string[]
  /** Completion time, ISO 8601; absent while the run is active or prepared. */
  readonly finishedAt?: string
  /** Human-readable terminal explanation for a failed/rolled-back/cancelled run. */
  readonly reason?: string
  /** True when the record was synthesized from the engine marker (a run started outside the UI). */
  readonly observed?: boolean
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
 *
 * Success lines: the one-shot flow's `Enpoi Harness successfully updated!`
 * summary, an apply's `Update applied: … — current → …`, and the no-op
 * `dsh is already up to date: …`. `Update prepared: …` is deliberately NOT a
 * result: a prepare run's witness is the staged-apply marker, so its line must
 * not turn the record terminal.
 * @param line - plain (ANSI-stripped) log line.
 * @returns the result the line announces, or null.
 */
export function resultFromLine(line: string): UpdateRunResult | null {
  if (/rolled back/i.test(line)) return 'rolledback'
  if (/successfully updated|already up to date|update applied:/i.test(line)) return 'success'
  if (/\bFAILED\b|✗\s*ERROR:/.test(line)) return 'failed'
  return null
}

/**
 * Parse a log tail into the progress contract.
 *
 * @param text - raw log tail (any number of lines).
 * @returns step/steps, the bounded line tail, and the terminal result when a
 *   result line is present (the last result line wins).
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
  return { step, steps, lastLine, logTail, result }
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
  return join(home, 'update-check')
}

/** `run.json` path for one home. */
export function runRecordPath(home: string): string {
  return join(updateCheckDir(home), 'run.json')
}

/** `run.log` path for one home. */
export function runLogPath(home: string): string {
  return join(updateCheckDir(home), 'run.log')
}

/** `run.pid` path: the updater's own pid, written by the launch wrapper. */
export function runPidPath(home: string): string {
  return join(updateCheckDir(home), 'run.pid')
}

/** The staged-apply marker the engine writes after a successful prepare. */
export function stagedApplyPath(prefix: string): string {
  return join(prefix, 'harness', '.staged-apply.json')
}

/** Whether the engine's staged-apply marker exists. */
export function hasStagedApply(prefix: string): boolean {
  return existsSync(stagedApplyPath(prefix))
}

/** Whether a raw value is one of the reported phases. */
function isUpdatePhase(value: unknown): value is UpdatePhase {
  return value === 'starting' || value === 'prepared' || value === 'preparing' || value === 'applying'
    || value === 'success' || value === 'failed' || value === 'rolledback' || value === 'cancelled'
}

/** Whether a raw value is one of the terminal results. */
function isUpdateResult(value: unknown): value is UpdateRunResult {
  return value === 'success' || value === 'failed' || value === 'rolledback' || value === 'cancelled'
}

/**
 * Normalize one parsed run.json document. Records written before the
 * rung/launcher split (the engine-capability work) carried the OS launcher in
 * `rung` and no `launcher`; they are healed here so an in-flight run survives
 * the plugin upgrade — a legacy prepared record must still read as two-phase
 * or the UI would never offer its restart.
 *
 * @param raw - the parsed document (required string fields already checked).
 * @returns the normalized record.
 */
function normalizeRunRecord(raw: Record<string, unknown>): UpdateRunRecord {
  const mode: UpdateRunMode = raw.mode === 'apply' || raw.mode === 'one-shot' ? raw.mode : 'prepare'
  const rung: UpdateRung = raw.rung === 'two-phase' || raw.rung === 'one-shot' ? raw.rung : rungForMode(mode)
  const launcher = typeof raw.launcher === 'string' && raw.launcher !== ''
    ? raw.launcher
    : typeof raw.rung === 'string' && raw.rung !== 'two-phase' && raw.rung !== 'one-shot' ? raw.rung : 'pending'
  const finishedAt = typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined
  const reason = typeof raw.reason === 'string' ? raw.reason : undefined
  return {
    runId: String(raw.runId),
    target: typeof raw.target === 'string' ? raw.target : '',
    channel: typeof raw.channel === 'string' ? raw.channel : 'stable',
    mode,
    rung,
    launcher,
    phase: isUpdatePhase(raw.phase) ? raw.phase : 'failed',
    step: typeof raw.step === 'number' && Number.isFinite(raw.step) ? raw.step : 0,
    steps: typeof raw.steps === 'number' && raw.steps > 0 ? raw.steps : RUN_STEP_TOTAL,
    lastLine: typeof raw.lastLine === 'string' ? raw.lastLine : '',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    pid: typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null,
    logPath: typeof raw.logPath === 'string' ? raw.logPath : '',
    result: isUpdateResult(raw.result) ? raw.result : null,
    staged: raw.staged === true,
    logTail: Array.isArray(raw.logTail) ? raw.logTail.filter((line): line is string => typeof line === 'string') : [],
    ...(raw.observed === true ? { observed: true } : {}),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Whether a parsed JSON value has the required run-record fields. */
function isRunRecordShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string'
    && typeof record.target === 'string'
    && typeof record.phase === 'string'
    && typeof record.startedAt === 'string'
    && typeof record.logPath === 'string'
    && (record.result === null || record.result === 'success' || record.result === 'failed'
      || record.result === 'rolledback' || record.result === 'cancelled')
}

/**
 * Read the run record, or null when absent/unreadable/malformed. Legacy
 * records are normalized (see {@link normalizeRunRecord}).
 * @param file - `run.json` path.
 * @returns the record, or null.
 */
export function readRunRecord(file: string): UpdateRunRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRunRecordShape(parsed) ? normalizeRunRecord(parsed) : null
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

/** Whether a run is still executing: no terminal result, not prepared, and a live process. */
export function isRunActive(home: string, record: UpdateRunRecord): boolean {
  if (record.result !== null || isPreparedPhase(record.phase)) return false
  const pid = effectivePid(home, record)
  return pid !== null && isProcessAlive(pid)
}

/** The terminal record for one result (the failure reason defaults to the last line). */
export function terminalRecord(
  record: UpdateRunRecord,
  result: UpdateRunResult,
  now: () => Date,
  staged: boolean,
): UpdateRunRecord {
  return {
    ...record,
    phase: phaseForResult(result),
    result,
    staged,
    finishedAt: now().toISOString(),
    ...(result === 'success' ? {} : { reason: record.lastLine === '' ? `${record.mode} run reported ${result}` : record.lastLine }),
  }
}

/** The resting record after a successful prepare (staged, awaiting apply). */
export function preparedRecord(record: UpdateRunRecord, now: () => Date = () => new Date()): UpdateRunRecord {
  // A record reaching this state never carried a failure reason (those are set
  // together with a terminal result), so spreading it cannot resurrect one.
  return { ...record, phase: 'prepared', result: null, staged: true, finishedAt: now().toISOString() }
}

/** Reconcile inputs beyond the record itself. */
export interface ReconcileContext {
  /** Harness home (`$DSH_HOME`), where the pid file and record live. */
  readonly home: string
  /** Install prefix, where `harness/.staged-apply.json` lives. */
  readonly prefix: string
  /** Clock for `finishedAt`. */
  readonly now?: () => Date
}

/**
 * Reconcile one record left behind by a dead watcher (the service restarted
 * mid-run, or the whole host came back). Idempotent: a terminal record is
 * returned unchanged.
 *
 * Order of resolution for a dead run:
 * 1. a live process means the run continues under a new watcher (unchanged);
 * 2. a terminal log line (re-read from the log) decides the result;
 * 3. a `prepared` record whose staged file still exists stays prepared;
 * 4. a dead `prepare` record whose staged file appeared is prepared;
 * 5. the install version equal to the run's target is `success`;
 * 6. anything else is `failed` with an explicit reason. The log is never
 *    deleted (the UI tails it).
 *
 * @param record - the persisted record.
 * @param identity - the install identity read at reconcile time.
 * @param context - home/prefix paths and clock.
 * @returns the reconciled record and whether it changed.
 */
export function reconcileRunRecord(
  record: UpdateRunRecord,
  identity: InstallIdentity,
  context: ReconcileContext,
): { record: UpdateRunRecord; changed: boolean } {
  const now = context.now ?? (() => new Date())
  if (record.result !== null) return { record, changed: false }
  if (isRunActive(context.home, record)) return { record, changed: false }
  const staged = hasStagedApply(context.prefix)
  const parsed = readRunLog(record.logPath)
  if (parsed.result !== null) {
    const next = terminalRecord(parsed.lastLine === '' ? record : { ...record, lastLine: parsed.lastLine }, parsed.result, now, staged)
    return { record: next, changed: true }
  }
  if (isPreparedPhase(record.phase) && staged) {
    if (record.staged) return { record, changed: false }
    return { record: { ...record, staged: true }, changed: true }
  }
  if (record.mode === 'prepare' && staged) {
    return { record: { ...preparedRecord(record), lastLine: parsed.lastLine === '' ? record.lastLine : parsed.lastLine, logTail: parsed.logTail }, changed: true }
  }
  if (identity.version !== '' && identity.version === record.target) {
    return { record: { ...terminalRecord(record, 'success', now, staged), lastLine: parsed.lastLine === '' ? record.lastLine : parsed.lastLine, logTail: parsed.logTail }, changed: true }
  }
  const version = identity.version === '' ? 'unknown' : identity.version
  const action = modeLabel(record.mode)
  return {
    record: {
      ...record,
      phase: 'failed',
      result: 'failed',
      staged,
      finishedAt: now().toISOString(),
      lastLine: parsed.lastLine === '' ? record.lastLine : parsed.lastLine,
      logTail: parsed.logTail,
      reason: `the ${action} run is no longer running and the install version (${version}) does not match the target (${record.target})`,
    },
    changed: true,
  }
}

/** Whether two records persist identically (skip redundant writes). */
export function sameRunRecord(left: UpdateRunRecord, right: UpdateRunRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
