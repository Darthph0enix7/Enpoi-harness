/**
 * enpoi-update-check — the installed-engine capability probe.
 *
 * The two-phase runner (`dsh update --prepare` / `--apply`) ships with a new
 * engine, so the first in-app update on a device still running an older
 * install would hit an unknown-flag error. The controller therefore probes the
 * installed shim once per plugin boot (`dsh update --help`, bounded) and
 * falls back to the pre-two-phase one-shot invocation when the flag is absent.
 *
 * The probe defaults to UNSUPPORTED on every failure mode — a spawn error, a
 * timeout, or empty output — because guessing wrong in the supported direction
 * breaks the very first update on an old device.
 *
 * @module dsh-enpoi-update-check/probe
 */

import { spawn } from 'node:child_process'

/** What the installed engine supports. */
export type EngineCapability = 'supported' | 'unsupported'

/** One probe outcome. */
export interface EngineProbeResult {
  /** `supported` only when the help output names `--prepare`. */
  readonly capability: EngineCapability
  /** Why the probe decided unsupported (absent on success). */
  readonly reason?: string
}

/** Default probe bound; the shim's help path does no network work. */
export const ENGINE_PROBE_TIMEOUT_MS = 10_000

/** How much combined stdout+stderr the probe retains. */
export const ENGINE_PROBE_OUTPUT_CAP = 64 * 1024

/** Minimal child-process face the probe needs (real and stubbed). */
export interface ProbeChild {
  readonly stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  readonly stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill?(): unknown
}

/** Spawn seam (tests inject a stub). */
export type ProbeSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv },
) => ProbeChild

/** Probe inputs. */
export interface EngineProbeInput {
  /** Absolute shim path (`<binDir>/dsh`). */
  readonly shim: string
  /** Environment the probe runs with (composed PATH where possible). */
  readonly env: NodeJS.ProcessEnv
  /** Bound override (tests). */
  readonly timeoutMs?: number
  /** Spawn seam (tests). */
  readonly spawn?: ProbeSpawn
}

/**
 * Run the capability probe: `<shim> update --help` and look for `--prepare`.
 *
 * @param input - shim path, environment, bound, and spawn seam.
 * @returns the capability; never rejects.
 */
export function probeEngineCapability(input: EngineProbeInput): Promise<EngineProbeResult> {
  const timeoutMs = input.timeoutMs ?? ENGINE_PROBE_TIMEOUT_MS
  const spawnImpl: ProbeSpawn = input.spawn ?? ((command, args, options) => spawn(command, [...args], {
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: EngineProbeResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    try {
      const child = spawnImpl(input.shim, ['update', '--help'], { env: input.env })
      const collect = (chunk: unknown): void => {
        if (output.length >= ENGINE_PROBE_OUTPUT_CAP) return
        output += typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      child.on('error', (error) => {
        finish({ capability: 'unsupported', reason: `probe failed to start: ${error.message}` })
      })
      child.on('close', (code) => {
        if (output.includes('--prepare')) {
          finish({ capability: 'supported' })
          return
        }
        finish({
          capability: 'unsupported',
          reason: output.trim() === ''
            ? `probe produced no output (exit ${String(code)})`
            : `engine help does not list --prepare (exit ${String(code)})`,
        })
      })
      timer = setTimeout(() => {
        try { child.kill?.() } catch { /* the kill is best-effort; the result is already decided */ }
        finish({ capability: 'unsupported', reason: `probe timed out after ${String(timeoutMs)}ms` })
      }, timeoutMs)
      timer.unref?.()
    } catch (error) {
      finish({ capability: 'unsupported', reason: `probe failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  })
}
