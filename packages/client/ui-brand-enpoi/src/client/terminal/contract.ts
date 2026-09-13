/**
 * enpoi: the terminal surfaces' inject face. Both registrations (the right
 * sidebar's terminal page and the bottom dock) declare the same hooks and
 * callbacks, so the browser terminal module can render the same terminals on
 * either surface from one apply-closure registry.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TerminalPlace, TerminalRegistryState } from './registry.ts'

/** What every terminal surface receives from the plugin body. */
export interface TerminalInjected {
  readonly hooks: {
    /** The registry snapshot, bound by the renderer as `useTerminals`. */
    readonly terminals: HostObservable<TerminalRegistryState>
  }
  /**
   * Spawn a terminal on one surface.
   * @param sessionId - owning conversation.
   * @param place - which surface hosts it.
   * @param cwd - the session's working directory when known.
   */
  readonly openTerminal: (sessionId: string, place: TerminalPlace, cwd: string | undefined) => void
  /**
   * Kill one terminal and drop its tab.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   */
  readonly closeTerminal: (sessionId: string, id: string) => void
  /**
   * Focus one terminal tab.
   * @param sessionId - owning conversation.
   * @param place - which surface.
   * @param id - terminal id.
   */
  readonly activateTerminal: (sessionId: string, place: TerminalPlace, id: string) => void
  /**
   * Write input to one terminal.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param data - keystrokes or pasted text.
   */
  readonly writeTerminal: (sessionId: string, id: string, data: string) => void
  /**
   * Report one terminal's grid to its PTY.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param cols - columns.
   * @param rows - rows.
   */
  readonly resizeTerminal: (sessionId: string, id: string, cols: number, rows: number) => void
  /**
   * Subscribe to one terminal's live output.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param listener - output sink.
   * @returns unsubscribe.
   */
  readonly subscribeTerminal: (sessionId: string, id: string, listener: (data: string) => void) => () => void
  /**
   * Everything one terminal received so far, for a fresh emulator.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @returns the transcript.
   */
  readonly readTerminal: (sessionId: string, id: string) => string
  /** Flip the bottom dock open or closed. */
  readonly toggleTerminalDock: () => void
  /**
   * Record the dock's height after a drag.
   * @param px - dragged height.
   */
  readonly setTerminalDockHeight: (px: number) => void
}
