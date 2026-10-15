/**
 * UpdateRunController: prepare/apply gating, launch, watcher progress
 * (preparing → prepared, applying → terminal), and the boot reconcile across
 * both phases.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InstallIdentity } from '../src/catalog.js'
import type { EngineCancelOutcome } from '../src/cancel.js'
import { updateJobLabel, type LaunchdJob, type LaunchOutcome, type LaunchUpdaterInput } from '../src/launcher.js'
import { runMarkerPath, type EngineRunMarker } from '../src/marker.js'
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

/**
 * Stage a complete applyable update for `home` (home doubles as prefix): the
 * engine's `.staged-apply.json` record plus the tree directory and its
 * `.dsh-install-complete` witness.
 */
function stageApply(home: string, version = '0.1.7-enpoi.2.84'): string {
  const file = stagedApplyPath(home)
  mkdirSync(join(home, 'harness', version), { recursive: true })
  writeFileSync(join(home, 'harness', version, '.dsh-install-complete'), `${JSON.stringify({ version })}\n`)
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
  /** Every launchd-job label the controller asked the removal seam to remove. */
  removals: string[]
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
  probe?: () => Promise<{ capability: 'supported' | 'unsupported'; reason?: string }>
  cancelEngine?: () => Promise<EngineCancelOutcome>
  /** launchd-job removal seam; the bench records every call by default. */
  removeJob?: (label: string) => boolean
  /** launchd-job listing seam; null (no listing) by default, like off-darwin. */
  listJobs?: () => readonly LaunchdJob[] | null
} = {}): Bench {
  const home = options.home ?? scratch()
  const ticks = manualTimers()
  const launches: LaunchUpdaterInput[] = []
  const removals: string[] = []
  const shim = join(home, 'bin', 'dsh')
  const launch = options.launch ?? ((input: LaunchUpdaterInput) => {
    launches.push(input)
    return { rung: 'setsid', pid: 4242 }
  })
  const removeJob = options.removeJob ?? ((label: string) => {
    removals.push(label)
    return true
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
    probe: options.probe ?? (async () => (options.probeCapability === 'unsupported'
      ? { capability: 'unsupported', reason: 'engine help does not list --prepare (exit 0)' }
      : { capability: 'supported' })),
    removeJob,
    listJobs: options.listJobs ?? (() => null),
    ...(options.cancelEngine === undefined ? {} : { cancelEngine: options.cancelEngine }),
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { controller, ticks, launches, removals, home, shim }
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

describe('UpdateRunController.start single flight', () => {
  it('launches exactly one engine for concurrent start calls in the probe window', async () => {
    let resolveProbe!: (value: { capability: 'supported' }) => void
    const probe = new Promise<{ capability: 'supported' }>((resolve) => { resolveProbe = resolve })
    const b = bench({ probe: () => probe })
    const first = b.controller.start()
    const second = b.controller.start()
    expect(first).toBe(second)
    // Both calls are parked on the same probe; nothing launched yet.
    expect(b.launches).toHaveLength(0)
    resolveProbe({ capability: 'supported' })
    const [one, two] = await Promise.all([first, second])
    expect(b.launches).toHaveLength(1)
    expect(one.runId).toBe('run42')
    expect(two).toEqual(one)
    b.controller.dispose()
  })

  it('attaches to a run that appeared while the probe was in flight, never launching a second', async () => {
    const home = scratch()
    let resolveProbe!: (value: { capability: 'supported' }) => void
    const probe = new Promise<{ capability: 'supported' }>((resolve) => { resolveProbe = resolve })
    const b = bench({ home, probe: () => probe })
    const starting = b.controller.start()
    // An update started outside the UI while the probe was in flight: the
    // post-await gate must attach to it instead of launching a second run.
    const log = join(home, 'install.log')
    writeFileSync(log, '[2/9] source\n')
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(runMarkerPath(home), JSON.stringify({
      runId: 'ext-9', pid: process.pid, mode: 'plain', step: 2, steps: 9, phase: 'running',
      startedAt: new Date().toISOString(), logPath: log, version: '', target: '0.1.7-enpoi.2.84',
    }))
    resolveProbe({ capability: 'supported' })
    const attached = await starting
    expect(attached).toMatchObject({ runId: 'ext-9', observed: true, result: null })
    expect(b.launches).toHaveLength(0)
    b.controller.dispose()
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
  it('refuses when nothing is prepared or the staged tree is gone', () => {
    const empty = bench()
    expect(() => empty.controller.apply()).toThrowError(expect.objectContaining({ reason: 'not-prepared' }))

    const preparedHome = scratch()
    writeLiveRecord(preparedHome, recordFixture({ home: preparedHome, record: { phase: 'prepared', staged: true, step: 7 } }).record, null)
    const missingMarker = bench({ home: preparedHome })
    // Reconcile first demotes the prepared record (no staged record on disk):
    // nothing can be applied, and apply refuses before any launch.
    expect(() => missingMarker.controller.apply()).toThrowError(expect.objectContaining({ reason: 'not-prepared' }))
    expect(missingMarker.launches).toHaveLength(0)
  })

  it('never replays apply after a rollback archived the staged tree (the A2 dead end)', () => {
    const home = scratch()
    stageApply(home)
    // The engine archives the failed tree as <dir>.failed-<ts> and keeps the
    // staged record; the marker survives but names a missing tree, and the
    // persisted record still reads `staged: true`.
    rmSync(join(home, 'harness', '0.1.7-enpoi.2.84'), { recursive: true, force: true })
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'apply', phase: 'rolledback', result: 'rolledback', staged: true, target: '0.1.7-enpoi.2.84' },
    }).record, null)
    const b = bench({ home })
    // The read path corrects the derived flag, which is what routes the
    // client's Retry/recover into a fresh prepare instead of a dead replay.
    expect(b.controller.run()).toMatchObject({ result: 'rolledback', staged: false })
    expect(JSON.parse(readFileSync(runRecordPath(home), 'utf8'))).toMatchObject({ staged: false })
    // apply names the real problem (marker present, tree archived) with its
    // own refusal, and never launches the engine again.
    expect(() => b.controller.apply()).toThrowError(expect.objectContaining({ reason: 'staged-tree-missing' }))
    expect(b.launches).toHaveLength(0)
    b.controller.dispose()
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

describe('UpdateRunController engine-marker observer', () => {
  /** Write an engine marker document under `home` (home doubles as prefix). */
  function writeMarker(home: string, overrides: Partial<EngineRunMarker> = {}): void {
    const document: EngineRunMarker = {
      runId: 'ext-1',
      pid: process.pid,
      mode: 'plain',
      step: 5,
      steps: 9,
      phase: 'running',
      startedAt: '2026-10-13T12:00:00Z',
      logPath: join(home, 'install.log'),
      version: '',
      target: '0.1.7-enpoi.2.84',
      ...overrides,
    }
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(runMarkerPath(home), JSON.stringify(document))
  }

  it('surfaces a live terminal-started run and attaches start to it', async () => {
    const home = scratch()
    writeMarker(home)
    const b = bench({ home })
    const record = b.controller.run()
    expect(record).toMatchObject({
      runId: 'ext-1',
      target: '0.1.7-enpoi.2.84',
      mode: 'one-shot',
      rung: 'one-shot',
      phase: 'preparing',
      step: 5,
      pid: process.pid,
      observed: true,
    })
    // Attach, not refuse: the UI renders the running update it already polls.
    const attached = await b.controller.start()
    expect(attached).toMatchObject({ runId: 'ext-1', observed: true, result: null })
    expect(b.launches).toHaveLength(0)
    b.controller.dispose()
  })

  it('attaches apply to a live terminal-started run without touching the shared log', async () => {
    const home = scratch()
    writeMarker(home)
    writeLog(home, 'output the running update still owns\n')
    const b = bench({ home })
    const record = b.controller.apply()
    expect(record).toMatchObject({ runId: 'ext-1', observed: true, result: null })
    expect(b.launches).toHaveLength(0)
    expect(readFileSync(runLogPath(home), 'utf8')).toBe('output the running update still owns\n')
    b.controller.dispose()
  })

  it('refuses to truncate the log when the engine turns live between the checks (begin guard)', async () => {
    const home = scratch()
    writeMarker(home)
    writeLog(home, 'output the racing engine still owns\n')
    // The marker reads stale (dead pid) through every pre-check; the pre-launch
    // sweep hook inside begin() is the instant the engine's pid turns live, so
    // only begin()'s own guard can catch the race (recon D4).
    const live = { value: false }
    let listings = 0
    const b = bench({
      home,
      isAlive: pid => pid === process.pid && live.value,
      // start()'s reconcile lists once; begin()'s pre-launch sweep is the
      // second listing, and that is when the engine turns live.
      listJobs: () => { if (++listings === 2) live.value = true; return null },
    })
    const attached = await b.controller.start()
    expect(attached).toMatchObject({ runId: 'ext-1', observed: true })
    expect(b.launches).toHaveLength(0)
    expect(readFileSync(runLogPath(home), 'utf8')).toBe('output the racing engine still owns\n')
    b.controller.dispose()
  })

  it('attaches to a live foreign run when the engine refuses the update lock (contention)', async () => {
    const home = scratch()
    const b = bench({ home })
    await b.controller.start()
    // The plugin's engine died on the engine's lock: another update is live.
    writeMarker(home, { runId: 'ext-7', pid: process.pid, phase: 'running', step: 3 })
    writeLog(home, '✗ ERROR: another update is already running (PID 12345); wait for it to finish\n')
    writeFileSync(runPidPath(home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    const record = b.controller.run()!
    expect(record).toMatchObject({ runId: 'ext-7', observed: true, result: null, step: 3 })
    // No failed record; the persisted state is the observed live run and the
    // watcher keeps polling it.
    expect(JSON.parse(readFileSync(runRecordPath(home), 'utf8'))).toMatchObject({ runId: 'ext-7', observed: true, result: null })
    expect(existsSync(runPidPath(home))).toBe(false)
    expect(b.ticks.active()).toBe(1)
    b.controller.dispose()
  })

  it('keeps the contention failure when no live run remains, without the manual-removal advice', async () => {
    const home = scratch()
    const b = bench({ home })
    await b.controller.start()
    writeLog(home, '✗ ERROR: another update is already running (PID 12345); wait for it to finish, or remove /x/harness/.update.lock.d only if its recorded PID is a reused or zombie process\n')
    writeFileSync(runPidPath(home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    const record = b.controller.run()!
    expect(record).toMatchObject({ runId: 'run42', result: 'failed', recoverable: true })
    expect(record.reason).toContain('another update is already running')
    expect(record.reason).not.toContain('remove')
    b.controller.dispose()
  })

  it('never observes a terminal marker even when its pid still reads live', () => {
    const home = scratch()
    writeMarker(home, { phase: 'failed', step: 8 })
    const b = bench({ home, isAlive: () => true })
    expect(b.controller.run()).toBeNull()
    b.controller.dispose()
  })

  it('ignores a stale (dead-pid) marker and falls back to the persisted record', async () => {
    const home = scratch()
    writeMarker(home, { pid: await deadPid() })
    const b = bench({ home })
    expect(b.controller.run()).toBeNull()
    b.controller.dispose()
  })

  it('lets the plugin’s own executing record win over the marker', async () => {
    const home = scratch()
    const b = bench({ home, isAlive: pid => pid === process.pid || pid === 4242 })
    await b.controller.start()
    writeMarker(home)
    const record = b.controller.run()!
    expect(record.observed).toBeUndefined()
    expect(record.runId).toBe('run42')
    b.controller.dispose()
  })

  it('reconciles a surviving plugin run with the marker pid and phase', () => {
    const home = scratch()
    const record = recordFixture({ home, record: { mode: 'one-shot', rung: 'one-shot', phase: 'preparing', step: 6, pid: process.pid } }).record
    writeLiveRecord(home, record, null)
    writeMarker(home, { mode: 'plain', phase: 'switching', step: 8, logPath: record.logPath })
    const b = bench({ home })
    const reconciled = b.controller.reconcile()!
    expect(reconciled).toMatchObject({ phase: 'applying', step: 8, pid: process.pid })
    b.controller.dispose()
  })

  it('relays an engine cancel of a terminal-started run into a persisted cancelled record', async () => {
    const home = scratch()
    writeMarker(home, {
      phase: 'cancelled',
      mode: 'plain',
      logPath: join(home, 'install.log'),
    })
    const cancelEngine = vi.fn(async (): Promise<EngineCancelOutcome> => ({
      status: 'cancelled',
      message: 'Cancelled run ext-1: runner stopped',
      runId: 'ext-1',
      pid: process.pid,
      phase: 'cancelled',
    }))
    const b = bench({ home, cancelEngine })
    const outcome = await b.controller.cancel()
    expect(cancelEngine).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ status: 'cancelled', message: expect.stringContaining('runner stopped') })
    expect(outcome.record).toMatchObject({ result: 'cancelled', phase: 'cancelled', observed: true })
    // Persisted: the next read still reports the cancelled state.
    expect(b.controller.run()).toMatchObject({ result: 'cancelled' })
    b.controller.dispose()
  })

  it('marks the plugin’s own record cancelled on a successful cancel', async () => {
    const home = scratch()
    const b = bench({
      home,
      isAlive: () => true,
      cancelEngine: async () => ({ status: 'cancelled', message: 'stopped', runId: 'run42', pid: 4242, phase: 'cancelled' }),
    })
    await b.controller.start()
    const outcome = await b.controller.cancel()
    expect(outcome.record).toMatchObject({ runId: 'run42', result: 'cancelled', phase: 'cancelled' })
    expect(outcome.record?.observed).toBeUndefined()
    b.controller.dispose()
  })

  it('never overwrites a terminal record with a cancelled relay (cancel racing a finish)', async () => {
    const home = scratch()
    // The run finished (success) between the cancel decision and the relay;
    // the engine's second read is authoritative, and even an old engine that
    // still reports `cancelled` must not relabel a terminal record.
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'apply', phase: 'success', result: 'success', step: 9, target: '0.1.7-enpoi.2.84', finishedAt: '2026-10-13T12:30:00.000Z' },
    }).record, null)
    const b = bench({
      home,
      cancelEngine: async () => ({ status: 'cancelled', message: 'stopped', runId: 'run-old', pid: 4242, phase: 'cancelled' }),
    })
    const outcome = await b.controller.cancel()
    expect(outcome.status).toBe('cancelled')
    expect(outcome.record).toMatchObject({ result: 'success', phase: 'success' })
    expect(b.controller.run()).toMatchObject({ result: 'success' })
    expect(JSON.parse(readFileSync(runRecordPath(home), 'utf8'))).toMatchObject({ result: 'success' })
    b.controller.dispose()
  })

  it('returns the engine refusal without changing the record', async () => {
    const home = scratch()
    writeMarker(home, { phase: 'applying', step: 8 })
    const b = bench({
      home,
      cancelEngine: async () => ({ status: 'refused', message: 'refusing — the update is past the switch (phase applying)', runId: 'ext-1', pid: process.pid, phase: 'applying' }),
    })
    const before = b.controller.run()
    const outcome = await b.controller.cancel()
    expect(outcome.status).toBe('refused')
    expect(outcome.message).toContain('past the switch')
    expect(outcome.record).toEqual(before)
    expect(b.controller.run()).toEqual(before)
    b.controller.dispose()
  })

  it('refuses cancel when the shim is missing', async () => {
    const home = scratch()
    const controller = new UpdateRunController({
      home,
      readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' }),
      readStatus: () => available(),
      resolveShim: () => null,
      resolvePrefix: () => home,
      timers: manualTimers().timers,
    })
    await expect(controller.cancel()).rejects.toThrowError(expect.objectContaining({ reason: 'shim-missing' }))
    controller.dispose()
  })
})

describe('UpdateRunController stale-state self-healing', () => {
  /** Push one file's mtime well past the stall window. */
  function staleMtime(path: string): void {
    const past = new Date(Date.now() - 30 * 60_000)
    utimesSync(path, past, past)
  }

  it('heals a dead-pid record on run() and lets start proceed', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { phase: 'preparing', step: 4, startedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    }).record, await deadPid())
    const b = bench({ home })
    const healed = b.controller.run()!
    expect(healed).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(healed.reason).toContain('no longer running')
    const started = await b.controller.start()
    expect(started).toMatchObject({ mode: 'prepare', phase: 'preparing' })
    b.controller.dispose()
  })

  it('heals a recycled-pid record once its log stopped moving', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { phase: 'preparing', step: 4, startedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }).record, process.pid)
    writeLog(home, '[4/9] dependencies and build\n')
    staleMtime(runLogPath(home))
    // The recycled pid reads live, but the run is not progressing.
    const b = bench({ home, isAlive: () => true })
    const healed = b.controller.run()!
    expect(healed).toMatchObject({ result: 'failed', phase: 'failed' })
    const started = await b.controller.start()
    expect(started.mode).toBe('prepare')
    b.controller.dispose()
  })

  it('treats a recycled pid behind a deleted log as dead instead of blocking forever', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { phase: 'preparing', step: 4, startedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }).record, process.pid)
    // No run.log at all: absent evidence is not evidence of life (recon D5).
    const b = bench({ home, isAlive: () => true })
    const healed = b.controller.run()!
    expect(healed).toMatchObject({ result: 'failed', phase: 'failed' })
    const started = await b.controller.start()
    expect(started.mode).toBe('prepare')
    b.controller.dispose()
  })

  it('lets clearStale open a recycled pid behind deleted files (gates unblock)', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { phase: 'applying', step: 8, startedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }).record, process.pid)
    const b = bench({ home, isAlive: () => true })
    expect(b.controller.clearStale()).toMatchObject({ result: 'failed', phase: 'failed' })
    b.controller.dispose()
  })

  it('keeps a just-launched run alive through the launch window when its log is missing', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { phase: 'preparing', step: 0, startedAt: new Date(Date.now() - 60_000).toISOString() },
    }).record, process.pid)
    // The log file is gone but the run started a minute ago: inside
    // RUN_START_GRACE_MS + the stall window the absent evidence is still
    // ambiguous, so the gate refuses rather than heal.
    const b = bench({ home, isAlive: () => true })
    await expect(b.controller.start()).rejects.toThrowError(expect.objectContaining({ reason: 'already-running' }))
    b.controller.dispose()
  })

  it('drops the wrapper pid file when a terminal result is parsed', async () => {
    const b = bench()
    await b.controller.start()
    writeLog(b.home, '[9/9] self-check\nEnpoi Harness successfully updated!\n')
    writeFileSync(runPidPath(b.home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'success', recoverable: false })
    expect(existsSync(runPidPath(b.home))).toBe(false)
    b.controller.dispose()
  })

  it('drops the wrapper pid file when a dead run is recorded failed', async () => {
    const b = bench({ isAlive: () => false })
    await b.controller.start()
    writeLog(b.home, '[4/9] dependencies and build\nunpacking archive\n')
    writeFileSync(runPidPath(b.home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'failed' })
    expect(existsSync(runPidPath(b.home))).toBe(false)
    b.controller.dispose()
  })

  it('still refuses while a genuinely progressing run is alive', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({ home, record: { phase: 'preparing', step: 2 } }).record, process.pid)
    writeLog(home, '[2/9] source: stable channel archive\n')
    const b = bench({ home, isAlive: () => true })
    await expect(b.controller.start()).rejects.toThrowError(expect.objectContaining({ reason: 'already-running' }))
    b.controller.dispose()
  })

  it('never lets a terminal record block, and re-applies the staged tree after a failure (the Mac case)', async () => {
    const home = scratch()
    mkdirSync(join(home, 'harness', '0.1.7-enpoi.2.87'), { recursive: true })
    writeFileSync(join(home, 'harness', '0.1.7-enpoi.2.87', '.dsh-install-complete'), '{}\n')
    writeFileSync(stagedApplyPath(home), JSON.stringify({
      version: '0.1.7-enpoi.2.87', treeDirName: '0.1.7-enpoi.2.87', channel: 'stable', preparedAt: '2026-10-13T07:25:52Z',
    }))
    writeLiveRecord(home, recordFixture({
      home,
      record: {
        mode: 'apply',
        phase: 'failed',
        result: 'failed',
        staged: true,
        target: '0.1.7-enpoi.2.86',
        reason: 'another update is already running (PID 30852)',
        startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
    }).record, process.pid)
    const b = bench({ home, isAlive: () => true })
    const record = b.controller.apply()
    // The staged record's version wins over the failed record's target.
    expect(record).toMatchObject({ mode: 'apply', target: '0.1.7-enpoi.2.87', phase: 'applying' })
    expect(b.launches).toHaveLength(1)
    expect(b.launches[0]).toMatchObject({ flag: '--apply', prefix: home })
    b.controller.dispose()
  })

  it('refuses apply on a failed record whose staged tree is gone', () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'apply', phase: 'failed', result: 'failed', staged: true },
    }).record, null)
    const b = bench({ home })
    expect(() => b.controller.apply()).toThrowError(expect.objectContaining({ reason: 'not-prepared' }))
    // The read path corrects the derived flag: the persisted record no longer
    // claims an applyable tree, so client Retry routes into a fresh prepare.
    expect(JSON.parse(readFileSync(runRecordPath(home), 'utf8'))).toMatchObject({ staged: false })
    b.controller.dispose()
  })
})

