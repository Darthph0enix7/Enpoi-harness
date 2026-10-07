#!/usr/bin/env node
/**
 * Refuse operator state in the tracked fresh-install template.
 *
 * `cordis.patch.yml` is the document every fresh install and sandbox clones.
 * The settings service rewrites the same document on a configured machine, so a
 * `git commit -a`, a branch push, or packaging the checkout can leak the
 * operator's providers, default model, UI settings, seats, grants, MCP catalog,
 * chains, favorites, and whiteboard into end-user installs. This checker is the
 * packaging gate: the pre-commit and pre-push hooks run it against the staged
 * and committed document, and it can be run by hand before packaging. The same
 * split is pinned by
 * `packages/enpoi-capabilities/tests/profile-patch.spec.ts`.
 *
 * Usage: node scripts/verify-profile-template.mjs [path-to-cordis.patch.yml]
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = process.argv[2] ?? join(root, 'cordis.patch.yml')
const patch = readFileSync(file, 'utf8')

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
 * Template registry exceptions: the `roles`/`personas` sections stay
 * operator-owned by name, but the tracked template may carry exactly these
 * shipped entries — the two specialist roles the Fleet screens expect, and the
 * keeper/compaction personas pinned to the keyless Kilo route the first-run
 * seed writes. Ids, keys, and the Kilo route are allowlisted; everything else
 * in either section is operator state. Pinned in lockstep with
 * `scripts/install.sh` and `packages/enpoi-capabilities/tests/profile-patch.spec.ts`
 * by `scripts/install-profile-merge.spec.ts`.
 */
const TEMPLATE_ROLE_IDS = ['designer', 'oracle']
const TEMPLATE_ROLE_KEYS = ['label', 'group', 'seat']
const TEMPLATE_PERSONA_IDS = ['keeper', 'compaction']
const TEMPLATE_PERSONA_KEYS = ['provider', 'model']
const TEMPLATE_PERSONA_PROVIDER = 'kilo'
const TEMPLATE_PERSONA_MODEL = 'kilo-auto/free'

const violations = []
for (const id of STATE_ROWS) {
  if (patch.includes(`\n- id: ${id}\n`)) violations.push(`state row '- id: ${id}'`)
}
if (/^\s*onboardingCompleted:/m.test(patch)) violations.push('onboardingCompleted marker')
if (/^\s*providers:/m.test(patch)) violations.push("top-level 'providers:' block")

/** Extract one 4-space orchestration section body, up to the next section or row. */
function templateSection(body, section) {
  const start = body.indexOf(`\n    ${section}:\n`)
  if (start === -1) return undefined
  const rest = body.slice(start + section.length + 7)
  // Section entries indent 6+ spaces; the next section starts at 4 and the
  // next top-level row or comment at column 0.
  const end = rest.search(/^ {0,4}\S/m)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Flag any role entry/key beyond the template allowlist. */
function checkRoleTemplate(section) {
  let current
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue
    const role = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (role !== null) {
      current = role[1]
      if (!TEMPLATE_ROLE_IDS.includes(current)) {
        violations.push(`role '${current}' is not a template role (${TEMPLATE_ROLE_IDS.join(', ')})`)
      }
      continue
    }
    const key = /^        ([A-Za-z0-9_-]+):/.exec(line)
    if (key !== null) {
      if (current === undefined) violations.push(`role key '${key[1]}' appears outside a role entry`)
      else if (!TEMPLATE_ROLE_KEYS.includes(key[1])) {
        violations.push(`role '${current}' carries operator key '${key[1]}'`)
      }
      continue
    }
    violations.push(`unrecognized line in the template roles section: '${line.trim()}'`)
  }
}

/** Flag any persona entry, key, or route beyond the keyless-Kilo template. */
function checkPersonaTemplate(section) {
  let current
  let entry
  const flush = () => {
    if (entry === undefined) {
      return
    }
    for (const key of TEMPLATE_PERSONA_KEYS) {
      if (!(key in entry)) violations.push(`persona '${current}' must carry '${key}'`)
    }
    for (const key of Object.keys(entry)) {
      if (!TEMPLATE_PERSONA_KEYS.includes(key)) {
        violations.push(`persona '${current}' carries operator key '${key}'`)
      }
    }
    if (entry.provider !== TEMPLATE_PERSONA_PROVIDER) {
      violations.push(`persona '${current}' provider must be '${TEMPLATE_PERSONA_PROVIDER}'`)
    }
    if (entry.model !== TEMPLATE_PERSONA_MODEL) {
      violations.push(`persona '${current}' model must be '${TEMPLATE_PERSONA_MODEL}'`)
    }
    entry = undefined
  }
  for (const line of section.split('\n')) {
    if (line.trim() === '') continue
    const persona = /^      ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (persona !== null) {
      flush()
      current = persona[1]
      if (TEMPLATE_PERSONA_IDS.includes(current)) {
        entry = {}
      } else {
        violations.push(`persona '${current}' is not a template persona (${TEMPLATE_PERSONA_IDS.join(', ')})`)
      }
      continue
    }
    const key = /^        ([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/.exec(line)
    if (key !== null && entry !== undefined) {
      entry[key[1]] = key[2]
      continue
    }
    violations.push(`unrecognized line in the template personas section: '${line.trim()}'`)
  }
  flush()
}

const start = patch.indexOf('\n- id: enpoi-orchestration\n')
if (start === -1) {
  violations.push("missing '- id: enpoi-orchestration' row")
} else {
  const row = patch.slice(start + 1)
  const end = row.indexOf('\n- ')
  const body = end === -1 ? row : row.slice(0, end)
  for (const section of STATE_SECTIONS) {
    // roles/personas stay operator-owned names but carry the template
    // registry exceptions checked below.
    if (section === 'roles' || section === 'personas') continue
    if (body.includes(`\n    ${section}:\n`)) violations.push(`operator-owned section '${section}'`)
  }
  const roles = templateSection(body, 'roles')
  if (roles !== undefined) checkRoleTemplate(roles)
  const personas = templateSection(body, 'personas')
  if (personas !== undefined) checkPersonaTemplate(personas)
}

if (violations.length > 0) {
  console.error(`operator state in ${file}:`)
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('the tracked cordis.patch.yml must stay the fresh-install template; move operator state out of the repo before committing or packaging')
  process.exit(1)
}
console.log(`profile template clean: ${file}`)
