// @vitest-environment jsdom
/**
 * Full-frame regression for the settings shell's ownership boundary. The
 * trigger lives in the sidebar slot, but the panel must be mounted once at the
 * frame root, outside the desktop-column / compact-drawer swap. This test boots
 * the web-app roster through its real AppFrame, opens a registered section,
 * and asserts the dialog, section input, draft/selection, and scroll node are
 * the same DOM instances across live layout-mode changes.
 */
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { getLayoutModeRuntime } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'

/** A section with observable local state and a tall scroll body. */
function RegressionSection() {
  const [value, setValue] = useState('')
  return (
    <div>
      <label htmlFor="frame-regression-input">Regression input</label>
      <input
        id="frame-regression-input"
        data-frame-regression-input=""
        value={value}
        onChange={(event) => { setValue(event.target.value) }}
      />
      <div style={{ height: 1200 }} data-frame-regression-filler="" />
    </div>
  )
}

/** @returns the current dialog, input, scroll host, and their observable state. */
function readSurface() {
  const dialog = document.querySelector<HTMLElement>('[data-shortcut-modal="settings"]')
  const input = document.querySelector<HTMLInputElement>('[data-frame-regression-input]')
  const scroll = document.querySelector<HTMLElement>('[data-settings-scroll]')
  return {
    dialog,
    input,
    scroll,
    value: input?.value,
    start: input?.selectionStart,
    end: input?.selectionEnd,
    scrollTop: scroll?.scrollTop,
  }
}

describe('settings shell frame ownership', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps one dialog, input, draft/selection, and scroll host across live 1440↔800 switches', async () => {
    vi.stubGlobal('innerWidth', 1440)
    vi.stubGlobal('innerHeight', 900)
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
    onTestFinished(() => client.dispose())

    // The root shell and the stable settings host are both real.
    expect(document.querySelector('[data-slot="root"]')).not.toBeNull()
    expect(document.documentElement.dataset.layout).toBe('desktop')

    client.ctx.slots.register({
      name: 'settings.section', id: 'frame-regression', order: 1_000, label: 'Frame regression',
    }, RegressionSection)
    await client.flush()

    const settingsUi = client.ctx.get('settingsUi') as { openSection: (id: string) => void } | undefined
    expect(settingsUi).toBeDefined()
    await act(async () => {
      settingsUi!.openSection('frame-regression')
      await client.flush()
    })

    const baseline = readSurface()
    expect(baseline.dialog).not.toBeNull()
    expect(baseline.input).not.toBeNull()
    expect(baseline.scroll).not.toBeNull()
    expect(baseline.dialog!.closest('#root')).toBeNull()
    expect(baseline.dialog!.querySelector('[data-frame-regression-input]')).toBe(baseline.input)

    baseline.input!.focus()
    fireEvent.change(baseline.input!, { target: { value: 'preserve this draft' } })
    baseline.input!.setSelectionRange(3, 11)
    baseline.scroll!.scrollTop = 240
    const filled = readSurface()
    expect(filled.value).toBe('preserve this draft')
    expect(filled.start).toBe(3)
    expect(filled.end).toBe(11)
    expect(filled.scrollTop).toBe(240)

    for (const width of [800, 1440, 800, 1440]) {
      await act(async () => {
        getLayoutModeRuntime().setFrameWidth(width)
        await client.flush()
      })
      expect(document.documentElement.dataset.layout).toBe(width < 900 ? 'compact' : 'desktop')
      const current = readSurface()
      expect(current.dialog).toBe(baseline.dialog)
      expect(current.input).toBe(baseline.input)
      expect(current.scroll).toBe(baseline.scroll)
      expect(current.value).toBe('preserve this draft')
      expect(current.start).toBe(3)
      expect(current.end).toBe(11)
      expect(current.scrollTop).toBe(240)
    }
  }, 90_000)
})
