/**
 * Fork: a restart path that cannot kill the turn that requested it.
 *
 * `systemctl --user restart dsh-web.service` from inside a model turn kills the
 * process hosting that turn: the tool call never returns, the turn aborts, and
 * the caller is stuck. This module owns the two safe forms:
 *
 * - `--after-turn` writes a marker at `$DSH_HOME/state/restart-after-turn.json`
 *   naming the session, profile, and unit. The web service watches the marker:
 *   it fires only when the named session is idle (its turn ended), consumes the
 *   marker first, and then restarts the unit detached — the restart happens
 *   between turns, never inside one. A stale marker (past its deadline) is
 *   dropped; a marker left by a crash fires once on the next boot.
 * - `--now` restarts immediately but detached from the caller (a `systemd-run
 *   --user --collect` transient unit on Linux, `launchctl kickstart` on macOS,
 *   `Restart-Service` on Windows), so the caller returns promptly and survives.
 *
 * Agents must use these instead of a direct service restart from a turn.
 * @module @deepseek-ai/dsh/restart-after-turn
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Marker schema version; a different version is treated as malformed. */
export const RESTART_MARKER_VERSION = 1

/** The unit `dsh restart` targets unless `--unit` overrides it. */
export const DEFAULT_RESTART_UNIT = 'dsh-web.service'

/** The profile whose watcher acts on a marker unless `--profile` overrides it. */
export const DEFAULT_RESTART_PROFILE = 'web'

/** A scheduled restart older than this is stale and never fires (default 15 minutes). */
export const DEFAULT_MAX_WAIT_MS = 15 * 60_000

/** The idle-sweep cadence; `turn/end` is the primary trigger, this is the safety net. */
export const WATCH_INTERVAL_MS = 2_000

/** Marker location relative to `$DSH_HOME`. */
export const RESTART_MARKER_RELATIVE = join('state', 'restart-after-turn.json')

/** The durable request for a restart after one named session goes idle. */
export interface RestartMarker {
  /** {@link RESTART_MARKER_VERSION}. */
  version: number
  /** Session whose live turn must end before the restart fires. */
  sessionId: string
  /** systemd user unit (or launchd label / Windows service name) to restart. */
  unit: string
  /** Profile whose web service owns the watcher (marker/profile must match). */
  profile: string
  /** Unix epoch ms when the request was written. */
  requestedAt: number
  /** Unix epoch ms after which the request is stale and dropped instead of fired. */
  deadline: number
  /** Free-form requester identity for diagnostics (pid, cwd). */
  requestedBy: string
  /** Fire only when every live session is idle, not just {@link sessionId}. */
  waitAll: boolean
}

/** Absolute marker path for one harness home. */
export function restartMarkerPath(home: string = resolveDshHome()): string {
  return join(home, RESTART_MARKER_RELATIVE)
}

/** Parse one marker value tolerantly; anything malformed is `undefined`. */
export function parseRestartMarker(raw: string): RestartMarker | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.version !== RESTART_MARKER_VERSION) return undefined
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined
  if (typeof candidate.unit !== 'string' || candidate.unit === '') return undefined
  if (typeof candidate.profile !== 'string' || candidate.profile === '') return undefined
  if (typeof candidate.requestedAt !== 'number' || !Number.isFinite(candidate.requestedAt)) return undefined
  if (typeof candidate.deadline !== 'number' || !Number.isFinite(candidate.deadline)) return undefined
  if (typeof candidate.requestedBy !== 'string') return undefined
  return {
    version: RESTART_MARKER_VERSION,
    sessionId: candidate.sessionId,
    unit: candidate.unit,
    profile: candidate.profile,
    requestedAt: candidate.requestedAt,
    deadline: candidate.deadline,
    requestedBy: candidate.requestedBy,
    waitAll: candidate.waitAll === true,
  }
}

/** Write a marker atomically (temp file + rename); the directory is created on demand. */
export function writeRestartMarker(marker: RestartMarker, home: string = resolveDshHome()): string {
  const path = restartMarkerPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, JSON.stringify(marker, undefined, 2) + '\n')
  renameSync(temporary, path)
  return path
}

