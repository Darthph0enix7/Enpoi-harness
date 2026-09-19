// enpoi: this whole module is the fork's per-session surface persistence; upstream keeps every column in memory.
/**
 * Per-session storage of the right column's surface.
 *
 * One versioned key holds every session's column: the docking layout, the
 * editor pane's record, and each tab's navigation record. A session's store
 * instance reads its own entry when it is minted and writes it back debounced,
 * so a reload restores the column the operator left — per session.
 *
 * Everything read passes validation: a foreign or malformed payload means
 * "nothing stored", a tab whose kind no longer has a registered definition is
 * dropped, and the session and tab counts are clamped. Reading never throws;
 * an empty column is worth more than a stored copy that cannot be drawn.
 */
import type {
  FloatRect, LayoutNode, LayoutState, NodeId, PaneId, PaneNode, SplitId, SplitNode, TabId, TabRecord,
} from '@deepseek-ai/dsh-client-ui-dockkit'
import { EMPTY_HISTORY } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabNavigation } from './contract/slots.ts'
import type { SurfaceState } from './stores.ts'

/** Device-local storage key for every session's right-column surface. */
export const SURFACES_STORAGE_KEY = 'dsh.sidebar-right.surfaces.v1'

/** Payload generation; any other version is foreign and not read. */
const SURFACE_VERSION = 1

/** Most sessions one payload keeps; the least recently written entries fall away first. */
export const SURFACE_SESSION_LIMIT = 20

/** Most tabs one session's stored layout keeps. */
export const SURFACE_TAB_LIMIT = 30

/** One session's restored column: its surface plus what each tab was navigated to. */
export interface StoredSurface {
  /** The surface to seed a fresh store with. */
  readonly surface: SurfaceState
  /** Tab id to the navigation the previous page recorded; the Tab domain seeds from it. */
  readonly navigation: Readonly<Record<string, SidebarRightTabNavigation>>
  /** When this record last changed, in epoch milliseconds; 0 for a record stored before the field existed. */
  readonly updatedAt: number
}

/** One session's record as the server's opaque `surface` slot carries it. */
export interface SurfaceEnvelope {
  /** The serialized column: layout, id counter, editor record, and navigation. */
  readonly value: unknown
  /** When the record last changed; the slot's own revision time, which orders concurrent edits. */
  readonly updatedAt: number
}

/** How a session's surface reaches storage and comes back; `SurfaceStorage` is the product implementation. */
export interface SurfacePersistence {
  /**
   * The validated column stored for one session.
   * @param sessionId - the session to read.
   * @returns the restored surface and its navigation records, or `undefined` when nothing usable is stored.
   */
  read(sessionId: string): StoredSurface | undefined
  /**
   * Merge one session's committed column into storage, dropping the oldest sessions past the cap.
   * An unchanged record is not written again and keeps its revision time.
   * @param sessionId - the session being written.
   * @param surface - its committed surface.
   * @param navigation - its live tab navigation records.
   * @returns the record as the server's opaque `surface` slot carries it.
   */
  write(sessionId: string, surface: SurfaceState, navigation: Readonly<Record<string, SidebarRightTabNavigation>>): SurfaceEnvelope
  /**
   * Drop one session's stored column; the session was pruned.
   * @param sessionId - the session being dropped.
   */
  clear(sessionId: string): void
  /**
   * The record one session's server slot carries, validated into what a store may adopt.
   * @param value - the slot's raw value: an envelope, or a bare record from a writer without one.
   * @param fallbackUpdatedAt - revision time for a bare record, generally the response's record time.
   * @returns the restored surface and navigation, or `undefined` when the slot holds nothing usable.
   */
  readRemote(value: unknown, fallbackUpdatedAt: number): StoredSurface | undefined
  /**
   * Write an adopted remote record into local storage, keeping its revision time.
   * @param sessionId - the session the record belongs to.
   * @param stored - the validated record to cache.
   */
  cache(sessionId: string, stored: StoredSurface): void
  /**
   * The record one session currently has stored, as the server's slot carries it.
   * @param sessionId - the session to read.
   * @returns the envelope, or `undefined` when nothing usable is stored.
   */
  payload(sessionId: string): SurfaceEnvelope | undefined
}

/** A plain JSON object, as storage may hand one back. */
type UnknownRecord = Record<string, unknown>

/**
 * The revision time a stored record carries, or 0 when it has none.
 * @param value - the stored `updatedAt`.
 * @returns the epoch milliseconds.
 */
function storedUpdatedAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * A stored record's content without its revision time, for change detection.
 * @param record - the stored session record.
 * @returns its JSON text minus `updatedAt`.
 */
function contentKey(record: UnknownRecord): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'updatedAt')))
}

/**
 * Whether a parsed value is a JSON object rather than an array, `null`, or a primitive.
 * @param value - the parsed value.
 * @returns whether it is a record.
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The stored sessions of a raw payload, oldest first.
 * @param raw - the storage entry, or `undefined` for none.
 * @returns the entries, or `undefined` for absent, malformed, or foreign payloads.
 */
function parseSessions(raw: string | undefined): readonly (readonly [string, unknown])[] | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A truncated or foreign entry is not JSON: nothing is stored as far as a reader is concerned.
    return undefined
  }
  if (!isRecord(parsed) || parsed.version !== SURFACE_VERSION || !isRecord(parsed.sessions)) return undefined
  return Object.entries(parsed.sessions)
}

/**
 * The tab records a stored map still has a registered type for, capped.
 * @param value - the stored `layout.tabs`.
 * @param isKnownKind - whether a kind has a registered definition.
 * @returns the kept records, keyed by tab id.
 */
function restoreTabs(value: UnknownRecord, isKnownKind: (kind: string) => boolean): Record<string, TabRecord> {
  const tabs: Record<string, TabRecord> = {}
  let kept = 0
  for (const [id, entry] of Object.entries(value)) {
    if (kept >= SURFACE_TAB_LIMIT) break
    if (!isRecord(entry) || entry.id !== id) continue
    const { kind, contentId, title } = entry
    if (typeof kind !== 'string' || typeof contentId !== 'string' || typeof title !== 'string') continue
    if (!isKnownKind(kind)) continue
    tabs[id] = { id: id as TabId, kind, contentId, title }
    kept += 1
  }
  return tabs
}

/**
 * A floating pane's rectangle, or `undefined` when the stored value is not one.
 * @param value - the stored `rect`.
 * @returns the rectangle.
 */
function restoreRect(value: unknown): FloatRect | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height } = value
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined
  if (typeof y !== 'number' || !Number.isFinite(y)) return undefined
  if (typeof width !== 'number' || !Number.isFinite(width)) return undefined
  if (typeof height !== 'number' || !Number.isFinite(height)) return undefined
  return { x, y, width, height }
}

/**
 * One pane, its tab list scrubbed to the records that survived and its active tab repaired.
 * @param id - the stored node key, which the node must echo.
 * @param value - the stored node.
 * @param tabs - the kept tab records.
 * @returns the pane, or `undefined` when the stored node is not a pane.
 */
function restorePane(id: string, value: UnknownRecord, tabs: Readonly<Record<string, TabRecord>>): PaneNode | undefined {
  const host = value.host === 'dock' || value.host === 'float' ? value.host : undefined
  if (host === undefined || !Array.isArray(value.tabs)) return undefined
  const tabIds = [...new Set(value.tabs.filter((entry): entry is string => typeof entry === 'string' && tabs[entry] !== undefined))]
  const activeTabId = typeof value.activeTabId === 'string' && tabIds.includes(value.activeTabId)
    ? value.activeTabId as TabId
    : tabIds[0] as TabId | undefined
  if (host === 'dock') return { kind: 'pane', id: id as PaneId, host, tabs: tabIds as TabId[], activeTabId, rect: undefined }
  const rect = restoreRect(value.rect)
  if (rect === undefined) return undefined
  return { kind: 'pane', id: id as PaneId, host, tabs: tabIds as TabId[], activeTabId, rect }
}

/**
 * One split, with its axis, children, and positive finite fractions.
 * @param id - the stored node key, which the node must echo.
 * @param value - the stored node.
 * @returns the split, or `undefined` when the stored node is not one.
 */
function restoreSplit(id: string, value: UnknownRecord): SplitNode | undefined {
  const axis = value.axis === 'row' || value.axis === 'column' ? value.axis : undefined
  if (axis === undefined || !Array.isArray(value.children) || !Array.isArray(value.sizes)) return undefined
  const { children, sizes } = value
  if (children.length < 2 || children.length !== sizes.length) return undefined
  if (!children.every((child): child is string => typeof child === 'string')) return undefined
  if (!sizes.every((size): size is number => typeof size === 'number' && Number.isFinite(size) && size > 0)) return undefined
  return { kind: 'split', id: id as SplitId, axis, children: children as NodeId[], sizes }
}

