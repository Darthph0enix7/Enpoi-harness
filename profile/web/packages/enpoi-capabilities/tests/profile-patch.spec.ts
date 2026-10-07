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
 * 3. The `enpoi-orchestration` row carries the template parameters and the
 *    template registry entries only, never the operator-owned sections
 *    (capabilities, MCP catalog/status, councils, chains, catalog rules, UI
 *    preferences, permissions, whiteboard, tool groups). `roles`/`personas`
 *    stay operator-owned names with narrow template exceptions: designer/
 *    oracle with label/group/seat, and keeper/compaction on the keyless Kilo
 *    route.
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

/**
 * Template registry exceptions: the only role/persona entries the tracked
 * template may carry. Pinned in lockstep with
 * `scripts/verify-profile-template.mjs` and `scripts/install.sh` by
 * `scripts/install-profile-merge.spec.ts`.
 */
const TEMPLATE_ROLE_IDS = ['designer', 'oracle']
const TEMPLATE_ROLE_KEYS = ['label', 'group', 'seat']
const TEMPLATE_PERSONA_IDS = ['keeper', 'compaction']
const TEMPLATE_PERSONA_KEYS = ['provider', 'model']
const TEMPLATE_PERSONA_PROVIDER = 'kilo'
const TEMPLATE_PERSONA_MODEL = 'kilo-auto/free'

/** The `enpoi-orchestration` row body, ending before the next top-level row. */
function orchestrationBody(patch: string): string {
  const start = patch.indexOf('\n- id: enpoi-orchestration\n')
  if (start === -1) throw new Error('missing enpoi-orchestration row')
  const row = patch.slice(start + 1)
  const end = row.indexOf('\n- ')
  return end === -1 ? row : row.slice(0, end)
}

