/**
 * Per-session surface persistence: what a reload restores and what it refuses.
 *
 * The storage is a plain map-backed `Storage`, so every case runs without a
 * browser; the write debounce is driven by fake timers, and a "reload" is a
 * second store over the same storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneNode, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabNavigation } from '../src/client/contract/slots.ts'
import { createSidebarRightController } from '../src/client/service.ts'
import { SidebarRightRail } from '../src/client/rail.ts'
import { SidebarRightTabRegistry } from '../src/client/tab-registry.ts'
import { bindSurfacePersistence, createSidebarRightStore } from '../src/client/stores.ts'
import {
  SURFACES_STORAGE_KEY, SURFACE_SESSION_LIMIT, SURFACE_TAB_LIMIT, SurfaceStorage,
} from '../src/client/surface-storage.ts'
import { guideDefinition } from '../src/client/tabs/guide/definition.ts'

/** Map-backed `Storage`; specs read the same key the browser would. */
function fakeStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() { return entries.size },
    clear: () => { entries.clear() },
    getItem: key => entries.get(key) ?? null,
    key: index => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key) },
    setItem: (key, value) => { entries.set(key, value) },
  }
}

/** The tab kinds these specs still register; anything else is a kind without a definition. */
const isKnownKind = (kind: string) => kind === 'guide' || kind === 'text'

/** The raw payload as storage holds it. */
function storedPayload(storage: Storage): { version: number; sessions: Record<string, unknown> } {
  const raw = storage.getItem(SURFACES_STORAGE_KEY)
  if (raw === null) throw new Error('expected a stored payload')
  return JSON.parse(raw)
}

