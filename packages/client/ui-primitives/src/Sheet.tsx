import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutlineMedium } from './icons/index.tsx'
import { useBackHandler } from './back-stack.ts'
import { useDevice } from './device.ts'
import css from './Sheet.module.css'

/** Width ceiling under which pickers and dialogs take the sheet presentation. */
export const SHEET_MAX_WIDTH = 560

/**
 * Whether the current device takes the sheet presentation: a classified phone,
 * or any viewport at or below {@link SHEET_MAX_WIDTH}.
 * @returns true while a surface should present as a bottom sheet.
 */
export function useSheetPresentation(): boolean {
  const device = useDevice()
  return device.device === 'phone' || device.width <= SHEET_MAX_WIDTH
}

interface SheetBaseProps {
  /** Whether the sheet is presented. */
  open: boolean
  /** Dismiss path shared by the mask, Escape, the close button, and touch back. */
  onClose: () => void
  /** Accessible dialog name (aria-label in every mode). */
  title: string
  /** Optional supporting sentence under the title. */
  description?: string
  children?: ReactNode
  /** Sticky action row under the scrolling content. */
  footer?: ReactNode
  /** Extra class for the panel. */
  className?: string
  /** Extra class for the scrolling content region. */
  contentClassName?: string
  /** Back-stack surface id; distinguish surfaces that can nest (default `ui-primitives:sheet`). */
  surfaceId?: string
  /** Render children directly in the panel (no default header/close/body chrome). */
  headless?: boolean
}

type SheetProps = SheetBaseProps & (
  | { headless: true; closeLabel?: never }
  | { headless?: false; closeLabel: string }
)

/**
 * Present a modal surface as a bottom sheet on phone/tablet widths and as a
 * centered card on wider viewports. The panel is safe-area padded, lifts clear
 * of the soft keyboard through `--dsh-keyboard-inset`, and scrolls its own
 * content between a fixed header and footer. Escape, the mask, the close
 * button, and the touch back gesture all run `onClose`; focus is never moved
 * by the primitive, so a caller that must keep the composer caret alive owns
 * its `pointerdown` handling.
 * @param props.open - whether the sheet is presented.
 * @param props.onClose - dismissal action for mask, Escape, close, and back.
 * @param props.title - dialog heading (aria-label in every mode).
 * @param props.closeLabel - localized accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - scrolling body content.
 * @param props.footer - action row kept below the scrolling body.
 * @param props.surfaceId - back-stack surface id (default `ui-primitives:sheet`).
 * @param props.contentClassName - optional class for the scrolling region.
 * @param props.headless - render children directly in the panel (no default
 *   header/close/body chrome); mask, panel, Escape, and aria-label remain.
 * @returns null when closed; otherwise the portaled overlay tree.
 */
export function Sheet({
  open, onClose, title, closeLabel, description, children, footer,
  className, contentClassName, surfaceId = 'ui-primitives:sheet', headless = false,
}: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, onClose])
  // Touch devices route the browser back gesture into the same close.
  useBackHandler(surfaceId, onClose, open)

  if (!open) return null

  return createPortal((
    <div className={css.root} role="presentation" data-sheet-root="">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        className={clsx(css.panel, className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-dsh-list-surface=""
      >
        <span className={css.grabber} aria-hidden="true" />
        {headless
          ? children
          : (
            <>
              <div className={clsx(css.content, contentClassName)}>
                <div className={css.header}>
                  <h2 className={css.title}>{title}</h2>
                  <button type="button" className={css.close} aria-label={closeLabel} onClick={onClose}>
                    <IconCloseOutlineMedium size={14} />
                  </button>
                </div>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
