/**
 * Browser client for the profile's fenced `/sidebar/fsops` JSON routes the file
 * tree's row actions call: create, mkdir, rename, delete, download, and the
 * operator document listing.
 *
 * The routes are same-origin and carry the fenced envelope: a JSON POST whose
 * answer is `{ok: true, value}` or `{ok: false, error: {code, message}}` with a
 * matching HTTP status. Paths are workspace-relative or absolute; the host
 * resolves relative paths against the session's cwd. `list` exists only for
 * the operator document view: the route grants the settings document's own
 * directory and refuses every other path. This copy serves only this package —
 * a plugin bundle shares runtime code through the module table, never through
 * another feature package's values.
 */
import type { DirLevel } from './store.ts'

/** One fenced-route failure, carrying the envelope's code and the HTTP status. */
export class FsOpsError extends Error {
  /**
   * @param code - the envelope's error code, or `network`/`http`/`malformed` for transport failures.
   * @param message - the envelope's message, or the transport failure's.
   * @param status - the HTTP status; `0` when the request never completed.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'FsOpsError'
  }
}

/** One downloaded file: base64 bytes plus the name to save them under. */
export interface DownloadPayload {
  /** The file's bytes, base64-encoded. */
  readonly base64: string
  /** The file's size in bytes. */
  readonly size: number
  /** The file's basename, as the host reports it. */
  readonly name: string
}

/** The file operations the tree's row actions call. */
export interface FsOps {
  /**
   * Create one empty file, refusing an existing name.
   * @param sessionId - the session whose workspace resolves a relative parent.
   * @param parent - the directory that will hold the file.
   * @param name - the new file's basename.
   */
  create(sessionId: string, parent: string, name: string): Promise<void>
  /**
   * Create one directory, parents included.
   * @param sessionId - the session whose workspace resolves a relative parent.
   * @param parent - the directory that will hold the new directory.
   * @param name - the new directory's basename.
   */
  mkdir(sessionId: string, parent: string, name: string): Promise<void>
  /**
   * Rename one entry, refusing to overwrite an existing target.
   * @param sessionId - the session whose workspace resolves relative paths.
   * @param from - the entry's current path.
   * @param to - the entry's new path.
   */
  rename(sessionId: string, from: string, to: string): Promise<void>
  /**
   * Move one entry to the trash; the route never deletes in place.
   * @param sessionId - the session whose workspace resolves a relative path.
   * @param path - the entry to move to the trash.
   */
  delete(sessionId: string, path: string): Promise<void>
  /**
   * Read one file's bytes as base64, for a browser-side save.
   * @param sessionId - the session whose workspace resolves a relative path.
   * @param path - the file to read.
   * @returns the bytes, size, and basename.
   */
  download(sessionId: string, path: string): Promise<DownloadPayload>
  /**
   * List one directory through the operator document grant.
   * @param sessionId - the session whose cwd resolves a relative path.
   * @param path - the directory to list; the route refuses anything outside
   *   the settings document's directory.
   * @param signal - aborts the request when the tab record disappears.
   * @returns the direct entries and whether the route cut the listing.
   */
  list(sessionId: string, path: string, signal?: AbortSignal): Promise<DirLevel>
}

/** The envelope both success and failure answers share. */
interface Envelope<T> {
  readonly ok?: boolean
  readonly value?: T
  readonly error?: { readonly code?: string; readonly message?: string }
}

/**
 * Create the fsops client over a fetch implementation.
 * @param request - the fetch to use; defaults to the page's global `fetch`.
 * @returns the file operations the row menu consumes.
 */
export function createFsOps(request: typeof fetch = fetch): FsOps {
  const call = async <T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T | undefined> => {
    let response: Response
    try {
      response = await request(`/sidebar/fsops/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new FsOpsError('network', failureMessage(error), 0)
    }
    const parsed = await response.json().catch(() => null) as Envelope<T> | null
    if (!response.ok || parsed === null || parsed.ok !== true) {
      throw new FsOpsError(
        parsed?.error?.code ?? 'http',
        parsed?.error?.message ?? `HTTP ${response.status}`,
        response.status,
      )
    }
    return parsed.value
  }
  return {
    create: async (sessionId, parent, name) => { await call('fs.create', { sessionId, parent, name }) },
    mkdir: async (sessionId, parent, name) => { await call('fs.mkdir', { sessionId, parent, name }) },
    rename: async (sessionId, from, to) => { await call('fs.rename', { sessionId, from, to }) },
    delete: async (sessionId, path) => { await call('fs.delete', { sessionId, path }) },
    download: async (sessionId, path) => {
      const value = await call<DownloadPayload>('fs.download', { sessionId, path })
      if (value === undefined) throw new FsOpsError('malformed', 'download answered no value', 200)
      return value
    },
    list: async (sessionId, path, signal) => {
      const value = await call<{ path: string; entries: DirLevel['entries']; truncated: boolean }>('fs.list', { sessionId, path }, signal)
      if (value === undefined) throw new FsOpsError('malformed', 'list answered no value', 200)
      return { entries: value.entries, truncated: value.truncated }
    },
  }
}

/**
 * Message of an unknown thrown value, for inline failure lines.
 * @param error - the thrown value.
 * @returns an `Error`'s message, or the value stringified.
 */
export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Save one downloaded file: decode the base64 to a Blob, click a temporary
 * `download` anchor holding an object URL, then release the URL.
 * @param payload - the bytes and the basename the host reported.
 */
export function saveDownload(payload: DownloadPayload): void {
  const binary = atob(payload.base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  const url = URL.createObjectURL(new Blob([bytes]))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payload.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
