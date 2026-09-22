// SwipeReveal: coarse-pointer destructive row action.
//
// The message row stays exactly as it renders today on fine pointers: the
// action layer is `display: none` outside `(pointer: coarse)` and the gesture
// ignores mouse pointers. On touch, a horizontal drag over the row slides the
// content aside and reveals a destructive control; choosing it arms an inline
// confirmation (confirm/cancel) so the destructive operation is never one
// accidental tap away. Vertical drags remain scrolling.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import css from './MessageItem.module.css'

/** Revealed strip width in px; also the content's travel at full reveal (kept in step with MessageItem.module.css). */
export const SWIPE_ACTION_WIDTH = 116

/** Horizontal travel (px) before the gesture claims the pointer from the scroller. */
const SWIPE_CLAIM_TRAVEL = 8

/** Vertical share of the gesture above which it is a scroll, not a swipe. */
const SWIPE_VERTICAL_RATIO = 0.7

/** Share of the strip the drag must cross to commit the reveal instead of snapping back. */
const SWIPE_COMMIT_SHARE = 0.45

/** One tracked touch gesture on the row. */
interface SwipeDrag {
  readonly pointerId: number
  readonly originX: number
  readonly originY: number
  /** Whether the horizontal claim threshold was crossed and the row follows the finger. */
  claimed: boolean
}

export interface SwipeRevealProps {
  /** The row content that slides aside. */
  children: ReactNode
  /** Destructive control copy on the revealed strip. */
  actionLabel: string
  /** Confirmation control copy after the destructive control is chosen. */
  confirmLabel: string
  /** Dismiss control copy that disarms a pending confirmation. */
  cancelLabel: string
  /** Runs after the destructive action is explicitly confirmed. */
  onConfirm: () => void
}

/**
 * Wrap one chat row in a touch-only swipe-to-reveal destructive action.
 * @param props - row content, localized control copy, and the confirmed action.
 * @returns the row wrapper with its hidden action layer.
 */
export function SwipeReveal({
  children, actionLabel, confirmLabel, cancelLabel, onConfirm,
}: SwipeRevealProps): ReactNode {
  const [revealed, setRevealed] = useState(false)
  const [armed, setArmed] = useState(false)
  const [dragX, setDragX] = useState(0)
  const drag = useRef<SwipeDrag | null>(null)

  const close = useCallback((): void => {
    setRevealed(false)
    setArmed(false)
    setDragX(0)
    drag.current = null
  }, [])

  useEffect(() => {
    if (!revealed && !armed) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [armed, close, revealed])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse') return
    // A tap outside the revealed controls dismisses the strip before it acts.
    if (revealed && event.target instanceof Element && event.target.closest(`.${css.swipeAction}`) === null) {
      close()
      return
    }
    drag.current = { pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, claimed: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (held === null || held.pointerId !== event.pointerId) return
    const dx = event.clientX - held.originX
    const dy = event.clientY - held.originY
    if (!held.claimed) {
      if (Math.abs(dy) > Math.abs(dx) * SWIPE_VERTICAL_RATIO) {
        drag.current = null
        return
      }
      if (dx > -SWIPE_CLAIM_TRAVEL) return
      held.claimed = true
      // jsdom exposes no pointer capture; in the browser it keeps the drag
      // alive when the finger leaves the row.
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId)
      }
    }
    const base = revealed ? -SWIPE_ACTION_WIDTH : 0
    setDragX(Math.max(-SWIPE_ACTION_WIDTH, Math.min(0, base + dx)))
  }

  const settle = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    if (held === null || held.pointerId !== event.pointerId) return
    drag.current = null
    if (!held.claimed) return
    const committed = dragX <= -SWIPE_ACTION_WIDTH * SWIPE_COMMIT_SHARE
    setRevealed(committed)
    setArmed(false)
    setDragX(0)
  }

  const offset = revealed ? -SWIPE_ACTION_WIDTH : 0
  return (
    <div
      className={css.swipeRow}
      data-swipe-reveal=""
      data-revealed={revealed || undefined}
      data-dragging={dragX !== 0 || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={settle}
      onPointerCancel={settle}
    >
      <div
        className={css.swipeContent}
        style={dragX === 0 && offset === 0 ? undefined : { transform: `translateX(${String(dragX === 0 ? offset : dragX)}px)` }}
      >
        {children}
      </div>
      <div className={css.swipeAction} data-swipe-action="" data-open={revealed || undefined}>
        {armed
          ? (
            <>
              <button
                type="button"
                className={css.swipeConfirm}
                onClick={() => { close(); onConfirm() }}
              >
                {confirmLabel}
              </button>
              <button type="button" className={css.swipeCancel} onClick={close}>{cancelLabel}</button>
            </>
          )
          : (
            <button type="button" className={css.swipeDestructive} onClick={() => { setArmed(true) }}>
              {actionLabel}
            </button>
          )}
      </div>
    </div>
  )
}
