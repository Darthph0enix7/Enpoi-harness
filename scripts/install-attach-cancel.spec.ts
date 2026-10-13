/**
 * Engine run marker, `dsh update` attach, and `dsh update --cancel` from
 * `scripts/install.sh`.
 *
 * The running installer is the sole writer of `$PREFIX/harness/.update-run.json`
 * ({runId, pid, mode, step, steps, phase, startedAt, logPath, version, target});
 * attach and cancel read it. These tests drive the helpers through
 * `DSH_INSTALL_LIB_ONLY=1` and the real script against scratch prefixes with a
 * held update lock (flock) and live/sleeper pids: the marker contract, the
 * step/exit lifecycle, contention→attach (outcome and Ctrl-C detach behavior is
 * exercised end-to-end in the rehearsal harness), cancel no-op/refusal/kill,
 * and the flag validation. All paths live under unique mkdtemp roots.
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const win32 = process.platform === 'win32'
const cleanups: string[] = []
let counter = 0

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-attach-cancel-'))
  cleanups.push(dir)
  return dir
}

function write(dir: string, rel: string, content: string, mode = 0o644): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

interface LibResult {
  status: number | null
  stdout: string
  stderr: string
}

function runLib(body: string, env: Record<string, string> = {}): LibResult {
  counter += 1
  const dir = scratch()
  const file = join(dir, `lib-${counter}.sh`)
  writeFileSync(file, ['set -u', 'export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" >/dev/null 2>&1', body, ''].join('\n'))
  const result = spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, INSTALL_SH: installSh, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runScript(args: string[], env: Record<string, string> = {}): LibResult {
  const result = spawnSync('bash', [installSh, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A prefix with install-state.json (attach/cancel never read deeper). */
function minimalPrefix(): { root: string; prefix: string; marker: string } {
  const root = scratch()
  const prefix = join(root, 'prefix')
  mkdirSync(join(prefix, 'harness'), { recursive: true })
  write(prefix, 'harness/install-state.json', '{"version":"0.1.7-enpoi.2.80","harnessDir":"0.1.7-enpoi.2.80","channel":"beta"}\n')
  return { root, prefix, marker: join(prefix, 'harness/.update-run.json') }
}

function writeMarker(marker: string, fields: Record<string, string | number>): void {
  const record: Record<string, string | number> = {
    runId: 'test-run',
    pid: 0,
    mode: 'plain',
    step: 2,
    steps: 9,
    phase: 'running',
    startedAt: '2026-01-01T00:00:00Z',
    logPath: '/dev/null',
    version: '0.1.7-enpoi.2.84',
    target: '0.1.7-enpoi.2.84',
    ...fields,
  }
  writeFileSync(marker, `${JSON.stringify(record)}\n`)
}

/** Hold the primary flock so the engine sees a busy update lock. */
function holdLock(prefix: string): { kill: () => void } {
  const lock = join(prefix, 'harness/.update.lock')
  const child = spawn('bash', ['-c', 'exec 9>>"$1"; flock -n 9; sleep 60', '_', lock], { stdio: 'ignore' })
  return { kill: () => child.kill('SIGKILL') }
}

