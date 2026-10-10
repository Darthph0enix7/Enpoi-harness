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
 * and committed document, and it can be run by hand before packaging. It also
 * refuses committed per-device patches under `device-patches/` (found next to
 * the checked document): another machine's MCP servers and capability flags
 * are operator state and must live in the dotfiles repo or `sync-local.yaml`.
 * The same split is pinned by
 * `packages/enpoi-capabilities/tests/profile-patch.spec.ts`.
 *
 * Usage: node scripts/verify-profile-template.mjs [path-to-cordis.patch.yml]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
 * Template registry exceptions: the `roles` section stays operator-owned by
 * name, but the tracked template may carry exactly these shipped entries — the
 * two specialist roles the Fleet screens expect. Ids and keys are allowlisted;
 * everything else in the section is operator state. Personas are route state
 * and never belong in the tracked template: the keeper/compaction personas
 * are written by the first-run seed (packages/host/first-run). Pinned in
 * lockstep with `scripts/install.sh` and
 * `packages/enpoi-capabilities/tests/profile-patch.spec.ts` by
 * `scripts/install-profile-merge.spec.ts`.
 */
const TEMPLATE_ROLE_IDS = ['designer', 'oracle']
const TEMPLATE_ROLE_KEYS = ['label', 'group', 'seat']

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

const start = patch.indexOf('\n- id: enpoi-orchestration\n')
if (start === -1) {
  violations.push("missing '- id: enpoi-orchestration' row")
} else {
  const row = patch.slice(start + 1)
  const end = row.indexOf('\n- ')
  const body = end === -1 ? row : row.slice(0, end)
  for (const section of STATE_SECTIONS) {
    // roles stays an operator-owned name but carries the template registry
    // exception checked below; every other section, personas included, is
    // operator state and must not ship.
    if (section === 'roles') continue
    if (body.includes(`\n    ${section}:\n`)) violations.push(`operator-owned section '${section}'`)
  }
  const roles = templateSection(body, 'roles')
  if (roles !== undefined) checkRoleTemplate(roles)
}

// A committed device patch is another machine's settings delta; the merged
// engine folds it in only when the file is named exactly after the resolved
// host, so on every other device it is dead weight that can still ship. The
// release archive prunes it; this gate refuses it at the source.
const patchesDir = join(dirname(resolve(file)), 'device-patches')
if (existsSync(patchesDir)) {
  for (const entry of readdirSync(patchesDir, { recursive: true })) {
    const rel = String(entry)
    if (rel === 'README.md') continue
    violations.push(`device patch 'device-patches/${rel}' is committed operator state`)
  }
}

if (violations.length > 0) {
  console.error(`operator state in ${file}:`)
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('the tracked cordis.patch.yml must stay the fresh-install template; move operator state out of the repo before committing or packaging')
  process.exit(1)
}
console.log(`profile template clean: ${file}`)
