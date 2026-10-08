/**
 * Installer self-restart guards from `scripts/install.sh`.
 *
 * A `dsh update` started inside the managed unit (a session shell or a model
 * tool call) is a child of the unit's main process; a direct restart stops that
 * whole process tree, kills the update mid-flight, and leaves the service down.
 * The installer must detect that position from process ancestry, complete every
 * durable step first, then delegate the restart — the after-turn marker
 * (`apps/cli/src/restart-after-turn.ts`) when a turn is in flight, a detached
 * restart plus a detached verifier otherwise — and the verifier must confirm
 * the unit is back, starting or bootstrapping it when it is not.
 *
 * The helpers are driven by sourcing install.sh as a library
 * (DSH_INSTALL_LIB_ONLY=1) with fake systemctl/systemd-run/launchctl on PATH
 * and a scratch HOME, and the marker the shell writes is parsed with the
 * module's own `parseRestartMarker`, so the bash-written JSON cannot drift from
 * the schema the web watcher consumes.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRestartMarker, RestartAfterTurnWatcher } from '../apps/cli/src/restart-after-turn.ts'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const createCreatorDocs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'creator', '02-install-and-update.md')

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-self-restart-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeExecutable(path: string, lines: readonly string[]): void {
  writeFileSync(path, lines.join('\n') + '\n')
  chmodSync(path, 0o755)
}

/** Fake `systemctl`: static answers by env, with an optional state file. */
function fakeSystemctl(root: string): { binDir: string; log: string; stateFile: string } {
  const binDir = join(root, 'bin')
  const log = join(root, 'systemctl.log')
  const stateFile = join(root, 'service.state')
  mkdirSync(binDir, { recursive: true })
  writeExecutable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"',
    'active="${FAKE_ACTIVE:-0}"; gen="${FAKE_GEN:-100}"',
    'if [ -f "$FAKE_STATE_FILE" ]; then',
    '  active="$(sed -n \'s/^active=//p\' "$FAKE_STATE_FILE" | head -n 1)"',
    '  [ -n "$active" ] || active="${FAKE_ACTIVE:-0}"',
    '  g="$(sed -n \'s/^gen=//p\' "$FAKE_STATE_FILE" | head -n 1)"',
    '  [ -n "$g" ] && gen="$g"',
    'fi',
    'case "$*" in',
    '  *"show -p MainPID"*) printf \'%s\\n\' "${FAKE_MAIN_PID:-0}";;',
    '  *"show -p ActiveEnterTimestampMonotonic"*) printf \'%s\\n\' "$gen";;',
    '  *"is-active"*) [ "$active" = 1 ] && exit 0 || exit 3;;',
    '  *"start "*)',
    '    if [ "${FAKE_START_OK:-1}" = 1 ]; then',
    '      printf \'active=%s\\ngen=%s\\n\' "${FAKE_STARTED_ACTIVE:-1}" "${FAKE_GEN_AFTER:-200}" > "$FAKE_STATE_FILE"',
    '    else exit 1; fi;;',
    '  *"reset-failed"*) exit 0;;',
    '  *"restart"*)',
    '    if [ "${FAKE_RESTART_OK:-1}" = 1 ]; then',
    '      printf \'active=1\\ngen=%s\\n\' "${FAKE_GEN_AFTER:-200}" > "$FAKE_STATE_FILE"',
    '    else exit 1; fi;;',
    'esac',
    'exit 0',
  ])
  return { binDir, log, stateFile }
}

/** Fake `systemd-run`: records argv, never executes the command. */
function fakeSystemdRun(root: string): { binDir: string; log: string } {
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const log = join(root, 'systemd-run.log')
  writeExecutable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$SYSTEMD_RUN_LOG"',
    'exit "${SYSTEMD_RUN_EXIT:-0}"',
  ])
  return { binDir, log }
}

