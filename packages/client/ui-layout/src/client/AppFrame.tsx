/**
 * Shell frame, registered into the built-in 'root' slot (the web shell renders
 * only 'root'). Owns the grid tracks (sidebar | center | rightbar), the drag
 * handles (pointer capture + rAF throttle), the column solve (columns.ts), the
 * compact/desktop chrome choice, and the child-slot render decisions. The main
 * and rightbar slots stay in the same DOM position across a live layout-mode
 * switch so the conversation, composer, and right panel do not remount.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  InjectFace, HostObservable, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { DeviceSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { getLayoutModeRuntime, startLayoutModeRuntime, useLayoutMode } from '@deepseek-ai/dsh-client-ui-primitives'
import { computeColumns, resolveRightbarWidth, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT } from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import { MobileFrame } from './MobileFrame.tsx'
import { publishShellInsets } from './overlay-insets.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'
import mobileCss from './MobileFrame.module.css'

/** What the root entry injects beyond the framework shares. */
export interface AppFrameInjected {
  /**
   * The shared input-capability classifier. The frame no longer branches on
   * it; shell chrome follows `useLayoutMode`, while this hook remains the
   * source for pointer and touch-target behavior.
   */
  readonly hooks: { readonly device: HostObservable<DeviceSnapshot> }
  /** Dismiss the top registered surface through the shared stack. */
  readonly dismissBack: () => boolean
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<
    'sidebar' | 'main' | 'rightbar' | 'shell.overlay' | 'settings.surface'
    | 'shell.mobile.header' | 'shell.mobile.bar' | 'shell.mobile.more'
  >
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>
  & InjectFace<AppFrameInjected>

/**
 * The track marker only drops after no track-owned transition has run for this
 * long. A settle that landed between a spam toggle and its commit used to clear
 * the marker mid-retarget, and the browser's shortened reversal left the next
 * toggle without a transition rule (a snap). The grace also absorbs a toggle
 * whose effect cleanup has not run yet, and the generation check rejects a
 * settle a newer toggle superseded.
 */
const TRACK_SETTLE_GRACE_MS = 250

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    callbacks.current.onDrag(e.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === e.pointerId) endDrag()
  }, [endDrag])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  usePanelInfo,
  dismissBack,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth
  const layoutMode = useLayoutMode()
  const compact = layoutMode === 'compact'

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // The same frame is measured for both the width store and the shared layout
  // mode, so feature consumers never guess a viewport width of their own.
  useLayoutEffect(() => {
    const stopLayoutMode = startLayoutModeRuntime()
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) {
        actions.setViewportWidth(width)
        getLayoutModeRuntime().setFrameWidth(width)
      }
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
      stopLayoutMode()
    }
  }, [actions])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  // No stored preference means the shipped default: opening the panel never
  // records one, so a default we change later reaches operators who never dragged.
  const rightbarPreference = resolveRightbarWidth(layoutInfo.rightbar, viewport)
  // Desktop reopen controls occupy the macOS session header or Windows caption row.
  const collapsedWidth = document.documentElement.dataset.platform === 'darwin'
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth)
  const cols = computeColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0, collapsedWidth)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // Publish the overlay-safe geometry on the root: overlay chips portal to
  // document.body, so they cannot inherit the frame's own variables. The left
  // inset is the sidebar column (its collapsed rail included); the right inset
  // is the right panel's viewport footprint even when it hangs over the centre
  // without a track. A fullscreen right panel owns the frame and marks the
  // root so every overlay chip hides instead of sitting over it.
  const overlayRightInset = layoutInfo.rightbarFullscreen ? viewport : layoutInfo.rightbarShown ? normal.rightbar : 0
  const overlayCovered = layoutInfo.rightbarFullscreen
  useEffect(() => {
    if (compact) return undefined
    return publishShellInsets(document.documentElement, {
      left: cols.sidebar,
      right: overlayRightInset,
      bottom: '0px',
      covered: overlayCovered,
    })
  }, [compact, cols.sidebar, overlayRightInset, overlayCovered])

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  // Track easing is scoped to a discrete open/close toggle. The marker must be
  // up in the same commit as the track change: an effect commit sets it after
  // the track already moved, and a layout read in between forces a style recalc
  // of the new track without the transition, so the tracks snap. The toggle
  // comparison therefore happens while rendering and the settle counter is
  // bumped in the same pass. Steady-state viewport updates stay instant
  // (AppFrame.module.css), and so does a toggle arriving together with a
  // viewport change — that is the responsive auto-collapse firing mid
  // window-resize, where easing would chase the live window edge. The counter
  // restarts the settle window when a re-toggle interrupts a running transition.
  const [animating, setAnimating] = useState(0)
  const trackToggle = `${sidebarCollapsed}:${layoutInfo.rightbarTrack}`
  const previousToggle = useRef(trackToggle)
  const previousViewport = useRef(viewport)
  const viewportChanged = previousViewport.current !== viewport
  previousViewport.current = viewport
  if (previousToggle.current !== trackToggle) {
    previousToggle.current = trackToggle
    if (!viewportChanged) setAnimating(token => token + 1)
  }
  useEffect(() => {
    if (animating === 0) return
    const frame = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (frame === null) return
    // The marker may only drop when no track-owned transition has run for
    // TRACK_SETTLE_GRACE_MS. A toggle landing on a completed end restarts the
    // effect, and an end event of the replaced transition used to clear the
    // marker while the retargeted transition was still gliding — the retargeted
    // grid/padding then snap without their transition declarations while the
    // panel keeps moving. The 600 ms backstop covers reduced motion and covered
    // frames.
    const trackProperties = new Set(['grid-template-columns', 'padding-right', '--dsh-sidebar-track', '--dsh-rightbar-progress'])
    const stillRunning = () => {
      const centre = frame.querySelector('[data-main-column]')
      for (const element of [frame, centre]) {
        if (element === null || typeof element.getAnimations !== 'function') continue
        for (const animation of element.getAnimations()) {
          if (animation.playState !== 'running') continue
          const property = 'transitionProperty' in animation ? String(animation.transitionProperty) : undefined
          if (property === undefined || trackProperties.has(property)) return true
        }
      }
      return false
    }
    // The grace is a timer owned by this effect: the next toggle's cleanup
    // cancels it, and while transitions run the check re-arms, so the marker
    // can neither outlive a newer toggle nor drop inside the window between a
    // newer toggle's commit and its effect cleanup. `current === animating`
    // rejects a settle that still fires in that window.
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const settleIfDone = () => {
      settleTimer = null
      if (stillRunning()) { settleTimer = setTimeout(settleIfDone, TRACK_SETTLE_GRACE_MS); return }
      setAnimating(current => current === animating ? 0 : current)
    }
    const scheduleSettle = () => {
      if (settleTimer !== null) return
      settleTimer = setTimeout(settleIfDone, TRACK_SETTLE_GRACE_MS)
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== frame && event.target !== frame.querySelector('[data-main-column]')) return
      if (!trackProperties.has(event.propertyName)) return
      scheduleSettle()
    }
    frame.addEventListener('transitionend', onTransitionEnd)
    const backstop = setTimeout(scheduleSettle, 600)
    return () => {
      frame.removeEventListener('transitionend', onTransitionEnd)
      clearTimeout(backstop)
      if (settleTimer !== null) clearTimeout(settleTimer)
    }
  }, [animating])
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarWidth.current; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => {
    actions.setRightbar(rightbarBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  const sidebar = useMemo(() => (compact ? null : renderSlot('sidebar', {
    collapsed: sidebarCollapsed,
    width: cols.sidebar,
  })), [renderSlot, compact, sidebarCollapsed, cols.sidebar])
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => (compact ? null : renderSlot('shell.overlay', {})), [renderSlot, compact])
  const settingsSurface = useMemo(() => renderSlot('settings.surface', {}), [renderSlot])

  // One animated value per side: the registered track variables are what the
  // frame transitions, and the grid, the centre's rail reservation
  // (ui-sidebar-right), the right panel's slide and the terminal dock all read
  // them. The right track is the width target scaled by the eased progress, so
  // a mid-ride target change (the crossed collapse, a window resize) moves
  // every consumer by the same amount.
  const frameStyle: CSSProperties & {
    '--dsh-sidebar-track': string
    '--dsh-rightbar-width': string
    '--dsh-rightbar-progress': number
  } = {
    ...(document.documentElement.hasAttribute('data-windows-titlebar')
      ? { '--dsh-windows-sidebar-width': `${cols.sidebar}px` } : {}),
    '--dsh-sidebar-track': `${cols.sidebar}px`,
    '--dsh-rightbar-width': `${normal.rightbar}px`,
    '--dsh-rightbar-progress': layoutInfo.rightbarTrack ? 1 : 0,
    gridTemplateColumns:
      'var(--dsh-sidebar-track) minmax(0, 1fr) calc(var(--dsh-rightbar-width) * var(--dsh-rightbar-progress))',
  }

  const rightbarOwner = compact
    ? { width: viewport, viewportWidth: viewport, canShow: true, mobile: true }
    : { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0, mobile: false }

  return (
    <div
      ref={frameRef}
      className={compact ? mobileCss.frame : css.frame}
      style={compact ? undefined : frameStyle}
      data-mobile-frame={compact ? '' : undefined}
      data-sidebar-collapsed={!compact && sidebarCollapsed ? true : undefined}
      data-rightbar-collapsed={!compact && cols.rightbar === 0 ? true : undefined}
      data-rightbar-fullscreen={!compact && layoutInfo.rightbarFullscreen ? true : undefined}
      data-rightbar-instant={!compact && layoutInfo.rightbarInstant ? true : undefined}
      data-dragging={!compact && dragging ? true : undefined}
      data-animating={!compact && animating > 0 ? true : undefined}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      {/* Stable settings host: rendered once at the frame root, outside the
          desktop sidebar / compact drawer swap. The sidebar keeps only the
          trigger; the dialog and mounted section survive layout-mode changes. */}
      {settingsSurface}
      {!compact && (
        <div key="sidebar" className={css.sidebarCol}>
          {sidebar}
        </div>
      )}
      {compact && (
        <MobileFrame
          frameRef={frameRef}
          productTitle={productTitle}
          renderSlot={renderSlot}
          useSessions={useSessions}
          usePanelInfo={usePanelInfo}
          useStore={useStore}
          dismissBack={dismissBack}
          t={t}
          viewport={viewport}
        />
      )}
      <div
        key="main"
        className={compact ? mobileCss.content : css.centerCol}
        data-main-column=""
        data-mobile-content={compact ? '' : undefined}
      >
        {main}
      </div>
      <div
        key="rightbar"
        className={compact ? mobileCss.rightbarHost : css.rightbarCol}
        data-rightbar-col={compact ? undefined : ''}
      >
        {renderSlot('rightbar', rightbarOwner)}
      </div>
      {!compact && (
        <div className={css.overlayLayer} data-shell-overlay>
          {overlays}
        </div>
      )}
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!compact && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {!compact && layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
