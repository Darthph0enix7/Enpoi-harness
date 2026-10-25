/**
 * Root-owned frame measurement, panel preferences, and presentation reports.
 * The registration supplies a fresh store and binds its actions to ctx.layout.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from './service.ts'
import type { RightbarPreference } from './columns.ts'
import {
  clampWidth, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/** Device-local storage key for the two column width preferences. */
const WIDTHS_KEY = 'dsh.client.layout.widths'

/** The column width preferences as they survive a reload. */
export interface LayoutWidths {
  /** Sidebar width in px; 0 collapses to the icon rail. */
  readonly sidebar: number
  /** Right panel width, or null while the panel follows the shipped default. */
  readonly rightbar: RightbarPreference | null
}

/**
 * The host record's width members. The right panel key exists only when some
 * client dragged one: a device that never dragged a right panel (a phone, a
 * fresh origin) must not erase the width another device chose.
 */
export interface HostLayoutWidths {
  readonly sidebar: number
  readonly rightbar?: RightbarPreference
}

/**
 * Read this origin's cached column widths. The record is deliberately not
 * clamped to the current frame: clamping a stored preference to a shrunken
 * window used to be persisted onward by the next sidebar gesture, which
 * shrank the operator's width for good. Bounds are applied where the width is
 * drawn ({@link resolveRightbarWidth}) and when a drag commits.
 * @returns the validated preferences, or the contract defaults.
 */
function readStoredWidths(): LayoutWidths {
  const defaults: LayoutWidths = { sidebar: 0, rightbar: null }
  if (typeof localStorage === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (raw === null) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaults
    const stored = parsed as { sidebar?: unknown; rightbar?: unknown }
    const sidebar = typeof stored.sidebar === 'number' && Number.isFinite(stored.sidebar)
      ? stored.sidebar === 0 ? 0 : clampWidth(stored.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
      : 0
    return { sidebar, rightbar: readStoredRightbar(stored.rightbar) }
  } catch {
    // A truncated or foreign entry is not a width: fall back to the defaults.
    return defaults
  }
}

/**
 * Validate one stored right panel preference. A legacy raw number is treated
 * as absent: the only automatic writer of that field was the first-open
 * default stamp, so a number cannot be told apart from an operator drag and
 * keeping it would pin the panel to a default we have since replaced.
 * @param value - the stored `rightbar` member.
 * @returns the validated preference, or null.
 */
function readStoredRightbar(value: unknown): RightbarPreference | null {
  if (typeof value !== 'object' || value === null) return null
  const { px, ratio } = value as { px?: unknown; ratio?: unknown }
  if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return null
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) return null
  return { px, ratio }
}

/**
 * Write the width preferences to this origin's storage. A storage failure
 * (quota, private mode) only disables the cache, never the layout.
 * @param widths - the committed record.
 */
function persistWidths(widths: LayoutWidths): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    // Storage failures leave the in-memory layout as the only record.
  }
}

/**
 * Transient layout preferences. Responsive concessions never rewrite widths;
 * the right panel's expanded state belongs to its occupant.
 */
type LayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: LayoutInfo
}

type LayoutInfo = {
  sidebar: number
  /** Last positive frame measurement; window width bootstraps the first render. */
  viewportWidth: number
  narrowExpanded: boolean
  /**
   * Dragged right panel width, or null while the panel follows the shipped
   * default. Resizing the frame and closing the panel preserve this
   * preference; opening the panel never creates one.
   */
  rightbar: RightbarPreference | null
  /**
   * Whether this page already committed a width gesture. A host preference
   * arriving after one is stale by definition: the gesture is the operator's
   * latest word, made against the frame in front of them.
   */
  widthsEdited: boolean
  /**
   * Whether the right panel is drawn at all, in either presentation.
   *
   * Derived chrome, not a source of truth: whether the right surface is
   * expanded is a recorded fact owned by that surface, reported here so the
   * frame can place the panel's resize handle. The occupant reports it; nothing
   * else writes it.
   */
  rightbarShown: boolean
  /**
   * Whether the normal panel width reserves a grid track, including beneath
   * fullscreen. Reported by the occupant; always false while hidden.
   */
  rightbarTrack: boolean
  /** Reported fullscreen presentation; hides the outer resize handle. */
  rightbarFullscreen: boolean
  /** Suppress transitions for a fullscreen exit until another geometry action. */
  rightbarInstant: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  setSidebar: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setViewportWidth: (draft: LayoutState, width: number) => void
  setRightbar: (draft: LayoutState, px: number) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
  adoptWidths: (draft: LayoutState, widths: HostLayoutWidths) => void
}

