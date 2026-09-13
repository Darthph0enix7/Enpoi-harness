/**
 * enpoi: terminal-surface glyphs. The primitives catalog has no terminal or
 * bottom-panel glyph, so these two live with their only consumer.
 */
import type { ReactNode } from 'react'

/** Props of the terminal-surface glyphs; mirrors the fork's other tab icons. */
export interface TerminalGlyphProps {
  readonly size?: number | undefined
  readonly active?: boolean | undefined
  readonly className?: string | undefined
}

/** A terminal window with a prompt caret. */
export function TerminalIcon({ size = 16, className }: TerminalGlyphProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.8" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.4 6.1 6.5 8 4.4 9.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.1 10.1h3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** A panel whose lower band is filled: the bottom dock. */
export function BottomPanelIcon({ size = 16, className }: TerminalGlyphProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="1.4" y="2.4" width="13.2" height="11.2" rx="1.8" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.4 9.6h13.2v2.2a1.8 1.8 0 0 1-1.8 1.8H3.2a1.8 1.8 0 0 1-1.8-1.8z" fill="currentColor" />
    </svg>
  )
}
