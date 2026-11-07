// @vitest-environment jsdom
/**
 * Menu portal placement lifetime: a short post-open settling burst plus
 * resize/scroll signals replace the former unbounded animation-frame loop.
 * Every frame below is a deterministic counter, never wall-clock time.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function installFrames() {
  let nextId = 0
  const pending = new Map<number, FrameRequestCallback>()
  const requested: number[] = []
  const cancelled: number[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = ++nextId
    pending.set(id, callback)
    requested.push(id)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelled.push(id)
    pending.delete(id)
  })
  const runFrame = (): boolean => {
    const next = pending.entries().next()
    if (next.done === true) return false
    const [id, callback] = next.value
    pending.delete(id)
    act(() => { callback(0) })
    return true
  }
  return {
    requested,
    cancelled,
    runFrame,
    runAll(limit = 20): number {
      let count = 0
      while (count < limit && runFrame()) count += 1
      return count
    },
    pending: (): number => pending.size,
  }
}

function installResizeObserver() {
  const observes: Element[] = []
  let disconnects = 0
  class FakeResizeObserver {
    observe(element: Element): void { observes.push(element) }
    unsubscribe(): void { /* unused */ }
    disconnect(): void { disconnects += 1 }
    unobserve(): void { /* unused */ }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  return { observes, disconnects: (): number => disconnects }
}

function menu(open: boolean) {
  return (
    <Menu
      open={open}
      anchor={<button type="button">Open</button>}
      items={[{ id: 'action', label: 'Action' }]}
      onClose={() => { /* owner-controlled close */ }}
      portal
    />
  )
}

describe('Menu placement tracking', () => {
  it('stops requesting frames after the post-open settling burst', () => {
    const frames = installFrames()
    installResizeObserver()
    const view = render(menu(true))
    expect(frames.requested).toHaveLength(1)
    expect(frames.runAll()).toBe(4)
    expect(frames.requested).toHaveLength(4)
    expect(frames.pending()).toBe(0)
    // Nothing moves, so no further frame is requested.
    expect(frames.runAll()).toBe(0)
    expect(frames.requested).toHaveLength(4)
    view.unmount()
  })

  it('cancels a pending settling frame when the menu closes', () => {
    const frames = installFrames()
    installResizeObserver()
    const view = render(menu(true))
    act(() => { frames.runFrame() })
    expect(frames.pending()).toBeGreaterThan(0)
    view.rerender(menu(false))
    expect(frames.cancelled.length).toBeGreaterThan(0)
    expect(frames.pending()).toBe(0)
  })

  it('observes the anchor and panel and disconnects on close', () => {
    installFrames()
    const observer = installResizeObserver()
    const view = render(menu(true))
    expect(observer.observes).toHaveLength(2)
    view.rerender(menu(false))
    expect(observer.disconnects()).toBeGreaterThan(0)
  })
})
