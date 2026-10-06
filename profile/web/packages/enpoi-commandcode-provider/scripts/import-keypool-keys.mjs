#!/usr/bin/env node
/**
 * Map the old keypool proxy's commandcode keys onto the native pool's
 * settings identities.
 *
 * Reads `<config>/opencode/keypool/pools.json` (or `--pools <path>`), takes
 * `pools.<name>.keys` (default pool `commandcode`), and prints:
 *
 *   1. the `pool` block to place under `providers.commandcode` in the
 *      `commandcode-provider` settings section, with
 *      `credentialRef = COMMANDCODE_KEY_<n>` (old key ids and priorities are
 *      preserved), and
 *   2. how to store each key — Settings → Models → Keys card, or the
 *      environment alternative that reads the old file in place.
 *
 * The script writes nothing and never prints key material: only ids,
 * priorities, credential references, and paths appear in its output.
 *
 * Usage:
 *   node scripts/import-keypool-keys.mjs [--pools PATH] [--pool NAME]
 *
 * Environment:
 *   KEYPOOL_CONFIG_DIR  keypool config directory (default ~/.config/opencode/keypool)
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const USAGE = `Usage: node scripts/import-keypool-keys.mjs [--pools PATH] [--pool NAME]

  --pools PATH   keypool pools.json (default $KEYPOOL_CONFIG_DIR or ~/.config/opencode/keypool/pools.json)
  --pool NAME    pool to migrate (default commandcode)
  -h, --help     this text`

const args = { pool: 'commandcode', pools: undefined }
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index]
  const value = process.argv[index + 1]
  if (arg === '--pools' && value !== undefined) args.pools = process.argv[++index]
  else if (arg === '--pool' && value !== undefined) args.pool = process.argv[++index]
  else if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else {
    console.error(`unknown argument: ${arg}\n\n${USAGE}`)
    process.exit(2)
  }
}

/** One shell argument, single-quoted so the emitted line cannot expand it. */
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const home = process.env.HOME ?? ''
// Absolute: the emitted env lines require() this path, and a bare relative
// name would fail Node's CJS resolution from another working directory.
const poolsPath = resolve(args.pools
  ?? join(process.env.KEYPOOL_CONFIG_DIR ?? join(home, '.config', 'opencode', 'keypool'), 'pools.json'))

if (existsSync(poolsPath) === false) {
  console.log(`[commandcode] no pools.json at ${poolsPath} — nothing to migrate.`)
  console.log('[commandcode] Add keys on the Settings → Models → Keys card instead.')
  process.exit(0)
}

let document
try {
  document = JSON.parse(readFileSync(poolsPath, 'utf8'))
} catch (error) {
  console.error(`[commandcode] ${poolsPath} is not valid JSON (${error.message}) — fix it first`)
  process.exit(1)
}

const pool = document?.pools?.[args.pool]
if (pool === undefined) {
  console.log(`[commandcode] ${poolsPath} has no pools.${args.pool} — nothing to migrate.`)
  process.exit(0)
}

const keys = Array.isArray(pool.keys) ? pool.keys : []
if (keys.length === 0) {
  console.log(`[commandcode] pools.${args.pool} has no keys — nothing to migrate.`)
  console.log('[commandcode] Add keys on the Settings → Models → Keys card instead.')
  process.exit(0)
}

/** The identity rows derived from the old entries; `key` never leaves this scope. */
const rows = keys.map((entry, index) => {
  const id = typeof entry?.id === 'string' && entry.id !== '' ? entry.id : `key-${String(index + 1)}`
  const priority = Number.isSafeInteger(entry?.priority) ? entry.priority : index + 1
  return { id, credentialRef: `COMMANDCODE_KEY_${String(index + 1)}`, priority, index }
})

const refLine = (row) => `        - id: ${row.id}\n          credentialRef: ${row.credentialRef}\n          priority: ${String(row.priority)}`

console.log('# Command Code key-pool migration')
console.log(`#   old pool: ${poolsPath} → pools.${args.pool} (${String(rows.length)} key${rows.length === 1 ? '' : 's'})`)
console.log('#   This script wrote nothing and printed no key material.')
console.log('')
console.log('# 1. Replace the route\'s `pool:` block in the commandcode-provider settings')
console.log('#    section (Settings → Models → the Command Code route → settings YAML,')
console.log('#    path providers.commandcode). Keep baseURL, apiKeyEnv, models, and every')
console.log('#    other key; add `pool:` when the route has none yet.')
console.log('')
console.log('    pool:')
console.log('      strategy: priority-sticky')
console.log('      identities:')
for (const row of rows) console.log(refLine(row))
console.log('')
console.log('# 2. Store each key on the Settings → Models → Keys card:')
for (const row of rows) {
  console.log(`#      identity ${row.id}  →  credential ${row.credentialRef}`)
}
console.log('#')
console.log('#    Env alternative (run before the harness starts; each line reads the old')
console.log('#    file and prints no secret):')
for (const row of rows) {
  console.log(`export ${row.credentialRef}="$(node -p '(require(process.argv[1]).pools.${args.pool}.keys[${String(row.index)}].key??"")' ${shellQuote(poolsPath)})"`)
}
console.log('')
console.log(`# 3. Verify: the Command Code route's Key Pool card lists ${String(rows.length)} identities;`)
console.log('#    a request rotates among them on quota/auth failures. The :8899 proxy is no')
console.log('#    longer part of this route and can be retired once no other tool uses it.')
