// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLIENT_HEALTH_GLOBAL, installClientHealth, type ClientErrorReport, type ClientHealthOptions,
} from '../src/client-health.ts'

interface HealthGlobalFace {
  fatal(reason: unknown): void
  report(kind: string, message: string, stack?: string): void
}

function healthGlobal(): HealthGlobalFace | undefined {
  return (globalThis as Record<string, unknown>)[CLIENT_HEALTH_GLOBAL] as HealthGlobalFace | undefined
}

/** Minimal in-memory Storage; jsdom sessionStorage is real, but the record must be inspectable. */
function memStorage(seed?: Record<string, unknown>): Storage {
  const map = new Map<string, string>(seed === undefined ? [] : Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    clear: () => { map.clear() },
    key: index => [...map.keys()][index] ?? null,
    get length() { return map.size },
  }
}

interface Bench {
  container: HTMLElement
  reports: ClientErrorReport[]
  reload: ReturnType<typeof vi.fn>
  fallback: ReturnType<typeof vi.fn>
  storage: Storage
  health: ReturnType<typeof installClientHealth>
  clock: { value: number }
}

const cleanups: (() => void)[] = []
let nowValue = 1_000_000

/** Which production defaults a bench keeps instead of its recording seams. */
interface BenchDefaults {
  defaultPostReport?: boolean
  defaultShowFallback?: boolean
  ambientStorage?: boolean
}

function bench(overrides: Partial<ClientHealthOptions> = {}, defaults: BenchDefaults = {}): Bench {
  const container = document.createElement('div')
  document.body.append(container)
  const reports: ClientErrorReport[] = []
  const reload = vi.fn()
  const fallback = vi.fn()
  const storage = memStorage()
  const clock = { value: nowValue }
  const health = installClientHealth({
    container,
    ...(defaults.defaultPostReport === true ? {} : { postReport: (report) => { reports.push(report) } }),
    reload,
    ...(defaults.defaultShowFallback === true ? {} : { showFallback: fallback }),
    ...(defaults.ambientStorage === true ? {} : { storage }),
    now: () => clock.value,
    ...overrides,
  })
  cleanups.push(() => { health.dispose() })
  return { container, reports, reload, fallback, storage, health, clock }
}

/** One healthy mounted workspace: the root anchor with visible content. */
function mountWorkspace(container: HTMLElement): void {
  container.innerHTML = '<div data-slot="root"><div class="shell">workspace</div></div>'
}

function throwError(message: string, stack?: string): Error {
  const error = new Error(message)
  if (stack !== undefined) error.stack = stack
  return error
}

beforeEach(() => {
  vi.useFakeTimers()
  nowValue = 1_000_000
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  Reflect.deleteProperty(globalThis, CLIENT_HEALTH_GLOBAL)
})

describe('breadcrumbs', () => {
  it('reports window error events with kind, message, stack, and url', () => {
    const { reports, health } = bench()
    const error = throwError('render exploded', 'Error: render exploded\n  at frame.ts:1')
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'window.onerror', message: 'render exploded' })
    expect(reports[0]!.stack).toContain('frame.ts:1')
    expect(typeof reports[0]!.url).toBe('string')
    health.dispose()
  })

  it('reports unhandled rejections', () => {
    const { reports } = bench()
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('rejected from a timer')
    window.dispatchEvent(event)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ kind: 'unhandledrejection', message: 'rejected from a timer' })
  })

  it('reports non-Error values by stringification', () => {
    const { reports } = bench()
    window.dispatchEvent(new ErrorEvent('error', { message: 'plain failure' }))
    expect(reports[0]!.message).toBe('plain failure')
  })

  it('dedupes identical messages inside the dedupe window and reports later ones', () => {
    const { reports, clock } = bench()
    window.dispatchEvent(new ErrorEvent('error', { message: 'flaky' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'flaky' }))
    expect(reports).toHaveLength(1)
    clock.value += 30_001
    window.dispatchEvent(new ErrorEvent('error', { message: 'flaky' }))
    expect(reports).toHaveLength(2)
  })

  it('caps reports per rolling minute and recovers capacity with time', () => {
    const { reports, clock } = bench({ reportLimitPerMinute: 2 })
    window.dispatchEvent(new ErrorEvent('error', { message: 'one' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'two' }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'three' }))
    expect(reports.map(report => report.message)).toEqual(['one', 'two'])
    clock.value += 60_001
    window.dispatchEvent(new ErrorEvent('error', { message: 'four' }))
    expect(reports.map(report => report.message)).toEqual(['one', 'two', 'four'])
  })

  it('bounds oversized messages and stacks', () => {
    const { reports } = bench()
    const error = throwError('x'.repeat(5000), 'y'.repeat(5000))
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    expect(reports[0]!.message).toHaveLength(4000)
    expect(reports[0]!.stack).toHaveLength(1000)
  })

  it('drops the oldest dedupe entries once the bound is reached', () => {
    const { reports, clock } = bench({ reportLimitPerMinute: 1000, reportDedupeMs: 0 })
    for (let index = 0; index < 205; index += 1) {
      clock.value += 1
      window.dispatchEvent(new ErrorEvent('error', { message: `failure-${String(index)}` }))
    }
    clock.value += 1
    window.dispatchEvent(new ErrorEvent('error', { message: 'failure-0' }))
    expect(reports).toHaveLength(206)
  })

  it('swallows a throwing reporter', () => {
    const { health } = bench({ postReport: () => { throw new Error('reporter down') } })
    expect(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'still fine' }))
    }).not.toThrow()
    health.dispose()
  })

  it('posts through the default diagnostics.report transport', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { health } = bench({}, { defaultPostReport: true })
    window.dispatchEvent(new ErrorEvent('error', { message: 'transport probe' }))
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('default transport never ran')
    const [url, init] = call
    expect(url).toBe('/api/diagnostics.report')
    const body = JSON.parse(init.body as string) as {
      type: string
      method: string
      payload: { args: { request: ClientErrorReport } }
    }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('diagnostics.report')
    expect(body.payload.args.request).toMatchObject({ message: 'transport probe' })
    health.dispose()
  })

  it('keeps the page alive when the default transport rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { health } = bench({}, { defaultPostReport: true })
    window.dispatchEvent(new ErrorEvent('error', { message: 'offline probe' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(() => { health.checkNow() }).not.toThrow()
  })
})

