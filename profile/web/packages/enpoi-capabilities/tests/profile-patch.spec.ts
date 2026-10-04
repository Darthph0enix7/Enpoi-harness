import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Profile-patch guard for the fresh-install template.
 *
 * `cordis.patch.yml` is what every fresh install and sandbox clones, while the
 * settings service rewrites the same document on the machine where the
 * operator edits it: provider routes, the default-model seat, UI settings,
 * seats, permissions, grants, the MCP catalog, chains, favorites, whiteboard.
 * This spec pins the split so live state can never be committed back:
 *
 * 1. Tool presentation stays native (`run_code` is not advertised).
 * 2. No settings/state row ships: no `llm-pi-ai` provider routes, no
 *    `agent-default-model`, no UI settings rows, no onboarding marker.
 * 3. The `enpoi-orchestration` row carries the template parameters only, never
 *    the operator-owned sections (capabilities, MCP catalog/status, personas,
 *    roles, councils, chains, catalog rules, UI preferences, permissions,
 *    whiteboard, tool groups).
 * 4. Exactly the three agent presets ship, with the upstream preset rows
 *    disabled, and nothing ever links the gated opencode free tier.
 */

const PATCH = readFileSync(new URL('../../../cordis.patch.yml', import.meta.url), 'utf8')

/** Settings rows the config editor creates on a configured machine. */
const STATE_ROWS = [
  'agent-default-model',
  'llm-pi-ai',
  'ui-settings-general',
  'ui-settings-models',
  'ui-theme',
]

/** Operator-owned sections of the `enpoi-orchestration` document. */
const STATE_SECTIONS = [
  'capabilities', 'mcpServers', 'mcpStatus', 'personas', 'roles', 'councils',
  'chains', 'catalogRules', 'uiPreferences', 'permissions', 'whiteboard', 'toolGroups',
]

describe('web profile patch template guard', () => {
  it('presents every tool-presentation row as native (run_code is not advertised)', () => {
    const rows = PATCH.split('- id: tool-presentation').slice(1)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const config = row.slice(0, row.indexOf('\n\n'))
      expect(config).toContain('mode: native')
      expect(config).not.toContain('mode: both')
      expect(config).not.toContain('mode: ptc')
    }
  })

  it('ships no settings/state rows', () => {
    for (const id of STATE_ROWS) {
      expect(PATCH.includes(`\n- id: ${id}\n`), `state row ${id} must not ship`).toBe(false)
    }
    expect(PATCH).not.toMatch(/^\s*onboardingCompleted:/m)
    expect(PATCH).not.toMatch(/^\s*providers:/m)
  })

  it('ships no operator-owned orchestration sections', () => {
    const start = PATCH.indexOf('\n- id: enpoi-orchestration\n')
    expect(start).toBeGreaterThan(-1)
    const row = PATCH.slice(start + 1)
    const body = row.slice(0, row.indexOf('\n- '))
    for (const section of STATE_SECTIONS) {
      expect(body.includes(`\n    ${section}:\n`), `section ${section} must not ship`).toBe(false)
    }
    expect(body).toContain('parameters:')
  })

  it('ships exactly the three presets and keeps the upstream rows disabled', () => {
    expect(PATCH.match(/\n {4}- id: preset-/g)).toHaveLength(3)
    for (const id of ['orchestrator', 'sysadmin', 'creator']) {
      expect(PATCH).toContain(`\n    - id: preset-${id}\n`)
    }
    for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
      expect(PATCH).toContain(`- id: preset-${id}\n  disabled: true`)
    }
    expect(PATCH).toContain('- id: agent-preset-registry\n  config:\n    default: orchestrator')
  })

  it('never routes into the gated opencode free tier', () => {
    expect(PATCH).not.toMatch(/^\s*-? ?provider: opencode\s*$/m)
    expect(PATCH).not.toMatch(/model: \S*-free\s*$/m)
  })
})
