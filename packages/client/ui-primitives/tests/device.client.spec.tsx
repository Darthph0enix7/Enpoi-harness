// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeviceRuntime, KEYBOARD_ROTATION_GUARD_MS, classifyDevice, getDeviceSnapshot, startDeviceRuntime, useDevice, KEYBOARD_SETTLE_MS,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One controllable visual-viewport stand-in. */
interface FakeVisualViewport {
  height: number
  offsetTop: number
  listeners: Set<() => void>
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  emit(): void
}

let frames: FrameRequestCallback[] = []

function flushFrames(): void {
  const queued = frames
  frames = []
  for (const callback of queued) callback(0)
}

function installAnimationFrames(): void {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => { frames = [] })
}

function installVisualViewport(height: number, offsetTop = 0): FakeVisualViewport {
  const viewport: FakeVisualViewport = {
    height, offsetTop, listeners: new Set(),
    addEventListener: (_type, listener) => { viewport.listeners.add(listener) },
    removeEventListener: (_type, listener) => { viewport.listeners.delete(listener) },
    emit: () => { for (const listener of [...viewport.listeners]) listener() },
  }
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  return viewport
}

function installTouch(maxTouchPoints: number, coarse: boolean): void {
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: () => { /* change events are not exercised here */ },
    removeEventListener: () => { /* symmetric with addEventListener */ },
  }))
}

function installViewportWidth(width: number): void {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', 844)
}

function installScreenSize(width: number, height: number): void {
  Object.defineProperty(window.screen, 'width', { configurable: true, value: width })
  Object.defineProperty(window.screen, 'height', { configurable: true, value: height })
}

beforeEach(() => {
  vi.useFakeTimers()
  installAnimationFrames()
  installTouch(0, false)
  installViewportWidth(1440)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // Object.defineProperty shapes survive unstubAllGlobals; drop them explicitly.
  Reflect.deleteProperty(window, 'visualViewport')
  Reflect.deleteProperty(navigator, 'maxTouchPoints')
  Reflect.deleteProperty(window.screen, 'orientation')
  Reflect.deleteProperty(window.screen, 'width')
  Reflect.deleteProperty(window.screen, 'height')
})

describe('classifyDevice', () => {
  it('classifies a coarse pointer by width: phone, tablet, then desktop', () => {
    expect(classifyDevice({ width: 390, hasTouch: true, coarsePointer: true })).toEqual({ device: 'phone', pointer: 'coarse' })
    expect(classifyDevice({ width: 768, hasTouch: true, coarsePointer: true })).toEqual({ device: 'phone', pointer: 'coarse' })
    expect(classifyDevice({ width: 769, hasTouch: true, coarsePointer: true })).toEqual({ device: 'tablet', pointer: 'coarse' })
    expect(classifyDevice({ width: 1024, hasTouch: false, coarsePointer: true })).toEqual({ device: 'tablet', pointer: 'coarse' })
    expect(classifyDevice({ width: 1025, hasTouch: true, coarsePointer: true })).toEqual({ device: 'desktop', pointer: 'coarse' })
  })

  it('keeps a narrow fine pointer on the desktop layout', () => {
    expect(classifyDevice({ width: 390, hasTouch: false, coarsePointer: false })).toEqual({ device: 'desktop', pointer: 'fine' })
  })

  it('treats a stylus-only coarse pointer as touch', () => {
    expect(classifyDevice({ width: 390, hasTouch: false, coarsePointer: true })).toEqual({ device: 'phone', pointer: 'coarse' })
  })
})

