/**
 * Normal column geometry: the right column shrinks, then loses its track,
 * before the center drops below its minimum. The sidebar never concedes here;
 * AppFrame supplies its effective preference after responsive collapse.
 */

/** Resolved widths for one frame. */
export interface Columns { sidebar: number; center: number; rightbar: number }

/** Center width protected while the normal right column is open. */
export const CENTER_MIN = 400
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Right column drag clamp floor. */
export const RIGHTBAR_MIN = 300
/** Maximum normal right panel width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7
/** Fraction of the frame the shipped right panel takes on a large frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.22
/** Px the shipped right panel adds beyond the default left sidebar. */
export const RIGHTBAR_DEFAULT_GAP = 96
/** Widest the shipped right panel grows without a drag; a wide monitor must not read as a split screen. */
export const RIGHTBAR_DEFAULT_MAX = 420

/**
 * One stored right panel width: the dragged pixels and the frame ratio they
 * were dragged at. Keeping both lets another frame scale the panel instead of
 * adopting a stale absolute width, while the dragged px still wins on the
 * frame it was chosen on.
 */
export interface RightbarPreference {
  /** Width in px on the frame this preference was dragged on. */
  readonly px: number
  /** {@link px} divided by that frame's width; a different frame scales by this. */
  readonly ratio: number
}

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * The shipped right panel width: a little wider than the default left sidebar,
 * growing with the frame up to a fixed ceiling, so first open reads as a slim
 * side panel at 1280, 1920, and 2560 alike.
 * @param viewport - current frame width in px.
 * @returns the default width, never below {@link RIGHTBAR_MIN}.
 */
export function defaultRightbarWidth(viewport: number): number {
  return clampWidth(
    Math.max(SIDEBAR_DEFAULT + RIGHTBAR_DEFAULT_GAP, viewport * RIGHTBAR_DEFAULT_RATIO),
    RIGHTBAR_MIN,
    RIGHTBAR_DEFAULT_MAX,
  )
}

/**
 * The right panel width to draw on one frame.
 *
 * A stored preference is scaled by the frame width, so resizing the window
 * keeps the panel's share of the screen; the dragged px wins on the frame it
 * was dragged on (the ratio rounds back to it there). Bound by the same 300px
 * floor and 70% ceiling a drag applies.
 * @param preference - the stored preference, or null while the panel follows the shipped default.
 * @param viewport - current frame width in px.
 * @returns the resolved width in px.
 */
export function resolveRightbarWidth(preference: RightbarPreference | null, viewport: number): number {
  const max = Math.max(RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO)
  if (preference === null) return clampWidth(defaultRightbarWidth(viewport), RIGHTBAR_MIN, max)
  // Both members are validated above zero at every boundary that stores one.
  const captured = preference.px / preference.ratio
  const px = Math.abs(captured - viewport) <= 1 ? preference.px : preference.ratio * viewport
  return clampWidth(px, RIGHTBAR_MIN, max)
}

/**
 * Solve the three column widths for one viewport frame.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param rightbar - requested right panel width in px (0 = no track).
 * @param collapsedWidth - track width of the closed sidebar; the default keeps
 *   the icon rail, 0 hides the column entirely (macOS desktop).
 * @returns actual widths after shrinking or removing the right track; only
 *   without that track may the center fall below its minimum, down to zero.
 */
export function computeColumns(viewport: number, sidebar: number, rightbar: number, collapsedWidth = SIDEBAR_COLLAPSED): Columns {
  const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const available = viewport - s - CENTER_MIN
  const r = rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
  return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r }
}
