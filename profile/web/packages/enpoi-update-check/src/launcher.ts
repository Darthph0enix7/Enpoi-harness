/**
 * enpoi-update-check — the detached-launch ladder for the updater
 * (docs/plan/ui-update-manifest.md P4, engine two-phase flags).
 *
 * The updater is the installed `dsh` shim (`<binDir>/dsh update --channel
 * <channel> --prepare`, then `dsh update --apply`), launched so it survives
 * the web service's own restart at the switch step. The web service's
 * environment is not the login environment (the live failure: the engine
 * reported "no usable Node.js found for the update"), so the launcher probes
 * for a Node.js runtime itself and the wrapper exports a composed environment:
 *
 * ```
 * log="$1"; pid="$2"; shift 2; export PATH='…'; export DSH_HOME='…';
 * export PREFIX='…'; echo $$ > "$pid"; exec "$@" >>"$log" 2>&1
 * ```
 *
 * The runtime probe, in order ({@link resolveRuntime}):
 * 1. the install's recorded runtime: `$PREFIX/runtime/node/current/bin`;
 * 2. the nvm layout: `$HOME/.local/share/nvm/<version>/bin` (newest version),
 *    then `$HOME/.nvm/versions/node/<version>/bin` (newest);
 * 3. the inherited `PATH` (any usable `node`);
 * 4. common system directories (`/usr/local/bin`, `/usr/bin`, `/bin`, and
 *    `/opt/homebrew/bin` on macOS).
 *
 * Nothing resolving throws {@link LaunchEnvironmentError}, which the run
 * controller persists as `run.json`'s failure `reason` instead of letting the
 * engine print a cryptic line.
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
 * own service-guard uses on macOS. A submitted job carries KeepAlive on
 * current macOS, so it is relaunched every few seconds until it is removed:
 * the controller removes the job once the run rests ({@link removeLaunchdJob})
 * and sweeps leftovers at boot/pre-launch ({@link listLaunchdJobs}). The final
 * `spawn` rung starts `sh` detached (a new session on POSIX) and is the
 * everywhere-fallback.
 *
 * @module dsh-enpoi-update-check/launcher
 */

import { execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

/** Launch rungs, in ladder order per platform. */
export type LaunchRung = 'systemd-run' | 'launchctl' | 'setsid' | 'spawn'

/** Every launchd label this plugin submits starts with this prefix. */
export const UPDATE_JOB_LABEL_PREFIX = 'com.dsh.update.'

/**
 * The launchd label for one run. A submitted job carries KeepAlive, so the
 * controller must remove the job once the run rests; the label is derived
 * from the run id on both sides (submit and removal), never reconstructed
 * from launchctl output.
 *
 * @param runId - the run id recorded in `run.json`.
 * @returns the submitted job's label.
 */
export function updateJobLabel(runId: string): string {
  return `${UPDATE_JOB_LABEL_PREFIX}${runId}`
}

/** Where a resolved Node.js runtime came from. */
export type RuntimeSource = 'prefix-runtime' | 'nvm' | 'path' | 'system'

/** One resolved Node.js runtime. */
export interface RuntimeProbe {
  /** Directory to prepend to PATH; empty when the inherited PATH already works. */
  readonly binDir: string
  /** Which ladder step resolved it. */
  readonly source: RuntimeSource
}

/** Inputs that decide the environment and the ladder. */
export interface LaunchPlanInput {
  /** Harness home the updater must resolve (`DSH_HOME`). */
  readonly home: string
  /** Install prefix (the state's recorded `prefix`). */
  readonly prefix: string
  /** Absolute path of the installed `dsh` shim. */
  readonly shim: string
  /** Engine invocation this run drives. */
  readonly flag: '--prepare' | '--apply' | 'one-shot'
  /** Channel for a prepare run; absent for apply. */
  readonly channel?: string
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
  /** Environment the launch composes from (defaults to `process.env`). */
  readonly baseEnv?: NodeJS.ProcessEnv
  /** User home probed for the nvm layout (defaults to `os.homedir()`). */
  readonly probeHomeDir?: string
}

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

/** The composed launch environment. */
export interface LaunchEnvironment {
  /** Absolute `node` path the probe found, or null when the inherited PATH works. */
  readonly nodePath: string | null
  /** Which ladder step resolved the runtime. */
  readonly source: RuntimeSource
  /** PATH value the wrapper exports and the launcher passes. */
  readonly path: string
  /** Environment handed to the spawned launcher (and to launchd/systemd). */
  readonly env: NodeJS.ProcessEnv
  /** Every location the probe consulted, in order (for the failure message). */
  readonly probed: readonly string[]
}

/** Environment variable the run pins so the updater resolves the same home. */
export const RUN_HOME_ENV = 'DSH_HOME'

/** Environment hook the engine reads to label a no-flag run in its marker (`one-shot`). */
export const UPDATE_MODE_ENV = 'DSH_UPDATE_MODE'

/** A launch whose environment carries no usable Node.js runtime. */
export class LaunchEnvironmentError extends Error {
  /** Every location the probe consulted, in order. */
  readonly probed: readonly string[]

  /**
   * @param probed - every location the probe consulted, in order.
   */
  constructor(probed: readonly string[]) {
    super(
      `no Node.js runtime found for the updater (probed: ${probed.join(', ')}). `
      + 'Install Node 22.19+ or record the install prefix so $PREFIX/runtime/node/current resolves.',
    )
    this.name = 'LaunchEnvironmentError'
    this.probed = probed
  }
}

/** Standard directories appended to every composed PATH. */
export function systemBinDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
    : ['/usr/local/bin', '/usr/bin', '/bin']
}

