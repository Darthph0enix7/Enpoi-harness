/**
 * UpdateRunController: prepare/apply gating, launch, watcher progress
 * (preparing → prepared, applying → terminal), and the boot reconcile across
 * both phases.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstallIdentity } from '../src/catalog.js'
import type { LaunchOutcome, LaunchUpdaterInput } from '../src/launcher.js'
import { runLogPath, runPidPath, runRecordPath, stagedApplyPath, type UpdateRunRecord } from '../src/run.js'
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

/** Stage the engine's `.staged-apply.json` marker for `home` as its own prefix. */
function stageApply(home: string, version = '0.1.7-enpoi.2.84'): string {
  const file = stagedApplyPath(home)
  mkdirSync(join(home, 'harness'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version, treeDirName: version, channel: 'stable', preparedAt: '2026-10-13T12:00:00.000Z' }))
  return file
}

function writeLog(home: string, text: string): void {
  mkdirSync(join(home, 'update-check'), { recursive: true })
  writeFileSync(runLogPath(home), text)
}

interface Bench {
  controller: UpdateRunController
  ticks: ReturnType<typeof manualTimers>
  launches: LaunchUpdaterInput[]
  home: string
  shim: string
}

function bench(options: {
  home?: string
  status?: UpdateCheckStatus
  identity?: InstallIdentity
  launch?: (input: LaunchUpdaterInput) => LaunchOutcome
  isAlive?: (pid: number) => boolean
  now?: () => Date
  probeCapability?: 'supported' | 'unsupported'
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
    resolvePrefix: () => home,
    runId: () => 'run42',
    pollIntervalMs: 1_000,
    timers: ticks.timers,
    probe: async () => (options.probeCapability === 'unsupported'
      ? { capability: 'unsupported', reason: 'engine help does not list --prepare (exit 0)' }
      : { capability: 'supported' }),
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { controller, ticks, launches, home, shim }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => { child.on('exit', () => { resolve() }) })
  return pid
}

