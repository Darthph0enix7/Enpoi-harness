/**
 * ui-update plugin halves: the browser entry's dictionary and shell-overlay
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the inject face's action wiring, and the inert node
 * entry.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UpdateIndicatorInjected } from '../src/client/UpdateIndicator.tsx'
import type { UpdateSettingsInjected } from '../src/client/UpdateSettingsRow.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as applyNode } from '../src/index.ts'

/** Boot the browser half over a real slot tree that declares the shell overlay. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('en')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  onTestFinished(async () => { await fiber.dispose(); await ctx.fiber.dispose() })
  return { ctx, fiber }
}

describe('ui-update browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one shell-overlay entry whose inject face carries the state and actions', async () => {
    const { ctx } = await bench()
    const entry = ctx.slots.entries('shell.overlay').find(candidate => candidate.options.id === 'update-indicator')
    expect(entry).toBeDefined()
    expect(entry?.locale).toBe(NS)
    const face = (entry?.inject as unknown as (() => UpdateIndicatorInjected) | undefined)?.()
    expect(face?.hooks.update.getSnapshot()).toMatchObject({ status: null, run: null, dialogOpen: false })
    expect(Object.keys(face?.actions ?? {}).sort()).toEqual(['apply', 'close', 'open', 'retry', 'skip', 'start', 'toastDone'])
    face?.actions.open()
    expect(face?.hooks.update.getSnapshot().dialogOpen).toBe(true)
    face?.actions.close()
    expect(face?.hooks.update.getSnapshot().dialogOpen).toBe(false)
  })

  it('registers the General-settings row under the version row with the shared controller face', async () => {
    const { ctx } = await bench()
    const entry = ctx.slots.entries('settings.general.item').find(candidate => candidate.options.id === 'update')
    expect(entry).toBeDefined()
    expect(entry?.options.order).toBe(101)
    expect(entry?.locale).toBe(NS)
    const face = (entry?.inject as unknown as (() => UpdateSettingsInjected) | undefined)?.()
    expect(face?.hooks.update.getSnapshot()).toMatchObject({ status: null, run: null })
    // The row's open shares the pill's controller store, not a second source.
    const pill = ctx.slots.entries('shell.overlay').find(candidate => candidate.options.id === 'update-indicator')
    const pillFace = (pill?.inject as unknown as (() => UpdateIndicatorInjected) | undefined)?.()
    expect(face?.hooks.update).toBe(pillFace?.hooks.update)
    face?.actions.open()
    expect(face?.hooks.update.getSnapshot().dialogOpen).toBe(true)
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('dialog.title')).toBe(en['dialog.title'])
    ctx.locale.setLocale('zh')
    expect(translate('dialog.title')).toBe(zh['dialog.title'])

    await fiber.dispose()
    expect(translate('dialog.title')).not.toBe(zh['dialog.title'])
  })

  it('drops the overlay entry when the plugin fiber unloads (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).toContain('update-indicator')
    expect(ctx.slots.entries('settings.general.item').map(entry => entry.options.id)).toContain('update')
    await fiber.dispose()
    expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).not.toContain('update-indicator')
    expect(ctx.slots.entries('settings.general.item').map(entry => entry.options.id)).not.toContain('update')
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-update node half', () => {
  it('contributes no host behavior', () => {
    expect(applyNode).not.toThrow()
  })
})
