// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet, getDeviceSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { backStack } from '../src/back-stack.ts'

afterEach(cleanup)
afterEach(() => { backStack.clear() })

beforeEach(() => { usePhoneReading() })

/** Publish a phone (touch, coarse) reading through the shared classifier. */
function usePhoneReading(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  getDeviceSnapshot()
}

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    render(
      <Sheet open={false} onClose={() => {}} title="Models" closeLabel="Close">
        <p>body</p>
      </Sheet>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders a safe-area padded dialog with title, body, and footer', () => {
    render(
      <Sheet open onClose={() => {}} title="Models" closeLabel="Close" footer={<button type="button">Apply</button>}>
        <p>body</p>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Models' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('data-sheet-root')).toBeNull()
    expect(screen.getByText('body')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(document.querySelector('[data-sheet-root]')).not.toBeNull()
  })

  it('closes on the mask, the close button, and Escape', () => {
    const onClose = vi.fn()
    const view = render(
      <Sheet open onClose={onClose} title="Models" closeLabel="Close">body</Sheet>,
    )
    fireEvent.click(view.container.ownerDocument.querySelector('[aria-hidden="true"]') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('registers the touch back surface while open and releases it on close', () => {
    const onClose = vi.fn()
    const view = render(
      <Sheet open onClose={onClose} title="Models" closeLabel="Close" surfaceId="test:sheet">body</Sheet>,
    )
    expect(backStack.depth()).toBe(1)
    view.rerender(
      <Sheet open={false} onClose={onClose} title="Models" closeLabel="Close" surfaceId="test:sheet">body</Sheet>,
    )
    expect(backStack.depth()).toBe(0)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the panel free of default chrome in headless mode', () => {
    render(
      <Sheet headless open onClose={() => {}} title="Raw">body</Sheet>,
    )
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Raw' }).textContent).toContain('body')
  })
})