/** Bind one session's instance exactly as the plugin binds each minted instance. */
function bind(
  handle: ReturnType<typeof createSidebarRightStore>,
  storage: Storage,
  sessionId: string,
  navigation?: (sessionId: string) => Readonly<Record<string, SidebarRightTabNavigation>>,
) {
  const instance = handle.create()
  const persistence = new SurfaceStorage(isKnownKind, storage)
  const stop = bindSurfacePersistence(instance, sessionId, persistence, navigation)
  return { instance, persistence, stop }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('SurfaceStorage — the stored column', () => {
  it('round-trips a session\'s layout, editor record, and id counter through a later boot', () => {
    const storage = fakeStorage()
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const first = bind(handle, storage, 's-a')
    first.instance.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/notes.md', title: 'notes.md', editor: true,
    }, () => {})
    vi.advanceTimersByTime(500)
    const committed = first.instance.getSnapshot().bySession['s-a']!
    expect(committed.editorTabId).toBeDefined()

    const second = bind(handle, storage, 's-a')
    const restored = second.instance.getSnapshot().bySession['s-a']!
    expect(restored.layout).toEqual(committed.layout)
    expect(restored.editorTabId).toBe(committed.editorTabId)
    // The sequence is not restored; the ids must still resume where they left.
    expect(restored.history).toEqual({ entries: [], cursor: 0 })
    expect(restored.minted).toBe(committed.minted)
    // The next mint cannot collide with an id the restored column already uses.
    second.instance.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/other.md', title: 'other.md',
    }, () => {})
    const ids = Object.keys(second.instance.getSnapshot().bySession['s-a']!.layout.tabs)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never overwrites a live in-memory column with the stored copy', () => {
    const storage = fakeStorage()
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const first = bind(handle, storage, 's-a')
    first.instance.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/a.txt', title: 'a', editor: true,
    }, () => {})
    vi.advanceTimersByTime(500)
    first.instance.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/b.txt', title: 'b',
    }, () => {})
    // Binding again reads the stored copy but must leave the live column alone.
    const stop = bindSurfacePersistence(first.instance, 's-a', first.persistence)
    const titles = Object.values(first.instance.getSnapshot().bySession['s-a']!.layout.tabs).map(tab => tab.title)
    expect(titles).toEqual(['a', 'b'])
    stop()
  })

  it('drops a tab whose kind has no registered definition, scrubbing its pane and records', () => {
    const storage = fakeStorage()
    storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        's-a': {
          layout: {
            nodes: {
              pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: ['tab1', 'tab2', 'tab3'], activeTabId: 'tab2' },
            },
            tabs: {
              tab1: { id: 'tab1', kind: 'guide', contentId: 'sidebar://guide', title: 'Start' },
              tab2: { id: 'tab2', kind: 'ghost', contentId: 'dsh-resource://ghost/thing', title: 'ghost' },
              tab3: { id: 'tab3', kind: 'text', contentId: 'dsh-resource://file/session/s-a/a.txt', title: 'a' },
            },
            rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
          },
          minted: 3,
          editorTabId: 'tab2',
          navigation: {
            tab2: { address: 'dsh-resource://ghost/thing', revision: 1 },
            tab3: { address: 'dsh-resource://file/session/s-a/a.txt', revision: 1 },
          },
        },
      },
    }))
    const restored = new SurfaceStorage(isKnownKind, storage).read('s-a')!
    expect(restored).toBeDefined()
    expect(Object.keys(restored.surface.layout.tabs)).toEqual(['tab1', 'tab3'])
    const pane = (restored.surface.layout.nodes as unknown as Record<string, PaneNode>).pane1!
    expect(pane.tabs).toEqual(['tab1', 'tab3'])
    expect(pane.activeTabId).toBe('tab1')
    expect(restored.surface.editorTabId).toBeUndefined()
    expect(restored.navigation).toEqual({
      tab3: { address: 'dsh-resource://file/session/s-a/a.txt', params: undefined, revision: 1 },
    })
  })

  it('ignores malformed JSON, foreign versions, and payloads that are not surfaces', () => {
    const storage = fakeStorage()
    const persistence = new SurfaceStorage(isKnownKind, storage)
    const broken = [
      '{not json',
      'null',
      '42',
      JSON.stringify({ version: 2, sessions: { 's-a': {} } }),
      JSON.stringify({ version: 1, sessions: 'nope' }),
      JSON.stringify({ version: 1, sessions: { 's-a': { layout: 'nope' } } }),
      JSON.stringify({
        version: 1,
        sessions: {
          's-a': { layout: { nodes: {}, tabs: {}, rootId: 'pane9', floats: [], activePaneId: 'pane9', expanded: true, mode: 'push' } },
        },
      }),
    ]
    for (const payload of broken) {
      storage.setItem(SURFACES_STORAGE_KEY, payload)
      expect(persistence.read('s-a')).toBeUndefined()
    }
    // A store bound to a broken payload still starts with an empty column.
    storage.setItem(SURFACES_STORAGE_KEY, '{not json')
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const { instance } = bind(handle, storage, 's-a')
    expect(instance.getSnapshot().bySession).toEqual({})
  })

  it('persists nothing when the browser has no storage or storage refuses to read', () => {
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const instance = handle.create()
    instance.actions.setExpanded('s-a', true)
    const surface = instance.getSnapshot().bySession['s-a']!
    const noStorage = new SurfaceStorage(isKnownKind)
    expect(noStorage.read('s-a')).toBeUndefined()
    expect(() => { noStorage.write('s-a', surface, {}); noStorage.clear('s-a') }).not.toThrow()

    const storage = fakeStorage()
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('private mode') })
    const unreadable = new SurfaceStorage(isKnownKind, storage)
    expect(unreadable.read('s-a')).toBeUndefined()
    expect(() => { unreadable.write('s-a', surface, {}); unreadable.clear('s-a') }).not.toThrow()
  })

  it('falls back to the first docked pane when the stored active pane did not survive', () => {
    const storage = fakeStorage()
    storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        's-a': {
          layout: {
            nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: [], activeTabId: undefined } },
            tabs: {}, rootId: 'pane1', floats: [], activePaneId: 'pane9', expanded: false, mode: 'push',
          },
          minted: 1,
        },
      },
    }))
    const restored = new SurfaceStorage(isKnownKind, storage).read('s-a')!
    expect(restored.surface.layout.activePaneId).toBe('pane1')
  })

  it('keeps the in-memory column when storage refuses to write', () => {
    const storage = fakeStorage()
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const { instance } = bind(handle, storage, 's-a')
    expect(() => {
      instance.actions.setExpanded('s-a', true)
      vi.advanceTimersByTime(500)
    }).not.toThrow()
    expect(instance.getSnapshot().bySession['s-a']?.layout.expanded).toBe(true)
  })
})