/** Read the marker without consuming it; malformed or absent markers read as `undefined`. */
export function readRestartMarker(home: string = resolveDshHome()): RestartMarker | undefined {
  let raw: string
  try {
    raw = readFileSync(restartMarkerPath(home), 'utf8')
  } catch {
    return undefined
  }
  return parseRestartMarker(raw)
}

/**
 * Atomically consume the marker: the process that wins the `unlink` is the one
 * that may fire it. Exactly one concurrent watcher observes the request.
 */
export function consumeRestartMarker(home: string = resolveDshHome()): RestartMarker | undefined {
  const path = restartMarkerPath(home)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    unlinkSync(path)
  } catch {
    return undefined
  }
  return parseRestartMarker(raw)
}

/** Delete a pending marker; `false` when none was pending. */
export function clearRestartMarker(home: string = resolveDshHome()): boolean {
  try {
    unlinkSync(restartMarkerPath(home))
    return true
  } catch {
    return false
  }
}

/** The detached command that restarts one unit outside the caller's process tree. */
export interface DetachedRestartPlan {
  /** Stable planner name used in diagnostics and tests. */
  via: 'systemd-run' | 'systemctl' | 'launchctl' | 'powershell'
  /** Executable to spawn detached. */
  command: string
  /** Arguments, verbatim. */
  args: string[]
}

/**
 * Plan the platform detach. Linux prefers a transient user unit (`systemd-run
 * --user --collect`), which lives outside the target unit's cgroup and outlives
 * the caller; the plain `systemctl` fallback survives too because the restart
 * job is already queued with systemd and systemd completes the transaction even
 * when the requesting cgroup is stopped under it.
 */
export function detachedRestartPlan(
  unit: string,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? 0,
): DetachedRestartPlan {
  switch (platform) {
    case 'linux':
      return {
        via: 'systemd-run',
        command: 'systemd-run',
        args: ['--user', '--collect', '--quiet', '--', 'systemctl', '--user', 'restart', unit],
      }
    case 'darwin':
      return { via: 'launchctl', command: 'launchctl', args: ['kickstart', '-k', `gui/${String(uid)}/${unit}`] }
    case 'win32':
      return {
        via: 'powershell',
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', `Restart-Service -Name '${unit.replaceAll("'", "''")}' -Force`],
      }
    default:
      throw new Error(`dsh restart: no detached restart mechanism for platform ${JSON.stringify(platform)}`)
  }
}

/** Injection seam for the detached spawn (tests record instead of restarting). */
export interface DetachedFireOptions {
  /** Platform override for tests. */
  platform?: NodeJS.Platform
  /** User id override for the macOS `gui/<uid>` domain. */
  uid?: number
  /** Spawn implementation override. */
  spawnImpl?: typeof spawn
  /** Called when even the fallback could not be spawned; never throws. */
  onError?: (error: Error) => void
}

/**
 * Spawn the detached restart and return without waiting: the caller (a tool
 * call inside a turn) observes a normal, prompt exit.
 * @returns the plan actually spawned.
 */
export function fireDetachedRestart(unit: string, options: DetachedFireOptions = {}): DetachedRestartPlan {
  const plan = detachedRestartPlan(unit, options.platform, options.uid)
  const spawnImpl = options.spawnImpl ?? spawn
  const report = (error: Error): void => {
    try {
      options.onError?.(error)
    } catch { /* an error reporter must not take the caller down */ }
  }
  try {
    const child = spawnImpl(plan.command, plan.args, { detached: true, stdio: 'ignore' })
    child.once('error', (error: Error) => {
      if (plan.via !== 'systemd-run') {
        report(error)
        return
      }
      // systemd-run absent (container, non-systemd distro): fall back to a
      // detached systemctl; the job is queued with systemd before any cgroup
      // stop can reach this process.
      try {
        const fallback = spawnImpl('systemctl', ['--user', 'restart', unit], { detached: true, stdio: 'ignore' })
        fallback.once('error', report)
        fallback.unref()
      } catch (spawnError) {
        report(spawnError instanceof Error ? spawnError : new Error(String(spawnError)))
      }
    })
    child.unref()
  } catch (error) {
    report(error instanceof Error ? error : new Error(String(error)))
  }
  return plan
}

