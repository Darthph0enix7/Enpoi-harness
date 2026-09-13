/**
 * The one menu the tree opens: the row's 3-dots and its right-click both land
 * here.
 *
 * The list portals into `document.body` and positions itself fixed from the
 * gesture's coordinates, so neither the tree's scroller nor an ancestor's
 * overflow can crop it. Keyboard semantics are the menu's own: the first item
 * takes focus on open (and after the delete confirmation swaps the list),
 * Escape closes, outside pointerdown closes, and the caller owns returning
 * focus to the row.
 */
import { useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { MenuActionId, MenuState } from './menu.ts'
import css from './FilesBody.module.css'

/** One rendered item: the resolved label plus its action id. */
export interface RowMenuItem {
  /** The action this item runs. */
  readonly id: MenuActionId
  /** The localized label to show. */
  readonly label: string
  /** Draw as a destructive row. */
  readonly danger?: boolean
}

/**
 * Render the open menu.
 * @param props.menu - the open menu, for placement and alignment.
 * @param props.items - the resolved items, in order.
 * @param props.onSelect - the item click callback.
 * @param props.onClose - close request from Escape or an outside pointerdown.
 * @returns the portaled list.
 */
export function RowMenu({ menu, items, onSelect, onClose }: {
  menu: MenuState
  items: readonly RowMenuItem[]
  onSelect: (id: MenuActionId) => void
  onClose: () => void
}): ReactNode {
  const listRef = useRef<HTMLDivElement>(null)
  // Focus the first item on open and whenever the item set changes (the delete
  // confirmation replaces the focused row); a label-only swap keeps focus.
  const ids = items.map(item => item.id).join(' ')
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [ids])
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      // The listener lives only while the portaled list is mounted, so the ref
      // is set; the composed path catches the portaled node itself too.
      if (event.composedPath().includes(listRef.current as HTMLDivElement)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const buttons = Array.from((listRef.current as HTMLDivElement).querySelectorAll<HTMLButtonElement>('button'))
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (at < 0) return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])
  const style: CSSProperties = { left: menu.x, top: menu.y }
  return createPortal(
    <div
      ref={listRef}
      role="menu"
      className={clsx(css.menu, menu.align === 'end' && css.menuEnd)}
      style={style}
      data-files-menu
      onContextMenu={(event) => { event.preventDefault() }}
    >
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={clsx(css.menuItem, item.danger === true && css.menuDanger)}
          data-files-menu-item={item.id}
          onClick={() => { onSelect(item.id) }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
