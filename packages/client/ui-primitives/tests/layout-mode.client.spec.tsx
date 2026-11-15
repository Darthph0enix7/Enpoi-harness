// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLayoutModeRuntime, LAYOUT_BREAKPOINTS, LayoutModeRuntime,
  resolveLayoutMode, startLayoutModeRuntime, useLayoutMode,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeviceSnapshot, DeviceSource } from '@deepseek-ai/dsh-client-ui-primitives'

/** One matchMedia stand-in with a controllable coarse-pointer answer. */
function installPointer(coarse: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: () => { /* change events are not exercised here */ },
    removeEventListener: () => { /* symmetric with addEventListener */ },
  }))
}

function installViewport(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
}

/** One controllable device source, exposing the resting height the layout mode reads. */
function fakeDevice(initial: Partial<DeviceSnapshot> = {}): {
  readonly source: DeviceSource
  update(next: Partial<DeviceSnapshot>): void
} {
  let snapshot: DeviceSnapshot = {
    device: 'desktop', pointer: 'fine', width: 1440, restingHeight: 900,
    keyboardOpen: false, keyboardInset: 0, ...initial,
  }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    update: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

beforeEach(() => {
  installPointer(false)
  installViewport(1440, 900)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-layout')
  document.documentElement.removeAttribute('data-keyboard')
})

describe('resolveLayoutMode', () => {
  it('keeps desktop frames desktop at 1440 and landscape 1024', () => {
    expect(resolveLayoutMode({ frameWidth: 1440, viewportHeight: 900, coarsePointer: false })).toBe('desktop')
    expect(resolveLayoutMode({ frameWidth: 1024, viewportHeight: 768, coarsePointer: false })).toBe('desktop')
  })

  it('selects compact for narrow, portrait, and short coarse frames', () => {
    expect(resolveLayoutMode({ frameWidth: 800, viewportHeight: 1100, coarsePointer: false })).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: 390, viewportHeight: 844, coarsePointer: false })).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: 1024, viewportHeight: 1366, coarsePointer: false })).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: 844, viewportHeight: 390, coarsePointer: true })).toBe('compact')
  })

  it('does not use a narrow landscape fine-pointer window as a phone portrait signal', () => {
    expect(resolveLayoutMode({ frameWidth: 1099, viewportHeight: 800, coarsePointer: false })).toBe('desktop')
    expect(resolveLayoutMode({ frameWidth: 1100, viewportHeight: 800, coarsePointer: false })).toBe('desktop')
  })

  it('holds compact until each boundary clears the 24px hysteresis', () => {
    expect(resolveLayoutMode({ frameWidth: 899, viewportHeight: 900, coarsePointer: false }, 'desktop')).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: 900, viewportHeight: 900, coarsePointer: false }, 'desktop')).toBe('desktop')
    expect(resolveLayoutMode({ frameWidth: 900, viewportHeight: 900, coarsePointer: false }, 'compact')).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: LAYOUT_BREAKPOINTS.compactWidth + 24, viewportHeight: 900, coarsePointer: false }, 'compact')).toBe('desktop')
    expect(resolveLayoutMode({ frameWidth: 920, viewportHeight: 1100, coarsePointer: false }, 'compact')).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: LAYOUT_BREAKPOINTS.portraitWidth + 24, viewportHeight: 1100, coarsePointer: false }, 'compact')).toBe('desktop')
    expect(resolveLayoutMode({ frameWidth: 950, viewportHeight: LAYOUT_BREAKPOINTS.shortHeight + 23, coarsePointer: true }, 'compact')).toBe('compact')
    expect(resolveLayoutMode({ frameWidth: 950, viewportHeight: LAYOUT_BREAKPOINTS.shortHeight + 24, coarsePointer: true }, 'compact')).toBe('desktop')
  })
})

