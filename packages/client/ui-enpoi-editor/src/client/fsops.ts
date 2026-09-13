/**
 * Browser client for the profile's fenced `/sidebar/fsops` JSON routes.
 *
 * The routes are same-origin and fenced by the host's browser-auth/trust
 * fence; every call is a JSON POST whose envelope is `{ok: true, value}` or
 * `{ok: false, error: {code, message}}` with a matching HTTP status. `fs.read`
 * refuses binary content, `fs.write` answers `409 conflict` when the file no
 * longer matches `expectedSha`, and `fs.stat` is the cheap poll the editor runs
 * while its tab is visible.
 */

/** One wire failure, carrying the envelope's code and the HTTP status. */
export class FsOpsError extends Error {
  /**
   * @param code - the envelope's error code, or `network`/`http` for transport failures.
   * @param message - the envelope's message.
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

  /** Whether this failure means the file no longer exists. */
  get notFound(): boolean {
    return this.code === 'not-found' || this.status === 404
  }

  /** Whether this failure means the file changed since it was read. */
  get conflict(): boolean {
    return this.code === 'conflict' || this.status === 409
  }
}

/** One full-file read: the text plus the baseline the next save checks against. */
export interface FileSnapshot {
  /** The UTF-8 file content; a truncated read holds only the prefix. */
  readonly content: string
  /** SHA-256 of the FULL file (not of a truncated prefix). */
  readonly sha256: string
  /** Last modification time, ms since the epoch. */
  readonly mtimeMs: number
  /** Full file size in bytes. */
  readonly size: number
  /** Whether the content is only the first part of a larger file. */
  readonly truncated: boolean
}

/** The cheap stat the external-change watcher polls. */
export interface FileStat {
  /** Last modification time, ms since the epoch. */
  readonly mtimeMs: number
  /** File size in bytes. */
  readonly size: number
}

/** What a successful write reports; fields are absent only for a plain-text peer. */
export interface WriteAck {
  /** SHA-256 of the written bytes, when the route reports it. */
  readonly sha256: string | undefined
  /** Post-write modification time, when the route reports it. */
  readonly mtimeMs: number | undefined
  /** Post-write size in bytes, when the route reports it. */
  readonly size: number | undefined
}

/** The file operations one editor body uses, injectable for tests. */
export interface EditorFsOps {
  /**
   * Read one file through the session's workspace.
   * @param sessionId - the session whose workspace resolves a relative path.
   * @param path - the address's absolute or workspace-relative path.
   * @param signal - aborts the request when the tab record disappears.
   * @returns the text, digest, stat, and truncation flag.
   * @throws {FsOpsError} `not-found`, `not-text`, or a transport failure.
   */
  read(sessionId: string, path: string, signal?: AbortSignal): Promise<FileSnapshot>
  /**
   * Write one file, optionally expecting the digest last read.
   * @param sessionId - the session whose workspace contains the file.
   * @param path - the address's absolute or workspace-relative path.
   * @param content - the full replacement text.
   * @param expectedSha - the digest the write must still match; `undefined` forces the write.
   * @param signal - aborts the request when the tab record disappears.
   * @returns the route's digest/stat ack.
   * @throws {FsOpsError} `conflict` when the file changed, or a transport failure.
   */
  write(sessionId: string, path: string, content: string, expectedSha: string | undefined, signal?: AbortSignal): Promise<WriteAck>
  /**
   * Stat one file without reading it.
   * @param sessionId - the session whose workspace resolves a relative path.
   * @param path - the address's absolute or workspace-relative path.
   * @param signal - aborts the request when the tab record disappears.
   * @returns modification time and size.
   * @throws {FsOpsError} `not-found`, or a transport failure.
   */
  stat(sessionId: string, path: string, signal?: AbortSignal): Promise<FileStat>
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
 * @returns the file operations the editor body consumes.
 */
export function createFsOps(request: typeof fetch = fetch): EditorFsOps {
  const call = async <T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    let response: Response
    try {
      response = await request(`/sidebar/fsops/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new FsOpsError('network', error instanceof Error ? error.message : String(error), 0)
    }
    const parsed = await response.json().catch(() => null) as Envelope<T> | null
    if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
      throw new FsOpsError(
        parsed?.error?.code ?? 'http',
        parsed?.error?.message ?? `HTTP ${response.status}`,
        response.status,
      )
    }
    return parsed.value
  }
  return {
    read: (sessionId, path, signal) => call<FileSnapshot>('fs.read', { sessionId, path }, signal),
    write: (sessionId, path, content, expectedSha, signal) => call<WriteAck>('fs.write', {
      sessionId,
      path,
      content,
      // Absent `expectedSha` is the route's force-write form; never send `null`
      // (that spelling is a create-only request).
      ...(expectedSha === undefined ? {} : { expectedSha }),
    }, signal),
    stat: (sessionId, path, signal) => call<FileStat>('fs.stat', { sessionId, path }, signal),
  }
}
