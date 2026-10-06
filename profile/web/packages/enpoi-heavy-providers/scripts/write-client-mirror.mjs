/**
 * Regenerate the committed client-mirror fixture from the host manifest table.
 *
 * The pre-connection fallback table in
 * `packages/client/ui-settings-models/src/client/heavy-providers.ts` mirrors
 * the host manifests. Two specs keep the mirror honest:
 *
 * - `tests/client-mirror.spec.ts` (host) asserts the committed fixture equals
 *   the projection of `HEAVY_MANIFESTS` below.
 * - `packages/client/ui-settings-models/tests/heavy-provider-parity.client.spec.ts`
 *   (client) asserts the fallback table equals the same fixture.
 *
 * Run from the repository root after any host manifest change:
 *
 *   node --experimental-strip-types profile/web/packages/enpoi-heavy-providers/scripts/write-client-mirror.mjs
 *
 * `--check` writes nothing and exits non-zero on drift (usable as a gate).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEAVY_MANIFESTS } from '../src/manifests.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '../../../../../packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json')

// `requiresFiles` is the one host-only field: the client's pre-connection
// table never checks the filesystem. Everything else — ids, labels, delivery,
// base URLs, health probes, auth/pool identities, platform variants, install
// and removal steps, quirks — is shared and must match.
const stripHostOnly = (key, value) => (key === 'requiresFiles' ? undefined : value)
const projection = JSON.parse(JSON.stringify(HEAVY_MANIFESTS, stripHostOnly))
const next = `${JSON.stringify(projection, null, 2)}\n`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(fixture, 'utf8')
  } catch {
    current = ''
  }
  if (current !== next) {
    console.error(`client mirror fixture is stale: ${fixture}`)
    process.exit(1)
  }
  console.log('client mirror fixture is current')
} else {
  writeFileSync(fixture, next, 'utf8')
  console.log(`wrote ${fixture}`)
}
