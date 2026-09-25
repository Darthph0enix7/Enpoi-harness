// @vitest-environment jsdom
/** Sidebar presentation and tab subscriptions through the production slot renderer. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PaneId, SplitId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { dockPaneIds, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply, inject } from '../src/client/index.ts'
import { intentsFor } from '../src/client/shell/SidebarRight.tsx'
import { GUIDE_KIND } from '../src/client/contract/seed.ts'
import type { SidebarRightTabInfo, SidebarRightTabMenuOwnerProps } from '../src/client/contract/slots.ts'
import type { createSidebarRightStore } from '../src/client/stores.ts'

declare module '../src/client/contract/params.ts' {
  interface SidebarRightResourceParamsMap {
    test: { line?: number; x?: number }
  }
}

const SESSION = 's-test' as SessionId
const OTHER = 's-other' as SessionId
const runtimes: SlotTestRuntime[] = []
let getAnimationsDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  // The seat's stores restore their session's column from localStorage; a
  // previous test's column must not seed the next test's seat.
  localStorage.clear()
  getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations')
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, writable: true, value: () => [] })
})

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    vi.restoreAllMocks()
    if (getAnimationsDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'getAnimations')
    else Object.defineProperty(Element.prototype, 'getAnimations', getAnimationsDescriptor)
  }
})

/** Browser-owned animation completion controlled independently of the test clock. */
function transition(property = 'transform') {
  const done = Promise.withResolvers<Animation>()
  let state: AnimationPlayState = 'running'
  const animation = {
    transitionProperty: property,
    get playState() { return state },
    finished: done.promise,
  } as CSSTransition
  return {
    animation,
    finish: () => { state = 'finished'; done.resolve(animation) },
    cancel: () => { state = 'idle'; done.reject(new DOMException('Transition canceled', 'AbortError')) },
  }
}

async function mountSeat(viewportWidth = 1440, canShow = true, entryCount = 0, mobile = false) {
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const frame = { openRightbar: vi.fn(), closeRightbar: vi.fn(), setRightbar: vi.fn() }
  const pin = vi.fn<(address: string, signal: AbortSignal) => void>()
  runtime.ctx.provide('layout', frame as never)
  runtime.ctx.provide('resources', { pin } as never)
  // The merged plugin injects the shortcut registry; the seat reads only its
  // catalog for chrome hints, so an empty effective catalog serves the seat.
  const shortcutCatalog: readonly never[] = []
  runtime.ctx.provide('shortcuts', {
    runtime: 'web',
    register: () => () => {},
    // A stable snapshot: the hook compares by identity.
    catalog: { getSnapshot: () => shortcutCatalog, subscribe: () => () => {} },
  } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({
    'rightbar': { kind: 'single', scope: 'root' },
  })
  await runtime.sessions.add({ id: SESSION })
  let reference = runtime.sessions.retainFor(runtime.ctx, SESSION, { source: 'mainView' })
  const feature = await runtime.mount({ inject: [...inject], apply })
  const bodies = new Map<string, SidebarRightTabInfo>()
  const titles = new Map<string, SidebarRightTabInfo>()
  const hooks = new Map<string, PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']>()
  let mounts = 0
  function Body(props: PropsRuntime<'sidebar.right.pane.tab'>) {
    const info = props.useTabInfo()
    const [instance] = useState(() => ++mounts)
    bodies.set(info.tab.id, info)
    hooks.set(info.tab.id, props.useTabInfo)
    expect(['tabInfo', 'tab', 'paneId', 'visible', 'navigation', 'signal', 'tabActions'].filter(key => key in props)).toEqual([])
    return <span data-tab-body={info.tab.id} data-instance={instance} data-revision={info.tab.navigation.revision} />
  }
  function Title({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
    const info = useTabInfo()
    titles.set(info.tab.id, info)
    return <span data-tab-title={info.tab.id}>{info.tab.title}</span>
  }
  await act(async () => {
    runtime.ctx.sidebarRightTabs.register({
      id: 'test/text', kind: 'text', priority: 'builtin', patterns: ['dsh-resource://file/**'],
      title: address => address.slice(address.lastIndexOf('/') + 1),
      guide: Array.from({ length: entryCount }, (_, order) => ({ id: String(order), order, title: () => 'Test', description: () => 'Test page' })),
    })
    // The files page carries no guide entry: it is the anchor a file open
    // lights, not a rail icon of its own (ui-sidebar-files owns it in the
    // shipped composition).
    runtime.ctx.sidebarRightTabs.register({
      id: 'test/files', kind: 'files', priority: 'builtin', patterns: ['sidebar://files'],
      title: () => 'Files',
    })
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/text' }, Body)
    runtime.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'test/text' }, Title)
    runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'test/files' }, Body)
    runtime.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'test/files' }, Title)
  })
  const view = runtime.renderSlot('rightbar', { width: 420, viewportWidth, canShow, mobile })
  const instance = runtime.storeOf('rightbar.session', reference) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
  const controller = runtime.ctx.sidebarRight
  const layout = () => instance.getSnapshot().bySession[SESSION]!.layout
  const editorRecord = () => {
    const id = instance.getSnapshot().bySession[SESSION]?.editorTabId
    return id === undefined ? undefined : layout().tabs[id]
  }
  const open = (name = 'a.txt', options?: Parameters<typeof controller.openResource>[1]) => {
    act(() => { controller.openResource(`dsh-resource://file/session/s-test/${name}`, options) })
    // The file lands in the editor record; the files page takes the dock's
    // active slot (the anchor), so callers want the record, not `active()`.
    return editorRecord() ?? controller.active()!
  }
  const selectSession = (id: SessionId): SessionReference => {
    const next = runtime.sessions.retainFor(runtime.ctx, id, { source: 'mainView' })
    reference.release()
    reference = next
    return next
  }
  return {
    runtime, feature, controller, instance, actions: instance.actions, layout, editorRecord,
    open, selectSession, frame, pin, bodies, titles, hooks, view,
  }
}

