/**
 * Micro monochrome icon (10px, stroke currentColor) shared by the Watchtower
 * cards — the Liquid-Glass micro-header glyph, never a filled icon set.
 * @param props - the icon path and optional pixel size.
 * @returns the inline SVG.
 */
export function MicroIcon({ d, size = 10 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}
