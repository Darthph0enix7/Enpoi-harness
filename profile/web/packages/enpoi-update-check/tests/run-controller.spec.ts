/**
 * UpdateRunController: start gating, launch, watcher progress, terminal
 * results, exit-without-result failure, and the boot reconcile.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstallIdentity } from '../src/catalog.js'
import type { LaunchOutcome, LaunchUpdaterInput } from '../src/launcher.js'
import { readRunRecord, runLogPath, runPidPath, runRecordPath } from '../src/run.js'
import {
  RunRefusedError,
  UpdateRunController,
  type RunTimers,
  type UpdateRunControllerOptions,
} from '../src/run-service.js'
import type { UpdateCheckStatus } from '../src/service.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-controller-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

/** Timer seam whose ticks the test drives explicitly. */
function manualTimers(): { timers: RunTimers; tick: () => void; active: () => number } {
  const handlers = new Set<() => void>()
  return {
    timers: {
      setInterval: (handler: () => void) => { handlers.add(handler); return handler as unknown as ReturnType<typeof setInterval> },
      clearInterval: (handle: ReturnType<typeof setInterval>) => { handlers.delete(handle as unknown as () => void) },
    },
    tick: () => { for (const handler of [...handlers]) handler() },
    active: () => handlers.size,
  }
}

function available(version = '0.1.7-enpoi.2.84'): UpdateCheckStatus {
  return {
    state: 'available',
    current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
    latest: { version, commit: 'def5678', releasedAt: '2026-10-13T12:00:00.000Z', notes: ['feat(x): y'] },
    checkedAt: '2026-10-13T12:00:00.000Z',
  }
}

interface Bench extends UpdateRunControllerOptions {
  controller: UpdateRunController
  ticks: ReturnType<typeof manualTimers>
  launches: LaunchUpdaterInput[]
  shim: string
}

