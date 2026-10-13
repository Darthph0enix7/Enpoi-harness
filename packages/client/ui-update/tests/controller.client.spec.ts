// @vitest-environment jsdom
/**
 * UpdateController: poll cadence (mount, 60 s visible-only, focus/visibility
 * with a gap), run polling only while active, the start/dismiss actions, the
 * restart detection through `connection/reset`, and the one-time toast
 * marker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PENDING_KEY,
  STATUS_POLL_MS,
  TOAST_KEY,
  TRIGGER_MIN_GAP_MS,
  UpdateController,
  type UpdateDom,
  type UpdateStorage,
  type UpdateTimers,
} from '../src/client/controller.ts'
import { updateCheckRpc, type UpdateRpcResult } from '../src/client/rpc.ts'

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

const activeRun = {
  runId: 'run1',
  target: '0.1.7-enpoi.2.84',
  channel: 'stable',
  phase: 'starting' as const,
  step: 1,
  steps: 9,
  lastLine: '[1/9] environment',
  startedAt: '2026-10-13T12:00:00.000Z',
  pid: 4242,
  logPath: '/home/dsh/update-check/run.log',
  result: null,
  rung: 'setsid',
  logTail: [],
}

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
  it('polls status on mount, on the 60 s interval, and on focus, never inside the trigger gap', async () => {
    let clock = 1_000
    const b = bench({ answers: { 'updateCheck.status': availableStatus }, now: () => clock })
    b.controller.mount()
    expect(b.calls).toEqual([{ method: 'updateCheck.status', args: {} }])
    expect(STATUS_POLL_MS).toBe(60_000)
    await b.controller.refreshStatus()

    // A visibility restore inside the trigger gap adds no call.
    b.doc.fire('visibilitychange')
    expect(b.calls).toHaveLength(1)

    // The 60 s interval polls again.
    b.ticks.fireIntervals()
    expect(b.calls).toHaveLength(2)
    await b.controller.refreshStatus()

    // Focus inside the gap is price-free; after the gap it reads once more.
    b.win.fire('focus')
    expect(b.calls).toHaveLength(2)
    clock += TRIGGER_MIN_GAP_MS + 1
    b.win.fire('focus')
    expect(b.calls).toHaveLength(3)
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
    expect(calls).toEqual(['updateCheck.status'])
    ticks.fireIntervals()
    expect(calls).toHaveLength(1)
    hidden.fire('visibilitychange')
    expect(calls).toHaveLength(1)
    controller.dispose()
    expect(ticks.intervals()).toBe(0)
  })

  it('reads the run on open and polls it while active, stopping at the terminal result', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.run': activeRun,
    }
    const b = bench({ answers })
    b.controller.mount()
    await settle()
    b.controller.open()
    expect(b.calls.map(call => call.method)).toEqual(['updateCheck.status', 'updateCheck.run'])
    // Active run starts the 2 s poll.
    await settle()
    expect(b.ticks.intervals()).toBe(2)
    answers['updateCheck.run'] = { ...activeRun, result: 'success', phase: 'done', step: 9 }
    b.ticks.fireIntervals()
    await settle()
    expect(b.controller.store.getSnapshot().run?.result).toBe('success')
    // A terminal run stops the 2 s poll; only the status interval remains.
    expect(b.ticks.intervals()).toBe(1)
    b.controller.dispose()
  })

  it('does not poll the run while closed and terminal', async () => {
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.run': null } })
    b.controller.mount()
    b.controller.close()
    await Promise.resolve()
    expect(b.ticks.intervals()).toBe(1)
    b.controller.dispose()
  })
})

describe('UpdateController actions', () => {
  it('start pins the pre-run version and begins following the fresh run', async () => {
    const b = bench({
      answers: {
        'updateCheck.status': availableStatus,
        'updateCheck.start': activeRun,
      },
    })
    b.controller.mount()
    await Promise.resolve()
    b.controller.start()
    await Promise.resolve()
    await Promise.resolve()
    const state = b.controller.store.getSnapshot()
    expect(state.run?.runId).toBe('run1')
    expect(state.busy).toBe(false)
    expect(state.dialogOpen).toBe(true)
    expect(JSON.parse(b.storage.values.get(PENDING_KEY)!)).toEqual({
      from: '0.1.7-enpoi.2.81',
      target: '0.1.7-enpoi.2.84',
    })
    b.controller.dispose()
  })

  it('surfaces a refused start as the action error', async () => {
    const b = bench({ rpcError: 'an update is already running' })
    b.controller.mount()
    b.controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.controller.store.getSnapshot()).toMatchObject({
      busy: false,
      actionError: 'an update is already running',
    })
    b.controller.dispose()
  })

  it('skip dismisses the latest version and closes the dialog', async () => {
    const dismissed = { ...availableStatus, state: 'dismissed' as const }
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.dismiss': dismissed } })
    b.controller.mount()
    await Promise.resolve()
    b.controller.open()
    b.controller.skip()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.calls.at(-1)).toEqual({ method: 'updateCheck.dismiss', args: { version: '0.1.7-enpoi.2.84' } })
    expect(b.controller.store.getSnapshot()).toMatchObject({ status: { state: 'dismissed' }, dialogOpen: false })
    b.controller.dispose()
  })

  it('ignores skip when no release is offered', async () => {
    const b = bench({ answers: { 'updateCheck.status': { ...availableStatus, state: 'current', latest: undefined } } })
    b.controller.mount()
    b.controller.skip()
    await Promise.resolve()
    expect(b.calls).toHaveLength(1)
    b.controller.dispose()
  })
})

describe('UpdateController restart detection', () => {
  it('reloads once the server reports a different version after a reconnect', async () => {
    const answers: Record<string, unknown> = {
      'updateCheck.status': availableStatus,
      'updateCheck.start': activeRun,
    }
    const b = bench({ answers })
    b.controller.mount()
    await Promise.resolve()
    b.controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.reload).not.toHaveBeenCalled()

    answers['updateCheck.status'] = {
      ...availableStatus,
      state: 'current' as const,
      latest: undefined,
      current: { version: '0.1.7-enpoi.2.84', commit: 'def5678', channel: 'stable' },
    }
    b.controller.onConnectionReset()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.reload).toHaveBeenCalledTimes(1)
    expect(JSON.parse(b.storage.values.get(TOAST_KEY)!)).toEqual({ version: '0.1.7-enpoi.2.84' })
    expect(b.storage.values.has(PENDING_KEY)).toBe(false)
    b.controller.dispose()
  })

  it('does not reload on an unrelated reconnect while a run is in flight', async () => {
    const b = bench({ answers: { 'updateCheck.status': availableStatus, 'updateCheck.start': activeRun } })
    b.controller.mount()
    await Promise.resolve()
    b.controller.start()
    await Promise.resolve()
    await Promise.resolve()
    b.controller.onConnectionReset()
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()
    await Promise.resolve()
    expect(b.reload).toHaveBeenCalledTimes(1)
    b.controller.dispose()
  })
})
