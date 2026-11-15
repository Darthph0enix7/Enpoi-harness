/**
 * Vitest-owned shell for the keyless inventory capture.
 *
 * The capture boots `apps/web/tests/scaffold.ts`, which imports Vitest's
 * `expect`; a plain Node/tsx process cannot import it. This file runs inside
 * the isolated child Vitest process (env set by keyless-tool-inventory.e2e.ts)
 * and delegates to the node-only runner after its ownership/readiness gates.
 */
import { expect, it } from 'vitest'
import { runCapture } from './keyless-inventory-runner.mts'

it('captures the shipped preset surfaces in the isolated child', async () => {
  expect(process.env.DSH_KEYLESS_INVENTORY_CAPTURE, 'explicit capture intent missing').toBe('1')
  await runCapture()
}, 300_000)