/** Host durability of the committed width record; the layout plugin supplies it at apply. */
export interface LayoutStoreOptions {
  /**
   * Receive each committed width gesture. Called after the local cache is
   * written, so a host failure never costs the first-paint value.
   * @param widths - the committed record.
   */
  readonly persistHost?: (widths: LayoutWidths) => void
}

/**
 * Create the layout panel store handle. For the sidebar the preference IS the
 * width, so closing it forgets its drag width — reopening restores the contract
 * default. The right panel follows the shipped slim default until the operator
 * drags it: opening and closing never record a width, and a stored preference
 * (local cache or host record) keeps its px + ratio pair. Drag writes clamp to
 * the current frame's range. Narrow sidebar toggles change only the expansion
 * override; opening the right panel clears that override.
 * @param options - host durability for the committed width record.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(options: LayoutStoreOptions = {}): EngineStoreHandle<LayoutState, LayoutActions>  {
  // The draft is revoked once the update commits, so the record handed to the
  // cache and the host is a plain copy, never a draft sub-object.
  const committed = (d: LayoutState): void => {
    const rightbar = d.layoutInfo.rightbar
    const widths: LayoutWidths = {
      sidebar: d.layoutInfo.sidebar,
      rightbar: rightbar === null ? null : { px: rightbar.px, ratio: rightbar.ratio },
    }
    persistWidths(widths)
    options.persistHost?.(widths)
  }
  const handle = defineStore({
    init: (): LayoutState => {
      const viewport = window.innerWidth
      const widths = readStoredWidths()
      return {
        panelInfo: { activePanelId: null },
        layoutInfo: {
          sidebar: widths.sidebar,
          viewportWidth: viewport,
          narrowExpanded: false,
          rightbar: widths.rightbar,
          widthsEdited: false,
          rightbarShown: false,
          rightbarTrack: false,
          rightbarFullscreen: false,
          rightbarInstant: false,
        },
      }
    },
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      setSidebar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        d.layoutInfo.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
        d.layoutInfo.widthsEdited = true
        committed(d)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
        else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : 0
        d.layoutInfo.widthsEdited = true
        committed(d)
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      // The frame measurement is not a width gesture: a stored px keeps its
      // ratio and is only scaled where it is drawn.
      setViewportWidth: (d, width: number) => {
        if (d.layoutInfo.viewportWidth === width) return
        d.layoutInfo.rightbarInstant = false
        if ((d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !== (width < SIDEBAR_AUTO_COLLAPSE)) {
          d.layoutInfo.narrowExpanded = false
        }
        d.layoutInfo.viewportWidth = width
      },
      setRightbar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        const viewport = Math.max(1, d.layoutInfo.viewportWidth)
        const width = clampWidth(px, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
        d.layoutInfo.rightbar = { px: width, ratio: width / viewport }
        d.layoutInfo.widthsEdited = true
        committed(d)
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        if (!d.layoutInfo.rightbarShown || d.layoutInfo.rightbarTrack !== track || d.layoutInfo.rightbarFullscreen !== fullscreen) {
          d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen && !fullscreen
        }
        if (!d.layoutInfo.rightbarShown && d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = false
        d.layoutInfo.rightbarShown = true
        d.layoutInfo.rightbarTrack = track
        d.layoutInfo.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d) => {
        if (d.layoutInfo.rightbarShown) d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen
        d.layoutInfo.rightbarShown = false
        d.layoutInfo.rightbarTrack = false
        d.layoutInfo.rightbarFullscreen = false
      },
      // The host record outranks this origin's cache, but never a gesture the
      // operator made while the read was in flight. A record without a right
      // panel member leaves the local width alone; the adopted value is
      // written to the local cache only, never mirrored back.
      adoptWidths: (d, widths: HostLayoutWidths) => {
        if (d.layoutInfo.widthsEdited) return
        d.layoutInfo.sidebar = widths.sidebar === 0 ? 0 : clampWidth(widths.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
        if (widths.rightbar !== undefined) d.layoutInfo.rightbar = widths.rightbar
        persistWidths({ sidebar: d.layoutInfo.sidebar, rightbar: d.layoutInfo.rightbar })
      },
    },
  })
  return handle
}