describe('SurfaceStorage — writes', () => {
  it('collapses rapid commits into one debounced write and skips an unchanged payload', () => {
    const storage = fakeStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const { instance, persistence } = bind(handle, storage, 's-a')
    instance.actions.setExpanded('s-a', true)
    instance.actions.openContent('s-a', { kind: 'text', contentId: 'dsh-resource://file/session/s-a/a.txt', title: 'a' }, () => {})
    instance.actions.openContent('s-a', { kind: 'text', contentId: 'dsh-resource://file/session/s-a/b.txt', title: 'b' }, () => {})
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(setItem).toHaveBeenCalledTimes(1)

    // The same committed surface is not written again.
    const surface = instance.getSnapshot().bySession['s-a']!
    persistence.write('s-a', surface, {})
    persistence.write('s-a', surface, {})
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('drops a pruned session\'s entry when its scope dies, keeping the other sessions', () => {
    const storage = fakeStorage()
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const a = bind(handle, storage, 's-a')
    const b = bind(handle, storage, 's-b')
    a.instance.actions.setExpanded('s-a', true)
    b.instance.actions.setExpanded('s-b', true)
    vi.advanceTimersByTime(500)
    expect(Object.keys(storedPayload(storage).sessions)).toEqual(['s-a', 's-b'])

    a.instance.clearPersisted()
    expect(Object.keys(storedPayload(storage).sessions)).toEqual(['s-b'])
    b.instance.clearPersisted()
    expect(storage.getItem(SURFACES_STORAGE_KEY)).toBeNull()
  })

  it('clamps the payload to the session and tab limits', () => {
    const storage = fakeStorage()
    const persistence = new SurfaceStorage(isKnownKind, storage)
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const instance = handle.create()
    instance.actions.setExpanded('s-x', true)
    const surface = instance.getSnapshot().bySession['s-x']!
    for (let index = 0; index <= SURFACE_SESSION_LIMIT; index += 1) persistence.write(`s-${index}`, surface, {})
    expect(persistence.read('s-0')).toBeUndefined()
    expect(persistence.read(`s-${SURFACE_SESSION_LIMIT}`)).toBeDefined()

    const tabs = Object.fromEntries(Array.from({ length: SURFACE_TAB_LIMIT + 5 }, (_, index) => {
      const id = `tab${index + 1}`
      return [id, { id, kind: 'text', contentId: `dsh-resource://file/session/s-a/${index}.txt`, title: `${index}.txt` }]
    }))
    const tabIds = Object.keys(tabs)
    storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        's-a': {
          layout: {
            nodes: { pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: tabIds, activeTabId: tabIds[0] } },
            tabs, rootId: 'pane1', floats: [], activePaneId: 'pane1', expanded: true, mode: 'push',
          },
          minted: SURFACE_TAB_LIMIT + 5,
        },
      },
    }))
    expect(Object.keys(persistence.read('s-a')!.surface.layout.tabs)).toHaveLength(SURFACE_TAB_LIMIT)
  })
})

describe('SurfaceStorage — per-session isolation', () => {
  it('switching back to a session restores its own file, not another session\'s', () => {
    const storage = fakeStorage()
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'Start' }))
    const persistence = new SurfaceStorage(isKnownKind, storage)
    const a = handle.create()
    const b = handle.create()
    bindSurfacePersistence(a, 's-a', persistence)
    bindSurfacePersistence(b, 's-b', persistence)
    a.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/a.txt', title: 'a', editor: true,
    }, () => {})
    vi.advanceTimersByTime(500)
    expect(a.getSnapshot().bySession['s-b']).toBeUndefined()

    // A reload mints fresh stores per session; each reads only its own entry.
    const a2 = handle.create()
    const b2 = handle.create()
    bindSurfacePersistence(a2, 's-a', persistence)
    bindSurfacePersistence(b2, 's-b', persistence)
    const restored = a2.getSnapshot().bySession['s-a']!
    expect(Object.values(restored.layout.tabs).map(tab => tab.title)).toEqual(['a'])
    expect(restored.editorTabId).toBeDefined()
    expect(a2.getSnapshot().bySession['s-b']).toBeUndefined()
    expect(b2.getSnapshot().bySession['s-b']).toBeUndefined()
  })
})

