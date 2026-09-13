// enpoi: this whole module is the fork's icon-rail state; upstream has no rail.
/**
 * The right column's icon rail: which icon is lit, whether the panel is open,
 * and how wide the editor pane beside it is.
 *
 * One instance per browser, owned by the root controller and persisted by the
 * store engine, because the rail is global: it sits beside every session's
 * panel, and a switch from a session into a subagent session must not close
 * the panel, drop the chosen page, or reseed the editor.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The persisted rail facts. */
export interface SidebarRightRailState {
  /** Whether the panel is open; only an explicit operator gesture flips this. */
  readonly open: boolean
  /** The lit page kind; `null` until the first choice, resolved to the first rail item. */
  readonly kind: string | null
  /** The editor pane's width in px. */
  readonly editorWidth: number
}

/** Where the state is restored from on reload. */
const STORAGE_KEY = 'dsh.client.sidebarRight.rail'

/** Editor pane width before any drag. */
export const EDITOR_WIDTH_DEFAULT = 420

/** Narrowest editor pane a drag may leave. */
export const EDITOR_WIDTH_MIN = 200

/** Widest editor pane a drag may leave. */
export const EDITOR_WIDTH_MAX = 960

/**
 * Clamp an editor width into its contract range.
 * @param px - requested width.
 * @returns the clamped width.
 */
export function clampEditorWidth(px: number): number {
  return Math.min(EDITOR_WIDTH_MAX, Math.max(EDITOR_WIDTH_MIN, Math.round(px)))
}

/** Root-owned rail preferences shared by the panel seat, the rail, and the corner expand button. */
export class SidebarRightRail {
  /** The observable state; components read it through the inject hook compartment. */
  readonly state: SnapshotStore<SidebarRightRailState>

  /**
   * Build the rail over the persisted state, normalizing whatever an older
   * generation stored before any reader sees it.
   */
  constructor() {
    this.state = createSnapshotStore<SidebarRightRailState>(
      { open: true, kind: null, editorWidth: EDITOR_WIDTH_DEFAULT },
      { persist: { name: STORAGE_KEY } },
    )
    const stored = this.state.getSnapshot()
    this.state.set({
      open: typeof stored.open === 'boolean' ? stored.open : true,
      kind: typeof stored.kind === 'string' ? stored.kind : null,
      editorWidth: typeof stored.editorWidth === 'number' && Number.isFinite(stored.editorWidth)
        ? clampEditorWidth(stored.editorWidth)
        : EDITOR_WIDTH_DEFAULT,
    })
  }

  /**
   * Record the panel's open intent.
   * @param open - whether the panel should be open.
   */
  setOpen(open: boolean): void {
    this.state.set({ ...this.state.getSnapshot(), open })
  }

  /**
   * Light a kind and open the panel on it.
   * @param kind - the page kind the rail selected.
   */
  setKind(kind: string): void {
    this.state.set({ ...this.state.getSnapshot(), kind, open: true })
  }

  /**
   * Record the editor pane's width.
   * @param px - the dragged width.
   */
  setEditorWidth(px: number): void {
    this.state.set({ ...this.state.getSnapshot(), editorWidth: clampEditorWidth(px) })
  }
}