describe('UpdateRunController clearStale', () => {
  function writeMarkerDoc(home: string, phase: string, pid: number, logPath: string): void {
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(runMarkerPath(home), JSON.stringify({
      runId: 'ext-1', pid, mode: 'apply', step: 8, steps: 9, phase, startedAt: '2026-10-13T07:30:00Z',
      logPath, version: '', target: '0.1.7-enpoi.2.87',
    }))
  }

  it('refuses while the engine lock directory has a live owner', () => {
    const home = scratch()
    mkdirSync(join(home, 'harness', '.update.lock.d'), { recursive: true })
    writeFileSync(join(home, 'harness', '.update.lock.d', 'pid'), String(process.pid))
    const b = bench({ home, isAlive: () => true })
    expect(() => b.controller.clearStale()).toThrowError(expect.objectContaining({ reason: 'already-running' }))
    expect(readFileSync(join(home, 'harness', '.update.lock.d', 'pid'), 'utf8')).toBe(String(process.pid))
    b.controller.dispose()
  })

  it('refuses while a live observed run exists', () => {
    const home = scratch()
    writeMarkerDoc(home, 'running', process.pid, join(home, 'install.log'))
    const b = bench({ home })
    expect(() => b.controller.clearStale()).toThrowError(expect.objectContaining({ reason: 'already-running' }))
    b.controller.dispose()
  })

  it('refuses while the plugin’s own run is genuinely progressing', async () => {
    const home = scratch()
    const b = bench({ home, isAlive: () => true })
    await b.controller.start()
    expect(() => b.controller.clearStale()).toThrowError(expect.objectContaining({ reason: 'already-running' }))
    b.controller.dispose()
  })

  it('heals stale state, leaves the engine marker and staged tree untouched, and lets apply run', async () => {
    const home = scratch()
    mkdirSync(join(home, 'harness', '0.1.7-enpoi.2.87'), { recursive: true })
    writeFileSync(join(home, 'harness', '0.1.7-enpoi.2.87', '.dsh-install-complete'), '{}\n')
    const stagedBody = JSON.stringify({
      version: '0.1.7-enpoi.2.87', treeDirName: '0.1.7-enpoi.2.87', channel: 'stable', preparedAt: '2026-10-13T07:25:52Z',
    })
    writeFileSync(stagedApplyPath(home), stagedBody)
    writeMarkerDoc(home, 'failed', await deadPid(), join(home, 'install.log'))
    const markerBody = readFileSync(runMarkerPath(home), 'utf8')
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'apply', phase: 'applying', step: 8, staged: true, startedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }).record, await deadPid())
    const b = bench({ home })
    const cleared = b.controller.clearStale()!
    expect(cleared).toMatchObject({ result: 'failed', phase: 'failed' })
    // Engine-owned files are never touched.
    expect(readFileSync(stagedApplyPath(home), 'utf8')).toBe(stagedBody)
    expect(readFileSync(runMarkerPath(home), 'utf8')).toBe(markerBody)
    // The dead pid file is dropped and apply now proceeds against the staged tree.
    expect(existsSync(runPidPath(home))).toBe(false)
    const applied = b.controller.apply()
    expect(applied).toMatchObject({ mode: 'apply', target: '0.1.7-enpoi.2.87' })
    b.controller.dispose()
  })

  it('heals a stale prepare that did stage the tree into the prepared state', async () => {
    const home = scratch()
    mkdirSync(join(home, 'harness', '0.1.7-enpoi.2.87'), { recursive: true })
    writeFileSync(join(home, 'harness', '0.1.7-enpoi.2.87', '.dsh-install-complete'), '{}\n')
    writeFileSync(stagedApplyPath(home), JSON.stringify({
      version: '0.1.7-enpoi.2.87', treeDirName: '0.1.7-enpoi.2.87', channel: 'stable', preparedAt: '2026-10-13T07:25:52Z',
    }))
    writeLiveRecord(home, recordFixture({
      home,
      record: { mode: 'prepare', phase: 'preparing', step: 7, staged: true, startedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
    }).record, await deadPid())
    const b = bench({ home })
    const cleared = b.controller.clearStale()!
    expect(cleared).toMatchObject({ phase: 'prepared', result: null })
    const applied = b.controller.apply()
    expect(applied).toMatchObject({ mode: 'apply', target: '0.1.7-enpoi.2.87' })
    b.controller.dispose()
  })
})

