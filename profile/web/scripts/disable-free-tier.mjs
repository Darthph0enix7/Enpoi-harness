#!/usr/bin/env node
/**
 * disable-free-tier.mjs — keep OpenCode's gated `-free` models out of every
 * enabled route, idempotently.
 *
 * Why this exists: `cordis.patch.yml` is also the document the merged
 * config-editor writes (`packages/boot/config-editor/src/index.ts`): a
 * settings write re-serializes the *live* entry config of the row it touches,
 * and the model picker's selection save (`dsh-agent-default-model`)
 * materializes the default seat's provider/model/chain. A hand-applied edit
 * therefore does not survive a settings rewrite — this script re-establishes
 * the invariant at boot, and
 * `packages/enpoi-capabilities/tests/disable-free-tier.spec.ts` fails the
 * profile test run when the script, its constant, or its built-in inventory
 * drifts.
 *
 * Invariant (evidence: ~/dsh-migration/evidence/free-tier/
 * opencode-free-tier-403.md): OpenCode gates `opencode/*-free` server-side to
 * its own clients — "You cannot use the free tier in other harnesses"
 * (anomalyco/opencode#49621) — so a harness call gets `403 FreeTierError`.
 * The invariant is content, not a chain name:
 *
 *   1. No enabled chain may link an `opencode/*-free` model.
 *   2. Every `chain:` reference names a declared chain that is not
 *      `disabled: true`, or a group id shipped by `dsh-enpoi-model-chains`
 *      (BUILTIN_CHAIN_IDS below). A settings row with a built-in id replaces
 *      the built-in entirely, including a `disabled: true` opt-out.
 *   3. `agent-default-model` names a resolvable target: a complete
 *      `provider`+`model` pair that is not gated free, or a valid `chain`.
 *      Both may be present (primary route + fallback group).
 *
 * The shipped `free` group is a selector group (`zeroPrice`, `tools`,
 * `gated: false`, `visible`, `minContextWindow`, `adopt: true`), so it never
 * links a gated model and needs no settings row; `disabled` is the operator's
 * switch. This script never enables or disables a chain by name. A chain whose
 * only members are gated free links is reported as a warning, and an enabled
 * one fails through (1). The only document write is the repair-on-write
 * insertion of a missing `agent-default-model` row (a settings save can drop
 * it), pinned to the keyless Kilo baseline the first-run seed also writes —
 * never to a paid route.
 *
 * Usage: node scripts/disable-free-tier.mjs [patch-path]
 * Exit 0 when the invariant holds (with or without a repair); exit 1 when it
 * cannot be established.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = process.argv[2] ?? join(PROFILE, 'cordis.patch.yml')

/**
 * Group ids in the `dsh-enpoi-model-chains` plugin's default `builtinChains`
 * (`SHIPPED_BUILTIN_CHAINS` in packages/enpoi-model-chains/src/index.ts). A
 * built-in group has no settings row, so this literal is the only way the boot
 * guard can see it. The guard cannot import the TypeScript plugin (it runs
 * before boot under plain Node); the profile spec reads both sources and fails
 * when they drift.
 */
const BUILTIN_CHAIN_IDS = ['free']

/**
 * Route the repair-on-write path inserts when a settings save dropped the
 * `agent-default-model` row: the keyless Kilo baseline the plugin resolves a
 * blank selection to (`BASELINE_PROVIDER`/`BASELINE_MODEL` in
 * packages/core/agent-default-model), never the retired paid `opencode-go`
 * pin. The repair pins no chain.
 */
const BASELINE = { provider: 'kilo', model: 'kilo-auto/free' }

// A fresh profile has no patch yet (initProfile writes the template later).
if (!existsSync(PATCH)) {
  console.log(`disable-free-tier: no patch at ${PATCH}; nothing to do`)
  process.exit(0)
}

const original = readFileSync(PATCH, 'utf8')

