/**
 * Run record, log parser, staged marker, and the restart reconcile: the
 * `[N/9]` contract, terminal result lines, the prepared resting state, and
 * every dead-run resolution branch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { InstallIdentity } from '../src/catalog.js'
import {
  effectivePid,
  executingPhase,
  hasStagedApply,
  isPreparedPhase,
  isProcessAlive,
  isRunActive,
  isTerminalPhase,
  modeFlag,
  parseRunLog,
  phaseForResult,
  preparedRecord,
  readRunLog,
  readRunPid,
  readRunRecord,
  reconcileRunRecord,
  resultFromLine,
  runRecordPath,
  sameRunRecord,
  stagedApplyPath,
  terminalRecord,
  writeRunRecord,
  type UpdateRunRecord,
} from '../src/run.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-run-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function record(overrides: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId: 'run-1',
    target: '0.1.7-enpoi.2.84',
    channel: 'stable',
    mode: 'prepare',
    phase: 'preparing',
    step: 0,
    steps: 9,
    lastLine: '',
    startedAt: '2026-10-13T12:00:00.000Z',
    pid: 4242,
    logPath: '/nonexistent/run.log',
    result: null,
    rung: 'setsid',
    staged: false,
    logTail: [],
    ...overrides,
  }
}

/** Stage the engine's marker for `root`'s prefix. */
function stageMarker(root: string, version = '0.1.7-enpoi.2.84'): string {
  const file = stagedApplyPath(join(root, 'prefix'))
  mkdirSync(join(root, 'prefix', 'harness'), { recursive: true })
  writeFileSync(file, JSON.stringify({ version, treeDirName: version, channel: 'stable', preparedAt: '2026-10-13T12:00:00.000Z' }))
  return file
}

const identity = (version: string, commit = 'abc1234', channel = 'stable'): InstallIdentity => ({
  channel,
  version,
  commit,
})