describe('fatal recovery', () => {
  it('reloads once and posts the fatal breadcrumb', () => {
    const { reports, reload, health } = bench()
    expect(health.fatal(throwError('root crashed'))).toBe('reload')
    expect(reload).toHaveBeenCalledOnce()
    expect(reports[0]).toMatchObject({ kind: 'renderer.fatal', message: 'root crashed' })
  })

  it('suppresses a second reload inside the cooldown and shows the fallback', () => {
    const { reload, fallback, health } = bench()
    health.fatal(throwError('first'))
    expect(health.fatal(throwError('second'))).toBe('fallback')
    expect(reload).toHaveBeenCalledOnce()
    expect(fallback).toHaveBeenCalledOnce()
    expect(String(fallback.mock.calls[0]![0])).toContain('second')
  })

  it('allows a reload again after the cooldown', () => {
    const { reload, health, clock } = bench()
    health.fatal(throwError('first'))
    clock.value += 30_000
    expect(health.fatal(throwError('second'))).toBe('reload')
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('stops reloading after the rolling cap and keeps the fallback', () => {
    const { storage, reload, fallback, health, clock } = bench({ maxReloadsPerWindow: 2 })
    health.fatal(throwError('one'))
    clock.value += 30_000
    health.fatal(throwError('two'))
    clock.value += 30_000
    expect(health.fatal(throwError('three'))).toBe('fallback')
    expect(reload).toHaveBeenCalledTimes(2)
    expect(fallback).toHaveBeenCalledOnce()
    expect(storage.getItem('dsh.clientHealth.reloads')).not.toBeNull()
  })

  it('treats an out-of-window record as a fresh window', () => {
    const now = 1_000_000
    const { reload, health } = bench({
      storage: memStorage({ 'dsh.clientHealth.reloads': { t: now - 700_000, n: 9 } }),
    })
    expect(health.fatal(throwError('after a long stable run'))).toBe('reload')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('grants the reload on a malformed record', () => {
    const storage = memStorage()
    storage.setItem('dsh.clientHealth.reloads', '"junk"')
    const { reload, health } = bench({ storage })
    expect(health.fatal(throwError('malformed record'))).toBe('reload')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('denies auto-reload when no guard storage is available', () => {
    const { reload, fallback, health } = bench({ storage: null })
    expect(health.fatal(throwError('no storage'))).toBe('fallback')
    expect(reload).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('denies auto-reload when guard storage fails', () => {
    const throwing = memStorage()
    throwing.getItem = () => { throw new Error('blocked') }
    const { reload, fallback, health } = bench({ storage: throwing })
    expect(health.fatal(throwError('storage blocked'))).toBe('fallback')
    expect(reload).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('denies auto-reload when the guard write fails', () => {
    const throwing = memStorage()
    throwing.setItem = () => { throw new Error('quota') }
    const { reload, fallback, health } = bench({ storage: throwing })
    expect(health.fatal(throwError('quota'))).toBe('fallback')
    expect(reload).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('draws the kernel failure card as the default fallback', () => {
    const { container, health } = bench({ storage: null }, { defaultShowFallback: true })
    expect(health.fatal(throwError('card please'))).toBe('fallback')
    const card = container.querySelector('[data-dsh-boot]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('card please')
  })

  it('ignores fatal calls after disposal', () => {
    const { reload, health } = bench()
    health.dispose()
    expect(health.fatal(throwError('late'))).toBe('ignored')
    expect(reload).not.toHaveBeenCalled()
  })

  it('exposes a page-global fatal face and retracts it on disposal', () => {
    const { reload, health } = bench()
    healthGlobal()!.fatal(throwError('from the boundary'))
    expect(reload).toHaveBeenCalledOnce()
    health.dispose()
    expect(healthGlobal()).toBeUndefined()
  })

  it('exposes a report-only breadcrumb face for contained failures', () => {
    const { reports, reload, health, clock } = bench()
    const face = healthGlobal()
    expect(face).toBeDefined()
    face?.report('renderer.slot-crash', "slot 'composer' crashed: boom", 'Error: boom\n  at panel.ts:1')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      kind: 'renderer.slot-crash',
      message: "slot 'composer' crashed: boom",
      stack: 'Error: boom\n  at panel.ts:1',
    })
    // Reporting is advisory: contained crashes never trigger the recovery reload.
    expect(reload).not.toHaveBeenCalled()
    clock.value += 1
    face?.report('renderer.slot-crash', 'second contained crash')
    expect(reports).toHaveLength(2)
    expect(reload).not.toHaveBeenCalled()
    health.dispose()
  })

  it('uses ambient sessionStorage by default', () => {
    sessionStorage.clear()
    const { reload, health } = bench({}, { ambientStorage: true })
    expect(health.fatal(throwError('ambient'))).toBe('reload')
    expect(reload).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('dsh.clientHealth.reloads')).not.toBeNull()
    health.dispose()
  })
})

describe('watchdog', () => {
  it('reloads a blank workspace on tab return', () => {
    const { container, reload, health, clock } = bench()
    mountWorkspace(container)
    health.markBootComplete()
    clock.value += 2_000
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).not.toHaveBeenCalled()
    container.replaceChildren()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('treats an abdicated root cell as blank', () => {
    const { container, reload, health, clock } = bench()
    container.innerHTML = '<div data-slot-error="root"></div>'
    health.markBootComplete()
    clock.value += 2_000
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('treats a root anchor with only error markers as blank', () => {
    const { container, reload, health, clock } = bench()
    container.innerHTML = '<div data-slot="root"><div data-slot-error="root"></div></div>'
    health.markBootComplete()
    clock.value += 2_000
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('accepts a root anchor holding only text', () => {
    const { container, reload, health, clock } = bench()
    container.innerHTML = '<div data-slot="root">plain text workspace</div>'
    health.markBootComplete()
    clock.value += 2_000
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).not.toHaveBeenCalled()
  })

  it('treats a boot card that survived the settle window as a stall', () => {
    const { container, reload, health, clock } = bench()
    container.innerHTML = '<div data-dsh-boot=""></div>'
    health.markBootComplete()
    clock.value += 2_000
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('stays silent inside the post-mount settle window', () => {
    const { reload, health, clock } = bench()
    health.markBootComplete()
    clock.value += 1_000
    expect(health.checkNow()).toBe(false)
    clock.value += 1_000
    expect(health.checkNow()).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('ignores hidden-tab visibility events', () => {
    const { reload, health, clock } = bench()
    health.markBootComplete()
    clock.value += 2_000
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads a boot that passes the hard deadline', () => {
    const { reload, health } = bench({ bootDeadlineMs: 100 })
    vi.advanceTimersByTime(100)
    expect(reload).toHaveBeenCalledOnce()
    expect(health.checkNow()).toBe(false)
  })

  it('leaves a completed boot alone at the deadline', () => {
    const { reload, health } = bench({ bootDeadlineMs: 100 })
    health.markBootComplete()
    vi.advanceTimersByTime(100)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reports an overdue boot when probed directly', () => {
    const { reload, health, clock } = bench({ bootDeadlineMs: 100 })
    clock.value += 100
    expect(health.checkNow()).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('stands down after a visible boot failure', () => {
    const { reload, health } = bench({ bootDeadlineMs: 100 })
    health.markBootFailed()
    expect(health.checkNow()).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('runs one settle probe after mount', () => {
    const { container, reload, health, clock } = bench()
    mountWorkspace(container)
    health.markBootComplete()
    container.replaceChildren()
    clock.value += 2_000
    vi.advanceTimersByTime(2_000)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('leaves a healthy workspace untouched across probes and deadlines', () => {
    const { container, reload, health, clock } = bench()
    mountWorkspace(container)
    health.markBootComplete()
    clock.value += 2_000
    expect(health.checkNow()).toBe(false)
    vi.advanceTimersByTime(120_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('removes listeners, timers, and the global on disposal', () => {
    const { reload, reports, health } = bench({ bootDeadlineMs: 100 })
    expect(healthGlobal()).toBeDefined()
    health.dispose()
    health.dispose()
    expect(healthGlobal()).toBeUndefined()
    window.dispatchEvent(new ErrorEvent('error', { message: 'after dispose' }))
    vi.advanceTimersByTime(1_000)
    expect(reports).toHaveLength(0)
    expect(reload).not.toHaveBeenCalled()
  })
})