/** A field value: trimmed, unquoted, without a trailing comment. */
function scalar(raw) {
  const value = raw.replace(/\s+#.*$/, '').trim()
  if (value === '') return undefined
  return value.replace(/^['"]|['"]$/g, '')
}

/**
 * A block-style `key:` map: its body and the indentation of its entries.
 * @param source - document text to search.
 * @param key - map key name.
 * @returns the body and entry indentation, or undefined when the map is absent
 *   or written in flow style.
 */
function mapBlock(source, key) {
  const header = new RegExp(`^([ \\t]*)${key}:[ \\t]*(?:#.*)?$`, 'm').exec(source)
  if (header === null) return undefined
  const indent = header[1].length
  const start = header.index + header[0].length + 1
  const rest = source.slice(start)
  const end = rest.search(new RegExp(`\\n[ \\t]{0,${String(indent)}}[^\\s#]`))
  return { indent, body: end === -1 ? rest : rest.slice(0, end + 1) }
}

/**
 * One `id:` entry inside a block map, with the lines that follow it.
 * @param map - a block returned by {@link mapBlock}.
 * @returns entries in document order.
 */
function mapEntries(map) {
  const entryIndent = map.indent + 2
  const entries = []
  let current
  let offset = 0
  for (const line of map.body.split('\n')) {
    const trimmed = line.trim()
    const indent = line.length - line.trimStart().length
    if (trimmed !== '' && indent === entryIndent) {
      const match = /^([A-Za-z0-9_@./-]+):[ \t]*(?:#.*)?$/.exec(trimmed)
      if (match !== null) {
        if (current !== undefined) entries.push({ id: current.id, body: map.body.slice(current.start, offset) })
        current = { id: match[1], start: offset }
      }
    }
    offset += line.length + 1
  }
  if (current !== undefined) entries.push({ id: current.id, body: map.body.slice(current.start) })
  return entries
}

/**
 * The list items of a block sequence body (each item keeps its continuation
 * lines).
 * @param body - a sequence body from {@link mapBlock}.
 * @returns one chunk per `-` item.
 */
function listItems(body) {
  const items = []
  for (const line of body.split('\n')) {
    if (/^[ \t]*-([ \t]+|$)/.test(line)) items.push(line.replace(/^[ \t]*-[ \t]*/, ''))
    else if (items.length > 0 && /^[ \t]+\S/.test(line)) items[items.length - 1] += `\n${line}`
  }
  return items
}

/**
 * The scalar value of `key` inside a chunk.
 * @param chunk - an item or row body.
 * @param key - field name.
 * @param indent - exact indentation, or undefined for any indentation.
 * @returns the value, or undefined when absent or blank.
 */
function scalarOf(chunk, key, indent) {
  const prefix = indent === undefined ? '[ \\t]*' : `[ \\t]{${String(indent)}}`
  const match = new RegExp(`(?:^|\\n)${prefix}${key}:[ \\t]*(.*)$`, 'm').exec(chunk)
  return match === null ? undefined : scalar(match[1])
}

/** Whether a link is OpenCode's gated free tier (`opencode/*-free`). */
function isGatedFree(provider, model) {
  return provider === 'opencode' && model.endsWith('-free')
}

/**
 * The value of `key` in one flow map.
 * @param text - a `{ … }` flow map.
 * @param key - field name.
 * @returns the value, or undefined when absent.
 */
function flowField(text, key) {
  const match = new RegExp(`(?:^|[{,\\s])${key}:[ \\t]*['"]?([^,'"\\s}]+)`).exec(text)
  return match === null ? undefined : match[1]
}

/**
 * Provider/model pairs declared by a chain: block `links:` items plus flow-map
 * syntax (`links: [{ provider: …, model: … }]`).
 * @param chainBody - one chain entry body.
 * @returns deduplicated links in document order.
 */
function linkPairs(chainBody) {
  const pairs = []
  const links = mapBlock(chainBody, 'links')
  if (links !== undefined) {
    for (const item of listItems(links.body)) {
      const provider = scalarOf(item, 'provider')
      const model = scalarOf(item, 'model')
      if (provider !== undefined && model !== undefined) pairs.push({ provider, model })
    }
  }
  for (const flow of chainBody.matchAll(/\{[^{}]*\}/g)) {
    const provider = flowField(flow[0], 'provider')
    const model = flowField(flow[0], 'model')
    if (provider !== undefined && model !== undefined) pairs.push({ provider, model })
  }
  return pairs.filter(
    (pair, index) => pairs.findIndex(other => other.provider === pair.provider && other.model === pair.model) === index,
  )
}

/**
 * Parse the `chains` map: id → { disabled, links }.
 * @param source - document text.
 * @returns the declared chains.
 */
function declaredChains(source) {
  const map = mapBlock(source, 'chains')
  const chains = new Map()
  if (map === undefined) return chains
  for (const entry of mapEntries(map)) {
    chains.set(entry.id, {
      disabled: /^[ \t]*disabled:[ \t]*true[ \t]*(?:#.*)?$/m.test(entry.body),
      links: linkPairs(entry.body),
    })
  }
  return chains
}

/**
 * Whether a `chain:` reference can route: a declared chain that is enabled, or
 * a shipped built-in id with no shadowing settings row.
 * @param id - referenced group id.
 * @param declared - parsed `chains` map.
 * @returns true when the runtime can resolve the id.
 */
function isResolvableChain(id, declared) {
  const chain = declared.get(id)
  if (chain !== undefined) return !chain.disabled
  return BUILTIN_CHAIN_IDS.includes(id)
}

/**
 * One top-level patch row by id, ending before the next top-level row.
 * @param source - document text.
 * @param id - row id.
 * @returns the row body, or undefined when the row is absent.
 */
function rowBody(source, id) {
  const header = new RegExp(`(?:^|\\n)- id: ${id}\\n`).exec(source)
  if (header === null) return undefined
  const start = header.index + header[0].length
  const rest = source.slice(start)
  const end = rest.search(/\n- /)
  return end === -1 ? rest : rest.slice(0, end)
}

// Repair on write: a settings save can re-serialize the document without the
// default seat row (observed 2026-10-02, which blocked the boot). Insert it as
// a top-level row next to the shipped composition; the inserted route is the
// keyless Kilo baseline the first-run seed also writes, never a paid pin.
let text = original
const changed = []
if (rowBody(text, 'agent-default-model') === undefined) {
  const secondRow = text.indexOf('\n- id: ', 1)
  if (secondRow === -1) {
    console.error('disable-free-tier: no agent-default-model row and no insertion point — cannot repair the default seat')
    process.exit(1)
  }
  const row = `\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: ${BASELINE.provider}\n    model: ${BASELINE.model}\n`
  text = text.slice(0, secondRow) + row + text.slice(secondRow)
  changed.push(`seat: inserted the agent-default-model row (${BASELINE.provider}/${BASELINE.model})`)
}

if (text !== original) writeFileSync(PATCH, text)

// Verify the invariant on the final document, not on the intent. The checks
// accept any indentation, so a nested reference cannot slip past the guard.
const final = readFileSync(PATCH, 'utf8')
const failures = []
const declared = declaredChains(final)

for (const [id, chain] of declared) {
  const gated = chain.links.filter(link => isGatedFree(link.provider, link.model))
  if (chain.links.length > 0 && gated.length === chain.links.length) {
    const state = chain.disabled ? ' and is disabled' : ''
    console.warn(`disable-free-tier: warning: chain "${id}" has only gated free links${state}`)
  }
  if (chain.disabled) continue
  for (const link of gated) failures.push(`enabled chain ${id} links gated free model ${link.model}`)
}

for (const reference of final.matchAll(/^[ \t]*chain:[ \t]*(\S+?)[ \t]*(?:#.*)?$/gm)) {
  const id = reference[1].replace(/^["']|["']$/g, '')
  if (!isResolvableChain(id, declared)) failures.push(`a config still references unusable chain ${id}`)
}

const seat = rowBody(final, 'agent-default-model')
if (seat !== undefined) {
  // The settings writer emits a block config; a hand edit may use a flow map.
  const inline = /\{[^{}]*\}/.exec(seat)
  const inlineField = key => inline === null ? undefined : flowField(inline[0], key)
  const provider = scalarOf(seat, 'provider', 4) ?? inlineField('provider')
  const model = scalarOf(seat, 'model', 4) ?? inlineField('model')
  const chainId = scalarOf(seat, 'chain', 4) ?? inlineField('chain')
  const pair = provider !== undefined && model !== undefined
  if (pair && isGatedFree(provider, model)) failures.push(`agent-default-model names gated free model ${model}`)
  const chained = chainId !== undefined && isResolvableChain(chainId, declared)
  if (chainId !== undefined && !chained) failures.push(`a config still references unusable chain ${chainId}`)
  if (!pair && !chained) failures.push('agent-default-model names no resolvable target (provider+model or chain)')
}

const uniqueFailures = [...new Set(failures)]
if (uniqueFailures.length > 0) {
  console.error('disable-free-tier: invariant NOT restored:')
  for (const failure of uniqueFailures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(changed.length === 0
  ? `disable-free-tier: already clean (${PATCH})`
  : `disable-free-tier: applied ${String(changed.length)} fix(es) to ${PATCH}\n  ${changed.join('\n  ')}`)
