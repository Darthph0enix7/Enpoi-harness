/**
 * Session-log verification and self-healing.
 *
 * `verifySessionLog` walks one durable log and checks the durability
 * invariants the revert-iteration work depends on: sequence contiguity, every
 * marker target present, every branch record reachable, every offload target
 * present, every compaction summary source present, the surface fold
 * resolvable, and the derived iteration fold identical to a fresh recompute.
 *
 * `repairSessionLog` rebuilds what is derivable from the committed prefix:
 * missing indexes and folds are recomputed, a torn (never-committed) tail is
 * dropped from the derived view, and dangling references inside a corrupt
 * record are neutralized so the log replays. The durable events are never
 * rewritten or deleted: every repair acts on the returned derived view and is
 * reported in the result.
 *
 * @module
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  emptyIterationFoldState,
  foldIterationEvents,
  iterationEdges,
  type IterationFoldState,
} from './iteration-fold.ts'
import { foldSurfaceNodes } from './surface-view.ts'
import type {
  SessionRepairAction,
  SessionVerifyIssue,
  SessionVerifyIssueKind,
} from './verify-types.ts'

export type {
  SessionRepairAction,
  SessionRepairKind,
  SessionVerifyIssue,
  SessionVerifyIssueKind,
} from './verify-types.ts'

/** Structural event fields this module reads; durable events qualify. */
export interface SessionVerifyEvent {
  readonly type?: string
  readonly seq?: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
  readonly ignorable?: unknown
  readonly time?: number
}

/** Verification result for one log. */
export interface SessionVerifyReport {
  /** True when no error-severity issue remains. */
  readonly ok: boolean
  /** Number of committed (contiguous, well-formed) events seen. */
  readonly committedEventCount: number
  /** Every finding, in log order where a seq applies. */
  readonly issues: readonly SessionVerifyIssue[]
}

/** The log plus the derived state a caller already holds. */
export interface SessionVerificationInput {
  /** Durable events; the final entry may be a torn partial append. */
  readonly events: readonly SessionVerifyEvent[]
  /** Derived iteration fold to check, when the caller has one. */
  readonly index?: IterationFoldState
  /** Caller's current surface nodes, when the caller has a live surface. */
  readonly nodes?: readonly SessionSeq[]
}

/** Result of one self-heal pass over a log. */
export interface SessionRepairResult {
  /** Verification of the repaired derived view. */
  readonly report: SessionVerifyReport
  /** The repaired derived view; committed events survive unchanged. */
  readonly events: readonly SessionEvent[]
  /** The rebuilt surface nodes. */
  readonly nodes: readonly SessionSeq[]
  /** The rebuilt iteration fold. */
  readonly iterations: IterationFoldState
  /** Every repair applied, in order. */
  readonly applied: readonly SessionRepairAction[]
}

/** A log record neutralized in the derived view: unknown type, ignorable, no effect. */
const NEUTRALIZED_TYPE = 'verify/neutralized'

function isSafeSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function seqArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((seq): seq is number => isSafeSeq(seq)) : []
}

function isAscendingUnique(seqs: readonly number[]): boolean {
  for (let index = 1; index < seqs.length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
    if (seqs[index]! <= seqs[index - 1]!) return false
  }
  return true
}

/** Committed prefix plus the tail findings that ended it. */
interface PrefixScan {
  readonly committed: readonly SessionVerifyEvent[]
  readonly issues: SessionVerifyIssue[]
}

