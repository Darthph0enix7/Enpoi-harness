/**
 * Declarations for scripts/update-inspect.mjs: the read-only `ds update
 * --dry-run` planner (ladder selection, manifest comparison, local tree
 * classification, pins/tombstones).
 */

import type { ReleaseManifestDocument, ReleaseManifestEntry } from './release-delta.mjs'

/** One release from the GitHub listing / probe fallback. */
export interface InspectionRelease {
  tag: string
  version: string
  assets: Map<string, number | null>
  urls: Map<string, string>
  createdAt: string | null
  base?: string | null
}

/** Ladder decision for `from -> to`. */
export interface LadderPlan {
  rung: number
  kind: string
  chain: string[]
  chainTags: string[]
  downloadBytes: number | null
  full: { name: string | null; bytes: number | null }
  reason: string
}

/** Structure of the inspection report (`dsh-update-inspection/1`). */
export interface InspectionReport {
  schema: string
  channel: string | null
  platform: string
  target: { tag: string | null; version: string | null; assetCount: number | null }
  installed: { version: string | null; tree: string | null; treeExists: boolean }
  ladder: LadderPlan & { fullTarball: { name: string | null; bytes: number | null } }
  changed: {
    available: boolean
    count: number | null
    bytes: number | null
    sample: { path: string; type: string; size: number | null }[]
    modeChanges: number | null
  }
  deletions: {
    candidates: number | null
    sample: string[]
    applicable: number | null
    applicableSample: string[]
    kept: number | null
    keptSample: { path: string; reason: string }[]
    available: boolean
  }
  localChanges: {
    available: boolean
    modified: { path: string; reason: string }[]
    missing: string[]
    modeOnly: { path: string; oldMode: string; newMode: string }[]
    untracked: string[]
    installerState: string[]
    counts: {
      modified: number | null
      missing: number | null
      modeOnly: number | null
      untracked: number | null
      installerState: number | null
    }
    note?: string
  }
  baseline: { available: boolean; asset: string | null; note: string | null }
  pins: { path: string | null; present: boolean; entries: string[]; matched: string[] }
  tombstones: { path: string | null; present: boolean; entries: string[]; matched: string[] }
  notes: string[]
}

export const INSPECTION_SCHEMA: string

/**
 * Read and validate a gzipped-or-plain manifest Buffer.
 * @param raw - manifest bytes
 * @returns validated document
 */
export function parseManifestBuffer(raw: Buffer): ReleaseManifestDocument

/**
 * sha256 of a file as lowercase hex.
 * @param file - file path
 * @returns hex digest
 */
export function sha256FileSync(file: string): string

/**
 * Lstat-only tree index.
 * @param treeDir - tree root
 * @returns path -> entry skeleton
 */
export function statTree(treeDir: string): Map<string, { type: string; mode: string; target?: string; size?: number; sha256?: string }>

/**
 * Classify the installed tree against a baseline manifest.
 * @param treeDir - tree root
 * @param tree - statTree index
 * @param baselineEntries - baseline manifest entries
 * @returns classification
 */
export function classifyLocal(
  treeDir: string,
  tree: Map<string, { type: string; mode: string; target?: string; size?: number; sha256?: string }>,
  baselineEntries: ReleaseManifestEntry[],
  options?: { hash?: (file: string) => string },
): {
  modified: { path: string; reason: string }[]
  missing: string[]
  modeOnly: { path: string; oldMode: string; newMode: string }[]
  untracked: string[]
  installerState: string[]
}

/**
 * Manifest comparison mirroring the release diff generator.
 * @param baseline - baseline entries
 * @param target - target entries
 * @returns changed/mode-only/deleted classification
 */
export function compareManifests(
  baseline: ReleaseManifestEntry[],
  target: ReleaseManifestEntry[],
): { changed: ReleaseManifestEntry[]; changedBytes: number; modeChanges: { path: string; oldMode: string; newMode: string }[]; deleted: string[] }

/** Asset name helpers. */
export function manifestAsset(platform: string, version: string): string
export function diffAsset(platform: string, from: string, to: string): string
export function fullAsset(version: string, platform: string): string

/**
 * Choose the apply ladder rung.
 * @param options - releases, platform, from, to
 * @returns ladder plan
 */
export function planLadder(options: { releases: InspectionRelease[]; platform: string; from?: string | null; to: string; maxHops?: number }): LadderPlan

/**
 * Simple glob matcher (`**` crosses directories).
 * @param glob - glob pattern
 * @returns matcher
 */
export function globToRegExp(glob: string): RegExp

/**
 * Read a pin/tombstone list file.
 * @param file - list path
 * @returns parsed entries
 */
export function readPathList(file: string | null | undefined): { path: string | null; present: boolean; entries: string[] }

/**
 * Build the inspection report from already-fetched inputs.
 * @param options - report inputs
 * @returns inspection report
 */
export function buildReport(options: {
  channel?: string | null
  platform: string
  tag?: string | null
  toVersion: string | null
  fromVersion?: string | null
  treeDir?: string
  targetManifest?: ReleaseManifestDocument | null
  targetManifestNote?: string | null
  baselineManifest?: ReleaseManifestDocument | null
  baselineAsset?: string | null
  baselineNote?: string | null
  releases: InspectionRelease[]
  pinsPath?: string | null
  tombstonePaths?: string[]
  limit?: number
  maxHops?: number
  treeExists?: boolean
}): InspectionReport

/**
 * Human-readable or JSON rendering of a report.
 * @param report - inspection report
 * @param options - `json` selects JSON
 * @returns rendered text
 */
export function formatReport(report: InspectionReport, options?: { json?: boolean }): string

/**
 * Full CLI flow: discover, fetch, classify, report.
 * @param options - CLI-shaped options
 * @returns inspection report
 */
export function inspectChannelUpdate(options: {
  platform: string
  repo: string
  baseUrl: string
  apiUrl: string
  tag: string
  fromVersion?: string
  treeDir?: string
  pinsPath?: string
  tombstonePaths?: string[]
  channel?: string | null
  limit?: number
  maxHops?: number
}): Promise<InspectionReport>
