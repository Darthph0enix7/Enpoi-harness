/** Settings shell box-model guards read as CSS text; jsdom has no layout. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/SettingsRoot.module.css', import.meta.url), 'utf8')

function ruleFor(selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const escaped = selector.replace(/[.[\]():*+^$\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(source)
  if (match === null) throw new Error(`no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('settings scroll box model', () => {
  it('keeps the compact list/detail scroll hosts inside their page', () => {
    expect(ruleFor('.mobileList')).toContain('box-sizing: border-box')
    expect(ruleFor('.mobileDetail')).toContain('box-sizing: border-box')
  })

  it('gives section-owned content the same border box so width:100% + padding cannot overflow', () => {
    const group = /\.mobileDetail \*,[\s\S]*?\.content \*\s*\{([^}]*)\}/.exec(css)
    expect(group).not.toBeNull()
    expect(group?.[1]).toContain('box-sizing: border-box')
    for (const selector of ['.mobileDetail *', '.mobileList *', '.options *', '.content *']) {
      expect(css).toContain(selector)
    }
  })
})
