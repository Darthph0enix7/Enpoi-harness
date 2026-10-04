/**
 * The sidebar shell: panels mounted inside the unified panel host — a
 * fixed, viewport-sized containing block ([data-dsh-panel-host]) appended
 * to document.body — instead of individual fixed-position elements, so a
 * desktop shell's intermediate wrapper transforms can never hijack the
 * panels' fixed containing block (the core AppFrame owns the left sidebar /
 * center / details columns and has no right-side hole for plugins). The
 * right panel hosts the original workbench; the bottom panel hosts a
 * second, independent workbench. The bottom panel squeezes ONLY the center
 * column (the agent output area): it spans from the app shell's own left
 * sidebar to the right panel's left edge, so neither sidebar gives up any
 * position (the right panel keeps its full height). A persistent two-button
 * cluster at the top-right corner toggles each panel; the right panel's
 * width drags from its left edge, the bottom panel's height from its top
 * edge, and the shared corner drags both at once. The whole layout lives in
 * the per-session store, so switching conversations swaps the sidebar.
 *
 * The shell binds the workbench actions to the store and dispatches tab
 * content to the views. New tabs come from the + menu (explorer / git /
 * terminal; editors open from the explorer). Tabs live in one tree only —
 * they never cross panels; only the panel sizes drag against each other.
 *
 * Narrow (mobile, <768px) viewports show ONLY the right sidebar: entering
 * narrow migrates the bottom panel's tabs INTO the right tree
 * (migrateBottomTabs) — one workbench, the bottom tabs thrown into its
 * strips. The right panel becomes a full-width drawer, the bottom panel
 * and its toggle button disappear, and the layout push is disabled (the
 * drawer floats). Widening does not migrate back: the tabs keep living in
 * the right tree.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconBranchOutline16, IconCloseFill14, IconFolderOpen16, IconThinkOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context, SidebarSessionList } from '../context-types.ts'
import { appendToDraft } from './conversation-draft.ts'
import {
  activateTab as activateTabReducer, allLeaves, BOTTOM_MIN, PANEL_MIN, agentUuidOf, defaultWidthFor, firstLeaf, isAgentTabId, leafWithTab, mapLeaf, migrateBottomTabs, moveTab, moveTabToEdge, openDiffTab,
  reconcileAgentTerminals,
  resizeSplitIn, setBottomHeight, setWidth, toggleBottomPanel, toggleExpanded, togglePanel, treeOf,
  type DropZone, type SidebarState, type SidebarStore, type SidebarTab, type SplitNode,
} from './state.ts'
import { IconGlobeOutline16, IconPanelBottomOutline16, IconPanelRightOutline16, IconTerminalOutline16 } from './icons.tsx'
import { Workbench, type WorkbenchActions } from './split-pane.tsx'
import { useNarrowViewport } from './breakpoints.ts'
import { parseDesktopEnv } from './desktop-env.ts'
import type { NewTabOption } from './TabBar.tsx'
import type { TabDragPayload } from './TabBar.tsx'
import { relativeTo } from './paths.ts'
import { OrphanedTab } from './OrphanedTab.tsx'
import { RenderBoundary } from './RenderBoundary.tsx'
import { detectNewDirectSubagent } from './subagent-detect.ts'
import { detectNewJob } from './subagent-jobs.ts'
import { t } from './locales.ts'
import { api, type SessionScope } from './api.ts'
import { openSidebarFile } from './intercept.tsx'
import css from './sidebar.module.css'

/** Width of the vertical activity rail the right panel floats next to. */
const ACTIVITY_RAIL = 44

/** How many consecutive reconnect failures stop the agent-terminals push loop
 * (mirror of the terminal view's own cap; the loop restarts on session switch). */
const FAILURE_LIMIT = 3

/** Render the content of one tab (dispatched by type). */
function TabContent(props: {
  tab: SidebarTab
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string) => void
  ctx: Context
  store: SidebarStore
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean
  /** Fired before a topology node jumps to its child session (see Sidebar). */
  onSubagentJump: (childSessionId: string) => void
  /** Open a diff tab from the git panel (placement handled by the store). */
  onOpenDiff: (tab: SidebarTab) => void
  /** Bump to refresh the file tree after fs operations. */
  fsChangedTick: number
  /** Called after any successful fs operation (bumps the tree refresh). */
  onFsChanged: () => void
}) {
  const { tab, sessionId, cwd, expanded, onToggleDir, onReferenceFile, ctx, store, visible, onSubagentJump, onOpenDiff, fsChangedTick, onFsChanged } = props
  const scope = { sessionId, cwd }
  const descriptor = ctx.betterSidebar?.getTab(tab.type)
  if (descriptor === undefined) {
    return <OrphanedTab ctx={ctx} store={store} scope={scope} tab={tab} visible={visible} />
  }
  // File-system operations (enpoi-fs-ops plugin): rename / delete / create.
  const onFsOp = {
    rename: async (from: string, to: string): Promise<void> => { await api.fsRename(scope, from, to) },
    delete: async (path: string, isDir: boolean): Promise<void> => { await api.fsDelete(scope, path) },
    create: async (parent: string, name: string, isDir: boolean): Promise<void> => {
      if (isDir) await api.fsMkdir(scope, parent, name)
      else await api.fsCreate(scope, parent, name)
    },
  }
  // One boundary per tab: a render crash in a viewer/editor shows a strip in
  // THIS tab's pane only — the toggle cluster, the other tabs, and the panel
  // stay alive (issue #31). The tab strip (close button) lives outside, so a
  // crashing tab stays closable; the root boundary in index.tsx remains the
  // last resort for errors in the sidebar shell itself. The descriptor is
  // rendered as a REAL element (not called directly): a direct call would
  // throw inside TabContent's own render, which the boundary cannot catch —
  // as a child fiber, every render error (top-level or deep) lands in it.
  return createElement(
    RenderBoundary,
    { className: css.tabBoundaryError },
    createElement(descriptor.component, {
      ctx, store, scope, tab, visible, expanded,
      onToggleDir, onReferenceFile, onOpenDiff, onSubagentJump,
      onFsOp, onFsChanged, fsChangedTick,
    }),
  )
}

/** The + menu options for the current state, driven by the tab registry.
 * Hidden tabs (editor/diff) never show; `available` returning false shows
 * a disabled row (e.g. terminal at capacity) instead of hiding the option.
 * Tabs the user disabled in the side card settings are filtered out
 * entirely — re-enabling them is the settings page's job. */
function buildNewTabOptions(state: SidebarState, ctx: Context, scope: SessionScope): NewTabOption[] {
  const service = ctx.betterSidebar
  if (service === undefined) return []
  return service.getTabs()
    .filter(d => !d.hidden && service.isTabEnabled(d.id))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    .map(d => ({
      id: d.id,
      label: typeof d.title === 'function' ? d.title() : d.title,
      disabled: !(d.available?.(ctx, scope, state) ?? true),
      icon: typeof d.icon === 'function' ? d.icon(16) : d.icon,
    }))
}

