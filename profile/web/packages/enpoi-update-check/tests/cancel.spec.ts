/**
 * The engine-owned cancel: JSON parsing, the exact `update --cancel --json`
 * invocation, outcome relay, the refusal path, and the timeout bound.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cancelEngineRun, parseCancelJson, type CancelChild } from '../src/cancel.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cancel-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

/**
 * Stage a fake shim whose `update --cancel --json` prints `stdout` (JSON) and
 * `stderr` (human) with `code`.
 */
function stageCancelShim(stdout: string, stderr: string, code: number): string {
  const dir = scratch()
  const shim = join(dir, 'dsh')
  writeFileSync(shim, [
    '#!/bin/sh',
    '[ "${2:-}" = "--cancel" ] || { echo "argv mismatch: $*" >&2; exit 2; }',
    `printf '%s\\n' '${stdout.replaceAll("'", "'\\''")}'`,
    `printf '%s\\n' '${stderr.replaceAll("'", "'\\''")}' >&2`,
    `exit ${String(code)}`,
  ].join('\n'))
  chmodSync(shim, 0o755)
  return shim
}

const CANCELLED_JSON = '{"ok": 0, "action": "cancel", "status": "cancelled", "runId": "175-9", "pid": "99", "phase": "cancelled", "prefix": "/p"}'

describe('parseCancelJson', () => {
  it('parses each engine status', () => {
    expect(parseCancelJson(CANCELLED_JSON)).toEqual({ status: 'cancelled', runId: '175-9', pid: 99, phase: 'cancelled' })
    expect(parseCancelJson('{"ok": 0, "action": "cancel", "status": "refused", "runId": "175-9", "pid": "99", "phase": "applying"}'))
      .toMatchObject({ status: 'refused', phase: 'applying' })
    expect(parseCancelJson('{"ok": 1, "action": "cancel", "status": "noop", "runId": "", "pid": "", "phase": ""}'))
      .toMatchObject({ status: 'noop', pid: null })
  })

  it('ignores non-JSON lines, other actions, and unparsable documents', () => {
    expect(parseCancelJson('plain output only')).toBeNull()
    expect(parseCancelJson('{"action": "update", "status": "cancelled"}')).toBeNull()
    expect(parseCancelJson('{not json}')).toBeNull()
  })
})

describe('cancelEngineRun', () => {
  it('relays a successful cancel with the engine message', async () => {
    const shim = stageCancelShim(CANCELLED_JSON, 'dsh update --cancel: stopping run 175-9 (PID 99)…', 0)
    const outcome = await cancelEngineRun({ shim, env: process.env })
    expect(outcome).toMatchObject({ status: 'cancelled', runId: '175-9', pid: 99 })
    expect(outcome.message).toContain('stopping run 175-9')
  })

  it('relays the refusal with the engine’s explanatory message', async () => {
    const refused = '{"ok": 0, "action": "cancel", "status": "refused", "runId": "175-9", "pid": "99", "phase": "applying", "prefix": "/p"}'
    const shim = stageCancelShim(refused, 'refusing — the update is past the switch (phase applying)', 1)
    const outcome = await cancelEngineRun({ shim, env: process.env })
    expect(outcome.status).toBe('refused')
    expect(outcome.message).toContain('past the switch')
  })

  it('fails with the last human line when no JSON arrives', async () => {
    const shim = stageCancelShim('', 'unknown flag: --cancel', 2)
    const outcome = await cancelEngineRun({ shim, env: process.env })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('unknown flag')
  })

  it('is bounded by the timeout and kills the child', async () => {
    const dir = scratch()
    const shim = join(dir, 'dsh')
    writeFileSync(shim, '#!/bin/sh\nsleep 30\n')
    chmodSync(shim, 0o755)
    const started = Date.now()
    const outcome = await cancelEngineRun({ shim, env: process.env, timeoutMs: 200 })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('timed out after 200ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('invokes exactly `update --cancel --json`', async () => {
    const spawn = vi.fn((): CancelChild => ({
      stdout: null,
      stderr: null,
      on: (event: string, listener: (value: never) => void) => {
        if (event === 'close') queueMicrotask(() => { (listener as (code: number | null) => void)(0) })
        return undefined
      },
    }))
    const outcome = await cancelEngineRun({ shim: '/bin/dsh', env: { PATH: '/usr/bin' }, spawn })
    expect(spawn).toHaveBeenCalledWith('/bin/dsh', ['update', '--cancel', '--json'], { env: { PATH: '/usr/bin' } })
    expect(outcome.status).toBe('failed')
  })

  it('reports a spawn failure', async () => {
    const spawn = vi.fn((): CancelChild => ({
      stdout: null,
      stderr: null,
      on: (event: string, listener: (value: never) => void) => {
        if (event === 'error') queueMicrotask(() => { (listener as (error: Error) => void)(new Error('ENOENT')) })
        return undefined
      },
    }))
    const outcome = await cancelEngineRun({ shim: '/missing/dsh', env: {}, spawn })
    expect(outcome.status).toBe('failed')
    expect(outcome.message).toContain('ENOENT')
  })
})