describe('LayoutModeRuntime', () => {
  it('projects data-layout and removes it on the last release', () => {
    const runtime = new LayoutModeRuntime(fakeDevice().source)
    const stop = runtime.install()
    expect(document.documentElement.dataset.layout).toBe('desktop')
    runtime.setFrameWidth(800)
    expect(document.documentElement.dataset.layout).toBe('compact')
    stop()
    expect(document.documentElement.hasAttribute('data-layout')).toBe(false)
  })

  it('reference-counts installations so HMR or a replacement frame does not strand the projection', () => {
    const runtime = new LayoutModeRuntime(fakeDevice().source)
    const first = runtime.install()
    const second = runtime.install()
    first()
    expect(document.documentElement.dataset.layout).toBe('desktop')
    second()
    expect(document.documentElement.hasAttribute('data-layout')).toBe(false)
  })

  it('keeps desktop when Android resizes before the keyboard marker and closes without another resize', () => {
    const device = fakeDevice({ pointer: 'coarse', restingHeight: 768 })
    const runtime = new LayoutModeRuntime(device.source)
    const stop = runtime.install()
    runtime.setFrameWidth(1024)
    expect(runtime.getSnapshot().mode).toBe('desktop')
    // The layout viewport shrinks but the device runtime has not published
    // `data-keyboard` yet. The layout mode must not adopt 400 as resting.
    vi.stubGlobal('innerHeight', 400)
    window.dispatchEvent(new Event('resize'))
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'desktop', viewportHeight: 768 })
    device.update({ keyboardOpen: true })
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'desktop', viewportHeight: 768 })
    // Closing without a second resize must not leave the shell compact.
    device.update({ keyboardOpen: false })
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'desktop', viewportHeight: 768 })
    stop()
  })

  it('keeps a portrait frame compact across a keyboard shrink', () => {
    const device = fakeDevice({ pointer: 'coarse', restingHeight: 844 })
    const runtime = new LayoutModeRuntime(device.source)
    const stop = runtime.install()
    runtime.setFrameWidth(800)
    expect(runtime.getSnapshot().mode).toBe('compact')
    device.update({ keyboardOpen: true, restingHeight: 844 })
    expect(runtime.getSnapshot().mode).toBe('compact')
    device.update({ keyboardOpen: false })
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'compact', viewportHeight: 844 })
    stop()
  })

  it('adopts a real orientation resting height while the keyboard is open', () => {
    const device = fakeDevice({ pointer: 'coarse', restingHeight: 768 })
    const runtime = new LayoutModeRuntime(device.source)
    const stop = runtime.install()
    runtime.setFrameWidth(1024)
    expect(runtime.getSnapshot().mode).toBe('desktop')
    device.update({ keyboardOpen: true, restingHeight: 400 })
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'compact', viewportHeight: 400 })
    device.update({ keyboardOpen: true, restingHeight: 768 })
    expect(runtime.getSnapshot()).toMatchObject({ mode: 'desktop', viewportHeight: 768 })
    stop()
  })

  it('notifies subscribers on a mode change and exposes the shared reading', () => {
    const runtime = new LayoutModeRuntime(fakeDevice().source)
    const stop = runtime.install()
    const seen: string[] = []
    const release = runtime.subscribe(() => { seen.push(runtime.getSnapshot().mode) })
    runtime.setFrameWidth(390)
    expect(seen).toEqual(['compact'])
    expect(runtime.getSnapshot().mode).toBe('compact')
    release()
    stop()
  })
})

function ModeProbe() {
  return <span data-testid="mode">{useLayoutMode()}</span>
}

describe('useLayoutMode', () => {
  it('reacts to the shared runtime without a second width guess', () => {
    const stop = startLayoutModeRuntime()
    const runtime = getLayoutModeRuntime()
    runtime.setFrameWidth(1440)
    render(<ModeProbe />)
    expect(screen.getByTestId('mode').textContent).toBe('desktop')
    act(() => { runtime.setFrameWidth(800) })
    expect(screen.getByTestId('mode').textContent).toBe('compact')
    act(() => { runtime.setFrameWidth(1440) })
    expect(screen.getByTestId('mode').textContent).toBe('desktop')
    stop()
  })
})
