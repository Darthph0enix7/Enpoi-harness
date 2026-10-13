/**
 * Overlay-safe geometry the frames publish on the document root. Overlay
 * chips (the update pill, the system-analysis chip, the feedback pipeline
 * chip) portal to `document.body`, so they cannot inherit the frame's own CSS
 * variables; the root is the one node both the frame and a body portal share.
 * A fullscreen right surface marks the root covered so every chip hides
 * rather than sitting over it.
 * @module @deepseek-ai/dsh-client-ui-layout/client/overlay-insets
 */

/** CSS variable naming the left rail/column footprint in px. */
export const SHELL_INSET_LEFT_VAR = '--dsh-shell-inset-left'

/** CSS variable naming the right panel footprint in px. */
export const SHELL_INSET_RIGHT_VAR = '--dsh-shell-inset-right'

/** CSS variable naming the bottom chrome (mobile action bar) footprint. */
export const SHELL_INSET_BOTTOM_VAR = '--dsh-shell-inset-bottom'

/** Root attribute present while a fullscreen panel covers the frame. */
export const SHELL_COVERED_ATTR = 'data-shell-covered'

/** Root attribute present while the mobile shell owns the viewport. */
export const MOBILE_SHELL_ATTR = 'data-mobile-shell'

/** One frame's overlay-safe geometry. */
export interface ShellInsets {
  /** Left rail/column footprint in px. */
  readonly left: number
  /** Right panel footprint in px (its viewport width when it hangs over the centre). */
  readonly right: number
  /**
   * Bottom chrome footprint; the mobile shell leaves this undefined and lets
   * its stylesheet resolve `--dsh-shell-inset-bottom` from the bar height.
   */
  readonly bottom?: string
  /** Whether a fullscreen panel covers the frame outright. */
  readonly covered: boolean
}

/**
 * Publish one frame's insets on `root`.
 *
 * @param root - the shared root element (`document.documentElement`).
 * @param insets - the frame's current geometry.
 * @returns the cleanup that removes every published value.
 */
export function publishShellInsets(root: HTMLElement, insets: ShellInsets): () => void {
  root.style.setProperty(SHELL_INSET_LEFT_VAR, `${String(insets.left)}px`)
  root.style.setProperty(SHELL_INSET_RIGHT_VAR, `${String(insets.right)}px`)
  if (insets.bottom !== undefined) root.style.setProperty(SHELL_INSET_BOTTOM_VAR, insets.bottom)
  root.toggleAttribute(SHELL_COVERED_ATTR, insets.covered)
  return () => {
    root.style.removeProperty(SHELL_INSET_LEFT_VAR)
    root.style.removeProperty(SHELL_INSET_RIGHT_VAR)
    root.style.removeProperty(SHELL_INSET_BOTTOM_VAR)
    root.removeAttribute(SHELL_COVERED_ATTR)
  }
}

/**
 * Mark the root as the mobile shell (its stylesheet owns the bar-height inset).
 *
 * @param root - the shared root element.
 * @returns the cleanup that removes the marker.
 */
export function markMobileShell(root: HTMLElement): () => void {
  root.setAttribute(MOBILE_SHELL_ATTR, '')
  return () => { root.removeAttribute(MOBILE_SHELL_ATTR) }
}