function element(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(selector)
  if (node === null) throw new Error(`expected ${selector}`)
  return node
}

describe('RightbarSeat presentation', () => {
  it('hides for a global main panel and retains the Session sidebar state', async () => {
    const h = await mountSeat()
    h.open('retained.txt')
    const retained = h.layout()
    act(() => { h.runtime.panelInfo.set({ activePanelId: 'other-panel' as MainPanelId }) })
    expect(h.view.container.querySelector('[data-sidebar-right-panel]')).toBeNull()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    expect(h.layout()).toBe(retained)
    act(() => { h.runtime.panelInfo.set({ activePanelId: null }) })
    expect(h.view.container.querySelector('[data-sidebar-right-panel]')).not.toBeNull()
    expect(h.layout()).toBe(retained)
  })

  it('opens the first rail item at mount and keeps the tab strip controls reachable', async () => {
    const h = await mountSeat(1440, true, 2)
    // The rail is global state, open by default: the panel shows the first
    // registered page kind without a click.
    const rail = element(h.view.container, '[data-sidebar-right-rail]')
    expect(rail.querySelectorAll('[data-sidebar-right-rail-item]')).toHaveLength(1)
    expect(h.layout().expanded).toBe(true)
    const initial = Object.values(h.layout().tabs)[0]!
    expect(initial.kind).toBe('text')
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${initial.id}"]`)).not.toBeNull()

    // A rail icon click collapses the panel; the rail stays.
    fireEvent.click(element(h.view.container, '[data-sidebar-right-rail-item="text"]'))
    expect(h.layout().expanded).toBe(false)
    expect(element(h.view.container, '[data-sidebar-right-rail]')).not.toBeNull()

    // Clicking it again reopens the same page, once.
    fireEvent.click(element(h.view.container, '[data-sidebar-right-rail-item="text"]'))
    expect(h.layout().expanded).toBe(true)
    expect(Object.values(h.layout().tabs).filter(tab => tab.kind === 'text')).toHaveLength(1)
  })

  it('seeds the guide when no page kind offers a rail icon, protecting only a sole guide', async () => {
    const h = await mountSeat(1440, true, 0)
    expect(h.view.container.querySelectorAll('[data-sidebar-right-rail-item]')).toHaveLength(0)
    expect(h.layout().expanded).toBe(false)
    act(() => { h.controller.toggleExpanded() })
    const initial = Object.values(h.layout().tabs)[0]!
    expect(initial.kind).toBe('guide')
    expect(h.view.container.querySelectorAll('[data-dockkit-tab-close]')).toHaveLength(0)
    const before = h.layout()
    act(() => { h.controller.close(initial.id) })
    expect(h.layout()).toBe(before)
    fireEvent.contextMenu(element(h.view.container, '[data-dockkit-tab]'))
    expect(document.querySelector('[data-dockkit-tab-menu] [role^="menuitem"]')).toBeNull()
    expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
  })

  it('draws the lit rail page, and brings it back as a fresh record after its tab closes', async () => {
    const h = await mountSeat(1440, true, 1)
    // One guide entry makes the store's default seed that entry's page; the
    // rail opens it at mount.
    expect(h.layout().expanded).toBe(true)
    const initial = Object.values(h.layout().tabs)[0]!
    expect(initial.kind).toBe('text')
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${initial.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(initial.id) })
    // The rail's kind stays lit, so the panel draws that page again rather than
    // staying empty; the record is fresh.
    const reopened = Object.values(h.layout().tabs).find(tab => tab.kind === 'text')!
    expect(reopened.id).not.toBe(initial.id)
    expect(h.layout().expanded).toBe(true)
    // The guide stays available as the pane's second page.
    fireEvent.click(element(h.view.container, '[data-dockkit-add-tab]'))
    expect(Object.values(h.layout().tabs).some(tab => tab.kind === 'guide')).toBe(true)
    expect(h.view.container.querySelector('[data-dockkit-add-tab]')).toBeNull()
    const preview = h.open('ordinary.txt')
    expect(h.view.container.querySelector(`[data-dockkit-tab-close="${preview.id}"]`)).not.toBeNull()
    act(() => { h.controller.close(preview.id) })
    expect(h.layout().tabs[preview.id]).toBeUndefined()
  })

  it('offers close for a floating tab and docks it back into the pane', async () => {
    const h = await mountSeat()
    const floating = h.open('floating.txt')
    act(() => { h.controller.float(floating.id) })
    const paneId = getPane(h.layout(), h.layout().floats[0]!).id
    const close = document.querySelector<HTMLButtonElement>(`[data-dockkit-float-close="${paneId}"]`)
    expect(close).not.toBeNull()

    fireEvent.click(close!)

    expect(h.layout().tabs[floating.id]).toBeUndefined()
    expect(h.layout().floats).toHaveLength(0)
    // The files anchor keeps the docked pane occupied.
    expect(getPane(h.layout(), h.layout().rootId).tabs).toHaveLength(1)
    expect(h.layout().tabs[getPane(h.layout(), h.layout().rootId).tabs[0]!]?.kind).toBe('files')
  })

  it('keeps the panel mounted while collapsed and releases the frame on unmount', async () => {
    const h = await mountSeat()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    expect(panel.getAttribute('aria-hidden')).toBe('true')
    expect(h.frame.closeRightbar).toHaveBeenCalled()
    h.open()
    expect(element(h.view.container, '[data-sidebar-right-panel]')).toBe(panel)
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    await h.runtime.dispose()
    expect(h.frame.closeRightbar).toHaveBeenCalled()
  })

  it('mounts the editor pane at zero width before its first record and opens it on a file', async () => {
    const h = await mountSeat()
    // No editor tab: the pane is not mounted on a page that never shows it.
    expect(h.view.container.querySelector('[data-sidebar-right-editor]')).toBeNull()
    h.open()
    // The visible editor is exactly expanded && files && record.
    const editor = element(h.view.container, '[data-sidebar-right-editor]')
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(parseFloat(editor.style.width)).toBeGreaterThan(0)
    expect(editor.querySelector('[data-tab-body]')).not.toBeNull()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    // The panel box is the column's whole share; the pane and the tree split
    // it, so the box width is the same whether or not the preview is open.
    expect(parseFloat(panel.style.width)).toBe(420 - 44)
    // The operator's collapse closes the pane in the same commit; the pane
    // stays mounted so the reopen has a zero-width state to grow from.
    act(() => { h.controller.toggleExpanded() })
    expect(element(h.view.container, '[data-sidebar-right-editor]')).toBe(editor)
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(false)
    expect(parseFloat(editor.style.width)).toBe(0)
    act(() => { h.controller.toggleExpanded() })
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(parseFloat(editor.style.width)).toBeGreaterThan(0)
    expect(parseFloat(panel.style.width)).toBe(420 - 44)
  })

  it('opens a tab action\'s file in the editor pane while the panel keeps its page', async () => {
    const h = await mountSeat(1440, true, 0)
    h.open('a.txt')
    act(() => { h.controller.selectKind(GUIDE_KIND) })
    const page = Object.values(h.layout().tabs).find(tab => tab.kind === GUIDE_KIND)!
    // The page's own action is how the file tree opens a row; it reports its
    // docked pane as an implicit placement, which must not replace the page.
    act(() => {
      h.controller.tabDomain.occurrence(SESSION, { id: page.id })
        .tabActions.openResource('dsh-resource://file/session/s-test/b.txt')
    })
    const b = Object.values(h.layout().tabs).find(tab => tab.title === 'b.txt')!
    expect(h.instance.getSnapshot().bySession[SESSION]?.editorTabId).toBe(b.id)
    const editor = element(h.view.container, '[data-sidebar-right-editor]')
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(parseFloat(editor.style.width)).toBeGreaterThan(0)
    expect(element(h.view.container, '[data-sidebar-right-editor] [data-tab-body]').dataset['tabBody']).toBe(b.id)
    // The panel's own page still fills the panel body, not the file.
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(page.id)
    expect(element(h.view.container, '[data-sidebar-right-body]')).not.toBe(editor)
  })

  it('focuses the files tab in the rail for any file open, whatever page was lit', async () => {
    const h = await mountSeat(1440, true, 1)
    // One guide entry made the viewer page the lit one before the file open.
    const page = Object.values(h.layout().tabs).find(tab => tab.kind === 'text')!
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(page.id)
    h.open('b.txt')
    expect(h.controller.rail.state.getSnapshot().kind).toBe('files')
    expect(h.layout().expanded).toBe(true)
    // The tree (the files page) is the visible anchor; the file draws beside it.
    const files = Object.values(h.layout().tabs).find(tab => tab.kind === 'files')!
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(files.id)
    const file = h.editorRecord()!
    const editor = element(h.view.container, '[data-sidebar-right-editor]')
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(element(editor, '[data-tab-body]').dataset['tabBody']).toBe(file.id)
    // The dock's own pane never mounts a second copy of the record.
    expect(element(h.view.container, '[data-sidebar-right-body]').querySelector(`[data-tab-body="${file.id}"]`)).toBeNull()
  })

  it('opens a panel-placement resource as the panel page with no editor pane', async () => {
    const h = await mountSeat(1440, true, 0)
    await act(async () => {
      h.runtime.ctx.sidebarRightTabs.register({
        id: 'test/session-view', kind: 'sessionview', priority: 'builtin',
        patterns: ['dsh-resource://test/session/**'], opensIn: 'panel', title: () => 'session view',
      })
    })
    act(() => { h.controller.selectKind(GUIDE_KIND) })
    act(() => { h.controller.openResource('dsh-resource://test/session/s-test/child') })
    const tab = h.controller.active()!
    expect(tab.kind).toBe('sessionview')
    expect(h.instance.getSnapshot().bySession[SESSION]?.editorTabId).toBeUndefined()
    expect(element(h.view.container, '[data-sidebar-right-editor]').hasAttribute('data-sidebar-right-editor-open')).toBe(false)
  })

  it('collapses the editor pane when the rail switches away from files and re-reveals it on return', async () => {
    const h = await mountSeat(1440, true, 1)
    h.open('a.txt')
    const editor = element(h.view.container, '[data-sidebar-right-editor]')
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(parseFloat(editor.style.width)).toBeGreaterThan(0)
    // Any other rail tab closes the pane in the same commit; the tree stays.
    act(() => { h.controller.selectKind('text') })
    expect(editor.hasAttribute('data-sidebar-right-editor-open')).toBe(false)
    expect(parseFloat(editor.style.width)).toBe(0)
    expect(element(h.view.container, '[data-sidebar-right-body]')).toBeTruthy()
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    // Returning to files re-reveals the same record.
    act(() => { h.controller.selectKind('files') })
    const reopened = element(h.view.container, '[data-sidebar-right-editor]')
    expect(reopened.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(parseFloat(reopened.style.width)).toBeGreaterThan(0)
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
  })

  it('keeps the editor divider interactive only while the pane is open', async () => {
    const h = await mountSeat()
    expect(h.view.container.querySelector('[data-sidebar-right-editor-divider]')).toBeNull()
    h.open()
    const divider = element(h.view.container, '[data-sidebar-right-editor-divider]')
    expect(divider.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(divider.hasAttribute('data-sidebar-right-editor-live')).toBe(true)
    // Collapsing the column closes the pane; its seam is no longer a drag target.
    act(() => { h.controller.toggleExpanded() })
    expect(element(h.view.container, '[data-sidebar-right-editor-divider]')).toBe(divider)
    expect(divider.hasAttribute('data-sidebar-right-editor-open')).toBe(false)
    expect(divider.hasAttribute('data-sidebar-right-editor-live')).toBe(false)
    act(() => { h.controller.toggleExpanded() })
    expect(divider.hasAttribute('data-sidebar-right-editor-open')).toBe(true)
    expect(divider.hasAttribute('data-sidebar-right-editor-live')).toBe(true)
  })

  it('reopens the lit page while the rail records an open intent, and folds when it records a close', async () => {
    const h = await mountSeat(1440, true, 1)
    // The rail is the open/close control: a surface collapsed behind its back
    // is reopened on the next commit, because the intent still says open.
    act(() => { h.actions.setExpanded(SESSION, false) })
    expect(h.layout().expanded).toBe(true)
    act(() => { h.controller.rail.setOpen(false) })
    expect(h.layout().expanded).toBe(false)
  })

  it('opens a session the seat has never drawn without reporting a collapse first', async () => {
    const h = await mountSeat(1440, true, 1)
    h.open('kept.txt')
    await h.runtime.sessions.add({ id: OTHER })
    h.frame.closeRightbar.mockClear()
    let otherRef!: SessionReference
    act(() => { otherRef = h.selectSession(OTHER) })
    const other = h.runtime.storeOf('rightbar.session', otherRef) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
    // The target materializes expanded with the lit page in the same frame, so
    // the frame never learns a collapse it would have to take back.
    expect(other.getSnapshot().bySession[OTHER]?.layout.expanded).toBe(true)
    expect(h.frame.closeRightbar).not.toHaveBeenCalled()
    expect(element(h.view.container, '[data-sidebar-right-panel]').hasAttribute('data-sidebar-right-open')).toBe(true)
  })

  it('fills the viewport without replacing the content tree or releasing the wide track', async () => {
    const h = await mountSeat()
    const tab = h.open()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    const body = element(h.view.container, '[data-sidebar-right-body] [data-tab-body]')
    // The editor shares the column, so the panel takes what the rail and editor leave.
    const wideWidth = panel.style.width
    expect(parseFloat(wideWidth)).toBeGreaterThan(0)
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.layout().mode).toBe('fullscreen')
    expect(panel.style.width).toBe('100%')
    expect(panel.dataset['sidebarRightPanel']).toBe('fullscreen')
    expect(element(h.view.container, '[data-sidebar-right-body] [data-tab-body]')).toBe(body)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, true)
    expect(h.bodies.get(tab.id)?.sidebar).toEqual({ expanded: true, fullscreen: true })
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(panel.style.width).toBe(wideWidth)
    expect(element(h.view.container, '[data-sidebar-right-body] [data-tab-body]')).toBe(body)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    act(() => { h.controller.toggleExpanded() })
    expect(h.layout().expanded).toBe(false)
    expect(h.frame.closeRightbar).toHaveBeenCalled()
  })

  it('derives narrow fullscreen without recording mode and returns to normal when widened', async () => {
    const h = await mountSeat(767, false)
    const record = h.open()
    expect(h.layout().mode).toBe('push')
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(false, true)
    // The narrow frame cannot show, so the lit files page waited; widening
    // seats it beside the document record, which survives untouched.
    h.view.update({ width: 420, viewportWidth: 768, canShow: true, mobile: false })
    expect(h.layout().tabs[record.id]).toBeDefined()
    const files = Object.values(h.layout().tabs).find(tab => tab.kind === 'files')!
    expect(element(h.view.container, '[data-sidebar-right-body] [data-tab-body]').dataset['tabBody']).toBe(files.id)
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
  })

  it('closes on automatic fullscreen exit and re-seats the lit files page when widened', async () => {
    const h = await mountSeat(500, false)
    const record = h.open()
    const signal = h.bodies.get(record.id)!.tab.signal
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.layout().expanded).toBe(false)
    expect(h.layout().mode).toBe('push')
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true, mobile: false })
    // The rail still records the open intent: widening seats the lit files page.
    const files = Object.values(h.layout().tabs).find(tab => tab.kind === 'files')!
    expect(h.layout().expanded).toBe(true)
    expect(element(h.view.container, '[data-sidebar-right-body] [data-tab-body]').dataset['tabBody']).toBe(files.id)
    expect(h.layout().tabs[record.id]).toBeDefined()
    expect(signal.aborted).toBe(false)
  })

  it('preserves manual fullscreen through narrow and wide viewport changes', async () => {
    const h = await mountSeat()
    h.open()
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    const stored = h.instance.getSnapshot()
    h.view.update({ width: 420, viewportWidth: 500, canShow: false, mobile: false })
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(false, true)
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true, mobile: false })
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, true)
    expect(h.instance.getSnapshot()).toBe(stored)
  })

  it('collapses a normal panel that cannot fit, keeps its records, and re-seats the lit page on growth', async () => {
    const h = await mountSeat()
    const record = h.open()
    const signal = h.bodies.get(record.id)!.tab.signal
    h.view.update({ width: 420, viewportWidth: 900, canShow: false, mobile: false })
    expect(h.layout().expanded).toBe(false)
    expect(h.layout().tabs[record.id]).toBeDefined()
    expect(signal.aborted).toBe(false)
    h.view.update({ width: 420, viewportWidth: 1440, canShow: true, mobile: false })
    // The rail's open intent still stands: growth re-seats the lit files page
    // without touching the document record.
    expect(h.layout().expanded).toBe(true)
    expect(h.layout().tabs[record.id]).toBeDefined()
    expect(Object.values(h.layout().tabs).some(tab => tab.kind === 'files')).toBe(true)
    expect(signal.aborted).toBe(false)
  })
})

