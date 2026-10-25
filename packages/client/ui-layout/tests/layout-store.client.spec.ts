// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLayoutStore } from '../src/client/stores.ts'
import type { LayoutWidths } from '../src/client/stores.ts'
import { defaultRightbarWidth, resolveRightbarWidth } from '../src/client/columns.ts'
import type { MainPanelId } from '../src/client/service.ts'

const WIDTHS_KEY = 'dsh.client.layout.widths'

/** One preference as a drag on a given frame records it. */
function preference(px: number, viewport: number): { px: number; ratio: number } {
  return { px, ratio: px / viewport }
}

/** This origin's cached record as storage holds it. */
function readStored(): { sidebar: number; rightbar: { px: number; ratio: number } | null } {
  return JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? 'null') as { sidebar: number; rightbar: { px: number; ratio: number } | null }
}

beforeEach(() => { vi.stubGlobal('innerWidth', 1920); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('createLayoutStore', () => {
  it('starts with the default sidebar and no right panel preference', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        sidebar: 0,
        viewportWidth: 1920,
        narrowExpanded: false,
        rightbar: null,
        widthsEdited: false,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
        rightbarInstant: false,
      },
    })
  })

  it('keeps independent live instances while sharing one device preference per key', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    a.actions.openRightbar(true, false)
    expect(b.store.getSnapshot().layoutInfo.sidebar).toBe(0)
    expect(b.store.getSnapshot().layoutInfo.rightbar).toBeNull()
  })

  it('restores dragged widths on a later boot', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.setRightbar(1000)
    const reopened = createLayoutStore().create()
    expect(reopened.store.getSnapshot().layoutInfo.sidebar).toBe(400)
    expect(reopened.store.getSnapshot().layoutInfo.rightbar).toEqual(preference(1000, 1920))
    expect(resolveRightbarWidth(reopened.store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(1000)
  })

  it('never records a width for opening the panel', () => {
    const first = createLayoutStore().create()
    first.actions.openRightbar(true, false)
    expect(first.store.getSnapshot().layoutInfo.rightbar).toBeNull()
    expect(localStorage.getItem(WIDTHS_KEY)).toBeNull()
    // A sidebar gesture writes the record, and the untouched right panel stays
    // on the shipped default rather than being stamped with one.
    first.actions.setSidebar(400)
    first.actions.toggleSidebar()
    expect(readStored()).toEqual({ sidebar: 0, rightbar: null })
    const reopened = createLayoutStore().create()
    expect(reopened.store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 0, rightbar: null })
  })

  it('keeps a hydrated width across opening and closing without reseeding it', () => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 360, rightbar: preference(640, 1280) }))
    const { store, actions } = createLayoutStore().create()
    expect(store.getSnapshot().layoutInfo).toMatchObject({
      sidebar: 360,
      rightbar: preference(640, 1280),
    })
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(640, 1280))
  })

  it('does not shrink a stored preference to the frame it boots on', () => {
    // The old read clamped the stored px to 70% of the boot frame, and the next
    // sidebar gesture persisted that clamped value: a narrow window silently
    // reduced the operator's width for good.
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 280, rightbar: preference(1200, 2560) }))
    const { store, actions } = createLayoutStore().create()
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(1200, 2560))
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(900)
    actions.setViewportWidth(1280)
    actions.setSidebar(300)
    expect(readStored().rightbar).toEqual(preference(1200, 2560))
    expect(resolveRightbarWidth(readStored().rightbar, 2560)).toBe(1200)
  })

  it('treats malformed or legacy width entries as absent', () => {
    const defaults = { sidebar: 0, rightbar: null }
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject(defaults)
    localStorage.setItem(WIDTHS_KEY, '{not json')
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject(defaults)
    localStorage.setItem(WIDTHS_KEY, 'null')
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject(defaults)
    localStorage.setItem(WIDTHS_KEY, '42')
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject(defaults)
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 'wide', rightbar: 'tall' }))
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject(defaults)
    // A numeric rightbar can only come from the removed first-open default
    // stamp: it is not proof of a drag, so the shipped default wins again.
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 280, rightbar: 672 }))
    expect(createLayoutStore().create().store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 280, rightbar: null })
    for (const rightbar of [
      { px: 500 }, { px: 0, ratio: 0.4 }, { px: 'wide', ratio: 0.4 }, { px: 500, ratio: 0 },
      { px: 500, ratio: 2 }, { px: Number.NaN, ratio: 0.4 }, { px: 500, ratio: Number.NaN },
    ]) {
      localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 280, rightbar }))
      expect(createLayoutStore().create().store.getSnapshot().layoutInfo.rightbar).toBeNull()
    }
  })

  it('reads defaults and skips writes when the browser has no storage', () => {
    vi.stubGlobal('localStorage', undefined)
    const { store, actions } = createLayoutStore().create()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 0, rightbar: null })
    actions.setSidebar(400)
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(400)
  })

  it('keeps the in-memory layout when a write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 400, rightbar: null })
  })

  it('clamps the sidebar to 264–420px', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(264)
    actions.setSidebar(9999)
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(420)
  })

  it('toggles the wide sidebar between closed and default width', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(280)
  })

  it('keeps the sidebar preference while toggling its narrow override', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 400, viewportWidth: 980, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 400, narrowExpanded: false })
  })

  it('clears the manual override only when crossing 1024px', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(980)
    actions.toggleSidebar()
    actions.setViewportWidth(980)
    actions.setViewportWidth(1023)
    expect(store.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    actions.setViewportWidth(1024)
    expect(store.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
    actions.setViewportWidth(980)
    expect(store.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
  })
})

