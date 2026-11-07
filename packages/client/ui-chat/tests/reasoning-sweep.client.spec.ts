/**
 * The running-reasoning sweep must stay compositor-only. jsdom has no layout,
 * so this reads the stylesheet: the band's infinite animation transforms a
 * full-row track instead of animating the layout `left` property, and the
 * reduced-motion override still removes it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/chat/ReasoningRow.module.css', import.meta.url)),
  'utf8',
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('reasoning-row running sweep', () => {
  it('animates transform on the compositor, never the layout left property', () => {
    const after = rule(".root[data-state='running'] .row::after")
    expect(after).toContain('animation: dsh-reasoning-row-sweep 2.6s ease-out infinite')
    expect(after).toContain('left: -100%')
    const keyframes = /@keyframes dsh-reasoning-row-sweep \{([\s\S]*?)\n\}/.exec(css)
    expect(keyframes).not.toBeNull()
    expect(keyframes![1]).toContain('transform: translateX(')
    expect(keyframes![1]).not.toContain('left:')
  })

  it('still disables the sweep for reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)
    expect(reduced).not.toBeNull()
    expect(reduced![1]).toContain(".root[data-state='running'] .row::after")
    expect(reduced![1]).toContain('animation: none')
  })
})
