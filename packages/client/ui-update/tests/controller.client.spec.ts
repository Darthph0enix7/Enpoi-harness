// @vitest-environment jsdom
/**
 * UpdateController: poll cadence (mount incl. one run read, 60 s
 * visible-only, focus/visibility with a gap), executing-only run polling,
 * the prepare/apply/retry/dismiss actions with their exact wire args, the
 * restart detection through `connection/reset`, and the one-time toast
 * marker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_KEY,
  RELOAD_WATCH_MS,
  STATUS_POLL_MS,
  TOAST_KEY,
  TRIGGER_MIN_GAP_MS,
  UpdateController,
  type UpdateDom,
  type UpdateStorage,
  type UpdateTimers,
} from '../src/client/controller.ts'
import { updateCheckRpc, type UpdateRpcResult, type UpdateRunWire } from '../src/client/rpc.ts'

/** In-memory storage seam. */
function memoryStorage(initial: Record<string, string> = {}): UpdateStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

/** Timer seam whose handlers the test fires explicitly. */
function manualTimers(): { timers: UpdateTimers; fireIntervals: () => void; intervals: () => number } {
  const handlers = new Set<() => void>()
  return {
    timers: {
      setInterval: (handler: () => void) => { handlers.add(handler); return handler as unknown as ReturnType<typeof setInterval> },
      clearInterval: (handle: ReturnType<typeof setInterval>) => { handlers.delete(handle as unknown as () => void) },
      setTimeout: (handler: () => void) => { handlers.add(handler); return handler as unknown as ReturnType<typeof setTimeout> },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => { handlers.delete(handle as unknown as () => void) },
    },
    fireIntervals: () => { for (const handler of [...handlers]) handler() },
    intervals: () => handlers.size,
  }
}

function dom(visibilityState: DocumentVisibilityState = 'visible'): {
  seam: UpdateDom
  fire: (type: string) => void
} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    seam: {
      visibilityState,
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener) },
    },
    fire: (type) => { for (const listener of [...listeners.get(type) ?? []]) listener() },
  }
}

const availableStatus = {
  state: 'available' as const,
  current: { version: '0.1.7-enpoi.2.81', commit: 'abc1234', channel: 'stable' },
  latest: { version: '0.1.7-enpoi.2.84', commit: 'def5678', releasedAt: '2026-10-13T12:00:00.000Z', notes: ['feat(x): y'] },
}

function runWire(overrides: Partial<UpdateRunWire> = {}): UpdateRunWire {
  return {
    runId: 'run1',
    target: '0.1.7-enpoi.2.84',
    channel: 'stable',
    mode: 'prepare',
    rung: 'two-phase',
    phase: 'preparing',
    step: 1,
    steps: 9,
    lastLine: '[1/9] environment',
    startedAt: '2026-10-13T12:00:00.000Z',
    pid: 4242,
    logPath: '/home/dsh/update-check/run.log',
    result: null,
    launcher: 'setsid',
    staged: false,
    logTail: [],
    ...overrides,
  }
}

const executingRun = runWire({ phase: 'preparing', step: 4 })

