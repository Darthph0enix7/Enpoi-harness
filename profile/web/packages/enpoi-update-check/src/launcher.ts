/**
 * enpoi-update-check — the detached-launch ladder for the updater
 * (docs/plan/ui-update-manifest.md P4).
 *
 * The updater is the installed `dsh` shim (`<binDir>/dsh update --channel
 * <channel>`), launched so it survives the web service's own restart at the
 * switch step. Every rung runs the same POSIX wrapper, which records the
 * updater's own pid and redirects stdout+stderr into the run log:
 *
 * ```
 * sh -c 'log="$1"; pid="$2"; shift 2; echo $$ > "$pid"; exec "$@" >>"$log" 2>&1' \
 *    dsh-update <logPath> <pidPath> <shim> update --channel <channel>
 * ```
 *
 * The rungs, in order of preference (the first whose command exists on PATH
 * wins; the last rung has no command requirement and always works):
 *
 * | platform | rung 1         | rung 2  | rung 3 |
 * |----------|----------------|---------|--------|
 * | linux    | `systemd-run`  | `setsid`| `spawn` |
 * | darwin   | `launchctl`    | `setsid`| `spawn` |
 * | other    | `setsid`       | `spawn` | —      |
 *
 * `systemd-run --user --wait` keeps the launcher client alive for the whole
 * unit lifetime, so its pid is a usable liveness anchor until the wrapper's
 * pid file appears; `launchctl submit` is the transient job the installer's
 * own service-guard uses on macOS. The final `spawn` rung starts `sh`
 * detached (a new session on POSIX) and is the everywhere-fallback.
 *
 * @module dsh-enpoi-update-check/launcher
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

/** Launch rungs, in ladder order per platform. */
export type LaunchRung = 'systemd-run' | 'launchctl' | 'setsid' | 'spawn'

/** One candidate launch: a command plus its argv. */
export interface LaunchPlanStep {
  /** Ladder rung that produced this candidate. */
  readonly rung: LaunchRung
  /** Executable to spawn. */
  readonly command: string
  /** Full argv (the wrapper and the updater invocation). */
  readonly args: readonly string[]
  /** systemd unit / launchd label, when the rung schedules one. */
  readonly unit?: string
}

/** Inputs that decide the ladder and its argv. */
export interface LaunchPlanInput {
  /** Harness home the updater must resolve (`DSH_HOME`). */
  readonly home: string
  /** Absolute path of the installed `dsh` shim. */
  readonly shim: string
  /** Channel pinned for this run (`stable` or `beta`). */
  readonly channel: string
  /** Run id: the unit/label suffix and the update-check directory key. */
  readonly runId: string
  /** Absolute run log path written by the wrapper. */
  readonly logPath: string
  /** Absolute pid file path written by the wrapper. */
  readonly pidFile: string
  /** Platform selector (defaults to the running platform). */
  readonly platform?: NodeJS.Platform
  /** PATH probe for optional rungs (defaults to the process PATH). */
  readonly hasCommand?: (command: string) => boolean
  /** Runtime uid used for the systemd-run `XDG_RUNTIME_DIR` fallback. */
  readonly uid?: number
}

/** The wrapper script, passed as a single `-c` argument. */
export const LAUNCH_WRAPPER =
  'log="$1"; pid="$2"; shift 2; echo $$ > "$pid"; exec "$@" >>"$log" 2>&1'

/** Environment variable the run pins so the updater resolves the same home. */
export const RUN_HOME_ENV = 'DSH_HOME'

/** Whether `command` resolves on `pathSpec`. */
export function commandOnPath(command: string, pathSpec: string | undefined = process.env.PATH): boolean {
  if (pathSpec === undefined || pathSpec === '') return false
  for (const dir of pathSpec.split(delimiter)) {
    if (dir === '') continue
    if (directoryHasExecutable(join(dir, command))) return true
  }
  return false
}

function directoryHasExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The wrapper argv that runs the updater: `sh -c <wrapper> dsh-update <log> <pid> <shim> update --channel <channel>`. */
export function wrapperArgs(input: Pick<LaunchPlanInput, 'shim' | 'channel' | 'logPath' | 'pidFile'>): string[] {
  return [
    '-c',
    LAUNCH_WRAPPER,
    'dsh-update',
    input.logPath,
    input.pidFile,
    input.shim,
    'update',
    '--channel',
    input.channel,
  ]
}

/**
 * Build the ordered launch ladder for one platform.
 *
 * @param input - shim, channel, run id, log/pid paths, and test seams.
 * @returns the candidates in preference order; the last one always spawns.
 */
export function launchPlan(input: LaunchPlanInput): LaunchPlanStep[] {
  const platform = input.platform ?? process.platform
  const has = input.hasCommand ?? ((command: string) => commandOnPath(command))
  const args = wrapperArgs(input)
  const steps: LaunchPlanStep[] = []
  if (platform === 'linux' && has('systemd-run')) {
    const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(input.uid ?? process.getuid?.() ?? 0)}`
    steps.push({
      rung: 'systemd-run',
      command: 'systemd-run',
      unit: `dsh-update-${input.runId}`,
      args: [
        '--user',
        '--collect',
        '--quiet',
        '--wait',
        `--unit=dsh-update-${input.runId}`,
        `--setenv=XDG_RUNTIME_DIR=${runtimeDir}`,
        `--setenv=${RUN_HOME_ENV}=${input.home}`,
        '--',
        'sh',
        ...args,
      ],
    })
  }
  if (platform === 'darwin' && has('launchctl')) {
    steps.push({
      rung: 'launchctl',
      command: 'launchctl',
      unit: `com.dsh.update.${input.runId}`,
      args: [
        'submit',
        '-l', `com.dsh.update.${input.runId}`,
        '-o', input.logPath,
        '-e', input.logPath,
        '--',
        'sh',
        ...args,
      ],
    })
  }
  if (has('setsid')) {
    steps.push({ rung: 'setsid', command: 'setsid', args: ['sh', ...args] })
  }
  steps.push({ rung: 'spawn', command: 'sh', args })
  return steps
}

/** Minimal child-process face the launcher needs (real and stubbed). */
export interface LaunchChild {
  readonly pid?: number | undefined
  unref?(): void
}

/** Spawn seam (tests inject a stub). */
export type LaunchSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => LaunchChild

/** Inputs for {@link launchUpdater}: the ladder plus the spawn seam. */
export interface LaunchUpdaterInput extends LaunchPlanInput {
  /** Spawn implementation (defaults to node:child_process). */
  readonly spawn?: LaunchSpawn
}

/** Which rung launched, and the launcher client's pid. */
export interface LaunchOutcome {
  /** Rung that was spawned. */
  readonly rung: LaunchRung
  /** systemd unit / launchd label when the rung scheduled one. */
  readonly unit?: string
  /** Launcher client pid, or null when the platform reported none. */
  readonly pid: number | null
}

/**
 * Launch the updater through the first ladder rung whose command is spawnable.
 * A synchronous spawn failure (a `spawn` stub throwing) falls through to the
 * next rung; an asynchronous `error` event is the run's failure to report, not
 * a fallback trigger (the wrapper's log carries the reason).
 *
 * @param input - ladder inputs plus the spawn seam.
 * @returns the rung that started and its pid.
 * @throws Error when even the final rung cannot spawn.
 */
export function launchUpdater(input: LaunchUpdaterInput): LaunchOutcome {
  const spawn = input.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options))
  const plan = launchPlan(input)
  let lastError: unknown
  for (const step of plan) {
    try {
      const child = spawn(step.command, step.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, [RUN_HOME_ENV]: input.home },
      })
      // Detach so the web service's own restart cannot take the launcher with
      // it; the wrapper's own redirection owns stdout/stderr.
      child.unref?.()
      return {
        rung: step.rung,
        ...(step.unit === undefined ? {} : { unit: step.unit }),
        pid: typeof child.pid === 'number' ? child.pid : null,
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no launch rung could start the updater')
}

/** Default `dsh` shim location when the install state records no binDir. */
export function defaultShimPath(): string {
  return join(homedir(), '.local', 'bin', 'dsh')
}
