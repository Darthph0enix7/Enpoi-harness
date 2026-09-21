/**
 * Minimalist stroke glyphs for the operator sections the Enpoi fork adds to the
 * settings nav (orchestration, permissions, dynamic, agent presets). One 16px
 * grid, 1.25 stroke, currentColor — the same family as the sidebar rail icons —
 * so the shell's `navIcon` mapping has a distinct glyph per owned section
 * instead of the shared gear fallback.
 */
import type { ReactNode } from 'react'

/** The icon call contract the shell's nav slots use. */
export interface NavIconProps {
  size?: number | undefined
  className?: string | undefined
}

/** Shared 16px stroke wrapper. */
function Glyph({ size = 16, className, children }: NavIconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {children}
    </svg>
  )
}

/** Orchestration: one parent node branching into two worker nodes. */
export function IconOrchestrationStroke16(props: NavIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="3.1" r="1.35" />
      <circle cx="3.6" cy="12.2" r="1.35" />
      <circle cx="12.4" cy="12.2" r="1.35" />
      <path d="M8 4.45v2.4M8 6.85H3.6v4M8 6.85h4.4v4" />
    </Glyph>
  )
}

/** Permissions: shield outline with an inner check. */
export function IconPermissionsStroke16(props: NavIconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 1.9l4.6 1.8v3.3c0 3.1-1.9 5.4-4.6 6.9-2.7-1.5-4.6-3.8-4.6-6.9V3.7z" />
      <path d="M5.9 7.8l1.6 1.6 2.9-3.1" />
    </Glyph>
  )
}

/** Dynamic: stacked sliders editors (two tracks, offset knobs). */
export function IconDynamicStroke16(props: NavIconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.4 5.2h11.2M2.4 10.8h11.2" />
      <circle cx="10.4" cy="5.2" r="1.35" />
      <circle cx="5.6" cy="10.8" r="1.35" />
    </Glyph>
  )
}

/** Agent presets: three linked roster nodes (the composition triangle). */
export function IconAgentPresetStroke16(props: NavIconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="3.1" r="1.35" />
      <circle cx="3.6" cy="12.2" r="1.35" />
      <circle cx="12.4" cy="12.2" r="1.35" />
      <path d="M7.1 4.4L4.5 10.8M8.9 4.4l2.6 6.4M5 12.2h6" />
    </Glyph>
  )
}
