/**
 * Root-owned frame measurement, panel preferences, and presentation reports.
 * The registration supplies a fresh store and binds its actions to ctx.layout.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from './service.ts'
import type { RightbarPreference } from './columns.ts'
import {
  clampWidth, renderedRightbarWidth, resolveRightbarWidth,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
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

/** This origin's cached widths, with the presence of each written preference. */
interface StoredWidths {
  readonly widths: LayoutWidths
  /** A valid sidebar width was written on this origin. */
  readonly sidebarLocal: boolean
  /** A valid right-panel preference was written on this origin. */
  readonly rightbarLocal: boolean
}

/**
 * Read this origin's cached column widths. The record is deliberately not
 * clamped to the current frame: clamping a stored preference to a shrunken
 * window used to be persisted onward by the next sidebar gesture, which
 * shrank the operator's width for good. Bounds are applied where the width is
 * drawn ({@link resolveRightbarWidth}) and when a drag commits.
 *
 * The returned presence flags are the local-authority marker. They are
 * derived from the existing record shape rather than a timestamp or a new
 * persisted member: a valid written width is a local preference, and the host
 * record may seed only a field this origin has not written.
 * @returns the validated preferences and which of them are local.
 */
function readStoredWidths(): StoredWidths {
  const defaults: StoredWidths = {
    widths: { sidebar: 0, rightbar: null },
    sidebarLocal: false,
    rightbarLocal: false,
  }
  if (typeof localStorage === 'undefined') return defaults
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (raw === null) return defaults
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaults
    const stored = parsed as { sidebar?: unknown; rightbar?: unknown }
    const sidebar = readStoredSidebar(stored.sidebar)
    const rightbar = readStoredRightbar(stored.rightbar)
    return {
      widths: { sidebar: sidebar ?? 0, rightbar },
      sidebarLocal: sidebar !== undefined,
      rightbarLocal: rightbar !== null,
    }
  } catch {
    // A truncated or foreign entry is not a width: fall back to the defaults.
    return defaults
  }
}

/**
 * Validate one stored sidebar width. A valid number, including 0 for the
 * collapsed rail, is a local preference; anything else is absent.
 * @param value - the stored `sidebar` member.
 * @returns the clamped width, or undefined when the member is not a width.
 */
