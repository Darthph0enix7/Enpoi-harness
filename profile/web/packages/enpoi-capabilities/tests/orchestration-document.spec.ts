/**
 * The `enpoi-orchestration` document fields owners edit through Settings.
 *
 * `customTools` is the T2 contract: the settings service projects the entry's
 * volatile Config fields into the editable form, and Dynamic → Skills & tools
 * writes add/remove edits back through `settings.mutate`, so an owner never
 * edits the profile patch by hand. A field that loses its `Volatile` wrapper
 * silently disappears from that surface and only a profile edit could change
 * it again; this spec pins both shipped editable fields.
 */
import { isVolatile } from '@deepseek-ai/cosmokit'
import { expect, it } from 'vitest'
import { OrchestrationSettingsSchema } from '../src/index'

it('projects customTools as a live field carrying the stored records', () => {
  const record = {
    id: 'research-verify',
    name: 'Research verify',
    description: 'verify claims',
    params: [{ name: 'run-dir', type: 'string', required: true, description: 'run directory' }],
    command: 'node verify.mjs --run-dir {{run-dir}}',
  }
  const config = OrchestrationSettingsSchema({ customTools: [record] })
  expect(isVolatile(config.customTools)).toBe(true)
  expect(config.customTools.get()).toEqual([record])
})

it('projects extendBuiltins as a live field for the delegation tool', () => {
  const edits = { roles: { librarian: { remove: ['web_fetch'] } }, sharedDeny: { add: ['custom_probe'] } }
  const config = OrchestrationSettingsSchema({ extendBuiltins: edits })
  expect(isVolatile(config.extendBuiltins)).toBe(true)
  expect(config.extendBuiltins.get()).toEqual(edits)
})