describe('RightbarSeat fullscreen entry', () => {
  it('retains the previous report until its transform finishes, then leaves the track in place on exit', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    const slide = transition()
    const unrelated = transition('opacity')
    vi.spyOn(panel, 'getAnimations').mockReturnValue([slide.animation, unrelated.animation])
    h.frame.closeRightbar.mockClear()
    h.open()
    expect(panel.hasAttribute('data-sidebar-right-open')).toBe(true)
    expect(panel.dataset['sidebarRightPanel']).toBe('fullscreen')
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    expect(h.frame.closeRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(true, true)
    fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    unrelated.finish()
  })

  it('reports immediately without a transform transition, including zero-duration and reduced-motion entry', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const unrelated = transition('opacity')
    const ended = transition()
    ended.finish()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([unrelated.animation, ended.animation])
    h.open()
    // The file record and the lit files page commit separately, so the report
    // lands at least once without waiting for any transition.
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, true)
    unrelated.finish()
  })

  it('reports when reduced motion cancels the entering transition', async () => {
    const h = await mountSeat(767, false)
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.cancel(); await Promise.allSettled([slide.animation.finished]) })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('waits for a replacement transform after cancellation', async () => {
    const h = await mountSeat(767, false)
    const first = transition()
    const replacement = transition()
    const animations = vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([first.animation])
    h.open()
    animations.mockReturnValue([replacement.animation])
    await act(async () => { first.cancel(); await Promise.allSettled([first.animation.finished]) })
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { replacement.finish(); await replacement.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it.each(['close', 'push', 'session', 'unmount'])('ignores a late completion after %s', async (change) => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    if (change === 'close') act(() => { h.controller.toggleExpanded() })
    else if (change === 'push') fireEvent.click(element(h.view.container, '[data-sidebar-right-mode]'))
    else if (change === 'session') {
      await h.runtime.sessions.add({ id: OTHER })
      act(() => { h.selectSession(OTHER) })
      act(() => { h.controller.openResource('dsh-resource://file/session/s-other/b.txt') })
    } else await h.runtime.dispose()
    const openCalls = [...h.frame.openRightbar.mock.calls]
    const closeCalls = h.frame.closeRightbar.mock.calls.length
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar.mock.calls).toEqual(openCalls)
    expect(h.frame.closeRightbar).toHaveBeenCalledTimes(closeCalls)
  })

  it('uses the current viewport report when entry crosses the fullscreen breakpoint', async () => {
    const h = await mountSeat()
    act(() => { h.actions.setMode(SESSION, 'fullscreen') })
    const slide = transition()
    vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations').mockReturnValue([slide.animation])
    h.open()
    h.view.update({ width: 420, viewportWidth: 500, canShow: false, mobile: false })
    expect(h.frame.openRightbar).not.toHaveBeenCalled()
    await act(async () => { slide.finish(); await slide.animation.finished })
    expect(h.frame.openRightbar).toHaveBeenCalledExactlyOnceWith(false, true)
  })

  it('does not delay normal presentation behind its slide', async () => {
    const h = await mountSeat()
    const slide = transition()
    const animations = vi.spyOn(element(h.view.container, '[data-sidebar-right-panel]'), 'getAnimations')
      .mockReturnValue([slide.animation])
    h.open()
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(true, false)
    expect(animations).not.toHaveBeenCalled()
    slide.finish()
  })
})

