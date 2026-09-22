/**
 * The plugin's wiring, and its removal when the plugin goes.
 *
 * The registry and the navigation controller are real, because "provided"
 * means what those faces do; the slot, locale, frame, and resource faces are
 * recorders, because what matters here is what was handed to them — two seats
 * over one store, the guide's body under its own id, the frame reports, the
 * service binding — and that every registration is gone after dispose, which
 * is what makes a reload safe. The seats' components have their own specs.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import type { GuideInjected, SidebarRightInjected } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { SidebarRightController } from '../src/client/service.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'
import { RightbarSeat } from '../src/client/shell/SidebarRight.tsx'
import { RightbarRoot } from '../src/client/shell/RightbarRoot.tsx'
import { MobileSurfaces } from '../src/client/shell/MobileSurfaces.tsx'
import { GuideBody } from '../src/client/tabs/guide/GuideBody.tsx'
import { GuideTitle } from '../src/client/tabs/guide/GuideTitle.tsx'
import { GUIDE_ID } from '../src/client/tabs/guide/definition.ts'
import { en, zh } from '../src/client/locales.ts'

const SESSION = 's-test' as SessionId

interface Recorded {
  name: string
  key?: string
  id?: string
  locale?: string
  store?: unknown
  children?: unknown
  inject?: (sessionId: SessionId) => unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: Parameters<SlotRegistry['inject']>[1]) => ctx.effect(register)),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const layout = { openRightbar: vi.fn(), closeRightbar: vi.fn() }
  const resources = { pin: vi.fn<(address: string, signal: AbortSignal) => void>() }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', layout as never)
  ctx.provide('resources', resources as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const seat = (name: string): Recorded => {
    const entry = registered.find(candidate => candidate.name === name)
    if (entry === undefined) throw new Error(`expected a registration into ${name}`)
    return entry
  }
  const injectedOf = (entry: Recorded): unknown => {
    if (entry.inject === undefined) throw new Error(`expected ${entry.name} to inject`)
    return entry.inject(SESSION)
  }
  return { ctx, registered, dictionaries, layout, resources, fiber, seat, injectedOf }
}

describe('ui-sidebar-right apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('provides both faces, and registers the guide through the same two-stage path as any other type', async () => {
    const { ctx, registered, dictionaries, seat } = await boot()
    expect(ctx.sidebarRightTabs).toBeInstanceOf(SidebarRightTabRegistry)
    expect(ctx.sidebarRight).toBeInstanceOf(SidebarRightController)
    expect('adopt' in ctx.sidebarRight).toBe(false)
    expect(dictionaries.get('sidebarRight')).toEqual({ zh, en })
    const guide = ctx.sidebarRightTabs.get('guide')
    expect(guide?.id).toBe(GUIDE_ID)
    expect(guide?.priority).toBe('builtin')
    expect(guide?.title('sidebar://guide')).toBe('tab.guide.title')
    // Six registrations: the root and panel seats, the guide body and chip
    // title under the guide implementation's id, and the mobile shell's two
    // surface entry lists. The guide draws no product copy of its own, so
    // neither guide seat binds the dictionary.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['rightbar', undefined, undefined, RightbarRoot],
      ['rightbar.session', undefined, 'sidebarRight', RightbarSeat],
      ['sidebar.right.pane.tab', GUIDE_ID, undefined, GuideBody],
      ['sidebar.right.pane.tab.title', GUIDE_ID, undefined, GuideTitle],
      ['shell.mobile.bar', undefined, 'sidebarRight', MobileSurfaces],
      ['shell.mobile.more', undefined, 'sidebarRight', MobileSurfaces],
    ])
    // One entry per seat, named by the list registration's id.
    expect(registered.filter(entry => entry.name.startsWith('shell.mobile')).map(entry => entry.id)).toEqual(['surfaces', 'surfaces'])
    // The panel declares the extension seats; the guide declares its chain child.
    expect(Object.keys(seat('rightbar.session').children as object)).toEqual([
      'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'sidebar.right.tab.menu.item',
    ])
    expect(seat('sidebar.right.pane.tab').children).toMatchObject({ 'sidebar.right.tab.guide': { kind: 'chain', scope: 'session' } })
    expect(seat('rightbar.session').store).toBeDefined()
  })

  it('hands the panel seat the frame report, the service binding, the opens, the observable registry, and the Tab domain', async () => {
    const { ctx, layout, resources, seat, injectedOf } = await boot()
    const injected = injectedOf(seat('rightbar.session')) as SidebarRightInjected
    // The frame learns the composition of expanded and presentation, nothing else.
    injected.syncPresentation({ shown: true, track: true, fullscreen: false })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(true, false)
    injected.syncPresentation({ shown: true, track: true, fullscreen: true })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(true, true)
    injected.syncPresentation({ shown: true, track: false, fullscreen: true })
    expect(layout.openRightbar).toHaveBeenLastCalledWith(false, true)
    injected.syncPresentation({ shown: false, track: false, fullscreen: false })
    expect(layout.closeRightbar).toHaveBeenCalledOnce()
    // The registry, observable: what the seat dispatches a kind to.
    expect(injected.hooks.tabTypes.getSnapshot().find(type => type.kind === 'guide')?.id).toBe(GUIDE_ID)
    const seen = vi.fn()
    const unsubscribe = injected.hooks.tabTypes.subscribe(seen)
    ctx.sidebarRightTabs.register({ id: 'spec/text', kind: 'text', patterns: ['dsh-resource://file/**'], title: () => 'text' })
    expect(seen).toHaveBeenCalledOnce()
    unsubscribe()
    // The binding makes the service act on this seat's session; the seat's
    // store instance is minted here from the handle the registration declared.
    const handle = seat('rightbar.session').store as ReturnType<typeof createSidebarRightStore>
    const instance = handle.create()
    instance.clearPersisted()
    const release = injected.bindService({ sessionId: SESSION, actions: instance.actions, surfaces: {}, canSplitPane: () => true })
    injected.openTab('guide', { revealIfOpened: false })
    const surface = instance.getSnapshot().bySession[SESSION]
    expect(surface?.layout.expanded).toBe(true)
    expect(Object.values(surface?.layout.tabs ?? {}).map(tab => tab.kind)).toEqual(['guide'])
    // Holding a record pins its address through the resource model.
    if (surface === undefined) throw new Error('expected a surface')
    ctx.sidebarRight.tabDomain.sync(SESSION, surface.layout)
    expect(resources.pin).toHaveBeenCalledWith('sidebar://guide', expect.any(AbortSignal))
    release()
    expect(() => { ctx.sidebarRight.toggleExpanded() }).toThrow('no session surface is mounted')
  })

  it('restores a session\'s stored column and pins it when its store is minted', async () => {
    const entries = new Map<string, string>()
    const storage: Storage = {
      get length() { return entries.size },
      clear: () => { entries.clear() },
      getItem: key => entries.get(key) ?? null,
      key: index => [...entries.keys()][index] ?? null,
      removeItem: (key) => { entries.delete(key) },
      setItem: (key, value) => { entries.set(key, value) },
    }
    entries.set('dsh.sidebar-right.surfaces.v1', JSON.stringify({
      version: 1,
      sessions: {
        [SESSION]: {
          layout: {
            nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab1'], activeTabId: 'tab1' } },
            tabs: { tab1: { id: 'tab1', kind: 'guide', contentId: 'sidebar://guide', title: 'Start' } },
            rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
          },
          minted: 1,
        },
      },
    }))
    vi.stubGlobal('localStorage', storage)
    try {
      const { ctx, resources, seat } = await boot()
      const handle = seat('rightbar.session').store as ReturnType<typeof createSidebarRightStore>
      const instance = handle.create(SESSION)
      const surface = instance.getSnapshot().bySession[SESSION]
      expect(surface?.layout.expanded).toBe(true)
      expect(Object.values(surface?.layout.tabs ?? {}).map(tab => tab.kind)).toEqual(['guide'])
      // Adoption reconciles the restored column immediately, without a seat and without a commit.
      expect(resources.pin).toHaveBeenCalledWith('sidebar://guide', expect.any(AbortSignal))
      expect(ctx.sidebarRight.tabDomain.occurrence(SESSION, { id: 'tab1' as TabId })).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('adopts each session\'s store instance as the runtime mints it, so a tab\'s own actions land with no seat bound', async () => {
    const { ctx, resources, seat } = await boot()
    const handle = seat('rightbar.session').store as ReturnType<typeof createSidebarRightStore>
    const instance = handle.create(SESSION)
    instance.actions.open(SESSION)
    // The first expansion seeds the guide; a second tab beside it makes it closable.
    instance.actions.setExpanded(SESSION, true)
    instance.actions.openContent(SESSION, { kind: 'text', contentId: 'dsh-resource://file/session/s/a.txt', title: 'a' }, () => {})
    const guide = Object.values(instance.getSnapshot().bySession[SESSION]?.layout.tabs ?? {}).find(tab => tab.kind === 'guide')
    if (guide === undefined) throw new Error('expected the seeded guide')
    // Held and pinned from the store's own commit: no seat synced anything.
    const occurrence = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)
    expect(resources.pin).toHaveBeenCalledWith('sidebar://guide', occurrence.signal)
    occurrence.tabActions.close()
    expect(instance.getSnapshot().bySession[SESSION]?.layout.tabs[guide.id]).toBeUndefined()
    expect(occurrence.signal.aborted).toBe(true)
    expect(ctx.sidebarRight.openTabs.getSnapshot().length).toBeGreaterThan(0)
    instance.clearPersisted()
    expect(ctx.sidebarRight.openTabs.getSnapshot()).toEqual([])
  })

  it('hands the guide body the registry\'s entry boxes, observable', async () => {
    const { ctx, seat, injectedOf } = await boot()
    const { hooks: { guideEntries } } = injectedOf(seat('sidebar.right.pane.tab')) as GuideInjected
    expect(guideEntries.getSnapshot()).toEqual([])
    const seen = vi.fn()
    guideEntries.subscribe(seen)
    ctx.sidebarRightTabs.register({
      id: 'spec/files',
      kind: 'files',
      title: () => 'Files',
      guide: [{ id: 'default', order: 10, title: () => 'Files' }],
    })
    expect(seen).toHaveBeenCalledOnce()
    expect(guideEntries.getSnapshot().map(entry => entry.kind)).toEqual(['files'])
  })

  it('takes every registration and both faces back when disposed, aborting the open records, so a reload registers again', async () => {
    const { ctx, registered, dictionaries, fiber, seat, injectedOf } = await boot()
    const injected = injectedOf(seat('rightbar.session')) as SidebarRightInjected
    const handle = seat('rightbar.session').store as ReturnType<typeof createSidebarRightStore>
    // Minted under the session key, so the instance is adopted and the teardown releases it.
    const instance = handle.create(SESSION)
    injected.bindService({ sessionId: SESSION, actions: instance.actions, surfaces: {}, canSplitPane: () => true })
    injected.openTab('guide')
    const surface = instance.getSnapshot().bySession[SESSION]
    const guide = Object.values(surface?.layout.tabs ?? {})[0]
    if (guide === undefined) throw new Error('expected the guide tab')
    const { signal, tabActions } = ctx.sidebarRight.tabDomain.occurrence(SESSION, guide)
    await fiber.dispose()
    expect(signal.aborted).toBe(true)
    // The adoption went with the plugin: a late action from the dead occurrence changes nothing.
    tabActions.close()
    expect(instance.getSnapshot().bySession[SESSION]?.layout.tabs[guide.id]).toBeDefined()
    expect(ctx.get('sidebarRight')).toBeUndefined()
    expect(ctx.get('sidebarRightTabs')).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(ctx.sidebarRightTabs.get('guide')?.id).toBe(GUIDE_ID)
    expect(registered).toHaveLength(6)
  })
})
