/**
 * The row menu's state machine and item table.
 *
 * The transitions are asserted on their own terms: open replaces any earlier
 * menu, close is total, the delete confirmation exists only for rows, and the
 * copied label records and clears. The item table is checked per target kind
 * and phase, because those lists are the menu's contract with the routes.
 */
import { describe, expect, it } from 'vitest'
import { MENU_LABEL_KEYS, menuItemsOf, menuReducer } from '../src/client/menu.ts'
import type { MenuState, RootTarget, RowTarget } from '../src/client/menu.ts'

const FILE: RowTarget = { kind: 'file', path: '/w/a.txt' }
const DIR: RowTarget = { kind: 'directory', path: '/w/src' }
const ROOT: RootTarget = { kind: 'root', path: '/w' }

/** One open menu, for the item-table checks. */
function opened(target: MenuState['target']): MenuState {
  const state = menuReducer(null, { type: 'open', target, x: 1, y: 2, align: 'start' })
  if (state === null) throw new Error('open must yield a menu')
  return state
}

describe('menuReducer', () => {
  it('opens with the actions phase, and a second open replaces the first', () => {
    const state = menuReducer(null, { type: 'open', target: FILE, x: 5, y: 6, align: 'end' })
    expect(state).toEqual({ target: FILE, x: 5, y: 6, align: 'end', phase: 'actions', copied: null })
    const replaced = menuReducer(state, { type: 'open', target: ROOT, x: 1, y: 2, align: 'start' })
    expect(replaced).toMatchObject({ target: ROOT, phase: 'actions', copied: null })
  })

  it('closes, and ignores every transition once closed', () => {
    expect(menuReducer(null, { type: 'close' })).toBeNull()
    expect(menuReducer(null, { type: 'ask-delete' })).toBeNull()
    expect(menuReducer(null, { type: 'copied', action: 'copy-path' })).toBeNull()
    expect(menuReducer(null, { type: 'copied-clear' })).toBeNull()
    expect(menuReducer(opened(FILE), { type: 'close' })).toBeNull()
  })

  it('asks for the delete confirmation only from a row', () => {
    const confirming = menuReducer(opened(FILE), { type: 'ask-delete' })
    expect(confirming?.phase).toBe('confirm-delete')
    const root = opened(ROOT)
    expect(menuReducer(root, { type: 'ask-delete' })).toBe(root)
  })

  it('records the copied action and clears it', () => {
    const copied = menuReducer(opened(DIR), { type: 'copied', action: 'copy-relative' })
    expect(copied?.copied).toBe('copy-relative')
    expect(menuReducer(copied, { type: 'copied-clear' })?.copied).toBeNull()
  })
})

describe('menuItemsOf', () => {
  it('offers the file actions, the directory actions, and the root actions', () => {
    expect(menuItemsOf(opened(FILE))).toEqual([
      'open', 'download', 'rename', 'delete', 'copy-path', 'copy-relative',
    ])
    expect(menuItemsOf(opened(DIR))).toEqual([
      'new-file', 'new-folder', 'rename', 'delete', 'copy-path', 'copy-relative',
    ])
    expect(menuItemsOf(opened(ROOT))).toEqual(['new-file', 'new-folder', 'refresh'])
  })

  it('shows only the confirmation while confirming', () => {
    const confirming = menuReducer(opened(FILE), { type: 'ask-delete' })!
    expect(menuItemsOf(confirming)).toEqual(['delete-confirm'])
  })

  it('names a locale key for every action', () => {
    expect(Object.keys(MENU_LABEL_KEYS).sort()).toEqual([
      'copy-path', 'copy-relative', 'delete', 'delete-confirm', 'download',
      'new-file', 'new-folder', 'open', 'refresh', 'rename',
    ])
  })
})
