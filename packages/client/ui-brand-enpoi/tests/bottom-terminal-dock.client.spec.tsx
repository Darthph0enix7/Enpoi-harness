// @vitest-environment jsdom
/**
 * The bottom dock's mounted-shell contract (the parked dock must stay mounted
 * so a reopen retargets its transform instead of restarting an animation) and
 * the open-body marker the conversation column's margin rides on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { BottomTerminalDock } from '../src/client/terminal/BottomTerminalDock.tsx'
import type { BottomTerminalDockProps } from '../src/client/terminal/BottomTerminalDock.tsx'

const noop = (): void => { /* the spec only observes rendering */ }

/** Props for one dock snapshot; the terminal surface is empty so no xterm mounts. */
function dockProps(open: boolean, height = 260): BottomTerminalDockProps {
  return {
    useSessions: (selector: (state: unknown) => unknown) => selector({
      ids: ['s1'], byId: { s1: { cwd: '/tmp' } },
    }),
    useTerminals: (selector: (state: unknown) => unknown) => selector({
      dock: { open, height },
      bySession: open ? { s1: { tabs: [], active: { bottom: undefined } } } : {},
    }),
    openTerminal: noop, closeTerminal: noop, activateTerminal: noop,
    writeTerminal: noop, resizeTerminal: noop, subscribeTerminal: noop, readTerminal: noop,
    toggleTerminalDock: noop, setTerminalDockHeight: noop,
  } as unknown as BottomTerminalDockProps
}

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-enpoi-bottom-dock-open')
  document.documentElement.style.removeProperty('--enpoi-bottom-dock-height')
  vi.useRealTimers()
})

describe('BottomTerminalDock shell', () => {
  it('keeps the parked dock mounted without an open marker or a terminal body', () => {
    const { container } = render(<BottomTerminalDock {...dockProps(false)} />)
    const dock = container.querySelector<HTMLElement>('[data-enpoi-bottom-dock]')
    expect(dock).not.toBeNull()
    expect(dock?.hasAttribute('data-enpoi-bottom-dock-open')).toBe(false)
    expect(container.querySelector('[data-enpoi-bottom-terminal-empty]')).toBeNull()
    expect(document.body.hasAttribute('data-enpoi-bottom-dock-open')).toBe(false)
  })

  it('marks the open dock and renders its body', () => {
    const { container } = render(<BottomTerminalDock {...dockProps(true)} />)
    const dock = container.querySelector<HTMLElement>('[data-enpoi-bottom-dock]')
    expect(dock?.hasAttribute('data-enpoi-bottom-dock-open')).toBe(true)
    expect(container.querySelector('[data-enpoi-bottom-terminal-empty]')).not.toBeNull()
    expect(document.body.hasAttribute('data-enpoi-bottom-dock-open')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--enpoi-bottom-dock-height')).toBe('260px')
  })

  it('keeps the column marker through the closing ride and clears it at settle', () => {
    vi.useFakeTimers()
    const view = render(<BottomTerminalDock {...dockProps(true)} />)
    expect(document.body.hasAttribute('data-enpoi-bottom-dock-open')).toBe(true)
    act(() => { view.rerender(<BottomTerminalDock {...dockProps(false)} />) })
    // The ride's marker must survive until the transition ends, while the
    // dock's own open attribute drops immediately (it drives the transform).
    expect(document.body.hasAttribute('data-enpoi-bottom-dock-open')).toBe(true)
    expect(view.container.querySelector<HTMLElement>('[data-enpoi-bottom-dock]')?.hasAttribute('data-enpoi-bottom-dock-open')).toBe(false)
    act(() => { vi.advanceTimersByTime(400) })
    expect(document.body.hasAttribute('data-enpoi-bottom-dock-open')).toBe(false)
  })
})