describe('main panel selection', () => {
  const panelA = 'panel-a' as MainPanelId
  const panelB = 'panel-b' as MainPanelId

  it('changes only panelInfo when switching panels and returning to the Conversation', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.openRightbar(true, true)
    actions.closeRightbar()
    const layoutInfo = store.getSnapshot().layoutInfo
    for (const activePanelId of [panelA, panelB, null]) {
      const previousPanelInfo = store.getSnapshot().panelInfo
      actions.selectPanel(activePanelId)
      expect(store.getSnapshot().panelInfo).toEqual({ activePanelId })
      expect(store.getSnapshot().panelInfo).not.toBe(previousPanelInfo)
      expect(store.getSnapshot().layoutInfo).toBe(layoutInfo)
    }
  })

  it('keeps the complete snapshot when selecting the current panel again', () => {
    const { store, actions } = createLayoutStore().create()
    actions.selectPanel(panelA)
    const selected = store.getSnapshot()
    actions.selectPanel(panelA)
    expect(store.getSnapshot()).toBe(selected)
    expect(store.getSnapshot().panelInfo.activePanelId).toBe(panelA)
  })

  it('returns to the Conversation only when the selected main registration disappears', () => {
    const { store, actions } = createLayoutStore().create()
    const initial = store.getSnapshot()
    actions.retainMainPanels([])
    expect(store.getSnapshot()).toBe(initial)
    actions.selectPanel(panelA)
    const selected = store.getSnapshot()
    actions.retainMainPanels(['conversation', panelA, panelB])
    expect(store.getSnapshot()).toBe(selected)
    actions.retainMainPanels(['conversation', panelB])
    expect(store.getSnapshot().panelInfo).toEqual({ activePanelId: null })
    expect(store.getSnapshot().layoutInfo).toBe(selected.layoutInfo)
  })

  it.each(['setSidebar', 'toggleSidebar', 'setViewportWidth', 'setRightbar', 'openRightbar', 'closeRightbar'] as const)(
    'preserves panelInfo identity when %s changes layoutInfo', (action) => {
      const { store, actions } = createLayoutStore().create()
      actions.selectPanel(panelA)
      if (action === 'closeRightbar') actions.openRightbar(true, true)
      const previous = store.getSnapshot()
      switch (action) {
        case 'setSidebar': actions.setSidebar(400); break
        case 'toggleSidebar': actions.toggleSidebar(); break
        case 'setViewportWidth': actions.setViewportWidth(980); break
        case 'setRightbar': actions.setRightbar(500); break
        case 'openRightbar': actions.openRightbar(true, true); break
        case 'closeRightbar': actions.closeRightbar(); break
      }
      expect(store.getSnapshot().panelInfo).toBe(previous.panelInfo)
      expect(store.getSnapshot().layoutInfo).not.toBe(previous.layoutInfo)
    },
  )
})