/** One 4-space section body: entries indent 6+; the next section starts at 4. */
function templateSection(body: string, section: string): string | undefined {
  const start = body.indexOf(`\n    ${section}:\n`)
  if (start === -1) return undefined
  const rest = body.slice(start + section.length + 7)
  const end = rest.search(/^ {0,4}\S/m)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Parse a roles section into `{ id: { key: scalar } }`. */
function parseRoles(body: string): Record<string, Record<string, string>> {
  const section = templateSection(body, 'roles')
  const roles: Record<string, Record<string, string>> = {}
  if (section === undefined) return roles
  let current: string | undefined
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue
    const id = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (id !== null) {
      current = id[1]!
      roles[current] = {}
      continue
    }
    const key = /^        ([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/.exec(line)
    if (key === null || current === undefined) throw new Error(`unrecognized roles line: ${line}`)
    roles[current]![key[1]!] = key[2]!
  }
  return roles
}

/** Parse a personas section into `{ id: { key: scalar } }`. */
function parsePersonas(body: string): Record<string, Record<string, string>> {
  const section = templateSection(body, 'personas')
  const personas: Record<string, Record<string, string>> = {}
  if (section === undefined) return personas
  let current: string | undefined
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue
    const id = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (id !== null) {
      current = id[1]!
      personas[current] = {}
      continue
    }
    const key = /^        ([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/.exec(line)
    if (key === null || current === undefined) throw new Error(`unrecognized personas line: ${line}`)
    personas[current]![key[1]!] = key[2]!
  }
  return personas
}

/** The guard's rejection predicate over one orchestration body. */
function templateEntryViolations(body: string): string[] {
  const violations: string[] = []
  const roles = templateSection(body, 'roles')
  if (roles !== undefined) {
    let current: string | undefined
    for (const line of roles.split('\n')) {
      if (line.trim() === '') continue
      const id = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (id !== null) {
        current = id[1]
        if (!TEMPLATE_ROLE_IDS.includes(current!)) violations.push(`role '${current}' is not a template role`)
        continue
      }
      const key = /^        ([A-Za-z0-9_-]+):/.exec(line)
      if (key === null) violations.push(`unrecognized role line '${line.trim()}'`)
      else if (current === undefined) violations.push(`role key '${key[1]}' outside a role entry`)
      else if (!TEMPLATE_ROLE_KEYS.includes(key[1]!)) violations.push(`role '${current}' carries operator key '${key[1]}'`)
    }
  }
  const personas = templateSection(body, 'personas')
  if (personas !== undefined) {
    let current: string | undefined
    let entry: Record<string, string> | undefined
    const flush = (): void => {
      if (entry === undefined) return
      for (const key of TEMPLATE_PERSONA_KEYS) if (!(key in entry)) violations.push(`persona '${current}' must carry '${key}'`)
      for (const key of Object.keys(entry)) if (!TEMPLATE_PERSONA_KEYS.includes(key)) violations.push(`persona '${current}' carries operator key '${key}'`)
      if (entry.provider !== TEMPLATE_PERSONA_PROVIDER) violations.push(`persona '${current}' provider must be 'kilo'`)
      if (entry.model !== TEMPLATE_PERSONA_MODEL) violations.push(`persona '${current}' model must be 'kilo-auto/free'`)
      entry = undefined
    }
    for (const line of personas.split('\n')) {
      if (line.trim() === '') continue
      const id = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
      if (id !== null) {
        flush()
        current = id[1]
        if (TEMPLATE_PERSONA_IDS.includes(current)) entry = {}
        else violations.push(`persona '${current}' is not a template persona`)
        continue
      }
      const key = /^        ([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/.exec(line)
      if (key !== null && entry !== undefined) {
        entry[key[1]!] = key[2]!
        continue
      }
      violations.push(`unrecognized persona line '${line.trim()}'`)
    }
    flush()
  }
  return violations
}

describe('web profile patch template guard', () => {
  it('presents every tool-presentation row as both (native tools + run_code)', () => {
    const rows = PATCH.split('- id: tool-presentation').slice(1)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const config = row.slice(0, row.indexOf('\n\n'))
      expect(config).toContain('mode: both')
      expect(config).not.toContain('mode: native')
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

  it('ships no operator-owned orchestration sections beyond the template registry entries', () => {
    const body = orchestrationBody(PATCH)
    for (const section of STATE_SECTIONS) {
      if (section === 'roles' || section === 'personas') continue
      expect(body.includes(`\n    ${section}:\n`), `section ${section} must not ship`).toBe(false)
    }
    expect(body).toContain('parameters:')
    expect(templateEntryViolations(body)).toEqual([])
  })

  it('ships only the designer/oracle roles with label/group/seat', () => {
    const roles = parseRoles(orchestrationBody(PATCH))
    expect(Object.keys(roles).sort()).toEqual(['designer', 'oracle'])
    for (const [id, entry] of Object.entries(roles)) {
      expect(Object.keys(entry).sort(), `role ${id} keys`).toEqual([...TEMPLATE_ROLE_KEYS].sort())
    }
    expect(roles['designer']).toEqual({ label: 'Designer', group: 'specialists', seat: 'true' })
    expect(roles['oracle']).toEqual({ label: 'The Oracle', group: 'supervision', seat: 'true' })
  })

  it('pins the keeper/compaction personas to the keyless Kilo route', () => {
    const personas = parsePersonas(orchestrationBody(PATCH))
    expect(Object.keys(personas).sort()).toEqual(['compaction', 'keeper'])
    for (const [id, entry] of Object.entries(personas)) {
      expect(entry, `persona ${id}`).toEqual({ provider: 'kilo', model: 'kilo-auto/free' })
    }
  })

  it('rejects role/persona entries outside the template allowlist', () => {
    const body = orchestrationBody(PATCH)
    const hostileRole = body.replace('    roles:\n', '    roles:\n      toto:\n        label: Operator\n')
    expect(templateEntryViolations(hostileRole).join('\n')).toContain("role 'toto' is not a template role")
    const hostileKey = body.replace('      designer:\n        label: Designer\n', '      designer:\n        persona: |\n          operator text\n        label: Designer\n')
    expect(templateEntryViolations(hostileKey).join('\n')).toContain("role 'designer' carries operator key 'persona'")
    const hostileRoute = body.replace('        provider: kilo', '        provider: openrouter')
    expect(templateEntryViolations(hostileRoute).join('\n')).toContain("persona 'keeper' provider must be 'kilo'")
    const hostileChain = body.replace('      keeper:\n        provider: kilo', '      keeper:\n        provider: kilo\n        chain: free')
    expect(templateEntryViolations(hostileChain).join('\n')).toContain("persona 'keeper' carries operator key 'chain'")
    const hostilePersona = body.replace('    personas:\n', '    personas:\n      oracle:\n        provider: kilo\n        model: kilo-auto/free\n')
    expect(templateEntryViolations(hostilePersona).join('\n')).toContain("persona 'oracle' is not a template persona")
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
