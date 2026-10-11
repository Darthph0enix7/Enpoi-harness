/**
 * Declarations for scripts/release-delta.mjs: the release manifest and
 * consecutive-diff emitter used by harness-release.yml and the update specs.
 */

/** One shipped path in a release manifest document. */
export interface ReleaseManifestEntry {
  path: string
  type: 'file' | 'symlink' | 'dir'
  mode: string
  size: number
  sha256: string | null
  target: string | null
  binary: boolean
}

/** The `dsh-release-manifest/1` document envelope. */
export interface ReleaseManifestDocument {
  schema: string
  version: string
  platform: string
  entries: ReleaseManifestEntry[]
}

/** Engine-canonical projection of one manifest entry. */
export interface CanonicalManifestEntry {
  sha256: string | null
  size: number
  type: 'file' | 'symlink' | 'dir'
  mode: number
  target: string | null
  binary: boolean
}

/** Engine-canonical manifest map (`path -> entry`). */
export type CanonicalManifest = Record<string, CanonicalManifestEntry>

/** Changed/deleted/mode-only classification between two documents. */
export interface ManifestDiff {
  changed: ReleaseManifestEntry[]
  changedBytes: number
  modeChanges: { path: string; oldMode: string; newMode: string }[]
  deleted: string[]
}

export const MANIFEST_SCHEMA: string
export const DIFF_SCHEMA: string
export const DIFF_META_DIR: string
export const BINARY_PROBE_BYTES: number

/**
 * Walk a tree with the engine's canonical manifest rules.
 * @param treeRoot - tree root
 * @returns manifest entries sorted by path bytes
 */
export function buildManifest(treeRoot: string): ReleaseManifestEntry[]

/**
 * Serialize a manifest document (one-line JSON + trailing newline).
 * @param entries - manifest entries
 * @param version - release version
 * @param platform - os-arch pair
 * @returns JSON text
 */
export function manifestDocument(entries: ReleaseManifestEntry[], version: string, platform: string): string

/**
 * Reject an unsafe manifest path (release-delta/update-delta parity rule).
 * @param relPath - relative path
 */
export function assertSafeRelPath(relPath: unknown): void

/**
 * POSIX permission bits from an octal string or number.
 * @param value - mode value
 * @param label - error label
 * @returns masked permission bits
 */
export function modeNumber(value: unknown, label?: string): number

/**
 * Validate a manifest document.
 * @param doc - parsed document
 * @param source - error label
 * @returns the validated document
 */
export function validateManifestDocument(doc: unknown, source?: string): ReleaseManifestDocument

/**
 * Project a manifest document onto the engine manifest map.
 * @param doc - parsed document
 * @param source - error label
 * @returns canonical manifest
 */
export function toCanonicalManifest(doc: unknown, source?: string): CanonicalManifest

/**
 * Compare two manifest documents.
 * @param oldManifest - previous document
 * @param newManifest - new document
 * @returns diff classification
 */
export function computeDiff(oldManifest: ReleaseManifestDocument, newManifest: ReleaseManifestDocument): ManifestDiff

/**
 * sha256 of a file as lowercase hex.
 * @param file - file path
 * @returns hex digest
 */
export function sha256FileSync(file: string): string

/**
 * Write a gzipped manifest and its sidecar.
 * @param options - tree, platform, version, out
 * @returns manifest statistics
 */
export function writeManifest(options: { tree: string; platform: string; version: string; out: string }): {
  entries: number
  files: number
  symlinks: number
  dirs: number
  jsonBytes: number
  gzBytes: number
  sha256: string
}

/**
 * Read a manifest from a path or Buffer, transparently handling gzip.
 * @param source - file path or bytes
 * @returns validated document
 */
export function readManifest(source: string | Buffer): ReleaseManifestDocument

/**
 * Write a consecutive diff archive and its sidecar.
 * @param options - tree, manifests, platform, versions, out
 * @returns diff statistics
 */
export function writeDiff(options: {
  tree: string
  oldManifest: ReleaseManifestDocument
  newManifest: ReleaseManifestDocument
  platform: string
  from: string
  to: string
  out: string
}): { changed: number; changedBytes: number; deleted: number; modeChanges: number; diffBytes: number; sha256: string }