/** One parsed `dsh restart` invocation. */
export interface RestartRequest {
  /** Which safe form to run; `help` only prints usage. */
  action: 'after-turn' | 'now' | 'cancel' | 'help'
  /** Session to wait for; required for `after-turn`. */
  sessionId?: string
  /** Unit to restart. */
  unit: string
  /** Profile whose watcher owns the marker. */
  profile: string
  /** Staleness window in ms. */
  maxWaitMs: number
  /** Fire only when every live session is idle. */
  waitAll: boolean
  /** Emit one JSON object instead of prose. */
  json: boolean
}

/** The `dsh restart` help text. */
export const RESTART_USAGE = `Usage: dsh restart [--after-turn | --now | --cancel] [options]

Safe service restart: it never kills the turn that requested it.

  --after-turn      schedule the restart for when the session's current turn ends;
                    the web service performs it between turns (never mid-call)
  --now             restart immediately, detached from this process (systemd-run,
                    launchctl kickstart, or Restart-Service); returns promptly
  --cancel          cancel a scheduled after-turn restart
  --session <id>    session to wait for (default: $DSH_SESSION_ID)
  --unit <name>     unit to restart (default: $DSH_RESTART_UNIT or ${DEFAULT_RESTART_UNIT})
  --profile <name>  profile whose web service owns the marker (default: $DSH_PROFILE or ${DEFAULT_RESTART_PROFILE})
  --max-wait <sec>  drop a scheduled restart never fired within this window (default 900)
  --wait-all        fire only when every live session is idle, not just --session
  --json            machine-readable output
  -h, --help        print this help
`

/** Thrown for argv that commander would have rejected; the caller prints usage. */
export class RestartUsageError extends Error {}

/**
 * Parse `dsh restart` arguments without touching the filesystem or spawning.
 * @param args - argv after the `restart` token.
 * @param env - environment used for session/profile defaults.
 */
export function parseRestartArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): RestartRequest {
  let afterTurn = false
  let nowFlag = false
  let cancel = false
  let sessionId: string | undefined
  let unit = env.DSH_RESTART_UNIT ?? DEFAULT_RESTART_UNIT
  let profile = env.DSH_PROFILE ?? DEFAULT_RESTART_PROFILE
  let maxWaitMs = DEFAULT_MAX_WAIT_MS
  let waitAll = false
  let json = false
  const iterator = args.values()
  for (let argument = iterator.next(); !argument.done; argument = iterator.next()) {
    const value = argument.value
    switch (value) {
      case '--after-turn': afterTurn = true; break
      case '--now': nowFlag = true; break
      case '--cancel': cancel = true; break
      case '--wait-all': waitAll = true; break
      case '--json': json = true; break
      case '-h':
      case '--help': return { action: 'help', unit, profile, maxWaitMs, waitAll, json }
      case '--session':
      case '--unit':
      case '--profile':
      case '--max-wait': {
        const next = iterator.next()
        if (next.done || next.value === '') throw new RestartUsageError(`${value} needs a value`)
        if (value === '--session') sessionId = next.value
        else if (value === '--unit') unit = next.value
        else if (value === '--profile') profile = next.value
        else {
          const seconds = Number(next.value)
          if (!Number.isFinite(seconds) || seconds <= 0) throw new RestartUsageError('--max-wait needs a positive number of seconds')
          maxWaitMs = seconds * 1000
        }
        break
      }
      default:
        throw new RestartUsageError(`unexpected argument ${JSON.stringify(value)}`)
    }
  }
  const requested = [afterTurn, nowFlag, cancel].filter(Boolean).length
  if (requested > 1) throw new RestartUsageError('--after-turn, --now, and --cancel are mutually exclusive')
  if (sessionId !== undefined && !afterTurn) throw new RestartUsageError('--session applies only to --after-turn')
  if (afterTurn && sessionId === undefined) {
    const ambient = env.DSH_SESSION_ID
    if (ambient === undefined || ambient === '') {
      throw new RestartUsageError('--after-turn needs the session id: run from a session shell or pass --session <id>')
    }
    sessionId = ambient
  }
  if (cancel) return { action: 'cancel', unit, profile, maxWaitMs, waitAll, json }
  if (afterTurn) return { action: 'after-turn', sessionId: sessionId as string, unit, profile, maxWaitMs, waitAll, json }
  return { action: 'now', unit, profile, maxWaitMs, waitAll, json }
}