/** Flush the rpc promise chains (then/finally) to completion. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

interface Bench {
  controller: UpdateController
  calls: { method: string; args: Record<string, unknown> }[]
  ticks: ReturnType<typeof manualTimers>
  doc: ReturnType<typeof dom>
  win: ReturnType<typeof dom>
  storage: ReturnType<typeof memoryStorage>
  reload: ReturnType<typeof vi.fn>
}

function bench(options: {
  answers?: Record<string, unknown>
  storage?: ReturnType<typeof memoryStorage>
  now?: () => number
  rpcError?: string
} = {}): Bench {
  const calls: Bench['calls'] = []
  const rpc = async <T>(method: string, args: Record<string, unknown>): Promise<UpdateRpcResult<T>> => {
    calls.push({ method, args })
    if (options.rpcError !== undefined) return { ok: false, message: options.rpcError }
    const answers = options.answers ?? {}
    return { ok: true, value: (method in answers ? answers[method] : null) as T }
  }
  const ticks = manualTimers()
  const doc = dom()
  const win = dom()
  const storage = options.storage ?? memoryStorage()
  const reload = vi.fn()
  const controller = new UpdateController({
    rpc,
    storage,
    timers: ticks.timers,
    doc: doc.seam,
    win: win.seam,
    reload,
    now: options.now ?? (() => 0),
  })
  return { controller, calls, ticks, doc, win, storage, reload }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdateController polling', () => {
  it('reads status and the run once on mount, then status on the 60 s cadence and triggers', async () => {
    let clock = 1_000
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': null }, now: () => clock })
    b.controller.mount()
    expect(b.calls).toEqual([
      { method: 'updateCheck.status', args: {} },
      { method: 'updateCheck.run', args: {} },
    ])
    expect(STATUS_POLL_MS).toBe(60_000)
    await settle()

    // A visibility restore inside the trigger gap adds no call.
    b.doc.fire('visibilitychange')
    expect(b.calls).toHaveLength(2)

    // The 60 s interval polls status again.
    b.ticks.fireIntervals()
    expect(b.calls.filter(call => call.method === 'updateCheck.status')).toHaveLength(2)
    await settle()

    // Focus inside the gap is price-free; after the gap it reads once more.
    b.win.fire('focus')
    expect(b.calls).toHaveLength(3)
    clock += TRIGGER_MIN_GAP_MS + 1
    b.win.fire('focus')
    expect(b.calls).toHaveLength(4)
    b.controller.dispose()
  })

  it('skips the interval tick while the tab is hidden', () => {
    const hidden = dom('hidden')
    const ticks = manualTimers()
    const calls: string[] = []
    const controller = new UpdateController({
      rpc: (async (method: string) => {
        calls.push(method)
        return { ok: true, value: availableStatus }
      }) as unknown as typeof updateCheckRpc,
      storage: memoryStorage(),
      timers: ticks.timers,
      doc: hidden.seam,
      win: dom().seam,
      reload: vi.fn(),
    })
    controller.mount()
    expect(calls).toEqual(['updateCheck.status', 'updateCheck.run'])
    ticks.fireIntervals()
    expect(calls).toHaveLength(2)
    hidden.fire('visibilitychange')
    expect(calls).toHaveLength(2)
    controller.dispose()
    expect(ticks.intervals()).toBe(0)
  })

  it('polls the run every 2 s only while the engine executes, and stops at a prepared record', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.run': executingRun,
    }
    const b = bench({ answers })
    b.controller.mount()
    await settle()
    // status interval + run interval.
    expect(b.ticks.intervals()).toBe(2)

    answers['updateCheck.run'] = runWire({ phase: 'prepared', step: 7, staged: true })
    b.ticks.fireIntervals()
    await settle()
    expect(b.controller.store.getSnapshot().run?.phase).toBe('prepared')
    // A prepared record rests: only the status interval remains.
    expect(b.ticks.intervals()).toBe(1)
    b.controller.dispose()
  })

  it('stops polling when the engine process left a terminal record', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.run': executingRun,
    }
    const b = bench({ answers })
    b.controller.mount()
    await settle()
    expect(b.ticks.intervals()).toBe(2)
    answers['updateCheck.run'] = runWire({ phase: 'applying', result: null, mode: 'apply', step: 9 })
    b.ticks.fireIntervals()
    await settle()
    expect(b.ticks.intervals()).toBe(2)
    answers['updateCheck.run'] = runWire({ phase: 'success', result: 'success', mode: 'apply', step: 9 })
    b.ticks.fireIntervals()
    await settle()
    expect(b.controller.store.getSnapshot().run?.result).toBe('success')
    // The run poll stopped (a terminal record never changes); the bounded
    // reload watch may still be running, but it never reads updateCheck.run.
    const runCalls = b.calls.filter(call => call.method === 'updateCheck.run').length
    b.ticks.fireIntervals()
    await settle()
    expect(b.calls.filter(call => call.method === 'updateCheck.run')).toHaveLength(runCalls)
    b.controller.dispose()
  })
})

describe('UpdateController actions and their exact wire args', () => {
  it('start prepares, pins the pre-run version, and opens the progress dialog', async () => {
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.start': executingRun } })
    b.controller.mount()
    await settle()
    b.controller.start()
    await settle()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.start', args: {} })
    const state = b.controller.store.getSnapshot()
    expect(state.run?.runId).toBe('run1')
    expect(state.dialogOpen).toBe(true)
    expect(JSON.parse(b.storage.values.get(PENDING_KEY)!)).toEqual({
      from: '0.1.7-enpoi.2.81',
      target: '0.1.7-enpoi.2.84',
    })
    b.controller.dispose()
  })

  it('apply sends no arguments and follows the applying record', async () => {
    const applied = runWire({ mode: 'apply', phase: 'applying', step: 8, staged: true })
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.apply': applied } })
    b.controller.mount()
    await settle()
    b.controller.apply()
    await settle()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.apply', args: {} })
    expect(b.controller.store.getSnapshot().run?.mode).toBe('apply')
    expect(b.ticks.intervals()).toBe(2)
    b.controller.dispose()
  })

  it('retry replays apply while the staged marker survived, and re-prepares otherwise', async () => {
    const rolled = runWire({ mode: 'apply', phase: 'rolledback', result: 'rolledback', step: 9, staged: true })
    const prepared = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': rolled, 'updateCheck.apply': runWire({ mode: 'apply', phase: 'applying' }) } })
    prepared.controller.mount()
    await settle()
    prepared.controller.open()
    await settle()
    prepared.controller.retry()
    await settle()
    expect(prepared.calls.at(-1)).toEqual({ method: 'updateCheck.apply', args: {} })
    prepared.controller.dispose()

    const failedPrepare = runWire({ phase: 'failed', result: 'failed', staged: false })
    const fresh = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': failedPrepare, 'updateCheck.start': executingRun } })
    fresh.controller.mount()
    await settle()
    fresh.controller.open()
    await settle()
    fresh.controller.retry()
    await settle()
    expect(fresh.calls.at(-1)).toEqual({ method: 'updateCheck.start', args: {} })
    fresh.controller.dispose()
  })

  it('retry re-runs the one-shot flow and only replays apply for a two-phase apply record', async () => {
    const failedOneShot = runWire({ mode: 'one-shot', rung: 'one-shot', phase: 'failed', result: 'failed', staged: false })
    const oneShot = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': failedOneShot,
        'updateCheck.start': runWire({ mode: 'one-shot', rung: 'one-shot' }),
      },
    })
    oneShot.controller.mount()
    await settle()
    oneShot.controller.open()
    await settle()
    oneShot.controller.retry()
    await settle()
    expect(oneShot.calls.at(-1)).toEqual({ method: 'updateCheck.start', args: {} })
    oneShot.controller.dispose()

    // Defensive guard: a record claiming `apply` on the one-shot rung (which
    // the host never writes) still retries through start, never apply.
    const mixed = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': runWire({ mode: 'apply', rung: 'one-shot', phase: 'rolledback', result: 'rolledback', staged: true }),
        'updateCheck.start': runWire(),
      },
    })
    mixed.controller.mount()
    await settle()
    mixed.controller.open()
    await settle()
    mixed.controller.retry()
    await settle()
    expect(mixed.calls.at(-1)).toEqual({ method: 'updateCheck.start', args: {} })
    mixed.controller.dispose()
  })

  it('surfaces a refused start as the action error', async () => {
    const b = bench({ rpcError: 'an update is already running' })
    b.controller.mount()
    await settle()
    b.controller.start()
    await settle()
    expect(b.controller.store.getSnapshot()).toMatchObject({
      busy: false,
      actionError: 'an update is already running',
    })
    b.controller.dispose()
  })

  it('skip wraps the version in the descriptor’s `request` parameter and closes the dialog', async () => {
    const dismissed = { ...availableStatus, state: 'dismissed' as const }
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.dismiss': dismissed } })
    b.controller.mount()
    await settle()
    b.controller.open()
    await settle()
    b.controller.skip()
    await settle()
    expect(b.calls.at(-1)).toEqual({
      method: 'updateCheck.dismiss',
      args: { request: { version: '0.1.7-enpoi.2.84' } },
    })
    expect(b.controller.store.getSnapshot()).toMatchObject({ status: { state: 'dismissed' }, dialogOpen: false })
    b.controller.dispose()
  })

  it('ignores skip when no release is offered', async () => {
    const b = bench({ answers: { 'updateCheck.status': { ...availableStatus, state: 'current', latest: undefined } } })
    b.controller.mount()
    await settle()
    b.controller.skip()
    await settle()
    expect(b.calls.filter(call => call.method === 'updateCheck.dismiss')).toHaveLength(0)
    b.controller.dispose()
  })
})

describe('UpdateController checkNow', () => {
  it('runs one manual check, applies the shared status, and clears checking', async () => {
    const checked = { ...availableStatus, checkedAt: '2026-10-13T18:00:00.000Z' }
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.checkNow': checked } })
    b.controller.mount()
    await settle()
    b.controller.checkNow()
    expect(b.controller.store.getSnapshot()).toMatchObject({ checking: true, checkError: null })
    await settle()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.checkNow', args: {} })
    expect(b.controller.store.getSnapshot()).toMatchObject({ checking: false, status: checked, checkError: null })
    b.controller.dispose()
  })

  it('is single-flight while a manual check is in flight', async () => {
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.checkNow': availableStatus } })
    b.controller.mount()
    await settle()
    const before = b.calls.filter(call => call.method === 'updateCheck.checkNow').length
    b.controller.checkNow()
    b.controller.checkNow()
    await settle()
    expect(b.calls.filter(call => call.method === 'updateCheck.checkNow')).toHaveLength(before + 1)
    b.controller.dispose()
  })

  it('records a quiet failure and clears it when the next check starts', async () => {
    const b = bench({ rpcError: 'gateway responded 502' })
    b.controller.mount()
    await settle()
    b.controller.checkNow()
    await settle()
    expect(b.controller.store.getSnapshot()).toMatchObject({ checking: false, checkError: 'gateway responded 502' })
    b.controller.checkNow()
    expect(b.controller.store.getSnapshot()).toMatchObject({ checking: true, checkError: null })
    b.controller.dispose()
  })
})

describe('UpdateController recover', () => {
  it('clears stale state then re-applies a staged record without re-preparing', async () => {
    const failed = runWire({ mode: 'apply', phase: 'failed', result: 'failed', staged: true, reason: 'already running' })
    const cleared = runWire({ mode: 'apply', phase: 'failed', result: 'failed', staged: true })
    const applied = runWire({ mode: 'apply', phase: 'applying', staged: true })
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': failed,
        'updateCheck.clearStale': cleared,
        'updateCheck.apply': applied,
      },
    })
    b.controller.mount()
    await settle()
    b.controller.recover()
    await settle()
    await settle()
    expect(b.calls.at(-2)).toEqual({ method: 'updateCheck.clearStale', args: {} })
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.apply', args: {} })
    expect(b.controller.store.getSnapshot().run?.phase).toBe('applying')
    b.controller.dispose()
  })

  it('falls back to a fresh start when clearing leaves nothing staged', async () => {
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': runWire({ phase: 'failed', result: 'failed', staged: false }),
        'updateCheck.clearStale': runWire({ phase: 'failed', result: 'failed', staged: false }),
        'updateCheck.start': runWire({ phase: 'preparing' }),
      },
    })
    b.controller.mount()
    await settle()
    b.controller.recover()
    await settle()
    await settle()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.start', args: {} })
    b.controller.dispose()
  })

  it('surfaces a refused clear (live run) as the action error', async () => {
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': runWire(),
      },
      rpcError: 'updateCheck.clearStale: run ext-1 is live (preparing); cancel it or wait',
    })
    b.controller.mount()
    await settle()
    b.controller.recover()
    await settle()
    expect(b.controller.store.getSnapshot().actionError).toContain('is live')
    b.controller.dispose()
  })
})

describe('UpdateController cancel', () => {
  it('relays a cancelled engine outcome into the record', async () => {
    const cancelled = runWire({ observed: true, launcher: 'external', phase: 'cancelled', result: 'cancelled', staged: true })
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': executingRun,
        'updateCheck.cancel': { status: 'cancelled', message: 'Cancelled run run1: runner stopped', record: cancelled },
      },
    })
    b.controller.mount()
    await settle()
    b.controller.cancel()
    await settle()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.cancel', args: {} })
    expect(b.controller.store.getSnapshot().run).toMatchObject({ result: 'cancelled', phase: 'cancelled' })
    b.controller.dispose()
  })

  it('surfaces the engine refusal without touching the record', async () => {
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': runWire({ mode: 'apply', phase: 'applying', step: 8 }),
        'updateCheck.cancel': { status: 'refused', message: 'refusing — the update is past the switch (phase applying)', record: null },
      },
    })
    b.controller.mount()
    await settle()
    b.controller.cancel()
    await settle()
    expect(b.controller.store.getSnapshot().actionError).toContain('past the switch')
    expect(b.controller.store.getSnapshot().run?.phase).toBe('applying')
    b.controller.dispose()
  })

  it('re-reads the run after a no-op cancel', async () => {
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.run': null,
        'updateCheck.cancel': { status: 'noop', message: 'no update is running', record: null },
      },
    })
    b.controller.mount()
    await settle()
    const before = b.calls.filter(call => call.method === 'updateCheck.run').length
    b.controller.cancel()
    await settle()
    expect(b.calls.filter(call => call.method === 'updateCheck.run')).toHaveLength(before + 1)
    b.controller.dispose()
  })
})

describe('UpdateController reload watch', () => {
  it('reloads once the identity changes inside the watch window', async () => {
    let clock = 0
    const storage = memoryStorage({ [PENDING_KEY]: JSON.stringify({ from: '0.1.7-enpoi.2.81', target: '0.1.7-enpoi.2.84' }) })
    const answers: Record<string, unknown> = { 'updateCheck.status': availableStatus, 'updateCheck.run': null }
    const b = bench({ answers, storage, now: () => clock })
    b.controller.mount()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()

    // A reconnect with a pending update starts the bounded watch.
    b.controller.onConnectionReset()
    await settle()
    b.ticks.fireIntervals()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()

    // The restarted service now reports the new version; the next tick reloads.
    answers['updateCheck.status'] = {
      ...availableStatus,
      state: 'current' as const,
      latest: undefined,
      current: { version: '0.1.7-enpoi.2.84', commit: 'def5678', channel: 'stable' },
    }
    clock += 2_000
    b.ticks.fireIntervals()
    await settle()
    expect(b.reload).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })

  it('does not reload without an identity change and stops at the deadline', async () => {
    let clock = 0
    const storage = memoryStorage({ [PENDING_KEY]: JSON.stringify({ from: '0.1.7-enpoi.2.81', target: '0.1.7-enpoi.2.84' }) })
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': null }, storage, now: () => clock })
    b.controller.mount()
    await settle()
    b.controller.onConnectionReset()
    await settle()
    expect(b.ticks.intervals()).toBe(2)
    clock += 2_000
    b.ticks.fireIntervals()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()

    // Past the watch window the timer disposes itself (only the status interval remains).
    clock += RELOAD_WATCH_MS + 1
    b.ticks.fireIntervals()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()
    expect(b.ticks.intervals()).toBe(1)
    b.controller.dispose()
  })

  it('starts the watch when a run reaches terminal success', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.run': runWire({ mode: 'apply', phase: 'applying', step: 9 }),
    }
    const b = bench({ answers })
    b.controller.mount()
    await settle()
    answers['updateCheck.run'] = runWire({ mode: 'apply', phase: 'success', result: 'success', step: 9 })
    b.ticks.fireIntervals()
    await settle()
    // status + run + reload-watch intervals; the watch is bounded and cleaned on dispose.
    expect(b.ticks.intervals()).toBeGreaterThanOrEqual(2)
    b.controller.dispose()
    expect(b.ticks.intervals()).toBe(0)
  })
})

describe('UpdateController restart detection', () => {
  it('reloads once the server reports a different version after a reconnect', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.start': executingRun,
    }
    const b = bench({ answers })
    b.controller.mount()
    await settle()
    b.controller.start()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()

    answers['updateCheck.status'] = {
      ...availableStatus,
      state: 'current' as const,
      latest: undefined,
      current: { version: '0.1.7-enpoi.2.84', commit: 'def5678', channel: 'stable' },
    }
    b.controller.onConnectionReset()
    await settle()
    expect(b.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(b.storage.values.get(TOAST_KEY)!)).toEqual({ version: '0.1.7-enpoi.2.84' })
    expect(b.storage.values.has(PENDING_KEY)).toBe(false)
    b.controller.dispose()
  })

  it('reloads when the apply reports success even before the version read moves', async () => {
    const succeeded = runWire({ mode: 'apply', phase: 'success', result: 'success', step: 9 })
    // The tab that clicked Restart carries the pending marker; a fresh tab
    // with only a stale success record must not reload.
    const storage = memoryStorage({ [PENDING_KEY]: JSON.stringify({ from: '0.1.7-enpoi.2.81', target: '0.1.7-enpoi.2.84' }) })
    const b = bench({ storage, answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': succeeded } })
    b.controller.mount()
    await settle()
    expect(b.reload).toHaveBeenCalledTimes(1)
    b.controller.dispose()

    const fresh = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': succeeded } })
    fresh.controller.mount()
    await settle()
    expect(fresh.reload).not.toHaveBeenCalled()
    fresh.controller.dispose()
  })

  it('does not reload on an unrelated reconnect while a run is in flight', async () => {
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.start': executingRun } })
    b.controller.mount()
    await settle()
    b.controller.start()
    await settle()
    b.controller.onConnectionReset()
    await settle()
    expect(b.reload).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('shows the stored toast once and consumes the marker', () => {
    const storage = memoryStorage({ [TOAST_KEY]: JSON.stringify({ version: '0.1.7-enpoi.2.84' }) })
    const b = bench({ storage, answers: {} })
    expect(b.controller.store.getSnapshot().toastVersion).toBe('0.1.7-enpoi.2.84')
    expect(storage.values.has(TOAST_KEY)).toBe(false)
    b.controller.toastDone()
    expect(b.controller.store.getSnapshot().toastVersion).toBeNull()
    b.controller.dispose()
  })

  it('picks up a pending marker written before a manual reload', async () => {
    const storage = memoryStorage({ [PENDING_KEY]: JSON.stringify({ from: '0.1.7-enpoi.2.81', target: '0.1.7-enpoi.2.84' }) })
    const b = bench({
      storage,
      answers: {
        'updateCheck.status': {
          ...availableStatus,
          state: 'current' as const,
          latest: undefined,
          current: { version: '0.1.7-enpoi.2.84', commit: 'def5678', channel: 'stable' },
        },
      },
    })
    b.controller.mount()
    await settle()
    expect(b.reload).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })
})
