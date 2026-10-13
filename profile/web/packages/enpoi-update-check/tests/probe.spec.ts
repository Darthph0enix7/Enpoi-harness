/**
 * The installed-engine capability probe: help output with/without `--prepare`,
 * the timeout bound, spawn failures, and the empty-output default.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { probeEngineCapability, type ProbeChild } from '../src/probe.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

/** Stage an executable shim printing `body` for `update --help`. */
function stageShim(body: string): string {
  const dir = scratch()
  const shim = join(dir, 'dsh')
  writeFileSync(shim, `#!/bin/sh\n${body}\n`)
  chmodSync(shim, 0o755)
  return shim
}

describe('probeEngineCapability', () => {
  it('reports supported when the help lists --prepare', async () => {
    const shim = stageShim('echo "usage: dsh update [--channel stable|beta] [--prepare] [--apply]"')
    const result = await probeEngineCapability({ shim, env: process.env })
    expect(result).toEqual({ capability: 'supported' })
  })

  it('reports supported when the flag arrives on stderr only', async () => {
    const shim = stageShim('echo "usage: dsh update [--prepare]" >&2')
    const result = await probeEngineCapability({ shim, env: process.env })
    expect(result).toEqual({ capability: 'supported' })
  })

  it('reports unsupported when the help lacks the flag', async () => {
    const shim = stageShim('echo "usage: dsh update [--channel stable|beta] [--force]"')
    const result = await probeEngineCapability({ shim, env: process.env })
    expect(result.capability).toBe('unsupported')
    expect(result.reason).toContain('does not list --prepare')
  })

  it('reports unsupported on empty output with a non-zero exit', async () => {
    const shim = stageShim('exit 3')
    const result = await probeEngineCapability({ shim, env: process.env })
    expect(result.capability).toBe('unsupported')
    expect(result.reason).toContain('no output')
    expect(result.reason).toContain('exit 3')
  })

  it('reports unsupported when the probe times out, and kills the child', async () => {
    const shim = stageShim('sleep 30')
    const started = Date.now()
    const result = await probeEngineCapability({ shim, env: process.env, timeoutMs: 200 })
    expect(result.capability).toBe('unsupported')
    expect(result.reason).toContain('timed out after 200ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('reports unsupported when the child cannot start', async () => {
    const spawn = vi.fn((): ProbeChild => ({
      stdout: null,
      stderr: null,
      on: (event: string, listener: (value: never) => void) => {
        if (event === 'error') queueMicrotask(() => { (listener as (error: Error) => void)(new Error('ENOENT')) })
        return undefined
      },
    }))
    const result = await probeEngineCapability({ shim: '/missing/dsh', env: {}, spawn })
    expect(result.capability).toBe('unsupported')
    expect(result.reason).toContain('probe failed to start: ENOENT')
  })

  it('probes the shim with exactly `update --help`', async () => {
    const spawn = vi.fn((): ProbeChild => ({
      stdout: null,
      stderr: null,
      on: (event: string, listener: (value: never) => void) => {
        if (event === 'close') queueMicrotask(() => { (listener as (code: number | null) => void)(0) })
        return undefined
      },
    }))
    const result = await probeEngineCapability({ shim: '/bin/dsh', env: { PATH: '/usr/bin' }, spawn })
    expect(result.capability).toBe('unsupported')
    expect(spawn).toHaveBeenCalledWith('/bin/dsh', ['update', '--help'], { env: { PATH: '/usr/bin' } })
  })
})
