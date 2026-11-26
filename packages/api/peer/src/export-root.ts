/**
 * Fixed per-session export root management, symlink-safe listing, and bounded
 * SHA-256-verified file fetch (`peer.exportList` / `peer.exportFetch`).
 *
 * Roots are fixed under the configured `exportRoot` (`<exportRoot>/<sessionId>`,
 * mode `0700`) and never derived from caller input. Every path component is
 * `lstatSync`-checked to refuse symlinks, traversal, non-regular files,
 * oversize reads, and concurrent size changes between stat and read. The hub
 * must still independently re-verify returned bytes and SHA-256 against its
 * job criteria.
 *
 * @module @deepseek-ai/dsh-api-peer/export-root
 */

import { createHash } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  type Stats,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerExportFetchValue, PeerExportFileEntry, PeerExportListValue } from './types.ts'

/** Default parent directory holding per-session `0700` worker export directories. */
export const DEFAULT_EXPORT_ROOT = dshHomePath('peer-exports')

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/u
const READ_CHUNK_BYTES = 64 * 1024
const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const LIST_MIN_RESPONSE_BYTES = Buffer.byteLength(JSON.stringify({ files: [], truncated: false }))

/**
 * Verify that `exportRoot` is safe to host per-session export directories.
 * Returns `false` if `exportRoot` itself is a symlink, a non-directory, or
 * contains a non-directory prefix.
 * @param exportRoot - configured export root path.
 * @returns true when `exportRoot` can serve `0700` per-session directories.
 */
export function checkExportRootAvailable(exportRoot: string): boolean {
  if (typeof exportRoot !== 'string' || exportRoot.length === 0 || exportRoot.includes('\u0000')) return false
  try {
    const stat = inspectExportRoot(exportRoot)
    let anchor = resolve(exportRoot)
    while (lstatSafe(anchor) === undefined) anchor = dirname(anchor)
    accessSync(anchor, constants.W_OK | constants.X_OK)
    return stat === undefined || stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve and verify the fixed per-session export directory path without
 * trusting caller input.
 * @param exportRoot - configured export root directory.
 * @param sessionId - bound worker session identifier.
 * @returns the per-session directory path.
 * @throws {@link RemoteError} `peer/forbidden` when `sessionId` is unsafe.
 */
export function sessionExportDirPath(exportRoot: string, sessionId: SessionId): string {
  if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new RemoteError('peer/forbidden', 'sessionId is not valid for an export directory', {
      reason: 'export-path-forbidden',
    })
  }
  return join(exportRoot, sessionId)
}

/**
 * Create `<exportRoot>/<sessionId>` with mode `0700`, refusing any symlink at
 * `exportRoot` or the session directory itself.
 * @param exportRoot - configured export root directory.
 * @param sessionId - newly created worker session identifier.
 * @returns path to the created `0700` session export directory.
 * @throws {@link RemoteError} `peer/forbidden` on symlink or `peer/unavailable` on filesystem failure.
 */
export function ensureSessionExportDir(exportRoot: string, sessionId: SessionId): string {
  const sessionDir = sessionExportDirPath(exportRoot, sessionId)
  const existingRoot = inspectExportRoot(exportRoot)
  if (existingRoot !== undefined) {
    if (existingRoot.isSymbolicLink()) {
      throw new RemoteError('peer/forbidden', 'export root must not be a symlink', { reason: 'export-symlink' })
    }
    if (!existingRoot.isDirectory()) {
      throw new RemoteError('peer/unavailable', 'export root is not a directory', { reason: 'export-root-unavailable' })
    }
  } else {
    try {
      mkdirSync(exportRoot, { recursive: true, mode: 0o700 })
      inspectExportRoot(exportRoot)
    } catch (error) {
      throw exportIoError(error)
    }
  }

  const existingSession = lstatSafe(sessionDir)
  if (existingSession !== undefined) {
    if (existingSession.isSymbolicLink()) {
      throw new RemoteError('peer/forbidden', 'session export directory must not be a symlink', {
        reason: 'export-symlink',
      })
    }
    if (!existingSession.isDirectory()) {
      throw new RemoteError('peer/unavailable', 'session export path is not a directory', {
        reason: 'export-root-unavailable',
      })
    }
    if (process.platform !== 'win32' && (existingSession.mode & 0o077) !== 0) {
      throw exportIoError(undefined)
    }
    return sessionDir
  }

  try {
    mkdirSync(sessionDir, { mode: 0o700 })
  } catch (error) {
    throw exportIoError(error)
  }
  return sessionDir
}

/**
 * List regular files inside `<exportRoot>/<sessionId>` with relative POSIX
 * paths, skipping symlinks and non-regular entries and bounding both entry
 * count and complete serialized UTF-8 metadata byte size.
 * @param exportRoot - configured export root directory.
 * @param sessionId - bound worker session identifier.
 * @param limits - count and serialized byte caps from `PeerService` config.
 * @returns relative regular file inventory and truncation flag.
 */
export function listSessionExports(
  exportRoot: string,
  sessionId: SessionId,
  limits: { readonly maxFiles: number; readonly maxBytes: number; readonly maxScannedEntries?: number },
): PeerExportListValue {
  if (limits.maxBytes < LIST_MIN_RESPONSE_BYTES) throw exportIoError(undefined)
  const sessionDir = verifyExportDirectoryChain(exportRoot, sessionId)
  if (sessionDir === undefined) {
    return { files: [], truncated: false }
  }

  const collected: PeerExportFileEntry[] = []
  let bytes = LIST_MIN_RESPONSE_BYTES - 1 // `true` is one byte shorter than `false`.
  let scanned = 0
  const dirs = ['']
  const finish = (truncated: boolean): PeerExportListValue => ({
    files: collected.sort((a, b) => a.path.localeCompare(b.path)), truncated,
  })
  for (const prefix of dirs) {
    const path = prefix === '' ? sessionDir : join(sessionDir, prefix)
    // Recheck before traversing: queued directory entries may have been replaced.
    if (verifyExportDirectoryChain(exportRoot, sessionId) === undefined) throw exportChanged()
    if (prefix !== '') checkComponents(sessionDir, prefix.split('/'), false)
    const directory = opendirSync(path)
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (++scanned > (limits.maxScannedEntries ?? Number.MAX_SAFE_INTEGER)) return finish(true)
        const { name } = entry
        if (name.includes('\\') || name.includes(':')) continue
        const stat = lstatSafe(join(path, name))
        if (stat === undefined || stat.isSymbolicLink()) continue
        const relPath = prefix === '' ? name : `${prefix}/${name}`
        if (stat.isDirectory()) dirs.push(relPath)
        if (!stat.isFile()) continue
        const candidate = { path: relPath, bytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) }
        const addition = Buffer.byteLength(JSON.stringify(candidate)) + (collected.length === 0 ? 0 : 1)
        if (collected.length >= limits.maxFiles || bytes + addition > limits.maxBytes) return finish(true)
        bytes += addition
        collected.push(candidate)
      }
    } finally {
      directory.closeSync()
    }
  }
  return finish(bytes >= limits.maxBytes)
}