/** Whether `file` exists and is executable. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Whether `command` resolves on `pathSpec`. */
export function commandOnPath(command: string, pathSpec: string | undefined): boolean {
  if (pathSpec === undefined || pathSpec === '') return false
  for (const dir of pathSpec.split(delimiter)) {
    if (dir === '') continue
    if (isExecutable(join(dir, command))) return true
  }
  return false
}

/** Newest version directory (nvm naming, e.g. `v22.22.2`) under `parent`, or undefined. */
function newestVersionDir(parent: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(parent).filter(name => /^v?\d/.test(name))
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined
  const weight = (name: string): number[] => name.replace(/^v/, '').split(/[^0-9]+/).filter(part => part !== '').map(Number)
  names.sort((left, right) => {
    const a = weight(left)
    const b = weight(right)
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0)
      if (diff !== 0) return diff
    }
    return left.localeCompare(right)
  })
  return names.at(-1)
}

/**
 * Resolve a Node.js runtime for the updater from explicit locations, walking
 * the documented ladder. The inherited `PATH` counts as a hit only when it
 * actually resolves `node`.
 *
 * @param input - prefix/home/platform and the base environment.
 * @returns the resolved runtime, or null when nothing was found.
 */
export function resolveRuntime(input: {
  readonly prefix: string
  readonly homeDir: string
  readonly baseEnv?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): { probe: RuntimeProbe | null; probed: string[] } {
  const platform = input.platform ?? process.platform
  const baseEnv = input.baseEnv ?? process.env
  const probed: string[] = []

  const prefixRuntime = join(input.prefix, 'runtime', 'node', 'current', 'bin')
  probed.push(prefixRuntime)
  if (isExecutable(join(prefixRuntime, 'node'))) {
    return { probe: { binDir: prefixRuntime, source: 'prefix-runtime' }, probed }
  }

  for (const root of [
    join(input.homeDir, '.local', 'share', 'nvm'),
    join(input.homeDir, '.nvm', 'versions', 'node'),
  ]) {
    const newest = newestVersionDir(root)
    if (newest === undefined) {
      probed.push(`${root}/*/bin`)
      continue
    }
    const binDir = join(root, newest, 'bin')
    probed.push(binDir)
    if (isExecutable(join(binDir, 'node'))) {
      return { probe: { binDir, source: 'nvm' }, probed }
    }
  }

  if (commandOnPath('node', baseEnv.PATH)) {
    return { probe: { binDir: '', source: 'path' }, probed }
  }
  probed.push('PATH')

  for (const dir of systemBinDirs(platform)) {
    probed.push(dir)
    if (isExecutable(join(dir, 'node'))) {
      return { probe: { binDir: dir, source: 'system' }, probed }
    }
  }
  return { probe: null, probed }
}

/**
 * Compose the runtime PATH for one launch (or the capability probe): the
 * probe's directory first, then the inherited PATH, then the standard system
 * directories (deduplicated).
 *
 * @param input - prefix/home/platform and the base environment.
 * @returns the composed path with its probe and every location consulted; the
 *   path is null when no runtime resolves.
 */
export function resolveRuntimePath(input: {
  readonly prefix: string
  readonly homeDir: string
  readonly baseEnv?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
}): { readonly path: string | null; readonly probe: RuntimeProbe | null; readonly probed: readonly string[] } {
  const baseEnv = input.baseEnv ?? process.env
  const { probe, probed } = resolveRuntime(input)
  if (probe === null) return { path: null, probe: null, probed }
  const segments = [probe.binDir, baseEnv.PATH ?? '', ...systemBinDirs(input.platform)]
    .flatMap(value => value.split(delimiter))
    .filter(segment => segment !== '')
  return { path: [...new Set(segments)].join(delimiter), probe, probed }
}

/**
 * Compose the runtime environment for one launch.
 * Throws when nothing resolved a Node.js runtime.
 *
 * @param input - prefix/home/platform, base environment, and the shim/flag.
 * @returns the composed environment and the probe that produced it.
 * @throws LaunchEnvironmentError when no runtime resolves.
 */
export function resolveLaunchEnvironment(input: LaunchPlanInput): LaunchEnvironment {
  const baseEnv = input.baseEnv ?? process.env
  const resolved = resolveRuntimePath({
    prefix: input.prefix,
    homeDir: input.probeHomeDir ?? homedir(),
    ...(input.baseEnv === undefined ? {} : { baseEnv: input.baseEnv }),
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  })
  if (resolved.path === null || resolved.probe === null) throw new LaunchEnvironmentError(resolved.probed)
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: resolved.path,
    [RUN_HOME_ENV]: input.home,
    ...(input.prefix === '' ? {} : { PREFIX: input.prefix }),
    // The engine labels its run marker from this hook; a one-shot rung has no
    // phase flag, so without it the marker would read `plain`.
    ...(input.flag === 'one-shot' ? { [UPDATE_MODE_ENV]: 'one-shot' } : {}),
  }
  return {
    nodePath: resolved.probe.binDir === '' ? null : join(resolved.probe.binDir, 'node'),
    source: resolved.probe.source,
    path: resolved.path,
    env,
    probed: resolved.probed,
  }
}

