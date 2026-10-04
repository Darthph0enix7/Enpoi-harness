#!/usr/bin/env node
/**
 * disable-free-tier.mjs — keep OpenCode's `-free` models out of the default
 * route set, idempotently.
 *
 * Why this exists: `cordis.patch.yml` is also the document the merged
 * config-editor writes (`packages/boot/config-editor/src/index.ts`): a
 * settings write re-serializes the *live* entry config of the row it touches,
 * and the model picker's selection save (`dsh-agent-default-model`)
 * materializes the default seat's provider/model/chain. A hand-applied text
 * disable therefore does not survive a settings rewrite — this script
 * re-applies it, and `packages/enpoi-capabilities/tests/profile-patch.spec.ts`
 * fails the profile test run when the invariant drifts.
 *
 * Invariant (evidence: ~/dsh-migration/evidence/free-tier/opencode-free-tier-403.md):
 * OpenCode gates `opencode/*-free` server-side to its own clients — "You cannot
 * use the free tier in other harnesses" (anomalyco/opencode#49621) — so a
 * harness call gets `403 FreeTierError`. The `free` chain stays present but
 * `disabled: true` (the house pattern: the dead links stay visible for an
 * operator to repair), and no default seat or enabled chain may reference it.
 *
 * Usage: node scripts/disable-free-tier.mjs [patch-path]
 * Exit 0 when the invariant holds (with or without a rewrite); exit 1 when it
 * cannot be restored.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = process.argv[2] ?? join(PROFILE, 'cordis.patch.yml')

/** Paid route the default seat falls back to when no chain is selected. */
const PAID = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
/** Chain id whose links are OpenCode's gated free tier. */
const FREE_CHAIN = 'free'

// A fresh profile has no patch yet (initProfile writes the template later).
if (!existsSync(PATCH)) {
  console.log(`disable-free-tier: no patch at ${PATCH}; nothing to do`)
  process.exit(0)
}

const original = readFileSync(PATCH, 'utf8')
let text = original
const changed = []

/** One indented block, from its `header` line to the next line of equal-or-lower indent. */
function blockOf(source, header, keyIndent) {
  const start = source.indexOf(header)
  if (start === -1) return undefined
  const rest = source.slice(start + 1)
  const end = rest.search(new RegExp(`\\n {0,${keyIndent}}[A-Za-z0-9_@./-]`))
  return { start, end: end === -1 ? source.length : start + 1 + end + 1 }
}

/** Every `      <id>:` chain entry inside the `    chains:` map. */
function chainBlocks(source) {
  const map = source.indexOf('\n    chains:\n')
  if (map === -1) return []
  const body = source.slice(map + 1)
  const stop = body.search(/\n {4}[A-Za-z0-9_@./-]+:/)
  const scope = stop === -1 ? body : body.slice(0, stop)
  const ids = [...scope.matchAll(/\n {6}([A-Za-z0-9_@./-]+):\n/g)].map(match => match[1])
  return ids.map((id) => {
    const header = `\n      ${id}:\n`
    const start = source.indexOf(header)
    const rest = source.slice(start + 1)
    const end = rest.search(/\n {0,6}[A-Za-z0-9_@./-]/)
    return { id, start, body: rest.slice(0, end === -1 ? undefined : end + 1) }
  })
}

const chains = chainBlocks(text)
const free = chains.find(chain => chain.id === FREE_CHAIN)
if (free === undefined) {
  console.error(`disable-free-tier: no "${FREE_CHAIN}" chain entry in ${PATCH} — nothing to disable`)
} else if (/^        disabled: false$/m.test(free.body)) {
  const next = free.body.replace(/^        disabled: false$/m, '        disabled: true')
  text = text.slice(0, free.start + 1) + next + text.slice(free.start + 1 + free.body.length)
  changed.push(`chain ${FREE_CHAIN}: disabled false → true`)
} else if (!/^        disabled: true$/m.test(free.body)) {
  const next = free.body.replace(/\n$/, '\n        disabled: true\n')
  text = text.slice(0, free.start + 1) + next + text.slice(free.start + 1 + free.body.length)
  changed.push(`chain ${FREE_CHAIN}: added disabled: true`)
}