describe('UpdateRunController.start (prepare)', () => {
  it('refuses when no update is available, with a typed reason', async () => {
    for (const status of [
      { state: 'current', current: { version: '0.1.7-enpoi.2.84', commit: 'a', channel: 'stable' } } as UpdateCheckStatus,
      { state: 'unknown', current: { version: '', commit: '', channel: 'stable' } } as UpdateCheckStatus,
      { state: 'available', current: { version: 'x', commit: 'a', channel: 'stable' } } as UpdateCheckStatus,
    ]) {
      const b = bench({ status })
      await expect(b.controller.start()).rejects.toThrowError(
        expect.objectContaining({ name: 'RunRefusedError', reason: 'not-available' }) as Error,
      )
    }
  })

  it('refuses when a run is already active or an update is already prepared', async () => {
    const live = recordFixture({ record: { phase: 'preparing' } })
    const b = bench({ home: live.home })
    writeLiveRecord(live.home, live.record, process.pid)
    await expect(b.controller.start()).rejects.toThrowError(expect.objectContaining({ reason: 'already-running' }))

    const preparedHome = scratch()
    stageApply(preparedHome)
    writeLiveRecord(preparedHome, recordFixture({ home: preparedHome, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const prepared = bench({ home: preparedHome })
    await expect(prepared.controller.start()).rejects.toThrowError(expect.objectContaining({ reason: 'already-prepared' }))
  })

  it('pins the target and channel, truncates the log, and launches --prepare', async () => {
    const b = bench()
    writeLog(b.home, 'stale output from an older run\n')
    const record = await b.controller.start()
    expect(record).toMatchObject({
      runId: 'run42',
      target: '0.1.7-enpoi.2.84',
      channel: 'stable',
      mode: 'prepare',
      rung: 'two-phase',
      launcher: 'setsid',
      phase: 'preparing',
      step: 0,
      steps: 9,
      result: null,
      pid: 4242,
      staged: false,
    })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({
      home: b.home,
      prefix: b.home,
      shim: b.shim,
      flag: '--prepare',
      channel: 'stable',
      runId: 'run42',
    })
    expect(readFileSync(runLogPath(b.home), 'utf8')).toBe('')
    expect(JSON.parse(readFileSync(runRecordPath(b.home), 'utf8'))).toMatchObject({ result: null, phase: 'preparing' })
    b.controller.dispose()
  })

  it('starts an update for a dismissed version (the Settings control re-arms it)', async () => {
    const b = bench({ status: { ...available(), state: 'dismissed' } })
    const record = await b.controller.start()
    expect(record).toMatchObject({ target: '0.1.7-enpoi.2.84', mode: 'prepare', result: null })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({ flag: '--prepare', channel: 'stable' })
    b.controller.dispose()
  })

  it('records a launch failure with the clear reason and refuses', async () => {
    const b = bench({ launch: () => { throw new Error('no Node.js runtime found for the updater (probed: PATH)') } })
    await expect(b.controller.start()).rejects.toThrowError(
      expect.objectContaining({ name: 'RunRefusedError', reason: 'launch-failed' }),
    )
    const persisted = JSON.parse(readFileSync(runRecordPath(b.home), 'utf8')) as UpdateRunRecord
    expect(persisted.result).toBe('failed')
    expect(persisted.reason).toContain('no Node.js runtime found')
  })

  it('is exportable as a refusal error type', () => {
    expect(new RunRefusedError('not-available', 'nope')).toMatchObject({ name: 'RunRefusedError', reason: 'not-available' })
  })
})

describe('UpdateRunController watcher', () => {
  it('follows the prepare steps, then rests at prepared when the staged marker appears', async () => {
    const alive = { value: true }
    const b = bench({ isAlive: () => alive.value })
    await b.controller.start()
    writeLog(b.home, '[1/9] environment: existing install\n  ✓ cli found\n[4/9] dependencies and build: prebuilt release\n')
    b.ticks.tick()
    const midway = b.controller.run()!
    expect(midway).toMatchObject({ step: 4, steps: 9, phase: 'preparing', pid: 4242 })
    expect(midway.lastLine).toBe('[4/9] dependencies and build: prebuilt release')

    // The engine stages the tree and exits; the marker (not a log line) is the witness.
    stageApply(b.home)
    writeLog(b.home, '[1/9] environment\n[7/9] home, dependencies and migrations\n  ✓ profile seeded\n')
    writeFileSync(runPidPath(b.home), '4242\n')
    alive.value = false
    b.ticks.tick()
    const prepared = b.controller.run()!
    expect(prepared).toMatchObject({ phase: 'prepared', result: null, staged: true, step: 7 })
    expect(b.ticks.active()).toBe(0)
    b.controller.dispose()
  })

  it('records failed when the prepare exits without staging anything', async () => {
    const b = bench({ isAlive: () => false })
    await b.controller.start()
    writeLog(b.home, '[4/9] dependencies and build\nunpacking archive\n')
    writeFileSync(runPidPath(b.home), String(await deadPid()))
    b.ticks.tick()
    const failed = b.controller.run()!
    expect(failed).toMatchObject({ result: 'failed', phase: 'failed', step: 4 })
    expect(failed.reason).toContain('the prepare run exited before reporting a result')
    expect(b.ticks.active()).toBe(0)
  })

  it('holds a probably-starting run through the grace window when no wrapper pid exists yet', async () => {
    let offset = 0
    const late = bench({
      isAlive: () => false,
      now: () => new Date(Date.now() + offset),
    })
    await late.controller.start()
    late.ticks.tick()
    expect(late.controller.run()!.result).toBeNull()
    offset = 60_000
    late.ticks.tick()
    expect(late.controller.run()).toMatchObject({ result: 'failed' })
    expect(late.controller.run()!.reason).toContain('exited before writing any output')
  })
})

describe('UpdateRunController.apply', () => {
  it('refuses when nothing is prepared or the staged marker is gone', () => {
    const empty = bench()
    expect(() => empty.controller.apply()).toThrowError(expect.objectContaining({ reason: 'not-prepared' }))

    const preparedHome = scratch()
    writeLiveRecord(preparedHome, recordFixture({ home: preparedHome, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const missingMarker = bench({ home: preparedHome })
    expect(() => missingMarker.controller.apply()).toThrowError(expect.objectContaining({ reason: 'not-prepared' }))
  })

  it('launches --apply against the staged tree with the recorded target', () => {
    const home = scratch()
    stageApply(home)
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'prepared', staged: true, step: 7, target: '0.1.7-enpoi.2.84' } }).record, null)
    const b = bench({ home })
    const record = b.controller.apply()
    expect(record).toMatchObject({
      runId: 'run42',
      target: '0.1.7-enpoi.2.84',
      channel: 'stable',
      mode: 'apply',
      phase: 'applying',
      result: null,
      staged: true,
      rung: 'two-phase',
      launcher: 'setsid',
    })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({ flag: '--apply', prefix: home })
    expect(b.launches[0]!.channel).toBeUndefined()
    b.controller.dispose()
  })

  it('follows the apply steps to success and keeps watching until exit', () => {
    const alive = { value: true }
    const home = scratch()
    stageApply(home)
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const b = bench({ home, isAlive: () => alive.value })
    b.controller.apply()
    writeLog(home, '[8/9] switch, service and backfill\n  ✓ current → 0.1.7-enpoi.2.84\n[9/9] self-check\nEnpoi Harness successfully updated!\n')
    b.ticks.tick()
    const done = b.controller.run()!
    expect(done).toMatchObject({ mode: 'apply', phase: 'success', result: 'success', step: 9 })
    expect(done.logTail.at(-1)).toBe('Enpoi Harness successfully updated!')
    expect(b.ticks.active()).toBe(1)
    alive.value = false
    b.ticks.tick()
    expect(b.ticks.active()).toBe(0)
    b.controller.dispose()
  })

  it('records rolledback from the engine rollback line', () => {
    const home = scratch()
    stageApply(home)
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const b = bench({ home, isAlive: () => true })
    b.controller.apply()
    writeLog(home, '[9/9] self-check\ndsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)\n')
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'rolledback', phase: 'rolledback' })
    expect(b.controller.run()!.reason).toContain('rolled back')
    b.controller.dispose()
  })
})

