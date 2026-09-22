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

/** The save glyph: a tray with a downward arrow into it. */
export function IconSave16({ size = 14 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M8 1.8V9.2M8 9.2L5.2 6.4M8 9.2L10.8 6.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M2.4 10.4V12.6C2.4 13.4 3 14 3.8 14H12.2C13 14 13.6 13.4 13.6 12.6V10.4"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
    </svg>
  )
}

/** The auto-save glyph: a closed circular arrow with a dot at its centre. */
export function IconAutosave16({ size = 14 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M13.4 8A5.4 5.4 0 1 1 11.1 3.62"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
      <path d="M13.6 1.9V4.1H11.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
    </svg>
  )
}

/** The match-case toggle glyph: an "A" over a baseline dot. */
export function IconCase16({ size = 14 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M2.4 11.6L5.9 3.6L9.4 11.6M3.7 8.8H8.1"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
      />
      <circle cx="12" cy="10.9" r="0.95" fill="currentColor" />
    </svg>
  )
}

/** The regular-expression toggle glyph: two dots and an asterisk. */
export function IconRegex16({ size = 14 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="2.6" cy="11.6" r="1" fill="currentColor" />
      <circle cx="6.2" cy="11.6" r="1" fill="currentColor" />
      <path d="M11.6 3.2V9.4M8.9 4.8L14.3 7.9M14.3 4.8L8.9 7.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