/** Fake `launchctl`: records argv; `print` answers from a state file. */
function fakeLaunchctl(root: string): { binDir: string; log: string; stateFile: string } {
  const binDir = join(root, 'bin')
  const log = join(root, 'launchctl.log')
  const stateFile = join(root, 'launchd.state')
  mkdirSync(binDir, { recursive: true })
  writeExecutable(join(binDir, 'launchctl'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$LAUNCHCTL_LOG"',
    'case "$1" in',
    '  print)',
    '    if [ "${PRINT_PID:-0}" = 1 ]; then printf \'\\tpid = %s\\n\' "${FAKE_MAIN_PID:-0}"; exit 0; fi',
    '    if [ "${PRINT_STATEFUL:-0}" = 1 ]; then',
    '      if [ -f "$LAUNCHCTL_STATE" ]; then printf \'\\tpid = %s\\n\' "${FAKE_PID:-4242}"; exit 0; fi',
    '      exit 1',
    '    fi',
    '    exit "${PRINT_UNIT_EXIT:-1}";;',
    '  submit|bootstrap|kickstart)',
    '    [ "${PRINT_STATEFUL:-0}" = 1 ] && : > "$LAUNCHCTL_STATE"',
    '    exit "${LAUNCHCTL_ACTION_EXIT:-0}";;',
    'esac',
    'exit 1',
  ])
  return { binDir, log, stateFile }
}

interface RunOptions {
  home: string
  path?: string
  env?: Record<string, string>
}

