/**
 * Fork: marker lifecycle for `dsh restart` — schedule, cancel, fire-only-when-idle,
 * stale-marker-on-boot, atomic consume, detached plan, and the CLI surface.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRestartMarker,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RESTART_UNIT,
  detachedRestartPlan,
  installRestartAfterTurn,
  parseRestartArgs,
  parseRestartMarker,
  RESTART_MARKER_VERSION,
  RestartAfterTurnWatcher,
  RestartUsageError,
  readRestartMarker,
  restartMarkerPath,
  runRestart,
  type RestartMarker,
  type RestartRequest,
  writeRestartMarker,
} from '../src/restart-after-turn.ts'

const homes: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function marker(overrides: Partial<RestartMarker> = {}): RestartMarker {
  return {
    version: RESTART_MARKER_VERSION,
    sessionId: 'session-1',
    unit: DEFAULT_RESTART_UNIT,
    profile: 'web',
    requestedAt: 1_000,
    deadline: 1_000 + DEFAULT_MAX_WAIT_MS,
    requestedBy: 'test',
    waitAll: false,
    ...overrides,
  }
}

/** Mirror of the internal request shape assertions tests read. */
function request(overrides: Partial<RestartRequest> = {}): RestartRequest {
  return {
    action: 'now',
    unit: DEFAULT_RESTART_UNIT,
    profile: 'web',
    maxWaitMs: DEFAULT_MAX_WAIT_MS,
    waitAll: false,
    json: false,
    ...overrides,
  }
}

describe('parseRestartArgs', () => {
  it('defaults to the detached immediate restart with the service defaults', () => {
    expect(parseRestartArgs([], {})).toEqual(request())
  })

  it('resolves the after-turn session from the shell environment or --session', () => {
    expect(parseRestartArgs(['--after-turn'], { DSH_SESSION_ID: 'abc' }))
      .toEqual(request({ action: 'after-turn', sessionId: 'abc' }))
    expect(parseRestartArgs(['--after-turn', '--session', 'explicit'], { DSH_SESSION_ID: 'abc' }))
      .toEqual(request({ action: 'after-turn', sessionId: 'explicit' }))
    expect(() => parseRestartArgs(['--after-turn'], {})).toThrow(RestartUsageError)
  })

  it('reads unit, profile, max-wait, wait-all, and json overrides', () => {
    expect(parseRestartArgs(
      ['--after-turn', '--session', 's', '--unit', 'x.service', '--profile', 'other', '--max-wait', '30', '--wait-all', '--json'],
      {},
    )).toEqual(request({
      action: 'after-turn',
      sessionId: 's',
      unit: 'x.service',
      profile: 'other',
      maxWaitMs: 30_000,
      waitAll: true,
      json: true,
    }))
    expect(parseRestartArgs([], { DSH_RESTART_UNIT: 'env.service', DSH_PROFILE: 'env-profile' }))
      .toEqual(request({ unit: 'env.service', profile: 'env-profile' }))
  })

  it('rejects conflicting or malformed flags', () => {
    expect(() => parseRestartArgs(['--after-turn', '--now'], {})).toThrow('mutually exclusive')
    expect(() => parseRestartArgs(['--cancel', '--now'], {})).toThrow('mutually exclusive')
    expect(() => parseRestartArgs(['--now', '--session', 's'], {})).toThrow('--session applies only')
    expect(() => parseRestartArgs(['--max-wait', 'zero'], {})).toThrow('positive number')
    expect(() => parseRestartArgs(['--bogus'], {})).toThrow('unexpected argument')
    expect(parseRestartArgs(['--help'], {})).toEqual(request({ action: 'help' }))
  })
})

describe('marker lifecycle', () => {
  it('writes under $DSH_HOME/state and round-trips', () => {
    const dir = home()
    const path = writeRestartMarker(marker(), dir)
    expect(path).toBe(join(dir, 'state', 'restart-after-turn.json'))
    expect(restartMarkerPath(dir)).toBe(path)
    expect(readRestartMarker(dir)).toEqual(marker())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sessionId: 'session-1' })
  })

  it('treats malformed and foreign-version markers as absent', () => {
    const dir = home()
    writeRestartMarker(marker(), dir)
    writeFileSync(restartMarkerPath(dir), '{not json')
    expect(readRestartMarker(dir)).toBeUndefined()
    writeFileSync(restartMarkerPath(dir), JSON.stringify({ version: 99, sessionId: 'x' }))
    expect(readRestartMarker(dir)).toBeUndefined()
    expect(parseRestartMarker('null')).toBeUndefined()
  })

  it('cancel consumes only once and reports whether a marker existed', () => {
    const dir = home()
    expect(runRestart(['--cancel'], io(), { home: dir })).toBe(0)
    writeRestartMarker(marker(), dir)
    expect(runRestart(['--cancel'], io(), { home: dir })).toBe(0)
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    expect(runRestart(['--cancel'], io(), { home: dir })).toBe(0)
    expect(consumeRestartMarker(dir)).toBeUndefined()
  })
})

