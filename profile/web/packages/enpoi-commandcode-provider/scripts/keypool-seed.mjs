#!/usr/bin/env node
/**
 * Seed the shared keypool's pools.json with the commandcode pool.
 *
 * Local-install helper: creates ~/.config/opencode/keypool/pools.json when
 * missing and adds only a `commandcode` pool skeleton (empty keys — the API
 * keys are operator secrets and are never generated here). The catalogPaths
 * point at this package's bundled snapshot, which the keypool serves as
 * `/commandcode/catalog.json`. The `go` pool and the keypool service are never
 * touched; an operator adds keys in the dashboard-free pools.json.
 *
 * Usage: node scripts/keypool-seed.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.HOME ?? ''
const configDir = process.env.KEYPOOL_CONFIG_DIR ?? join(home, '.config', 'opencode', 'keypool')
const poolsPath = join(configDir, 'pools.json')
const packageRoot = dirname(fileURLToPath(import.meta.url)) === '' ? '' : join(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotPath = join(packageRoot, 'catalog.snapshot.json')

let document = { pools: {} }
if (existsSync(poolsPath)) {
  try {
    document = JSON.parse(readFileSync(poolsPath, 'utf8'))
  } catch (error) {
    console.error(`[commandcode] ${poolsPath} is not valid JSON — fix it first (${error.message})`)
    process.exit(1)
  }
}
document.pools ??= {}
if (!document.pools.commandcode) {
  document.pools.commandcode = {
    upstream: 'https://api.commandcode.ai',
    strategy: 'priority',
    cooldownMs: 3_600_000,
    quotaCooldownMs: 21_600_000,
    catalogPaths: [snapshotPath],
    keys: [],
  }
  mkdirSync(configDir, { recursive: true })
  writeFileSync(poolsPath, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`[commandcode] wrote ${poolsPath} with an empty commandcode pool — add keys to pools.commandcode.keys, then reload nothing (the keypool reads pools.json per request)`)
} else {
  console.log('[commandcode] pools.json already declares the commandcode pool — left untouched')
}