function runLibrary(call: string, options: RunOptions): { status: number; output: string } {
  const script = ['export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" 2>/dev/null', 'VERBOSE=1', call].join('\n')
  const result = spawnSync('bash', ['-c', script], {
    env: {
      ...process.env,
      INSTALL_SH: installSh,
      HOME: options.home,
      STUB_BIN: options.path ?? '',
      ...(options.path === undefined ? {} : { PATH: `${options.path}:${process.env.PATH ?? ''}` }),
      ...options.env,
    },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * Run the call from a grandchild shell, so the invoking shell's parent is a
 * known pid the fake unit can report as its main process — the real ancestor
 * walk then answers against a live process tree.
 */
function runUnderFakeServiceAncestor(call: string, options: RunOptions): { status: number; output: string } {
  const inner = [
    'export DSH_INSTALL_LIB_ONLY=1',
    '. "$INSTALL_SH" 2>/dev/null',
    'OS=linux',
    'SERVICE_UNIT=test.service',
    'PATH="$STUB_BIN:$PATH"',
    call,
  ].join('\n')
  const result = spawnSync('bash', ['-c', 'export FAKE_MAIN_PID=$$; bash -c "$INNER_SCRIPT"'], {
    env: {
      ...process.env,
      INSTALL_SH: installSh,
      HOME: options.home,
      INNER_SCRIPT: inner,
      STUB_BIN: options.path ?? '',
      ...options.env,
    },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** The common scratch layout for delegation runs. */
function scratch(): { root: string; home: string; prefix: string; binDir: string; systemctlLog: string; runLog: string } {
  const root = tempRoot()
  const home = join(root, 'home')
  const prefix = join(root, 'prefix')
  const systemctl = fakeSystemctl(root)
  const systemdRun = fakeSystemdRun(root)
  return {
    root, home, prefix,
    binDir: `${systemdRun.binDir}:${systemctl.binDir}`,
    systemctlLog: systemctl.log,
    runLog: systemdRun.log,
  }
}

const DELEGATE_ARGS = [
  'OS=linux',
  'SERVICE_UNIT=test.service',
  'PROFILE=web',
].join('\n')

describe('installer in-unit detection', () => {
  it('detects a process descending from the unit main pid', () => {
    const root = tempRoot()
    const { binDir } = fakeSystemctl(root)
    const result = runUnderFakeServiceAncestor(
      'if running_under_service; then printf "UNDER=0\\n"; else printf "UNDER=1\\n"; fi',
      { home: root, path: binDir, env: { SYSTEMCTL_LOG: join(root, 'sys.log') } },
    )
    expect(result.output).toContain('UNDER=0')
  })

  it('does not treat an unrelated main pid as this process tree', () => {
    const root = tempRoot()
    const { binDir } = fakeSystemctl(root)
    const result = runUnderFakeServiceAncestor(
      'FAKE_MAIN_PID=999999; if running_under_service; then printf "UNDER=0\\n"; else printf "UNDER=1\\n"; fi',
      { home: root, path: binDir, env: { SYSTEMCTL_LOG: join(root, 'sys.log') } },
    )
    expect(result.output).toContain('UNDER=1')
  })

  it('detects the launchd job pid on macOS', () => {
    const root = tempRoot()
    const { binDir } = fakeLaunchctl(root)
    const result = runLibrary([
      'OS=darwin',
      'SERVICE_UNIT=test.label',
      'PATH="$STUB_BIN:$PATH"',
      'if running_under_service; then printf "UNDER=0\\n"; else printf "UNDER=1\\n"; fi',
    ].join('\n'), {
      home: root,
      path: binDir,
      env: { LAUNCHCTL_LOG: join(root, 'launchctl.log'), PRINT_PID: '1', FAKE_MAIN_PID: String(process.pid) },
    })
    // The fake reports this test process as the job pid; the spawned shell
    // descends from it, so the walk finds it.
    expect(result.output).toContain('UNDER=0')
  })
})

describe('delegated restart from inside the unit', () => {
  it('writes the after-turn marker when a turn is in flight', () => {
    const { home, prefix, binDir, runLog } = scratch()
    const result = runLibrary([
      DELEGATE_ARGS,
      `PREFIX=${prefix}`,
      `DSH_HOME=${home}`,
      'DSH_SESSION_ID=session-a',
      'unset DSH_PTY_SESSION_ID',
      'PATH="$STUB_BIN:$PATH"',
      'delegate_service_restart',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), {
      home, path: binDir,
      env: { SYSTEMCTL_LOG: join(prefix, 'sys.log'), SYSTEMD_RUN_LOG: runLog, FAKE_GEN: '100' },
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('RC=0')
    expect(result.output).toContain('scheduled for between turns')
    const marker = parseRestartMarker(readFileSync(join(home, 'state', 'restart-after-turn.json'), 'utf8'))
    expect(marker).toBeDefined()
    expect(marker).toMatchObject({
      version: 1, sessionId: 'session-a', unit: 'test.service', profile: 'web', waitAll: true,
    })
    expect(marker!.deadline).toBeGreaterThan(marker!.requestedAt)
    expect(marker!.requestedBy).toContain('(dsh update)')
    const log = readLog(runLog)
    // A verifier was detached, but the marker path must not restart the unit.
    expect(log).toContain('--service-guard')
    expect(log).not.toContain('systemctl --user restart')
  })

  it('restarts from a detached process when no turn is in flight', () => {
    const { home, prefix, binDir, runLog, systemctlLog } = scratch()
    const result = runLibrary([
      DELEGATE_ARGS,
      `PREFIX=${prefix}`,
      `DSH_HOME=${home}`,
      'DSH_SESSION_ID=session-a',
      'DSH_PTY_SESSION_ID=pty-1',
      'PATH="$STUB_BIN:$PATH"',
      'delegate_service_restart',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), {
      home, path: binDir,
      env: { SYSTEMCTL_LOG: systemctlLog, SYSTEMD_RUN_LOG: runLog, FAKE_GEN: '100' },
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain('delegated to a detached process')
    expect(existsSync(join(home, 'state', 'restart-after-turn.json'))).toBe(false)
    const log = readLog(runLog)
    expect(log).toContain('systemctl --user restart test.service')
    expect(log).toContain('--guard-expect-restart')
    expect(log).toContain('--guard-timeout 180')
  })

  it('falls back to the detached restart when no session identity is present', () => {
    const { home, prefix, binDir, runLog } = scratch()
    const result = runLibrary([
      DELEGATE_ARGS,
      `PREFIX=${prefix}`,
      `DSH_HOME=${home}`,
      'unset DSH_SESSION_ID DSH_PTY_SESSION_ID',
      'PATH="$STUB_BIN:$PATH"',
      'delegate_service_restart',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), {
      home, path: binDir,
      env: { SYSTEMCTL_LOG: join(prefix, 'sys.log'), SYSTEMD_RUN_LOG: runLog, FAKE_GEN: '100' },
    })
    expect(result.output).toContain('RC=0')
    expect(result.output).toContain('delegated to a detached process')
    expect(readLog(runLog)).toContain('systemctl --user restart test.service')
  })

  it('is idempotent: a repeated delegation overwrites the same marker', () => {
    const { home, prefix, binDir, runLog } = scratch()
    const result = runLibrary([
      DELEGATE_ARGS,
      `PREFIX=${prefix}`,
      `DSH_HOME=${home}`,
      'DSH_SESSION_ID=session-a',
      'unset DSH_PTY_SESSION_ID',
      'PATH="$STUB_BIN:$PATH"',
      'delegate_service_restart; delegate_service_restart',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), {
      home, path: binDir,
      env: { SYSTEMCTL_LOG: join(prefix, 'sys.log'), SYSTEMD_RUN_LOG: runLog, FAKE_GEN: '100' },
    })
    expect(result.output).toContain('RC=0')
    const marker = parseRestartMarker(readFileSync(join(home, 'state', 'restart-after-turn.json'), 'utf8'))
    expect(marker).toBeDefined()
    expect(marker!.sessionId).toBe('session-a')
  })

  it('delegates a macOS restart through the launchd detach', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const prefix = join(root, 'prefix')
    const launchctl = fakeLaunchctl(root)
    const result = runLibrary([
      'OS=darwin',
      'SERVICE_UNIT=test.label',
      'PROFILE=web',
      `PREFIX=${prefix}`,
      `DSH_HOME=${home}`,
      'DSH_SESSION_ID=session-a',
      'DSH_PTY_SESSION_ID=pty-1',
      'PATH="$STUB_BIN:$PATH"',
      'delegate_service_restart',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), {
      home,
      path: launchctl.binDir,
      env: { LAUNCHCTL_LOG: launchctl.log, PRINT_UNIT_EXIT: '1' },
    })
    expect(result.output).toContain('RC=0')
    const log = readLog(launchctl.log)
    expect(log).toContain('submit -l com.dsh.update-guard.')
    expect(log).toContain('kickstart -k gui/')
  })
})

describe('shell-written marker and the web watcher', () => {
  it('waits for whole-service idle, then fires between turns and consumes the marker', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const written = runLibrary([
      'OS=linux',
      'SERVICE_UNIT=test.service',
      'PROFILE=web',
      `DSH_HOME=${home}`,
      'DSH_SESSION_ID=session-a',
      'write_restart_marker session-a',
      'printf "RC=%s\\n" "$?"',
    ].join('\n'), { home })
    expect(written.output).toContain('RC=0')

    let marked: 'idle' | 'running' = 'running'
    let other: 'idle' | 'running' = 'running'
    const fired: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home,
      profile: 'web',
      liveSessions: () => [
        { id: 'session-a', status: marked },
        { id: 'session-b', status: other },
      ],
      fire: (marker) => { fired.push(marker.sessionId) },
    })
    // The marked turn still runs: never fire inside it.
    expect(watcher.check()).toBe('waiting')
    expect(fired).toEqual([])
    // The marked session went idle, but the whole-service scope still waits.
    marked = 'idle'
    expect(watcher.check()).toBe('waiting')
    expect(fired).toEqual([])
    // Every session is idle: the switch happens between turns.
    other = 'idle'
    expect(watcher.check()).toBe('fired')
    expect(fired).toEqual(['session-a'])
    expect(existsSync(join(home, 'state', 'restart-after-turn.json'))).toBe(false)
  })
})

describe('detached verifier --service-guard', () => {
  /** Run the real installer in guard mode against one fake systemd service state. */
  function runGuard(options: {
    root: string
    state?: string
    env?: Record<string, string>
    baseline?: string
    expectRestart?: boolean
  }): { status: number; log: string; systemctl: string } {
    const prefix = join(options.root, 'prefix')
    const systemctl = fakeSystemctl(options.root)
    const launchctl = fakeLaunchctl(options.root)
    if (options.state !== undefined) writeFileSync(systemctl.stateFile, options.state)
    const args = [
      installSh, '--service-guard',
      '--service-unit', 'test.service',
      '--prefix', prefix,
      '--dsh-home', options.root,
      '--guard-timeout', '1',
      '--guard-home', options.root,
    ]
    if (options.baseline !== undefined) args.push('--guard-baseline', options.baseline)
    if (options.expectRestart === true) args.push('--guard-expect-restart')
    const result = spawnSync('bash', args, {
      env: {
        ...process.env,
        PATH: `${launchctl.binDir}:${systemctl.binDir}:${process.env.PATH ?? ''}`,
        SYSTEMCTL_LOG: systemctl.log,
        FAKE_STATE_FILE: systemctl.stateFile,
        DSH_SERVICE_GUARD_INTERVAL: '1',
        DSH_SERVICE_GUARD_RECOVER: options.env?.DSH_SERVICE_GUARD_RECOVER ?? '5',
        ...options.env,
      },
      encoding: 'utf8',
    })
    return {
      status: result.status ?? -1,
      log: readLog(join(prefix, 'logs', 'install.log')),
      systemctl: readLog(systemctl.log),
    }
  }

  it('confirms the unit re-activated and records it in the install log', () => {
    const root = tempRoot()
    const result = runGuard({ root, state: 'active=1\ngen=200\n', baseline: '100' })
    expect(result.status).toBe(0)
    expect(result.log).toContain('verified active after the delegated restart')
  })

  it('starts the unit when the delegated restart left it down', () => {
    const root = tempRoot()
    const result = runGuard({ root, state: 'active=0\ngen=100\n', baseline: '100' })
    expect(result.status).toBe(0)
    expect(result.systemctl).toContain('start test.service')
    expect(result.log).toContain('recovered test.service after the failed restart')
  })

  it('records the failure when the unit cannot be started', () => {
    const root = tempRoot()
    const result = runGuard({ root, state: 'active=0\ngen=100\n', baseline: '100', env: { FAKE_START_OK: '0' } })
    expect(result.status).toBe(1)
    expect(result.log).toContain('ERROR: could not start or bootstrap test.service')
  })

  it('reports an unobserved restart instead of failing a still-active unit', () => {
    const root = tempRoot()
    const result = runGuard({ root, state: 'active=1\ngen=100\n', baseline: '100' })
    expect(result.status).toBe(0)
    expect(result.log).toContain('no delegated restart was observed')
  })

  it('re-kicks a unit whose detached restart never arrived', () => {
    const root = tempRoot()
    const result = runGuard({ root, state: 'active=1\ngen=100\n', baseline: '100', expectRestart: true, env: { DSH_SERVICE_GUARD_KICK: '1' } })
    expect(result.status).toBe(0)
    expect(result.systemctl).toContain('restart test.service')
    expect(result.log).toContain('restarting test.service from the detached verifier')
  })

  it('bootstraps an unloaded macOS unit (the guard recovery primitive)', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const launchctl = fakeLaunchctl(root)
    const plistDir = join(home, 'Library', 'LaunchAgents')
    mkdirSync(plistDir, { recursive: true })
    writeFileSync(join(plistDir, 'test.label.plist'), '<plist/>')
    const result = runLibrary('OS=darwin; SERVICE_UNIT=test.label; PATH="$STUB_BIN:$PATH"; start_or_bootstrap_service; printf "RC=%s\\n" "$?"', {
      home,
      path: launchctl.binDir,
      env: {
        LAUNCHCTL_LOG: launchctl.log,
        LAUNCHCTL_STATE: launchctl.stateFile,
        PRINT_STATEFUL: '1',
      },
    })
    expect(result.output).toContain('RC=0')
    expect(readLog(launchctl.log)).toContain('bootstrap gui/')
  })
})

describe('update wiring and the non-session path', () => {
  it('keeps the direct restart for an out-of-session update', () => {
    const root = tempRoot()
    const { binDir, log } = fakeSystemctl(root)
    const result = runLibrary('OS=linux; SERVICE_UNIT=test.service; PATH="$STUB_BIN:$PATH"; restart_service; printf "RC=%s\\n" "$?"', {
      home: root,
      path: binDir,
      env: { SYSTEMCTL_LOG: log },
    })
    expect(result.output).toContain('RC=0')
    expect(readLog(log)).toContain('restart test.service')
  })

  it('defers the restart only for an in-session update and reports first', () => {
    const install = readFileSync(installSh, 'utf8')
    const directRestart = [
      'deferred_restart=0',
      '  if running_under_service; then deferred_restart=1; fi',
      '  if [ "$deferred_restart" = 0 ]; then restart_service; fi',
    ].join('\n')
    expect(install).toContain(directRestart)
    // The durable sequence keeps its exact order for the direct path.
    expect(install).toMatch(/\n  ensure_service\n  ensure_tailnet_exposure\n  run_backfill\n/)
    // The delegated restart is the last action, after the result is reported.
    const delegatedRestart = [
      'print_summary update',
      '  emit_json update 1',
      '  if [ "$deferred_restart" = 1 ]; then delegate_service_restart; fi',
    ].join('\n')
    expect(install).toContain(delegatedRestart)
    // Rollback defers its restart for an in-session run too.
    const rollback = /rollback\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(rollback).toBeDefined()
    expect(rollback).toContain('in_session=1')
    expect(rollback).toMatch(/if \[ "\$in_session" = 1 \]; then delegate_service_restart; fi/)
  })

  it('parses under bash -n and documents the safe session update', () => {
    const syntax = spawnSync('bash', ['-n', installSh], { encoding: 'utf8' })
    expect(syntax.status).toBe(0)
    const docs = readFileSync(createCreatorDocs, 'utf8')
    expect(docs).toContain('dsh update')
    expect(docs).toMatch(/between turns|delegat/)
  })
})
