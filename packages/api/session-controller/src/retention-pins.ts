/**
 * Durable retention pins: the do-not-delete manifest over one Session log.
 *
 * No cleanup path exists today. Any future trim, rotation, or prune MUST
 * compute this manifest first and route every candidate removal through
 * {@link assertRemovalSafe}: a pinned seq can never be removed, because doing
 * so would break a restartable surface, an iteration branch, an image-offload
 * replay, or a compaction checkpoint — the mandate is that nothing may ever be
 * deleted, corrupted, or unreachable.
 *
 * The manifest is a pure fold over durable events plus the current surface
 * nodes, so it can be rebuilt from the log at any time and reused by a future
 * GC planner.
 *
 * @module
 */

import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { foldSurfaceNodes } from './surface-view.ts'

/**
 * Structural event fields the pin fold reads; durable Session events qualify.
 * A repaired or neutralized derived view can be pinned the same way, so a
 * cleanup planner never needs the owning plugin for an inert record.
 */
export interface RetentionPinEvent {
  /** Durable event type, when the record is well formed. */
  readonly type?: string
  /** Durable sequence, when the record is committed. */
  readonly seq?: number
  /** Event payload, read structurally per type. */
  readonly data?: unknown
  /** Live surface citations, when the record carries them. */
  readonly sourceEventSeqs?: unknown
}

/** Why one seq must never be physically removed or rewritten. */
export type RetentionPinCategory =
  /** A `revert/iteration` marker's own record. */
  | 'iteration-marker'
  /** A variant, group anchor, or replaced-span seq named by an iteration marker. */
  | 'iteration-variant'
  /** A shadowed or restored record named by a `revert/branch` switch. */
  | 'branch-record'
  /** A current model-visible surface node. */
  | 'surface-node'
  /** A seq cited by a live surface node's `sourceEventSeqs`. */
  | 'surface-source'
  /** A target seq of an `image/offload` decision. */
  | 'offload-target'
  /** A seq listed in a `compaction/summary.shadowedSeqs`. */
  | 'compaction-shadowed'
  /** A compaction checkpoint node or a seq it cites. */
  | 'compaction-checkpoint'
  /** A seq a `revert/state` boundary points at. */
  | 'revert-boundary'

/** One pinned seq with every reason it is pinned. */
export interface RetentionPin {
  /** The pinned durable sequence. */
  readonly seq: number
  /** Every category that pinned the seq, in first-pin order. */
  readonly categories: readonly RetentionPinCategory[]
  /** Human-readable reasons, for the fail-loud removal diagnostic. */
  readonly reasons: readonly string[]
}

/**
 * The do-not-delete set of one Session. Membership is O(1); reasons are kept
 * for the refusal message.
 */
export interface RetentionPinManifest {
  /** Pinned seqs keyed by seq. */
  readonly pins: ReadonlyMap<number, RetentionPin>
  /**
   * Whether one seq is pinned.
   * @param seq - durable sequence to test.
   * @returns true when removing the seq is forbidden.
   */
  has(seq: number): boolean
  /**
   * Every pinned seq, ascending.
   * @returns a fresh sorted array.
   */
  seqs(): number[]
}

/** One refused removal: the seq and why it may not be removed. */
export interface RetentionViolation {
  /** The pinned seq a caller attempted to remove. */
  readonly seq: number
  /** Every reason the seq is pinned. */
  readonly reasons: readonly string[]
}

/** Thrown by the removal guard when a plan names a pinned seq. */
export class RetentionViolationError extends Error {
  override name = 'RetentionViolationError'

  /**
   * @param violations - every pinned seq in the refused plan, ascending.
   */
  constructor(readonly violations: readonly RetentionViolation[]) {
    super(
      `retention violation: refusing to remove ${String(violations.length)} pinned seq(s): `
      + violations.map(violation => `${String(violation.seq)} (${violation.reasons.join('; ')})`).join(', '),
    )
  }
}

/** Mutable accumulator for one pin pass. */
interface MutablePinManifest {
  readonly pins: Map<number, { categories: RetentionPinCategory[]; reasons: string[] }>
}