/** Output sink for the CLI, injectable for tests. */
export interface RestartCliIo {
  /** Writes a complete line to stdout. */
  stdout: (text: string) => void
  /** Writes a complete line to stderr. */
  stderr: (text: string) => void
}

/** Injection seam for the CLI effects; production uses the real filesystem and spawner. */
export interface RestartCliDeps {
  /** Harness home override. */
  home?: string
  /** Environment override for session/profile defaults. */
  env?: Record<string, string | undefined>
  /** Clock override. */
  now?: () => number
  /** Detached-fire override (tests record the unit without restarting). */
  fire?: (unit: string) => DetachedRestartPlan
}

/**
 * Execute one `dsh restart` invocation. Returns the process exit code.
 * @param args - argv after the `restart` token.
 * @param io - output sink.
 * @param deps - optional overrides for home, clock, and the detached spawner.
 */
export function runRestart(
  args: readonly string[],
  io: RestartCliIo = { stdout: text => process.stdout.write(text + '\n'), stderr: text => process.stderr.write(text + '\n') },
  deps: RestartCliDeps = {},
): number {
  let request: RestartRequest
  try {
    request = parseRestartArgs(args, deps.env ?? process.env)
  } catch (error) {
    io.stderr(`dsh restart: ${error instanceof Error ? error.message : String(error)}`)
    io.stderr(RESTART_USAGE.trimEnd())
    return 1
  }
  if (request.action === 'help') {
    io.stdout(RESTART_USAGE.trimEnd())
    return 0
  }
  const home = deps.home ?? resolveDshHome()
  if (request.action === 'cancel') {
    const pending = readRestartMarker(home)
    const cleared = clearRestartMarker(home)
    const unit = pending?.unit ?? request.unit
    if (request.json) io.stdout(JSON.stringify({ cancelled: cleared, unit }))
    else if (cleared) io.stdout(`restart-after-turn: cancelled the scheduled restart of ${unit}`)
    else io.stdout('restart-after-turn: no scheduled restart to cancel')
    return 0
  }
  if (request.action === 'now') {
    const fire = deps.fire ?? ((unit: string): DetachedRestartPlan => fireDetachedRestart(unit, {
      onError: (error) => { io.stderr(`restart-after-turn: ${error.message}`) },
    }))
    const plan = fire(request.unit)
    if (request.json) io.stdout(JSON.stringify({ restarted: true, unit: request.unit, via: plan.via }))
    else io.stdout(`restart-after-turn: restarting ${request.unit} now via ${plan.via} (detached)`)
    return 0
  }
  const requestedAt = (deps.now ?? Date.now)()
  const marker: RestartMarker = {
    version: RESTART_MARKER_VERSION,
    sessionId: request.sessionId as string,
    unit: request.unit,
    profile: request.profile,
    requestedAt,
    deadline: requestedAt + request.maxWaitMs,
    requestedBy: `pid ${String(process.pid)}`,
    waitAll: request.waitAll,
  }
  writeRestartMarker(marker, home)
  if (request.json) {
    io.stdout(JSON.stringify({
      scheduled: true,
      unit: marker.unit,
      sessionId: marker.sessionId,
      deadline: new Date(marker.deadline).toISOString(),
    }))
  } else {
    const deadline = new Date(marker.deadline).toISOString()
    io.stdout(
      `restart-after-turn: ${marker.unit} will restart after session ${marker.sessionId} goes idle `
      + `(deadline ${deadline}); cancel with: dsh restart --cancel`,
    )
  }
  return 0
}

/** Why one watcher sweep decided what it decided. */
export type RestartWatchCheck = 'none' | 'waiting' | 'fired' | 'stale' | 'other-profile'

/** Injection seam for the watcher (tests substitute time, idleness, and firing). */
export interface RestartWatcherOptions {
  /** Harness home. */
  home?: string
  /** Profile whose markers this watcher owns. */
  profile: string
  /** Whether the named session (and, with `waitAll`, every live session) is idle. */
  isIdle: (marker: RestartMarker) => boolean
  /** Fire the detached restart for a consumed marker. */
  fire: (marker: RestartMarker) => void
  /** Called with one prose line per decision (default: silent). */
  log?: (message: string) => void
  /** Clock override. */
  now?: () => number
  /** Marker readers, injectable for tests. */
  read?: (home: string) => RestartMarker | undefined
  /** Marker consumer, injectable for tests. */
  consume?: (home: string) => RestartMarker | undefined
}

