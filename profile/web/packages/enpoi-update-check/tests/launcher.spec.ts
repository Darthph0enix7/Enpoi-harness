/**
 * Launcher ladder: platform ordering, wrapper argv, PATH probing, spawn
 * fallback across rungs, and the detached spawn options.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  commandOnPath,
  launchPlan,
  launchUpdater,
  LAUNCH_WRAPPER,
  RUN_HOME_ENV,
  wrapperArgs,
  type LaunchChild,
  type LaunchPlanInput,
} from '../src/launcher.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function input(overrides: Partial<LaunchPlanInput> = {}): LaunchPlanInput {
  return {
    home: '/home/dsh',
    shim: '/home/dsh/.local/bin/dsh',
    channel: 'stable',
    runId: 'run42',
    logPath: '/home/dsh/update-check/run.log',
    pidFile: '/home/dsh/update-check/run.pid',
    ...overrides,
  }
}

describe('launchPlan', () => {
  it('orders linux as systemd-run → setsid → spawn when every command exists', () => {
    const plan = launchPlan(input({ platform: 'linux', hasCommand: () => true }))
    expect(plan.map(step => step.rung)).toEqual(['systemd-run', 'setsid', 'spawn'])
    expect(plan[0]!.unit).toBe('dsh-update-run42')
    expect(plan[0]!.args.slice(0, 4)).toEqual([
      '--user', '--collect', '--quiet', '--wait',
    ])
    expect(plan[0]!.args).toContain('--unit=dsh-update-run42')
    expect(plan[0]!.args).toContain(`--setenv=${RUN_HOME_ENV}=/home/dsh`)
    expect(plan[0]!.args).toContain('--')
  })

  it('skips absent commands and always ends with the bare spawn fallback', () => {
    expect(launchPlan(input({ platform: 'linux', hasCommand: () => false })).map(step => step.rung))
      .toEqual(['spawn'])
    expect(launchPlan(input({ platform: 'linux', hasCommand: command => command === 'setsid' })).map(step => step.rung))
      .toEqual(['setsid', 'spawn'])
    expect(launchPlan(input({ platform: 'freebsd', hasCommand: () => true })).map(step => step.rung))
      .toEqual(['setsid', 'spawn'])
  })

  it('orders darwin as launchctl → setsid → spawn', () => {
    const plan = launchPlan(input({ platform: 'darwin', hasCommand: () => true }))
    expect(plan.map(step => step.rung)).toEqual(['launchctl', 'setsid', 'spawn'])
    const launchctl = plan[0]!
    expect(launchctl.unit).toBe('com.dsh.update.run42')
    expect(launchctl.args.slice(0, 8)).toEqual([
      'submit', '-l', 'com.dsh.update.run42', '-o', '/home/dsh/update-check/run.log',
      '-e', '/home/dsh/update-check/run.log', '--',
    ])
  })

  it('runs the wrapper that writes the pid file and redirects into the log', () => {
    expect(wrapperArgs(input())).toEqual([
      '-c', LAUNCH_WRAPPER, 'dsh-update',
      '/home/dsh/update-check/run.log', '/home/dsh/update-check/run.pid',
      '/home/dsh/.local/bin/dsh', 'update', '--channel', 'stable',
    ])
    const plan = launchPlan(input({ platform: 'linux', hasCommand: () => false }))
    expect(plan[0]!.command).toBe('sh')
    expect(plan[0]!.args).toEqual(wrapperArgs(input()))
  })
})

describe('commandOnPath', () => {
  it('finds only executable files on the given PATH', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'bin'))
    const unique = `dsh-launcher-spec-${String(process.pid)}`
    writeFileSync(join(dir, 'bin', `${unique}-yes`), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(dir, 'bin', `${unique}-no`), '#!/bin/sh\n', { mode: 0o644 })
    const path = join(dir, 'bin')
    expect(commandOnPath(`${unique}-yes`, path)).toBe(true)
    expect(commandOnPath(`${unique}-no`, path)).toBe(false)
    expect(commandOnPath(`${unique}-yes`, undefined)).toBe(false)
    expect(commandOnPath(`${unique}-yes`, '')).toBe(false)
    expect(commandOnPath(`${unique}-yes`, `${path}:`)).toBe(true)
  })
})

describe('launchUpdater', () => {
  function child(pid: number): LaunchChild & { unref: ReturnType<typeof vi.fn> } {
    return { pid, unref: vi.fn() }
  }

  it('spawns the first rung detached with unref and the pinned home env', () => {
    const spawn = vi.fn(() => child(1234))
    const outcome = launchUpdater({
      ...input({ platform: 'linux', hasCommand: () => true }),
      spawn,
    })
    expect(outcome).toEqual({ rung: 'systemd-run', unit: 'dsh-update-run42', pid: 1234 })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe('systemd-run')
    expect(args).toContain('--unit=dsh-update-run42')
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' })
    expect((options as { env: Record<string, string> }).env[RUN_HOME_ENV]).toBe('/home/dsh')
  })

  it('falls through to the next rung when a spawn throws synchronously', () => {
    const spawn = vi.fn()
      .mockImplementationOnce(() => { throw new Error('spawn systemd-run ENOENT') })
      .mockImplementationOnce(() => child(777))
    const outcome = launchUpdater({
      ...input({ platform: 'linux', hasCommand: () => true }),
      spawn,
    })
    expect(outcome.rung).toBe('setsid')
    expect(outcome.pid).toBe(777)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]![0]).toBe('setsid')
    expect(spawn.mock.calls[1]![1]).toEqual(['sh', ...wrapperArgs(input())])
  })

  it('reports a null pid when the platform does not name one', () => {
    const outcome = launchUpdater({
      ...input({ platform: 'linux', hasCommand: () => false }),
      spawn: () => ({ unref: vi.fn() }),
    })
    expect(outcome).toEqual({ rung: 'spawn', pid: null })
  })

  it('throws when no rung can spawn', () => {
    expect(() => launchUpdater({
      ...input({ platform: 'linux', hasCommand: () => false }),
      spawn: () => { throw new Error('spawn sh ENOENT') },
    })).toThrow(/ENOENT/)
  })

  it('falls back to the running platform when none is given', () => {
    const plan = launchPlan(input({ hasCommand: () => false }))
    expect(plan.at(-1)!.rung).toBe('spawn')
  })
})