describe('right panel', () => {
  it('follows the shipped slim default without recording it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1000)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeNull()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeNull()
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 1000)).toBe(defaultRightbarWidth(1000))
    actions.setViewportWidth(2000)
    actions.openRightbar(true, true)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeNull()
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeNull()
    expect(localStorage.getItem(WIDTHS_KEY)).toBeNull()
  })

  it('keeps track and fullscreen reports independent and clears both on close', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false })
    actions.openRightbar(true, true)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: true })
    actions.openRightbar(false, true)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: false, rightbarFullscreen: true })
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  })

  it('keeps a dragged px across resize, close, and reopen, scaled by the frame', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    actions.setRightbar(1100)
    actions.setViewportWidth(800)
    const stored = store.getSnapshot().layoutInfo.rightbar
    expect(stored).toEqual(preference(1100, 1920))
    expect(resolveRightbarWidth(stored, 800)).toBe(Math.round(1100 / 1920 * 800))
    actions.closeRightbar()
    actions.openRightbar(false, true)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(1100, 1920))
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(1100)
  })

  it('clamps drag preferences to 300px and 70% of the current frame', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(1600)
    actions.setRightbar(9999)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(1120, 1600))
    actions.setViewportWidth(1000)
    actions.setRightbar(9999)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(700, 1000))
    actions.setRightbar(1)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(300, 1000))
  })

  it('draws the minimum width on a phone without recording a preference', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setViewportWidth(320)
    actions.openRightbar(false, true)
    expect(store.getSnapshot().layoutInfo.rightbar).toBeNull()
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 320)).toBe(300)
  })

  it('collapses a manually expanded narrow sidebar on opening, not presentation reports', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setViewportWidth(800)
    actions.toggleSidebar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 400, narrowExpanded: false })
    actions.toggleSidebar()
    actions.openRightbar(true, true)
    expect(store.getSnapshot().layoutInfo.narrowExpanded).toBe(true)
    actions.closeRightbar()
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.narrowExpanded).toBe(false)
  })

  it('keeps the wide sidebar preference and never opens a closed right panel on resize', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(420)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(420)
    actions.closeRightbar()
    actions.setViewportWidth(3000)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ sidebar: 420, rightbarShown: false, rightbarTrack: false })
  })
})

