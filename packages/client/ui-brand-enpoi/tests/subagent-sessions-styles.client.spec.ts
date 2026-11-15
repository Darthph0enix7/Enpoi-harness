/** The Subagent Sessions tree must stay tappable at phone widths. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/SubagentSessionsBody.module.css', import.meta.url), 'utf8')

function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('subagent sessions touch geometry', () => {
  it('keeps every row at the 44px touch minimum and suppresses double-tap zoom', () => {
    const row = ruleFor('.row')
    expect(row).toContain('min-height: 44px')
    expect(row).toContain('touch-action: manipulation')
  })

  it('scrolls its list inside itself without horizontal overflow', () => {
    const list = ruleFor('.list')
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('overflow-x: hidden')
  })
})