/**
 * Fetch one bounded regular file from `<exportRoot>/<sessionId>`, refusing
 * absolute paths, `..`, NUL, symlinks in any component, non-regular files,
 * oversize payloads, and concurrent size changes between stat and read.
 * @param exportRoot - configured export root directory.
 * @param sessionId - bound worker session identifier.
 * @param requestedPath - relative POSIX path inside the session export directory.
 * @param limits - configured maximum bytes cap and optional caller cap.
 * @returns relative path, byte length, SHA-256 over the returned bytes, and base64 payload.
 * @throws {@link RemoteError} `gateway/bad-request`, `peer/not-found`, `peer/forbidden`, or `peer/conflict`.
 */
export function fetchSessionExport(
  exportRoot: string,
  sessionId: SessionId,
  requestedPath: string,
  limits: { readonly maxBytes: number; readonly requestedMaxBytes?: number },
): PeerExportFetchValue {
  const segments = parseSafeRelativeSegments(requestedPath)
  const cap = limits.requestedMaxBytes === undefined
    ? limits.maxBytes
    : Math.min(limits.requestedMaxBytes, limits.maxBytes)

  const sessionDir = verifyExportDirectoryChain(exportRoot, sessionId)
  if (sessionDir === undefined) {
    throw new RemoteError('peer/not-found', 'session export directory does not exist', {
      sessionId,
      reason: 'export-not-found',
    })
  }

  const current = join(sessionDir, ...segments)
  const checked = checkComponents(sessionDir, segments, true)
  if (checked.size > cap) throw exportOversize()

  let fd: number
  try {
    fd = openSync(current, FILE_OPEN_FLAGS)
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code
    if (errno === 'ENOENT') {
      throw new RemoteError('peer/not-found', `export path ${JSON.stringify(requestedPath)} was not found`, {
        sessionId,
        reason: 'export-not-found',
      })
    }
    if (errno === 'ELOOP') {
      throw new RemoteError('peer/forbidden', 'export path must not traverse symlinks', {
        reason: 'export-symlink',
      })
    }
    throw exportIoError(error)
  }

  try {
    const statBefore = fstatSync(fd)
    if (!statBefore.isFile()) {
      throw new RemoteError('peer/forbidden', 'export target must be a regular file', {
        reason: 'export-not-regular-file',
      })
    }
    if (!sameFile(checked, statBefore)) throw exportChanged()

    const buffer = readFdBounded(fd, cap)
    const statAfter = fstatSync(fd)
    if (verifyExportDirectoryChain(exportRoot, sessionId) === undefined) throw exportChanged()
    const pathStatAfter = checkComponents(sessionDir, segments, true)
    if (!sameFile(statBefore, statAfter) || !sameFile(statBefore, pathStatAfter)
      || buffer.byteLength !== statBefore.size) throw exportChanged()

    const sha256 = createHash('sha256').update(buffer).digest('hex')
    return {
      path: segments.join('/'),
      bytes: buffer.byteLength,
      sha256,
      contentBase64: buffer.toString('base64'),
    }
  } finally {
    closeSync(fd)
  }
}

