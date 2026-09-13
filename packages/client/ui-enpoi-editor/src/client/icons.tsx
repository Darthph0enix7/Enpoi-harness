/** The wrap-toggle glyph: three lines, the last bent when wrapping is on. */
import type { ReactNode } from 'react'

/** Props for {@link IconWrap16}. */
export interface IconWrap16Props {
  /** Whether line wrap is currently on (draws the bent last line). */
  readonly wrapped: boolean
  /** Square size in px; defaults to 14. */
  readonly size?: number
}

/**
 * Render the compact wrap toggle.
 * @param props - wrap state and size.
 * @returns the monochrome line glyph.
 */
export function IconWrap16({ wrapped, size = 14 }: IconWrap16Props): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2 3.5H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2 7.5H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {wrapped
        ? <path d="M2 11.5H9M9 11.5L6.5 9.5M9 11.5L6.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M2 11.5H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  )
}
