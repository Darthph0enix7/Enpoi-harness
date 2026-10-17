// Keyboard clipboard routing shared by the Web UI's xterm surfaces. xterm keeps
// its selection on a canvas, so the browser's native copy gesture copies
// nothing, and it binds no copy/paste chords of its own. These handlers add the
// missing gestures; plain Ctrl+C stays untouched so SIGINT keeps reaching the
// pty exactly as before.

import { writeClipboard } from './clipboard.ts'

/** The emulator operations terminal clipboard routing drives. */
export interface TerminalClipboardTarget {
  /** Whether the emulator currently holds a text selection. */
  hasSelection(): boolean
  /** The selected text, empty when nothing is selected. */
  selection(): string
  /** Insert clipboard text into the pty as xterm's own paste pipeline does. */
  paste(text: string): void
  /** Select the whole buffer. */
  selectAll(): void
  /** Clear the scrollback and the viewport. */
  clear(): void
}

/** Overrides for {@link terminalClipboardKey}. */
export interface TerminalClipboardOptions {
  /** Visiting platform; detected from the device when omitted. */
  platform?: 'macos' | 'linux' | 'windows'
  /** Clipboard writer; defaults to this package's {@link writeClipboard}. */
  write?: (text: string) => Promise<boolean> | boolean
}

/** One platform's copy/paste chord family. */
type TerminalPlatform = 'macos' | 'linux' | 'windows'

/**
 * Detect the visiting platform the same way the shortcut layer does: the
 * document's desktop platform marker first, then the browser's device string.
 * @returns the platform whose clipboard chords this browser receives.
 */
function detectPlatform(): TerminalPlatform {
  const desktop = document.documentElement.dataset.platform
  const device = desktop ?? navigator.platform
  return /darwin|mac|iphone|ipad/iu.test(device) ? 'macos' : /win/iu.test(device) ? 'windows' : 'linux'
}

/**
 * Copy the emulator's current selection through the writer, swallowing a
 * synchronous throw and a rejected write result: clipboard refusal must not
 * escape a key handler or surface as an unhandled rejection.
 * @param target - emulator operations for the focused terminal.
 * @param write - the clipboard writer invoked with the selected text.
 */
function copySelection(target: TerminalClipboardTarget,
  write: (text: string) => Promise<boolean> | boolean): void {
  if (!target.hasSelection()) return
  try {
    void Promise.resolve(write(target.selection())).catch(() => {
      // Clipboard refusal is not a terminal input failure; the chord stays consumed.
    })
  } catch {
    // The writer threw synchronously; the chord stays consumed all the same.
  }
}

/**
 * Route one keyboard event through the terminal clipboard chords before xterm
 * evaluates it. Pass the result to `Terminal.attachCustomKeyEventHandler`:
 * `false` means this module handled the chord and xterm must not, `true` leaves
 * xterm's behavior unchanged.
 *
 * Copy consumes its chord even with an empty selection. Paste returns `false`
 * without preventing the default, because the browser's own `paste` event is
 * the only clipboard read available on an insecure origin and
 * {@link attachTerminalPaste} forwards it. The non-macOS bare Ctrl+C copies only
 * with a selection, so without one it returns `true` and SIGINT still flows.
 * @param event - the keyboard event handed to xterm's custom key handler.
 * @param target - emulator operations for the focused terminal.
 * @param options - platform and clipboard-writer overrides.
 * @returns `false` when the chord was handled, `true` when xterm should proceed.
 */
export function terminalClipboardKey(event: KeyboardEvent, target: TerminalClipboardTarget,
  options: TerminalClipboardOptions = {}): boolean {
  if (event.type !== 'keydown') return true
  const macos = (options.platform ?? detectPlatform()) === 'macos'
  const write = options.write ?? writeClipboard
  const command = macos && event.metaKey && !event.ctrlKey && !event.altKey
  const controlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
  const controlOnly = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
  if (event.code === 'KeyC') {
    if (command || controlShift || (controlOnly && !macos && target.hasSelection())) {
      event.preventDefault()
      copySelection(target, write)
      return false
    }
    return true
  }
  if (event.code === 'KeyV') {
    if (command || controlShift) return false
    return true
  }
  if (event.code === 'Insert') {
    if (controlOnly) {
      event.preventDefault()
      copySelection(target, write)
      return false
    }
    if (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return false
    return true
  }
  if (event.code === 'KeyA') {
    if (command || controlShift) {
      event.preventDefault()
      target.selectAll()
      return false
    }
    return true
  }
  if (event.code === 'KeyK') {
    if (command || controlShift) {
      event.preventDefault()
      target.clear()
      return false
    }
    return true
  }
  return true
}

/**
 * Take over DOM `paste` on the element xterm was opened into. The capture-phase
 * listener runs before xterm's own paste listeners, stops them, and forwards
 * the clipboard text through the emulator's paste pipeline. The event is
 * consumed even when the clipboard carries no text.
 * @param host - the element xterm renders into.
 * @param target - emulator operations for that terminal.
 * @returns a disposer removing the listener.
 */
export function attachTerminalPaste(host: HTMLElement, target: TerminalClipboardTarget): () => void {
  const paste = (event: ClipboardEvent): void => {
    event.preventDefault()
    event.stopImmediatePropagation()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text !== '') target.paste(text)
  }
  host.addEventListener('paste', paste, true)
  return () => { host.removeEventListener('paste', paste, true) }
}