/** A pid that is certainly dead: a short-lived child, awaited to exit. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => { child.on('exit', () => { resolve() }) })
  return pid
}

describe('phases, modes, and the staged marker', () => {
  it('maps modes, engine flags, executing phases, and terminal phases', () => {
    expect(modeFlag('prepare')).toBe('--prepare')
    expect(modeFlag('apply')).toBe('--apply')
    expect(executingPhase('prepare')).toBe('preparing')
    expect(executingPhase('apply')).toBe('applying')
    expect(phaseForResult('success')).toBe('success')
    expect(phaseForResult('failed')).toBe('failed')
    expect(phaseForResult('rolledback')).toBe('rolledback')
    expect(isTerminalPhase('success')).toBe(true)
    expect(isTerminalPhase('prepared')).toBe(false)
    expect(isPreparedPhase('prepared')).toBe(true)
    expect(isPreparedPhase('preparing')).toBe(false)
  })

  it('resolves the staged marker under the prefix', () => {
    const root = scratch()
    expect(stagedApplyPath(join(root, 'prefix'))).toBe(join(root, 'prefix', 'harness', '.staged-apply.json'))
    expect(hasStagedApply(join(root, 'prefix'))).toBe(false)
    stageMarker(root)
    expect(hasStagedApply(join(root, 'prefix'))).toBe(true)
  })
})

describe('parseRunLog', () => {
  it('reads step markers, the last line, the bounded tail, and no result', () => {
    const parsed = parseRunLog([
      '\u001b[1m[1/9]\u001b[0m environment: existing install under /home/dsh',
      '  \u001b[32m✓\u001b[0m cli found',
      '[2/9] source: stable channel archive',
      '[7/9] home, dependencies and migrations',
      '  ! WARNING: profile dependency refresh failed',
    ].join('\n'))
    expect(parsed.step).toBe(7)
    expect(parsed.steps).toBe(9)
    expect(parsed.result).toBeNull()
    expect(parsed.lastLine).toBe('  ! WARNING: profile dependency refresh failed')
    expect(parsed.logTail).toHaveLength(5)
    expect(parsed.logTail[0]).toBe('[1/9] environment: existing install under /home/dsh')
  })

  it('keeps the highest step and ignores a later lower marker', () => {
    const parsed = parseRunLog('[9/9] self-check\n[8/9] stale banner\n')
    expect(parsed.step).toBe(9)
  })

  it.each([
    ['Enpoi Harness successfully updated!', 'success'],
    ['dsh is already up to date: 0.1.7-enpoi.2.84 (stable channel)', 'success'],
    ['Update applied: 0.1.7-enpoi.2.84 (stable channel) — current → 0.1.7-enpoi.2.84', 'success'],
    ['dsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)', 'rolledback'],
    ['✗ ERROR: no install state at /home/dsh/harness/install-state.json', 'failed'],
    ['dsh update FAILED; rolled back to x, but the user-file restore did NOT complete.', 'rolledback'],
  ] as const)('classifies %j as %s', (line, result) => {
    expect(resultFromLine(line)).toBe(result)
    expect(parseRunLog(`[9/9] self-check\n${line}\n`).result).toBe(result)
  })

  it('never treats the prepare completion line as a terminal result', () => {
    expect(resultFromLine('Update prepared: 0.1.7-enpoi.2.84 (stable channel) — nothing was switched or restarted.')).toBeNull()
    expect(parseRunLog('[7/9] home, dependencies and migrations\nUpdate prepared: 0.1.7-enpoi.2.84 (stable channel) — nothing was switched or restarted.\n').result).toBeNull()
  })

  it('lets the last result line win and keeps lowercase warnings non-terminal', () => {
    expect(parseRunLog('✗ ERROR: fetch failed\ndsh update FAILED; rolled back to 0.1.7-enpoi.2.81\n').result).toBe('rolledback')
    expect(parseRunLog('  ! WARNING: profile dependency refresh failed\n').result).toBeNull()
  })

  it('caps the tail at 40 lines and survives empty input', () => {
    const many = Array.from({ length: 60 }, (_, index) => `[9/9] line ${String(index)}`).join('\n')
    expect(parseRunLog(many).logTail).toHaveLength(40)
    expect(parseRunLog('').lastLine).toBe('')
    expect(parseRunLog('').step).toBe(0)
  })

  it('reads a bounded window from a real log file and parses the tail', () => {
    const dir = scratch()
    const file = join(dir, 'run.log')
    const noise = Array.from({ length: 200 }, (_, index) => `noise line ${String(index)}`).join('\n')
    writeFileSync(file, `${noise}\n[9/9] self-check\nEnpoi Harness successfully updated!\n`)
    const parsed = readRunLog(file, 512)
    expect(parsed.result).toBe('success')
    expect(parsed.step).toBe(9)
    expect(readRunLog(join(dir, 'missing.log')).lastLine).toBe('')
  })
})

describe('run record persistence and liveness', () => {
  it('round-trips through run.json and rejects malformed documents', () => {
    const dir = scratch()
    const file = runRecordPath(dir)
    const first = record({
      mode: 'apply',
      phase: 'applying',
      step: 8,
      staged: true,
      lastLine: '[8/9] switch, service and backfill',
    })
    expect(writeRunRecord(file, first)).toBe(true)
    expect(readRunRecord(file)).toEqual(first)

    writeFileSync(file, '{"runId": 42}')
    expect(readRunRecord(file)).toBeNull()
    writeFileSync(file, 'not json')
    expect(readRunRecord(file)).toBeNull()
    expect(readRunRecord(join(dir, 'missing.json'))).toBeNull()
  })

  it('compares records for redundant-write suppression', () => {
    expect(sameRunRecord(record(), record())).toBe(true)
    expect(sameRunRecord(record(), record({ step: 3 }))).toBe(false)
  })

  it('reads the wrapper pid file and prefers it over the launch pid', () => {
    const dir = scratch()
    const file = join(dir, 'run.pid')
    writeFileSync(file, ' 12345 \n')
    expect(readRunPid(file)).toBe(12345)
    expect(readRunPid(join(dir, 'missing.pid'))).toBeNull()
    writeFileSync(file, 'nonsense')
    expect(readRunPid(file)).toBeNull()

    const home = scratch()
    const rec = record({ pid: 1 })
    expect(effectivePid(home, rec)).toBe(1)
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(join(home, 'update-check', 'run.pid'), String(process.pid))
    expect(effectivePid(home, rec)).toBe(process.pid)
    expect(isRunActive(home, rec)).toBe(true)
    expect(isRunActive(home, record({ result: 'success' }))).toBe(false)
    expect(isRunActive(home, record({ phase: 'prepared' }))).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('builds terminal and prepared records', () => {
    const at = (): Date => new Date('2026-10-13T12:30:00.000Z')
    const failed = terminalRecord(record({ lastLine: '✗ ERROR: nope' }), 'failed', at, false)
    expect(failed).toMatchObject({ phase: 'failed', result: 'failed', reason: '✗ ERROR: nope', finishedAt: '2026-10-13T12:30:00.000Z' })
    const success = terminalRecord(record({ lastLine: 'Enpoi Harness successfully updated!' }), 'success', at, false)
    expect(success).toMatchObject({ phase: 'success', result: 'success' })
    expect(success.reason).toBeUndefined()
    const prepared = preparedRecord(record({ step: 7 }), at)
    expect(prepared).toMatchObject({ phase: 'prepared', result: null, staged: true, step: 7, finishedAt: '2026-10-13T12:30:00.000Z' })
    expect(prepared.reason).toBeUndefined()
  })
})

describe('reconcileRunRecord', () => {
  it('keeps a live run untouched (the watcher resumes)', () => {
    const home = scratch()
    const live = record({ phase: 'applying', step: 8 })
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(join(home, 'update-check', 'run.pid'), String(process.pid))
    const result = reconcileRunRecord(live, identity('0.1.7-enpoi.2.81'), {
      home,
      prefix: join(home, 'prefix'),
    })
    expect(result.changed).toBe(false)
    expect(result.record).toBe(live)
  })

  it('decodes a terminal log line when the watcher died before reading it', () => {
    const home = scratch()
    const logPath = join(home, 'run.log')
    writeFileSync(logPath, '[9/9] self-check\ndsh update FAILED; rolled back to 0.1.7-enpoi.2.81\n')
    const result = reconcileRunRecord(record({ mode: 'apply', phase: 'applying', logPath }), identity('0.1.7-enpoi.2.81'), {
      home,
      prefix: join(home, 'prefix'),
      now: () => new Date('2026-10-13T12:30:00.000Z'),
    })
    expect(result.changed).toBe(true)
    expect(result.record).toMatchObject({ result: 'rolledback', phase: 'rolledback', lastLine: expect.stringContaining('rolled back') })
  })

  it('keeps a prepared record while its staged marker exists (survives restarts)', () => {
    const home = scratch()
    const root = { home, prefix: join(home, 'prefix') }
    stageMarker(home)
    const prepared = record({ phase: 'prepared', staged: true, step: 7 })
    const result = reconcileRunRecord(prepared, identity('0.1.7-enpoi.2.81'), root)
    expect(result.changed).toBe(false)
    expect(result.record).toBe(prepared)
  })

  it('fails a prepared record whose staged marker disappeared before apply', () => {
    const home = scratch()
    const prepared = record({ phase: 'prepared', staged: true })
    const result = reconcileRunRecord(prepared, identity('0.1.7-enpoi.2.81'), {
      home,
      prefix: join(home, 'prefix'),
      now: () => new Date('2026-10-13T12:30:00.000Z'),
    })
    expect(result.changed).toBe(true)
    expect(result.record).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(result.record.reason).toContain('does not match the target')
  })

  it('promotes a dead prepare that did stage the tree to prepared', () => {
    const home = scratch()
    const logPath = join(home, 'run.log')
    writeFileSync(logPath, '[7/9] home, dependencies and migrations\n')
    stageMarker(home)
    const result = reconcileRunRecord(record({ phase: 'preparing', logPath }), identity('0.1.7-enpoi.2.81'), {
      home,
      prefix: join(home, 'prefix'),
      now: () => new Date('2026-10-13T12:30:00.000Z'),
    })
    expect(result.changed).toBe(true)
    expect(result.record).toMatchObject({ phase: 'prepared', result: null, staged: true, lastLine: '[7/9] home, dependencies and migrations' })
  })

  it('marks success when the version reached the target (prepare or apply died before its line)', () => {
    const home = scratch()
    const result = reconcileRunRecord(
      record({ mode: 'apply', phase: 'applying', step: 9 }),
      identity('0.1.7-enpoi.2.84'),
      { home, prefix: join(home, 'prefix'), now: () => new Date('2026-10-13T12:30:00.000Z') },
    )
    expect(result.changed).toBe(true)
    expect(result.record).toMatchObject({ result: 'success', phase: 'success', finishedAt: '2026-10-13T12:30:00.000Z' })
  })

  it('marks a failed prepare with a clear reason when nothing staged and the version is old', async () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(join(home, 'update-check', 'run.pid'), String(await deadPid()))
    const { record: reconciled, changed } = reconcileRunRecord(
      record({ phase: 'preparing', step: 4, lastLine: '[4/9] dependencies and build' }),
      identity('0.1.7-enpoi.2.81'),
      { home, prefix: join(home, 'prefix'), now: () => new Date('2026-10-13T12:30:00.000Z') },
    )
    expect(changed).toBe(true)
    expect(reconciled).toMatchObject({ result: 'failed', phase: 'failed' })
    expect(reconciled.reason).toContain('the prepare run is no longer running')
    expect(reconciled.reason).toContain('0.1.7-enpoi.2.81')
    expect(reconciled.reason).toContain('0.1.7-enpoi.2.84')
  })

  it('marks a failed apply when the version never reached the target', async () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(join(home, 'update-check', 'run.pid'), String(await deadPid()))
    const { record: reconciled } = reconcileRunRecord(
      record({ mode: 'apply', phase: 'applying', step: 8 }),
      identity('0.1.7-enpoi.2.81'),
      { home, prefix: join(home, 'prefix'), now: () => new Date('2026-10-13T12:30:00.000Z') },
    )
    expect(reconciled.result).toBe('failed')
    expect(reconciled.reason).toContain('the apply run is no longer running')
  })

  it('is idempotent on a terminal record', () => {
    const terminal = record({ result: 'rolledback', phase: 'rolledback', reason: 'rolled back' })
    const { record: again, changed } = reconcileRunRecord(terminal, identity('0.1.7-enpoi.2.81'), {
      home: scratch(),
      prefix: scratch(),
    })
    expect(changed).toBe(false)
    expect(again).toBe(terminal)
  })

  it('reports an unknown install version verbatim', async () => {
    const home = scratch()
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(join(home, 'update-check', 'run.pid'), String(await deadPid()))
    const { record: reconciled } = reconcileRunRecord(record(), identity(''), { home, prefix: join(home, 'prefix') })
    expect(reconciled.result).toBe('failed')
    expect(reconciled.reason).toContain('unknown')
  })
})
