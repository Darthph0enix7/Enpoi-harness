/**
 * The redirect's display-type memory.
 *
 * The unified document pane resolves a tab's display type from the viewer
 * preferences stored under `dsh.client.documentPreview.viewerPrefs`, owned by
 * `ui-sidebar-documentpreview`; this package may not import its values, so the
 * one by-path write the `enpoi-editor` redirect needs is repeated here against
 * the same documented key. A foreign or malformed store is treated as empty,
 * and every failure keeps the choice in memory only.
 */

/** The storage key `ui-sidebar-documentpreview` owns; keep in step with it. */
const VIEWER_PREFS_KEY = 'dsh.client.documentPreview.viewerPrefs'

/**
 * Remember one file's display type by exact path, the `byPath` bucket that
 * outranks the suffix bucket when the document pane resolves its renderer.
 * @param path - the decoded file path the choice is keyed by.
 * @param rendererId - the chosen implementation id.
 */
export function rememberViewerByPath(path: string, rendererId: string): void {
  let source: Storage
  try {
    if (typeof localStorage === 'undefined') return
    source = localStorage
  } catch {
    // A page with storage blocked reads and writes nothing.
    return
  }
  try {
    const raw = source.getItem(VIEWER_PREFS_KEY)
    const parsed = raw === null ? {} : JSON.parse(raw) as { byExtension?: unknown; byPath?: unknown }
    const byPath: Record<string, string> = {}
    if (typeof parsed.byPath === 'object' && parsed.byPath !== null) {
      for (const [key, entry] of Object.entries(parsed.byPath as Record<string, unknown>)) {
        if (typeof entry === 'string') byPath[key] = entry
      }
    }
    const byExtension = typeof parsed.byExtension === 'object' && parsed.byExtension !== null
      ? parsed.byExtension
      : {}
    byPath[path] = rendererId
    source.setItem(VIEWER_PREFS_KEY, JSON.stringify({ byExtension, byPath }))
  } catch {
    // Malformed JSON or a quota-blocked write keeps the redirect working; only
    // the remembered display type is lost.
  }
}
