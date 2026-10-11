/**
 * Type declarations for the update engine: manifest entries (§2.1), the plan
 * produced by the §3.2 decision matrix, apply results, the journal used for
 * interruption recovery, and the structured update report. This module
 * contains types only; runtime code lives in the sibling modules.
 */

/** Filesystem kind recorded for one path. */
export type ManifestEntryType = 'file' | 'symlink' | 'dir'

/**
 * One path in a release manifest (§2.1) or a scanned tree.
 */
export interface ManifestEntry {
  /** SHA-256 of the file bytes; SHA-256 of the target string for a symlink; null for a directory. */
  sha256: string | null
  /** File size in bytes; target-string byte length for a symlink; 0 for a directory. */
  size: number
  /** Filesystem kind. */
  type: ManifestEntryType
  /** POSIX permission bits (`mode & 0o7777`). */
  mode: number
  /** Symlink target string; null unless {@link type} is 'symlink'. */
  target: string | null
  /** True when a regular file is binary (NUL byte in the first 8192 bytes). */
  binary: boolean
}

/**
 * Relative path → manifest entry. Paths use '/' separators and are emitted in
 * sorted order, so serialization is deterministic.
 */
export type Manifest = Record<string, ManifestEntry>

/** Decision-matrix row that produced a plan action; used in reports. */
export type PlanReason =
  | 'unchanged/unchanged'
  | 'unchanged/changed'
  | 'modified/unchanged'
  | 'modified/changed'
  | 'modified/removed'
  | 'untracked/absent'
  | 'untracked/added'
  | 'untracked/identical'
  | 'missing/unchanged'
  | 'missing/changed'
  | 'missing/removed'
  | 'tombstoned'
  | 'pinned'
  | 'added'
  | 'removed/unmodified'
  | 'removed/modified'

/** Action kinds a plan can contain; one per §3.2 matrix row plus pins/tombstones. */
export type PlanActionKind =
  | 'skip'
  | 'replace'
  | 'add'
  | 'merge'
  | 'keep-local'
  | 'keep-local-sidecar'
  | 'keep-untracked'
  | 'restore'
  | 'delete'
  | 'tombstone'
  | 'pin-skip'

/** What the staged tree must contain at a planned path after apply. */
export type OutcomeDisposition = 'shipped' | 'local' | 'merged' | 'absent'

/**
 * Recorded expectation for one path, consumed by the qualified verification
 * contract (§2.3 step 4): manifest hash for shipped paths, the recorded
 * merge-keep/merge-output hash for preserved paths, absence for tombstones.
 */
export interface PlannedOutcome {
  /** Source of the staged content. */
  disposition: OutcomeDisposition
  /** Expected SHA-256 after apply; null for directories and 'absent'. */
  sha256: string | null
  /** Relative sidecar path → expected SHA-256, written by apply. */
  sidecars: Record<string, string>
}

/** Conflict class, following the §3.2 severity split. */
export type ConflictSeverity = 'config-data' | 'runtime-code'

/** Why a conflict row exists. */
export type ConflictKind = 'merge' | 'binary' | 'type-mismatch' | 'untracked-collision'

/** One reported conflict. */
export interface PlanConflict {
  /** Conflicted path. */
  path: string
  /** Conflict class. */
  kind: ConflictKind
  /** Severity split; runtime code conflicts abort the switch. */
  severity: ConflictSeverity
  /** True when this conflict aborts the switch (§3.2 runtime-code rule). */
  abort: boolean
  /** Human-readable explanation, including the exact conflict points when known. */
  detail: string
  /** Sidecar path carrying the shipped or conflict-marked content; null when none. */
  sidecar: string | null
}

/** Outcome of a both-changed merge attempt. */
export interface MergeOutcome {
  /** Result classification. */
  status: 'clean' | 'conflict' | 'binary' | 'type-mismatch'
  /** Severity split applied to a conflict. */
  severity: ConflictSeverity | null
  /** Number of conflict regions; 0 when clean or non-textual. */
  conflicts: number
}

/** One planned action, self-contained except for bytes (resolved from tree roots at apply). */
export interface PlanAction {
  /** Action kind. */
  kind: PlanActionKind
  /** Relative path in the tree. */
  path: string
  /** Decision-matrix row. */
  reason: PlanReason
  /** True when a pin covers this path. */
  pinned: boolean
  /** True when a tombstone was respected for this path. */
  tombstoned: boolean
  /** Previous-manifest entry; null when the path was not previously shipped. */
  baseline: ManifestEntry | null
  /** New-manifest entry; null when the path is absent from the new release. */
  shipped: ManifestEntry | null
  /** Local entry observed before apply; null when absent locally. */
  local: ManifestEntry | null
  /** Recorded post-apply expectation. */
  outcome: PlannedOutcome
  /** Merge attempt outcome; null when no merge was attempted. */
  merge: MergeOutcome | null
}

/** Action-kind histogram. */
export type PlanCounts = Record<PlanActionKind, number>

/** Complete deterministic update plan. */
export interface UpdatePlan {
  /** Plan format version. */
  schema: 1
  /** Installed version the plan was computed against; null for a cold start. */
  fromVersion: string | null
  /** Version being installed. */
  toVersion: string
  /** Actions ordered for apply: non-deletions sorted by path, then deletions. */
  actions: PlanAction[]
  /** Action-kind histogram. */
  counts: PlanCounts
  /** Conflicts, including the runtime-code conflicts that abort the switch. */
  conflicts: PlanConflict[]
  /** 'abort' when any runtime-code merge conflict exists; otherwise 'proceed'. */
  switchDecision: 'proceed' | 'abort'
  /** SHA-256 over the canonical plan JSON; binds the journal to this plan. */
  fingerprint: string
}