/**
 * Marker lifecycle for one profile: peek, drop stale, wait for idle, consume
 * atomically, then fire. The consume happens before the fire, so a process that
 * dies in the restart never leaves a marker that would restart it again.
 */
export class RestartAfterTurnWatcher {
  private readonly home: string
  private readonly now: () => number
  private readonly read: (home: string) => RestartMarker | undefined
  private readonly consume: (home: string) => RestartMarker | undefined
  private readonly log: (message: string) => void

  constructor(private readonly options: RestartWatcherOptions) {
    this.home = options.home ?? resolveDshHome()
    this.now = options.now ?? Date.now
    this.read = options.read ?? readRestartMarker
    this.consume = options.consume ?? consumeRestartMarker
    this.log = options.log ?? (() => {})
  }

  /** Run one sweep. */
  check(): RestartWatchCheck {
    const marker = this.read(this.home)
    if (marker === undefined) return 'none'
    if (marker.profile !== this.options.profile) return 'other-profile'
    if (this.now() > marker.deadline) {
      this.consume(this.home)
      this.log(`restart-after-turn: dropped stale restart of ${marker.unit} (deadline passed)`)
      return 'stale'
    }
    if (!this.options.isIdle(marker)) return 'waiting'
    const consumed = this.consume(this.home)
    if (consumed === undefined) return 'none'
    this.log(`restart-after-turn: ${consumed.unit} restarting after session ${consumed.sessionId} went idle`)
    try {
      this.options.fire(consumed)
    } catch (error) {
      this.log(`restart-after-turn: could not restart ${consumed.unit}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return 'fired'
  }
}

/** The subset of the live-agent registry the watcher reads. */
interface LiveAgentLookup {
  get: (id: SessionId) => { readonly status: 'idle' | 'running' } | undefined
  list: () => readonly { readonly status: 'idle' | 'running' }[]
}

/** Injection seam for the service-side installation. */
export interface InstallRestartWatcherOptions {
  /** Profile that boots this tree; markers must match it. */
  profile: string
  /** Harness home override. */
  home?: string
  /** Sweep interval override (tests). */
  intervalMs?: number
  /** Log sink; the default uses `console`. */
  log?: (message: string) => void
  /** Detached-fire override (tests). */
  fire?: (marker: RestartMarker) => void
}

/**
 * Install the turn/end hook and idle sweep on a booted tree. Returns the stop
 * function; the same cleanup is registered as a Cordis effect so tree disposal
 * tears the watcher down.
 */
export function installRestartAfterTurn(ctx: Context, options: InstallRestartWatcherOptions): () => void {
  const log = options.log ?? ((message: string) => { console.log(message) })
  const watcher = new RestartAfterTurnWatcher({
    ...(options.home === undefined ? {} : { home: options.home }),
    profile: options.profile,
    isIdle: (marker): boolean => {
      const agents = ctx.get('agents') as unknown as LiveAgentLookup | undefined
      if (agents === undefined) return true
      if (agents.get(marker.sessionId as SessionId)?.status === 'running') return false
      if (!marker.waitAll) return true
      return !agents.list().some(agent => agent.status === 'running')
    },
    fire: options.fire ?? ((marker): void => {
      fireDetachedRestart(marker.unit, { onError: (error) => { log(`restart-after-turn: ${error.message}`) } })
    }),
    log,
  })
  const check = (): void => {
    try {
      watcher.check()
    } catch (error) {
      log(`restart-after-turn: sweep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const offTurnEnd = ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (event.type === 'turn/end') check()
  })
  const timer = setInterval(check, options.intervalMs ?? WATCH_INTERVAL_MS)
  timer.unref()
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    offTurnEnd()
  }
  ctx.effect(() => stop, 'restart-after-turn')
  // Boot sweep: a marker that survived a crash fires once now that nothing runs.
  check()
  return stop
}
