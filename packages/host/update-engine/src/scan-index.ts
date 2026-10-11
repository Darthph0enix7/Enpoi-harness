/**
 * Scan index (doc 97 §3, Oracle amendments AMD-01..06): a compact, path-keyed
 * stat cache persisted inside the version tree it describes
 * (`<tree>/.dsh-scan-index`). It turns `scanTree` from a full-content hash walk
 * into a stat walk while keeping the classification provably safe:
 *
 * - the trust anchor is the index FILE's own `mtimeNs` (the filesystem clock,
 *   never `Date.now()`); a future timestamp (+5 s tolerance for clock skew)
 *   invalidates the whole index;
 * - an entry is trusted only when type, size, mode, device and inode match AND
 *   both the entry's `mtimeNs` and `ctimeNs` are strictly older than the index
 *   file's `mtimeNs` (racy-git rule; ctime closes the `utimes` bypass);
 * - a missing, truncated, unparsable, or hostile index is never an error: the
 *   caller falls back to a full scan and rewrites it;
 * - every write is tmp+rename (the hardlink write-through lesson).
 *
 * The index is an optimization, never an invariant: `.dsh-scan-index` is a
 * reserved engine path excluded from every walk, classification, and
 * verification surface (AMD-01).
 */

import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeBufferAtomic } from './atomic.ts'
import { hashBytes } from './manifest.ts'

/** Reserved index file name inside a version tree. */
export const SCAN_INDEX_NAME = '.dsh-scan-index'

/** Index document schema id. */
export const SCAN_INDEX_SCHEMA = 'dsh-scan-index/1'

/** Clock-skew tolerance for the future-timestamp guard. */
export const SCAN_INDEX_FUTURE_TOLERANCE_MS = 5_000

/**
 * True for the reserved index path and its transient siblings
 * (`.dsh-scan-index.tmp-…`). Excluded from every tree surface.
 * @param relPath - Tree-relative path.
 * @returns True when the path is reserved engine state.
 */
export function isScanIndexPath(relPath: string): boolean {
  return relPath === SCAN_INDEX_NAME || relPath.startsWith(`${SCAN_INDEX_NAME}.`)
}

/** One index entry (full stat identity plus the content hash). */
export interface ScanIndexEntry {
  /** Entry kind. */
  type: 'file' | 'dir' | 'symlink'
  /** Content size in bytes (0 for dirs). */
  size: number
  /** Modification time in nanoseconds (BigInt-safe decimal string). */
  mtimeNs: string
  /** Change time in nanoseconds (BigInt-safe decimal string). */
  ctimeNs: string
  /** Inode number (decimal string; `0` when the platform does not report one). */
  ino: string
  /** Device number (decimal string; `0` when unavailable). */
  dev: string
  /** Permission bits. */
  mode: number
  /** Symlink target; null otherwise. */
  target: string | null
  /** Binary probe result for files. */
  binary: boolean
  /** Content hash; null for directories. */
  sha256: string | null
}

/** A parsed index with its trust anchor. */
export interface ScanIndex {
  /** The index file's own mtime in nanoseconds (the trust anchor). */
  writtenAtNs: bigint
  /** Entries by tree-relative path. */
  entries: Map<string, ScanIndexEntry>
}

const TYPE_CODES: Record<ScanIndexEntry['type'], number> = { file: 0, dir: 1, symlink: 2 }
const TYPE_NAMES: Array<ScanIndexEntry['type']> = ['file', 'dir', 'symlink']

function isSafeRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.startsWith('/') || relPath.includes('\\')) return false
  if (/[\u0000-\u001f\u007f]/u.test(relPath)) return false
  return !relPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

function decimal(value: string): boolean {
  return /^\d+$/u.test(value)
}