/**
 * The docked nodes reachable from the root without a cycle or a missing child.
 * @param rootId - the stored root key.
 * @param panes - the valid panes.
 * @param splits - the valid splits.
 * @returns the reachable node keys, or `undefined` when the root tree is broken.
 */
function collectDocked(
  rootId: string,
  panes: ReadonlyMap<string, PaneNode>,
  splits: ReadonlyMap<string, SplitNode>,
): ReadonlySet<string> | undefined {
  const kept = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): boolean => {
    if (kept.has(id)) return true
    if (visiting.has(id)) return false
    if (panes.has(id)) {
      kept.add(id)
      return true
    }
    const split = splits.get(id)
    if (split === undefined) return false
    visiting.add(id)
    const intact = split.children.every(child => visit(child))
    visiting.delete(id)
    if (!intact) return false
    kept.add(id)
    return true
  }
  return visit(rootId) ? kept : undefined
}

/**
 * The focused pane: the stored one when it survived, else the first docked pane, else the top float.
 * @param stored - the stored `activePaneId`.
 * @param docked - the reachable docked node keys.
 * @param panes - the valid panes.
 * @param floats - the surviving float pane ids.
 * @returns the pane id, or `undefined` when nothing can take focus.
 */
function restoreActivePane(
  stored: string,
  docked: ReadonlySet<string>,
  panes: ReadonlyMap<string, PaneNode>,
  floats: readonly PaneId[],
): PaneId | undefined {
  const survived = panes.has(stored) && (docked.has(stored) || floats.includes(stored as PaneId))
  if (survived) return stored as PaneId
  for (const id of docked) {
    if (panes.has(id)) return id as PaneId
  }
  return floats[0]
}

/**
 * A whole stored layout, repaired or rejected as foreign.
 * @param value - the stored `layout`.
 * @param isKnownKind - whether a kind has a registered definition.
 * @returns the layout to restore, or `undefined` when the stored value is not a drawable one.
 */
function restoreLayout(value: unknown, isKnownKind: (kind: string) => boolean): LayoutState | undefined {
  if (!isRecord(value)) return undefined
  const { nodes, tabs, rootId, floats, activePaneId, expanded, mode } = value
  if (!isRecord(nodes) || !isRecord(tabs)) return undefined
  if (typeof rootId !== 'string' || typeof activePaneId !== 'string') return undefined
  if (!Array.isArray(floats) || floats.some(entry => typeof entry !== 'string')) return undefined
  if (typeof expanded !== 'boolean' || (mode !== 'push' && mode !== 'fullscreen')) return undefined

  const keptTabs = restoreTabs(tabs, isKnownKind)
  const panes = new Map<string, PaneNode>()
  const splits = new Map<string, SplitNode>()
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node) || node.id !== id) continue
    if (node.kind === 'pane') {
      const pane = restorePane(id, node, keptTabs)
      if (pane !== undefined) panes.set(id, pane)
    } else if (node.kind === 'split') {
      const split = restoreSplit(id, node)
      if (split !== undefined) splits.set(id, split)
    }
  }

  const docked = collectDocked(rootId, panes, splits)
  if (docked === undefined) return undefined
  const floatIds: PaneId[] = []
  const floatPanes: PaneNode[] = []
  for (const id of floats) {
    const pane = panes.get(id as string)
    if (pane === undefined || pane.host !== 'float' || floatIds.includes(pane.id)) continue
    floatIds.push(pane.id)
    floatPanes.push(pane)
  }
  const restoredNodes: Record<string, LayoutNode> = {}
  for (const id of docked) {
    const node = panes.get(id) ?? splits.get(id)
    if (node !== undefined) restoredNodes[id] = node
  }
  for (const pane of floatPanes) restoredNodes[pane.id] = pane
  const active = restoreActivePane(activePaneId, docked, panes, floatIds)
  if (active === undefined) return undefined
  return {
    nodes: restoredNodes as LayoutState['nodes'],
    tabs: keptTabs as LayoutState['tabs'],
    rootId: rootId as LayoutState['rootId'],
    floats: floatIds,
    activePaneId: active,
    expanded,
    mode,
  }
}

/**
 * The tab navigation records whose tab survived, as the domain may seed them.
 * A record whose address disagrees with its tab is foreign and dropped.
 * @param value - the stored `navigation`.
 * @param tabs - the kept tab records.
 * @returns the records, keyed by tab id; empty for a foreign value.
 */
