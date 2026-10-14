/**
 * The engine run marker: parsing, zombie-aware liveness, and the observed
 * record synthesis (mode mapping, phase mapping, log tail, staged marker).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  isMarkerLive,
  isProcessLive,
  markerProgressAge,
  modeFromMarker,
  observedRecordFromMarker,
  phaseFromMarker,
  readRunMarker,
  resultFromMarkerPhase,
  runMarkerPath,
  type EngineRunMarker,
} from '../src/marker.js'
import { stagedApplyPath } from '../src/run.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-marker-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => { child.on('exit', () => { resolve() }) })
  return pid
}

function marker(overrides: Partial<EngineRunMarker> = {}): EngineRunMarker {
  return {
    runId: '1750000000-4242',
    pid: process.pid,
    mode: 'plain',
    step: 3,
    steps: 9,
    phase: 'running',
    startedAt: '2026-10-13T12:00:00Z',
    logPath: '',
    version: '',
    target: '',
    ...overrides,
  }
}

/** Write a raw marker document under `<prefix>/harness`. */
function writeMarker(prefix: string, document: unknown): void {
  mkdirSync(join(prefix, 'harness'), { recursive: true })
  writeFileSync(runMarkerPath(prefix), typeof document === 'string' ? document : JSON.stringify(document))
}

describe('readRunMarker', () => {
  it('parses a complete marker document', () => {
    const prefix = scratch()
    writeMarker(prefix, {
      runId: '1750000000-99',
      pid: 99,
      mode: 'prepare',
      step: 7,
      steps: 9,
      phase: 'running',
      startedAt: '2026-10-13T12:00:00Z',
      logPath: '/x/install.log',
      version: '',
      target: '0.1.7-enpoi.2.84',
    })
    expect(readRunMarker(prefix)).toEqual({
      runId: '1750000000-99',
      pid: 99,
      mode: 'prepare',
      step: 7,
      steps: 9,
      phase: 'running',
      startedAt: '2026-10-13T12:00:00Z',
      logPath: '/x/install.log',
      version: '',
      target: '0.1.7-enpoi.2.84',
    })
  })

  it('returns null for absent, malformed, or unknown-mode documents', () => {
    const prefix = scratch()
    expect(readRunMarker(prefix)).toBeNull()
    writeMarker(prefix, 'not json')
    expect(readRunMarker(prefix)).toBeNull()
    writeMarker(prefix, { runId: 'x' })
    expect(readRunMarker(prefix)).toBeNull()
    writeMarker(prefix, { runId: 'x', pid: 1, mode: 'wat', phase: 'running' })
    expect(readRunMarker(prefix)).toBeNull()
    writeMarker(prefix, { runId: 'x', pid: 1, mode: 'plain', phase: 'wat' })
    expect(readRunMarker(prefix)).toBeNull()
  })
})

describe('liveness and mappings', () => {
  it('detects live and dead pids, zombie-aware on linux', async () => {
    expect(isProcessLive(process.pid)).toBe(true)
    expect(isProcessLive(await deadPid())).toBe(false)
    if (process.platform === 'linux') expect(isProcessLive(process.pid, 'linux')).toBe(true)
  })

  it('maps marker modes, phases, and results', () => {
    expect(modeFromMarker('plain')).toBe('one-shot')
    expect(modeFromMarker('one-shot')).toBe('one-shot')
    expect(modeFromMarker('prepare')).toBe('prepare')
    expect(modeFromMarker('apply')).toBe('apply')
    expect(phaseFromMarker('running')).toBe('preparing')
    expect(phaseFromMarker('switching')).toBe('applying')
    expect(phaseFromMarker('applying')).toBe('applying')
    expect(phaseFromMarker('done')).toBe('success')
    expect(phaseFromMarker('failed')).toBe('failed')
    expect(phaseFromMarker('rolledback')).toBe('rolledback')
    expect(phaseFromMarker('cancelled')).toBe('cancelled')
    expect(resultFromMarkerPhase('running')).toBeNull()
    expect(resultFromMarkerPhase('switching')).toBeNull()
    expect(resultFromMarkerPhase('done')).toBe('success')
    expect(resultFromMarkerPhase('cancelled')).toBe('cancelled')
  })

  it('judges marker liveness by pid', async () => {
    expect(isMarkerLive(marker(), () => true)).toBe(true)
    expect(isMarkerLive(marker({ pid: await deadPid() }))).toBe(false)
    expect(isMarkerLive(marker({ pid: 0 }), () => true)).toBe(false)
  })

  it('never treats a terminal phase as live, even with a live recycled pid', () => {
    for (const phase of ['done', 'failed', 'rolledback', 'cancelled'] as const) {
      expect(isMarkerLive(marker({ phase }), () => true), phase).toBe(false)
    }
  })

  it('treats a stalled marker as not live once the evidence is available', () => {
    expect(isMarkerLive(marker(), () => true, { progressAgeMs: 1_000 })).toBe(true)
    expect(isMarkerLive(marker(), () => true, { progressAgeMs: 10 * 60_000 })).toBe(false)
    // No evidence (undefined) never counts as stalled.
    expect(isMarkerLive(marker(), () => true, { progressAgeMs: undefined })).toBe(true)
    expect(isMarkerLive(marker(), () => true, { progressAgeMs: 10 * 60_000, staleWindowMs: 60 * 60_000 })).toBe(true)
  })

  it('measures the marker/log progress age, with null for missing evidence', () => {
    const prefix = scratch()
    mkdirSync(join(prefix, 'harness'), { recursive: true })
    const logPath = join(prefix, 'install.log')
    writeFileSync(logPath, 'x')
    writeFileSync(runMarkerPath(prefix), JSON.stringify(marker({ logPath })))
    const now = Date.now()
    const fresh = markerProgressAge(marker({ logPath }), prefix, now)
    expect(fresh).not.toBeNull()
    expect(fresh!).toBeLessThan(5_000)
    // A marker with no readable files has no evidence.
    const empty = scratch()
    expect(markerProgressAge(marker({ logPath: '' }), empty, now)).toBeNull()
  })
})

