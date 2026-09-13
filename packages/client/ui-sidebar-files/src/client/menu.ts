/**
 * The row menu's pure state machine.
 *
 * The tree opens one menu at a time — the same list whether the gesture was the
 * row's 3-dots or a right-click — so all of it is one small fold: which row it
 * acts on, where it sits, whether it is asking for a delete confirmation, and
 * which copy item just landed. The component owns the effects; this module owns
 * the transitions and the item table, so both are testable without a DOM.
 */
import type { SidebarFilesKey } from './locales.ts'

/** A tree row the menu can act on. */
export interface RowTarget {
  /** Whether the row is a file or a directory. */
  readonly kind: 'file' | 'directory'
  /** The row's absolute path. */
  readonly path: string
}

/** The root/empty area the menu can act on. */
export interface RootTarget {
  /** Discriminant: the empty area, not a row. */
  readonly kind: 'root'
  /** The absolute path of the workspace root. */
  readonly path: string
}

/** What one open menu acts on. */
export type MenuTarget = RowTarget | RootTarget

/** Every action the tree's menus offer. */
export type MenuActionId =
  | 'open'
  | 'download'
  | 'rename'
  | 'delete'
  | 'delete-confirm'
  | 'copy-path'
  | 'copy-relative'
  | 'new-file'
  | 'new-folder'
  | 'refresh'

/** Which horizontal edge of the gesture the list hangs from. */
export type MenuAlign = 'start' | 'end'

/** One open menu. */
export interface MenuState {
  /** The row or empty area the items act on. */
  readonly target: MenuTarget
  /** Viewport x of the gesture's anchor, in px. */
  readonly x: number
  /** Viewport y of the gesture's anchor, in px. */
  readonly y: number
  /** The edge the list hangs from: the cursor's or the 3-dots button's right edge. */
  readonly align: MenuAlign
  /** The list phase: the actions, or the delete confirmation they led to. */
  readonly phase: 'actions' | 'confirm-delete'
  /** The copy action whose "copied" label is showing, if any. */
  readonly copied: MenuActionId | null
}

/** Every transition the open menu accepts. */
export type MenuEvent =
  | { readonly type: 'open'; readonly target: MenuTarget; readonly x: number; readonly y: number; readonly align: MenuAlign }
  | { readonly type: 'close' }
  | { readonly type: 'ask-delete' }
  | { readonly type: 'copied'; readonly action: MenuActionId }
  | { readonly type: 'copied-clear' }

/**
 * Fold one menu event into the open menu.
 * @param state - the open menu, or `null` when none is.
 * @param event - the transition to apply.
 * @returns the next menu state, or `null` once closed.
 */
export function menuReducer(state: MenuState | null, event: MenuEvent): MenuState | null {
  switch (event.type) {
    case 'open':
      return { target: event.target, x: event.x, y: event.y, align: event.align, phase: 'actions', copied: null }
    case 'close':
      return null
    case 'ask-delete':
      // Only a row can be deleted; the empty area has no Delete item to ask from.
      return state === null || state.target.kind === 'root' ? state : { ...state, phase: 'confirm-delete' }
    case 'copied':
      return state === null ? null : { ...state, copied: event.action }
    case 'copied-clear':
      return state === null ? null : { ...state, copied: null }
  }
}

/**
 * The item ids one menu shows, in order.
 * @param state - the open menu.
 * @returns the item ids for its target kind and phase.
 */
export function menuItemsOf(state: MenuState): readonly MenuActionId[] {
  if (state.phase === 'confirm-delete') return ['delete-confirm']
  switch (state.target.kind) {
    case 'file':
      return ['open', 'download', 'rename', 'delete', 'copy-path', 'copy-relative']
    case 'directory':
      return ['new-file', 'new-folder', 'rename', 'delete', 'copy-path', 'copy-relative']
    case 'root':
      return ['new-file', 'new-folder', 'refresh']
  }
}

/** Locale key each menu action's label reads. */
export const MENU_LABEL_KEYS = {
  'open': 'menu.open',
  'download': 'menu.download',
  'rename': 'menu.rename',
  'delete': 'menu.delete',
  'delete-confirm': 'menu.deleteConfirm',
  'copy-path': 'menu.copyPath',
  'copy-relative': 'menu.copyRelative',
  'new-file': 'menu.newFile',
  'new-folder': 'menu.newFolder',
  'refresh': 'menu.refresh',
} satisfies Record<MenuActionId, SidebarFilesKey>