function restoreNavigation(
  value: unknown,
  tabs: Readonly<Record<string, TabRecord>>,
): Record<string, SidebarRightTabNavigation> {
  const navigation: Record<string, SidebarRightTabNavigation> = {}
  if (!isRecord(value)) return navigation
  let kept = 0
  for (const [id, entry] of Object.entries(value)) {
    if (kept >= SURFACE_TAB_LIMIT) break
    const tab = tabs[id]
    if (tab === undefined || !isRecord(entry)) continue
    if (entry.address !== tab.contentId) continue
    const { revision } = entry
    if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0) continue
    navigation[id] = {
      address: tab.contentId,
      params: entry.params as SidebarRightTabNavigation['params'],
      revision: Math.floor(revision),
    }
    kept += 1
  }
  return navigation
}

/**
 * The id counter a stored surface must resume from: the largest numeric suffix
 * in use, so a restored id can never be minted again.
 * @param ids - every restored tab and node id.
 * @returns the largest suffix, or zero.
 */
function maxIdCounter(ids: readonly string[]): number {
  let max = 0
  for (const id of ids) {
    const match = /(\d+)$/.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return max
}

/**
 * One session's stored record, validated into what a fresh store may adopt.
 * @param value - the stored session entry.
 * @param isKnownKind - whether a kind has a registered definition.
 * @returns the restored surface and navigation, or `undefined` when the entry is foreign.
 */
function restoreSession(value: unknown, isKnownKind: (kind: string) => boolean): StoredSurface | undefined {
  if (!isRecord(value)) return undefined
  const layout = restoreLayout(value.layout, isKnownKind)
  if (layout === undefined) return undefined
  const { minted, editorTabId } = value
  const storedMinted = typeof minted === 'number' && Number.isFinite(minted) && minted >= 0 ? Math.floor(minted) : 0
  const counter = Math.max(storedMinted, maxIdCounter([...Object.keys(layout.tabs), ...Object.keys(layout.nodes), ...layout.floats]))
  const editor = typeof editorTabId === 'string' && layout.tabs[editorTabId as TabId] !== undefined
    ? editorTabId as TabId
    : undefined
  return {
    // The sequence is not stored: its operations reference records a dropped
    // tab may have taken with it, and stepping into them would be a defect.
    surface: { layout, history: EMPTY_HISTORY, minted: counter, editorTabId: editor },
    navigation: restoreNavigation(value.navigation, layout.tabs),
    updatedAt: storedUpdatedAt(value.updatedAt),
  }
}

/**
 * One session's record as it is written: everything read needs, nothing more.
 * @param surface - the committed surface.
 * @param navigation - the live navigation records.
 * @returns the JSON-shaped record.
 */
function serializeSession(
  surface: SurfaceState,
  navigation: Readonly<Record<string, SidebarRightTabNavigation>>,
): UnknownRecord {
  return {
    layout: surface.layout,
    minted: surface.minted,
    ...surface.editorTabId === undefined ? {} : { editorTabId: surface.editorTabId },
    navigation,
  }
}

/**
 * The right column's per-session storage over one versioned key.
 *
 * Storage failures — private mode, quota, a foreign key — only disable
 * persistence; the in-memory column is never affected and reads never throw.
 */
export class SurfaceStorage implements SurfacePersistence {
  private readonly storage: Storage | undefined

  /**
   * @param isKnownKind - whether a tab kind still has a registered definition.
   * @param storage - the storage to use; defaults to this browser's `localStorage`, and persistence silently disables without one.
   */
  constructor(
    private readonly isKnownKind: (kind: string) => boolean,
    storage?: Storage,
  ) {
    this.storage = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  }

  /**
   * The validated column stored for one session.
   * @param sessionId - the session to read.
   * @returns the restored surface and navigation, or `undefined` when nothing usable is stored.
   */
  read(sessionId: string): StoredSurface | undefined {
    const sessions = parseSessions(this.readRaw())
    if (sessions === undefined) return undefined
    const record = new Map(sessions.slice(-SURFACE_SESSION_LIMIT)).get(sessionId)
    if (record === undefined) return undefined
    return restoreSession(record, this.isKnownKind)
  }

  /**
   * Merge one session's committed column into storage; the entry moves to the
   * newest position, so the cap drops the least recently written session.
   * An unchanged record is not written again and keeps its revision time.
   * @param sessionId - the session being written.
   * @param surface - its committed surface.
   * @param navigation - its live tab navigation records.
   * @returns the record as the server's opaque `surface` slot carries it.
   */
  write(sessionId: string, surface: SurfaceState, navigation: Readonly<Record<string, SidebarRightTabNavigation>>): SurfaceEnvelope {
    const raw = this.readRaw()
    const sessions = new Map<string, unknown>(parseSessions(raw) ?? [])
    const previous = sessions.get(sessionId)
    const value = serializeSession(surface, navigation)
    const updatedAt = isRecord(previous) && contentKey(previous) === contentKey(value)
      ? storedUpdatedAt(previous.updatedAt)
      : Date.now()
    sessions.delete(sessionId)
    sessions.set(sessionId, { ...value, updatedAt })
    this.persist(sessions, raw)
    return { value, updatedAt }
  }

  /**
   * Drop one session's stored column.
   * @param sessionId - the session being dropped.
   */
  clear(sessionId: string): void {
    const { storage } = this
    if (storage === undefined) return
    const sessions = parseSessions(this.readRaw())
    if (sessions === undefined) return
    const remaining = sessions.filter(([id]) => id !== sessionId)
    if (remaining.length === sessions.length) return
    try {
      if (remaining.length === 0) {
        storage.removeItem(SURFACES_STORAGE_KEY)
        return
      }
      storage.setItem(SURFACES_STORAGE_KEY, JSON.stringify({
        version: SURFACE_VERSION,
        sessions: Object.fromEntries(remaining.slice(-SURFACE_SESSION_LIMIT)),
      }))
    } catch {
      // Same non-fatal contract as write: cleanup that cannot run leaves the entry behind.
    }
  }

  /**
   * The record one session's server slot carries, validated into what a store may adopt.
   * @param value - the slot's raw value: an envelope, or a bare record from a writer without one.
   * @param fallbackUpdatedAt - revision time for a bare record, generally the response's record time.
   * @returns the restored surface and navigation, or `undefined` when the slot holds nothing usable.
   */
  readRemote(value: unknown, fallbackUpdatedAt: number): StoredSurface | undefined {
    if (!isRecord(value)) return undefined
    const wrapped = 'value' in value
    const restored = restoreSession(wrapped ? value.value : value, this.isKnownKind)
    if (restored === undefined) return undefined
    const revision = wrapped ? storedUpdatedAt(value.updatedAt) : 0
    return { ...restored, updatedAt: revision > 0 ? revision : storedUpdatedAt(fallbackUpdatedAt) }
  }

  /**
   * Write an adopted remote record into local storage, keeping its revision time
   * so the next open is instant and the next comparison stays honest.
   * @param sessionId - the session the record belongs to.
   * @param stored - the validated record to cache.
   */
  cache(sessionId: string, stored: StoredSurface): void {
    const raw = this.readRaw()
    const sessions = new Map<string, unknown>(parseSessions(raw) ?? [])
    sessions.delete(sessionId)
    sessions.set(sessionId, {
      ...serializeSession(stored.surface, stored.navigation),
      updatedAt: stored.updatedAt,
    })
    this.persist(sessions, raw)
  }

  /**
   * The record one session currently has stored, as the server's slot carries it.
   * @param sessionId - the session to read.
   * @returns the envelope, or `undefined` when nothing usable is stored.
   */
  payload(sessionId: string): SurfaceEnvelope | undefined {
    const sessions = parseSessions(this.readRaw())
    if (sessions === undefined) return undefined
    const record = new Map(sessions.slice(-SURFACE_SESSION_LIMIT)).get(sessionId)
    if (record === undefined) return undefined
    const stored = restoreSession(record, this.isKnownKind)
    if (stored === undefined) return undefined
    return { value: serializeSession(stored.surface, stored.navigation), updatedAt: stored.updatedAt }
  }

  /**
   * Write every session's record back under the versioned key, capped; an identical payload is left alone.
   * @param sessions - the records, oldest first.
   * @param raw - the storage entry as last read, for the unchanged check.
   */
  private persist(sessions: ReadonlyMap<string, unknown>, raw: string | undefined): void {
    const { storage } = this
    if (storage === undefined) return
    const payload = JSON.stringify({
      version: SURFACE_VERSION,
      sessions: Object.fromEntries([...sessions.entries()].slice(-SURFACE_SESSION_LIMIT)),
    })
    if (payload === raw) return
    try {
      storage.setItem(SURFACES_STORAGE_KEY, payload)
    } catch {
      // A full or unavailable store only disables persistence; the column stays in memory.
    }
  }

  /** The raw storage entry, or `undefined` when absent or unreadable. */
  private readRaw(): string | undefined {
    if (this.storage === undefined) return undefined
    try {
      return this.storage.getItem(SURFACES_STORAGE_KEY) ?? undefined
    } catch {
      // An unreadable storage (private mode) persists nothing; the column stays in memory.
      return undefined
    }
  }
}