function readFdBounded(fd: number, cap: number): Buffer {
  const chunks: Buffer[] = []
  let total = 0
  const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, cap + 1))
  const scratch = Buffer.allocUnsafe(chunkSize)
  for (;;) {
    const bytesRead = readSync(fd, scratch, 0, scratch.byteLength, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > cap) {
      throw exportChanged()
    }
    chunks.push(Buffer.from(scratch.subarray(0, bytesRead)))
  }
  return Buffer.concat(chunks, total)
}

function parseSafeRelativeSegments(rawPath: string): readonly string[] {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new RemoteError('gateway/bad-request', 'exportFetch requires a non-empty path', {})
  }
  if (rawPath.includes('\u0000')
    || rawPath.includes('\\') || rawPath.includes(':')
    || rawPath.startsWith('/')
    || isAbsolute(rawPath)) {
    throw new RemoteError('peer/forbidden', 'export path must be a relative POSIX path without NUL or drive prefixes', {
      reason: 'export-path-forbidden',
    })
  }
  const segments = rawPath.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new RemoteError('peer/forbidden', 'export path must not contain empty, ".", or ".." segments', {
        reason: 'export-path-forbidden',
      })
    }
  }
  return segments
}

function verifyExportDirectoryChain(exportRoot: string, sessionId: SessionId): string | undefined {
  const sessionDir = sessionExportDirPath(exportRoot, sessionId)
  const rootStat = inspectExportRoot(exportRoot)
  if (rootStat === undefined) return undefined
  if (rootStat.isSymbolicLink()) {
    throw new RemoteError('peer/forbidden', 'export root must not be a symlink', { reason: 'export-symlink' })
  }
  if (!rootStat.isDirectory()) {
    throw new RemoteError('peer/unavailable', 'export root is not a directory', { reason: 'export-root-unavailable' })
  }
  const sessionStat = lstatSafe(sessionDir)
  if (sessionStat === undefined) return undefined
  if (sessionStat.isSymbolicLink()) {
    throw new RemoteError('peer/forbidden', 'session export directory must not be a symlink', {
      reason: 'export-symlink',
    })
  }
  if (!sessionStat.isDirectory()) {
    throw new RemoteError('peer/forbidden', 'session export path is not a directory', {
      reason: 'export-not-regular-file',
    })
  }
  return sessionDir
}

function inspectExportRoot(path: string): Stats | undefined {
  const absolute = resolve(path)
  const { root } = parse(absolute)
  let stat = lstatSafe(root)
  let current = root
  for (const name of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, name)
    stat = lstatSafe(current)
    if (stat === undefined) return undefined
    if (stat.isSymbolicLink()) throw exportSymlink()
    if (!stat.isDirectory()) throw exportIoError(undefined)
  }
  return stat
}

function checkComponents(root: string, segments: readonly string[], file: boolean): Stats {
  let current = root
  let result: Stats | undefined
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    result = lstatSafe(current)
    if (result === undefined) break
    if (result.isSymbolicLink()) throw exportSymlink()
    const regular = file && index === segments.length - 1 ? result.isFile() : result.isDirectory()
    if (!regular) throw new RemoteError('peer/forbidden', 'invalid export file type', { reason: 'export-not-regular-file' })
  }
  if (result === undefined) throw new RemoteError('peer/not-found', 'export not found', { reason: 'export-not-found' })
  return result
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function exportSymlink(): RemoteError<'peer/forbidden'> {
  return new RemoteError('peer/forbidden', 'export path must not traverse symlinks', { reason: 'export-symlink' })
}

function exportOversize(): RemoteError<'peer/forbidden'> {
  return new RemoteError('peer/forbidden', 'export file exceeds byte cap', { reason: 'export-oversize' })
}

function exportChanged(): RemoteError<'peer/conflict'> {
  return new RemoteError('peer/conflict', 'export file changed while reading', { reason: 'export-size-changed' })
}

/** Normalize export filesystem errors without returning host paths.
 * @param error - export operation failure.
 * @returns the existing typed refusal or a generic storage refusal.
 */
export function exportIoError(error: unknown): Error {
  if (error instanceof RemoteError) return error
  return new RemoteError('peer/unavailable', 'export storage is unavailable', { reason: 'export-root-unavailable' })
}

function lstatSafe(targetPath: string): Stats | undefined {
  try {
    return lstatSync(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw exportIoError(error)
  }
}