describe('UpdateRunController.reconcile', () => {
  it('keeps a prepared run offered across a restart (marker present)', () => {
    const home = scratch()
    stageApply(home)
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const b = bench({ home })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ phase: 'prepared', result: null, staged: true })
    expect(b.ticks.active()).toBe(0)
    // Idempotent: a second boot changes nothing.
    expect(b.controller.reconcile()).toEqual(reconciled)
  })

  it('promotes a dead prepare with the marker to prepared', async () => {
    const home = scratch()
    stageApply(home)
    writeLog(home, '[7/9] home, dependencies and migrations\n')
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'preparing', step: 7 } }).record, await deadPid())
    const b = bench({ home })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ phase: 'prepared', result: null, staged: true })
    expect(JSON.parse(readFileSync(runRecordPath(home), 'utf8'))).toMatchObject({ phase: 'prepared' })
  })

  it('marks success when the apply switch landed the target version', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({ home, record: { mode: 'apply', phase: 'applying', step: 9 } }).record, await deadPid())
    const b = bench({ home, identity: { channel: 'stable', version: '0.1.7-enpoi.2.84', commit: 'def5678' } })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ result: 'success', phase: 'success' })
    expect(readFileSync(runRecordPath(home), 'utf8')).toContain('"result": "success"')
  })

  it('marks failed when an apply died and the version never reached the target', async () => {
    const home = scratch()
    stageApply(home)
    writeLiveRecord(home, recordFixture({ home, record: { mode: 'apply', phase: 'applying', step: 8, staged: true } }).record, await deadPid())
    const b = bench({ home })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(reconciled.reason).toContain('the apply run is no longer running')
  })

  it('resumes the watcher for a run whose updater is still alive, and returns null with no record', () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({ home, record: { mode: 'apply', phase: 'applying', step: 8 } }).record, process.pid)
    const b = bench({ home })
    const resumed = b.controller.reconcile()!
    expect(resumed.result).toBeNull()
    expect(b.ticks.active()).toBe(1)
    b.controller.dispose()
    expect(b.ticks.active()).toBe(0)

    expect(bench().controller.reconcile()).toBeNull()
  })
})

