/**
 * Phone/tablet shell: the dedicated mobile container AppFrame mounts instead
 * of the three-column solver whenever the classifier reports a touch device.
 *
 * The container owns the compact 48px header (navigation trigger, session
 * title, the extension seat the chat lane contributes its view pills to, the
 * overflow trigger, and one back affordance wired to the shared dismissal
 * stack), the content column, the bottom action bar (its entries arrive
 * through the `shell.mobile.bar` seat), the left column as a slide-over drawer
 * with a scrim and an edge swipe, and the right column's existing fullscreen
 * panel. Chrome visibility is stylesheet-owned: the keyboard attribute and the
 * landscape/short-viewport media queries fold the bar into the header
 * overflow without a re-render.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'
import {
  IconChevronLeftOutlineRegular, IconEllipsisOutlineMedium, IconFullscreenOutlineMedium,
  IconPanelLeftOutlineMedium, Sheet, useBackHandler,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import css from './MobileFrame.module.css'

/** Drawer width; the desktop sidebar's minimum, so the wide content is unchanged. */
export const MOBILE_DRAWER_WIDTH = 264

/** Left edge strip (px) a swipe must start in to open the drawer. */
const EDGE_SWIPE_ZONE = 32

/** Horizontal travel (px) that commits a drawer swipe. */
const SWIPE_MIN_TRAVEL = 64

/** Vertical share of the gesture above which it is a scroll, not a swipe. */
const SWIPE_VERTICAL_RATIO = 0.7

/** One tracked touch gesture on the frame. */
interface SwipeState {
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  readonly opening: boolean
  rejected: boolean
}

/** Props the desktop frame hands the mobile container. */
export interface MobileFrameProps {
  /** The frame's own box, measured for the layout store like the desktop grid. */
  readonly frameRef: RefObject<HTMLDivElement>
  readonly productTitle: string
  /** The selected main panel, already rendered by the frame. */
  readonly main: ReactNode
  readonly renderSlot: AppFrameProps['renderSlot']
  readonly useSessions: AppFrameProps['useSessions']
  readonly usePanelInfo: AppFrameProps['usePanelInfo']
  readonly useStore: AppFrameProps['useStore']
  /** Dismiss the top surface on the shared back stack. */
  readonly dismissBack: () => void
  readonly t: AppFrameProps['t']
  /** Current frame width in px, passed to the right column's fullscreen panel. */
  readonly viewport: number
}

/**
 * Render the mobile shell.
 * @param props - frame geometry, the rendered main panel, and the render/device shares.
 * @returns the mobile frame element tree.
 */
