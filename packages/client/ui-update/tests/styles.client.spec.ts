/**
 * The pill's restrained-accent stylesheet contract and the version-free pill
 * copy: the available pill reads "Update" (en/zh), carries no version or
 * arrow, and takes exactly one accent step above the neutral chrome.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const indicatorCss = readFileSync(
  fileURLToPath(new URL('../src/client/UpdateIndicator.module.css', import.meta.url)),
  'utf8',
)

/** The declaration block of one selector in the indicator sheet. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(indicatorCss)
  if (match === null) throw new Error(`UpdateIndicator.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('update pill copy', () => {
  it('reads exactly "Update" in both locales', () => {
    expect(zh['indicator.pill']).toBe('更新')
    expect(en['indicator.pill']).toBe('Update')
  })

  it('keeps every pill label version-free (the dialog carries the details)', () => {
    for (const key of ['indicator.pill', 'indicator.pillAria', 'indicator.updating', 'indicator.updatingAria', 'indicator.prepared', 'indicator.preparedAria'] as const) {
      expect(en[key], key).not.toContain('{version}')
      expect(zh[key], key).not.toContain('{version}')
    }
  })
})

describe('manual check styling', () => {
  it('renders the check action as a quiet inline text action', () => {
    const check = block('.checkAction')
    expect(check).toContain('color: var(--dsw-alias-label-tertiary)')
    expect(check).toContain('background: none')
    expect(check).toContain('border: 0')
  })
})

describe('update pill accent', () => {
  it('colors the available and prepared states with the single restrained accent token', () => {
    const accent = block(".pill[data-dsh-update-indicator='available'],\n.pill[data-dsh-update-indicator='prepared']")
    expect(accent).toContain('color: var(--dsw-alias-brand-primary-new-colorprimary-new-color)')
  })

  it('keeps the executing state on the neutral label color', () => {
    const pill = block('.pill')
    expect(pill).toContain('color: var(--dsw-alias-label-secondary)')
    expect(pill).not.toContain('--dsw-alias-brand-primary-new-colorprimary-new-color')
  })

  it('keeps the pill a capsule with circular ends on corner-shaping engines', () => {
    expect(block('.pill')).toContain('corner-shape: round')
  })
})
