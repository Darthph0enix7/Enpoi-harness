/**
 * Shared coarse-pointer target geometry as CSS text. jsdom has no layout and no
 * media-query evaluation, so these read the declarations that make a 24–36px
 * control reach the 44px platform minimum on touch while desktop density stays
 * untouched. The rules are the mechanism every surface opts into; a regression
 * here silently shrinks every consumer's tap target at once.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hitBlockTargetClass, hitTargetClass } from '../src/hit-target.ts'

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Brace-matched body of every `@media <query>` block (nested rules included). */
function mediaBodies(css: string, query: RegExp): string[] {
  const bodies: string[] = []
  for (const match of css.matchAll(query)) {
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

function declarations(css: string, selector: string): string[] {
  const rule = new RegExp(`(?:^|[{}])\\s*${selector.replace(/[.[\]():*+^$\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`no \`${selector}\` rule in the stylesheet`)
  return (rule[1] ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

describe('shared hit-target exports', () => {
  it('resolves both classes from the module so consumers share one mechanism', () => {
    expect(hitTargetClass).toMatch(/target/)
    expect(hitBlockTargetClass).toMatch(/blockTarget/)
    expect(hitTargetClass).not.toBe(hitBlockTargetClass)
  })
})

describe('HitTarget.module.css coarse-pointer geometry', () => {
  const css = read('HitTarget.module.css')

  it('keeps the visual box and grows the hit box to 44px through a centred pseudo', () => {
    expect(declarations(css, '.target')).toEqual(expect.arrayContaining([
      'position: relative',
      'touch-action: manipulation',
    ]))
    const pseudo = declarations(css, '.target::before')
    expect(pseudo).toEqual(expect.arrayContaining([
      "content: ''",
      'width: max(100%, 44px)',
      'height: max(100%, 44px)',
      'transform: translate(-50%, -50%)',
    ]))
  })

  it('offers a block variant that makes the element itself 44x44 with no pseudo', () => {
    expect(declarations(css, '.blockTarget')).toEqual(expect.arrayContaining([
      'touch-action: manipulation',
    ]))
    expect(declarations(css, '.blockTarget')).not.toEqual(expect.arrayContaining(['min-height: 44px']))
    expect(declarations(css, '.blockTarget')).not.toEqual(expect.arrayContaining(['min-width: 44px']))
  })

  it('scopes every 44px declaration to coarse pointers', () => {
    const coarse = mediaBodies(css, /@media\s*\(pointer:\s*coarse\)\s*\{/gu)
    expect(coarse.length).toBeGreaterThan(0)
    expect(coarse.join('\n')).toContain('min-width: 44px')
    expect(coarse.join('\n')).toContain('min-height: 44px')
    expect(coarse.join('\n')).toContain('max(100%, 44px)')
    // Fine pointers see the base rules only: no unconditional 44px growth.
    expect(mediaBodies(css, /@media\s*\(pointer:\s*coarse\)\s*\{/gu).length).toBeGreaterThan(0)
    const stripped = css.replace(/@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\n\}/gu, '')
    expect(stripped).not.toContain('44px')
  })
})

describe('Button.module.css coarse-pointer geometry', () => {
  const css = read('Button.module.css')

  it('is a manipulation target and carries the shared 44px pseudo on touch', () => {
    expect(declarations(css, '.button')).toEqual(expect.arrayContaining([
      'position: relative',
      'touch-action: manipulation',
    ]))
    const coarse = mediaBodies(css, /@media\s*\(pointer:\s*coarse\)\s*\{/gu).join('\n')
    expect(coarse).toContain('.button::before')
    expect(coarse).toContain('max(100%, 44px)')
  })
})