describe('slot-owned useTabInfo', () => {
  it('updates body and title navigation with no layout commit and retains the bound hook', async () => {
    const h = await mountSeat()
    const tab = h.open('a.txt', { params: { line: 3 } })
    const stored = h.instance.getSnapshot()
    const hook = h.hooks.get(tab.id)
    const signal = h.bodies.get(tab.id)!.tab.signal
    act(() => { h.controller.tabDomain.navigate(SESSION, tab.id, { address: tab.contentId, params: { line: 7 } }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(h.hooks.get(tab.id)).toBe(hook)
    expect(h.bodies.get(tab.id)?.tab.navigation).toEqual({ address: tab.contentId, params: { line: 7 }, revision: 2 })
    expect(h.titles.get(tab.id)?.tab.navigation).toBe(h.bodies.get(tab.id)?.tab.navigation)
    expect(h.bodies.get(tab.id)?.tab.signal).toBe(signal)
    expect(element(h.view.container, '[data-tab-body]').dataset['revision']).toBe('2')
  })

  it('isolates same-kind record state and reports inactive titles, hiding, floating and docking', async () => {
    const h = await mountSeat()
    const a = h.open('a.txt')
    const files = Object.values(h.layout().tabs).find(tab => tab.kind === 'files')!
    // The editor's newest open does not steal the panel's anchor page.
    h.open('b.txt')
    const b = h.editorRecord()!
    const bodyPanel = element(h.view.container, '[data-sidebar-right-body] [data-tab-body]')
    const bodyB = element(h.view.container, '[data-sidebar-right-editor] [data-tab-body]')
    expect(bodyPanel.dataset['tabBody']).toBe(files.id)
    expect(bodyB.dataset['tabBody']).toBe(b.id)
    expect(bodyPanel.dataset['instance']).not.toBe(bodyB.dataset['instance'])
    // The first record is dormant behind the editor's newest open: it draws
    // nowhere, while its title still reports it.
    expect(h.view.container.querySelector(`[data-tab-body="${a.id}"]`)).toBeNull()
    expect(h.titles.get(b.id)?.tab.visible).toBe(true)
    const signal = h.bodies.get(files.id)!.tab.signal
    act(() => { h.controller.toggleExpanded() })
    expect(h.titles.get(files.id)?.tab.visible).toBe(false)
    expect(element(h.view.container, '[data-sidebar-right-body] [data-tab-body]')).toBe(bodyPanel)
    expect(signal.aborted).toBe(false)
    // Floating the dormant record gives it a surface of its own, isolated from
    // the panel's drawn page.
    act(() => { h.controller.float(a.id) })
    expect(h.bodies.get(a.id)?.tab.visible).toBe(true)
    const paneId = h.bodies.get(a.id)!.panel.id
    expect(h.layout().floats).toContain(paneId)
    act(() => { h.controller.dock(paneId) })
    expect(h.layout().floats).toHaveLength(0)
    expect(h.bodies.get(files.id)?.tab.signal).toBe(signal)
  })

  it('keeps session records and navigation while unmounted, aborting only removal and plugin unload', async () => {
    const h = await mountSeat()
    const own = h.open()
    const info = h.bodies.get(own.id)!
    const stored = h.instance.getSnapshot()
    await h.runtime.sessions.add({ id: OTHER })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(info.tab.signal.aborted).toBe(false)
    let otherRef!: SessionReference
    act(() => { otherRef = h.selectSession(OTHER) })
    act(() => { h.controller.openResource('dsh-resource://file/session/s-other/other.txt', { params: { line: 9 } }) })
    const otherStore = h.runtime.storeOf('rightbar.session', otherRef) as ReturnType<ReturnType<typeof createSidebarRightStore>['create']>
    const otherSurface = otherStore.getSnapshot().bySession[OTHER]!
    const otherTab = otherSurface.layout.tabs[otherSurface.editorTabId!]!
    expect(otherTab.title).toBe('other.txt')
    const otherInfo = h.bodies.get(otherTab.id)!
    expect(otherInfo.tab.signal).not.toBe(info.tab.signal)
    act(() => { info.tab.actions.openResource('dsh-resource://file/session/s-test/b.txt') })
    expect(Object.values(h.layout().tabs).map(tab => tab.title)).toContain('b.txt')
    // The other session's record kept its navigation while this one opened.
    expect(otherStore.getSnapshot().bySession[OTHER]!.editorTabId).toBe(otherTab.id)
    expect(h.bodies.get(otherTab.id)?.tab.navigation.params).toEqual({ line: 9 })
    act(() => { info.tab.actions.close() })
    expect(info.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(false)
    const remaining = h.bodies.get(otherTab.id)!
    expect(remaining.tab.navigation.revision).toBe(1)
    await h.feature.dispose()
    expect(remaining.tab.signal.aborted).toBe(true)
    expect(otherInfo.tab.signal.aborted).toBe(true)
    expect(h.runtime.ctx.get('sidebarRight')).toBeUndefined()
  })

  it('updates guide replacements through the same hook and lists guide boxes as rail icons', async () => {
    const h = await mountSeat()
    // The first expansion seeds the guide the replacement renders over.
    act(() => { h.controller.toggleExpanded() })
    let captured: SidebarRightTabInfo | undefined
    await act(async () => {
      h.runtime.ctx.sidebarRightTabs.register({
        id: 'test/plain', kind: 'plain', title: () => 'Plain',
      })
    })
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.guide', select: () => true },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.tab.guide'>) => {
          captured = useTabInfo()
          return <span data-guide-replacement={captured.tab.navigation.revision} />
        })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-guide]')).toBeNull()
    expect(captured?.tab.kind).toBe('guide')
    act(() => { h.controller.openTab('guide') })
    const stored = h.instance.getSnapshot()
    const guide = h.controller.active()!
    act(() => { h.controller.tabDomain.navigate(SESSION, guide.id, { address: guide.contentId, params: undefined }) })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(captured?.tab.navigation.revision).toBe(2)
    expect(element(h.view.container, '[data-guide-replacement]').dataset['guideReplacement']).toBe('2')
    expect(captured?.sidebar.expanded).toBe(true)
    // A guide-bearing type is a page the rail stands for: its icon appears and
    // the rail opens that page.
    await act(async () => {
      h.runtime.ctx.sidebarRightTabs.register({
        id: 'test/archive', kind: 'archive', title: () => 'Archive',
        guide: [{ id: 'archive', order: 1, title: () => 'Archive' }],
      })
    })
    expect(h.view.container.querySelector('[data-sidebar-right-rail-item="archive"]')).not.toBeNull()
  })

  it('follows type replacement and returns to the builtin when it leaves', async () => {
    const h = await mountSeat()
    h.open()
    let release = () => {}
    await act(async () => {
      release = h.runtime.ctx.sidebarRightTabs.register({ id: 'extension/text', kind: 'text', title: () => 'Extension' })
      h.runtime.slots.register({ name: 'sidebar.right.pane.tab', key: 'extension/text' },
        ({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) => <b data-extension>{useTabInfo().tab.title}</b>)
    })
    expect(element(h.view.container, '[data-extension]').textContent).toBe('a.txt')
    await act(async () => { release() })
    expect(h.view.container.querySelector('[data-extension]')).toBeNull()
    expect(h.view.container.querySelector('[data-tab-body]')).not.toBeNull()
  })

  it('renders unavailable kinds and keeps menu tab/dismiss arguments', async () => {
    const h = await mountSeat()
    let menu: SidebarRightTabMenuOwnerProps | undefined
    await act(async () => {
      h.runtime.slots.register({ name: 'sidebar.right.tab.menu.item', id: 'test' },
        (props: PropsRuntime<'sidebar.right.tab.menu.item'>) => { menu = props; return null })
      h.actions.openContent(SESSION, { kind: 'missing', contentId: 'missing://content', title: 'Missing' }, () => {})
    })
    expect(h.view.container.querySelector('[data-sidebar-right-unavailable]')).not.toBeNull()
    const chip = element(h.view.container, '[data-dockkit-tab]')
    fireEvent.contextMenu(chip)
    expect(menu?.tab.id).toBe(chip.getAttribute('data-dockkit-tab'))
    act(() => { menu?.dismiss() })
    expect(document.querySelector('[data-dockkit-tab-menu]')).toBeNull()
  })

  it('hides split controls at two panes and adds a guide only to a pane without one', async () => {
    const h = await mountSeat()
    // Expanding first seeds the left pane's guide; only the right pane will lack one.
    act(() => { h.controller.toggleExpanded() })
    h.open()
    const splitButtons = () => h.view.container.querySelectorAll<HTMLButtonElement>('[data-dockkit-split-button]')
    expect(splitButtons()).toHaveLength(1)
    act(() => { h.controller.split() })
    expect(dockPaneIds(h.layout())).toHaveLength(2)
    const stored = h.instance.getSnapshot()
    act(() => { expect(h.controller.split()).toBeUndefined() })
    expect(h.instance.getSnapshot()).toBe(stored)
    expect(splitButtons()).toHaveLength(0)
    const right = dockPaneIds(h.layout())[1]!
    h.open('right.txt', { paneId: right })
    const guide = getPane(h.layout(), right).tabs.find(id => h.layout().tabs[id]?.kind === 'guide')!
    act(() => { h.actions.closeTab(SESSION, guide) })
    const add = element(h.view.container, '[data-dockkit-add-tab]')
    expect(add.closest('[data-dockkit-pane]')?.getAttribute('data-dockkit-pane')).toBe(right)
    fireEvent.click(add)
    expect(getPane(h.layout(), right).tabs.filter(id => h.layout().tabs[id]?.kind === 'guide')).toHaveLength(1)
    const closing = [...getPane(h.layout(), right).tabs]
    act(() => { for (const tabId of closing) h.actions.closeTab(SESSION, tabId) })
    expect(dockPaneIds(h.layout())).toHaveLength(1)
    expect(splitButtons()).toHaveLength(1)
    expect(splitButtons()[0]?.disabled).toBe(false)
  })
})

describe('intentsFor — the kit\'s gestures as one session\'s store actions', () => {
  it('binds every intent to the session, and asks the navigation face for a guide on add', () => {
    const actions = {
      focusTab: vi.fn(), focusPane: vi.fn(), splitPane: vi.fn(), closeTab: vi.fn(), duplicateTab: vi.fn(),
      floatTab: vi.fn(), unfloatPane: vi.fn(), placeTab: vi.fn(), dropTab: vi.fn(), moveFloat: vi.fn(),
      resizeFloat: vi.fn(), resizeSplit: vi.fn(),
    }
    const openTab = vi.fn()
    const intents = intentsFor(SESSION, actions as unknown as Parameters<typeof intentsFor>[1], openTab)
    const rect = { x: 1, y: 2, width: 300, height: 200 }
    const TAB_1 = 'tab-1' as TabId
    const PANE_1 = 'pane-1' as PaneId
    const PANE_2 = 'pane-2' as PaneId
    const SPLIT_1 = 'split-1' as SplitId
    intents.focusTab(TAB_1)
    intents.focusPane(PANE_1)
    intents.splitPane(PANE_1)
    intents.closeTab(TAB_1)
    intents.duplicateTab(TAB_1)
    intents.floatTab(TAB_1, rect)
    intents.unfloatPane(PANE_2)
    intents.placeTab(TAB_1, PANE_1, 0)
    intents.dropTab(TAB_1, PANE_1, 'right')
    intents.moveFloat(PANE_2, 30, 40)
    intents.resizeFloat(PANE_2, rect)
    intents.resizeSplit(SPLIT_1, [0.3, 0.7])
    expect(actions.focusTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.focusPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.splitPane).toHaveBeenCalledWith(SESSION, PANE_1)
    expect(actions.closeTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.duplicateTab).toHaveBeenCalledWith(SESSION, TAB_1)
    expect(actions.floatTab).toHaveBeenCalledWith(SESSION, TAB_1, rect)
    expect(actions.unfloatPane).toHaveBeenCalledWith(SESSION, PANE_2)
    expect(actions.placeTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 0)
    expect(actions.dropTab).toHaveBeenCalledWith(SESSION, TAB_1, PANE_1, 'right')
    expect(actions.moveFloat).toHaveBeenCalledWith(SESSION, PANE_2, 30, 40)
    expect(actions.resizeFloat).toHaveBeenCalledWith(SESSION, PANE_2, rect)
    expect(actions.resizeSplit).toHaveBeenCalledWith(SESSION, SPLIT_1, [0.3, 0.7])
    // The add control is the guide opened by kind, in that pane, beside any guide elsewhere.
    intents.addTab(PANE_1)
    expect(openTab).toHaveBeenCalledWith('guide', { paneId: PANE_1, revealIfOpened: false })
  })
})

it('keeps a resource tab and reports a synchronous cleanup failure from its close button', async () => {
  const h = await mountSeat()
  const tab = h.open('terminal')
  const failure = new Error('process still running')
  const release = h.controller.registerCloseHandler('text', () => { throw failure })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    await expect.poll(() => logged.mock.calls).toEqual([['Sidebar tab close failed:', failure]])
    expect(h.layout().tabs[tab.id]).toBeDefined()
    release()
    fireEvent.click(element(h.view.container, `[data-dockkit-tab-close="${tab.id}"]`))
    expect(h.layout().tabs[tab.id]).toBeUndefined()
  } finally {
    logged.mockRestore()
    release()
  }
})

describe('RightbarSeat on the mobile container', () => {
  it('drops the icon rail and fills the viewport without recording a manual mode', async () => {
    const h = await mountSeat(390, true, 1, true)
    h.open()
    expect(h.view.container.querySelector('[data-sidebar-right-rail]')).toBeNull()
    const panel = element(h.view.container, '[data-sidebar-right-panel]')
    expect(panel.dataset['sidebarRightPanel']).toBe('fullscreen')
    expect(panel.style.width).toBe('100%')
    expect(h.layout().mode).toBe('push')
    expect(h.frame.openRightbar).toHaveBeenLastCalledWith(false, true)
  })

  it('pushes an opened document full-screen and returns to the tree through the file back control', async () => {
    const h = await mountSeat(390, true, 1, true)
    // The seeded page stands in for the file tree the push drills out of.
    expect(element(h.view.container, '[data-sidebar-right-body]')).toBeTruthy()
    h.open('a.txt')
    const editorTabId = h.instance.getSnapshot().bySession[SESSION]?.editorTabId
    expect(editorTabId).toBeDefined()
    const push = element(h.view.container, '[data-sidebar-right-file-push]')
    expect(push.querySelector('[data-sidebar-right-file-back]')).toBeTruthy()
    expect(element(h.view.container, '[data-sidebar-right-file-body] [data-tab-body]').dataset['tabBody']).toBe(editorTabId)
    expect(h.view.container.querySelector('[data-sidebar-right-body]')).toBeNull()
    fireEvent.click(element(h.view.container, '[data-sidebar-right-file-back]'))
    expect(h.instance.getSnapshot().bySession[SESSION]?.editorTabId).toBeUndefined()
    expect(h.view.container.querySelector('[data-sidebar-right-file-push]')).toBeNull()
    expect(element(h.view.container, '[data-sidebar-right-body]')).toBeTruthy()
    // The document tab itself stays open: reopening from the tree reveals it again.
    expect(h.layout().tabs[editorTabId!]).toBeDefined()
  })

  it('keeps the editor pane split beside the tree on a narrow desktop frame, never a push', async () => {
    // 420px is a desktop device by pointer and the column is fullscreen, but
    // the pane still splits beside the tree: the push is the mobile container's
    // presentation only.
    const h = await mountSeat(420, true, 1)
    expect(h.view.container.querySelector('[data-sidebar-right-rail]')).not.toBeNull()
    h.open('a.txt')
    const editorTabId = h.instance.getSnapshot().bySession[SESSION]?.editorTabId
    expect(editorTabId).toBeDefined()
    expect(h.view.container.querySelector('[data-sidebar-right-file-push]')).toBeNull()
    expect(element(h.view.container, '[data-sidebar-right-editor] [data-tab-body]').dataset['tabBody']).toBe(editorTabId)
    expect(element(h.view.container, '[data-sidebar-right-body]')).toBeTruthy()
    const files = Object.values(h.layout().tabs).find(tab => tab.kind === 'files')!
    expect(getPane(h.layout(), h.layout().activePaneId).activeTabId).toBe(files.id)
  })

  it('keeps the merged tree and pane on a desktop seat', async () => {
    const h = await mountSeat(1440, true, 1)
    expect(h.view.container.querySelector('[data-sidebar-right-rail]')).not.toBeNull()
    h.open('a.txt')
    const editorTabId = h.instance.getSnapshot().bySession[SESSION]?.editorTabId
    expect(editorTabId).toBeDefined()
    expect(h.view.container.querySelector('[data-sidebar-right-file-push]')).toBeNull()
    expect(h.view.container.querySelector(`[data-sidebar-right-editor] [data-tab-body="${editorTabId}"]`)).not.toBeNull()
  })
})
