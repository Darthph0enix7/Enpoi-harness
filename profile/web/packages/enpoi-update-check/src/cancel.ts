/**
 * enpoi-update-check — the engine-owned cancel (`dsh update --cancel --json`).
 *
 * Cancelling runs through the installed shim so every safety rule stays in the
 * engine: it reads the run marker, refuses past the switch, SIGTERMs then
 * SIGKILLs the runner, sweeps the dead run's partials, and leaves the marker
 * at `cancelled`. The plugin only relays the engine's outcome.
 *
 * With `--json` the engine prints exactly one JSON line on stdout
 * (`{ok, action: "cancel", status, runId, pid, phase, prefix}`) and routes its
 * human messages to stderr; the exit code is 0 for a successful cancel or a
 * no-op, 1 for a refusal.
 *
 * @module dsh-enpoi-update-check/cancel
 */

import { spawn } from 'node:child_process'

/** Outcome of one cancel attempt. */
export type EngineCancelStatus = 'cancelled' | 'refused' | 'noop' | 'failed'

/** One parsed cancel result. */
export interface EngineCancelOutcome {
  /** `cancelled` (runner stopped) / `refused` (past the switch) / `noop` (nothing live) / `failed` (transport or unparsable). */
  readonly status: EngineCancelStatus
  /** Human message: the engine's own words, or the local failure reason. */
  readonly message: string
  /** Marker run id the engine reported, when present. */
  readonly runId: string
  /** Marker pid the engine reported, or null. */
  readonly pid: number | null
  /** Marker phase the engine reported, when present. */
  readonly phase: string
}

/** Default cancel bound; the engine's own SIGTERM wait is 10 s by default. */
export const CANCEL_TIMEOUT_MS = 30_000

/** How much combined stdout+stderr the cancel reader retains. */
export const CANCEL_OUTPUT_CAP = 64 * 1024

/** Minimal child-process face the cancel needs (real and stubbed). */
export interface CancelChild {
  readonly stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  readonly stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill?(): unknown
}

/** Spawn seam (tests inject a stub). */
export type CancelSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
) => CancelChild

/** Cancel inputs. */
export interface CancelEngineInput {
  /** Absolute shim path (`<binDir>/dsh`). */
  readonly shim: string
  /** Environment the cancel runs with (composed PATH + DSH_HOME/PREFIX). */
  readonly env: NodeJS.ProcessEnv
  /** Bound override (tests). */
  readonly timeoutMs?: number
  /** Spawn seam (tests). */
  readonly spawn?: CancelSpawn
}

/** Parse the engine's JSON line, or null when absent. */
export function parseCancelJson(stdout: string): {
  status: EngineCancelStatus
  runId: string
  pid: number | null
  phase: string
} | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const raw = parsed as Record<string, unknown>
    if (raw.action !== 'cancel') continue
    const status = raw.status === 'cancelled' || raw.status === 'refused' || raw.status === 'noop'
      ? raw.status
      : 'failed'
    const pidRaw = typeof raw.pid === 'string' ? Number.parseInt(raw.pid, 10) : raw.pid
    return {
      status,
      runId: typeof raw.runId === 'string' ? raw.runId : '',
      pid: typeof pidRaw === 'number' && Number.isFinite(pidRaw) && pidRaw > 0 ? Math.trunc(pidRaw) : null,
      phase: typeof raw.phase === 'string' ? raw.phase : '',
    }
  }
  return null
}

/**
 * Run the engine's cancel through the installed shim.
 *
 * @param input - shim path, environment, bound, and spawn seam.
 * @returns the parsed outcome; never rejects.
 */
export function cancelEngineRun(input: CancelEngineInput): Promise<EngineCancelOutcome> {
  const timeoutMs = input.timeoutMs ?? CANCEL_TIMEOUT_MS
  const spawnImpl: CancelSpawn = input.spawn ?? ((command, args, options) => spawn(command, [...args], {
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (outcome: EngineCancelOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(outcome)
    }
    const lastLine = (text: string): string => {
      const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
      return lines.at(-1) ?? ''
    }
    try {
      const child = spawnImpl(input.shim, ['update', '--cancel', '--json'], { env: input.env })
      child.stdout?.on('data', (chunk: unknown) => {
        if (stdout.length < CANCEL_OUTPUT_CAP) stdout += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      })
      child.stderr?.on('data', (chunk: unknown) => {
        if (stderr.length < CANCEL_OUTPUT_CAP) stderr += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      })
      child.on('error', (error) => {
        finish({ status: 'failed', message: `cancel failed to start: ${error.message}`, runId: '', pid: null, phase: '' })
      })
      child.on('close', (code) => {
        const parsed = parseCancelJson(stdout)
        if (parsed === null) {
          const message = lastLine(stderr) || lastLine(stdout) || `cancel exited ${String(code)} without a result`
          finish({ status: 'failed', message, runId: '', pid: null, phase: '' })
          return
        }
        const message = lastLine(stderr) || lastLine(stdout)
        finish({ ...parsed, message })
      })
      timer = setTimeout(() => {
        try { child.kill?.() } catch { /* best-effort; the result is decided */ }
        finish({ status: 'failed', message: `cancel timed out after ${String(timeoutMs)}ms`, runId: '', pid: null, phase: '' })
      }, timeoutMs)
      timer.unref?.()
    } catch (error) {
      finish({
        status: 'failed',
        message: `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        runId: '',
        pid: null,
        phase: '',
      })
    }
  })
}