function parseEntry(tuple: unknown): ScanIndexEntry | null {
  if (!Array.isArray(tuple) || tuple.length !== 10) return null
  const [typeCode, size, mtimeNs, ctimeNs, ino, dev, mode, target, binary, sha256] = tuple as unknown[]
  if (typeof typeCode !== 'number' || TYPE_NAMES[typeCode] === undefined) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return null
  if (typeof mtimeNs !== 'string' || !decimal(mtimeNs)) return null
  if (typeof ctimeNs !== 'string' || !decimal(ctimeNs)) return null
  if (typeof ino !== 'string' || !decimal(ino)) return null
  if (typeof dev !== 'string' || !decimal(dev)) return null
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0) return null
  if (target !== null && typeof target !== 'string') return null
  if (typeof binary !== 'boolean') return null
  if (sha256 !== null && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256))) return null
  const type = TYPE_NAMES[typeCode]
  if (type === 'symlink' && target === null) return null
  if (type === 'file' && sha256 === null) return null
  return { type, size, mtimeNs, ctimeNs, ino, dev, mode, target, binary, sha256 }
}

function serializeEntry(entry: ScanIndexEntry): unknown[] {
  return [
    TYPE_CODES[entry.type],
    entry.size,
    entry.mtimeNs,
    entry.ctimeNs,
    entry.ino,
    entry.dev,
    entry.mode,
    entry.target,
    entry.binary,
    entry.sha256,
  ]
}

/**
 * Read and validate the index of a tree. Returns null for a missing,
 * unreadable, truncated, unparsable, or future-timestamped index — the caller
 * then performs a full scan. Never throws.
 * @param root - Absolute tree root.
 * @returns Parsed index or null.
 */
export async function readScanIndex(root: string): Promise<ScanIndex | null> {
  try {
    const indexStats = await lstat(join(root, SCAN_INDEX_NAME), { bigint: true })
    if (!indexStats.isFile()) return null
    const writtenAtNs = indexStats.mtimeNs
    if (writtenAtNs > BigInt(Date.now()) * 1_000_000n + BigInt(SCAN_INDEX_FUTURE_TOLERANCE_MS) * 1_000_000n) return null
    const text = await readFile(join(root, SCAN_INDEX_NAME), 'utf8')
    const doc: unknown = JSON.parse(text)
    if (typeof doc !== 'object' || doc === null) return null
    const record = doc as { schema?: unknown; entries?: unknown }
    if (record.schema !== SCAN_INDEX_SCHEMA) return null
    if (typeof record.entries !== 'object' || record.entries === null || Array.isArray(record.entries)) return null
    const entries = new Map<string, ScanIndexEntry>()
    for (const [relPath, tuple] of Object.entries(record.entries as Record<string, unknown>)) {
      if (!isSafeRelPath(relPath) || isScanIndexPath(relPath)) return null
      const entry = parseEntry(tuple)
      if (entry === null) return null
      entries.set(relPath, entry)
    }
    return { writtenAtNs, entries }
  } catch {
    return null
  }
}

/**
 * Write the index atomically (tmp+rename, never in place).
 * @param root - Absolute tree root.
 * @param entries - Entries by path (reserved paths are dropped).
 * @returns Written entry count and byte size.
 */
export async function writeScanIndex(root: string, entries: Map<string, ScanIndexEntry>): Promise<{ entries: number; bytes: number }> {
  const docEntries: Record<string, unknown[]> = {}
  let count = 0
  for (const [relPath, entry] of entries) {
    if (isScanIndexPath(relPath) || !isSafeRelPath(relPath)) continue
    docEntries[relPath] = serializeEntry(entry)
    count += 1
  }
  const data = Buffer.from(JSON.stringify({ schema: SCAN_INDEX_SCHEMA, entries: docEntries }), 'utf8')
  await writeBufferAtomic(join(root, SCAN_INDEX_NAME), data, 0o644)
  return { entries: count, bytes: data.length }
}

