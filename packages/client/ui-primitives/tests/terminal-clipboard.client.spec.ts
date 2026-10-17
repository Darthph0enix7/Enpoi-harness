// @vitest-environment jsdom
/** Terminal clipboard chords and the DOM paste takeover shared by xterm surfaces. */
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  attachTerminalPaste, terminalClipboardKey,
  type TerminalClipboardOptions, type TerminalClipboardTarget,
} from '../src/terminal-clipboard.ts'

/** Spy handles for one emulator target; function properties stay callable without a receiver. */
interface TargetSpies {
  hasSelection: Mock<() => boolean>
  selection: Mock<() => string>
  paste: Mock<(text: string) => void>
  selectAll: Mock<() => void>
  clear: Mock<() => void>
}

function makeTarget(overrides: Partial<TerminalClipboardTarget> = {}): TargetSpies {
  return {
    hasSelection: vi.fn(() => false),
    selection: vi.fn(() => ''),
    paste: vi.fn((_text: string) => {}),
    selectAll: vi.fn(),
    clear: vi.fn(),
    ...overrides,
  } as TargetSpies
}

function keyDown(code: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, cancelable: true, ...modifiers })
}

/** A paste event carrying clipboard text; jsdom's ClipboardEvent ignores clipboardData init. */
function pasteEvent(text?: string, getData = vi.fn((type: string) => type === 'text/plain' ? text ?? '' : '')): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  if (text !== undefined) Object.defineProperty(event, 'clipboardData', { value: { getData } })
  return event
}

afterEach(() => {
  delete document.documentElement.dataset.platform
  Reflect.deleteProperty(navigator, 'platform')
  delete (navigator as { clipboard?: unknown }).clipboard
})

describe('platform detection', () => {
  it('takes the document platform marker over the device string', () => {
    document.documentElement.dataset.platform = 'darwin'
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    expect(terminalClipboardKey(keyDown('KeyC', { metaKey: true }), target, { write })).toBe(false)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
  })

  it('falls back to the device string when the document carries no marker', () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    const target = makeTarget()
    expect(terminalClipboardKey(keyDown('KeyK', { metaKey: true }), target, { write: vi.fn() })).toBe(false)
    expect(target.clear).toHaveBeenCalledOnce()
  })

  it('treats a windows device string as a non-macOS platform', () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    expect(terminalClipboardKey(keyDown('KeyC', { ctrlKey: true }), target, { write })).toBe(false)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
  })
})