/** A path preserved from the local tree, with its recorded hash. */
export interface PreservedPath {
  /** Relative path. */
  path: string
  /** Matrix row that preserved it. */
  reason: PlanReason
  /** Recorded local/merge-keep hash; null for a directory. */
  sha256: string | null
}

/** One mismatch found by qualified verification. */
export interface VerificationMismatch {
  /** Relative path. */
  path: string
  /** Reason the path failed. */
  reason: 'missing' | 'unexpected' | 'type' | 'hash' | 'mode' | 'target' | 'sidecar-missing' | 'sidecar-hash' | 'unexpected-untracked'
  /** Expected value description. */
  expected: string
  /** Observed value description. */
  actual: string
}

/** Qualified verification result (§2.3 step 4). */
export interface VerificationResult {
  /** True when no mismatch was found. */
  ok: boolean
  /** Manifest paths checked against the new manifest hash. */
  manifestChecked: number
  /** Preserved paths checked against their recorded hash. */
  preservedChecked: number
  /** Tombstoned paths verified absent. */
  tombstonesAbsent: number
  /** Untracked paths verified present. */
  untrackedPresent: number
  /** Sidecars verified present with the recorded hash. */
  sidecarsPresent: number
  /** All mismatches found. */
  mismatches: VerificationMismatch[]
}

/** Apply journal phase. */
export type JournalPhase = 'seeded' | 'applying' | 'verifying' | 'complete' | 'aborted' | 'failed'

/** Interruption-recovery journal stored next to the staging directory. */
export interface ApplyJournal {
  /** Journal format version. */
  schema: 1
  /** Target version. */
  toVersion: string
  /** Plan fingerprint this staging directory was produced for. */
  fingerprint: string
  /** Caller-provided timestamp (deterministic when provided). */
  createdAt: string
  /** Last completed phase. */
  phase: JournalPhase
  /** Paths whose action completed in the interrupted pass. */
  completed: string[]
  /** Failure or abort detail; null when none. */
  detail: string | null
}

/** Status of an apply pass. */
export type ApplyStatus = 'applied' | 'aborted' | 'interrupted' | 'noop' | 'rollback-required' | 'failed'

/** Per-action apply outcome. */
export interface ApplyActionResult {
  /** Relative path. */
  path: string
  /** Planned action kind. */
  kind: PlanActionKind
  /** What the pass did for this path. */
  status: 'written' | 'verified' | 'absent' | 'sidecar' | 'retained' | 'skipped'
  /** Bytes written for this path (content + sidecars). */
  bytesWritten: number
}

/** Structured update report (§5). */
export interface UpdateReport {
  /** Installed version the update started from. */
  fromVersion: string | null
  /** Version being installed. */
  toVersion: string
  /** Apply status. */
  status: ApplyStatus
  /** Plan switch decision. */
  switchDecision: 'proceed' | 'abort'
  /** Action-kind histogram from the plan. */
  counts: PlanCounts
  /** Conflicts, with sidecars. */
  conflicts: PlanConflict[]
  /** Every preserved path and why. */
  preserved: PreservedPath[]
  /** Paths deleted by the update. */
  deletions: string[]
  /** Pinned paths whose replacement/merge/deletion was skipped. */
  pinned: string[]
  /** Sidecars written, with their hashes. */
  sidecars: { path: string; sha256: string }[]
  /** Written bytes counts. */
  bytes: { written: number; replaced: number }
  /** Qualified verification result; null when apply stopped before verification. */
  verification: VerificationResult | null
  /** Human-readable rendering of this report. */
  human: string
}

/** Result of an apply pass. */
export interface ApplyResult {
  /** Overall status. */
  status: ApplyStatus
  /** Plan fingerprint bound to this pass. */
  planFingerprint: string
  /** Journal path; null when no journal was requested. */
  journalPath: string | null
  /** Staging directory the pass operated on. */
  stagingRoot: string
  /** True when the pass continued an interrupted pass. */
  resumed: boolean
  /** Number of actions whose staged state was written in this pass. */
  wroteActions: number
  /** Bytes written in this pass (content and sidecars). */
  bytesWritten: number
  /** Gate result: every touched live-tree path kept its inode and hash. */
  liveTreeIntact: boolean
  /** Qualified verification result; null before verification ran. */
  verification: VerificationResult | null
  /** Conflicts, including aborting runtime-code conflicts. */
  conflicts: PlanConflict[]
  /** Pre-update backup directory when requested; null otherwise. */
  backupDir: string | null
  /** Structured update report. */
  report: UpdateReport
  /** Status detail (abort reason, mismatch summary); null when none. */
  detail: string | null
  /** Per-action results in plan order. */
  results: ApplyActionResult[]
}

/** Input for the §3.5 pre-update backup. */
export interface BackupResult {
  /** Directory the backup was written to. */
  dir: string
  /** Number of files/symlinks copied. */
  files: number
  /** Bytes copied. */
  bytes: number
  /** Backup manifest: relative path → baseline and local hashes. */
  baseline: Record<string, { baselineSha256: string | null; localSha256: string | null; reason: 'modified' | 'untracked' }>
}