export function MobileFrame({
  frameRef, productTitle, main, renderSlot, useSessions, usePanelInfo, useStore, dismissBack, t, viewport,
}: MobileFrameProps): ReactNode {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const [drawerRecordHeld, setDrawerRecordHeld] = useState(false)
  const surfaceShown = useStore(state => state.layoutInfo.rightbarShown)

  // The occupant mounts on the first open and stays mounted: a surface the
  // drawer hands off (Settings) keeps its state while the drawer slides away,
  // and the closed layer is inert and hidden from assistive technology.
  useEffect(() => {
    if (drawerOpen) setDrawerMounted(true)
  }, [drawerOpen])

  const closeDrawer = useCallback(() => { setDrawerOpen(false) }, [])
  const closeOverflow = useCallback(() => { setOverflowOpen(false) }, [])
  const restoreChrome = useCallback(() => { setImmersive(false) }, [])
  // The drawer's history record outlives its close by one task. A control
  // inside the drawer can open a dismissal surface of its own (Settings), and
  // a commit releases cleanups before it installs setups: dropping the
  // drawer's record in that same commit steps its history entry off under the
  // surface that just registered, and the resulting popstate dismisses it.
  useEffect(() => {
    if (drawerOpen) { setDrawerRecordHeld(true); return undefined }
    const timer = window.setTimeout(() => { setDrawerRecordHeld(false) }, 0)
    return () => { window.clearTimeout(timer) }
  }, [drawerOpen])
  useBackHandler('ui-layout:mobile-drawer', closeDrawer, drawerOpen || drawerRecordHeld)
  useBackHandler('ui-layout:mobile-overflow', closeOverflow, overflowOpen)
  useBackHandler('ui-layout:mobile-immersive', restoreChrome, immersive)

  // The header's back affordance renders while the shell owns a dismissal:
  // the drawer, the overflow sheet, the immersive fold, or a shown right
  // surface (which registers its own handler one step down the stack).
  const hasSurface = drawerOpen || overflowOpen || immersive || surfaceShown
  const title = useSessions((state) => {
    const current = Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)
    return current?.title ?? current?.displayTitle
  })
  const globalPanel = usePanelInfo(info => info.activePanelId !== null)

  // Edge swipe: from the left edge while closed, and back across the drawer
  // while open. Touch pointers only; a gesture that drifts vertically is a
  // scroll and is dropped for the rest of its lifetime.
  const swipe = useRef<SwipeState | null>(null)
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return
    const opening = !drawerOpen && event.clientX <= EDGE_SWIPE_ZONE
    const closing = drawerOpen
    if (!opening && !closing) return
    swipe.current = { pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, opening, rejected: false }
  }, [drawerOpen])
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const held = swipe.current
    if (held === null || held.pointerId !== event.pointerId || held.rejected) return
    const dx = event.clientX - held.originX
    const dy = event.clientY - held.originY
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_VERTICAL_RATIO) { swipe.current = null; return }
    if (held.opening && dx >= SWIPE_MIN_TRAVEL) { swipe.current = null; setDrawerOpen(true) }
    if (!held.opening && dx <= -SWIPE_MIN_TRAVEL) { swipe.current = null; setDrawerOpen(false) }
  }, [])
  const onPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (swipe.current?.pointerId === event.pointerId) swipe.current = null
  }, [])
  // A tap on a control or a navigation row inside the drawer acts and dismisses
  // the drawer: it is a menu over the content, not a column that stays open.
  const onDrawerAct = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, a, [role="button"], [role="treeitem"]') !== null) closeDrawer()
  }, [closeDrawer])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-mobile-frame=""
      data-mobile-immersive={immersive || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <header className={css.header} data-mobile-header="">
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('mobile.navigation')}
          data-mobile-nav-toggle=""
          onClick={() => { setDrawerOpen(true) }}
        >
          <IconPanelLeftOutlineMedium size={18} />
        </button>
        <div className={css.title} data-mobile-title="">{globalPanel ? productTitle : title ?? productTitle}</div>
        <div className={css.headerSeat} data-mobile-header-seat="">
          {renderSlot('shell.mobile.header', {})}
        </div>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('mobile.surfaces')}
          data-mobile-overflow-toggle=""
          onClick={() => { setOverflowOpen(true) }}
        >
          <IconEllipsisOutlineMedium size={16} />
        </button>
        {hasSurface && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('back')}
            data-mobile-back=""
            onClick={() => { dismissBack() }}
          >
            <IconChevronLeftOutlineRegular size={16} />
          </button>
        )}
      </header>
      <main className={css.content} data-mobile-content="">{main}</main>
      <nav className={css.bar} aria-label={t('mobile.surfaces')} data-mobile-bar="">
        <div className={css.barItems}>{renderSlot('shell.mobile.bar', {})}</div>
        <button
          type="button"
          className={css.barButton}
          aria-label={t('mobile.fullscreen')}
          data-mobile-immersive-toggle=""
          onClick={() => { setImmersive(true) }}
        >
          <IconFullscreenOutlineMedium size={16} />
        </button>
      </nav>
      {immersive && (
        <button
          type="button"
          className={css.immersiveRestore}
          aria-label={t('mobile.exitFullscreen')}
          data-mobile-immersive-restore=""
          onClick={restoreChrome}
        />
      )}
      {/* The occupant anchors a fixed fullscreen panel to the frame; nothing here positions it. */}
      {renderSlot('rightbar', { width: viewport, viewportWidth: viewport, canShow: true, mobile: true })}
      <div className={css.drawerLayer} data-mobile-drawer={drawerOpen ? 'open' : 'closed'} aria-hidden={!drawerOpen}>
        <div className={css.scrim} aria-hidden="true" data-mobile-scrim="" onClick={closeDrawer} />
        <aside className={css.drawer} data-mobile-drawer-panel="" onClick={onDrawerAct}>
          {drawerMounted && renderSlot('sidebar', { collapsed: false, width: MOBILE_DRAWER_WIDTH })}
        </aside>
      </div>
      <div className={css.overlayLayer}>{renderSlot('shell.overlay', {})}</div>
      <Sheet
        open={overflowOpen}
        onClose={closeOverflow}
        title={t('mobile.surfaces')}
        closeLabel={t('close')}
        surfaceId="ui-layout:mobile-overflow"
      >
        <div className={css.overflowList} data-mobile-overflow="">{renderSlot('shell.mobile.more', {})}</div>
      </Sheet>
    </div>
  )
}