describe('copy chords', () => {
  it('copies and consumes Command+C on macOS with a selection', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { metaKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'macos', write })).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
  })

  it('consumes Command+C on macOS without copying an empty selection', () => {
    const target = makeTarget()
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { metaKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'macos', write })).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('copies and consumes Ctrl+Shift+C on every platform, even without a selection', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { ctrlKey: true, shiftKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'macos', write })).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
    const empty = keyDown('KeyC', { ctrlKey: true, shiftKey: true })
    expect(terminalClipboardKey(empty, makeTarget(), { write })).toBe(false)
    expect(write).toHaveBeenCalledOnce()
  })

  it('copies and consumes Ctrl+Insert on every platform', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('Insert', { ctrlKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'macos', write })).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
  })

  it('copies and consumes bare Ctrl+C with a selection only off macOS', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { ctrlKey: true })
    expect(terminalClipboardKey(event, target, { write })).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(write).toHaveBeenCalledExactlyOnceWith('picked')
    expect(terminalClipboardKey(keyDown('KeyC', { ctrlKey: true }), target, { platform: 'windows', write })).toBe(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('leaves Command+C to xterm off macOS even with a selection', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { metaKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'windows', write })).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('leaves bare Ctrl+C without a selection to SIGINT on every non-macOS platform', () => {
    const target = makeTarget()
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { ctrlKey: true })
    expect(terminalClipboardKey(event, target, { write })).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('leaves bare Ctrl+C to SIGINT even with a selection on macOS', () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const write = vi.fn(() => true)
    const event = keyDown('KeyC', { ctrlKey: true })
    expect(terminalClipboardKey(event, target, { platform: 'macos', write })).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('copies the exact selection through the default clipboard writer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const target = makeTarget({ hasSelection: () => true, selection: () => 'exact selection' })
    expect(terminalClipboardKey(keyDown('KeyC', { ctrlKey: true, shiftKey: true }), target)).toBe(false)
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledExactlyOnceWith('exact selection')
  })

  it('contains a synchronous writer throw and a rejected writer result', async () => {
    const target = makeTarget({ hasSelection: () => true, selection: () => 'picked' })
    const throwing = vi.fn(() => { throw new Error('denied') })
    expect(terminalClipboardKey(keyDown('KeyC', { ctrlKey: true, shiftKey: true }), target, { write: throwing })).toBe(false)
    terminalClipboardKey(keyDown('KeyC', { ctrlKey: true, shiftKey: true }), target,
      { write: () => Promise.reject(new Error('denied')) })
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('paste chords', () => {
  it('returns false for Command+V on macOS without preventing the browser paste', () => {
    const event = keyDown('KeyV', { metaKey: true })
    expect(terminalClipboardKey(event, makeTarget(), { platform: 'macos' })).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('returns false for Ctrl+Shift+V on every platform without preventing the browser paste', () => {
    const event = keyDown('KeyV', { ctrlKey: true, shiftKey: true })
    expect(terminalClipboardKey(event, makeTarget(), { platform: 'macos' })).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('returns false for Shift+Insert on every platform without preventing the browser paste', () => {
    const event = keyDown('Insert', { shiftKey: true })
    expect(terminalClipboardKey(event, makeTarget())).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves plain Ctrl+V and unrelated chords to xterm', () => {
    for (const [code, modifiers] of [
      ['KeyV', { ctrlKey: true }],
      ['KeyV', { ctrlKey: true, altKey: true }],
      ['KeyV', { metaKey: true }],
      ['Insert', { ctrlKey: true, shiftKey: true }],
      ['Insert', { shiftKey: true, altKey: true }],
      ['Insert', { shiftKey: true, metaKey: true }],
    ] as const) {
      const event = keyDown(code, modifiers)
      expect(terminalClipboardKey(event, makeTarget())).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
  })
})

describe('select all and clear chords', () => {
  it('selects all and consumes Command+A on macOS and Ctrl+Shift+A everywhere', () => {
    const mac = makeTarget()
    const macEvent = keyDown('KeyA', { metaKey: true })
    expect(terminalClipboardKey(macEvent, mac, { platform: 'macos' })).toBe(false)
    expect(macEvent.defaultPrevented).toBe(true)
    expect(mac.selectAll).toHaveBeenCalledOnce()
    const common = makeTarget()
    const commonEvent = keyDown('KeyA', { ctrlKey: true, shiftKey: true })
    expect(terminalClipboardKey(commonEvent, common)).toBe(false)
    expect(commonEvent.defaultPrevented).toBe(true)
    expect(common.selectAll).toHaveBeenCalledOnce()
  })

  it('clears and consumes Command+K on macOS and Ctrl+Shift+K everywhere', () => {
    const mac = makeTarget()
    const macEvent = keyDown('KeyK', { metaKey: true })
    expect(terminalClipboardKey(macEvent, mac, { platform: 'macos' })).toBe(false)
    expect(macEvent.defaultPrevented).toBe(true)
    expect(mac.clear).toHaveBeenCalledOnce()
    const common = makeTarget()
    const commonEvent = keyDown('KeyK', { ctrlKey: true, shiftKey: true })
    expect(terminalClipboardKey(commonEvent, common)).toBe(false)
    expect(commonEvent.defaultPrevented).toBe(true)
    expect(common.clear).toHaveBeenCalledOnce()
  })

  it('leaves unrelated modifier combinations and keys to xterm', () => {
    const chords: ReadonlyArray<readonly [string, Partial<KeyboardEventInit>]> = [
      ['KeyC', { ctrlKey: true, metaKey: true }],
      ['KeyC', { ctrlKey: true, altKey: true }],
      ['KeyC', { ctrlKey: true, shiftKey: true, altKey: true }],
      ['KeyC', { ctrlKey: true, shiftKey: true, metaKey: true }],
      ['Insert', { ctrlKey: true, altKey: true }],
      ['Insert', { ctrlKey: true, metaKey: true }],
      ['KeyA', { ctrlKey: true }],
      ['KeyA', { ctrlKey: true, shiftKey: true, altKey: true }],
      ['KeyA', { metaKey: true, ctrlKey: true }],
      ['KeyK', { ctrlKey: true }],
      ['KeyK', { ctrlKey: true, shiftKey: true, metaKey: true }],
      ['KeyK', { metaKey: true, altKey: true }],
      ['KeyX', { ctrlKey: true, shiftKey: true }],
      ['KeyV', {}],
    ]
    for (const [code, modifiers] of chords) {
      expect(terminalClipboardKey(keyDown(code, modifiers), makeTarget(), { platform: 'macos' })).toBe(true)
      expect(terminalClipboardKey(keyDown(code, modifiers), makeTarget())).toBe(true)
    }
  })
})

describe('event routing guard', () => {
  it('leaves non-keydown events to xterm', () => {
    const target = makeTarget()
    const options: TerminalClipboardOptions = { platform: 'macos', write: vi.fn() }
    expect(terminalClipboardKey(new KeyboardEvent('keyup', { code: 'KeyC', metaKey: true }), target, options)).toBe(true)
    expect(terminalClipboardKey(new KeyboardEvent('keypress', { code: 'KeyC', metaKey: true }), target, options)).toBe(true)
  })
})

describe('attachTerminalPaste', () => {
  it('consumes the event, stops later listeners, and forwards the clipboard text', () => {
    const host = document.createElement('div')
    const child = document.createElement('span')
    host.append(child)
    const target = makeTarget()
    const detach = attachTerminalPaste(host, target)
    const later = vi.fn()
    host.addEventListener('paste', later, true)
    const getData = vi.fn(() => '__probe__')
    const event = pasteEvent('__probe__', getData)
    child.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(getData).toHaveBeenCalledExactlyOnceWith('text/plain')
    expect(target.paste).toHaveBeenCalledExactlyOnceWith('__probe__')
    expect(later).not.toHaveBeenCalled()
    detach()
  })

  it('consumes an empty payload and a missing clipboard without pasting', () => {
    const host = document.createElement('div')
    const target = makeTarget()
    attachTerminalPaste(host, target)
    const empty = pasteEvent('')
    host.dispatchEvent(empty)
    expect(empty.defaultPrevented).toBe(true)
    const missing = pasteEvent()
    host.dispatchEvent(missing)
    expect(missing.defaultPrevented).toBe(true)
    expect(target.paste).not.toHaveBeenCalled()
  })

  it('removes both behaviors through its disposer', () => {
    const host = document.createElement('div')
    const target = makeTarget()
    const detach = attachTerminalPaste(host, target)
    detach()
    const event = pasteEvent('__probe__')
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(target.paste).not.toHaveBeenCalled()
  })
})
