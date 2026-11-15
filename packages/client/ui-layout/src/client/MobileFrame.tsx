/**
 * Compact shell chrome. AppFrame owns the persistent frame root and the
 * persistent main/rightbar wrappers; this component contributes only the
 * chrome rows and modal layers inside that root, so switching between desktop
 * and compact never remounts the conversation or the right panel.
 *
 * The chrome owns the compact 48px header (navigation trigger, session title,
 * the extension seat the chat lane contributes its view pills to, the overflow
 * trigger, and one back affordance wired to the shared dismissal stack), the
 * bottom action bar (its entries arrive through the `shell.mobile.bar` seat),
 * the left column as a slide-over drawer with a scrim and an edge swipe, and
 * the shared overlay layer. The right column remains AppFrame's persistent
 * sibling and takes its fullscreen presentation from the owner props.
 *
 * Chrome visibility is stylesheet-owned: the keyboard attribute and the
 * landscape/short-viewport media queries fold the bar into the header overflow
 * without a re-render. The immersive fold zeroes the chrome geometry on the
 * root so a fullscreen right panel owns the complete frame.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react'
import {
  IconChevronDownOutlineMedium, IconChevronLeftOutlineRegular, IconChevronUpOutlineMedium,
  IconEllipsisOutlineMedium, IconPanelLeftOutlineMedium, Sheet, useBackHandler, useModalLayer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AppFrameProps } from './AppFrame.tsx'
import { markMobileShell, publishShellInsets } from './overlay-insets.ts'
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

/** Props the frame hands the compact chrome. */
export interface MobileFrameProps {
  /** The persistent frame root; chrome state and gestures attach to it. */
  readonly frameRef: RefObject<HTMLDivElement>
  readonly productTitle: string
  readonly renderSlot: AppFrameProps['renderSlot']
  readonly useSessions: AppFrameProps['useSessions']
  readonly usePanelInfo: AppFrameProps['usePanelInfo']
  readonly useStore: AppFrameProps['useStore']
  /** Dismiss the top surface on the shared back stack. */
  readonly dismissBack: () => void
  readonly t: AppFrameProps['t']
  /** Current frame width in px, used for the shell overlay insets. */
  readonly viewport: number
}

/**
 * Render the compact chrome fragment inside AppFrame's persistent root.
 * @param props - frame geometry, the render/device shares, and localization.
 * @returns the header, bar, drawer, and overlay layers.
 */