describe('resolveShimPath', () => {
  it('prefers the recorded binDir and falls back to the conventional shim', async () => {
    const { resolveShimPath } = await import('../src/run-service.js')
    const home = scratch()
    mkdirSync(join(home, 'harness'), { recursive: true })
    mkdirSync(join(home, 'bin'), { recursive: true })
    writeFileSync(join(home, 'bin', 'dsh'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify({ binDir: join(home, 'bin'), prefix: home }))
    expect(resolveShimPath(home)).toBe(join(home, 'bin', 'dsh'))
    // An unreadable state file resolves nothing under this scratch home.
    writeFileSync(join(home, 'harness', 'install-state.json'), 'not json')
    expect(resolveShimPath(home)).not.toBe(join(home, 'bin', 'dsh'))
  })
})

describe('UpdateRunController one-shot rung (engine without --prepare)', () => {
  it('starts the one-shot invocation when the probe reports unsupported', async () => {
    const b = bench({ probeCapability: 'unsupported' })
    const record = await b.controller.start()
    expect(record).toMatchObject({
      runId: 'run42',
      mode: 'one-shot',
      rung: 'one-shot',
      phase: 'preparing',
      result: null,
      staged: false,
    })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({ flag: 'one-shot', channel: 'stable', prefix: b.home })
    b.controller.dispose()
  })

  it('runs the full step band to success and never rests at prepared', async () => {
    const b = bench({ probeCapability: 'unsupported' })
    await b.controller.start()
    writeLog(b.home, [
      '[1/9] environment: existing install',
      '[4/9] dependencies and build: prebuilt release (no local build)',
      '[7/9] home, dependencies and migrations',
      '[8/9] switch, service and backfill',
      '[9/9] self-check',
      'Enpoi Harness successfully updated!',
    ].join('\n'))
    b.ticks.tick()
    const done = b.controller.run()!
    expect(done).toMatchObject({ result: 'success', phase: 'success', step: 9, rung: 'one-shot' })
    expect(done.staged).toBe(false)
    expect(b.ticks.active()).toBe(0)
    b.controller.dispose()
  })

  it('fails a dead one-shot run even when a staged marker exists', async () => {
    const home = scratch()
    stageApply(home)
    const b = bench({ home, probeCapability: 'unsupported', isAlive: () => false })
    await b.controller.start()
    writeLog(home, '[4/9] dependencies and build\nunpacking archive\n')
    writeFileSync(runPidPath(home), String(await deadPid()))
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(b.controller.run()!.phase).not.toBe('prepared')
    b.controller.dispose()
  })

  it('refuses apply on a one-shot record with the clear one-shot message', () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'one-shot', rung: 'one-shot', phase: 'failed', result: 'failed', staged: false },
    }).record, null)
    const b = bench({ home })
    let error: unknown
    try {
      b.controller.apply()
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ name: 'RunRefusedError', reason: 'not-prepared' })
    expect((error as Error).message).toContain('one-shot')
    expect((error as Error).message).toContain('nothing to apply')
  })

  it('probes once per controller and caches the answer', async () => {
    const home = scratch()
    const probe = vi.fn(async () => ({ capability: 'supported' as const }))
    const controller = new UpdateRunController({
      home,
      readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' }),
      readStatus: () => available(),
      resolveShim: () => join(home, 'bin', 'dsh'),
      resolvePrefix: () => home,
      timers: manualTimers().timers,
      probe,
    })
    expect(await controller.probe()).toEqual({ capability: 'supported' })
    expect(await controller.probe()).toEqual({ capability: 'supported' })
    expect(probe).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})

describe('liveness seam wiring', () => {
  it('uses the injected isAlive instead of the real process probe', async () => {
    const isAlive = vi.fn(() => true)
    const b = bench({ isAlive })
    await b.controller.start()
    b.ticks.tick()
    expect(isAlive).toHaveBeenCalledWith(4242)
    b.controller.dispose()
  })
})

/** Fixture pairing a scratch home with one record. */
function recordFixture(options: { home?: string; record?: Partial<UpdateRunRecord> } = {}): {
  home: string
  record: UpdateRunRecord
} {
  const home = options.home ?? scratch()
  return {
    home,
    record: {
      runId: 'run-old',
      target: '0.1.7-enpoi.2.84',
      channel: 'stable',
      mode: 'prepare',
      rung: 'two-phase',
      launcher: 'setsid',
      phase: 'preparing',
      step: 0,
      steps: 9,
      lastLine: '',
      startedAt: new Date().toISOString(),
      pid: null,
      logPath: runLogPath(home),
      result: null,
      staged: false,
      logTail: [],
      ...options.record,
    },
  }
}

/** Persist a record (and an optional wrapper pid) under `home`. */
function writeLiveRecord(home: string, record: UpdateRunRecord, pid: number | null): void {
  mkdirSync(join(home, 'update-check'), { recursive: true })
  writeFileSync(runRecordPath(home), `${JSON.stringify(record)}\n`)
  if (pid !== null) writeFileSync(runPidPath(home), `${String(pid)}\n`)
}