function createManifest(): MutablePinManifest {
  return { pins: new Map() }
}

function pin(
  manifest: MutablePinManifest,
  seq: unknown,
  category: RetentionPinCategory,
  reason: string,
): void {
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return
  const existing = manifest.pins.get(seq)
  if (existing === undefined) {
    manifest.pins.set(seq, { categories: [category], reasons: [reason] })
    return
  }
  if (!existing.categories.includes(category)) existing.categories.push(category)
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
}

function finish(manifest: MutablePinManifest): RetentionPinManifest {
  const pins = new Map<number, RetentionPin>()
  for (const [seq, entry] of manifest.pins) {
    pins.set(seq, { seq, categories: [...entry.categories], reasons: [...entry.reasons] })
  }
  const frozen = Object.freeze(pins)
  return {
    pins: frozen,
    has: (seq: number) => frozen.has(seq),
    seqs: () => [...frozen.keys()].sort((left, right) => left - right),
  }
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((seq): seq is number => typeof seq === 'number') : []
}

/**
 * Compute the do-not-delete manifest for one durable log.
 *
 * Pins: every `revert/iteration` and `revert/branch` marker field, every
 * current surface node and its `sourceEventSeqs`, every `image/offload`
 * target, every `compaction/summary.shadowedSeqs`, every compaction
 * checkpoint and the seqs it cites, and every `revert/state` boundary target.
 * @param events - dense zero-based durable events.
 * @param nodes - current surface nodes; folded from the log when omitted.
 * @returns the immutable pin manifest.
 */
