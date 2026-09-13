/**
 * enpoi: one xterm.js view over a registered terminal's transport. The
 * component owns the emulator only: it replays the client transcript on
 * mount, forwards keystrokes and fits, and never owns the PTY's lifetime.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalTabState } from './registry.ts'
import css from './TerminalView.module.css'

/** What one terminal view needs: its identity and the transport callbacks. */
export interface TerminalViewProps {
  readonly sessionId: string
  readonly tab: TerminalTabState
  readonly active: boolean
  readonly write: (sessionId: string, id: string, data: string) => void
  readonly resize: (sessionId: string, id: string, cols: number, rows: number) => void
  readonly subscribe: (sessionId: string, id: string, listener: (data: string) => void) => () => void
  readonly read: (sessionId: string, id: string) => string
}

/** One terminal's emulator over its transport. */
export function TerminalView({ sessionId, tab, active, write, resize, subscribe, read }: TerminalViewProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: { background: 'rgba(0,0,0,0)' },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    const replay = read(sessionId, tab.id)
    if (replay.length > 0) terminal.write(replay)
    const unsubscribe = subscribe(sessionId, tab.id, (data) => { terminal.write(data) })
    const input = terminal.onData((data) => { write(sessionId, tab.id, data) })
    const fitNow = (): void => {
      if (host.clientWidth < 8 || host.clientHeight < 8) return
      try { fit.fit() } catch { /* a hidden view has no measurable box */ }
      resize(sessionId, tab.id, terminal.cols, terminal.rows)
    }
    fitNow()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { fitNow() })
    observer?.observe(host)
    if (active) terminal.focus()
    return () => {
      observer?.disconnect()
      input.dispose()
      unsubscribe()
      terminal.dispose()
    }
  }, [sessionId, tab.id, active, write, resize, subscribe, read])

  return <div ref={hostRef} className={css.host} data-enpoi-terminal-view={tab.id} />
}