describe('host width record', () => {
  it('mirrors each committed gesture with px and ratio', () => {
    const persistHost = vi.fn<(widths: LayoutWidths) => void>()
    const { actions } = createLayoutStore({ persistHost }).create()
    actions.setRightbar(720)
    expect(persistHost).toHaveBeenCalledWith({ sidebar: 0, rightbar: preference(720, 1920) })
    actions.setSidebar(320)
    expect(persistHost).toHaveBeenLastCalledWith({ sidebar: 320, rightbar: preference(720, 1920) })
  })

  it('adopts the host record over this origin cache and rewrites the local copy', () => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 280, rightbar: preference(500, 1920) }))
    const { store, actions } = createLayoutStore().create()
    actions.adoptWidths({ sidebar: 360, rightbar: preference(720, 1920) })
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(360)
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(720)
    expect(readStored()).toEqual({ sidebar: 360, rightbar: preference(720, 1920) })
  })

  it('keeps a gesture made while the host read was in flight', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setRightbar(640)
    actions.adoptWidths({ sidebar: 400, rightbar: preference(900, 1920) })
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(0)
    expect(resolveRightbarWidth(store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(640)
  })

  it('keeps the local right width when the host record carries none', () => {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ sidebar: 280, rightbar: preference(700, 1920) }))
    const { store, actions } = createLayoutStore().create()
    actions.adoptWidths({ sidebar: 300 })
    expect(store.getSnapshot().layoutInfo.sidebar).toBe(300)
    expect(store.getSnapshot().layoutInfo.rightbar).toEqual(preference(700, 1920))
    expect(readStored()).toEqual({ sidebar: 300, rightbar: preference(700, 1920) })
  })

  it('never reports an opening to the host', () => {
    const persistHost = vi.fn<(widths: LayoutWidths) => void>()
    const { actions } = createLayoutStore({ persistHost }).create()
    actions.openRightbar(true, false)
    actions.closeRightbar()
    actions.openRightbar(true, true)
    expect(persistHost).not.toHaveBeenCalled()
  })

  it('survives an origin change through the host record', () => {
    const pushed: LayoutWidths[] = []
    const first = createLayoutStore({ persistHost: (widths) => { pushed.push(widths) } }).create()
    first.actions.setRightbar(720)
    expect(pushed).toHaveLength(1)
    // Another origin starts with no cache at all.
    localStorage.clear()
    const second = createLayoutStore().create()
    expect(second.store.getSnapshot().layoutInfo.rightbar).toBeNull()
    const record = pushed[0]!
    second.actions.adoptWidths(record.rightbar === null
      ? { sidebar: record.sidebar }
      : { sidebar: record.sidebar, rightbar: record.rightbar })
    expect(resolveRightbarWidth(second.store.getSnapshot().layoutInfo.rightbar, 1920)).toBe(720)
  })

  it('does not mirror an adopted record back to the host', () => {
    const persistHost = vi.fn<(widths: LayoutWidths) => void>()
    const { actions } = createLayoutStore({ persistHost }).create()
    actions.adoptWidths({ sidebar: 360, rightbar: preference(720, 1920) })
    expect(persistHost).not.toHaveBeenCalled()
  })
})

describe('right panel instant geometry', () => {
  it.each([true, false])('closes fullscreen with track=%s in one instant update and retains repeated close reports', (track) => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(track, true)
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false, rightbarInstant: true,
    })
    const closed = store.getSnapshot()
    actions.closeRightbar()
    expect(store.getSnapshot()).toBe(closed)
  })

  it('restores the normal track instantly, retaining the marker on an identical report', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, true)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo).toMatchObject({
      rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false, rightbarInstant: true,
    })
    const restored = store.getSnapshot()
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toBe(restored)
    actions.openRightbar(false, false)
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
  })

  it('allows a normal close to animate, including after restoring from fullscreen', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, false)
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
    actions.openRightbar(true, true)
    actions.openRightbar(true, false)
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(true)
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarTrack: false, rightbarInstant: false })
  })

  it.each(['setSidebar', 'toggleSidebar', 'setRightbar', 'setViewportWidth'] as const)('clears instant geometry on %s', (action) => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, true)
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(true)
    if (action === 'toggleSidebar') actions.toggleSidebar()
    else actions[action](action === 'setViewportWidth' ? 1800 : 350)
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
    actions.closeRightbar()
    expect(store.getSnapshot().layoutInfo.rightbarInstant).toBe(false)
  })

  it('does not let an unchanged frame measurement reset the fullscreen-exit marker', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, true)
    actions.closeRightbar()
    const closed = store.getSnapshot()
    actions.setViewportWidth(closed.layoutInfo.viewportWidth)
    expect(store.getSnapshot()).toBe(closed)
  })

  it.each([true, false])('clears the exit marker on a fresh opening with fullscreen=%s', (fullscreen) => {
    const { store, actions } = createLayoutStore().create()
    actions.openRightbar(true, true)
    actions.closeRightbar()
    actions.openRightbar(true, fullscreen)
    expect(store.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarFullscreen: fullscreen, rightbarInstant: false })
  })
})