describe('UpdateRunController launchd job removal', () => {
  /** A launch outcome on the macOS launchctl rung (the run id the bench pins). */
  function launchctlRung(): LaunchOutcome {
    return { rung: 'launchctl', unit: updateJobLabel('run42'), pid: 4242 }
  }

  /** Push one file's mtime well past the stall window. */
  function staleMtime(path: string): void {
    const past = new Date(Date.now() - 30 * 60_000)
    utimesSync(path, past, past)
  }

  it('removes the submitted job when a launched run reaches a terminal result', async () => {
    const b = bench({ launch: launchctlRung, isAlive: () => false })
    await b.controller.start()
    writeLog(b.home, '[1/9] environment\nEnpoi Harness successfully updated!\n')
    writeFileSync(runPidPath(b.home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'success', launcher: 'launchctl' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    expect(b.ticks.active()).toBe(0)
    b.controller.dispose()
  })

  it('never removes the job while the engine is alive; the later resting tick removes it', async () => {
    const alive = { value: true }
    const b = bench({ launch: launchctlRung, isAlive: () => alive.value })
    await b.controller.start()
    writeLog(b.home, 'Enpoi Harness successfully updated!\n')
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'success' })
    // The terminal line landed while the engine still ran: the job stays.
    expect(b.removals).toEqual([])
    expect(b.ticks.active()).toBe(1)
    // The engine exits; the next tick sees a resting record, removes, stops.
    alive.value = false
    b.ticks.tick()
    expect(b.removals).toEqual([updateJobLabel('run42')])
    expect(b.ticks.active()).toBe(0)
    b.controller.dispose()
  })

  it('removes the job when a prepare rests at prepared', async () => {
    const b = bench({ launch: launchctlRung, isAlive: () => false })
    await b.controller.start()
    stageApply(b.home)
    writeLog(b.home, '[7/9] home, dependencies and migrations\n')
    writeFileSync(runPidPath(b.home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ phase: 'prepared', staged: true, launcher: 'launchctl' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    b.controller.dispose()
  })

  it('removes the job when the engine exits without a result', async () => {
    const b = bench({ launch: launchctlRung, isAlive: () => false })
    await b.controller.start()
    writeLog(b.home, '[4/9] dependencies and build\nunpacking archive\n')
    writeFileSync(runPidPath(b.home), `${String(await deadPid())}\n`)
    b.ticks.tick()
    expect(b.controller.run()).toMatchObject({ result: 'failed', launcher: 'launchctl' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    b.controller.dispose()
  })

  it('removes the job when a successful cancel relays into a cancelled record', async () => {
    const alive = { value: true }
    const b = bench({
      launch: launchctlRung,
      isAlive: () => alive.value,
      // The engine answers `cancelled` only after the runner exited; model
      // that fact reaching the plugin's pid probe.
      cancelEngine: async () => {
        alive.value = false
        return { status: 'cancelled', message: 'stopped', runId: 'run42', pid: 4242, phase: 'cancelled' }
      },
    })
    await b.controller.start()
    const outcome = await b.controller.cancel()
    expect(outcome.record).toMatchObject({ result: 'cancelled', launcher: 'launchctl' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    b.controller.dispose()
  })

  it('removes the job when a stale read heals the run (healStaleOwn)', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: {
        runId: 'run42',
        phase: 'preparing',
        step: 4,
        launcher: 'launchctl',
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    }).record, await deadPid())
    const b = bench({ home })
    expect(b.controller.run()).toMatchObject({ result: 'failed' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    b.controller.dispose()
  })

  it('removes the job when clearStale heals a dead run', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: {
        runId: 'run42',
        phase: 'preparing',
        step: 4,
        launcher: 'launchctl',
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    }).record, await deadPid())
    const b = bench({ home })
    expect(b.controller.clearStale()).toMatchObject({ result: 'failed' })
    expect(b.removals).toEqual([updateJobLabel('run42')])
    b.controller.dispose()
  })

  it('never sweeps a job launchd reports as running, only stale ones', () => {
    const jobs: LaunchdJob[] = [
      { label: updateJobLabel('live'), running: true },
      { label: updateJobLabel('dead'), running: false },
      { label: 'com.other.running', running: true },
    ]
    const b = bench({ listJobs: () => jobs })
    expect(b.controller.reconcile()).toBeNull()
    expect(b.removals).toEqual([updateJobLabel('dead')])
    b.controller.dispose()
  })

  it('refuses to remove the job while the raw engine pid is live, even when progress went stale (healStaleOwn)', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: {
        runId: 'run42',
        phase: 'preparing',
        step: 4,
        launcher: 'launchctl',
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    }).record, process.pid)
    writeLog(home, '[4/9] dependencies and build\n')
    staleMtime(runLogPath(home))
    // The strong-liveness heuristic reads the silent run as stale (the log
    // stopped moving >5 min ago), but the raw pid is alive: the record heals,
    // the launchd job is never touched (launchctl remove would kill it).
    const b = bench({ home, isAlive: () => true })
    expect(b.controller.run()).toMatchObject({ result: 'failed' })
    expect(b.removals).toEqual([])
    b.controller.dispose()
  })

  it('refuses to remove the job while the raw engine pid is live, even when clearStale heals (clearStale)', async () => {
    const home = scratch()
    writeLiveRecord(home, recordFixture({
      home,
      record: {
        runId: 'run42',
        phase: 'preparing',
        step: 4,
        launcher: 'launchctl',
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    }).record, process.pid)
    writeLog(home, '[4/9] dependencies and build\n')
    staleMtime(runLogPath(home))
    const b = bench({ home, isAlive: () => true })
    expect(b.controller.clearStale()).toMatchObject({ result: 'failed' })
    expect(b.removals).toEqual([])
    b.controller.dispose()
  })

  it('sweeps leftover com.dsh.update.* jobs at boot when the marker is not live', () => {
    const jobs: LaunchdJob[] = [
      { label: updateJobLabel('aaa'), running: false },
      { label: 'com.other.job', running: false },
      { label: 'com.dsh.update-guard.token.1', running: false },
      { label: updateJobLabel('bbb'), running: false },
    ]
    const b = bench({ listJobs: () => jobs })
    expect(b.controller.reconcile()).toBeNull()
    // Only this plugin's own update jobs; unrelated and guard labels stay.
    expect(b.removals).toEqual([updateJobLabel('aaa'), updateJobLabel('bbb')])
    b.controller.dispose()
  })

  it('skips the sweep while the engine marker names a live run', () => {
    const home = scratch()
    const log = join(home, 'install.log')
    writeFileSync(log, '[2/9] source\n')
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(runMarkerPath(home), JSON.stringify({
      runId: 'ext-1', pid: process.pid, mode: 'plain', step: 2, steps: 9, phase: 'running',
      startedAt: new Date().toISOString(), logPath: log, version: '', target: '',
    }))
    const b = bench({ home, listJobs: () => [{ label: updateJobLabel('ccc'), running: false }] })
    b.controller.reconcile()
    expect(b.removals).toEqual([])
    b.controller.dispose()
  })

  it('skips the sweep while the controller’s own launchd run is executing', async () => {
    const alive = { value: true }
    let listings = 0
    const b = bench({
      launch: launchctlRung,
      isAlive: () => alive.value,
      // start() lists twice (reconcile + begin) before anything exists; only
      // the post-start reconcile sees labels, while the own run is executing.
      listJobs: () => (++listings >= 3 ? [{ label: updateJobLabel('ccc'), running: false }] : []),
    })
    await b.controller.start()
    expect(listings).toBe(2)
    expect(b.removals).toEqual([])
    // The engine has not written its marker yet: the own executing record is
    // the liveness evidence that keeps the sweep away from its job.
    b.controller.reconcile()
    expect(listings).toBe(3)
    expect(b.removals).toEqual([])
    b.controller.dispose()
  })

  it('runs the pre-launch sweep in begin() before launching a new run', async () => {
    let listings = 0
    const b = bench({ listJobs: () => (++listings === 2 ? [{ label: updateJobLabel('old'), running: false }] : []) })
    await b.controller.start()
    // First listing from start()'s reconcile, second from begin() itself.
    expect(listings).toBe(2)
    expect(b.removals).toEqual([updateJobLabel('old')])
    b.controller.dispose()
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
