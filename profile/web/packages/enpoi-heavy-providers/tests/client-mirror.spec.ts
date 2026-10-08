/**
 * Client-mirror parity, host half: the pre-connection fallback table in
 * `packages/client/ui-settings-models/src/client/heavy-providers.ts` mirrors
 * the host manifest facts. The committed fixture
 * (`packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json`)
 * is the projection both halves assert against; this spec pins it to
 * `HEAVY_MANIFESTS`, and the client spec
 * (`heavy-provider-parity.client.spec.ts`) pins the fallback table to the
 * same file. Drift on either side fails a suite.
 *
 * Regenerate after a host manifest change (from the repository root):
 *
 *   node --experimental-strip-types profile/web/packages/enpoi-heavy-providers/scripts/write-client-mirror.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS } from '../src/manifests.js'
import { HEAVY_OVERLAY_GLOBAL } from '../src/planner.js'

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json',
)

/** The one host-only field the client's pre-connection table never carries. */
const stripHostOnly = (key: string, value: unknown): unknown => key === 'requiresFiles' ? undefined : value

it('the committed client mirror fixture equals the host manifest projection', () => {
  const committed: unknown = JSON.parse(readFileSync(fixture, 'utf8'))
  const projection: unknown = JSON.parse(JSON.stringify(HEAVY_MANIFESTS, stripHostOnly))
  expect(committed).toEqual(projection)
})

it('the page-global overlay key matches the client package constant', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/client/ui-settings-models/src/heavy-overlay.ts'),
    'utf8',
  )
  expect(source).toContain(`export const HEAVY_OVERLAY_GLOBAL = '${HEAVY_OVERLAY_GLOBAL}'`)
})
