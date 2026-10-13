/**
 * Simulated end-to-end: a fake updater script driven through the REAL launch
 * ladder (the final detached `sh` rung) and the REAL watcher on a scratch
 * home. Proves start → progress → terminal in run.json without ever running
 * the real updater and without touching the live `~/.dsh` profile.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readRunRecord, runLogPath, runRecordPath, type UpdateRunRecord } from '../src/run.js'
import { UpdateRunController } from '../src/run-service.js'
import type { UpdateCheckStatus } from '../src/service.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-e2e-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

function status(version = '0.1.7-enpoi.2.84'): UpdateCheckStatus {
  return {
    state: 'available',
    current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
    latest: { version, commit: 'def5678', releasedAt: '2026-10-13T12:00:00.000Z', notes: ['feat(update): x'] },
  }
}

/** Stage a scratch install: a fake `dsh` shim plus the state file naming its binDir. */
function stageShim(home: string, body: string): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(home, 'harness'), { recursive: true })
  const shim = join(bin, 'dsh')
  writeFileSync(shim, `#!/bin/sh\nset -u\n${body}\n`)
  chmodSync(shim, 0o755)
  writeFileSync(
    join(home, 'harness', 'install-state.json'),
    JSON.stringify({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234', binDir: bin }),
  )
  return shim
}

async function waitForTerminal(controller: UpdateRunController, timeoutMs = 15_000): Promise<UpdateRunRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = controller.run()
    if (record !== null && record.result !== null) return record
    if (Date.now() > deadline) {
      throw new Error(`run did not finish; last record: ${JSON.stringify(record)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

function e2eController(home: string): UpdateRunController {
  return new UpdateRunController({
    home,
    readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' }),
    readStatus: () => status(),
    // The real ladder with every optional rung reported absent: the final
    // detached `sh` spawn is the everywhere-fallback the launcher ships.
    hasCommand: () => false,
    pollIntervalMs: 50,
  })
}

const stepLines = [
  'echo "[1/9] environment: existing install under $DSH_HOME"',
  'echo "  ✓ cli found"',
  'echo "[2/9] source: stable channel archive"',
  'echo "[3/9] pnpm: corepack"',
  'echo "[4/9] dependencies and build: prebuilt release (no local build)"',
  'echo "  ! WARNING: telemetry endpoint unreachable"',
  'echo "[5/9] transport: full prebuilt install (unpack + atomic switch)"',
  'echo "[6/9] profile: web"',
  'echo "[7/9] home, dependencies and migrations"',
  'echo "[8/9] switch, service and backfill"',
  'echo "  ✓ current → 0.1.7-enpoi.2.84"',
  'echo "[9/9] self-check"',
  'echo "  ✓ self-check passed"',
].join('\n')

describe('simulated update run (fake updater, real launcher + watcher)', () => {
  it('start → progress → terminal success in run.json', async () => {
    const home = scratch()
    const shim = stageShim(home, `${stepLines}\necho "Enpoi Harness successfully updated!"`)
    const controller = e2eController(home)
    const started = controller.start()
    expect(started.target).toBe('0.1.7-enpoi.2.84')
    expect(started.result).toBeNull()
    expect(started.logPath).toBe(runLogPath(home))

    const done = await waitForTerminal(controller)
    controller.dispose()

    expect(done).toMatchObject({ result: 'success', phase: 'done', step: 9, steps: 9, rung: 'spawn' })
    expect(done.finishedAt).toBeDefined()
    expect(done.pid).toBeGreaterThan(0)
    expect(done.logTail.at(-1)).toBe('Enpoi Harness successfully updated!')
    expect(done.logTail.some(line => line.includes('[5/9] transport'))).toBe(true)
    expect(done.logTail.some(line => line.includes('! WARNING'))).toBe(true)

    // The persisted record is the same one the Remote serves, and the shim
    // was really invoked (the scratch `binDir/dsh` ran with `update`).
    const persisted = readRunRecord(runRecordPath(home))!
    expect(persisted).toEqual(done)
    expect(readFileSync(runLogPath(home), 'utf8')).toContain('[1/9] environment')
    expect(shim).toBe(join(home, 'bin', 'dsh'))
  })

  it('reports a rollback from the engine failure line', async () => {
    const home = scratch()
    stageShim(home, `${stepLines}\necho "dsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)"\nexit 1`)
    const controller = e2eController(home)
    controller.start()
    const done = await waitForTerminal(controller)
    controller.dispose()
    expect(done).toMatchObject({ result: 'rolledback', phase: 'rolledback' })
    expect(done.reason).toContain('rolled back')
    expect(done.logTail.at(-1)).toContain('rolled back')
  })

  it('reports a hard failure from the engine error line', async () => {
    const home = scratch()
    stageShim(home, 'echo "[2/9] source: stable channel archive"\necho "✗ ERROR: no install state at $DSH_HOME/harness/install-state.json"\nexit 1')
    const controller = e2eController(home)
    controller.start()
    const done = await waitForTerminal(controller)
    controller.dispose()
    expect(done).toMatchObject({ result: 'failed', phase: 'failed', step: 2 })
    expect(done.reason).toContain('no install state')
    expect(readRunRecord(runRecordPath(home))?.result).toBe('failed')
  })

  it('reports a silent exit as a failure with the exit reason', async () => {
    const home = scratch()
    stageShim(home, 'echo "[2/9] source: stable channel archive"\nexit 1')
    const controller = e2eController(home)
    controller.start()
    const done = await waitForTerminal(controller)
    controller.dispose()
    expect(done).toMatchObject({ result: 'failed', phase: 'failed', step: 2 })
    expect(done.reason).toContain('exited before reporting a result')
  })
})