describe('observedRecordFromMarker', () => {
  it('synthesizes a one-shot-style executing record from a plain marker', () => {
    const prefix = scratch()
    mkdirSync(join(prefix, 'harness'), { recursive: true })
    const logPath = join(prefix, 'install.log')
    writeFileSync(logPath, '[8/9] switch, service and backfill\nswitching current\n')
    const record = observedRecordFromMarker(
      marker({ mode: 'plain', step: 8, logPath, target: '0.1.7-enpoi.2.84' }),
      { prefix, channel: 'stable' },
    )
    expect(record).toMatchObject({
      runId: '1750000000-4242',
      target: '0.1.7-enpoi.2.84',
      channel: 'stable',
      mode: 'one-shot',
      rung: 'one-shot',
      phase: 'preparing',
      step: 8,
      steps: 9,
      pid: process.pid,
      launcher: 'external',
      observed: true,
      result: null,
    })
    expect(record.lastLine).toBe('switching current')
    expect(record.logTail).toContain('[8/9] switch, service and backfill')
  })

  it('maps a two-phase prepare marker with the staged tree state', () => {
    const prefix = scratch()
    writeMarker(prefix, marker({ mode: 'prepare', phase: 'running', step: 7 }))
    // `staged` means a complete staged update: record plus tree witness.
    mkdirSync(join(prefix, 'harness', '0.1.7-enpoi.2.84'), { recursive: true })
    writeFileSync(join(prefix, 'harness', '0.1.7-enpoi.2.84', '.dsh-install-complete'), '{}\n')
    writeFileSync(stagedApplyPath(prefix), JSON.stringify({
      version: '0.1.7-enpoi.2.84', treeDirName: '0.1.7-enpoi.2.84', channel: 'beta', preparedAt: '2026-10-13T12:00:00Z',
    }))
    const record = observedRecordFromMarker(marker({ mode: 'prepare', phase: 'running', step: 7 }), {
      prefix,
      channel: 'beta',
      readLog: () => ({ lastLine: '[7/9] home, dependencies and migrations', logTail: ['[7/9] home, dependencies and migrations'] }),
    })
    expect(record).toMatchObject({
      mode: 'prepare',
      rung: 'two-phase',
      phase: 'preparing',
      channel: 'beta',
      staged: true,
    })
    expect(record.lastLine).toBe('[7/9] home, dependencies and migrations')
  })

  it('reports staged false when the marker survives but its tree was archived', () => {
    const prefix = scratch()
    mkdirSync(join(prefix, 'harness'), { recursive: true })
    writeFileSync(stagedApplyPath(prefix), JSON.stringify({
      version: '0.1.7-enpoi.2.84', treeDirName: '0.1.7-enpoi.2.84', channel: 'beta', preparedAt: '2026-10-13T12:00:00Z',
    }))
    const record = observedRecordFromMarker(marker({ mode: 'apply', phase: 'rolledback' }), {
      prefix,
      channel: 'beta',
      readLog: () => ({ lastLine: '', logTail: [] }),
    })
    expect(record).toMatchObject({ result: 'rolledback', staged: false })
  })

  it('maps switching/applying to the applying phase and terminal phases to results', () => {
    const prefix = scratch()
    const input = { prefix, channel: 'stable', readLog: () => ({ lastLine: 'line', logTail: ['line'] }) }
    expect(observedRecordFromMarker(marker({ mode: 'apply', phase: 'switching', step: 8 }), input)).toMatchObject({
      mode: 'apply', phase: 'applying', step: 8,
    })
    expect(observedRecordFromMarker(marker({ mode: 'apply', phase: 'applying', step: 9 }), input)).toMatchObject({
      phase: 'applying', result: null,
    })
    expect(observedRecordFromMarker(marker({ mode: 'plain', phase: 'done', step: 9 }), input)).toMatchObject({
      phase: 'success', result: 'success',
    })
    expect(observedRecordFromMarker(marker({ mode: 'plain', phase: 'failed', step: 4 }), input)).toMatchObject({
      phase: 'failed', result: 'failed', reason: 'line',
    })
    expect(observedRecordFromMarker(marker({ mode: 'plain', phase: 'rolledback', step: 9 }), input)).toMatchObject({
      phase: 'rolledback', result: 'rolledback',
    })
    expect(observedRecordFromMarker(marker({ mode: 'plain', phase: 'cancelled', step: 4 }), input)).toMatchObject({
      phase: 'cancelled', result: 'cancelled',
    })
  })

  it('defaults steps and tolerates an empty log path', () => {
    const prefix = scratch()
    const record = observedRecordFromMarker(marker({ steps: 0, logPath: '' }), { prefix, channel: 'stable' })
    expect(record.steps).toBe(9)
    expect(record.lastLine).toBe('')
    expect(record.logTail).toEqual([])
  })
})