/** Split a log into its committed dense prefix and the reason the prefix ended. */
function scanPrefix(events: readonly SessionVerifyEvent[]): PrefixScan {
  const issues: SessionVerifyIssue[] = []
  let length = 0
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const seq = event?.seq
    if (event === undefined || typeof event.type !== 'string') {
      issues.push({
        kind: 'torn-tail',
        severity: 'error',
        seq: index,
        message: `record at index ${String(index)} is incomplete (a partial append that never committed)`,
        repairable: true,
      })
      break
    }
    if (!isSafeSeq(seq) || seq !== index) {
      const gapped = isSafeSeq(seq) && seq > index
      issues.push({
        kind: gapped ? 'sequence-gap' : 'torn-tail',
        severity: 'error',
        seq: index,
        message: gapped
          ? `event at index ${String(index)} carries seq ${String(seq)}: committed events are missing before it`
          : `event at index ${String(index)} carries seq ${String(seq)} instead of ${String(index)}`,
        repairable: !gapped,
      })
      break
    }
    length = index + 1
  }
  return { committed: events.slice(0, length), issues }
}

/** Whether one event declares a message projection for content this module folds as identity. */
function isUserOriginReplacement(event: SessionVerifyEvent): { startSeq: number; endSeq: number } | undefined {
  if (event.type !== 'user/message') return undefined
  const sourceKind = (event.data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
  if (sourceKind !== 'user') return undefined
  const op = event.surfaceOp as { readonly op?: unknown; readonly startSeq?: unknown; readonly endSeq?: unknown } | undefined
  if (op?.op !== 'replace' || !isSafeSeq(op.startSeq) || !isSafeSeq(op.endSeq)) return undefined
  return { startSeq: op.startSeq, endSeq: op.endSeq }
}

/** Structural checks that do not need a fold. */
function verifyRecords(committed: readonly SessionVerifyEvent[]): SessionVerifyIssue[] {
  const issues: SessionVerifyIssue[] = []
  const markerVariants = new Set<number>()
  for (const event of committed) {
    if (event.type === 'revert/iteration') {
      const data = event.data as { readonly variantSeq?: unknown } | undefined
      if (isSafeSeq(data?.variantSeq)) markerVariants.add(data.variantSeq)
    }
  }
  for (const event of committed) {
    const seq = event.seq
    if (typeof event.type === 'string'
      && !KNOWN_SESSION_EVENT_TYPES.has(event.type)
      && event.ignorable !== true) {
      issues.push({
        kind: 'unknown-event',
        severity: 'error',
        seq,
        message: `event type "${event.type}" is unknown and not marked ignorable; an older build refuses this log`,
        repairable: false,
      })
    }
    switch (event.type) {
      case 'revert/iteration': {
        const data = event.data as {
          readonly groupAnchor?: unknown
          readonly previousSeq?: unknown
          readonly variantSeq?: unknown
          readonly startSeq?: unknown
          readonly endSeq?: unknown
          readonly restoredFromSeq?: unknown
        } | undefined
        const fields: ReadonlyArray<readonly [string, unknown, boolean]> = [
          ['groupAnchor', data?.groupAnchor, false],
          ['previousSeq', data?.previousSeq, true],
          ['variantSeq', data?.variantSeq, false],
          ['startSeq', data?.startSeq, false],
          ['endSeq', data?.endSeq, false],
          ['restoredFromSeq', data?.restoredFromSeq, true],
        ]
        for (const [name, value, optional] of fields) {
          if (optional && value === undefined) continue
          if (!isSafeSeq(value)) {
            issues.push({
              kind: 'malformed-marker',
              severity: 'error',
              seq,
              message: `revert/iteration marker field ${name} is not a sequence`,
              repairable: true,
            })
            continue
          }
          if (committed[value] === undefined) {
            issues.push({
              kind: 'missing-marker-target',
              severity: 'error',
              seq,
              message: `revert/iteration marker ${name} names missing event ${String(value)}`,
              repairable: true,
            })
          }
        }
        break
      }
      case 'revert/branch': {
        const data = event.data as {
          readonly groupAnchor?: unknown
          readonly variantSeq?: unknown
          readonly previousVariantSeq?: unknown
          readonly startSeq?: unknown
          readonly endSeq?: unknown
          readonly shadowedSeqs?: unknown
          readonly restoredSeqs?: unknown
        } | undefined
        for (const [name, value, optional] of [
          ['groupAnchor', data?.groupAnchor, false],
          ['variantSeq', data?.variantSeq, false],
          ['previousVariantSeq', data?.previousVariantSeq, true],
          ['startSeq', data?.startSeq, false],
          ['endSeq', data?.endSeq, false],
        ] as const) {
          if (optional && value === undefined) continue
          if (!isSafeSeq(value) || committed[value] === undefined) {
            issues.push({
              kind: 'missing-branch-variant',
              severity: 'error',
              seq,
              message: `revert/branch ${name} is missing or names missing event ${String(value)}`,
              repairable: true,
            })
          }
        }
        for (const [name, value] of [['shadowedSeqs', data?.shadowedSeqs], ['restoredSeqs', data?.restoredSeqs]] as const) {
          const declared = seqArray(value)
          if (!Array.isArray(value) || declared.length !== value.length || !isAscendingUnique(declared)) {
            issues.push({
              kind: 'malformed-branch-list',
              severity: 'error',
              seq,
              message: `revert/branch ${name} must be unique ascending sequences`,
              repairable: true,
            })
          }
          for (const record of declared) {
            if (committed[record] === undefined) {
              issues.push({
                kind: 'unreachable-branch-record',
                severity: 'error',
                seq,
                message: `revert/branch ${name} names missing event ${String(record)}`,
                repairable: true,
              })
            }
          }
        }
        break
      }
      case 'image/offload': {
        const data = event.data as { readonly targets?: unknown } | undefined
        if (!Array.isArray(data?.targets) || data.targets.length === 0) {
          issues.push({
            kind: 'malformed-offload-target',
            severity: 'error',
            seq,
            message: 'image/offload requires a nonempty targets array',
            repairable: true,
          })
          break
        }
        for (const target of data.targets) {
          const record = typeof target === 'object' && target !== null
            ? (target as { readonly seq?: unknown }).seq
            : undefined
          const source = isSafeSeq(record) ? committed[record] : undefined
          if (source === undefined || (source.type !== 'user/message' && source.type !== 'tool/result')) {
            issues.push({
              kind: 'orphan-offload-target',
              severity: 'error',
              seq,
              message: `image/offload target ${String(record)} is missing or not a message event`,
              repairable: true,
            })
          }
        }
        break
      }
      case 'compaction/summary': {
        const data = event.data as { readonly shadowedSeqs?: unknown } | undefined
        for (const shadowed of seqArray(data?.shadowedSeqs)) {
          if (committed[shadowed] === undefined) {
            issues.push({
              kind: 'missing-summary-source',
              severity: 'error',
              seq,
              message: `compaction/summary shadowedSeq ${String(shadowed)} is missing`,
              repairable: true,
            })
          }
        }
        break
      }
      case 'user/message': {
        const sourceKind = (event.data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
        if (sourceKind === 'compact-checkpoint') {
          for (const cited of seqArray(event.sourceEventSeqs)) {
            if (committed[cited] === undefined) {
              issues.push({
                kind: 'missing-checkpoint-source',
                severity: 'error',
                seq,
                message: `compaction checkpoint cites missing event ${String(cited)}`,
                repairable: true,
              })
            }
          }
        }
        const replacement = isUserOriginReplacement(event)
        if (replacement !== undefined && seq !== undefined) {
          const startEvent = committed[replacement.startSeq]
          const startKind = (startEvent?.data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
          if (startKind === 'user' && !markerVariants.has(seq)) {
            issues.push({
              kind: 'missing-marker',
              severity: 'warning',
              seq,
              message: `user-origin replacement ${String(seq)} is not named by a revert/iteration marker; the fold derives its edge from surfaceOp.startSeq`,
              repairable: true,
            })
          }
        }
        break
      }
      default:
        break
    }
  }
  return issues
}

/** Stable string form of the fold's observable state, for recompute comparison. */
function iterationSignature(state: IterationFoldState): string {
  const branchSeqs = [...state.branchSeqs.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([variant, records]) => [variant, [...records].sort((left, right) => left - right)])
  const variantBySeq = [...state.variantBySeq.entries()].sort((left, right) => left[0] - right[0])
  return JSON.stringify({ edges: iterationEdges(state), branchSeqs, variantBySeq })
}

/** Fold checks: the surface resolves and the derived iteration fold recomputes identically. */
function verifyFolds(
  committed: readonly SessionVerifyEvent[],
  index: IterationFoldState | undefined,
  nodes: readonly SessionSeq[] | undefined,
): { issues: SessionVerifyIssue[]; rebuilt: IterationFoldState; foldedNodes: readonly SessionSeq[] | undefined } {
  const issues: SessionVerifyIssue[] = []
  let rebuilt = emptyIterationFoldState()
  let foldedNodes: readonly SessionSeq[] | undefined
  const events = committed as readonly SessionEvent[]
  try {
    foldedNodes = foldSurfaceNodes(events)
  } catch (error: unknown) {
    issues.push({
      kind: 'surface-fold-error',
      severity: 'error',
      message: `surface fold failed: ${error instanceof Error ? error.message : String(error)}`,
      repairable: false,
    })
  }
  if (foldedNodes !== undefined) {
    for (const node of foldedNodes) {
      if (committed[node] === undefined) {
        issues.push({
          kind: 'unresolved-surface-node',
          severity: 'error',
          seq: node,
          message: `surface node ${String(node)} has no backing event`,
          repairable: true,
        })
      }
    }
    if (nodes !== undefined && JSON.stringify([...foldedNodes]) !== JSON.stringify([...nodes])) {
      issues.push({
        kind: 'surface-fold-divergence',
        severity: 'error',
        message: 'the caller surface nodes differ from a fresh fold of the durable log',
        repairable: true,
      })
    }
  }
  try {
    rebuilt = foldIterationEvents(events)
  } catch (error: unknown) {
    issues.push({
      kind: 'fold-divergence',
      severity: 'error',
      message: `iteration fold failed: ${error instanceof Error ? error.message : String(error)}`,
      repairable: true,
    })
    return { issues, rebuilt, foldedNodes }
  }
  if (index !== undefined && iterationSignature(rebuilt) !== iterationSignature(index)) {
    issues.push({
      kind: 'fold-divergence',
      severity: 'error',
      message: 'the derived iteration fold differs from a fresh recompute of the durable log',
      repairable: true,
    })
  }
  for (const [variant, records] of rebuilt.branchSeqs) {
    for (const record of records) {
      if (committed[record] === undefined) {
        issues.push({
          kind: 'unreachable-branch-record',
          severity: 'error',
          seq: variant,
          message: `folded branch of variant ${String(variant)} references missing event ${String(record)}`,
          repairable: true,
        })
      }
    }
  }
  return { issues, rebuilt, foldedNodes }
}

/**
 * Verify one session log against the durability invariants.
 * @param input - log, optional derived index, and optional live surface nodes.
 * @returns the findings and the committed prefix length.
 */
export function verifySessionLog(input: SessionVerificationInput): SessionVerifyReport {
  const scanned = scanPrefix(input.events)
  const issues = [...scanned.issues, ...verifyRecords(scanned.committed)]
  const folds = verifyFolds(scanned.committed, input.index, input.nodes)
  issues.push(...folds.issues)
  issues.sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1))
  return {
    ok: !issues.some(issue => issue.severity === 'error'),
    committedEventCount: scanned.committed.length,
    issues,
  }
}

/** Replace one derived log record with an inert tombstone. */
function neutralized(event: SessionVerifyEvent): SessionVerifyEvent {
  return { ...event, type: NEUTRALIZED_TYPE, data: {}, ignorable: true }
}

function hasIssueFor(issues: readonly SessionVerifyIssue[], seq: number | undefined, kinds: readonly SessionVerifyIssueKind[]): boolean {
  return issues.some(issue => issue.seq === seq && kinds.includes(issue.kind))
}

/** Sanitize one record's dangling references; returns the record to keep. */
function sanitizeRecord(
  event: SessionVerifyEvent,
  committed: readonly SessionVerifyEvent[],
  issues: readonly SessionVerifyIssue[],
  seq: number,
  applied: SessionRepairAction[],
): SessionVerifyEvent {
  const missingTarget = hasIssueFor(issues, seq, ['missing-marker-target', 'malformed-marker'])
  if (event.type === 'revert/iteration') {
    if (missingTarget) {
      applied.push({ kind: 'neutralized-record', seq, detail: 'dangling revert/iteration marker neutralized in the derived view' })
      return neutralized(event)
    }
    return event
  }
  if (event.type === 'revert/branch') {
    if (hasIssueFor(issues, seq, ['missing-branch-variant', 'malformed-branch-list'])) {
      applied.push({ kind: 'neutralized-record', seq, detail: 'malformed revert/branch switch neutralized in the derived view' })
      return neutralized(event)
    }
    if (hasIssueFor(issues, seq, ['unreachable-branch-record'])) {
      const data = event.data as { readonly restoredSeqs?: unknown; readonly shadowedSeqs?: unknown }
      const restored = seqArray(data.restoredSeqs).filter(record => committed[record] !== undefined)
      if (restored.length === 0) {
        applied.push({ kind: 'neutralized-record', seq, detail: 'revert/branch with no reachable restored records neutralized' })
        return neutralized(event)
      }
      applied.push({
        kind: 'filtered-references',
        seq,
        detail: 'revert/branch dangling branch records removed from the derived view',
      })
      return { ...event, data: { ...(event.data as object), restoredSeqs: restored } }
    }
    return event
  }
  if (event.type === 'image/offload') {
    const data = event.data as { readonly targets?: unknown }
    if (hasIssueFor(issues, seq, ['malformed-offload-target'])) {
      applied.push({ kind: 'neutralized-record', seq, detail: 'malformed image/offload decision neutralized in the derived view' })
      return neutralized(event)
    }
    if (!Array.isArray(data.targets)) return event
    const targets = data.targets.filter((target) => {
      const record = typeof target === 'object' && target !== null
        ? (target as { readonly seq?: unknown }).seq
        : undefined
      return isSafeSeq(record) && committed[record] !== undefined
    })
    if (targets.length === data.targets.length) return event
    applied.push({
      kind: 'filtered-references',
      seq,
      detail: 'image/offload orphan target(s) removed from the derived view',
    })
    return targets.length === 0
      ? neutralized(event)
      : { ...event, data: { ...(event.data as object), targets } }
  }
  if (event.type === 'compaction/summary') {
    if (!hasIssueFor(issues, seq, ['missing-summary-source'])) return event
    const data = event.data as { readonly shadowedSeqs?: unknown }
    const shadowedSeqs = seqArray(data.shadowedSeqs).filter(record => committed[record] !== undefined)
    applied.push({ kind: 'filtered-references', seq, detail: 'compaction/summary missing shadowed source(s) removed from the derived view' })
    return shadowedSeqs.length === 0
      ? neutralized(event)
      : { ...event, data: { ...(event.data as object), shadowedSeqs } }
  }
  if (event.type === 'user/message' && hasIssueFor(issues, seq, ['missing-checkpoint-source'])) {
    const cited = seqArray(event.sourceEventSeqs).filter(record => committed[record] !== undefined)
    applied.push({ kind: 'filtered-references', seq, detail: 'compaction checkpoint missing citation(s) removed from the derived view' })
    return { ...event, sourceEventSeqs: cited }
  }
  return event
}

/**
 * Repair one session log: recover the committed prefix, neutralize dangling
 * references in the derived view, and rebuild every derived fold. The durable
 * event set is never rewritten or reduced; only a torn, never-committed tail
 * and references to absent events are dropped from the returned view.
 * @param input - log, optional derived index, and optional live surface nodes.
 * @returns the repaired view with a verification report that is `ok` for every repairable finding.
 */
export function repairSessionLog(input: SessionVerificationInput): SessionRepairResult {
  const applied: SessionRepairAction[] = []
  const first = verifySessionLog(input)
  const scanned = scanPrefix(input.events)
  let committed: readonly SessionVerifyEvent[] = [...scanned.committed]
  if (scanned.committed.length < input.events.length) {
    applied.push({
      kind: 'truncated-torn-tail',
      seq: scanned.committed.length,
      detail: `dropped ${String(input.events.length - scanned.committed.length)} never-committed tail record(s) from the derived view`,
    })
  }
  const issues = [...scanned.issues, ...verifyRecords(scanned.committed)]
  const view: SessionVerifyEvent[] = committed.map((event, index) => sanitizeRecord(event, committed, issues, index, applied))
  const fold = (candidate: readonly SessionVerifyEvent[]): { nodes: readonly SessionSeq[]; iterations: IterationFoldState } => ({
    nodes: foldSurfaceNodes(candidate as readonly SessionEvent[]),
    iterations: foldIterationEvents(candidate as readonly SessionEvent[]),
  })
  let folded: { nodes: readonly SessionSeq[]; iterations: IterationFoldState }
  try {
    folded = fold(view)
  } catch {
    // A surface transition that still rejects the log can only be a branch
    // switch the sanitizer could not make coherent; neutralize every branch
    // record in the derived view and replay. Durable events stay untouched.
    for (let index = 0; index < view.length; index += 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- bounded by the loop condition
      const event = view[index]!
      if (event.type === 'revert/branch') {
        view[index] = neutralized(event)
        applied.push({ kind: 'neutralized-record', seq: index, detail: 'unreplayable revert/branch switch neutralized in the derived view' })
      }
    }
    try {
      folded = fold(view)
    } catch (error: unknown) {
      // The durable prefix itself cannot be replayed; report the residual.
      applied.push({ kind: 'rebuilt-surface-fold', detail: `surface fold remains invalid: ${error instanceof Error ? error.message : String(error)}` })
      folded = { nodes: [], iterations: emptyIterationFoldState() }
    }
  }
  if (input.index === undefined || first.issues.some(issue => issue.kind === 'fold-divergence')) {
    applied.push({ kind: 'rebuilt-iteration-fold', detail: 'iteration fold recomputed from the committed prefix' })
  }
  if (input.nodes === undefined || first.issues.some(issue => issue.kind === 'surface-fold-divergence')) {
    applied.push({ kind: 'rebuilt-surface-fold', detail: 'surface node fold recomputed from the committed prefix' })
  }
  committed = view
  const verified = verifySessionLog({ events: committed, index: folded.iterations, nodes: folded.nodes })
  // A sequence gap ends the committed prefix, so the repaired view can no
  // longer witness it; the receipt keeps it because repair restores what is
  // derivable and never invents the missing events. Every other unrepairable
  // finding either survives in the repaired view or was recoverable by
  // neutralizing the record that caused it.
  const remaining = [...verified.issues]
  for (const issue of first.issues) {
    if (issue.kind !== 'sequence-gap') continue
    if (remaining.some(candidate => candidate.kind === issue.kind && candidate.seq === issue.seq)) continue
    remaining.push(issue)
  }
  remaining.sort((left, right) => (left.seq ?? -1) - (right.seq ?? -1))
  return {
    report: {
      ok: !remaining.some(issue => issue.severity === 'error'),
      committedEventCount: verified.committedEventCount,
      issues: remaining,
    },
    events: committed as readonly SessionEvent[],
    nodes: folded.nodes,
    iterations: folded.iterations,
    applied,
  }
}