const sleepers: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
})
afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(win32)('run marker contract', () => {
  it('writes exactly the contract fields and advances with numbered steps', () => {
    const prefix = scratch()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; LOG_FILE=/dev/null
run_marker_init prepare
step "one"
cat "$(run_marker_path)"
`, { PREFIX_DIR: prefix })
    expect(result.status).toBe(0)
    const record = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([
      'logPath', 'mode', 'phase', 'pid', 'runId', 'startedAt', 'step', 'steps', 'target', 'version',
    ])
    expect(record.mode).toBe('prepare')
    expect(record.phase).toBe('running')
    expect(record.step).toBe(1)
    expect(record.steps).toBe(0)
    expect(record.pid).toBeTypeOf('number')
  })

  it('marks terminal phases from the exit hook and never overwrites one already written', () => {
    const prefix = scratch()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; LOG_FILE=/dev/null
run_marker_init plain
run_marker_exit_hook 0
printf 'done=%s\n' "$(marker_field "$(run_marker_path)" phase)"
run_marker_init plain
run_marker_phase rolledback
run_marker_exit_hook 1
printf 'rolledback=%s\n' "$(marker_field "$(run_marker_path)" phase)"
run_marker_init plain
RUN_MARKER_SIGNALLED=1
run_marker_exit_hook 143
printf 'cancelled=%s\n' "$(marker_field "$(run_marker_path)" phase)"
RUN_MARKER_SIGNALLED=0
`, { PREFIX_DIR: prefix })
    expect(result.stdout).toContain('done=done')
    expect(result.stdout).toContain('rolledback=rolledback')
    expect(result.stdout).toContain('cancelled=cancelled')
  })

  it('reads string and numeric fields without Node resolved', () => {
    const { marker } = minimalPrefix()
    writeMarker(marker, { pid: 4242, step: 7 })
    const result = runLib(String.raw`
printf 'pid=[%s] step=[%s] mode=[%s]\n' \
  "$(marker_field "$MARKER" pid)" "$(marker_field "$MARKER" step)" "$(marker_field "$MARKER" mode)"
`, { MARKER: marker })
    expect(result.stdout).toContain('pid=[4242] step=[7] mode=[plain]')
  })

  it('leaves the marker alone in every sweep that scrapes .update-*', () => {
    const { root, prefix, marker } = minimalPrefix()
    writeMarker(marker, {})
    writeFileSync(join(root, 'log'), '')
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$PREFIX/harness/../home"; PROFILE=web; LOG_FILE=/dev/null
is_run_marker_path "$MARKER" && echo GUARD
# Both sweeps match .update-*; neither may touch the marker.
prune_orphaned_update_artifacts
if [ -f "$MARKER" ]; then echo KEPT; else echo REMOVED; fi
`, { PREFIX_DIR: prefix, MARKER: marker })
    expect(result.stdout).toContain('GUARD')
    expect(result.stdout).toContain('KEPT')
    expect(existsSync(marker)).toBe(true)
  })
})

describe.skipIf(win32)('attach on lock contention', () => {
  it('attaches to a live run and exits 0 when the marker reaches done', () => {
    const { prefix, marker } = minimalPrefix()
    const sleeper = spawn('sleep', ['30'])
    sleepers.push(sleeper)
    writeMarker(marker, { pid: sleeper.pid ?? 0, mode: 'prepare' })
    const lock = holdLock(prefix)
    try {
      // spawnSync blocks this process's event loop, so the sequencing (mark
      // done, kill the sleeper) runs in a detached helper while attach polls.
      const helper = spawn(
        'bash',
        ['-c', `sleep 1.2; sed -i 's/"phase": *"running"/"phase": "done"/' "$1"; kill -KILL ${String(sleeper.pid)}`, '_', marker],
        { stdio: 'ignore' },
      )
      const result = runScript(
        ['--update', '--prefix', prefix, '--dsh-home', join(prefix, '..', 'home')],
        { DSH_ATTACH_INTERVAL: '0.2', PATH: process.env.PATH ?? '' },
      )
      helper.kill('SIGKILL')
      expect(result.stdout).toContain('already running — attaching')
      expect(result.stdout).toContain('finished successfully')
      expect(result.status).toBe(0)
    } finally {
      lock.kill()
    }
  })

  it('refuses (does not attach) when the marker is stale', () => {
    const { prefix, marker } = minimalPrefix()
    writeMarker(marker, { pid: 2147483647 })
    const lock = holdLock(prefix)
    try {
      const result = runScript(['--update', '--prefix', prefix, '--dsh-home', join(prefix, '..', 'home')], {
        DSH_ATTACH_INTERVAL: '0.2',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('another update is already running')
      expect(result.stdout).not.toContain('attaching')
    } finally {
      lock.kill()
    }
  })

  it('refuses --prepare contention instead of attaching', () => {
    const { prefix, marker } = minimalPrefix()
    const sleeper = spawn('sleep', ['30'])
    sleepers.push(sleeper)
    writeMarker(marker, { pid: sleeper.pid ?? 0, mode: 'prepare' })
    const lock = holdLock(prefix)
    try {
      const result = runScript(['--update', '--prepare', '--prefix', prefix, '--dsh-home', join(prefix, '..', 'home')])
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('another update is already running')
      expect(result.stdout).not.toContain('attaching')
    } finally {
      lock.kill()
    }
  })
})

describe.skipIf(win32)('cancel', () => {
  it('stops a live pre-switch run, rewrites the marker, and sweeps partials', () => {
    const { prefix, marker } = minimalPrefix()
    const sleeper = spawn('sleep', ['30'])
    sleepers.push(sleeper)
    writeMarker(marker, { pid: sleeper.pid ?? 0, phase: 'running' })
    const partial = join(prefix, 'harness/.download-2147483647.tar.gz')
    writeFileSync(partial, Buffer.alloc(4096, 1))
    const result = runScript(['--update', '--cancel', '--json', '--prefix', prefix], { DSH_CANCEL_TIMEOUT: '2' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"action": "cancel"')
    expect(result.stdout).toContain('"status": "cancelled"')
    const phase = /"phase": "([^"]+)"/.exec(readFileSync(marker, 'utf8'))
    expect(phase?.[1]).toBe('cancelled')
    expect(existsSync(partial)).toBe(false)
  })

  it('refuses when the run is past the switch and leaves the process alone', () => {
    const { prefix, marker } = minimalPrefix()
    const sleeper = spawn('sleep', ['30'])
    sleepers.push(sleeper)
    writeMarker(marker, { pid: sleeper.pid ?? 0, phase: 'applying', step: 9 })
    const result = runScript(['--update', '--cancel', '--json', '--prefix', prefix], { DSH_CANCEL_TIMEOUT: '2' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('"status": "refused"')
    expect(result.stderr).toContain('past the switch')
    expect(sleeper.exitCode).toBeNull()
  })

  it('is a clean no-op with no marker or a dead pid', () => {
    const { prefix, marker } = minimalPrefix()
    const first = runScript(['--update', '--cancel', '--json', '--prefix', prefix])
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('"status": "noop"')
    writeMarker(marker, { pid: 2147483647 })
    const second = runScript(['--update', '--cancel', '--json', '--prefix', prefix])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('"status": "noop"')
  })

  it('refuses --cancel without --update and with another update flag', () => {
    const a = runScript(['--cancel'])
    expect(a.status).not.toBe(0)
    expect(a.stderr).toContain('--cancel applies to --update only')
    const b = runScript(['--update', '--cancel', '--prepare'])
    expect(b.status).not.toBe(0)
    expect(b.stderr).toContain('choose one of --prepare, --apply, --cancel')
  })
})
