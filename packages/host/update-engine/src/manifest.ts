/**
 * Manifest utilities (§2.1): deterministic tree scanning, SHA-256 hashing
 * with symlink and mode metadata, and schema read/write. The manifest is a
 * JSON object mapping relative paths to `{sha256, size, type, mode, target}`
 * entries, emitted with sorted keys so two scans of identical trees produce
 * byte-identical manifests.
 *
 * Hashing rules:
 * - regular file: SHA-256 of the bytes; `binary` is true when a NUL byte
 *   appears in the first 8192 bytes;
 * - symlink: SHA-256 of the target string, with `target` recorded;
 * - directory: listed with `sha256: null`, `size: 0`.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeBufferAtomic } from './atomic.ts'
import { matchesAnyGlob } from './glob.ts'
import type { Manifest, ManifestEntry } from './types.ts'

/** NUL-byte probe window for binary classification. */
export const BINARY_PROBE_BYTES = 8192

/** Options for {@link scanTree}. */
export interface ScanTreeOptions {
  /** Glob patterns; a matching path (and any directory's subtree) is skipped. */
  ignore?: readonly string[]
}

/** File hashing result. */
export interface FileHash {
  /** Hex SHA-256 of the content. */
  sha256: string
  /** Content size in bytes. */
  size: number
  /** True when a NUL byte appears in the first {@link BINARY_PROBE_BYTES} bytes. */
  binary: boolean
}

/**
 * Hash bytes with SHA-256.
 * @param data - String (UTF-8) or buffer content.
 * @returns Hex digest.
 */
export function hashBytes(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Hash UTF-8 text with SHA-256.
 * @param text - Text content.
 * @returns Hex digest.
 */
export function hashText(text: string): string {
  return hashBytes(Buffer.from(text, 'utf8'))
}

/**
 * Stream-hash a file and classify it as binary through the probe window.
 * @param path - Absolute file path.
 * @returns Hex digest, byte size, and binary flag.
 */
export async function hashFile(path: string): Promise<FileHash> {
  const hash = createHash('sha256')
  const probe = Buffer.alloc(BINARY_PROBE_BYTES)
  let probeLength = 0
  let size = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer
    hash.update(bytes)
    size += bytes.length
    if (probeLength < BINARY_PROBE_BYTES) {
      const take = Math.min(BINARY_PROBE_BYTES - probeLength, bytes.length)
      bytes.copy(probe, probeLength, 0, take)
      probeLength += take
    }
  }
  return { sha256: hash.digest('hex'), size, binary: probe.subarray(0, probeLength).includes(0) }
}

/**
 * Reject a manifest path that could escape its tree root.
 * @param relPath - Relative path using '/' separators.
 */
