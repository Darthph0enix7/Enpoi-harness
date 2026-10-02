/**
 * Structural result types for session-log verification and repair.
 *
 * Kept free of imports so the Host/Client shared `types.ts` can carry the
 * `verifyLog`/`repairLog` Remote values without pulling the verification fold
 * (and its durable Session imports) into the Client compiler face.
 *
 * @module
 */

/** One invariant violation found in a log. */
export type SessionVerifyIssueKind =
  /** A final record without a newline-equivalent commit (a torn partial append). */
  | 'torn-tail'
  /** A seq gap with later committed records after it. */
  | 'sequence-gap'
  /** An event type neither known nor marked ignorable. */
  | 'unknown-event'
  /** A `revert/iteration` marker whose required fields are missing or malformed. */
  | 'malformed-marker'
  /** A marker names a seq that does not exist. */
  | 'missing-marker-target'
  /** A user-origin replacement has no durable `revert/iteration` marker (pre-marker fallback log). */
  | 'missing-marker'
  /** A `revert/branch` list is malformed (not arrays of unique ascending seqs). */
  | 'malformed-branch-list'
  /** A branch list names a seq that does not exist. */
  | 'unreachable-branch-record'
  /** A `revert/branch` switch names a missing variant or group anchor. */
  | 'missing-branch-variant'
  /** An `image/offload` target names a missing or non-message event. */
  | 'orphan-offload-target'
  /** An `image/offload` decision is not a nonempty target list. */
  | 'malformed-offload-target'
  /** A `compaction/summary.shadowedSeqs` entry does not exist. */
  | 'missing-summary-source'
  /** A compaction checkpoint cites a seq that does not exist. */
  | 'missing-checkpoint-source'
  /** The surface fold rejects the log. */
  | 'surface-fold-error'
  /** The surface fold resolves to different nodes than the caller's surface. */
  | 'surface-fold-divergence'
  /** A resolved surface node has no backing event. */
  | 'unresolved-surface-node'
  /** The derived iteration fold differs from a fresh recompute. */
  | 'fold-divergence'

/** One verification finding. */
export interface SessionVerifyIssue {
  /** The invariant that failed. */
  readonly kind: SessionVerifyIssueKind
  /** `error` breaks replay; `warning` is derivable (e.g. a pre-marker log). */
  readonly severity: 'error' | 'warning'
  /** Event seq the finding is about, when it belongs to one. */
  readonly seq?: number | undefined
  /** Human-readable diagnostic. */
  readonly message: string
  /** Whether the repair pass can make the repaired view pass. */
  readonly repairable: boolean
}

/** One repair applied to the derived view. */
export type SessionRepairKind =
  /** The torn, never-committed tail was dropped from the derived view. */
  | 'truncated-torn-tail'
  /** A dangling record was neutralized so the log replays. */
  | 'neutralized-record'
  /** Dangling references inside a record were removed. */
  | 'filtered-references'
  /** The iteration fold was rebuilt from the committed prefix. */
  | 'rebuilt-iteration-fold'
  /** The surface node fold was rebuilt from the committed prefix. */
  | 'rebuilt-surface-fold'

/** One repair action, for the operator receipt. */
export interface SessionRepairAction {
  /** What was repaired. */
  readonly kind: SessionRepairKind
  /** Event seq the repair belongs to, when it belongs to one. */
  readonly seq?: number | undefined
  /** Concrete description of the change. */
  readonly detail: string
}