/** Minimal stat identity the trust rule compares (as returned by a bigint lstat). */
export interface StatIdentity {
  /** Entry kind. */
  type: 'file' | 'dir' | 'symlink'
  /** Size in bytes. */
  size: number
  /** Modification time in nanoseconds. */
  mtimeNs: bigint
  /** Change time in nanoseconds. */
  ctimeNs: bigint
  /** Inode number (0 when the platform reports none). */
  ino: bigint
  /** Device number (0 when unavailable). */
  dev: bigint
  /** Permission bits. */
  mode: number
}

/**
 * The trust rule (AMD-02, AMD-06): identity must match and both timestamps
 * must be strictly older than the index file. Inode/device checks are skipped
 * when either side reports 0 (filesystems without stable inodes).
 * @param entry - Indexed entry.
 * @param stat - Fresh bigint stat of the path.
 * @param writtenAtNs - The index file's own mtime in nanoseconds.
 * @returns True when the indexed hash can be trusted.
 */
export function scanIndexEntryTrusted(entry: ScanIndexEntry, stat: StatIdentity, writtenAtNs: bigint, allowCtimeDrift = false): boolean {
  if (entry.type !== stat.type) return false
  if (entry.size !== stat.size) return false
  if (entry.mode !== stat.mode) return false
  const entryMtime = BigInt(entry.mtimeNs)
  const entryCtime = BigInt(entry.ctimeNs)
  // Stat hit: the current timestamps must be exactly the recorded ones. A
  // file edited after the index keeps its inode/size but moves mtime/ctime,
  // so equality is what makes the recorded hash still true. The refresh pass
  // (allowCtimeDrift) carries the hash when only the ctime moved — exactly
  // what hardlink seeding does to the source tree's inodes (nlink change).
  if (stat.mtimeNs !== entryMtime) return false
  if (!allowCtimeDrift && stat.ctimeNs !== entryCtime) return false
  // Racy rule: both recorded times must be strictly older than the index
  // file's own mtime (ctime closes the utimes bypass).
  if (!(entryMtime < writtenAtNs && entryCtime < writtenAtNs)) return false
  const entryIno = BigInt(entry.ino)
  const entryDev = BigInt(entry.dev)
  if (entryIno !== 0n && stat.ino !== 0n && entryIno !== stat.ino) return false
  if (entryDev !== 0n && stat.dev !== 0n && entryDev !== stat.dev) return false
  return true
}

/**
 * Fetch a trustable hash for one path from an index, or null.
 * @param index - Parsed index.
 * @param relPath - Tree-relative path.
 * @param stat - Fresh bigint stat identity of the path.
 * @returns Trusted hash (files) or symlink target hash, or null.
 */
export function trustedHash(index: ScanIndex | null, relPath: string, stat: StatIdentity, allowCtimeDrift = false): string | null {
  if (index === null) return null
  const entry = index.entries.get(relPath)
  if (entry === undefined) return null
  if (!scanIndexEntryTrusted(entry, stat, index.writtenAtNs, allowCtimeDrift)) return null
  if (entry.type === 'symlink') return entry.sha256 ?? hashBytes(entry.target ?? '')
  return entry.sha256
}

export interface BigIntStatsLike {
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
  dev: bigint
  mode: bigint
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/**
 * Build an index entry from a bigint lstat plus a known content hash.
 * @param stats - Bigint lstat result.
 * @param sha256 - Content hash (symlink target hash for symlinks, null for dirs).
 * @param binary - Binary probe result.
 * @param target - Symlink target.
 * @returns Index entry.
 */
export function scanIndexEntryFromStats(
  stats: BigIntStatsLike,
  sha256: string | null,
  binary: boolean,
  target: string | null,
): ScanIndexEntry {
  const type = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : 'file'
  return {
    type,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    ino: stats.ino.toString(),
    dev: stats.dev.toString(),
    mode: Number(stats.mode & 0o7777n),
    target,
    binary,
    sha256,
  }
}
