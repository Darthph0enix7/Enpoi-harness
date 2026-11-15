/** The Models master list stacks on phones; no horizontal provider strip. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ModelsSection.module.css', import.meta.url), 'utf8')

describe('Models phone layout', () => {
  it('stacks the provider list and leaves overflow to the settings page', () => {
    expect(css).toContain('@media (max-width: 820px)')
    expect(css).not.toMatch(/\.providerListScrollable\s*\{[^}]*overflow-x:\s*auto/s)
    expect(css).toMatch(/\.providerListScrollable\s*\{[^}]*flex-direction:\s*column/s)
    expect(css).toMatch(/\.providerListItem\s*\{[^}]*min-width:\s*0/s)
    expect(css).toMatch(/\.testBtn\s*\{[^}]*min-height:\s*44px/s)
  })
})
