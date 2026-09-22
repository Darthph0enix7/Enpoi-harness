// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BackStack, Modal, backStack, registerBackSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Dispatch one popstate carrying a whole history record, as a traversal delivers it. */
function dispatchState(state: unknown): void {
  window.dispatchEvent(new PopStateEvent('popstate', { state }))
}

/** The state object of the pushState record at one index (0-based). */
function pushedState(index: number): unknown {
  const call = vi.mocked(window.history.pushState).mock.calls[index]
  if (call === undefined) throw new Error(`no pushState call at index ${String(index)}`)
  return call[0]
}

/** Classify this bench as a phone so `useBackHandler` registers. */
function installPhoneEnvironment(): void {
  vi.stubGlobal('innerWidth', 390)
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    addEventListener: () => { /* the classification re-read is the tested path */ },
    removeEventListener: () => { /* symmetric with addEventListener */ },
  }))
}

let back: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.spyOn(window.history, 'pushState')
  back = vi.spyOn(window.history, 'back').mockImplementation(() => { /* jsdom traversal is not driven here */ })
})

afterEach(() => {
  backStack.clear()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'maxTouchPoints')
  vi.restoreAllMocks()
  cleanup()
})

describe('BackStack', () => {
  it('closes one surface per back press, LIFO, and leaves native history after the stack empties', () => {
    const stack = new BackStack()
    const sheet = vi.fn()
    const modal = vi.fn()
    const sheetOff = stack.register('sheet', sheet)
    const modalOff = stack.register('modal', modal)
    expect(window.history.pushState).toHaveBeenCalledTimes(2)
    expect(stack.depth()).toBe(2)
    // One real back press lands on the sheet's record with the modal still open.
    dispatchState(pushedState(0))
    expect(modal).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()
    expect(stack.depth()).toBe(1)
    // The next lands on the application's own record.
    dispatchState(null)
    expect(sheet).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    // Empty stack: a further press must not throw or consume anything.
    dispatchState(null)
    expect(back).not.toHaveBeenCalled()
    modalOff()
    sheetOff()
  })

  it('closes each of three stacked surfaces across three presses', () => {
    const stack = new BackStack()
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    stack.register('first', first)
    stack.register('second', second)
    const thirdOff = stack.register('third', third)
    dispatchState(pushedState(1))
    dispatchState(pushedState(0))
    dispatchState(null)
    expect(third).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    thirdOff()
  })

  it('ignores forward navigation into a released record', () => {
    const stack = new BackStack()
    const dismiss = vi.fn()
    const off = stack.register('modal', dismiss)
    dispatchState({ dsh_surface_depth: 2 })
    expect(dismiss).not.toHaveBeenCalled()
    expect(stack.depth()).toBe(1)
    // Coming back from that record is a real back press: the surface closes.
    dispatchState(pushedState(0))
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    off()
  })

  it('ignores the echo of its own programmatic close', () => {
    const stack = new BackStack()
    const dismiss = vi.fn()
    const off = stack.register('modal', dismiss)
    off()
    expect(back).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    // The step off the record lands on the application's own record (depth 0).
    dispatchState(null)
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('dismisses the top surface through dismissTop and steps off its record', () => {
    const stack = new BackStack()
    expect(stack.dismissTop()).toBe(false)
    const sheet = vi.fn()
    const modal = vi.fn()
    stack.register('sheet', sheet)
    stack.register('modal', modal)
    expect(stack.dismissTop()).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
    dispatchState(pushedState(0))
    expect(modal).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()
    expect(stack.depth()).toBe(1)
  })

  it('keeps a middle entry removable without a history step', () => {
    const stack = new BackStack()
    const bottom = vi.fn()
    const top = vi.fn()
    const bottomOff = stack.register('bottom', bottom)
    const middleOff = stack.register('middle', vi.fn())
    const topOff = stack.register('top', top)
    middleOff()
    expect(back).not.toHaveBeenCalled()
    expect(stack.depth()).toBe(2)
    dispatchState(pushedState(1))
    expect(top).toHaveBeenCalledTimes(1)
    dispatchState(pushedState(0))
    expect(bottom).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    bottomOff()
    topOff()
  })

  it('survives a throwing dismissal handler', () => {
    const stack = new BackStack()
    const error = vi.spyOn(console, 'error').mockImplementation(() => { /* asserted via the call count */ })
    stack.register('bad', () => { throw new Error('handler down') })
    dispatchState(null)
    expect(error).toHaveBeenCalledTimes(1)
    expect(stack.depth()).toBe(0)
    error.mockRestore()
  })

  it('deregisters an already-popped surface without another history step', () => {
    const stack = new BackStack()
    const dismiss = vi.fn()
    const off = stack.register('modal', dismiss)
    dispatchState(null)
    expect(dismiss).toHaveBeenCalledTimes(1)
    off()
    expect(back).not.toHaveBeenCalled()
    expect(stack.depth()).toBe(0)
  })
})

describe('registerBackSurface', () => {
  it('registers on the shared stack and pops its record', () => {
    const dismiss = vi.fn()
    const off = registerBackSurface('helper', dismiss)
    expect(backStack.depth()).toBe(1)
    dispatchState(null)
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(backStack.depth()).toBe(0)
    off()
  })
})

describe('useBackHandler', () => {
  it('registers while the surface is open and releases on close', () => {
    installPhoneEnvironment()
    const onClose = vi.fn()
    const view = render(<Modal open onClose={onClose} title="Add key" closeLabel="Close">body</Modal>)
    const record = pushedState(0)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(<Modal open={false} onClose={onClose} title="Add key" closeLabel="Close">body</Modal>)
    expect(back).toHaveBeenCalledTimes(1)
    dispatchState(record)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('dismisses an open surface through the shared stack', () => {
    installPhoneEnvironment()
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="Add key" closeLabel="Close">body</Modal>)
    dispatchState(null)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays inert on a fine-pointer desktop', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="Add key" closeLabel="Close">body</Modal>)
    expect(window.history.pushState).not.toHaveBeenCalled()
    dispatchState(null)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeDefined()
  })
})