describe('DeviceRuntime', () => {
  it('projects the classifier attributes onto the root element', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    const root = document.documentElement
    expect(root.dataset.device).toBe('phone')
    expect(root.dataset.pointer).toBe('coarse')
    expect(root.getAttribute('data-keyboard')).toBeNull()
    expect(root.style.getPropertyValue('--dsh-keyboard-inset')).toBe('0px')
    stop()
    expect(root.dataset.device).toBeUndefined()
    expect(root.style.getPropertyValue('--dsh-keyboard-inset')).toBe('')
  })

  it('notifies subscribers only when the published state changes', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const listener = vi.fn()
    const unsubscribe = runtime.subscribe(listener)
    const stop = runtime.install()
    expect(listener).toHaveBeenCalledTimes(0)
    vi.stubGlobal('innerWidth', 800)
    window.dispatchEvent(new Event('resize'))
    expect(listener).toHaveBeenCalledTimes(0)
    flushFrames()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.getSnapshot().device).toBe('tablet')
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    vi.stubGlobal('innerWidth', 1280)
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.getSnapshot().device).toBe('desktop')
    stop()
  })

  it('rAF-throttles repeated resize events into one measurement', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    vi.stubGlobal('innerWidth', 800)
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(frames).toHaveLength(1)
    flushFrames()
    expect(runtime.getSnapshot().device).toBe('tablet')
    stop()
  })

  it('opens the keyboard only after the inset holds through the settle delay', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    viewport.emit()
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    vi.advanceTimersByTime(60)
    viewport.height = 844
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(1000)
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    expect(document.documentElement.getAttribute('data-keyboard')).toBeNull()
    viewport.height = 444
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(120)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    expect(runtime.getSnapshot().keyboardInset).toBe(400)
    expect(document.documentElement.dataset.keyboard).toBe('open')
    expect(document.documentElement.style.getPropertyValue('--dsh-keyboard-inset')).toBe('400px')
    expect(document.documentElement.style.getPropertyValue('--dsh-visual-viewport-height')).toBe('444px')
    viewport.height = 844
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(0)
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    expect(document.documentElement.getAttribute('data-keyboard')).toBeNull()
    stop()
  })

  it('reports a resized layout viewport as an open keyboard with no lift', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    vi.stubGlobal('innerHeight', 444)
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    vi.advanceTimersByTime(120)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    // The layout viewport already shrank, so the shell must not lift again.
    expect(runtime.getSnapshot().keyboardInset).toBe(0)
    expect(document.documentElement.style.getPropertyValue('--dsh-keyboard-inset')).toBe('0px')
    vi.stubGlobal('innerHeight', 844)
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
  })

  it('reports an occlusion-free visual viewport as a keyboard without a lift', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    vi.stubGlobal('innerHeight', 444)
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    expect(runtime.getSnapshot().keyboardInset).toBe(0)
    viewport.height = 844
    viewport.emit()
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
  })

  it('drops the lift to zero when the platform pans the visual viewport to its bottom', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    viewport.offsetTop = 400
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    expect(runtime.getSnapshot().keyboardInset).toBe(0)
    stop()
  })

  it('never reports a keyboard on fine-pointer desktops', () => {
    installTouch(0, false)
    installViewportWidth(1440)
    const viewport = installVisualViewport(900)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 500
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(1000)
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
  })

  it('follows media-query changes through the modern listener API', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const listeners: Array<() => void> = []
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: (_type: string, listener: () => void) => { listeners.push(listener) },
      removeEventListener: () => { /* disposal is asserted through the snapshot below */ },
    }))
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    expect(listeners).toHaveLength(2)
    vi.stubGlobal('innerWidth', 1280)
    for (const listener of [...listeners]) listener()
    flushFrames()
    expect(runtime.getSnapshot().device).toBe('desktop')
    stop()
  })

  it('follows media-query changes through the legacy listener API', () => {
    installViewportWidth(390)
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
    const added: Array<() => void> = []
    const removed: Array<() => void> = []
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addListener: (listener: () => void) => { added.push(listener) },
      removeListener: (listener: () => void) => { removed.push(listener) },
    }))
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    expect(added).toHaveLength(2)
    expect(runtime.getSnapshot().device).toBe('phone')
    stop()
    expect(removed).toEqual(added)
  })

  it('installs despite a media query list with no listener API', () => {
    installViewportWidth(390)
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query }))
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    expect(runtime.getSnapshot().device).toBe('phone')
    stop()
  })

  it('installs without a matchMedia implementation', () => {
    installViewportWidth(390)
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
    vi.stubGlobal('matchMedia', undefined)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    expect(runtime.getSnapshot().device).toBe('phone')
    stop()
  })

  it('listens to screen.orientation changes when the API exists', () => {
    installTouch(1, true)
    installViewportWidth(390)
    installScreenSize(390, 844)
    const viewport = installVisualViewport(844)
    const listeners = new Set<() => void>()
    // window.screen, not the testing-library `screen` import this spec also uses.
    Object.defineProperty(window.screen, 'orientation', {
      configurable: true,
      value: {
        addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
        removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
      },
    })
    expect(window.screen.orientation).toBeDefined()
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    expect(listeners.size).toBe(1)
    viewport.height = 390
    viewport.offsetTop = 0
    vi.stubGlobal('innerHeight', 390)
    installScreenSize(844, 390)
    for (const listener of [...listeners]) listener()
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_ROTATION_GUARD_MS)
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('resets the resting viewport from the window orientationchange event', () => {
    installTouch(1, true)
    installViewportWidth(390)
    installScreenSize(390, 844)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 390
    vi.stubGlobal('innerHeight', 390)
    installScreenSize(844, 390)
    window.dispatchEvent(new Event('orientationchange'))
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_ROTATION_GUARD_MS)
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
  })

  it('ignores an orientation event whose display did not change', () => {
    installTouch(1, true)
    installViewportWidth(390)
    installScreenSize(390, 844)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    // A resizes-content keyboard shrinks the viewport without touching the
    // display: the orientation event must not reset the resting height.
    viewport.height = 444
    vi.stubGlobal('innerHeight', 444)
    window.dispatchEvent(new Event('orientationchange'))
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    stop()
  })

  it('holds an occluding keyboard across a display rotation', () => {
    installTouch(1, true)
    installViewportWidth(390)
    installScreenSize(390, 844)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    viewport.emit()
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    expect(runtime.getSnapshot().keyboardInset).toBe(400)
    installScreenSize(844, 390)
    viewport.height = 200
    vi.stubGlobal('innerHeight', 390)
    window.dispatchEvent(new Event('orientationchange'))
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    vi.advanceTimersByTime(KEYBOARD_ROTATION_GUARD_MS)
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    expect(runtime.getSnapshot().keyboardInset).toBe(190)
    viewport.height = 390
    viewport.emit()
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    stop()
  })

  it('resets the resting viewport without a visual viewport API', () => {
    installTouch(1, true)
    installViewportWidth(844)
    installScreenSize(390, 844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    vi.stubGlobal('innerHeight', 390)
    installScreenSize(844, 390)
    window.dispatchEvent(new Event('orientationchange'))
    flushFrames()
    vi.advanceTimersByTime(KEYBOARD_ROTATION_GUARD_MS)
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    expect(runtime.getSnapshot().keyboardInset).toBe(0)
    stop()
  })

  it('ignores dispose before install', () => {
    const runtime = new DeviceRuntime()
    expect(() => { runtime.dispose() }).not.toThrow()
    expect(document.documentElement.dataset.device).toBeUndefined()
  })

  it('coalesces visual-viewport samples through one frame and one settle timer', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    viewport.emit()
    viewport.emit()
    expect(frames).toHaveLength(1)
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    // A second sample inside the settle window must reuse the pending timer.
    viewport.emit()
    flushFrames()
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    vi.advanceTimersByTime(KEYBOARD_SETTLE_MS)
    expect(runtime.getSnapshot().keyboardOpen).toBe(true)
    stop()
  })

  it('drops pending frames and keyboard settling on dispose', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const viewport = installVisualViewport(844)
    const runtime = new DeviceRuntime()
    const stop = runtime.install()
    viewport.height = 444
    viewport.emit()
    flushFrames()
    window.dispatchEvent(new Event('resize'))
    stop()
    vi.advanceTimersByTime(1000)
    expect(runtime.getSnapshot().keyboardOpen).toBe(false)
    expect(document.documentElement.getAttribute('data-keyboard')).toBeNull()
  })

  it('disposes its listeners and is reinstallable', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const first = runtime.install()
    const second = runtime.install()
    second()
    expect(document.documentElement.dataset.device).toBe('phone')
    first()
    expect(document.documentElement.dataset.device).toBeUndefined()
    const third = runtime.install()
    expect(document.documentElement.dataset.device).toBe('phone')
    third()
  })

  it('survives a throwing subscriber', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const runtime = new DeviceRuntime()
    const bad = runtime.subscribe(() => { throw new Error('subscriber down') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => { /* asserted via the call count */ })
    const stop = runtime.install()
    vi.stubGlobal('innerWidth', 1280)
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(error).toHaveBeenCalledTimes(1)
    expect(runtime.getSnapshot().device).toBe('desktop')
    bad()
    stop()
    error.mockRestore()
  })
})

describe('device runtime singleton', () => {
  it('exposes the browser-wide instance and its snapshot', () => {
    installTouch(1, true)
    installViewportWidth(430)
    const stop = startDeviceRuntime()
    expect(getDeviceSnapshot().device).toBe('phone')
    expect(document.documentElement.dataset.device).toBe('phone')
    stop()
  })

  it('reads the current globals when no installation is live', () => {
    installTouch(0, false)
    installViewportWidth(1440)
    expect(getDeviceSnapshot()).toBeDefined()
  })
})

describe('useDevice', () => {
  it('re-renders subscribers when the shared runtime reclassifies', () => {
    installTouch(1, true)
    installViewportWidth(390)
    const stop = startDeviceRuntime()
    function Probe(): ReactNode {
      return <span data-testid="probe">{useDevice().device}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('phone')
    act(() => {
      vi.stubGlobal('innerWidth', 1440)
      window.dispatchEvent(new Event('resize'))
      flushFrames()
    })
    expect(screen.getByTestId('probe').textContent).toBe('desktop')
    stop()
  })
})
