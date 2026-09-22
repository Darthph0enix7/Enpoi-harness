/**
 * Persisted display-type choices for the document preview.
 *
 * A reader's pick is a UI preference, not host settings: it lives in this
 * browser's `localStorage` under {@link VIEWER_PREFS_KEY} as `{ byExtension,
 * byPath }`. Resolution reads the in-memory tab choice first, then `byPath`,
 * then `byExtension`, then the automatic candidate; a manual pick updates the
 * suffix bucket so it follows every file of that kind.
 */

/** The one key this module reads and writes. */
export const VIEWER_PREFS_KEY = 'dsh.client.documentPreview.viewerPrefs'

/** Persisted display-type choices, split by suffix and by exact path. */
export interface ViewerPrefs {
  /** Chosen implementation id per normalized suffix. */
  readonly byExtension: Readonly<Record<string, string>>
  /** Chosen implementation id per decoded file path; outranks the suffix bucket. */
  readonly byPath: Readonly<Record<string, string>>
}

/** The empty preference set an unavailable or malformed store reads as. */
const EMPTY: ViewerPrefs = { byExtension: {}, byPath: {} }

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
 * Read only the string-valued entries of one persisted bucket.
 * @param value - the parsed bucket, of unknown shape.
 * @returns the entries whose values are strings.
 */
function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

/**
 * Read the persisted display-type choices.
 * @returns the parsed preferences, or the empty set when absent or malformed.
 */
export function readViewerPrefs(): ViewerPrefs {
  const source = storage()
  if (source === undefined) return EMPTY
  try {
    const raw = source.getItem(VIEWER_PREFS_KEY)
    if (raw === null) return EMPTY
    const parsed = JSON.parse(raw) as { byExtension?: unknown; byPath?: unknown }
    return { byExtension: stringRecord(parsed.byExtension), byPath: stringRecord(parsed.byPath) }
  } catch {
    // Malformed JSON or a blocked read is a preference miss, never a preview failure.
    return EMPTY
  }
}

/**
 * The normalized suffix a path's preference is keyed by.
 * @param path - decoded file path or basename; `\` is accepted as a separator.
 * @returns the lowercased suffix without a leading dot, or `''` when there is none.
 */
export function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : ''
}

/**
 * Remember one manual display-type choice for a suffix.
 * @param path - the picker's file path, whose suffix keys the choice.
 * @param id - the chosen implementation id.
 */
export function rememberViewerByExtension(path: string, id: string): void {
  const extension = extensionOf(path)
  if (extension === '') return
  const source = storage()
  if (source === undefined) return
  try {
    const current = readViewerPrefs()
    const byExtension = { ...current.byExtension, [extension]: id }
    source.setItem(VIEWER_PREFS_KEY, JSON.stringify({ byExtension, byPath: current.byPath }))
  } catch {
    // A quota or blocked write keeps the in-memory choice; it just will not survive a reload.
  }
}

/**
 * Remember one manual display-type choice for an exact path, the bucket that
 * outranks the suffix choice. The `enpoi-editor` redirect writes this key from
 * its own package, so the two must keep the same shape.
 * @param path - the decoded file path the choice is keyed by.
 * @param id - the chosen implementation id.
 */
export function rememberViewerByPath(path: string, id: string): void {
  const source = storage()
  if (source === undefined) return
  try {
    const current = readViewerPrefs()
    const byPath = { ...current.byPath, [path]: id }
    source.setItem(VIEWER_PREFS_KEY, JSON.stringify({ byExtension: current.byExtension, byPath }))
  } catch {
    // A quota or blocked write keeps the in-memory choice; it just will not survive a reload.
  }
}
