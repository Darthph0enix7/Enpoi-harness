/** The phone session tree must be tappable, bounded, and internally scrollable. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/SubagentHeaderLineage.module.css', import.meta.url), 'utf8')

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('subagent catalog menu touch geometry', () => {
  it('keeps every row at the 44px touch minimum', () => {
    expect(ruleFor('.row')).toContain('min-height: 44px')
    expect(ruleFor('.row')).toContain('touch-action: manipulation')
    expect(css).toContain('@media (pointer: coarse)')
    expect(css).toMatch(/@media \(pointer: coarse\) \{[\s\S]*?\.row \{\s*min-height: 48px;/)
  })

  it('extends the 14px disclosure glyph into a thumb-sized hit area', () => {
    expect(css).toContain('.disclosure::after')
    expect(css).toMatch(/\.disclosure::after \{[\s\S]*?inset: -10px -8px;/)
  })

  it('keeps the 28px desktop trigger while coarse pointers use the shared 44px target', () => {
    expect(ruleFor('.trigger')).not.toContain('min-height')
    expect(css).toMatch(/@media \(pointer: fine\) \{[\s\S]*?\.trigger,[\s\S]*?min-height: 28px;/)
  })

  it('scrolls the menu inside itself without horizontal overflow', () => {
    const body = ruleFor('.menuBody')
    expect(body).toContain('overflow: auto')
    expect(body).toContain('overflow-x: hidden')
    expect(ruleFor('.menu')).toContain('max-width: min(400px, calc(100vw - 32px))')
  })
})
