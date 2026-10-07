/** Browser network and wake-event wiring for connection recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../src/client/connection.ts'
import {
  WAKE_RECONNECT_DEBOUNCE_MS,
  WAKE_STALE_THRESHOLD_MS,
  watchBrowserNetwork,
} from '../src/client/network-watch.ts'

class WindowProbe extends EventTarget {
  readonly navigator = { onLine: true }

  setOnline(online: boolean): void {
    this.navigator.onLine = online
    this.dispatchEvent(new Event(online ? 'online' : 'offline'))
  }
}

function createController(stale = false): {
  setNetworkAvailable: ReturnType<typeof vi.fn<(available: boolean) => void>>
  reconnect: ReturnType<typeof vi.fn<() => void>>
  isProbablyStale: ReturnType<typeof vi.fn<(thresholdMs: number) => boolean>>
} {
  return {
    setNetworkAvailable: vi.fn<(available: boolean) => void>(),
    reconnect: vi.fn<() => void>(),
    isProbablyStale: vi.fn<(thresholdMs: number) => boolean>(() => stale),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('browser network watch', () => {
  it('no-ops in a runtime without a browser window', () => {
    const controller = createController()
    watchBrowserNetwork(controller, () => undefined)()
    expect(controller.setNetworkAvailable).not.toHaveBeenCalled()
    expect(controller.reconnect).not.toHaveBeenCalled()
  })

  it('does not bind a window without a navigator', () => {
    vi.stubGlobal('window', new EventTarget())
    const controller = createController()
    watchBrowserNetwork(controller, () => undefined)()
    expect(controller.setNetworkAvailable).not.toHaveBeenCalled()
  })

  it('does not bind a navigator without an onLine state', () => {
    vi.stubGlobal('window', { navigator: {} })
    const controller = createController()
    watchBrowserNetwork(controller, () => undefined)()
    expect(controller.setNetworkAvailable).not.toHaveBeenCalled()
  })

  it('publishes the initial network state and follows online/offline transitions', () => {
    const win = new WindowProbe()
    win.navigator.onLine = false
    vi.stubGlobal('window', win)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => undefined)

    expect(controller.setNetworkAvailable.mock.calls).toEqual([[false]])
    win.setOnline(true)
    expect(controller.setNetworkAvailable).toHaveBeenLastCalledWith(true)
    win.setOnline(false)
    expect(controller.setNetworkAvailable).toHaveBeenLastCalledWith(false)
    dispose()
  })

  it('ignores a visibilitychange while the document is not visible', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    doc.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 2)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    dispose()
  })

  it('wakes on a visible visibilitychange and on pageshow', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    doc.dispatchEvent(new Event('visibilitychange'))
    expect(controller.reconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)

    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('merges a burst of wake events into one reconnect attempt', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'connecting')

    win.dispatchEvent(new Event('pageshow'))
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS - 1)
    win.dispatchEvent(new Event('pageshow'))
    expect(controller.reconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 10)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('does not wake while a connected generation has recent inbound activity', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController()
    let state: ConnectionState | undefined = 'connected'
    const dispose = watchBrowserNetwork(controller, () => state)

    win.dispatchEvent(new Event('pageshow'))
    doc.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 10)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(controller.isProbablyStale).toHaveBeenCalledWith(WAKE_STALE_THRESHOLD_MS)
    expect(vi.getTimerCount()).toBe(0)

    state = 'connecting'
    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('wakes a connected generation whose inbound activity went stale', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController(true)
    const dispose = watchBrowserNetwork(controller, () => 'connected')

    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pageshow'))
    expect(controller.reconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)

    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('re-checks staleness when the debounce elapses', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    vi.stubGlobal('window', win)
    const controller = createController(true)
    const dispose = watchBrowserNetwork(controller, () => 'connected')

    win.dispatchEvent(new Event('pageshow'))
    controller.isProbablyStale.mockReturnValue(false)
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).not.toHaveBeenCalled()

    controller.isProbablyStale.mockReturnValue(true)
    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('re-checks health when the debounce elapses', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    vi.stubGlobal('window', win)
    const controller = createController()
    let state: ConnectionState | undefined = 'connecting'
    const dispose = watchBrowserNetwork(controller, () => state)

    win.dispatchEvent(new Event('pageshow'))
    state = 'connected'
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).not.toHaveBeenCalled()
    dispose()
  })

  it('does not wake before the first attempt has an outcome', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    vi.stubGlobal('window', win)
    const controller = createController()
    let state: ConnectionState | undefined
    const dispose = watchBrowserNetwork(controller, () => state)

    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 2)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    // A scheduled attempt is dropped when the outcome is retracted before it fires.
    state = 'connecting'
    win.dispatchEvent(new Event('pageshow'))
    state = undefined
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).not.toHaveBeenCalled()
    dispose()
  })

  it('does not schedule a wake while the browser reports offline', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    win.navigator.onLine = false
    vi.stubGlobal('window', win)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    win.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 2)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    dispose()
  })

  it('cancels a pending wake when the browser goes offline', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    vi.stubGlobal('window', win)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    win.dispatchEvent(new Event('pageshow'))
    win.setOnline(false)
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 2)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(controller.setNetworkAvailable).toHaveBeenLastCalledWith(false)
    expect(vi.getTimerCount()).toBe(0)
    dispose()
  })

  it('drops a scheduled wake that fires after the browser reports offline', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    vi.stubGlobal('window', win)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    win.dispatchEvent(new Event('pageshow'))
    win.navigator.onLine = false
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS)
    expect(controller.reconnect).not.toHaveBeenCalled()
    dispose()
  })

  it('removes every listener and cancels a pending wake on dispose', () => {
    vi.useFakeTimers()
    const win = new WindowProbe()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', doc)
    const controller = createController()
    const dispose = watchBrowserNetwork(controller, () => 'disconnected')

    win.dispatchEvent(new Event('pageshow'))
    doc.dispatchEvent(new Event('visibilitychange'))
    dispose()
    expect(vi.getTimerCount()).toBe(0)

    win.dispatchEvent(new Event('pageshow'))
    doc.dispatchEvent(new Event('visibilitychange'))
    win.setOnline(false)
    vi.advanceTimersByTime(WAKE_RECONNECT_DEBOUNCE_MS * 2)
    expect(controller.reconnect).not.toHaveBeenCalled()
    expect(controller.setNetworkAvailable.mock.calls).toEqual([[true]])
  })
})
