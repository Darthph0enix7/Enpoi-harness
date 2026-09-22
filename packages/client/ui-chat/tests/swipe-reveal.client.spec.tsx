// @vitest-environment jsdom
// SwipeReveal: coarse-pointer destructive row action. The gesture is driven
// with pointer events (mouse ignored, vertical drag ignored, horizontal drag
// commits), and the revealed control requires the inline confirmation.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWIPE_ACTION_WIDTH, SwipeReveal } from '../src/client/chat/SwipeReveal.tsx'

afterEach(() => { cleanup() })

/** Render the wrapper with spies and return its row element. */
function setup(): { row: HTMLElement; onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn()
  render(
    <SwipeReveal
      actionLabel="Revert from here"
      confirmLabel="Confirm revert"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
    >
      <div>body</div>
    </SwipeReveal>,
  )
  const row = document.querySelector('[data-swipe-reveal]') as HTMLElement
  return { row, onConfirm }
}

let current: { row: HTMLElement; onConfirm: ReturnType<typeof vi.fn> }

describe('SwipeReveal', () => {
  it('renders the row content and a hidden action layer', () => {
    current = setup()
    expect(screen.getByText('body')).toBeDefined()
    expect(screen.getByText('Revert from here')).toBeDefined()
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })

  it('ignores mouse pointers', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'mouse', clientX: 20, clientY: 100 })
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })

  it('leaves a vertical drag to the scroller', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 190, clientY: 300 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 190, clientY: 300 })
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })

  it('snaps back when the drag stays under the commit threshold', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 290, clientY: 100 })
    expect(current.row.getAttribute('data-dragging')).toBeDefined()
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 280, clientY: 100 })
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })

  it('reveals the destructive control on a committed horizontal drag', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    expect(current.row.getAttribute('data-revealed')).toBe('true')
  })

  it('arms, confirms, and reports the destructive action', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300 - SWIPE_ACTION_WIDTH, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300 - SWIPE_ACTION_WIDTH, clientY: 100 })
    fireEvent.click(screen.getByText('Revert from here'))
    expect(current.onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Confirm revert'))
    expect(current.onConfirm).toHaveBeenCalledTimes(1)
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })

  it('cancels an armed confirmation without acting', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.click(screen.getByText('Revert from here'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(current.onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Revert from here')).toBeDefined()
  })

  it('closes the revealed strip on Escape and on an outside pointer', () => {
    current = setup()
    fireEvent.pointerDown(current.row, { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(current.row.getAttribute('data-revealed')).toBeNull()

    fireEvent.pointerDown(current.row, { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 100 })
    fireEvent.pointerMove(current.row, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerUp(current.row, { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100 })
    fireEvent.pointerDown(screen.getByText('body'), { pointerId: 3, pointerType: 'touch', clientX: 120, clientY: 100 })
    expect(current.row.getAttribute('data-revealed')).toBeNull()
  })
})