export function assertSafeRelPath(relPath: string): void {
  const segments = relPath.split('/')
  if (
    relPath === ''
    || relPath.startsWith('/')
    || relPath.includes('\\')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe manifest path: ${JSON.stringify(relPath)}`)
  }
}

/**
 * Resolve a manifest path under a tree root after validating it.
 * @param root - Absolute tree root.
 * @param relPath - Relative path using '/' separators.
 * @returns Absolute path under the root.
 */
export function resolveTreePath(root: string, relPath: string): string {
  assertSafeRelPath(relPath)
  return join(root, ...relPath.split('/'))
}

/**
 * Read a path from a tree as UTF-8 text.
 * @param root - Absolute tree root.
 * @param relPath - Relative path.
 * @returns File content.
 */
export async function readTreeText(root: string, relPath: string): Promise<string> {
  return readFile(resolveTreePath(root, relPath), 'utf8')
}

/**
 * Read a path from a tree as bytes.
 * @param root - Absolute tree root.
 * @param relPath - Relative path.
 * @returns File content.
 */
export async function readTreeBytes(root: string, relPath: string): Promise<Buffer> {
  return readFile(resolveTreePath(root, relPath))
}

/**
 * Scan a tree into a manifest (§2.1).
 * @param root - Absolute tree root.
 * @param options - Scan options.
 * @returns Deterministic path → entry manifest.
 */
export async function scanTree(root: string, options: ScanTreeOptions = {}): Promise<Manifest> {
  const manifest: Manifest = {}
  const ignore = options.ignore ?? []
  await walk(root, '', manifest, ignore)
  return manifest
}

async function walk(root: string, rel: string, manifest: Manifest, ignore: readonly string[]): Promise<void> {
  const directory = rel === '' ? root : resolveTreePath(root, rel)
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const dirent of entries) {
    const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
    if (matchesAnyGlob(ignore, childRel)) continue
    const stats = await lstat(join(directory, dirent.name))
    if (stats.isDirectory()) {
      manifest[childRel] = { sha256: null, size: 0, type: 'dir', mode: stats.mode & 0o7777, target: null, binary: false }
      await walk(root, childRel, manifest, ignore)
    } else if (stats.isSymbolicLink()) {
      const target = await readlink(join(directory, dirent.name))
      manifest[childRel] = {
        sha256: hashBytes(target),
        size: Buffer.byteLength(target),
        type: 'symlink',
        mode: stats.mode & 0o7777,
        target,
        binary: false,
      }
    } else if (stats.isFile()) {
      const hashed = await hashFile(join(directory, dirent.name))
      manifest[childRel] = {
        sha256: hashed.sha256,
        size: hashed.size,
        type: 'file',
        mode: stats.mode & 0o7777,
        target: null,
        binary: hashed.binary,
      }
    } else {
      throw new Error(`unsupported filesystem object in tree: ${childRel}`)
    }
  }
}

/**
 * Compare two entries for release identity: kind, mode, content hash, and
 * symlink target. Size and the derived binary flag do not participate.
 * @param left - First entry.
 * @param right - Second entry.
 * @returns True when the entries describe the same shipped path state.
 */
export function entryEquals(left: ManifestEntry, right: ManifestEntry): boolean {
  return left.type === right.type
    && left.mode === right.mode
    && left.sha256 === right.sha256
    && left.target === right.target
}

/**
 * List manifest paths in deterministic sorted order.
 * @param manifest - Manifest to list.
 * @returns Sorted relative paths.
 */
export function manifestPaths(manifest: Manifest): string[] {
  return Object.keys(manifest).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * Serialize a manifest with sorted paths and fixed field order.
 * @param manifest - Manifest to serialize.
 * @returns JSON text with a trailing newline.
 */
export function serializeManifest(manifest: Manifest): string {
  const lines: string[] = ['{']
  const paths = manifestPaths(manifest)
  paths.forEach((path, index) => {
    const entry = manifest[path]
    if (entry === undefined) return
    const payload = {
      sha256: entry.sha256,
      size: entry.size,
      type: entry.type,
      mode: entry.mode,
      target: entry.target,
      binary: entry.binary,
    }
    const comma = index === paths.length - 1 ? '' : ','
    lines.push(`${JSON.stringify(path)}:${JSON.stringify(payload)}${comma}`)
  })
  lines.push('}')
  return lines.join('\n') + '\n'
}

/**
 * Parse a manifest document, validating entries and rejecting unsafe paths.
 * @param text - JSON manifest text.
 * @param source - Label used in error messages.
 * @returns Parsed manifest.
 */
export function parseManifest(text: string, source = 'manifest'): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a JSON object mapping paths to entries`)
  }
  const manifest: Manifest = {}
  for (const [path, value] of Object.entries(parsed)) {
    assertSafeRelPath(path)
    manifest[path] = parseEntry(value, `${source}:${path}`)
  }
  return manifest
}

function parseEntry(value: unknown, label: string): ManifestEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: entry must be an object`)
  }
  const record = value as Record<string, unknown>
  const type = record['type']
  if (type !== 'file' && type !== 'symlink' && type !== 'dir') {
    throw new Error(`${label}: unknown type ${JSON.stringify(type)}`)
  }
  const sha256 = record['sha256']
  if (sha256 !== null && typeof sha256 !== 'string') {
    throw new Error(`${label}: sha256 must be a string or null`)
  }
  const size = record['size']
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new Error(`${label}: size must be a non-negative integer`)
  }
  const mode = parseMode(record['mode'], label)
  const target = record['target'] ?? null
  if (target !== null && typeof target !== 'string') {
    throw new Error(`${label}: target must be a string or null`)
  }
  if (type === 'symlink' && typeof target !== 'string') {
    throw new Error(`${label}: symlink entry requires a target string`)
  }
  const binary = record['binary'] ?? false
  if (typeof binary !== 'boolean') {
    throw new Error(`${label}: binary must be a boolean`)
  }
  return { sha256, size, type, mode, target, binary }
}

function parseMode(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value & 0o7777
  if (typeof value === 'string') {
    const parsed = /^0[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed >= 0) return parsed & 0o7777
  }
  throw new Error(`${label}: mode must be a POSIX mode number or string`)
}

/**
 * Read a manifest file.
 * @param path - Manifest file path.
 * @returns Parsed manifest.
 */
export async function readManifest(path: string): Promise<Manifest> {
  return parseManifest(await readFile(path, 'utf8'), path)
}

/**
 * Write a manifest atomically (temp file + rename) with sorted keys.
 * @param path - Destination path.
 * @param manifest - Manifest to write.
 */
export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeBufferAtomic(path, Buffer.from(serializeManifest(manifest), 'utf8'), 0o644)
}

/**
 * Fingerprint a manifest document for plan identity.
 * @param manifest - Manifest to fingerprint.
 * @returns Hex SHA-256 of the canonical serialization.
 */
export function manifestFingerprint(manifest: Manifest): string {
  return hashBytes(serializeManifest(manifest))
}