/** POSIX single-quote one value for embedding in the wrapper script. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Build the wrapper script: export the composed environment, record the
 * updater's own pid, then exec the shim with its argv redirected into the log.
 *
 * @param environment - the composed launch environment.
 * @returns the `sh -c` script text.
 */
export function launchWrapper(environment: LaunchEnvironment): string {
  const parts = [
    'log="$1"',
    'pid="$2"',
    'shift 2',
    `export PATH=${shellQuote(environment.path)}`,
    `export ${RUN_HOME_ENV}=${shellQuote(environment.env[RUN_HOME_ENV] ?? '')}`,
  ]
  const prefix = environment.env.PREFIX
  if (prefix !== undefined && prefix !== '') parts.push(`export PREFIX=${shellQuote(prefix)}`)
  parts.push('echo $$ > "$pid"', 'exec "$@" >>"$log" 2>&1')
  return parts.join('; ')
}

/** The wrapper argv that runs the updater: `sh -c <wrapper> dsh-update <log> <pid> <shim> update <flag…>`. */
export function wrapperArgs(input: LaunchPlanInput, environment: LaunchEnvironment): string[] {
  const engineArgs = input.flag === '--apply'
    ? ['--apply']
    : ['--channel', input.channel ?? 'stable', ...(input.flag === '--prepare' ? ['--prepare'] : [])]
  return [
    '-c',
    launchWrapper(environment),
    'dsh-update',
    input.logPath,
    input.pidFile,
    input.shim,
    'update',
    ...engineArgs,
  ]
}

/**
 * Build the ordered launch ladder for one platform.
 *
 * @param input - shim, flag, run id, log/pid paths, and test seams.
 * @param environment - the composed launch environment (from {@link resolveLaunchEnvironment}).
 * @returns the candidates in preference order; the last one always spawns.
 */
