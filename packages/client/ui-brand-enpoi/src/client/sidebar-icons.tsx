/**
 * enpoi: right-sidebar tab glyphs. They stay in the eager client entry while
 * the bodies they label load as deferred chunks, so registration-time guide
 * capsules never wait on a body chunk.
 */
import type { ReactNode } from 'react'

/** Shared visual contract of one tab glyph. */
export interface SidebarTabIconProps {
  readonly size?: number | undefined
  readonly active?: boolean | undefined
  readonly className?: string | undefined
}

/** Monochrome tab glyph for Agent Models (thin stroke, currentColor). */
export function FleetRoutingIcon({ size = 16, className }: SidebarTabIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="5.5" cy="4.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10.5" cy="8" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="7.5" cy="11.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/** Monochrome tab glyph for Subagent Sessions (thin stroke, currentColor). */
export function SubagentSessionsIcon({ size = 16, className }: SidebarTabIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="8" cy="3.6" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.6" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.4" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5.6v2.2M8 7.8 4.6 10.7M8 7.8l3.4 2.9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

/** Monochrome tab glyph for Git (thin stroke, currentColor). */
export function GitIcon({ size = 16, className }: SidebarTabIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="4.6" cy="3.6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.6" cy="12.4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.4" cy="7.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.6 5.3v5.4M4.6 8.4h3.4a1.7 1.7 0 001.7-1.7V7.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
