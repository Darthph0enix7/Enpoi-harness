/** Phone preset switcher must not widen the settings scroll host. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/PluginInventorySettingsTab.module.css', import.meta.url), 'utf8')

describe('plugin inventory phone layout', () => {
  it('gives the preset switcher a full-width row below the group title', () => {
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toMatch(/\.groupTitleRow\s*\{[^}]*flex-wrap:\s*wrap/s)
    expect(css).toMatch(/\.headerEnd\s*\{[^}]*width:\s*100%/s)
    expect(css).toMatch(/\.switcher\s*\{[^}]*width:\s*100%/s)
    expect(css).toMatch(/\.switcherLabel\s*\{[^}]*min-width:\s*0/s)
  })
})