export function launchPlan(input: LaunchPlanInput, environment: LaunchEnvironment): LaunchPlanStep[] {
  const platform = input.platform ?? process.platform
  const has = input.hasCommand ?? ((command: string) => commandOnPath(command, process.env.PATH))
  const args = wrapperArgs(input, environment)
  const envArgs = [
    `--setenv=PATH=${environment.path}`,
    `--setenv=${RUN_HOME_ENV}=${input.home}`,
    ...(input.prefix === '' ? [] : [`--setenv=PREFIX=${input.prefix}`]),
    ...(input.flag === 'one-shot' ? [`--setenv=${UPDATE_MODE_ENV}=one-shot`] : []),
  ]
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
        ...envArgs,
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
      unit: updateJobLabel(input.runId),
      args: [
        'submit',
        '-l', updateJobLabel(input.runId),
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
 * @throws LaunchEnvironmentError when no Node.js runtime resolves.
 * @throws Error when even the final rung cannot spawn.
 */
export function launchUpdater(input: LaunchUpdaterInput): LaunchOutcome {
  const environment = resolveLaunchEnvironment(input)
  const spawn = input.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options))
  const plan = launchPlan(input, environment)
  let lastError: unknown
  for (const step of plan) {
    try {
      const child = spawn(step.command, step.args, {
        detached: true,
        stdio: 'ignore',
        env: environment.env,
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

/**
 * Remove one submitted launchd job (`launchctl remove <label>`). A job
 * started with `launchctl submit` carries KeepAlive on current macOS, so a
 * finished run's job is relaunched every few seconds until it is removed;
 * the controller calls this only once the engine has exited, because the
 * removal also terminates the job's processes.
 *
 * Darwin-only and fail-soft: the label is passed as a single argv element
 * (never shell-interpolated), and a missing launchctl or a spawn failure
 * returns false instead of throwing.
 *
 * @param label - the submitted job's label (see {@link updateJobLabel}).
 * @param options - platform selector and spawn seam (tests).
 * @returns true when the removal was spawned; false when not darwin or the
 *   removal could not be spawned.
 */
export function removeLaunchdJob(
  label: string,
  options: { readonly platform?: string; readonly spawn?: LaunchSpawn } = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'darwin') return false
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions))
  try {
    const child = spawn('launchctl', ['remove', label], { detached: true, stdio: 'ignore' })
    child.unref?.()
    return true
  } catch {
    return false
  }
}

/** One synchronous command's captured result (the listing probe). */
export interface LaunchCommandResult {
  /** Exit status, or null when the command never ran. */
  readonly status: number | null
  /** Captured stdout. */
  readonly stdout: string
}

/** Synchronous command seam (tests inject a stub). */
export type LaunchCommandRun = (command: string, args: readonly string[]) => LaunchCommandResult

/** Default synchronous runner: `execFileSync` with stdout captured, fail-soft. */
function defaultCommandRun(command: string, args: readonly string[]): LaunchCommandResult {
  try {
    const stdout = execFileSync(command, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { status: 0, stdout: typeof stdout === 'string' ? stdout : '' }
  } catch (error) {
    const failure = error as { status?: unknown; stdout?: unknown }
    const stdout = typeof failure.stdout === 'string'
      ? failure.stdout
      : failure.stdout instanceof Uint8Array ? Buffer.from(failure.stdout).toString('utf8') : ''
    return { status: typeof failure.status === 'number' ? failure.status : null, stdout }
  }
}

/**
 * Every submitted launchd label (`launchctl list`'s third column), or null
 * when the platform is not darwin or the query fails. The caller filters for
 * leftovers it owns ({@link UPDATE_JOB_LABEL_PREFIX}); the sweep is
 * fail-soft because a missing launchctl only leaves stale jobs behind.
 *
 * @param options - platform selector and command seam (tests).
 * @returns the labels, or null when the listing is unavailable.
 */
export function listLaunchdJobs(
  options: { readonly platform?: string; readonly run?: LaunchCommandRun } = {},
): string[] | null {
  if ((options.platform ?? process.platform) !== 'darwin') return null
  const run = options.run ?? defaultCommandRun
  try {
    const result = run('launchctl', ['list'])
    if (result.status !== 0) return null
    return result.stdout.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('PID'))
      // PID and status first, the label last; labels never contain whitespace.
      .map(line => line.split(/\s+/).at(-1) ?? '')
      .filter(label => label !== '')
  } catch {
    return null
  }
}

/** Default `dsh` shim location when the install state records no binDir. */
export function defaultShimPath(): string {
  return join(homedir(), '.local', 'bin', 'dsh')
}
