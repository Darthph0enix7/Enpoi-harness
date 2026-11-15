/** The compact bar is bounded by its entries; it must not become a scroller. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/MobileFrame.module.css', import.meta.url), 'utf8')

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('compact bar geometry', () => {
  it('does not make the bounded entry row a horizontal scroller', () => {
    const items = ruleFor('.barItems')
    expect(items).not.toContain('overflow-x: auto')
    expect(items).toContain('overflow: hidden')
  })
})
