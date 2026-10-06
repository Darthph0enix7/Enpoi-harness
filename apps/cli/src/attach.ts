/**
 * Pre-boot attach for `dsh web` (fork).
 *
 * When a Harness Web instance already serves the requested endpoint, the
 * launcher prints that instance's authenticated URL, hands it to the browser,
 * and exits instead of booting a second server that would fail on the occupied
 * port. The serving instance records its URL under `$DSH_HOME/state/web-url.json`
 * at readiness; this module reads that record before any profile mounts.
 *
 * `--foreground` opts out and always serves, which is what supervised units
 * pass. A non-interactive invocation (no TTY) also serves unchanged, so tests
 * and pipelines keep today's behavior.
 * @module @deepseek-ai/dsh/attach
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { webStatePath } from '@deepseek-ai/dsh-web-app/state'

/** What one `dsh web` invocation decided to do. */
export type AttachOutcome = 'attached' | 'occupied' | 'serve'

/** The endpoint an invocation targets, or `serve` when attach never applies. */
export type AttachEndpoint =
  | { host: string
    port: number }
  | 'serve'

/** Probe timeout: loopback refusal arrives immediately, so this only bounds a hung listener. */
const PROBE_TIMEOUT_MS = 250

/** Hosts that mean "this machine" for endpoint matching. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Read a `--flag value` or `--flag=value` option from raw inner arguments.
 * @param args - raw arguments after the launcher's own flags.
 * @param flag - the option name including dashes.
 * @returns the value, or undefined when absent or followed by another option.
 */
export function optionValue(args: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined) continue
    if (token === flag) {
      const next = args[index + 1]
      return next !== undefined && !next.startsWith('-') ? next : undefined
    }
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}

/**
 * Whether a boolean option is present in any accepted spelling.
 * @param args - raw arguments after the launcher's own flags.
 * @param flag - the option name including dashes.
 * @returns true when the token appears verbatim.
 */
export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag)
}

/**
 * Resolve the endpoint this invocation targets, or refuse attach when the
 * invocation asks for something else: explicit help, forced foreground, or the
 * OS-assigned port `0` (nothing can be attached to a port that is not fixed).
 * @param args - raw arguments after the launcher's own flags.
 * @returns the endpoint, or `serve`.
 */
export function resolveAttachEndpoint(args: readonly string[]): AttachEndpoint {
  if (hasFlag(args, '--foreground')) return 'serve'
  if (hasFlag(args, '-h') || hasFlag(args, '--help')) return 'serve'
  const port = optionValue(args, '--port')
  // A bare `--port` (no value) is an app usage error; attach would misread it
  // as the default endpoint and silently open the wrong instance.
  if (hasFlag(args, '--port') && port === undefined) return 'serve'
  if (port !== undefined && !/^\d+$/u.test(port)) return 'serve'
  const host = optionValue(args, '--host')
  if (hasFlag(args, '--host') && host === undefined) return 'serve'
  const portNumber = port === undefined ? 3080 : Number(port)
  if (portNumber === 0) return 'serve'
  return { host: host ?? '127.0.0.1', port: portNumber }
}

/** One shape check for the state record read from disk. */
function parseState(raw: string): { url: string; host: string; port: number; pid: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const { url, host, port, pid } = record
    if (typeof url !== 'string' || typeof host !== 'string') return undefined
    if (typeof port !== 'number' || typeof pid !== 'number') return undefined
    return { url, host, port, pid }
  } catch {
    return undefined
  }
}

/**
 * Whether a process with this id exists. `EPERM` still proves existence.
 * @param pid - the recorded process id.
 * @returns true when the process is alive.
 */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * One HTTP GET to the recorded endpoint; any HTTP response proves a listener.
 * @param host - the recorded host.
 * @param port - the recorded port.
 * @returns a promise resolving true when the endpoint answers.
 */
function defaultProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const call = request({ host, port, path: '/', method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (response) => {
      response.resume()
      resolve(true)
    })
    call.once('timeout', () => { call.destroy(); resolve(false) })
    call.once('error', () => { resolve(false) })
    call.end()
  })
}

/**
 * The platform's default browser handoff, detached so the launcher can exit.
 * @param url - the URL to open.
 * @param warn - sink for a failed launch; the URL is already printed.
 * @returns nothing; the opener runs independently.
 */
function defaultOpenBrowser(url: string, warn: (message: string) => void): void {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', (error: Error) => { warn(`could not open the default browser because ${error.message}; use the printed URL`) })
    child.unref()
  } catch (error) {
    warn(`could not open the default browser because ${(error as Error).message}; use the printed URL`)
  }
}

/** Injected seams for {@link runAttach}; production uses the defaults. */
export interface AttachOptions {
  /** Interactive-terminal gate; defaults to the real stdout. */
  tty?: boolean
  /** Environment consulted for the SSH suppression; defaults to the real one. */
  env?: NodeJS.ProcessEnv
  /** URL line sink. */
  stdout?: { write: (chunk: string) => unknown }
  /** Diagnostics sink. */
  stderr?: { write: (chunk: string) => unknown }
  /** Attach state file override (tests). */
  statePath?: string
  /** Liveness check override (tests). */
  pidAlive?: (pid: number) => boolean
  /** Endpoint probe override (tests). */
  probe?: (host: string, port: number) => Promise<boolean>
  /** Browser handoff override (tests). */
  openBrowser?: (url: string) => void
}

/**
 * Decide and, on a live instance, print + open + report `attached`.
 * @param args - raw arguments after the launcher's own flags.
 * @param options - injected seams; every field defaults to production behavior.
 * @returns the outcome the launcher acts on (`serve` continues to profile boot).
 */
export async function runAttach(args: readonly string[], options: AttachOptions = {}): Promise<AttachOutcome> {
  const tty = options.tty ?? process.stdout.isTTY === true
  if (!tty) return 'serve'
  const endpoint = resolveAttachEndpoint(args)
  if (endpoint === 'serve') return 'serve'
  const env = options.env ?? process.env
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const pidAlive = options.pidAlive ?? defaultPidAlive
  const probe = options.probe ?? defaultProbe
  const openBrowser = options.openBrowser
    ?? ((url: string) => { defaultOpenBrowser(url, (message) => { stderr.write(`dsh web: ${message}\n`) }) })
  const statePath = options.statePath ?? webStatePath()

  let state: { url: string; host: string; port: number; pid: number } | undefined
  try {
    state = parseState(readFileSync(statePath, 'utf8'))
  } catch {
    state = undefined
  }

  const hostMatches = state !== undefined
    && (state.host === endpoint.host
      || (LOOPBACK_HOSTS.has(state.host) && LOOPBACK_HOSTS.has(endpoint.host)))
  if (state !== undefined && hostMatches && state.port === endpoint.port
    && pidAlive(state.pid) && await probe(state.host, state.port)) {
    stdout.write(`dsh web: ${state.url}\n`)
    const viaSsh = Boolean(env.SSH_CONNECTION ?? env.SSH_CLIENT ?? env.SSH_TTY)
    if (!hasFlag(args, '--no-open') && !viaSsh) {
      stdout.write('dsh web: opening the default browser; pass --no-open to disable\n')
      openBrowser(state.url)
    }
    return 'attached'
  }

  if (await probe(endpoint.host, endpoint.port)) {
    stderr.write(
      `dsh web: ${endpoint.host}:${String(endpoint.port)} already answers but has no attach state`
      + ' (another program, or a Harness started before this feature); stop it or pass --port\n',
    )
    return 'occupied'
  }
  return 'serve'
}