function bench(options: {
  home?: string
  status?: UpdateCheckStatus
  identity?: InstallIdentity
  launch?: (input: LaunchUpdaterInput) => LaunchOutcome
  isAlive?: (pid: number) => boolean
  now?: () => Date
} = {}): Bench {
  const home = options.home ?? scratch()
  const ticks = manualTimers()
  const launches: LaunchUpdaterInput[] = []
  const shim = join(home, 'bin', 'dsh')
  const launch = options.launch ?? ((input: LaunchUpdaterInput) => {
    launches.push(input)
    return { rung: 'setsid', pid: 4242 }
  })
  const controller = new UpdateRunController({
    home,
    readIdentity: () => options.identity ?? { channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' },
    readStatus: () => options.status ?? available(),
    launch,
    resolveShim: () => shim,
    runId: () => 'run42',
    pollIntervalMs: 1_000,
    timers: ticks.timers,
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { controller, ticks, launches, shim, home }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => { child.on('exit', () => { resolve() }) })
  return pid
}

function writeLog(home: string, text: string): void {
  mkdirSync(join(home, 'update-check'), { recursive: true })
  writeFileSync(runLogPath(home), text)
}

describe('UpdateRunController.start', () => {
  it('refuses when no update is available, with a typed reason', () => {
    for (const status of [
      { state: 'current', current: { version: '0.1.7-enpoi.2.84', commit: 'a', channel: 'stable' } } as UpdateCheckStatus,
      { state: 'unknown', current: { version: '', commit: '', channel: 'stable' } } as UpdateCheckStatus,
      { state: 'available', current: { version: 'x', commit: 'a', channel: 'stable' } } as UpdateCheckStatus,
    ]) {
      const b = bench({ status })
      expect(() => b.controller.start()).toThrowError(
        expect.objectContaining({ name: 'RunRefusedError', reason: 'not-available' }) as Error,
      )
    }
  })

  it('refuses when a run is already active', () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'old', target: '0.1.7-enpoi.2.84', channel: 'stable', phase: 'deps', step: 4, steps: 9,
      lastLine: '[4/9] dependencies and build', startedAt: new Date().toISOString(), pid: process.pid,
      logPath: runLogPath(home), result: null, rung: 'setsid', logTail: [],
    })}\n`)
    writeFileSync(runPidPath(home), String(process.pid))
    const b = bench({ home })
    expect(() => b.controller.start()).toThrowError(
      expect.objectContaining({ name: 'RunRefusedError', reason: 'already-running' }),
    )
    b.controller.dispose()
    expect(b.ticks.active()).toBe(0)
  })

  it('refuses when the shim is missing', () => {
    const b = bench()
    const controller = new UpdateRunController({
      home: b.home,
      readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'a' }),
      readStatus: () => available(),
      resolveShim: () => null,
      launch: () => { throw new Error('unreachable') },
      timers: b.ticks.timers,
    })
    expect(() => controller.start()).toThrowError(
      expect.objectContaining({ name: 'RunRefusedError', reason: 'shim-missing' }),
    )
  })

  it('pins the target, truncates the log, launches, and persists the record', () => {
    const b = bench()
    writeLog(b.home, 'stale output from an older run\n')
    const record = b.controller.start()
    expect(record).toMatchObject({
      runId: 'run42',
      target: '0.1.7-enpoi.2.84',
      channel: 'stable',
      phase: 'starting',
      step: 0,
      steps: 9,
      result: null,
      rung: 'setsid',
      pid: 4242,
    })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({
      home: b.home,
      shim: b.shim,
      channel: 'stable',
      runId: 'run42',
    })
    expect(readRunRecord(runRecordPath(b.home))).toEqual(record)
    expect(readFileSync(runLogPath(b.home), 'utf8')).toBe('')
    b.controller.dispose()
  })

  it('records a launch failure and refuses with the launch reason', () => {
    const b = bench({ launch: () => { throw new Error('spawn setsid ENOENT') } })
    expect(() => b.controller.start()).toThrowError(
      expect.objectContaining({ name: 'RunRefusedError', reason: 'launch-failed' }),
    )
    expect(readRunRecord(runRecordPath(b.home))?.result).toBe('failed')
    expect(readRunRecord(runRecordPath(b.home))?.reason).toContain('ENOENT')
  })

  it('is exportable as a refusal error type', () => {
    expect(new RunRefusedError('not-available', 'nope')).toMatchObject({ name: 'RunRefusedError', reason: 'not-available' })
  })
})

describe('UpdateRunController watcher', () => {
  it('follows step markers, the pid file, and the terminal success line', () => {
    const b = bench({ isAlive: pid => pid === 4242 || pid === 7777 })
    b.controller.start()
    const started = b.controller.run()!
    expect(started.phase).toBe('starting')

    writeLog(b.home, '[1/9] environment: existing install\n  ✓ cli found\n[3/9] pnpm: corepack\n')
    b.ticks.tick()
    const midway = b.controller.run()!
    expect(midway).toMatchObject({ step: 3, steps: 9, phase: 'verify', pid: 4242 })
    expect(midway.lastLine).toBe('[3/9] pnpm: corepack')
    expect(midway.logTail).toEqual(['[1/9] environment: existing install', '  ✓ cli found', '[3/9] pnpm: corepack'])

    // The wrapper's own pid takes over from the launcher pid.
    writeFileSync(runPidPath(b.home), '7777\n')
    b.ticks.tick()
    expect(b.controller.run()!.pid).toBe(7777)

    writeLog(b.home, '[1/9] environment\n[8/9] switch, service and backfill\n✓ switch: current → 0.1.7-enpoi.2.84\n[9/9] self-check\n✓ self-check passed\nEnpoi Harness successfully updated!\n')
    b.ticks.tick()
    const done = b.controller.run()!
    expect(done).toMatchObject({ step: 9, phase: 'done', result: 'success' })
    expect(done.finishedAt).toBeDefined()
    expect(done.logTail.at(-1)).toBe('Enpoi Harness successfully updated!')
    b.controller.dispose()
  })

  it('records failed when the process exits before a result line', async () => {
    const b = bench({ isAlive: () => false })
    b.controller.start()
    writeLog(b.home, '[4/9] dependencies and build\nunpacking archive\n')
    writeFileSync(runPidPath(b.home), String(await deadPid()))
    b.ticks.tick()
    const failed = b.controller.run()!
    expect(failed).toMatchObject({ result: 'failed', phase: 'failed', step: 4 })
    expect(failed.reason).toContain('exited before reporting a result')
    expect(failed.reason).toContain('unpacking archive')
    expect(b.ticks.active()).toBe(0)
  })

  it('holds a probably-starting run through the grace window when no wrapper pid exists yet', () => {
    const b = bench({ isAlive: () => false })
    b.controller.start()
    b.ticks.tick()
    expect(b.controller.run()!.result).toBeNull()
    // Past the grace window with no pid file and no output, the run fails.
    let offset = 0
    const late = bench({
      isAlive: () => false,
      now: () => new Date(Date.now() + offset),
    })
    late.controller.start()
    offset = 60_000
    late.ticks.tick()
    expect(late.controller.run()).toMatchObject({ result: 'failed' })
    expect(late.controller.run()!.reason).toContain('before writing any output')
  })

  it('keeps watching after a terminal line until the process exits', () => {
    const alive = { value: true }
    const b = bench({ isAlive: () => alive.value })
    b.controller.start()
    writeLog(b.home, '[9/9] self-check\nEnpoi Harness successfully updated!\n')
    b.ticks.tick()
    expect(b.controller.run()!.result).toBe('success')
    expect(b.ticks.active()).toBe(1)
    alive.value = false
    b.ticks.tick()
    expect(b.ticks.active()).toBe(0)
  })

  it('records rolledback from the engine rollback line', () => {
    const b = bench({ isAlive: () => true })
    b.controller.start()
    writeLog(b.home, '[9/9] self-check\ndsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)\n')
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'rolledback', phase: 'rolledback' })
    b.controller.dispose()
  })
})

describe('UpdateRunController.reconcile', () => {
  it('marks success when the restart landed the target version', () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'run-restart', target: '0.1.7-enpoi.2.84', channel: 'stable', phase: 'switch', step: 8, steps: 9,
      lastLine: '[8/9] switch, service and backfill', startedAt: new Date().toISOString(), pid: 4242,
      logPath: runLogPath(home), result: null, rung: 'setsid', logTail: [],
    })}\n`)
    const b = bench({ home, identity: { channel: 'stable', version: '0.1.7-enpoi.2.84', commit: 'def5678' } })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ result: 'success', phase: 'done' })
    expect(readRunRecord(runRecordPath(home))?.result).toBe('success')
    // Idempotent: a second boot changes nothing.
    expect(b.controller.reconcile()).toEqual(reconciled)
  })

  it('marks failed when the version never reached the target', async () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'run-dead', target: '0.1.7-enpoi.2.84', channel: 'stable', phase: 'deps', step: 4, steps: 9,
      lastLine: '[4/9] dependencies and build', startedAt: new Date().toISOString(), pid: 4242,
      logPath: runLogPath(home), result: null, rung: 'setsid', logTail: [],
    })}\n`)
    writeFileSync(runPidPath(home), String(await deadPid()))
    const b = bench({ home })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(reconciled.reason).toContain('does not match the target')
  })

  it('resumes the watcher for a run whose updater is still alive', () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'run-live', target: '0.1.7-enpoi.2.84', channel: 'stable', phase: 'deps', step: 5, steps: 9,
      lastLine: '[5/9] transport', startedAt: new Date().toISOString(), pid: process.pid,
      logPath: runLogPath(home), result: null, rung: 'spawn', logTail: [],
    })}\n`)
    writeFileSync(runPidPath(home), String(process.pid))
    const b = bench({ home })
    const resumed = b.controller.reconcile()!
    expect(resumed.result).toBeNull()
    expect(b.ticks.active()).toBe(1)
    b.controller.dispose()
    expect(b.ticks.active()).toBe(0)
  })

  it('returns null when no run was ever recorded', () => {
    const b = bench()
    expect(b.controller.reconcile()).toBeNull()
    expect(b.controller.run()).toBeNull()
  })
})

describe('resolveShimPath', () => {
  it('prefers the recorded binDir and falls back to the conventional shim', async () => {
    const { resolveShimPath } = await import('../src/run-service.js')
    const home = scratch()
    mkdirSync(join(home, 'harness'), { recursive: true })
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(join(home, 'bin', 'dsh'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify({ binDir: join(home, 'bin') }))
    expect(resolveShimPath(home)).toBe(join(home, 'bin', 'dsh'))
    // An unreadable state file resolves nothing under this scratch home.
    writeFileSync(join(home, 'harness', 'install-state.json'), 'not json')
    expect(resolveShimPath(home)).not.toBe(join(home, 'bin', 'dsh'))
  })
})

describe('liveness seam wiring', () => {
  it('uses the injected isAlive instead of the real process probe', () => {
    const isAlive = vi.fn(() => true)
    const b = bench({ isAlive })
    b.controller.start()
    b.ticks.tick()
    expect(isAlive).toHaveBeenCalledWith(4242)
    b.controller.dispose()
  })
})
