/**
 * Simulated end-to-end: a fake updater driven through the REAL launch ladder
 * (the final detached `sh` rung) and the REAL watcher on a scratch install.
 * Proves the environment ladder (an `env -i`-style base environment fails
 * with one clear reason and succeeds once the prefix runtime exists) and the
 * two-phase flow (prepare → prepared → apply → success/rolledback) in
 * run.json, without ever running the real updater or touching `~/.dsh`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { hasStagedApply, readRunRecord, runLogPath, runRecordPath, stagedApplyPath, type UpdateRunRecord } from '../src/run.js'
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

/** Stage a scratch install: a fake `dsh` shim plus the state file naming its binDir/prefix. */
function stageInstall(home: string, shimBody: string): string {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(home, 'harness'), { recursive: true })
  const shim = join(bin, 'dsh')
  writeFileSync(shim, `#!/bin/sh\nset -u\n${shimBody}\n`)
  chmodSync(shim, 0o755)
  writeFileSync(
    join(home, 'harness', 'install-state.json'),
    JSON.stringify({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234', binDir: bin, prefix: home }),
  )
  return shim
}

/** Stage the recorded runtime the probe prefers, with a `node` stub good enough for `command -v`. */
function stageRuntime(home: string): string {
  const bin = join(home, 'runtime', 'node', 'current', 'bin')
  mkdirSync(bin, { recursive: true })
  const node = join(bin, 'node')
  writeFileSync(node, '#!/bin/sh\nexit 0\n')
  chmodSync(node, 0o755)
  return node
}

/** The two-phase fake updater: refuses to run without node on PATH. */
const PHASED_SHIM = [
  'command -v node >/dev/null || { echo "✗ ERROR: no usable Node.js found for the update"; exit 1; }',
  'mode=update',
  'for arg in "$@"; do case "$arg" in --prepare) mode=prepare;; --apply) mode=apply;; esac; done',
  'if [ "$mode" = "prepare" ]; then',
  '  echo "[1/9] environment: existing install under $DSH_HOME"',
  '  echo "  ✓ cli found"',
  '  echo "[4/9] dependencies and build: prebuilt release (no local build)"',
  '  echo "  ! WARNING: telemetry endpoint unreachable"',
  '  echo "[7/9] home, dependencies and migrations"',
  '  mkdir -p "$PREFIX/harness"',
  '  printf \'{"version":"0.1.7-enpoi.2.84","treeDirName":"0.1.7-enpoi.2.84","channel":"stable","preparedAt":"2026-10-13T12:00:00Z"}\\n\' > "$PREFIX/harness/.staged-apply.json"',
  '  exit 0',
  'fi',
  'if [ "$mode" = "apply" ]; then',
  '  echo "[8/9] switch, service and backfill"',
  '  echo "  ✓ current → 0.1.7-enpoi.2.84"',
  '  echo "[9/9] self-check"',
  '  echo "  ✓ self-check passed"',
  '  echo "Enpoi Harness successfully updated!"',
  '  rm -f "$PREFIX/harness/.staged-apply.json"',
  '  exit 0',
  'fi',
  'echo "[1/9] environment"; exit 0',
].join('\n')

async function waitForRecord(
  controller: UpdateRunController,
  match: (record: UpdateRunRecord | null) => boolean,
  timeoutMs = 15_000,
): Promise<UpdateRunRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = controller.run()
    if (match(record)) return record!
    if (Date.now() > deadline) {
      throw new Error(`run did not reach the expected state; last record: ${JSON.stringify(record)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

function e2eController(home: string, baseEnv: NodeJS.ProcessEnv): UpdateRunController {
  return new UpdateRunController({
    home,
    readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' }),
    readStatus: () => status(),
    // The real ladder with every optional rung reported absent: the final
    // detached `sh` spawn is the everywhere-fallback the launcher ships.
    hasCommand: () => false,
    baseEnv,
    probeHomeDir: join(home, 'probe-home'),
    pollIntervalMs: 50,
  })
}

describe('launch environment on a scratch install', () => {
  it('fails the run with one clear reason when no runtime resolves (env -i style)', () => {
    const home = scratch()
    stageInstall(home, PHASED_SHIM)
    const controller = e2eController(home, {})
    expect(() => controller.start()).toThrowError(/no Node.js runtime found for the updater/)
    const persisted = readRunRecord(runRecordPath(home))!
    expect(persisted.result).toBe('failed')
    expect(persisted.reason).toContain('no Node.js runtime found for the updater')
    expect(persisted.reason).toContain(join(home, 'runtime', 'node', 'current', 'bin'))
    // Nothing ever reached the shim: no cryptic engine line in the log.
    expect(readFileSync(runLogPath(home), 'utf8')).toBe('')
    controller.dispose()
  })

  it('runs the same scratch install once the recorded prefix runtime exists', async () => {
    const home = scratch()
    stageInstall(home, PHASED_SHIM)
    stageRuntime(home)
    const controller = e2eController(home, {})
    const started = controller.start()
    expect(started.mode).toBe('prepare')
    const prepared = await waitForRecord(controller, record => record?.phase === 'prepared')
    controller.dispose()
    expect(prepared).toMatchObject({ result: null, staged: true, step: 7, mode: 'prepare' })
    expect(prepared.lastLine).toBe('[7/9] home, dependencies and migrations')
    expect(hasStagedApply(home)).toBe(true)
    expect(readFileSync(runLogPath(home), 'utf8')).toContain('[1/9] environment')
  })
})

describe('simulated two-phase update (fake updater, real launcher + watcher)', () => {
  it('prepare → prepared → apply → success in run.json', async () => {
    const home = scratch()
    stageInstall(home, PHASED_SHIM)
    stageRuntime(home)
    const phases: string[] = []
    const controller = new UpdateRunController({
      home,
      readIdentity: () => ({ channel: 'stable', version: '0.1.7-enpoi.2.81', commit: 'abc1234' }),
      readStatus: () => status(),
      hasCommand: () => false,
      baseEnv: {},
      probeHomeDir: join(home, 'probe-home'),
      pollIntervalMs: 50,
      onUpdate: record => { phases.push(record.phase) },
    })
    controller.start()
    await waitForRecord(controller, record => record?.phase === 'prepared')
    const applied = controller.apply()
    expect(applied).toMatchObject({ mode: 'apply', phase: 'applying', target: '0.1.7-enpoi.2.84' })
    const done = await waitForRecord(controller, record => record?.result !== null)
    controller.dispose()

    expect(done).toMatchObject({ result: 'success', phase: 'success', step: 9, mode: 'apply' })
    expect(done.logTail).toContain('Enpoi Harness successfully updated!')
    expect(done.logTail.some(line => line.includes('[8/9] switch'))).toBe(true)
    expect(hasStagedApply(home)).toBe(false)
    // Every phase the two-phase contract names was observed in order.
    expect(phases).toContain('starting')
    expect(phases).toContain('preparing')
    expect(phases).toContain('prepared')
    expect(phases).toContain('applying')
    expect(phases).toContain('success')
    expect(phases.indexOf('prepared')).toBeLessThan(phases.indexOf('applying'))
    const persisted = readRunRecord(runRecordPath(home))!
    expect(persisted).toEqual(done)
  })

  it('apply → rolledback from the engine rollback line, marker kept for Retry', async () => {
    const home = scratch()
    stageInstall(home, [
      'command -v node >/dev/null || { echo "✗ ERROR: no usable Node.js found for the update"; exit 1; }',
      'for arg in "$@"; do case "$arg" in --apply) mode=apply;; esac; done',
      'echo "[8/9] switch, service and backfill"',
      'echo "  ✓ current → 0.1.7-enpoi.2.84"',
      'echo "[9/9] self-check"',
      'echo "  ✗ self-check failed"',
      'echo "dsh update FAILED; rolled back to 0.1.7-enpoi.2.81 (previous tree self-check: ok)"',
      'exit 1',
    ].join('\n'))
    stageRuntime(home)
    // A prepared record already staged (the restart-after-prepare case).
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(stagedApplyPath(home), JSON.stringify({ version: '0.1.7-enpoi.2.84' }))
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'run-prep', target: '0.1.7-enpoi.2.84', channel: 'stable', mode: 'prepare', phase: 'prepared',
      step: 7, steps: 9, lastLine: '[7/9] home, dependencies and migrations', startedAt: new Date().toISOString(),
      pid: null, logPath: runLogPath(home), result: null, rung: 'spawn', staged: true, logTail: [],
    })}\n`)
    const controller = e2eController(home, {})
    controller.apply()
    const done = await waitForRecord(controller, record => record?.result !== null)
    controller.dispose()
    expect(done).toMatchObject({ result: 'rolledback', phase: 'rolledback' })
    expect(done.reason).toContain('rolled back')
    expect(hasStagedApply(home)).toBe(true)
  })

  it('apply → failed when the updater dies without a terminal line', async () => {
    const home = scratch()
    stageInstall(home, [
      'command -v node >/dev/null || { echo "✗ ERROR: no usable Node.js found for the update"; exit 1; }',
      'echo "[8/9] switch, service and backfill"',
      'exit 1',
    ].join('\n'))
    stageRuntime(home)
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(stagedApplyPath(home), JSON.stringify({ version: '0.1.7-enpoi.2.84' }))
    mkdirSync(join(home, 'update-check'), { recursive: true })
    writeFileSync(runRecordPath(home), `${JSON.stringify({
      runId: 'run-prep', target: '0.1.7-enpoi.2.84', channel: 'stable', mode: 'prepare', phase: 'prepared',
      step: 7, steps: 9, lastLine: '[7/9] home, dependencies and migrations', startedAt: new Date().toISOString(),
      pid: null, logPath: runLogPath(home), result: null, rung: 'spawn', staged: true, logTail: [],
    })}\n`)
    const controller = e2eController(home, {})
    controller.apply()
    const done = await waitForRecord(controller, record => record?.result !== null)
    controller.dispose()
    expect(done).toMatchObject({ result: 'failed', phase: 'failed', step: 8 })
    expect(done.reason).toContain('the apply run exited before reporting a result')
  })
})