export function Sidebar(props: { ctx: Context; store: SidebarStore }) {
  const { ctx, store } = props

  // Copy freshness: re-render the whole tree when the DSH locale switches.
  // The module-level t() reads the active locale at call time, so a root
  // re-render alone re-localizes every panel (no memo barriers below).
  const localeRevision = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.locale.subscribe(callback), [ctx]),
    useCallback(() => ctx.locale.getSnapshot().active, [ctx]),
  )
  void localeRevision

  // Narrow (mobile) viewports collapse the two panels into one: the right
  // panel becomes a full-width drawer holding BOTH workbenches, the bottom
  // panel (and its toggle button) disappears, and the layout push is
  // disabled (the drawer floats over the app shell). Entering narrow
  // MIGRATES the bottom tree's tabs into the right tree (migrateBottomTabs)
  // — the merged display is the right sidebar alone, the bottom tabs thrown
  // into its strips. Widening never rewrites the migrated state: the tabs
  // keep living in the right tree.
  const narrow = useNarrowViewport()

  // On-screen keyboard / visual-viewport inset (mobile, split-screen, …):
  // when the visual viewport shrinks below the layout viewport, bottom-
  // anchored panels would hide under the keyboard. Track the inset and
  // offset the bottom-anchored surfaces by it. The obscured bottom strip is
  // innerHeight − (vv.height + vv.offsetTop): offsetTop is nonzero while
  // the visual viewport is scrolled/zoomed under browser chrome, so
  // omitting it would over-lift the panels (CR #232 P2). offsetTop changes
  // through the viewport's scroll event too, so both events are listened.
  // Guarded: browsers without visualViewport (older WebViews, jsdom) stay
  // at 0. rAF-throttled, same pattern as useNarrowViewport.
  const [keyboardInset, setKeyboardInset] = useState(0)
  /** Bumped after any fs operation so the file tree refreshes. */
  const [fsChangedTick, setFsChangedTick] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const inset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      setKeyboardInset(inset > 1 ? Math.round(inset) : 0)
    }
    const onResize = (): void => { if (frame === null) frame = requestAnimationFrame(measure) }
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    measure()
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])

  // Current conversation (the sessions list feed).
  const sessionList = useSyncExternalStore(
    useMemo(() => (callback: () => void) => ctx.sessions.list.subscribe(callback), [ctx]),
    useCallback(() => ctx.sessions.list.getSnapshot(), [ctx]),
  )
  const current = sessionList.current

  // Per-session sidebar state.
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  useEffect(() => { store.setSession(current) }, [current, store])

  const state = snapshot.state
  const sessionId = snapshot.sessionId
  const summaryCwd = sessionId === undefined ? undefined : sessionList.byId[sessionId]?.cwd

  // Revert WAL events (enpoi-file-revert): disk may have changed without an fsOp call.
  // Bump fsChangedTick so EditorHost auto-reloads and TreePanel refreshes.
  useEffect(() => {
    if (sessionId === undefined) return
    const on = (ctx as unknown as { on?: (event: string, handler: (session: unknown, ev: unknown) => void) => () => void }).on
    if (typeof on !== 'function') return
    const off = on.call(ctx, 'session/event', (session: unknown, ev: unknown) => {
      const sid = (session as { id?: string })?.id
      if (sid !== undefined && sid !== sessionId) return
      const type = (ev as { type?: string })?.type ?? ''
      if (type.startsWith('revert/')) {
        setFsChangedTick(tick => tick + 1)
      }
    })
    return () => { try { (off as unknown as () => void)?.() } catch {} }
  }, [ctx, sessionId])

  // In-harness file open from chat/file mentions: when headless server has no
  // native opener, chat dispatches 'dsh-open-file' — open in the Files editor
  // even if the panel is collapsed or another tab is active.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ path?: string; sessionId?: string }>).detail
      if (!detail?.path) return
      const targetSession = detail.sessionId ?? sessionId
      if (targetSession === undefined) return
      store.reduce(s => s.panelOpen ? s : togglePanel(s))
      ctx.betterSidebar?.openTab({ type: 'editor', title: t('files') || 'Files' })
      try { openSidebarFile(ctx, store, targetSession, detail.path) } catch {}
    }
    window.addEventListener('dsh-open-file', handler as EventListener)
    return () => { window.removeEventListener('dsh-open-file', handler as EventListener) }
  }, [ctx, store, sessionId])

  // The collapsed toggle cluster reclaims the top-right corner, so the DSH
  // session header's right-aligned utilities (the "Session log" download
  // capsule) must yield. layout.css keys off this body attribute to push the
  // header's right padding out past the cluster. Only the CLOSED panel needs
  // it — an open panel already squeezes `#root` left, moving the header clear.
  const collapsed = state === undefined || !state.panelOpen
  useEffect(() => {
    if (collapsed) document.body.setAttribute('data-dsh-sidebar-collapsed', '')
    else document.body.removeAttribute('data-dsh-sidebar-collapsed')
    return () => { document.body.removeAttribute('data-dsh-sidebar-collapsed') }
  }, [collapsed])

  // Position compatibility mode (titleBarCompat pref): Windows frameless
  // windows draw the native title bar (minimize/maximize/close) at the
  // window's top-right corner, OVER the web content. When enabled, the body
  // attribute lets sidebar.module.css drop the toggle cluster below the
  // strip and push the right panel's content below it. Auto-enabled in the
  // win32 advanced desktop shell (the shell stamps the URL — see
  // desktop-env.ts — and reserves a 32px overlay for the window controls);
  // the manual pref and its strip height still win when the user sets them,
  // and the manual switch only ever ADDS compat. The strip height rides a
  // CSS variable so the rules stay declarative; the attribute rides the
  // snapshot's prefs, so flipping the setting re-renders and re-applies
  // immediately; the cleanup removes both on unmount/boundary swap so a
  // crashed sidebar never leaves them behind.
  const desktopEnv = parseDesktopEnv()
  const autoTitleBarCompat = desktopEnv.win32OverlayTop > 0
  const titleBarCompat = snapshot.prefs.titleBarCompat || autoTitleBarCompat
  const titleBarStrip = snapshot.prefs.titleBarCompat
    ? snapshot.prefs.titleBarStripPx
    : desktopEnv.win32OverlayTop
  useEffect(() => {
    const root = document.documentElement
    if (titleBarCompat) {
      document.body.setAttribute('data-dsh-title-bar-compat', '')
      root.style.setProperty('--dsh-title-bar-strip', `${titleBarStrip}px`)
    } else {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
    return () => {
      document.body.removeAttribute('data-dsh-title-bar-compat')
      root.style.removeProperty('--dsh-title-bar-strip')
    }
  }, [titleBarCompat, titleBarStrip])

  /**
   * Bottom-panel merge on narrow viewports: whenever a session is current
   * while narrow (mount, session switch, or a desktop→narrow transition),
   * throw the bottom tree's tabs into the right tree. Idempotent — after
   * the first migration the bottom tree is empty and the reducer returns
   * the same reference, so this effect settles immediately.
   */
  useEffect(() => {
    if (!narrow || sessionId === undefined) return
    store.reduce(migrateBottomTabs)
  }, [narrow, sessionId, store])

  // While the session's header is still hydrating (or the session is blank),
  // the list summary may carry no cwd; ask the host once (it falls back to
  // the process cwd) so the explorer root and terminal cwd are real from
  // first paint instead of showing "no session".
  const [fetchedCwd, setFetchedCwd] = useState<string | undefined>(undefined)
  useEffect(() => {
    setFetchedCwd(undefined)
    if (sessionId === undefined || summaryCwd !== undefined) return
    let cancelled = false
    api.sessionCwd({ sessionId })
      .then(result => { if (!cancelled) setFetchedCwd(result.cwd) })
      .catch(() => { /* the explorer/git rows surface their own errors */ })
    return () => { cancelled = true }
  }, [sessionId, summaryCwd])
  const cwd = summaryCwd ?? fetchedCwd

  /**
   * Agent terminals push: subscribe to the host's live list of agent-owned
   * terminals for this session (created by the model through the
   * `terminal_create` tool). The host pushes a JSON array on every
   * create / close / exit; the sidebar reconciles the list into tabs
   * (id `agent:<uuid>`, title from the agent). A disconnected socket
   * retries with a short backoff so a refresh or transient drop reattaches
   * the same shell without losing the agent's work — capped like the
   * terminal view's own reconnect loop, so a refused endpoint never spins
   * forever (the next session switch restarts the loop).
   * While the terminal tab type is disabled in settings, pushes are
   * ignored (no auto-added tabs); re-enabling makes the next push converge.
   */
  useEffect(() => {
    if (sessionId === undefined) return
    let socket: WebSocket | null = null
    let retry: number | undefined
    let closed = false
    let failures = 0
    const connect = (): void => {
      if (closed) return
      const url = new URL('/sidebar/ws/agent-terminals', location.origin)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = new URLSearchParams({ sessionId }).toString()
      socket = new WebSocket(url.toString())
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        try {
          const list = JSON.parse(event.data) as Array<{ uuid: string; title: string; command: string; exited: boolean }>
          if (!Array.isArray(list)) return
          store.reduce(s => ctx.betterSidebar?.isTabEnabled('terminal') === false
            ? s
            : reconcileAgentTerminals(s, list))
        } catch {
          // Malformed push: ignore (the next push will reconcile).
        }
      }
      socket.onclose = () => {
        if (closed) return
        failures += 1
        if (failures >= FAILURE_LIMIT) {
          console.error('[dsh-better-sidebar] agent-terminals connection failed; stopping reconnect loop', sessionId)
          return
        }
        retry = window.setTimeout(connect, 2000)
      }
      socket.onerror = () => { socket?.close() }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [sessionId, store])

  /**
   * Subagent auto-activation: the moment the current conversation spawns its
   * FIRST direct subagent (a 0 → N transition on the list feed), the "auto
   * open" pref is on, and the Subagent tab type is enabled in settings,
   * open the panel (if collapsed) and focus the Subagent page
   * (single-instance: an existing tab is focused, never duplicated).
   * Switching to a session that already has subagents never triggers — its
   * baseline starts at the current count — so a deliberate layout is never
   * fought.
   */
  const listBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    const prev = listBaselineRef.current
    listBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewDirectSubagent(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenSubagent) return
    if (ctx.betterSidebar?.isTabEnabled('subagent') === false) return
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    // Pin the landing to the right panel: the auto-opened Subagent page must
    // appear where the panel just expanded, not in a bottom-panel pane the
    // user last touched.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Job auto-activation: the moment a NEW background job appears for the
   * current conversation (a job id the previous snapshot lacked), the
   * auto-open pref is on, and the Jobs tab type is enabled, open the panel
   * (if collapsed) and focus the Jobs page. Unlike the subagent trigger
   * (0 → N only), ANY new job id triggers: the agent may start several
   * jobs in one session, and each should surface. A fresh page load never
   * triggers — its baseline starts at the current snapshot.
   */
  const jobBaselineRef = useRef<SidebarSessionList | undefined>(undefined)
  useEffect(() => {
    const prev = jobBaselineRef.current
    jobBaselineRef.current = sessionList
    if (sessionId === undefined || prev === undefined) return
    if (!detectNewJob(prev, sessionList, sessionId)) return
    if (!store.getPrefs().autoOpenJobs) return
    if (ctx.betterSidebar?.isTabEnabled('subagent') === false) return
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionList, sessionId, store, ctx])

  /**
   * Topology jump-back: clicking a subagent node on the Subagent page calls
   * the official `openSubagent`, which switches the sidebar to that child
   * session's OWN layout (a fresh child session defaults to the explorer).
   * The README contract says the Subagent page must stay open with the jumped
   * node highlighted — so once the current session becomes the recorded jump
   * target, re-open the Subagent page on top of the child's layout (expanding
   * the panel first if it is collapsed). Only this explicit node click arms
   * the flag, so switching to a subagent session by any other means keeps
   * that session's own layout untouched.
   */
  const subagentJumpRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const pending = subagentJumpRef.current
    if (pending === undefined || sessionId !== pending) return
    subagentJumpRef.current = undefined
    store.reduce(s => s.panelOpen ? s : togglePanel(s))
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
    ctx.betterSidebar?.openTab({ type: 'subagent', title: t('subagent') })
  }, [sessionId, store, ctx])

  // The app shell's center column: the bottom panel spans ONLY that column
  // ("squeezes the agent output area") — it starts at the app sidebar's
  // right edge and ends at the details column's left edge (the details
  // column sits between the center and the right panel). Measured directly
  // from the AppFrame's center column DOM (the parent of the
  // [data-slot="conversation"] wrapper — layout.css's center column) so the
  // bottom panel tracks the column's real
  // horizontal edges — including the animated margin-right push while the
  // right panel opens/closes; a frame that never appears keeps the initial
  // zero-size fallback (the panel renders at 0 width until measured).
  const [centerRect, setCenterRect] = useState({ left: 0, right: 0 })
  // Refs keep the measure step stable across renders and let it skip work
  // mid-drag: during a width/corner drag the layout push resizes the center
  // column every frame, and reacting (setCenterRect → re-render) would
  // re-introduce the drag lag this shell deliberately avoids. applyDrag
  // writes the bottom panel's edges directly, so measurement pauses then.
  const centerColRef = useRef<HTMLElement | null>(null)
  const draggingRef = useRef(false)
  const measureCenter = useCallback((): void => {
    if (draggingRef.current) return
    const col = centerColRef.current
    if (col === null) return
    const rect = col.getBoundingClientRect()
    // The bottom panel only cares about the horizontal edges: a pure height
    // change (the bottom panel itself opening/closing) must not re-render,
    // so keep the previous object when left/right are unchanged.
    setCenterRect(prev =>
      prev.left === rect.left && prev.right === rect.right
        ? prev
        : { left: rect.left, right: rect.right })
  }, [])
  useEffect(() => {
    let disposed = false
    let observer: ResizeObserver | undefined
    // Locate the AppFrame's center column. DSH 0.1.x wraps slot hosts in
    // [data-slot] containers: the conversation slot wrapper
    // ([data-slot="conversation"]) sits directly inside the center column,
    // so its parent IS that column — no hashed-class or positional
    // dependency (layout.css uses the same anchor). The shell swaps the
    // boot page for the AppFrame only AFTER boot settles, so the first
    // query may miss it. Never give up: watch #root's children (the swap
    // mutates them) and re-run this locator — querying once and bailing
    // would strand the panel at the zero-size fallback forever (observed:
    // a 1px sliver at the viewport's left edge).
    const locate = (): void => {
      if (disposed) return
      const col = document.querySelector('#root [data-slot="conversation"]')
        ?.parentElement as HTMLElement | undefined
      if (col === undefined) {
        if (centerColRef.current !== null) {
          centerColRef.current = null
          observer?.disconnect()
          observer = undefined
        }
        return
      }
      if (centerColRef.current !== col) {
        centerColRef.current = col
        observer?.disconnect()
        observer = new ResizeObserver(measureCenter)
        observer.observe(col)
      }
      measureCenter()
    }
    locate()
    const watcher = new MutationObserver(locate)
    const root = document.getElementById('root')
    if (root !== null) watcher.observe(root, { childList: true })
    // The layout push writes --dsh-sidebar-* on <html>. A HMR re-activation
    // clears those variables on teardown and re-writes them on setup — and
    // that is also the moment the shell may have re-created the center
    // column under a REUSED #root child (React swaps nodes in place, so
    // #root's childList never changes and the watcher above never fires).
    // Watching <html>'s style attribute catches that re-sync: the push
    // rewrite re-locates and re-measures, so the bottom panel recovers
    // instead of staying hidden on a stale {0,0} center rect.
    const htmlStyleWatcher = new MutationObserver(locate)
    htmlStyleWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    return () => {
      disposed = true
      observer?.disconnect()
      watcher.disconnect()
      htmlStyleWatcher.disconnect()
      centerColRef.current = null
    }
    // Opening the bottom panel re-runs the whole locate/measure chain: a
    // panel opened before the center column was ever found must not stay
    // invisible forever (the HMR recovery path depends on the observers
    // above, this is the belt-and-braces retry for the open moment itself).
  }, [measureCenter, state?.bottomOpen])

  /**
   * Bottom-panel first-expansion auto terminal: the FIRST time the user
   * expands the bottom panel in a session, try to open a fresh terminal tab
   * there. "Try" is literal — the terminal's own quota and enable switch
   * gate the attempt (a full quota or a disabled terminal type makes it a
   * no-op). Gated on the bottomPanelAutoTerminal pref (the terminal tab's
   * nested settings toggle, default on). Only a false→true TRANSITION fires
   * (a panel persisted open never counts as an expansion), and the session's
   * bottomOpenedOnce flag is set atomically with the first fire so later
   * expansions never repeat it.
   */
  const bottomWasOpenRef = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    // The bottom panel does not exist on narrow viewports (the two
    // workbenches merge into one panel), so the first-expansion auto
    // terminal is a desktop-only behavior.
    if (narrow) return
    if (state === undefined) return
    const wasOpen = bottomWasOpenRef.current
    bottomWasOpenRef.current = state.bottomOpen
    if (wasOpen === undefined || wasOpen || !state.bottomOpen) return
    if (state.bottomOpenedOnce) return
    if (store.getPrefs().bottomPanelAutoTerminal === false) return
    if (ctx.betterSidebar?.isTabEnabled('terminal') === false) return
    // Land the tab in the bottom panel's first pane; the once-flag is set
    // atomically so later expansions never repeat the auto-open.
    store.reduce(s => ({ ...s, activePane: firstLeaf(s.bottomSplits).id, bottomOpenedOnce: true }))
    ctx.betterSidebar?.openTab({ type: 'terminal' })
  }, [state, store, ctx, narrow])

  // Panel drags: the right panel's width (left edge strip), the bottom
  // panel's height (top edge strip), and the shared corner (both at once).
  // Drags write the sizes DIRECTLY to the DOM (panel styles + the layout CSS
  // variables) instead of round-tripping the store on every pointer move —
  // a store reduce re-renders both workbenches (terminals, editors…) per
  // move, which is the visible drag lag. The store is committed once on
  // pointer up (clamping + persistence).
  const panelRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const widthDrag = useRef({ startX: 0, startWidth: 0 })
  const [draggingWidth, setDraggingWidth] = useState(false)
  const bottomDrag = useRef({ startY: 0, startHeight: 0 })
  const [draggingBottom, setDraggingBottom] = useState(false)
  const cornerDrag = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 })
  const [draggingCorner, setDraggingCorner] = useState(false)
  const anyDragging = draggingWidth || draggingBottom || draggingCorner
  // Last geometry actually written to the DOM by applyDrag — the source of
  // truth when a drag's pointer stream dies (see abortDrag): committing this
  // freezes exactly what the user saw, instead of rolling back to the
  // pre-drag store sizes.
  const lastAppliedRef = useRef<{ width: number; height: number } | null>(null)

  // Pause center-column measurement while dragging, and re-measure once the
  // drag settles at its committed size. The store commit lands on release and
  // the final width equals the last drag width, so no ResizeObserver event
  // fires to refresh centerRect — this explicit re-measure covers that gap.
  useEffect(() => {
    draggingRef.current = anyDragging
    if (!anyDragging) measureCenter()
  }, [anyDragging, measureCenter])

  // Clamp mirrors of setWidth/setBottomHeight for mid-drag values (the store
  // re-clamps on commit; these keep the panels from overshooting mid-drag).
  const clampWidth = (width: number): number =>
    Math.min(Math.max(PANEL_MIN, Math.round(width)), Math.max(PANEL_MIN, window.innerWidth))
  const clampHeight = (height: number): number =>
    Math.min(Math.max(BOTTOM_MIN, Math.round(height)), Math.max(BOTTOM_MIN, window.innerHeight - PANEL_MIN))

  /** Single writer for the layout-push variables: the app shell gives up
   *  the panel's width/height while open (0 while collapsed) through
   *  layout.css's margins. Every size change — drag frames and committed
   *  state — flows through here so the push never forks between paths. */
  const writeGeometry = (width: number, height: number): void => {
    // The right panel floats ACTIVITY_RAIL px in from the viewport edge
    // (the activity rail owns that strip), so the shell must give up
    // panelWidth + rail — otherwise #root keeps a rail-width sliver of chat
    // under the panel's left edge and paints the "dark line" mismatch.
    // When collapsed (width === 0), the shell still reserves ACTIVITY_RAIL
    // so the slim vertical bar never covers content underneath.
    const push = width > 0 ? width + ACTIVITY_RAIL : ACTIVITY_RAIL
    document.documentElement.style.setProperty('--dsh-sidebar-width', `${push}px`)
    document.documentElement.style.setProperty('--dsh-sidebar-height', `${height}px`)
    // The corner handle positions itself relative to the panel (CSS
    // `bottom: calc(var(--dsh-sidebar-height) + 6px)`), so these two layout
    // variables are all it needs — no viewport coordinates written here
    // (issue #106: skins that inset the panels must not fight JS coords).
  }

  /** Apply a drag size to the DOM without touching React state or the store.
   *  The bottom panel's right edge tracks the right panel's left edge HERE
   *  too — React state only updates on release, so the inline right must be
   *  written directly or the bottom panel would lag the sidebar mid-drag.
   *  The layout push rides the shared writer (writeGeometry). */
  const applyDrag = (width: number, height: number): void => {
    lastAppliedRef.current = { width, height }
    panelRef.current?.style.setProperty('width', `${width}px`)
    bottomRef.current?.style.setProperty('height', `${height}px`)
    // centerRect.right is the center column's right edge at the committed
    // width (innerWidth - state.width - detailsWidth), so this equals
    // `width + detailsWidth` — derived from the measured column, keeping the
    // drag write-only (no React re-render mid-drag).
    bottomRef.current?.style.setProperty('right', `${(window.innerWidth - centerRect.right) + (width - (state?.width ?? 0))}px`)
    writeGeometry(width, height)
  }

  // Drags write at most once per frame: pointer events fire several times
  // faster than the display refresh, and each write reflows the app shell
  // (the layout push) plus the panels — batching to one write per frame is
  // what keeps the drag smooth. The store is still committed once on release.
  const dragFrame = useRef<number | null>(null)
  const pendingDrag = useRef<{ width: number; height: number } | null>(null)
  const scheduleDrag = (width: number, height: number): void => {
    pendingDrag.current = { width, height }
    if (dragFrame.current !== null) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null
      const pending = pendingDrag.current
      if (pending !== null) {
        pendingDrag.current = null
        applyDrag(pending.width, pending.height)
      }
    })
  }

  /** Flush any pending drag write and stop scheduling (the store commit on
   *  pointer up applies the final clamped values). */
  const stopDragScheduling = (): void => {
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = null
    }
    pendingDrag.current = null
  }

  /**
   * Finalize a drag on pointer up: flush the LAST drag frame to the DOM
   * synchronously, then commit the SAME clamped values to the store. A fast
   * release cancels the rAF before it ran — without the flush the DOM would
   * sit at the pre-drag size until React re-renders with the committed
   * value, and a value that never made it into a move handler would never
   * be applied at all. The measurement pause ends here too: the center
   * column is re-measured BEFORE the committed re-render lands, so the
   * bottom panel's React-rendered right edge already reflects the new
   * width (otherwise the re-render would re-apply the stale rect — the
   * bottom panel visibly jumps for one frame).
   */
  const commitDrag = (
    width: number,
    height: number,
    reduce: (state: SidebarState) => SidebarState,
  ): void => {
    stopDragScheduling()
    applyDrag(width, height)
    draggingRef.current = false
    measureCenter()
    store.reduce(reduce)
  }

  /** Set once a drag's pointerup handler commits — premature capture loss
   *  (pointercancel / lostpointercapture without pointerup) must then be told
   *  apart from a normal release. */
  const dragCommitted = useRef(false)
  /**
   * Abort a drag whose pointer stream was interrupted (pointercancel, or
   * capture lost before pointerup): no pointerup will arrive, so without
   * this the dragging state would stick true and center-column measurement
   * would stay paused forever — the bottom panel freezes at stale edges and
   * stops tracking sidebar/app-rail layout changes.
   *
   * A FAST release is the common trigger: browsers merge pointermove bursts,
   * and an ultra-fast flick can cancel the stream before ANY move lands.
   * The commit order is therefore: the LAST KNOWN dragged size (the rAF
   * pending value) first, then the interrupting event's own pointer
   * position (pointercancel / lostpointercapture still carry coordinates),
   * and only a drag that produced neither (pure down+up at the same spot)
   * reverts to the store's committed sizes.
   */
  const abortDrag = (reset: () => void, event?: { clientX: number; clientY: number }): void => {
    if (dragCommitted.current) return
    dragCommitted.current = true
    // Freeze-first ordering: the last geometry ACTUALLY rendered on screen
    // wins over the pending rAF frame; the cancel/lost-capture event's own
    // coordinates (only when real — clientX/Y > 0) are the fallback for a
    // drag whose moves never landed. There is NO revert to the pre-drag
    // store sizes anymore: an interrupted drag must keep exactly what the
    // user saw, and a pure down+up with zero movement leaves the DOM alone.
    const pending = pendingDrag.current
    let width = lastAppliedRef.current?.width ?? pending?.width
    let height = lastAppliedRef.current?.height ?? pending?.height
    if ((width === undefined || height === undefined)
      && event !== undefined && event.clientX > 0 && event.clientY > 0
      && (draggingWidth || draggingBottom || draggingCorner)) {
      if (draggingWidth) {
        width = clampWidth(widthDrag.current.startWidth + (widthDrag.current.startX - event.clientX))
        height = state?.bottomOpen === true ? Math.min(state.bottomHeight, window.innerHeight) : 0
      } else if (draggingBottom) {
        width = state?.panelOpen === true ? Math.min(state?.width ?? 0, window.innerWidth) : 0
        height = clampHeight(bottomDrag.current.startHeight + (bottomDrag.current.startY - event.clientY))
      } else if (draggingCorner) {
        width = clampWidth(cornerDrag.current.startWidth + (cornerDrag.current.startX - event.clientX))
        height = clampHeight(cornerDrag.current.startHeight + (cornerDrag.current.startY - event.clientY))
      }
    }
    stopDragScheduling()
    if (width !== undefined && height !== undefined) {
      applyDrag(width, height)
      draggingRef.current = false
      measureCenter()
      store.reduce(s => setBottomHeight(setWidth(s, width), height))
    } else {
      draggingRef.current = false
    }
    reset()
  }

  // Layout push: the app shell gives up the panel's width/height while the
  // panels are open (0 while collapsed), so the conversation and input bar
  // are squeezed instead of covered. The margins are capped at the viewport
  // so a stale persisted size (e.g. fullscreen on a bigger window) can never
  // crush the app shell to zero. Dragging disables the layout transition.
  // On NARROW viewports the drawer FLOATS over the app shell — no push, the
  // conversation keeps the full width behind the drawer.
  useEffect(() => {
    const width = !narrow && snapshot.state?.panelOpen === true
      ? Math.min(snapshot.state.width, window.innerWidth)
      : 0
    const height = !narrow && snapshot.state?.bottomOpen === true
      ? Math.min(snapshot.state.bottomHeight, window.innerHeight)
      : 0
    writeGeometry(width, height)
    // NOTE: NO removeProperty cleanup on updates — deleting the variables
    // mid-commit makes #root fall back to 0px for the effect window, forcing
    // a synchronous layout at full width. That transient spike re-triggers
    // the app's left-rail hysteresis and produces the "reload" animation on
    // release (and the rail flapping). The variables are only removed on
    // unmount/boundary-swap (separate effect below), where the release is
    // intentional.
  }, [narrow, snapshot.state?.panelOpen, snapshot.state?.width, snapshot.state?.bottomOpen, snapshot.state?.bottomHeight])
  // Unmount/boundary-swap release only (issue #31): when the boundary swaps
  // the whole sidebar after a render crash (or the plugin fiber is disposed /
  // HMR), the CSS variables would otherwise stay on <html> and layout.css
  // keeps squeezing #root with a stale margin. removeProperty restores the
  // CSS fallback (var(--dsh-sidebar-width, 0px)).
  useEffect(() => () => {
    document.documentElement.style.removeProperty('--dsh-sidebar-width')
    document.documentElement.style.removeProperty('--dsh-sidebar-height')
  }, [])
  useEffect(() => {
    if (anyDragging) document.body.setAttribute('data-dsh-sidebar-dragging', '')
    else document.body.removeAttribute('data-dsh-sidebar-dragging')
  }, [anyDragging])


  const actions: WorkbenchActions = useMemo(() => ({
    closeTab: (paneId, tabId) => {
      // A closed terminal releases its pty immediately — including when its
      // socket is mid-reconnect, where the unmount close frame never reaches
      // the host and the process would hold the quota until the grace ends.
      // Agent terminals (tabId `agent:<uuid>`) close through a different
      // host route: the WS close frame is the primary path (sent by
      // TerminalView on unmount), and the agent-pty.close HTTP route is the
      // fallback when the WS is down.
      const current = store.getSnapshot().state
      // Terminal tabs may live in EITHER tree (the bottom panel hosts them
      // too) — the pty-release lookup covers both, or the HTTP fallback is
      // skipped for a bottom-panel terminal whose WS frame never arrived.
      const leaf = current === undefined
        ? undefined
        : leafWithTab(current.splits, tabId) ?? leafWithTab(current.bottomSplits, tabId)
      const tab = leaf?.tabs.find(candidate => candidate.id === tabId)
      // Route through the service: the tab-bar close is the canonical close
      // path (finds the pane itself, fires descriptor.onClose); the session
      // scope (with its cwd) rides to the callback.
      ctx.betterSidebar?.closeTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
      if (tab?.type === 'terminal') {
        if (isAgentTabId(tabId)) {
          const uuid = agentUuidOf(tabId)
          void api.agentPtyClose(uuid).catch(() => { /* the host may already have released it */ })
        } else if (sessionId !== undefined) {
          void api.ptyClose({ sessionId, cwd }, tabId).catch(() => { /* the host may already have released it */ })
        }
      }
    },
    activateTab: (paneId, tabId) => {
      // Route through the service: same reducer (finds the pane in EITHER
      // tree, sets the active pane) and fires descriptor.onActivate; the
      // session scope (with its cwd) rides to the callback.
      ctx.betterSidebar?.activateTab(tabId, sessionId === undefined ? undefined : { sessionId, cwd })
    },
    focusPane: (paneId) => { store.reduce(s => ({ ...s, activePane: paneId })) },
    moveTabToEdge: (payload: TabDragPayload, toPane: string, zone: DropZone) => {
      store.reduce(s => moveTabToEdge(s, payload.paneId, payload.tabId, toPane, zone))
    },
    moveTabBefore: (payload: TabDragPayload, toPane: string, beforeTabId: string) => {
      store.reduce((s) => {
        let index = -1
        const source = leafWithTab(s.splits, beforeTabId)
        if (source !== undefined && source.id === toPane) {
          index = source.tabs.findIndex(tab => tab.id === beforeTabId)
        }
        return moveTab(s, payload.paneId, payload.tabId, toPane, index)
      })
    },
    resizeSplit: (splitId, index, deltaFrac) => {
      store.reduce(s => resizeSplitIn(s, splitId, index, deltaFrac))
    },
  }), [store, sessionId, cwd])

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). The conversation service is
   * resolved lazily through `ctx.get` (the inject-free read — the app's own
   * plugins read 'conversation' the same way); a missing service or scope
   * degrades to a logged no-op, never a crash. Defined above the no-session
   * early return — a hook must never sit behind a conditional return
   * (React counts hooks per render).
   */
  const referenceInChat = useCallback((path: string): void => {
    if (sessionId === undefined) return
    appendToDraft(ctx, sessionId, `@${relativeTo(cwd ?? '', path)}`)
  }, [ctx, sessionId, cwd])

  // NOTE: must live ABOVE the no-session early return — React counts hooks per
  // render, and a welcome→session transition would otherwise change the hook
  // count and crash with "rendered more hooks than during the previous render".
  const activeTabType = useMemo(() => {
    if (state === undefined) return undefined
    const leaves = allLeaves(state.splits)
    for (const leaf of leaves) {
      const active = leaf.tabs.find(t => t.id === leaf.active)
      if (active) return active.type
    }
    return undefined
  }, [state])

  /**
   * Auto-widen the panel on the FIRST file open per session (operator): a fresh
   * session seeds the panel at defaultWidthPercent (20% — the tree dock alone
   * nearly fills it, leaving a few characters of editor). When an editor tab
   * with a path becomes active and the panel is still at the seeded default
   * width, widen it so the editor gets a comfortable reading width. After
   * that the user owns the width (manual drags persist per session; the
   * widened width also persists, so later sessions start comfortable).
   */
  const autoWidenedSessions = useRef(new Set<string>())
  useEffect(() => {
    if (state === undefined || sessionId === undefined || !state.panelOpen) return
    if (autoWidenedSessions.current.has(sessionId)) return
    // Find the active editor tab carrying a file path.
    let activeTab: SidebarTab | undefined
    for (const leaf of allLeaves(state.splits)) {
      const active = leaf.tabs.find(t => t.id === leaf.active)
      if (active?.type === 'editor' && active.path !== undefined && active.path !== '') {
        activeTab = active
        break
      }
    }
    if (activeTab === undefined) return
    // Only auto-widen when the panel is still at the seeded default width
    // (the user has not dragged it).
    const viewport = window.innerWidth
    const defaultWidth = defaultWidthFor(viewport, snapshot.prefs.defaultWidthPercent)
    if (Math.abs(state.width - defaultWidth) > 8) return
    // Tree dock width from the tab's persisted meta (default 240).
    const meta = activeTab.meta !== null && typeof activeTab.meta === 'object' && !Array.isArray(activeTab.meta)
      ? activeTab.meta as Record<string, unknown>
      : {}
    const treeW = typeof meta.treeWidth === 'number' && Number.isFinite(meta.treeWidth)
      ? Math.min(480, Math.max(160, Math.round(meta.treeWidth)))
      : 240
    // Editor target: a comfortable reading width (~90 chars at 14px).
    const target = Math.min(Math.max(PANEL_MIN, viewport - PANEL_MIN), treeW + 560)
    if (target > state.width) {
      store.reduce(s => setWidth(s, target))
    }
    autoWidenedSessions.current.add(sessionId)
  }, [state, sessionId, store, snapshot.prefs.defaultWidthPercent])

  if (state === undefined || sessionId === undefined) {
    return (
      <div data-dsh-panel-host>
        {!narrow ? (
          <div className={css.activityBar}>
            <div className={css.activityGroup}>
              {[
                { id: 'editor', title: t('files') || 'Files', icon: <IconFolderOpen16 size={18} /> },
                { id: 'git', title: t('git') || 'Git', icon: <IconBranchOutline16 size={18} /> },
                { id: 'terminal', title: t('terminal') || 'Terminal', icon: <IconTerminalOutline16 size={18} /> },
                { id: 'subagent', title: t('subagent') || 'Tasks', icon: <IconThinkOutline16 size={18} /> },
                { id: 'browser', title: t('browser') || 'Browser', icon: <IconGlobeOutline16 size={18} /> },
              ].map((item) => (
                <Tooltip key={item.id} label={item.title} side="left" delayMs={300}>
                  <button
                    type="button"
                    className={css.activityButton}
                    aria-label={item.title}
                    onClick={() => {
                      const current = ctx.sessions.list.getSnapshot().current
                      if (current !== undefined) store.setSession(current)
                    }}
                  >
                    {item.icon}
                  </button>
                </Tooltip>
              ))}
            </div>
            <div className={css.activityGroup}>
              <Tooltip label={t('collapseBottomPanel') || 'Bottom Panel'} side="left" delayMs={300}>
                <button type="button" className={css.activityButton} disabled aria-label={t('collapseBottomPanel') || 'Bottom Panel'}>
                  <IconPanelBottomOutline16 size={18} />
                </button>
              </Tooltip>
            </div>
          </div>
        ) : (
          <div className={css.toggleCluster}>
            <Tooltip label={t('noSession')} side="bottom" delayMs={500}>
              <button type="button" className={css.toggleButton} disabled aria-label={t('noSession')}>
                <IconPanelRightOutline16 />
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    )
  }

  const onNewTab = (optionId: string): void => {
    const service = ctx.betterSidebar
    const descriptor = service?.getTab(optionId)
    if (descriptor === undefined) return
    const title = typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title
    // The session scope rides along: lifecycle callbacks receive it (and
    // the open stays in the current session, as before).
    service.openTab({ type: optionId, title }, { sessionId, cwd })
  }

  /**
   * The explorer's @-reference button: append `@<relative path>` to the
   * session's composer draft (space-separated). Resolves the session-scope
   * ctx and the conversation input service at click time; a missing service
   * or scope degrades to a logged no-op, never a crash.
   */
  /** The tab icon from the tab-type registry (shared by every workbench). */
  const tabIconOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.betterSidebar?.getTab(tab.type)
    if (descriptor === undefined) return null
    return typeof descriptor.icon === 'function' ? descriptor.icon(14) : descriptor.icon
  }

  /**
   * The tab badge from the tab-type registry: a count (99+ capped) or a
   * short text pill. A throwing badge is swallowed (no pill) — the tab
   * strip must never break because a plugin's badge computation failed.
   */
  const tabBadgeOf = (tab: SidebarTab): ReactNode => {
    const descriptor = ctx.betterSidebar?.getTab(tab.type)
    if (descriptor?.badge === undefined) return null
    let value: string | number | null | undefined
    try {
      value = descriptor.badge(ctx, { sessionId, cwd }, state)
    } catch (error) {
      console.error('[dsh-better-sidebar] tab badge error:', error)
      return null
    }
    if (value === null || value === undefined || value === '') return null
    const text = typeof value === 'number' ? (value > 99 ? '99+' : String(value)) : String(value)
    return <span className={css.tabBadge}>{text}</span>
  }

  /**
   * Render one tab's content. `active` (from the workbench) tells whether
   * this tab is the active one in its pane; combined with the panel's
   * open/closed state it gates live views (the Subagent topology pauses its
   * polling while the page is not actually visible). The pane id travels
   * with the tab so diff tabs can split below their source pane.
   */
  const renderTab = (tab: SidebarTab, active: boolean, paneId: string, bottom = false) => (
    <TabContent
      tab={tab}
      sessionId={sessionId}
      cwd={cwd}
      expanded={state.expanded}
      onToggleDir={(path) => { store.reduce(s => toggleExpanded(s, path)) }}
      onReferenceFile={referenceInChat}
      ctx={ctx}
      store={store}
      visible={bottom ? state.bottomOpen && active : state.panelOpen && active}
      onSubagentJump={(childSessionId) => { subagentJumpRef.current = childSessionId }}
      onOpenDiff={(diffTab) => { store.reduce(s => openDiffTab(s, paneId, diffTab)) }}
      fsChangedTick={fsChangedTick}
      onFsChanged={() => { setFsChangedTick(tick => tick + 1) }}
    />
  )

  const activityItems = [
    { id: 'editor', title: t('files') || 'Files', icon: <IconFolderOpen16 size={18} /> },
    { id: 'git', title: t('git') || 'Git', icon: <IconBranchOutline16 size={18} /> },
    { id: 'terminal', title: t('terminal') || 'Terminal', icon: <IconTerminalOutline16 size={18} /> },
    { id: 'subagent', title: t('subagent') || 'Tasks', icon: <IconThinkOutline16 size={18} /> },
    { id: 'browser', title: t('browser') || 'Browser', icon: <IconGlobeOutline16 size={18} /> },
    {
      id: 'capabilities',
      title: 'Capabilities & Tools',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 2.5C6 1.94772 6.44772 1.5 7 1.5H9C9.55228 1.5 10 1.94772 10 2.5V3.5H12.5C13.0523 3.5 13.5 3.94772 13.5 4.5V7C14.0523 7 14.5 7.44772 14.5 8V10C14.5 10.5523 14.0523 11 13.5 11V13.5C13.5 14.0523 13.0523 14.5 12.5 14.5H10V13.5C10 12.9477 9.55228 12.5 9 12.5H7C6.44772 12.5 6 12.9477 6 13.5V14.5H3.5C2.94772 14.5 2.5 14.0523 2.5 13.5V11C1.94772 11 1.5 10.5523 1.5 10V8C1.5 7.44772 1.94772 7 2.5 7V4.5C2.5 3.94772 2.94772 3.5 3.5 3.5H6V2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'routing',
      title: 'Agent Models',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="5.5" cy="4.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="10.5" cy="8" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
          <circle cx="7.5" cy="11.5" r="1.4" fill="var(--dsh-sidebar-bg, #0f172a)" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      ),
    },
  ]

  const handleActivityClick = (type: string, title?: string) => {
    // Prefs live on the SNAPSHOT, not the state — capture before the reduce.
    const mergedExplorer = store.getSnapshot().prefs.editorExplorer
    store.reduce((s) => {
      // 1. Sanitize any cross-panel contamination: if bottomSplits has non-terminal tabs, migrate them to splits
      const bottomLeaves = allLeaves(s.bottomSplits)
      const strayTabs: SidebarTab[] = []
      for (const leaf of bottomLeaves) {
        for (const tab of leaf.tabs) {
          if (tab.type !== 'terminal') strayTabs.push(tab)
        }
      }

      let nextBottomSplits = s.bottomSplits
      if (strayTabs.length > 0) {
        for (const leaf of bottomLeaves) {
          nextBottomSplits = mapLeaf(nextBottomSplits, leaf.id, (l) => {
            l.tabs = l.tabs.filter(t => t.type === 'terminal')
            if (!l.tabs.some(t => t.id === l.active)) {
              l.active = l.tabs[l.tabs.length - 1]?.id ?? null
            }
          })
        }
      }

      const leaves = allLeaves(s.splits)
      const rightPane = leaves.find(l => treeOf(s, l.id) === 'splits') ?? leaves[0]
      if (rightPane === undefined) return s

      const currentActiveTab = rightPane.tabs.find(t => t.id === rightPane.active)
      const currentActiveType = currentActiveTab?.type

      // 2. Toggle closed if clicking the currently active view in an open panel
      if (s.panelOpen && currentActiveType === type) {
        return {
          ...s,
          panelOpen: false,
          bottomSplits: nextBottomSplits,
        }
      }

      // 3. Re-activate if this tab type already exists in the right pane.
      // Merged mode: ANY editor tab re-activates (the open file + tree state
      // restore exactly as left). Split mode: the path-less home tab is the
      // standalone explorer.
      const existing = type === 'editor'
        ? rightPane.tabs.find(t => t.type === 'editor' && (mergedExplorer ? true : t.path === undefined))
        : rightPane.tabs.find(t => t.type === type)

      if (existing !== undefined) {
        const activated = activateTabReducer(s, rightPane.id, existing.id)
        return {
          ...activated,
          panelOpen: true,
          activePane: rightPane.id,
          bottomSplits: nextBottomSplits,
        }
      }

      // 4. Mint new tab in right pane
      const newTab: SidebarTab = {
        id: type === 'terminal' ? `terminal:${s.nextTerminal}` : type === 'browser' ? `browser:${s.nextBrowser}` : type,
        type,
        title: title || (type === 'editor' ? 'Files' : type === 'git' ? 'Git' : type === 'terminal' ? 'Terminal' : type === 'subagent' ? 'Tasks' : type === 'browser' ? 'Browser' : type === 'capabilities' ? 'Capabilities' : type === 'routing' ? 'Agent Models' : type),
      }

      const nextSplits = mapLeaf(s.splits, rightPane.id, (leaf) => {
        // Also adopt any stray tabs migrated from bottom panel
        for (const stray of strayTabs) {
          if (!leaf.tabs.some(t => t.id === stray.id || (t.type === stray.type && t.type !== 'editor'))) {
            leaf.tabs.push(stray)
          }
        }
        leaf.tabs.push(newTab)
        leaf.active = newTab.id
      })

      return {
        ...s,
        panelOpen: true,
        activePane: rightPane.id,
        splits: nextSplits,
        bottomSplits: nextBottomSplits,
        nextTerminal: type === 'terminal' ? s.nextTerminal + 1 : s.nextTerminal,
        nextBrowser: type === 'browser' ? s.nextBrowser + 1 : s.nextBrowser,
      }
    })
  }

  const handleBottomToggle = () => {
    store.reduce((s) => {
      const willBeOpen = !s.bottomOpen
      if (!willBeOpen) {
        return { ...s, bottomOpen: false }
      }
      const bottomLeaves = allLeaves(s.bottomSplits)
      const bottomPane = bottomLeaves[0]
      if (bottomPane) {
        // Ensure bottom panel ONLY shows terminal tabs
        const existingTerm = bottomPane.tabs.find(t => t.type === 'terminal')
        if (existingTerm) {
          const activated = activateTabReducer(s, bottomPane.id, existingTerm.id)
          return {
            ...activated,
            bottomOpen: true,
            activePane: bottomPane.id,
            bottomOpenedOnce: true,
          }
        }
        // Mint a terminal for the bottom drawer
        const termTab: SidebarTab = {
          id: `terminal:${s.nextTerminal}`,
          type: 'terminal',
          title: 'Terminal',
        }
        const nextBottomSplits = mapLeaf(s.bottomSplits, bottomPane.id, (leaf) => {
          leaf.tabs = leaf.tabs.filter(t => t.type === 'terminal')
          leaf.tabs.push(termTab)
          leaf.active = termTab.id
        })
        return {
          ...s,
          bottomOpen: true,
          bottomSplits: nextBottomSplits,
          activePane: bottomPane.id,
          nextTerminal: s.nextTerminal + 1,
          bottomOpenedOnce: true,
        }
      }
      return { ...s, bottomOpen: true, bottomOpenedOnce: true }
    })
  }

  return (
    <div data-dsh-panel-host>
      {/*
        OpenChamber-style Vertical Activity Bar / Tool Rail docked to the right edge.
      */}
      {!narrow ? (
        <div className={css.activityBar}>
          <div className={css.activityGroup}>
            {activityItems.map((item) => {
              const isActive = state.panelOpen && activeTabType === item.id
              return (
                <Tooltip key={item.id} label={item.title} side="left" delayMs={300}>
                  <button
                    type="button"
                    className={clsx(css.activityButton, isActive && css.activityButtonActive)}
                    aria-label={item.title}
                    onClick={() => handleActivityClick(item.id, item.title)}
                  >
                    {item.icon}
                  </button>
                </Tooltip>
              )
            })}
          </div>
          <div className={css.activityGroup}>
            <Tooltip label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')} side="left" delayMs={300}>
              <button
                type="button"
                className={clsx(css.activityButton, state.bottomOpen && css.activityButtonActive)}
                aria-label={state.bottomOpen ? t('collapseBottomPanel') : t('expandBottomPanel')}
                onClick={handleBottomToggle}
              >
                <IconPanelBottomOutline16 size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      ) : (
        <div className={css.toggleCluster}>
          <Tooltip label={state.panelOpen ? t('collapse') : t('expand')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.toggleButton}
              aria-label={state.panelOpen ? t('collapse') : t('expand')}
              onClick={() => { store.reduce(togglePanel) }}
            >
              <IconPanelRightOutline16 />
            </button>
          </Tooltip>
        </div>
      )}
      {/*
        The right panel stays mounted while collapsed (hidden off-screen) so
        the slide in/out can animate; visibility hides it after the slide
        settles. Its bottom edge follows the bottom panel's height (0 while
        the bottom panel is closed) — the VSCode-style "sidebar above panel".
        On NARROW viewports it is a full-width drawer holding both
        workbenches (see MobileWorkbench); the width drag strip is not
        offered there — a full-screen sheet has nothing to drag.
      */}
      <div
        ref={panelRef}
        className={clsx(css.panel, !state.panelOpen && css.panelHidden)}
        style={{
          width: narrow ? '100vw' : Math.min(state.width, window.innerWidth),
          // Narrow drawer: keep the bottom-anchored sheet above the on-screen
          // keyboard (visualViewport inset); desktop panels are full-height
          // and unaffected.
          bottom: narrow && keyboardInset > 0 ? `${keyboardInset}px` : undefined,
        }}

        data-dragging={anyDragging || undefined}
      >
          {!narrow && (
            <div
              className={clsx(css.panelResize, draggingWidth && css.panelResizeActive)}

              onPointerDown={(event) => {
                event.preventDefault()
                event.currentTarget.setPointerCapture(event.pointerId)
                dragCommitted.current = false
                widthDrag.current = { startX: event.clientX, startWidth: state.width }
                setDraggingWidth(true)
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                const { startX, startWidth } = widthDrag.current
                const width = clampWidth(startWidth + (startX - event.clientX))
                const height = state.bottomOpen ? Math.min(state.bottomHeight, window.innerHeight) : 0
                scheduleDrag(width, height)
              }}
              onPointerUp={(event) => {
                // Never bail on capture: capture may already be gone (fast
                // release / release outside the strip), and bailing leaves
                // the drag uncommitted — the "nothing changed" snap-back.
                dragCommitted.current = true
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
                }
                const { startX, startWidth } = widthDrag.current
                // Freeze the exact geometry the user saw: the last frame
                // actually rendered wins; the pending rAF frame is next; the
                // up position (which may equal the down position when no
                // move landed) is the last resort.
                const pending = pendingDrag.current
                const width = lastAppliedRef.current?.width
                  ?? (pending !== null ? pending.width : clampWidth(startWidth + (startX - event.clientX)))
                const height = state.bottomOpen ? Math.min(state.bottomHeight, window.innerHeight) : 0
                commitDrag(width, height, s => setWidth(s, width))
                setDraggingWidth(false)
              }}
              onPointerCancel={(event) => { abortDrag(() => setDraggingWidth(false), event) }}
              onLostPointerCapture={(event) => { abortDrag(() => setDraggingWidth(false), event) }}
            />
          )}
        <div className={css.panelBody}>
          <Workbench
            state={state}
            newTabOptions={buildNewTabOptions(state, ctx, { sessionId, cwd })}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={renderTab}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
        {/*
          The shared corner (only while BOTH panels are open): the
          intersection of the right panel's left edge and the bottom panel's
          top edge. Horizontal drags resize the right panel's width, vertical
          drags the bottom panel's height — the two panels drag against each
          other. Rendered INSIDE the right panel and positioned by CSS
          relative to it (left edge + the bottom panel's height via the
          --dsh-sidebar-height layout variable) — no JS-written viewport
          coordinates to keep in sync. (Never on narrow viewports: the
          bottom panel does not exist there.)
        */}
        {!narrow && state.panelOpen && state.bottomOpen && (
          <div
            className={css.cornerHandle}
            data-dragging={draggingCorner || undefined}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragCommitted.current = false
              cornerDrag.current = {
                startX: event.clientX,
                startY: event.clientY,
                startWidth: state.width,
                startHeight: state.bottomHeight,
              }
              setDraggingCorner(true)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const { startX, startY, startWidth, startHeight } = cornerDrag.current
              const width = clampWidth(startWidth + (startX - event.clientX))
              const height = clampHeight(startHeight + (startY - event.clientY))
              scheduleDrag(width, height)
            }}
            onPointerUp={(event) => {
              dragCommitted.current = true
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
              }
              const { startX, startY, startWidth, startHeight } = cornerDrag.current
              // Freeze the exact on-screen geometry (see the width strip's
              // pointerup for the ordering rationale).
              const pending = pendingDrag.current
              const width = lastAppliedRef.current?.width
                ?? (pending !== null ? pending.width : clampWidth(startWidth + (startX - event.clientX)))
              const height = lastAppliedRef.current?.height
                ?? (pending !== null ? pending.height : clampHeight(startHeight + (startY - event.clientY)))
              commitDrag(width, height, s => setBottomHeight(setWidth(s, width), height))
              setDraggingCorner(false)
            }}
            onPointerCancel={(event) => { abortDrag(() => setDraggingCorner(false), event) }}
            onLostPointerCapture={(event) => { abortDrag(() => setDraggingCorner(false), event) }}
          />
        )}
      </div>
      {/*
        The bottom panel: a second, independent workbench. It squeezes ONLY
        the center column (the agent output area): it starts at the app
        shell's own left sidebar and ends at the right panel's left edge —
        neither sidebar gives up any position (the right panel keeps its
        full height). Its resize strip is the top edge; hidden by sliding
        down like the right panel. On NARROW viewports it does not exist —
        the bottom workbench lives inside the drawer (MobileWorkbench).
      */}
      {/* The bottom panel only becomes VISIBLE once the center column is
          measured: before that, `centerRect` is the {0,0} fallback and
          `right` computes to the full viewport width — the panel (and its
          overflow content) would flash full-width for a frame until the
          first measurement lands. Rendering stays unconditional so the
          mount/render chain (auto-terminal etc.) is never gated on
          geometry. */}
      {!narrow && (
      <div
        ref={bottomRef}
        className={clsx(css.bottomPanel, !state.bottomOpen && css.bottomPanelHidden)}
        style={{
          height: Math.min(state.bottomHeight, window.innerHeight),
          left: centerRect.left,
          // Keep the panel above the on-screen keyboard when the visual
          // viewport shrinks (see the keyboardInset effect).
          bottom: keyboardInset > 0 ? `${keyboardInset}px` : undefined,
          // Direct from the center column's measured right edge: the bottom
          // panel spans ONLY the center column, ending exactly at the
          // details column's left edge (the details column sits between the
          // center and the right panel, and the right panel's margin-right
          // push is already baked into centerRect.right).
          right: centerRect.right > 0 ? window.innerWidth - centerRect.right : 0,
          // The seam against the open right panel needs its own hairline
          // (the right panel's border-left alone is covered by this panel's
          // fill — without it the corner looks cut off).
          borderRight: state.panelOpen ? '1px solid var(--dsw-alias-border-l2)' : undefined,
          // An OPEN panel is never hidden: if the center column hasn't been
          // measured yet, fall back to full-width geometry until the measure
          // lands (kickMeasure retries on toggle) — hiding it was the
          // "chat goes up but the bottom bar area is empty" bug.
          visibility: centerRect.right > 0 || state.bottomOpen ? undefined : 'hidden',
        }}

        data-dragging={(draggingBottom || draggingCorner) || undefined}
      >
        <div
          className={clsx(css.bottomResize, draggingBottom && css.bottomResizeActive)}

          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragCommitted.current = false
            bottomDrag.current = { startY: event.clientY, startHeight: state.bottomHeight }
            setDraggingBottom(true)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const { startY, startHeight } = bottomDrag.current
            const height = clampHeight(startHeight + (startY - event.clientY))
            // Carry the RIGHT panel's push only while it is actually open:
            // with it closed, a bottom drag must push 0 width — otherwise
            // the shell reserves an empty right-panel gap mid-drag ("the
            // right sidebar place opens up but is empty").
            scheduleDrag(state.panelOpen ? Math.min(state.width, window.innerWidth) : 0, height)
          }}
          onPointerUp={(event) => {
            dragCommitted.current = true
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
            }
            const { startY, startHeight } = bottomDrag.current
            // Freeze the exact on-screen geometry (see the width strip's
            // pointerup for the ordering rationale).
            const pending = pendingDrag.current
            const height = lastAppliedRef.current?.height
              ?? (pending !== null ? pending.height : clampHeight(startHeight + (startY - event.clientY)))
            const width = lastAppliedRef.current?.width
              ?? (state.panelOpen ? Math.min(state.width, window.innerWidth) : 0)
            commitDrag(width, height, s => setBottomHeight(s, height))
            setDraggingBottom(false)
          }}
          onPointerCancel={(event) => { abortDrag(() => setDraggingBottom(false), event) }}
          onLostPointerCapture={(event) => { abortDrag(() => setDraggingBottom(false), event) }}
        />
        {/*
          The bottom panel's own close control at its tab strip's right end
          (the strip reserves the width via CSS so the + menu never hides
          under it): one tap collapses the panel.
        */}
        <Tooltip label={t('collapseBottomPanel')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.bottomClose}
            aria-label={t('collapseBottomPanel')}
            onClick={() => { store.reduce(toggleBottomPanel) }}
          >
            <IconCloseFill14 />
          </button>
        </Tooltip>
        <div className={css.panelBody}>
          <Workbench
            state={state}
            tree={state.bottomSplits}
            newTabOptions={buildNewTabOptions(state, ctx, { sessionId, cwd })}
            actions={actions}
            onNewTab={onNewTab}
            renderTab={(tab, active, paneId) => renderTab(tab, active, paneId, true)}
            getTabIcon={tabIconOf}
            getTabBadge={tabBadgeOf}
          />
        </div>
      </div>
      )}
    </div>
  )
}