function readStoredSidebar(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value === 0 ? 0 : clampWidth(value, SIDEBAR_MIN, SIDEBAR_MAX)
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
   * This origin has a written sidebar width (cache or gesture). The host
   * record seeds this field only while it is false; a local preference is the
   * device's authority and is never replaced by another device's record.
   */
  sidebarLocal: boolean
  /**
   * This origin has a written right-panel preference (cache or gesture). The
   * host record seeds this field only while it is false; after a local drag or
   * seed, other devices cannot force their width onto this one.
   */
  rightbarLocal: boolean
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
 * The sidebar preference the frame will actually lay out on the current
 * report. Mirrors AppFrame's responsive branch: a narrow frame uses the manual
 * override, while a wide frame uses the width preference (0 = collapsed).
 * @param info - current frame layout state.
 * @returns the effective sidebar width preference in px.
 */
function frameSidebarPreference(info: LayoutInfo): number {
  const narrow = info.viewportWidth < SIDEBAR_AUTO_COLLAPSE
  const collapsed = narrow ? !info.narrowExpanded : info.sidebar === 0
  const preference = collapsed ? 0 : info.sidebar === 0 ? SIDEBAR_DEFAULT : info.sidebar
  return !info.rightbarShown && narrow ? 0 : preference
}

/**
 * Track width of the closed sidebar for the current shell. This mirrors the
 * AppFrame platform branch: macOS desktop and Windows titlebar shells hide the
 * rail, every other shell keeps {@link SIDEBAR_COLLAPSED} px.
 * @returns the collapsed-sidebar track width in px.
 */
function collapsedSidebarWidth(): number {
  if (typeof document === 'undefined') return SIDEBAR_COLLAPSED
  return document.documentElement.dataset.platform === 'darwin'
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED
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
 * drags it: opening and closing never record a width, and this origin's cache
 * is the width authority. The host record seeds only fields that have no local
 * preference, so another device's width cannot replace this device's choice.
 * A drag stores the width the frame actually renders, not the requested width
 * that the sidebar and center reserves may shrink. Narrow sidebar toggles
 * change only the expansion override; a normal tracked right panel opening on a
 * narrow frame clears that override only when it fits with the collapsed rail.
 * @param options - host durability for the committed width record.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(options: LayoutStoreOptions = {}): EngineStoreHandle<LayoutState, LayoutActions>  {
  // The draft is revoked once the update commits, so the record handed to the
  // cache and the host is a plain copy, never a draft sub-object.
  const committed = (d: LayoutState): void => {
    d.layoutInfo.sidebarLocal = true
    d.layoutInfo.rightbarLocal = d.layoutInfo.rightbar !== null
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
      const stored = readStoredWidths()
      return {
        panelInfo: { activePanelId: null },
        layoutInfo: {
          sidebar: stored.widths.sidebar,
          viewportWidth: viewport,
          narrowExpanded: false,
          rightbar: stored.widths.rightbar,
          sidebarLocal: stored.sidebarLocal,
          rightbarLocal: stored.rightbarLocal,
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
        committed(d)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (d.layoutInfo.viewportWidth < SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
        else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : 0
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
        if (!Number.isFinite(px)) return
        d.layoutInfo.rightbarInstant = false
        const viewport = Math.max(1, d.layoutInfo.viewportWidth)
        // Record the width the frame actually draws, not the requested value
        // that the sidebar/center reserves may shrink. Otherwise a narrow
        // frame stores an unrealizable share and a later wider frame inherits
        // the overcommit.
        const width = renderedRightbarWidth(
          viewport,
          frameSidebarPreference(d.layoutInfo),
          Math.max(1, Math.round(px)),
          collapsedSidebarWidth(),
        )
        if (!(width > 0)) return
        d.layoutInfo.rightbar = { px: width, ratio: width / viewport }
        committed(d)
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        if (!d.layoutInfo.rightbarShown || d.layoutInfo.rightbarTrack !== track || d.layoutInfo.rightbarFullscreen !== fullscreen) {
          d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen && !fullscreen
        }
        // Only a normal tracked opening on a narrow frame may consume the
        // left sidebar's manual expansion: it is the one report that asks the
        // left column to give up room, and only when the panel fits with the
        // collapsed rail. Fullscreen/overlay reports leave the override alone.
        const viewport = Math.max(1, d.layoutInfo.viewportWidth)
        const trackFits = renderedRightbarWidth(
          viewport,
          0,
          resolveRightbarWidth(d.layoutInfo.rightbar, viewport),
          collapsedSidebarWidth(),
        ) > 0
        // A normal track that cannot fit even with the collapsed left rail
        // must not report an opening. Fullscreen/overlay can still cover the
        // frame; the caller owns the compact presentation.
        if (!d.layoutInfo.rightbarShown && track && !fullscreen && !trackFits) return
        if (!d.layoutInfo.rightbarShown && viewport < SIDEBAR_AUTO_COLLAPSE && track && !fullscreen && trackFits) {
          d.layoutInfo.narrowExpanded = false
        }
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
      // The local cache is this device's width authority. The host record is a
      // seed for fields this origin has not written: another device's width
      // must not replace a local preference. Seeded values are written to the
      // local cache only, never mirrored back to the host.
      adoptWidths: (d, widths: HostLayoutWidths) => {
        let changed = false
        if (!d.layoutInfo.sidebarLocal) {
          d.layoutInfo.sidebar = widths.sidebar === 0 ? 0 : clampWidth(widths.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
          d.layoutInfo.sidebarLocal = true
          changed = true
        }
        if (!d.layoutInfo.rightbarLocal && widths.rightbar !== undefined) {
          d.layoutInfo.rightbar = widths.rightbar
          d.layoutInfo.rightbarLocal = true
          changed = true
        }
        if (changed) persistWidths({ sidebar: d.layoutInfo.sidebar, rightbar: d.layoutInfo.rightbar })
      },
    },
  })
  return handle
}
