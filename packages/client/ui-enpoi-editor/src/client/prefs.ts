/**
 * The auto-save preference, persisted per browser.
 *
 * Editing behavior is a UI preference, not host settings: it lives in this
 * browser's `localStorage` under {@link AUTOSAVE_KEY} as the strings `'on'` and
 * `'off'`. An absent or unreadable value reads as on — auto-save is the default.
 */

/** The one key this module reads and writes. */
export const AUTOSAVE_KEY = 'dsh.editor.autosave'

/**
 * The browser store, or `undefined` where the page has none.
 * @returns `localStorage` when it is callable, otherwise nothing.
 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    // A page with storage blocked reads and writes nothing; the choice stays in memory.
    return undefined
  }
}

/**
 * Read the persisted auto-save choice.
 * @returns `false` only when the store explicitly holds `'off'`.
 */
export function readAutosavePref(): boolean {
  return storage()?.getItem(AUTOSAVE_KEY) !== 'off'
}

/**
 * Persist the auto-save choice.
 * @param on - whether auto-save is wanted.
 */
export function writeAutosavePref(on: boolean): void {
  try {
    storage()?.setItem(AUTOSAVE_KEY, on ? 'on' : 'off')
  } catch {
    // A quota or blocked write keeps the in-memory choice; it just will not survive a reload.
  }
}
