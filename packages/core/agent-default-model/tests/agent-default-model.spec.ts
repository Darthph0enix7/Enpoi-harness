/** Default model references remain live without a settings service. */
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('resolves the keyless Kilo baseline when no provider or model is selected', async () => {
  const blank = new Context()
  onTestFinished(() => blank.fiber.dispose())
  await blank.plugin(DefaultModel, { provider: '', model: '' })
  expect(blank.agentDefaultModel.currentSelection()).toEqual({ provider: 'kilo', model: 'kilo-auto/free' })

  // A blank field resolves alone: a configured provider keeps its model baseline.
  const half = new Context()
  onTestFinished(() => half.fiber.dispose())
  await half.plugin(DefaultModel, { provider: 'acme', model: '' })
  expect(half.agentDefaultModel.currentSelection()).toEqual({ provider: 'acme', model: 'kilo-auto/free' })
})

it('leaves blank fields blank when the deployment disables the baseline', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: '', model: '', baseline: 'off' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: '', model: '' })
  // The policy is a live field: re-enabling it restores the Kilo fallback on
  // the running fiber, and each blank field resolves alone.
  await live.update({ baseline: 'kilo' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'kilo', model: 'kilo-auto/free' })
  await live.update({ provider: 'acme', model: '', baseline: 'off' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'acme', model: '' })
})

it('warns once when the selected provider is not registered, without changing it', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('llm', { listProviders: () => [{ id: 'other', name: 'Other' }] })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  await ctx.plugin(DefaultModel, { provider: 'ghost', model: 'm' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(1)
  // Settings are read live: a repeated read does not warn again.
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(1)
  warn.mockRestore()
})

it('warns again when a re-registered route disappears a second time', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let providers = [{ id: 'ghost', name: 'Ghost' }]
  ctx.provide('llm', { listProviders: () => providers })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  await ctx.plugin(DefaultModel, { provider: 'ghost', model: 'm' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).not.toHaveBeenCalled()
  providers = []
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(1)
  // The route resolves again: the one-shot record clears,
  providers = [{ id: 'ghost', name: 'Ghost' }]
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(1)
  // so the second disappearance is a new incident that warns again.
  providers = []
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'ghost', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})

it('stays silent while the selected provider is registered', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('llm', { listProviders: () => [{ id: 'acme', name: 'Acme' }] })
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  await ctx.plugin(DefaultModel, { provider: 'acme', model: 'm' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'acme', model: 'm' })
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('keeps the profile baseline policy across a saved selection', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, profile } = await configurationFixture({ hmr: false })
  await ctx.settings.update('default-model', { provider: 'test', model: 'original', baseline: 'kilo' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'next', model: 'm' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'next', model: 'm' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('baseline: kilo')
  await ctx.settings.update('default-model', { provider: 'next', model: 'm', baseline: 'off' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'final', model: 'f' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'final', model: 'f' })
  // The complete-selection write replaces the model fields but must not erase
  // the deployment's baseline opt-out.
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('baseline: off')
})

it('records a legal baseline for a legacy entry that has none', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, profile } = await configurationFixture({ hmr: false })
  // The fixture's row predates `baseline`; the save must still write one.
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('baseline: kilo')
})

it('treats a missing current config as a legacy row when deriving the baseline', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const editor = ctx.configEditor
  let candidate: Record<string, unknown> | undefined
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async (_entry, change) => {
    candidate = change(undefined as unknown as Record<string, unknown>, {})
  })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next' })
  intercepted.mockRestore()
  expect(candidate).toEqual({ provider: 'test', model: 'next', baseline: 'kilo' })
})

it('falls back to the baseline pair when the picked route is gone before the write lands', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  let providers = [{ id: 'ghost', name: 'Ghost' }, { id: 'kilo', name: 'Kilo' }]
  ctx.provide('llm', { listProviders: () => providers })
  // Queue the save, then drop the route before the serialized edit runs.
  const pending = ctx.agentDefaultModel.saveSelection({ provider: 'ghost', model: 'm' })
  providers = [{ id: 'kilo', name: 'Kilo' }]
  await pending
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'kilo', model: 'kilo-auto/free' })
})

it('drops a selection that echoes a group the runtime cannot route', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx, profile } = await configurationFixture({ hmr: false })
  ctx.provide('modelChains', {
    resolve: (id: string) => id === 'stable' ? { id, links: [{ provider: 'p', model: 'm' }] } : undefined,
  })
  // The UI pick carries the current selection's group; `free` is retired, so
  // the pick must persist the route without resurrecting the reference.
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', chain: 'free' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next' })
  expect(readFileSync(profile.patchPath, 'utf8')).not.toContain('chain: free')
  // An enabled group still persists through the same path.
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', chain: 'stable' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', chain: 'stable' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('chain: stable')
})

it('serializes overlapping saves and continues after a rejected write', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const calls: string[] = []
  const intercepted = vi.spyOn(editor, 'edit').mockImplementationOnce(async () => {
    calls.push('rejected')
    entered.resolve(undefined)
    await release.promise
    throw new Error('read-only document')
  }).mockImplementation(async (entry, change) => {
    calls.push('saved')
    await edit(entry, change)
  })
  const first = ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'rejected' })
  const failed = expect(first).rejects.toThrow('read-only document')
  const lastSelection = { provider: 'test', model: 'final' }
  const last = ctx.agentDefaultModel.saveSelection(lastSelection)
  onTestFinished(async () => {
    release.resolve(undefined)
    await Promise.allSettled([failed, last])
    intercepted.mockRestore()
  })
  lastSelection.model = 'mutated'
  await entered.promise
  expect(calls).toEqual(['rejected'])
  release.resolve(undefined)
  await failed
  await last
  expect(calls).toEqual(['rejected', 'saved'])
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
})
