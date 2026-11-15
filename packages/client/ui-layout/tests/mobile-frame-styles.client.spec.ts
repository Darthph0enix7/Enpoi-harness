/** The compact bar is bounded by its entries; it must not become a scroller. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/MobileFrame.module.css', import.meta.url), 'utf8')

function ruleFor(selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(source)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('compact bar geometry', () => {
  it('does not make the bounded entry row a horizontal scroller', () => {
    const items = ruleFor('.barItems')
    expect(items).not.toContain('overflow-x: auto')
    expect(items).toContain('overflow: hidden')
    expect(items).toContain('justify-content: space-between')
  })

  it('raises the header icon targets to 44px on coarse pointers', () => {
    const block = /@media \(pointer: coarse\)[\s\S]*?\.iconButton\s*\{([^}]*)\}/.exec(css)
    expect(block).not.toBeNull()
    expect(block?.[1]).toContain('width: 44px')
    expect(block?.[1]).toContain('height: 44px')
  })

  it('collapses into a safe-area bottom handle instead of a top-right float', () => {
    expect(ruleFor('.barCollapsed')).toContain('height: calc(44px + var(--dsh-safe-area-inset-bottom, 0px))')
    expect(ruleFor('.chromeHandle')).toContain('height: 44px')
    expect(ruleFor('.chromeHandle')).toContain('touch-action: none')
    expect(ruleFor('.handleGrip')).toContain('width: 36px')
    expect(css).not.toContain('.immersiveRestore')
    expect(css).not.toContain('position: fixed;\n  top: calc(var(--dsh-safe-area-inset-top')
  })
})
