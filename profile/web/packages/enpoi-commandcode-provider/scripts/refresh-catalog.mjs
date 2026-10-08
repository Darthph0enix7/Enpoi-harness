#!/usr/bin/env node
/**
 * Force-refresh the bundled Command Code catalog snapshot from a reachable
 * keypool. The vendor exposes no catalog listing, so the live source is the
 * keypool's `/catalog.json` (legacy `:8899/commandcode` deployment or any
 * loopback proxy serving the pool catalog).
 *
 * The payload is validated whole before anything is written; the previous
 * snapshot is backed up as `catalog.snapshot.json.bak` and the new file is
 * stamped in `catalog.snapshot.meta.json` (version, fetchedAt, entryCount,
 * source). A failure leaves both files untouched.
 *
 * Usage (from the repository root):
 *
 *   node --experimental-strip-types \
 *     profile/web/packages/enpoi-commandcode-provider/scripts/refresh-catalog.mjs \
 *     --base-url http://127.0.0.1:8899/commandcode
 *
 * `COMMANDCODE_CATALOG_URL` supplies the base URL when `--base-url` is absent;
 * `--snapshot <path>` overrides the target file.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshCatalogSnapshot } from '../src/catalog-refresh.ts'

const args = process.argv.slice(2)
const valueOf = (flag) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const baseURL = valueOf('--base-url') ?? process.env.COMMANDCODE_CATALOG_URL
if (baseURL === undefined || baseURL === '') {
  console.error('[commandcode] usage: refresh-catalog.mjs --base-url <keypool-url> [--snapshot <path>]')
  console.error('[commandcode] or set COMMANDCODE_CATALOG_URL')
  process.exit(1)
}
const snapshotPath = valueOf('--snapshot')
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.snapshot.json')

const outcome = await refreshCatalogSnapshot({ baseURL, snapshotPath })
if (!outcome.ok) {
  console.error(`[commandcode] refresh failed, snapshot untouched: ${outcome.error}`)
  process.exit(1)
}
console.log(
  `[commandcode] wrote ${snapshotPath} (v${outcome.stamp.version}, ${outcome.stamp.entryCount} entries,`
  + ` fetched ${outcome.stamp.fetchedAt})${outcome.backupPath === undefined ? '' : `; previous backed up to ${outcome.backupPath}`}`,
)