describe('SurfaceStorage — navigation records', () => {
  /** A fresh page's registry, controller, Tab domain, and store over one storage. */
  function world(storage: Storage) {
    const ctx = new Context()
    const tabs = new SidebarRightTabRegistry(ctx)
    const t = ((key: string) => key) as Parameters<typeof guideDefinition>[0]
    tabs.register(guideDefinition(t))
    tabs.register({
      id: 'test/text', kind: 'text', priority: 'fallback',
      patterns: ['dsh-resource://file/**'],
      title: address => address.slice(address.lastIndexOf('/') + 1),
    })
    const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
    const persistence = new SurfaceStorage(kind => tabs.get(kind) !== undefined, storage)
    const { controller, adopt } = createSidebarRightController(tabs, pin, new SidebarRightRail(), persistence)
    const handle = createSidebarRightStore(() => ({ kind: 'guide', title: 'seed' }))
    const open = (sessionId: string) => {
      const instance = handle.create()
      bindSurfacePersistence(instance, sessionId, persistence, id => controller.tabDomain.records(id as SessionId))
      const release = adopt(sessionId as SessionId, instance)
      return { instance, release }
    }
    return { ctx, tabs, pin, persistence, controller, handle, open }
  }

  it('re-renders a restored resource tab with the opener\'s params and revision', () => {
    const storage = fakeStorage()
    const first = world(storage)
    const a = first.open('s-a')
    const settled = vi.fn<(tabId: TabId) => void>()
    a.instance.actions.openContent('s-a', {
      kind: 'text', contentId: 'dsh-resource://file/session/s-a/notes.md', title: 'notes.md', editor: true,
    }, settled)
    const tabId = settled.mock.calls[0]![0]
    first.controller.tabDomain.navigate('s-a' as SessionId, tabId, {
      address: 'dsh-resource://file/session/s-a/notes.md', params: { line: 7 },
    })
    vi.advanceTimersByTime(500)

    // A reload: fresh world, same storage.
    const second = world(storage)
    const restored = second.open('s-a')
    const surface = restored.instance.getSnapshot().bySession['s-a']!
    expect(surface.editorTabId).toBe(tabId)
    expect(surface.layout.tabs[tabId]?.title).toBe('notes.md')
    const occurrence = second.controller.tabDomain.occurrence('s-a' as SessionId, { id: tabId })
    expect(occurrence.navigation.getSnapshot()).toEqual({
      address: 'dsh-resource://file/session/s-a/notes.md', params: { line: 7 }, revision: 1,
    })
    // Adoption reconciles the restored column without waiting for a commit.
    expect(second.pin).toHaveBeenCalledWith('dsh-resource://file/session/s-a/notes.md', occurrence.signal)
  })

  it('does not restore a page layout whose docked tree is broken', () => {
    const storage = fakeStorage()
    storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        's-a': {
          layout: {
            nodes: {
              pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: [], activeTabId: undefined },
              split1: { kind: 'split', id: 'split1', axis: 'row', children: ['pane1', 'pane2'], sizes: [0.5, 0.5] },
            },
            tabs: {},
            rootId: 'split1', floats: ['pane1', 'pane1'], activePaneId: 'pane1', expanded: true, mode: 'push',
          },
        },
      },
    }))
    expect(new SurfaceStorage(isKnownKind, storage).read('s-a')).toBeUndefined()
  })

  it('repairs a float list that names a docked pane', () => {
    const storage = fakeStorage()
    storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sessions: {
        's-a': {
          layout: {
            nodes: {
              pane1: { kind: 'pane', id: 'pane1', host: 'dock', tabs: [], activeTabId: undefined },
              pane2: { kind: 'pane', id: 'pane2', host: 'float', tabs: [], activeTabId: undefined, rect: { x: 1, y: 2, width: 3, height: 4 } },
            },
            tabs: {},
            rootId: 'pane1', floats: ['pane1', 'pane2', 'pane2'], activePaneId: 'pane2', expanded: false, mode: 'push',
          },
          minted: 2,
        },
      },
    }))
    const restored = new SurfaceStorage(isKnownKind, storage).read('s-a')!
    expect(restored.surface.layout.floats).toEqual(['pane2'])
    expect(restored.surface.layout.activePaneId).toBe('pane2')
    const nodes = restored.surface.layout.nodes as unknown as Record<string, PaneNode>
    expect(nodes.pane2!.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(nodes.pane1!.kind).toBe('pane')
  })
})