describe('RestartAfterTurnWatcher', () => {
  it('fires only when the named session is idle, and consumes before firing', () => {
    const dir = home()
    writeRestartMarker(marker(), dir)
    const fired: RestartMarker[] = []
    let idle = false
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      isIdle: () => idle,
      fire: (firedMarker) => {
        // Consume-before-fire: the marker must already be gone when the restart runs.
        expect(existsSync(restartMarkerPath(dir))).toBe(false)
        fired.push(firedMarker)
      },
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('waiting')
    expect(fired).toEqual([])
    expect(existsSync(restartMarkerPath(dir))).toBe(true)
    idle = true
    expect(watcher.check()).toBe('fired')
    expect(fired).toHaveLength(1)
    expect(fired[0]?.sessionId).toBe('session-1')
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    expect(watcher.check()).toBe('none')
  })

  it('drops a stale marker on boot without firing', () => {
    const dir = home()
    writeRestartMarker(marker({ deadline: 1_500 }), dir)
    const fired: RestartMarker[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      isIdle: () => true,
      fire: firedMarker => fired.push(firedMarker),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('stale')
    expect(fired).toEqual([])
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
  })

  it('ignores another profile\'s marker and leaves it in place', () => {
    const dir = home()
    writeRestartMarker(marker({ profile: 'other' }), dir)
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      isIdle: () => true,
      fire: vi.fn(),
    })
    expect(watcher.check()).toBe('other-profile')
    expect(existsSync(restartMarkerPath(dir))).toBe(true)
  })

  it('lets exactly one of two watchers win the consume race', () => {
    const dir = home()
    writeRestartMarker(marker(), dir)
    const fired: string[] = []
    const make = (): RestartAfterTurnWatcher => new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      isIdle: () => true,
      fire: () => fired.push('fired'),
      now: () => 2_000,
    })
    const results = [make().check(), make().check()].sort()
    expect(results).toEqual(['fired', 'none'])
    expect(fired).toEqual(['fired'])
  })
})

describe('runRestart', () => {
  it('schedules after-turn from the ambient session and records the deadline', () => {
    const dir = home()
    const out: string[] = []
    const code = runRestart(['--after-turn', '--wait-all'], sink(out), {
      home: dir,
      env: { DSH_SESSION_ID: 'ambient', DSH_PROFILE: 'web' },
      now: () => 5_000,
    })
    expect(code).toBe(0)
    expect(readRestartMarker(dir)).toEqual(marker({
      sessionId: 'ambient',
      requestedAt: 5_000,
      deadline: 5_000 + DEFAULT_MAX_WAIT_MS,
      requestedBy: `pid ${String(process.pid)}`,
      waitAll: true,
    }))
    expect(out.join('\n')).toContain('will restart after session ambient')
  })

  it('--now fires the detached plan without writing a marker and returns promptly', () => {
    const dir = home()
    const calls: string[] = []
    const out: string[] = []
    const code = runRestart(['--now', '--unit', 'scratch.service'], sink(out), {
      home: dir,
      fire: (unit) => {
        calls.push(unit)
        return { via: 'systemd-run', command: 'systemd-run', args: [] }
      },
    })
    expect(code).toBe(0)
    expect(calls).toEqual(['scratch.service'])
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    expect(out.join('\n')).toContain('restarting scratch.service now via systemd-run')
  })

  it('prints usage and exits nonzero for bad arguments', () => {
    const err: string[] = []
    expect(runRestart(['--after-turn'], { stdout: () => {}, stderr: text => err.push(text) }, { home: home(), env: {} })).toBe(1)
    expect(err.join('\n')).toContain('--after-turn needs the session id')
    expect(err.join('\n')).toContain('Usage: dsh restart')
  })
})

describe('detachedRestartPlan', () => {
  it('plans a transient systemd unit on Linux, launchctl on macOS, and Restart-Service on Windows', () => {
    expect(detachedRestartPlan('dsh-web.service', 'linux', 1000)).toEqual({
      via: 'systemd-run',
      command: 'systemd-run',
      args: ['--user', '--collect', '--quiet', '--', 'systemctl', '--user', 'restart', 'dsh-web.service'],
    })
    expect(detachedRestartPlan('com.example.dsh', 'darwin', 501)).toEqual({
      via: 'launchctl',
      command: 'launchctl',
      args: ['kickstart', '-k', 'gui/501/com.example.dsh'],
    })
    expect(detachedRestartPlan('dsh-web', 'win32').via).toBe('powershell')
  })
})

describe('installRestartAfterTurn', () => {
  it('checks on install, on turn/end, and stops on disposal', () => {
    const dir = home()
    writeRestartMarker(marker({ profile: 'web', requestedAt: Date.now(), deadline: Date.now() + 60_000 }), dir)
    const fired: RestartMarker[] = []
    const listeners = new Map<string, (session: unknown, event: unknown) => void>()
    const disposers: (() => void)[] = []
    let running = true
    const fake = {
      get: (name: string) => name === 'agents'
        ? {
          get: () => ({ status: running ? 'running' as const : 'idle' as const }),
          list: () => [{ status: running ? 'running' as const : 'idle' as const }],
        }
        : undefined,
      on: (event: string, listener: (session: unknown, event: unknown) => void) => {
        listeners.set(event, listener)
        return () => { listeners.delete(event) }
      },
      effect: (execute: () => () => void) => { disposers.push(execute()) },
    }
    const stop = installRestartAfterTurn(fake as unknown as Context, {
      profile: 'web',
      home: dir,
      intervalMs: 60_000,
      log: () => {},
      fire: firedMarker => fired.push(firedMarker),
    })
    // The install sweep runs while the session's turn is live.
    expect(fired).toEqual([])
    expect(existsSync(restartMarkerPath(dir))).toBe(true)
    running = false
    // A non-matching event does nothing; the turn/end event fires the sweep.
    listeners.get('session/event')?.({ id: 'session-1' }, { type: 'step/end' })
    expect(fired).toEqual([])
    listeners.get('session/event')?.({ id: 'session-1' }, { type: 'turn/end' })
    expect(fired).toHaveLength(1)
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    stop()
    stop()
    expect(disposers).toHaveLength(1)
  })
})

function sink(out: string[]): { stdout: (text: string) => void; stderr: (text: string) => void } {
  return { stdout: text => out.push(text), stderr: text => out.push(text) }
}

function io(): { stdout: (text: string) => void; stderr: (text: string) => void } {
  return { stdout: () => {}, stderr: () => {} }
}