export function computeRetentionPins(
  events: readonly RetentionPinEvent[],
  nodes?: readonly SessionSeq[],
): RetentionPinManifest {
  const manifest = createManifest()
  for (const event of events) {
    const seq = event.seq
    // Plugin-owned event types (image/offload, compaction/summary) are read
    // structurally: this package declares no dependency on their plugins.
    const type = event.type
    const data: unknown = (event as { readonly data?: unknown }).data
    if (type === 'revert/iteration') {
      const fields = data as {
        readonly groupAnchor?: unknown
        readonly previousSeq?: unknown
        readonly variantSeq?: unknown
        readonly startSeq?: unknown
        readonly endSeq?: unknown
        readonly restoredFromSeq?: unknown
      }
      pin(manifest, seq, 'iteration-marker', `revert/iteration marker at seq ${String(seq)}`)
      const label = `revert/iteration at seq ${String(seq)}`
      pin(manifest, fields.groupAnchor, 'iteration-variant', `group anchor named by ${label}`)
      pin(manifest, fields.previousSeq, 'iteration-variant', `previous variant named by ${label}`)
      pin(manifest, fields.variantSeq, 'iteration-variant', `variant named by ${label}`)
      pin(manifest, fields.startSeq, 'iteration-variant', `replaced span start named by ${label}`)
      pin(manifest, fields.endSeq, 'iteration-variant', `replaced span end named by ${label}`)
      pin(manifest, fields.restoredFromSeq, 'iteration-variant', `restored variant named by ${label}`)
    } else if (type === 'revert/branch') {
      const fields = data as {
        readonly groupAnchor?: unknown
        readonly variantSeq?: unknown
        readonly previousVariantSeq?: unknown
        readonly startSeq?: unknown
        readonly endSeq?: unknown
        readonly shadowedSeqs?: unknown
        readonly restoredSeqs?: unknown
      }
      pin(manifest, seq, 'iteration-marker', `revert/branch switch at seq ${String(seq)}`)
      const label = `revert/branch at seq ${String(seq)}`
      pin(manifest, fields.groupAnchor, 'iteration-variant', `group anchor named by ${label}`)
      pin(manifest, fields.variantSeq, 'iteration-variant', `active variant named by ${label}`)
      pin(manifest, fields.previousVariantSeq, 'iteration-variant', `displaced variant named by ${label}`)
      pin(manifest, fields.startSeq, 'branch-record', `shadowed span start named by ${label}`)
      pin(manifest, fields.endSeq, 'branch-record', `shadowed span end named by ${label}`)
      for (const record of numberArray(fields.shadowedSeqs)) {
        pin(manifest, record, 'branch-record', `shadowed branch record named by ${label}`)
      }
      for (const record of numberArray(fields.restoredSeqs)) {
        pin(manifest, record, 'branch-record', `restored branch record named by ${label}`)
      }
    } else if (type === 'revert/state') {
      const fields = data as { readonly fromSeq?: unknown }
      if (typeof fields.fromSeq === 'number') {
        pin(manifest, fields.fromSeq, 'revert-boundary', `revert/state boundary at seq ${String(seq)}`)
      }
    } else if (type === 'image/offload') {
      const fields = data as { readonly targets?: unknown }
      if (!Array.isArray(fields.targets)) continue
      for (const target of fields.targets) {
        if (typeof target !== 'object' || target === null) continue
        pin(
          manifest,
          (target as { readonly seq?: unknown }).seq,
          'offload-target',
          `image/offload decision at seq ${String(seq)}`,
        )
      }
    } else if (type === 'compaction/summary') {
      const fields = data as { readonly shadowedSeqs?: unknown }
      for (const shadowed of numberArray(fields.shadowedSeqs)) {
        pin(manifest, shadowed, 'compaction-shadowed', `compaction/summary at seq ${String(seq)}`)
      }
    } else if (type === 'user/message') {
      const kind: unknown = (data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
      if (kind !== 'compact-checkpoint') continue
      pin(manifest, seq, 'compaction-checkpoint', `compaction checkpoint at seq ${String(seq)}`)
      for (const source of numberArray(event.sourceEventSeqs)) {
        pin(manifest, source, 'compaction-checkpoint', `seq cited by compaction checkpoint at seq ${String(seq)}`)
      }
    }
  }
  const surfaceNodes = nodes ?? foldSurfaceNodes(events as readonly SessionEvent[])
  for (const node of surfaceNodes) {
    pin(manifest, node, 'surface-node', 'current model-visible surface node')
    const event = events[node]
    if (event === undefined) continue
    for (const source of numberArray(event.sourceEventSeqs)) {
      pin(manifest, source, 'surface-source', `sourceEventSeqs cited by live surface node ${String(node)}`)
    }
  }
  return finish(manifest)
}

/**
 * Compute the retention-pin manifest for one live Session.
 * @param session - Session whose durable log and current surface are pinned.
 * @returns the immutable pin manifest.
 */
export function computeSessionRetentionPins(session: Session): RetentionPinManifest {
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-deprecated -- a GC-time manifest reads the whole durable log by design.
  return computeRetentionPins(session.snapshotEvents(), session.surface.nodes)
}

/**
 * Refuse a removal plan that names any pinned seq. This is the single
 * enforcement seam every future trim, rotation, or prune must call before it
 * removes or rewrites anything; it fails loud with the reason for each
 * violation and never partially proceeds.
 * @param manifest - pins computed for the same durable log.
 * @param seqs - candidate seqs the caller intends to remove or rewrite.
 * @throws {RetentionViolationError} when at least one seq is pinned.
 */
export function assertRemovalSafe(manifest: RetentionPinManifest, seqs: Iterable<number>): void {
  const violations: RetentionViolation[] = []
  const seen = new Set<number>()
  for (const seq of seqs) {
    if (seen.has(seq)) continue
    seen.add(seq)
    const entry = manifest.pins.get(seq)
    if (entry !== undefined) violations.push({ seq, reasons: entry.reasons })
  }
  if (violations.length > 0) {
    violations.sort((left, right) => left.seq - right.seq)
    throw new RetentionViolationError(violations)
  }
}

/**
 * Bind {@link assertRemovalSafe} to one manifest for a cleanup planner.
 * @param manifest - pins computed for the same durable log.
 * @returns a guard that refuses pinned seqs.
 */
export function retentionGuardOf(
  manifest: RetentionPinManifest,
): (seqs: Iterable<number>) => void {
  return (seqs) => {
    assertRemovalSafe(manifest, seqs)
  }
}
