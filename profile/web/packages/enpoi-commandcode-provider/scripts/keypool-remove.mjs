#!/usr/bin/env node
/**
 * Drop ONLY the commandcode pool from the shared keypool's pools.json.
 *
 * Removal helper: the keypool service, its systemd unit, usage.jsonl, and
 * every other pool (the `go` pool included) are untouched. The proxy rereads
 * pools.json per request, so no service restart is needed after this.
 *
 * Usage: node scripts/keypool-remove.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.HOME ?? ''
const configDir = process.env.KEYPOOL_CONFIG_DIR ?? join(home, '.config', 'opencode', 'keypool')
const poolsPath = join(configDir, 'pools.json')

if (!existsSync(poolsPath)) {
  console.log('[commandcode] no pools.json — nothing to remove')
  process.exit(0)
}
let document
try {
  document = JSON.parse(readFileSync(poolsPath, 'utf8'))
} catch (error) {
  console.error(`[commandcode] ${poolsPath} is not valid JSON (${error.message})`)
  process.exit(1)
}
if (document.pools?.commandcode === undefined) {
  console.log('[commandcode] pools.json has no commandcode pool — left untouched')
  process.exit(0)
}
delete document.pools.commandcode
writeFileSync(poolsPath, `${JSON.stringify(document, null, 2)}\n`)
console.log('[commandcode] removed only pools.commandcode; the keypool service and every other pool are untouched')
