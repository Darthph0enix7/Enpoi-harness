/** A no-op write settles without persisting, bumping a revision, reloading, or emitting. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

it('short-circuits a no-op write without a revision bump or event', async () => {
  const { ctx, profile } = await configurationFixture()
  const events: Array<[unknown, unknown]> = []
  ctx.on('settings/document-updated', (ns, revision) => { events.push([ns, revision]) })
  const reloads: unknown[] = []
  ctx.on('app-boot/config-reload', () => { reloads.push(1) })
  // Warm the generation so the measurement excludes the first projection, and
  // flush pending invalidations so their events are not attributed to the write.
  ctx.settings.describe()
  await new Promise(resolve => setTimeout(resolve, 0))
  events.length = 0
  reloads.length = 0
  const before = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  const patch = readFileSync(profile.patchPath, 'utf8')
  await ctx.settings.mutate('first', [])
  const after = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  expect(after).toBe(before)
  expect(events).toEqual([])
  // The candidate equals the live config, so the short-circuit skips both
  // profile reconciles; the reconcile path raised two reloads per no-op.
  expect(reloads).toEqual([])
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
})
