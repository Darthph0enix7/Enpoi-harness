/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar), the drag handles (pointer capture + rAF throttle), the column
 * solve (columns.ts), and the child-slot render decisions: the sidebar slot
 * receives live parameters from that solve. The root-scoped main slot selects
 * the Conversation or a global panel. Each column occupant owns its Session
 * binding and reports the geometry it needs.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  InjectFace, HostObservable, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { DeviceSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import { computeColumns, RIGHTBAR_DEFAULT_RATIO, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT } from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import { MobileFrame } from './MobileFrame.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** What the root entry injects beyond the framework shares. */
export interface AppFrameInjected {
  /**
   * The shared device classifier. The frame branches on it: a touch device
   * mounts the mobile container, everything else the three-column solver.
   */
  readonly hooks: { readonly device: HostObservable<DeviceSnapshot> }
  /** Dismiss the top registered surface through the shared stack. */
  readonly dismissBack: () => boolean
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<
    'sidebar' | 'main' | 'rightbar' | 'shell.overlay'
    | 'shell.mobile.header' | 'shell.mobile.bar' | 'shell.mobile.more'
  >
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>
  & InjectFace<AppFrameInjected>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
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
  useDevice,
  dismissBack,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth
  const device = useDevice(snapshot => snapshot)
  const mobile = device.device !== 'desktop'

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // The mode dependency re-attaches the observer when the branch swaps the
  // measured element (a phone rotated past the tablet ceiling and back).
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
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
    }
  }, [actions, mobile])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
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
    // The marker may only drop when no track-owned transition still runs: a
    // toggle landing on a completed end restarts the effect, and the queued end
    // event of the replaced transition would otherwise dispatch into the fresh
    // listener and clear the marker while the retargeted transition is still
    // gliding — the retargeted grid/padding then snap without their transition
    // declarations while the panel keeps moving. The 600 ms timer is the
    // backstop for reduced motion and covered frames.
    const trackProperties = new Set(['grid-template-columns', 'padding-right', '--dsh-sidebar-track', '--dsh-rightbar-progress'])
    const stillRunning = () => {
      const centre = frame.children[1] ?? null
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
    const settleIfDone = () => { if (!stillRunning()) setAnimating(0) }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== frame && event.target !== frame.children[1]) return
      if (!trackProperties.has(event.propertyName)) return
      settleIfDone()
    }
    frame.addEventListener('transitionend', onTransitionEnd)
    const timer = setTimeout(settleIfDone, 600)
    return () => {
      frame.removeEventListener('transitionend', onTransitionEnd)
      clearTimeout(timer)
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
  const sidebar = useMemo(() => (mobile ? null : renderSlot('sidebar', {
    collapsed: sidebarCollapsed,
    width: cols.sidebar,
  })), [renderSlot, mobile, sidebarCollapsed, cols.sidebar])
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => (mobile ? null : renderSlot('shell.overlay', {})), [renderSlot, mobile])

  if (mobile) {
    return (
      <>
        <DocumentTitle
          productTitle={productTitle}
          useSessions={useSessions}
          usePanelInfo={usePanelInfo}
        />
        <MobileFrame
          frameRef={frameRef}
          productTitle={productTitle}
          main={main}
          renderSlot={renderSlot}
          useSessions={useSessions}
          usePanelInfo={usePanelInfo}
          useStore={useStore}
          dismissBack={dismissBack}
          t={t}
          viewport={viewport}
        />
      </>
    )
  }

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

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={frameStyle}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
      data-animating={animating > 0 || undefined}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      <div className={css.sidebarCol}>
        {sidebar}
      </div>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>
          {renderSlot('rightbar', {
            width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0, mobile: false,
          })}
        </RightbarColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
