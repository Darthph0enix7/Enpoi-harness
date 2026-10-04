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

const violations = []
for (const id of STATE_ROWS) {
  if (patch.includes(`\n- id: ${id}\n`)) violations.push(`state row '- id: ${id}'`)
}
if (/^\s*onboardingCompleted:/m.test(patch)) violations.push('onboardingCompleted marker')
if (/^\s*providers:/m.test(patch)) violations.push("top-level 'providers:' block")

const start = patch.indexOf('\n- id: enpoi-orchestration\n')
if (start === -1) {
  violations.push("missing '- id: enpoi-orchestration' row")
} else {
  const row = patch.slice(start + 1)
  const end = row.indexOf('\n- ')
  const body = end === -1 ? row : row.slice(0, end)
  for (const section of STATE_SECTIONS) {
    if (body.includes(`\n    ${section}:\n`)) violations.push(`operator-owned section '${section}'`)
  }
}

if (violations.length > 0) {
  console.error(`operator state in ${file}:`)
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('the tracked cordis.patch.yml must stay the fresh-install template; move operator state out of the repo before committing or packaging')
  process.exit(1)
}
console.log(`profile template clean: ${file}`)