// The default seat must name a paid route and no chain fallback.
let seat = blockOf(text, '\n- id: agent-default-model\n', 0)
if (seat === undefined) {
  // Repair on write: a settings write can re-serialize the document without
  // this row (observed 2026-10-02, which blocked the boot). Insert it before
  // the second top-level row so the seat invariant survives.
  const secondRow = text.indexOf('\n- id: ', 1)
  if (secondRow === -1) {
    console.error('disable-free-tier: no agent-default-model row and no insertion point — cannot pin the default seat')
    process.exit(1)
  }
  const row = `\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${PAID.provider}\n    model: ${PAID.model}\n`
  text = text.slice(0, secondRow) + row + text.slice(secondRow)
  seat = blockOf(text, '\n- id: agent-default-model\n', 0)
  if (seat === undefined) {
    console.error('disable-free-tier: seat row still missing after insertion')
    process.exit(1)
  }
  changed.push('seat: inserted the agent-default-model row')
}
let seatBody = text.slice(seat.start + 1, seat.end)
const beforeSeat = seatBody
seatBody = seatBody
  .replace(/^    provider: .*$/m, `    provider: ${PAID.provider}`)
  .replace(/^    model: .*$/m, `    model: ${PAID.model}`)
  .replace(/^    chain: .*\n/gm, '')
if (!/^    provider: /m.test(seatBody)) {
  seatBody = seatBody.replace(/^(  config:\n)/m, `$1    provider: ${PAID.provider}\n    model: ${PAID.model}\n`)
}
if (seatBody !== beforeSeat) {
  text = text.slice(0, seat.start + 1) + seatBody + text.slice(seat.end)
  changed.push(`agent-default-model: pin ${PAID.provider}/${PAID.model}, drop chain`)
}

if (text !== original) writeFileSync(PATCH, text)

// Verify the invariant on the final document, not on the intent. The checks
// accept any indentation, so a nested seat cannot slip past the guard in
// packages/enpoi-capabilities/tests/profile-patch.spec.ts.
const final = readFileSync(PATCH, 'utf8')
const failures = []
const finalChains = chainBlocks(final)
const finalDeclared = new Map(finalChains.map(chain => [chain.id, chain]))
for (const chain of finalChains) {
  if (/^[ \t]*disabled:[ \t]*true[ \t]*$/m.test(chain.body)) continue
  for (const link of chain.body.matchAll(/^[ \t]*- provider: (\S+)\n[ \t]*model: (\S+)/gm)) {
    if (link[1] === 'opencode' && link[2].endsWith('-free')) {
      failures.push(`enabled chain ${chain.id} links gated free model ${link[2]}`)
    }
  }
}
for (const reference of final.matchAll(/^[ \t]*chain:[ \t]*(\S+?)[ \t]*(?:#.*)?$/gm)) {
  const id = reference[1].replace(/^["']|["']$/g, '')
  const target = finalDeclared.get(id)
  if (target === undefined || /^[ \t]*disabled:[ \t]*true[ \t]*$/m.test(target.body)) {
    failures.push(`a config still references unusable chain ${id}`)
  }
}
const finalSeat = final.slice(final.indexOf('\n- id: agent-default-model\n'))
const seatBlock = finalSeat.slice(0, finalSeat.indexOf('\n- id:', 1) === -1 ? undefined : finalSeat.indexOf('\n- id:', 1))
if (/^    chain:/m.test(seatBlock) || /model: .*-free/m.test(seatBlock)) {
  failures.push('agent-default-model still names a chain or a free model')
}

if (failures.length > 0) {
  console.error('disable-free-tier: invariant NOT restored:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(changed.length === 0
  ? `disable-free-tier: already clean (${PATCH})`
  : `disable-free-tier: applied ${String(changed.length)} fix(es) to ${PATCH}\n  ${changed.join('\n  ')}`)
