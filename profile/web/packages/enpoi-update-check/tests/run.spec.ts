/**
 * Run record, log parser, and restart reconcile: the `[N/9]` step bands, the
 * terminal result lines, the bounded tail, and the three reconcile outcomes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { InstallIdentity } from '../src/catalog.js'
import {
  effectivePid,
  isProcessAlive,
  isRunActive,
  parseRunLog,
  phaseForResult,
  phaseForStep,
  readRunLog,
  readRunPid,
  readRunRecord,
  reconcileRunRecord,
  resultFromLine,
  runPidPath,
  runRecordPath,
  sameRunRecord,
  STEP_PHASES,
  targetReached,
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
    phase: 'starting',
    step: 0,
    steps: 9,
    lastLine: '',
    startedAt: '2026-10-13T12:00:00.000Z',
    pid: 4242,
    logPath: '/nonexistent/run.log',
    result: null,
    rung: 'setsid',
    logTail: [],
    ...overrides,
  }
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

describe('step bands and terminal phases', () => {
  it('maps every 1-based step to its documented phase band', () => {
    expect(STEP_PHASES).toHaveLength(9)
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(step => phaseForStep(step))).toEqual([
      'fetch', 'fetch', 'verify', 'unpack', 'deps', 'profile', 'profile', 'switch', 'selfcheck',
    ])
    // Before any marker and out-of-range values degrade safely.
    expect(phaseForStep(0)).toBe('starting')
    expect(phaseForStep(-4)).toBe('starting')
    expect(phaseForStep(99)).toBe('selfcheck')
  })

  it('mirrors results onto their terminal phases', () => {
    expect(phaseForResult('success')).toBe('done')
    expect(phaseForResult('failed')).toBe('failed')
    expect(phaseForResult('rolledback')).toBe('rolledback')
  })
})

describe('parseRunLog', () => {
  it('reads step markers, the last line, and the bounded tail', () => {
    const parsed = parseRunLog([
      '\u001b[1m[1/9]\u001b[0m environment: existing install under /home/dsh',
      '  \u001b[32m✓\u001b[0m cli found',
      '[2/9] source: stable channel archive',
      '[4/9] dependencies and build: prebuilt release (no local build)',
      '  ! WARNING: profile dependency refresh failed',
    ].join('\n'))
    expect(parsed.step).toBe(4)
    expect(parsed.steps).toBe(9)
    expect(parsed.phase).toBe('unpack')
    expect(parsed.result).toBeNull()
    expect(parsed.lastLine).toBe('  ! WARNING: profile dependency refresh failed')
    expect(parsed.logTail).toHaveLength(5)
    // ANSI codes are stripped from every retained line.
    expect(parsed.logTail[0]).toBe('[1/9] environment: existing install under /home/dsh')
  })

  it('keeps the highest step and ignores a later lower marker', () => {
    const parsed = parseRunLog('[5/9] transport\n[3/9] stale banner\n')
    expect(parsed.step).toBe(5)
    expect(parsed.phase).toBe('deps')
  })

  it.each([
    ['Enpoi Harness successfully updated!', 'success'],
    ['dsh is already up to date: 0.1.7-enpoi.2.84 (stable channel)', 'success'],
    ['dsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)', 'rolledback'],
    ['✗ ERROR: no install state at /home/dsh/harness/install-state.json', 'failed'],
    ['dsh update FAILED; rolled back to x, but the user-file restore did NOT complete.', 'rolledback'],
  ] as const)('classifies %j as %s', (line, result) => {
    expect(resultFromLine(line)).toBe(result)
    const parsed = parseRunLog(`[9/9] self-check\n${line}\n`)
    expect(parsed.result).toBe(result)
    expect(parsed.phase).toBe(phaseForResult(result))
  })

  it('lets the last result line win', () => {
    const parsed = parseRunLog('✗ ERROR: fetch failed\ndsh update FAILED; rolled back to 0.1.7-enpoi.2.81\n')
    expect(parsed.result).toBe('rolledback')
  })

  it('caps the tail at 40 lines and survives empty input', () => {
    const many = Array.from({ length: 60 }, (_, index) => `[9/9] line ${String(index)}`).join('\n')
    expect(parseRunLog(many).logTail).toHaveLength(40)
    expect(parseRunLog('').lastLine).toBe('')
    expect(parseRunLog('').phase).toBe('starting')
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

describe('run record persistence', () => {
  it('round-trips through run.json and rejects malformed documents', () => {
    const dir = scratch()
    const file = runRecordPath(dir)
    const first = record({ phase: 'switch', step: 8, lastLine: 'switch: current → 0.1.7-enpoi.2.84' })
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

  it('reads the wrapper pid file', () => {
    const dir = scratch()
    const file = join(dir, 'run.pid')
    writeFileSync(file, ' 12345 \n')
    expect(readRunPid(file)).toBe(12345)
    expect(readRunPid(join(dir, 'missing.pid'))).toBeNull()
    writeFileSync(file, 'nonsense')
    expect(readRunPid(file)).toBeNull()
  })

  it('prefers the wrapper pid over the launcher pid and judges liveness by it', () => {
    const dir = scratch()
    const rec = record({ pid: 1 })
    expect(effectivePid(dir, rec)).toBe(1)
    mkdirSync(join(dir, 'update-check'), { recursive: true })
    writeFileSync(runPidPath(dir), String(process.pid))
    expect(effectivePid(dir, rec)).toBe(process.pid)
    expect(isRunActive(dir, rec)).toBe(true)
    expect(isRunActive(dir, record({ result: 'success' }))).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})

describe('reconcileRunRecord', () => {
  it('marks success when the install version already reached the target', () => {
    const dir = scratch()
    const { record: reconciled, changed } = reconcileRunRecord(
      record({ phase: 'switch', step: 8 }),
      identity('0.1.7-enpoi.2.84'),
      () => new Date('2026-10-13T12:30:00.000Z'),
      dir,
    )
    expect(changed).toBe(true)
    expect(reconciled.result).toBe('success')
    expect(reconciled.phase).toBe('done')
    expect(reconciled.finishedAt).toBe('2026-10-13T12:30:00.000Z')
    expect(reconciled.logTail).toEqual([])
  })

  it('keeps a live run untouched (the watcher resumes)', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'update-check'), { recursive: true })
    writeFileSync(runPidPath(dir), String(process.pid))
    const live = record({ phase: 'deps', step: 4 })
    const result = reconcileRunRecord(live, identity('0.1.7-enpoi.2.81'), () => new Date(), dir)
    expect(result.changed).toBe(false)
    expect(result.record).toBe(live)
  })

  it('marks failed with a clear reason when the version never reached the target', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'update-check'), { recursive: true })
    writeFileSync(runPidPath(dir), String(await deadPid()))
    const { record: reconciled, changed } = reconcileRunRecord(
      record({ phase: 'deps', step: 4, lastLine: '[4/9] dependencies and build' }),
      identity('0.1.7-enpoi.2.81'),
      () => new Date('2026-10-13T12:30:00.000Z'),
      dir,
    )
    expect(changed).toBe(true)
    expect(reconciled.result).toBe('failed')
    expect(reconciled.phase).toBe('failed')
    expect(reconciled.reason).toContain('0.1.7-enpoi.2.81')
    expect(reconciled.reason).toContain('0.1.7-enpoi.2.84')
    expect(reconciled.lastLine).toBe('[4/9] dependencies and build')
  })

  it('is idempotent on a terminal record', () => {
    const terminal = record({ result: 'rolledback', phase: 'rolledback', reason: 'rolled back' })
    const { record: again, changed } = reconcileRunRecord(terminal, identity('0.1.7-enpoi.2.81'), () => new Date(), scratch())
    expect(changed).toBe(false)
    expect(again).toBe(terminal)
  })

  it('reports an unknown install version verbatim', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'update-check'), { recursive: true })
    writeFileSync(runPidPath(dir), String(await deadPid()))
    const { record: reconciled } = reconcileRunRecord(record(), identity(''), () => new Date(), dir)
    expect(reconciled.result).toBe('failed')
    expect(reconciled.reason).toContain('unknown')
  })
})

describe('targetReached', () => {
  it('orders comparable versions and refuses unusable ones', () => {
    expect(targetReached('0.1.7-enpoi.2.84', '0.1.7-enpoi.2.84')).toBe(true)
    expect(targetReached('0.1.7-enpoi.2.90', '0.1.7-enpoi.2.84')).toBe(true)
    expect(targetReached('0.1.7-enpoi.2.81', '0.1.7-enpoi.2.84')).toBe(false)
    expect(targetReached('', '0.1.7-enpoi.2.84')).toBeNull()
  })
})
