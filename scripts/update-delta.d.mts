/**
 * Declarations for scripts/update-delta.mjs: the apply-side orchestration
 * (manifest validation, diff-chain extraction with path safety, release-view
 * supplementation, and the preservation-engine plan/apply pipeline).
 */

import type { CanonicalManifest, CanonicalManifestEntry, ReleaseManifestDocument } from './release-delta.mjs'

/** Transport accounting of one apply. */
export interface ApplyTransport {
  mode: 'delta' | 'full'
  archives: string[]
  hops: number
  base: string
  supplemented?: number
  unresolved?: number
}

/** Plan summary as reported by the engine. */
export interface ApplyPlanSummary {
  actions: number
  counts: Record<string, number>
  conflicts: number
  switchDecision: string
  fingerprint: string
}

/** One planned action (subset used by the specs). */
export interface ApplyPlannedAction {
  kind: string
  path: string
  reason: string
  pinned: boolean
  tombstoned: boolean
  merge: { status: string; severity: string | null; conflicts: number } | null
  outcome: { disposition: string; sha256: string | null; sidecars: Record<string, string> }
}

/** Structured result written for the updater. */
export interface ApplyPipelineResult {
  schema: string
  fromVersion: string | null
  toVersion: string
  status: string
  exitCode: number
  detail: string | null
  transport: ApplyTransport
  plan: ApplyPlanSummary
  report: {
    counts: Record<string, number>
    conflicts: { path: string; severity: string; detail: string; sidecar: string | null }[]
    preserved: { path: string; reason: string; sha256: string | null }[]
    deletions: string[]
    pinned: string[]
    sidecars: { path: string; sha256: string }[]
    bytes: { written: number; replaced: number }
    human: string
  }
  verification: {
    ok: boolean
    manifestChecked: number
    preservedChecked: number
    tombstonesAbsent: number
    untrackedPresent: number
    sidecarsPresent: number
    mismatches: { path: string; reason: string; expected: string; actual: string }[]
  } | null
  liveTreeIntact: boolean
  bytesWritten: number
  wroteActions: number
  resumed: boolean
  backupDir: string | null
  stagingRoot: string
  journalPath: string
  /** Retained pristine base archive for the installed version; null when not requested or not synthesized. */
  baseArchive: { path: string; bytes: number; files: number; omitted: string[] } | null
  /** Why the base archive was not retained; null when it was or was not requested. */
  baseArchiveError: string | null
}

/** Options for {@link runApplyPipeline}. */
export interface RunApplyPipelineOptions {
  enginePath: string
  localRoot: string
  baseRoot: string
  releaseRoot: string
  previousPath: string
  nextPath: string
  stagingRoot: string
  journalPath: string
  toVersion: string
  fromVersion?: string
  diffArchives?: string[]
  platform?: string | null
  baseMode?: string
  backupDir?: string
  pinsPath?: string
  tombstonesPath?: string
  timestamp?: string
  stopAfterActions?: number
  /** When set, synthesize the pristine base archive for the installed version. */
  persistBasePath?: string
}

/** Outcome of the apply pipeline. */
export interface ApplyPipelineOutcome {
  status: string
  exitCode: number
  result: ApplyPipelineResult
  plan: {
    schema: number
    fromVersion: string | null
    toVersion: string
    actions: ApplyPlannedAction[]
    counts: Record<string, number>
    conflicts: { path: string; severity: string; abort: boolean; detail: string; sidecar: string | null }[]
    switchDecision: 'proceed' | 'abort'
    fingerprint: string
  }
  transport: ApplyTransport
  view: { assembled: boolean; members: number; hops: number } | null
}

export const MANIFEST_SCHEMA: string
export const DIFF_SCHEMA: string
export const DIFF_META_DIR: string
export const DIFF_META_MEMBERS: readonly string[]

/**
 * Reject an unsafe manifest path.
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
 * Project a manifest document onto the engine manifest map.
 * @param doc - parsed document
 * @param source - error label
 * @returns canonical manifest
 */
export function canonicalManifest(doc: unknown, source?: string): CanonicalManifest

/**
 * Read and validate a manifest document from a path or Buffer.
 * @param source - file path or bytes
 * @returns validated document
 */
export function readManifestDocument(source: string | Buffer): ReleaseManifestDocument

/**
 * sha256 of a file as lowercase hex.
 * @param file - file path
 * @returns hex digest
 */
export function sha256FileSync(file: string): string

/**
 * Content identity of an entry, ignoring mode.
 * @param left - first entry
 * @param right - second entry
 * @returns whether both describe the same content
 */
export function contentEqual(
  left: { type: string; sha256?: string | null; target?: string | null; mode?: string },
  right: { type: string; sha256?: string | null; target?: string | null; mode?: string },
): boolean

/**
 * Validate one archive member name.
 * @param name - member name
 * @returns normalized name
 */
export function validateArchiveMember(name: string): string

/**
 * List archive member names, rejecting unsafe names.
 * @param archive - archive path
 * @returns validated member names
 */
export function listArchiveMembers(archive: string): string[]

/**
 * Extract one diff archive into the view directory and validate its metadata.
 * @param options - extraction inputs
 * @returns parsed diff metadata
 */
export function extractDiffArchive(options: {
  archive: string
  viewDir: string
  from?: string | null
  to?: string | null
  platform?: string | null
}): { schema: string; from: string; to: string; platform: string }

/**
 * Walk an extracted view and reject unsafe or special entries.
 * @param viewDir - extracted view root
 * @returns number of regular one-link files seen
 */
export function verifyExtractedTree(viewDir: string): number

/**
 * Assemble the release view from a chain of consecutive diff archives.
 * @param options - chain inputs
 * @returns assembly statistics
 */
export function extractDiffChain(options: {
  archives: string[]
  viewDir: string
  from: string
  to: string
  platform?: string | null
}): { assembled: boolean; members: number; hops: number }

/**
 * Ensure the release view can serve every byte the plan can ask for.
 * @param options - view inputs
 * @returns supplemented and unresolved paths
 */
export function supplementReleaseView(options: {
  viewDir: string
  previous: CanonicalManifest
  next: CanonicalManifest
  localRoot: string
  baseRoot: string
}): { supplemented: string[]; unresolved: string[] }

/**
 * Run the full apply pipeline: manifests in, staging out.
 * @param options - pipeline inputs
 * @returns pipeline outcome
 */
export function runApplyPipeline(options: RunApplyPipelineOptions): Promise<ApplyPipelineOutcome>

/**
 * Build a pristine base archive for a freshly verified version from an applied plan.
 * @param options - synthesis inputs
 * @returns archive path, bytes, files linked, and omitted preserved paths
 */
export function synthesizePristineArchive(options: {
  plan: { actions: ApplyPlannedAction[] }
  stagingRoot: string
  releaseRoot: string
  outPath: string
}): { path: string; bytes: number; files: number; omitted: string[] }

/**
 * Run the CLI.
 * @param argv - arguments after the program name
 * @returns process exit code
 */
export function main(argv: string[]): Promise<number>

/** Exported for parity checks against the emitter projection. */
export type { CanonicalManifestEntry }