export function MobileFrame({
  frameRef, productTitle, renderSlot, useSessions, usePanelInfo, useStore, dismissBack, t, viewport,
}: MobileFrameProps): ReactNode {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const [drawerRecordHeld, setDrawerRecordHeld] = useState(false)
  const overflowDialog = useRef<HTMLDivElement | null>(null)
  const surfaceShown = useStore(state => state.layoutInfo.rightbarShown)

  // Publish the compact shell's overlay-safe geometry on the root (portalled
  // chips cannot see the frame's own variables): the open drawer pushes them
  // right, the compact right surface is fullscreen so it marks the root
  // covered, and the stylesheet supplies the bar height as the bottom inset.
  // Layout effect: the persistent right panel reads these variables before the
  // first paint of the compact shell.
  useLayoutEffect(() => {
    const root = document.documentElement
    const cleanMobile = markMobileShell(root)
    const cleanInsets = publishShellInsets(root, {
      left: drawerOpen ? MOBILE_DRAWER_WIDTH : 0,
      right: surfaceShown ? viewport : 0,
      covered: surfaceShown,
    })
    return () => {
      cleanInsets()
      cleanMobile()
    }
  }, [drawerOpen, surfaceShown, viewport])

  // The occupant mounts on the first open and stays mounted: a surface the
  // drawer hands off (Settings) keeps its state while the drawer slides away,
  // and the closed layer is inert and hidden from assistive technology.
  useEffect(() => {
    if (drawerOpen) setDrawerMounted(true)
  }, [drawerOpen])

  const closeDrawer = useCallback(() => { setDrawerOpen(false) }, [])
  const closeOverflow = useCallback(() => { setOverflowOpen(false) }, [])
  const openMore = useCallback(() => { setOverflowOpen(true) }, [])
  const selectSurface = useCallback((_kind: string) => { setOverflowOpen(false) }, [])
  const restoreChrome = useCallback(() => { setImmersive(false) }, [])
  // The Sheet itself never owns focus; this compact caller adds the dialog
  // layer only for its own More sheet. Entry focus goes to the first control,
  // Tab stays inside, and every close path restores the control that opened it.
  useModalLayer(overflowDialog, overflowOpen, closeOverflow)
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
  useBackHandler('ui-layout:mobile-immersive', restoreChrome, immersive)

  // Escape restores the chrome while immersive; the header's back affordance
  // is hidden with the header, so the floating restore control and Escape are
  // the two keyboard/pointer paths back to the chrome.
  useEffect(() => {
    if (!immersive) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      restoreChrome()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [immersive, restoreChrome])

  // Project the immersive state on both the frame (header/bar hiding) and the
  // root (zeroed chrome geometry for portalled overlays and the fullscreen
  // right panel). The layout effect applies it before paint.
  useLayoutEffect(() => {
    const frame = frameRef.current
    /* v8 ignore next -- the persistent frame root is attached before this chrome mounts. */
    if (frame === null) return undefined
    const root = document.documentElement
    if (immersive) {
      frame.setAttribute('data-mobile-immersive', '')
      root.setAttribute('data-mobile-immersive', '')
    } else {
      frame.removeAttribute('data-mobile-immersive')
      root.removeAttribute('data-mobile-immersive')
    }
    return () => {
      frame.removeAttribute('data-mobile-immersive')
      root.removeAttribute('data-mobile-immersive')
    }
  }, [frameRef, immersive])

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
  // scroll and is dropped for the rest of its lifetime. The listeners attach
  // to AppFrame's persistent root because this component contributes no root.
  const swipe = useRef<SwipeState | null>(null)
  useEffect(() => {
    const frame = frameRef.current
    /* v8 ignore next -- the persistent frame root is attached before this chrome mounts. */
    if (frame === null) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      const opening = !drawerOpen && event.clientX <= EDGE_SWIPE_ZONE
      const closing = drawerOpen
      if (!opening && !closing) return
      swipe.current = { pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, opening, rejected: false }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const held = swipe.current
      if (held === null || held.pointerId !== event.pointerId || held.rejected) return
      const dx = event.clientX - held.originX
      const dy = event.clientY - held.originY
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_VERTICAL_RATIO) { swipe.current = null; return }
      if (held.opening && dx >= SWIPE_MIN_TRAVEL) { swipe.current = null; setDrawerOpen(true) }
      if (!held.opening && dx <= -SWIPE_MIN_TRAVEL) { swipe.current = null; setDrawerOpen(false) }
    }
    const onPointerEnd = (event: PointerEvent): void => {
      if (swipe.current?.pointerId === event.pointerId) swipe.current = null
    }
    frame.addEventListener('pointerdown', onPointerDown)
    frame.addEventListener('pointermove', onPointerMove)
    frame.addEventListener('pointerup', onPointerEnd)
    frame.addEventListener('pointercancel', onPointerEnd)
    return () => {
      frame.removeEventListener('pointerdown', onPointerDown)
      frame.removeEventListener('pointermove', onPointerMove)
      frame.removeEventListener('pointerup', onPointerEnd)
      frame.removeEventListener('pointercancel', onPointerEnd)
      swipe.current = null
    }
  }, [drawerOpen, frameRef])

  // A tap on a control or a navigation row inside the drawer acts and dismisses
  // the drawer: it is a menu over the content, not a column that stays open.
  const onDrawerAct = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, a, [role="button"], [role="treeitem"]') !== null) closeDrawer()
  }, [closeDrawer])

  return (
    <>
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
          aria-haspopup="dialog"
          aria-expanded={overflowOpen}
          data-mobile-overflow-toggle=""
          onClick={openMore}
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
      <nav className={css.bar} aria-label={t('mobile.surfaces')} data-mobile-bar="">
        <div className={css.barItems}>
          {renderSlot('shell.mobile.bar', {
            open: overflowOpen, openMore, dismiss: closeOverflow, onSelect: selectSurface,
          })}
        </div>
        <button
          type="button"
          className={css.barButton}
          aria-label={t('mobile.hideControls')}
          data-mobile-immersive-toggle=""
          onClick={() => { setImmersive(true) }}
        >
          <IconChevronDownOutlineMedium size={16} />
        </button>
      </nav>
      {immersive && (
        <button
          type="button"
          className={css.immersiveRestore}
          aria-label={t('mobile.showControls')}
          data-mobile-immersive-restore=""
          onClick={restoreChrome}
        >
          <IconChevronUpOutlineMedium size={18} />
        </button>
      )}
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
        dialogRef={overflowDialog}
      >
        <div className={css.overflowList} data-mobile-overflow="">
          {renderSlot('shell.mobile.more', {
            open: overflowOpen, openMore, dismiss: closeOverflow, onSelect: selectSurface,
          })}
        </div>
      </Sheet>
    </>
  )
}
