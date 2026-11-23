import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Structural contract for the picker stylesheet. A real browser lane owns
 * rendered geometry; these assertions keep the layout primitives that prevent
 * a clipped chevron from regressing.
 */
const css = readFileSync(new URL('../src/client/ModelSelect.module.css', import.meta.url), 'utf8')

/** One flattened rule: comma-separated selectors and normalized declarations. */
function rulesOf(source: string): { selectors: string[]; declarations: Map<string, string> }[] {
  return [...source.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector = '', body = '']) => ({
      selectors: selector.split(',').map(part => part.trim()),
      declarations: new Map(body.split(';')
        .map(part => part.trim())
        .filter(part => part.includes(':'))
        .map((part): [string, string] => {
          const colon = part.indexOf(':')
          return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()]
        })),
    }))
}

/** Declarations of the rule that names one selector in a comma list. */
function declarations(selector: string): Map<string, string> {
  const rule = rulesOf(css).find(candidate => candidate.selectors.includes(selector))
  expect(rule, selector).toBeDefined()
  return rule?.declarations ?? new Map<string, string>()
}

describe('model picker stylesheet layout contract', () => {
  it('uses border-box for every full-width or padded row box', () => {
    for (const [property, value] of declarations('.modelRow')) {
      if (property === 'width') expect(value).toBe('100%')
    }
    expect(declarations('.modelRow').get('box-sizing')).toBe('border-box')
    expect(declarations('.groupHeaderToggle').get('box-sizing')).toBe('border-box')
    expect(declarations('.groupHeaderToggle').has('width')).toBe(false)
    expect(declarations('.groupHeaderToggle').get('flex')).toBe('1 1 auto')
    expect(declarations('.modelRowMain').get('min-width')).toBe('0')
  })

  it('keeps the trailing chevrons unshrinkable and inside the header flow', () => {
    expect(declarations('.groupChevron').get('flex-shrink')).toBe('0')
    expect(declarations('.chevronIcon').get('flex-shrink')).toBe('0')
    expect(declarations('.groupChevron').get('margin-inline-start')).toBe('auto')
  })

  it('draws the popover from elevation and radius tokens without a layout border', () => {
    const popover = declarations('.pickerPopover')
    expect(popover.get('border')).toBe('0')
    expect(popover.get('box-shadow')).toBe('var(--dsw-elevation-prominent)')
    expect(popover.get('border-radius')).toBe('var(--dsw-radius-lg)')
    expect(popover.get('overflow')).toBe('hidden')
  })

  it('uses ring-token outlines with an inset offset so the rounded card cannot clip focus', () => {
    expect(declarations('.modelRowMain:focus-visible').get('outline'))
      .toBe('var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))')
    expect(declarations('.modelRowMain:focus-visible').get('outline-offset')).toBe('-2px')
    expect(declarations('.groupHeaderToggle:focus-visible').get('outline-offset')).toBe('-2px')
  })

  it('keeps coarse-pointer targets at the 44px floor and honours reduced motion', () => {
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
    expect(coarse).toContain('.modelRow,')
    expect(coarse).toContain('.groupHeaderToggle,')
    expect(coarse).toContain('min-height: 44px')
    expect(coarse).toContain('width: 44px')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.modelRow,[\s\S]*?transition: none;/.test(css)).toBe(true)
  })

  it('has no literal colors or unbounded transition shorthands left in the picker', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/\brgba?\(/)
    expect(css).not.toMatch(/transition:\s*all\b/)
  })
})
