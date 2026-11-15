/**
 * The view switch's touch contract as CSS text. jsdom has no layout and no
 * media-query evaluation, so these read the declarations that make the
 * Chat/Trajectory/… strip a real phone control: one 44px-high target per mode,
 * equal columns that cannot overflow the header at 320px, and first-tap
 * activation without a hover dependency.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Declarations of one flat rule, wherever it sits (top level or media body). */
function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`ConversationRoot.module.css has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

/** Brace-matched bodies of every `@media <query>` block. */
function mediaBodies(marker: string): string[] {
  const bodies: string[] = []
  const pattern = new RegExp(`@media\\s*${marker}\\s*\\{`, 'gu')
  for (const match of css.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length
    let depth = 1
    for (let index = start; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') {
        depth -= 1
        if (depth === 0) { bodies.push(css.slice(start, index)); break }
      }
    }
  }
  return bodies
}

function ruleInside(body: string, selector: string): string[] {
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'u').exec(body)
  if (rule === null) throw new Error(`coarse media block has no \`${selector}\` rule`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

const COARSE = mediaBodies('\\(pointer:\\s*coarse\\)')

describe('ConversationRoot.view switch touch geometry', () => {
  it('activates on a plain click with no hover prerequisite', () => {
    expect(declarations('.tab')).toEqual(expect.arrayContaining([
      'touch-action: manipulation',
      'cursor: pointer',
    ]))
    // No rule may hide the strip until a pointer hover; touch has no hover.
    expect(/\.tab[^{}]*\bhover\b[^{}]*\{[^{}]*display:\s*none/u.test(css)).toBe(false)
    expect(/@media\s*\(hover:\s*hover\)/u.test(css)).toBe(false)
  })

  it('keeps the strip inside the header at every width', () => {
    expect(declarations('.tabs')).toEqual(expect.arrayContaining([
      'display: flex',
      'min-width: 0',
    ]))
    expect(declarations('.tabs')).not.toEqual(expect.arrayContaining(['overflow-x: auto']))
    expect(declarations('.tab')).toEqual(expect.arrayContaining([
      'flex: none',
      'white-space: nowrap',
    ]))
  })

  it('gives every coarse-pointer mode a 44px-high equal-width target', () => {
    expect(COARSE.length).toBeGreaterThan(0)
    const tab = ruleInside(COARSE.join('\n'), '.tab')
    expect(tab).toEqual(expect.arrayContaining([
      'flex: 1 1 0',
      'min-width: 0',
      'min-height: 44px',
      'padding: 0 4px',
      'overflow: hidden',
      'line-height: 44px',
    ]))
    // Equal columns plus a shrinkable minimum: no fixed gap/padding can push
    // a fourth mode past the 320px header edge.
    expect(tab).not.toEqual(expect.arrayContaining(['width: 89px']))
    const tabs = ruleInside(COARSE.join('\n'), '.tabs')
    expect(tabs).toEqual(expect.arrayContaining(['gap: 2px', 'padding-left: 0']))
  })

  it('drops one font step below 400px so four labels stay whole', () => {
    const narrow = mediaBodies('\\(pointer:\\s*coarse\\)\\s+and\\s+\\(max-width:\\s*399\\.98px\\)')
    expect(narrow.length).toBe(1)
    expect(ruleInside(narrow[0] ?? '', '.tab')).toEqual(expect.arrayContaining(['font-size: 12px', 'padding: 0 2px']))
  })

  it('keeps the header height bounded by trimming the coarse top inset', () => {
    const header = ruleInside(COARSE.join('\n'), '.header')
    expect(header).toEqual(expect.arrayContaining(['padding-top: 4px']))
    // The strip still spans both grid columns.
    expect(declarations('.tabs')).toEqual(expect.arrayContaining(['grid-column: 1 / -1']))
  })
})
