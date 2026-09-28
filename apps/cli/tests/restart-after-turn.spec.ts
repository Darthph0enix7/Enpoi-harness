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
  MAX_RESTART_CONFIRM_ATTEMPTS,
  parseRestartArgs,
  parseRestartMarker,
  RESTART_MARKER_VERSION,
  RestartAfterTurnWatcher,
  RestartUsageError,
  readRestartMarker,
  restartFailurePath,
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
    // Whole-service idle is the --after-turn default.
    expect(parseRestartArgs(['--after-turn'], { DSH_SESSION_ID: 'abc' }))
      .toEqual(request({ action: 'after-turn', sessionId: 'abc', waitAll: true }))
    // An explicit --session is the per-session scope and bypasses wait-all.
    expect(parseRestartArgs(['--after-turn', '--session', 'explicit'], { DSH_SESSION_ID: 'abc' }))
      .toEqual(request({ action: 'after-turn', sessionId: 'explicit', waitAll: false }))
    // --wait-all forces the default back even alongside --session.
    expect(parseRestartArgs(['--after-turn', '--session', 'explicit', '--wait-all'], {}))
      .toEqual(request({ action: 'after-turn', sessionId: 'explicit', waitAll: true }))
    expect(() => parseRestartArgs(['--after-turn'], {})).toThrow(RestartUsageError)
  })

  it('bounds the wait-all default at 10 minutes unless --max-wait overrides it', () => {
    expect(DEFAULT_MAX_WAIT_MS).toBe(10 * 60_000)
    expect(parseRestartArgs(['--after-turn'], { DSH_SESSION_ID: 'abc' }).maxWaitMs).toBe(10 * 60_000)
    expect(parseRestartArgs(['--after-turn', '--max-wait', '45'], { DSH_SESSION_ID: 'abc' }).maxWaitMs).toBe(45_000)
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
      liveSessions: () => idle ? [] : [{ id: 'session-1', status: 'running' }],
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

  it('the wait-all default fires immediately when every session is idle', () => {
    const dir = home()
    writeRestartMarker(marker({ waitAll: true }), dir)
    const fired: RestartMarker[] = []
    const log: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [],
      fire: firedMarker => fired.push(firedMarker),
      log: line => log.push(line),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('fired')
    expect(fired).toHaveLength(1)
    expect(log.join('\n')).toContain('after every session went idle')
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    console.info(`[restart-wait-all] idle at schedule: ${log.join(' | ')}`)
  })

  it('the wait-all default waits for other sessions and fires when the last one finishes', () => {
    const dir = home()
    writeRestartMarker(marker({ waitAll: true }), dir)
    const fired: RestartMarker[] = []
    const log: string[] = []
    let others: Array<{ id: string; status: 'idle' | 'running' }> = [
      { id: 'session-1', status: 'idle' },
      { id: 'other-1', status: 'running' },
    ]
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => others,
      fire: firedMarker => fired.push(firedMarker),
      log: line => log.push(line),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('waiting')
    expect(fired).toEqual([])
    others = []
    expect(watcher.check()).toBe('fired')
    expect(fired).toHaveLength(1)
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    console.info(`[restart-wait-all] waited for other-1, then fired: ${log.join(' | ')}`)
  })

  it('on timeout falls back to the marked session and warns which sessions it stops waiting for', () => {
    const dir = home()
    writeRestartMarker(marker({ waitAll: true, deadline: 1_500 }), dir)
    const fired: RestartMarker[] = []
    const log: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [
        { id: 'session-1', status: 'idle' },
        { id: 'other-1', status: 'running' },
        { id: 'other-2', status: 'running' },
      ],
      fire: firedMarker => fired.push(firedMarker),
      log: line => log.push(line),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('fired')
    expect(fired).toHaveLength(1)
    const text = log.join('\n')
    expect(text).toContain('wait-all bound elapsed')
    expect(text).toContain('other-1, other-2')
    expect(text).toContain('will be aborted')
    expect(text).toContain('after session session-1 went idle')
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    console.info(`[restart-wait-all] timeout fallback: ${text.replace(/\n/g, ' | ')}`)
  })

  it('on timeout with the marked session still running it waits for that session alone and warns once', () => {
    const dir = home()
    writeRestartMarker(marker({ waitAll: true, deadline: 1_500 }), dir)
    const fired: RestartMarker[] = []
    const log: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [
        { id: 'session-1', status: 'running' },
        { id: 'other-1', status: 'running' },
      ],
      fire: firedMarker => fired.push(firedMarker),
      log: line => log.push(line),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('timed-out')
    expect(watcher.check()).toBe('timed-out')
    expect(fired).toEqual([])
    expect(log.filter(line => line.includes('wait-all bound elapsed'))).toHaveLength(1)
    expect(log.join('\n')).toContain('other-1')
    expect(existsSync(restartMarkerPath(dir))).toBe(true)
  })

  it('drops a stale per-session marker on boot without firing', () => {
    const dir = home()
    writeRestartMarker(marker({ deadline: 1_500 }), dir)
    const fired: RestartMarker[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [],
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
      liveSessions: () => [],
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
      liveSessions: () => [],
      fire: () => fired.push('fired'),
      now: () => 2_000,
    })
    const results = [make().check(), make().check()].sort()
    expect(results).toEqual(['fired', 'none'])
    expect(fired).toEqual(['fired'])
  })

  it('keeps a successful confirmed fire consumed', () => {
    const dir = home()
    writeRestartMarker(marker(), dir)
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [],
      fire: () => {},
      confirm: () => true,
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('fired')
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
  })

  it('re-arms the marker with a bounded attempt count when the restart is not confirmed', () => {
    const dir = home()
    writeRestartMarker(marker({ deadline: 2_500 }), dir)
    const fired: RestartMarker[] = []
    const log: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [],
      fire: firedMarker => fired.push(firedMarker),
      confirm: () => false,
      log: line => log.push(line),
      now: () => 2_000,
    })
    // Attempt 1: consumed, fired, unconfirmed -> written back with attempt 1
    // and a retry deadline so the next sweep cannot drop it as stale.
    expect(watcher.check()).toBe('retry')
    const rearmed = readRestartMarker(dir)
    expect(rearmed?.attempts).toBe(1)
    expect(rearmed?.deadline).toBe(2_000 + 60_000)
    // Attempts 2 and 3 also re-arm; attempt 4 is over the bound and is dropped
    // with a durable failure record instead of looping forever.
    expect(watcher.check()).toBe('retry')
    expect(readRestartMarker(dir)?.attempts).toBe(2)
    expect(watcher.check()).toBe('retry')
    expect(readRestartMarker(dir)?.attempts).toBe(3)
    expect(watcher.check()).toBe('retry')
    expect(existsSync(restartMarkerPath(dir))).toBe(false)
    expect(existsSync(restartFailurePath(dir))).toBe(true)
    expect(JSON.parse(readFileSync(restartFailurePath(dir), 'utf8'))).toMatchObject({ attempts: MAX_RESTART_CONFIRM_ATTEMPTS + 1 })
    expect(fired).toHaveLength(MAX_RESTART_CONFIRM_ATTEMPTS + 1)
    expect(log.join('\n')).toContain('giving up')
    expect(log.join('\n')).toContain('marker re-armed for the next sweep')
    console.info(`[restart-confirm] retry state: ${log.join(' | ')}`)
  })

  it('re-arms immediately when the detached fire throws', () => {
    const dir = home()
    writeRestartMarker(marker(), dir)
    const log: string[] = []
    const watcher = new RestartAfterTurnWatcher({
      home: dir,
      profile: 'web',
      liveSessions: () => [],
      fire: () => { throw new Error('no systemd session') },
      log: line => log.push(line),
      now: () => 2_000,
    })
    expect(watcher.check()).toBe('retry')
    expect(readRestartMarker(dir)?.attempts).toBe(1)
    expect(log.join('\n')).toContain('no systemd session')
    expect(log.join('\n')).toContain('marker re-armed for the next sweep')
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
    expect(out.join('\n')).toContain('after every session goes idle, or ambient alone past')
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
          list: () => [{ id: 'session-1', status: running ? 'running' as const : 'idle' as const }],
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
