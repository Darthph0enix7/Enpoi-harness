// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalDockToggle } from '../src/client/terminal/dock-listener.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('terminal dock toggle listener', () => {
  it('toggles on the window event and stops after disposal', () => {
    const toggle = vi.fn()
    const dispose = installTerminalDockToggle(toggle)
    window.dispatchEvent(new CustomEvent('enpoi-toggle-terminal-dock'))
    expect(toggle).toHaveBeenCalledOnce()
    dispose()
    window.dispatchEvent(new CustomEvent('enpoi-toggle-terminal-dock'))
    expect(toggle).toHaveBeenCalledOnce()
  })
})
