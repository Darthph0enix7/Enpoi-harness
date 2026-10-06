/**
 * Client-mirror parity, client half: the pre-connection fallback table
 * (`src/client/heavy-providers.ts`) must carry exactly the host manifest
 * facts. Importing the host package from this suite is not possible — it
 * lives in the separate `profile/web` workspace — so the host projection is
 * committed beside this spec
 * (`tests/expected/heavy-provider-mirror.json`) and the host package's
 * `tests/client-mirror.spec.ts` pins it to `HEAVY_MANIFESTS`. Together the
 * two specs fail on drift from either side; no hand check is needed.
 *
 * Regenerate after a host manifest change (from the repository root):
 *
 *   node --experimental-strip-types profile/web/packages/enpoi-heavy-providers/scripts/write-client-mirror.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS } from '../src/client/heavy-providers.ts'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'expected', 'heavy-provider-mirror.json')

it('the fallback table matches the committed host-manifest projection', () => {
  const host: unknown = JSON.parse(readFileSync(fixture, 'utf8'))
  expect(FALLBACK_HEAVY_PROVIDER_MANIFESTS).toEqual(host)
})
