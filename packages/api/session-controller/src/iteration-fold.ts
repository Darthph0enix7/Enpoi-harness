/**
 * Shared fold for the durable revert-iteration pointer index.
 *
 * The index is a pure fold over durable Session events: the fixed-size
 * `revert/iteration` markers emitted by the agent loop plus a read-only
 * fallback that derives edges from `surfaceOp.startSeq` on user-origin
 * replacements for logs written before the marker existed. No content is
 * stored: variants are the original events, and a `previousSeq` field records
 * the tree edge for navigation.
 *
 * The same module runs on the Host (history folding and the list/restore RPCs)
 * and in the Client (the live event stream), which is what keeps the ◀ x/y ▶
 * data identical on both sides and refreshing for every attached client.
 *
 * @module
 */
import type { SessionIterationEdge, SessionIterationEdgeVariant } from './types.ts'

/** Mutable per-group accumulator; `variants` preserves first-seen (creation) order. */
interface MutableIterationGroup {
  readonly anchorSeq: number
  /** Variant seq → the variant it replaced (the tree edge), in creation order. */
  readonly variants: Map<number, number | null>
  /** The variant currently representing the group position, or null when shadowed. */
  activeVariantSeq: number | null
}

/** Fold accumulator for the iteration index. */
export interface IterationFoldState {
  /** Groups keyed by the original variant (the group anchor). */
  readonly groups: Map<number, MutableIterationGroup>
  /** Variant seq → owning group anchor. */
  readonly variantBySeq: Map<number, number>
  /** User-message seqs whose `source.kind` is `user`; the fallback filter. */
  readonly userOriginSeqs: Set<number>
}

/** Structural event fields the fold reads; durable Session events and test doubles qualify. */
export interface IterationFoldEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/**
 * Create an accumulator with no groups, variants, or user-origin seqs.
 * @returns an empty accumulator.
 */
export function emptyIterationFoldState(): IterationFoldState {
  return { groups: new Map(), variantBySeq: new Map(), userOriginSeqs: new Set() }
}

/**
 * Resolve the group anchor that owns one variant seq.
 * A seq that is itself a group anchor (the original variant) resolves to itself.
 * @param state - folded index.
 * @param seq - user-message seq.
 * @returns the group anchor, or undefined when the seq is not a known variant.
 */
export function iterationAnchorOf(state: IterationFoldState, seq: number): number | undefined {
  if (state.groups.has(seq)) return seq
  return state.variantBySeq.get(seq)
}

/**
 * Fold one durable event into the index.
 *
 * `revert/iteration` markers add the authoritative edge; a user-origin
 * `surfaceOp: replace` event adds the same edge when the marker is absent
 * (pre-marker logs). A user-origin replacement also deactivates every group
 * whose active variant falls inside the replaced span: that variant is no
 * longer represented on the surface. Compaction checkpoints are deliberately
 * not user-origin, so shadowing a variant with a checkpoint keeps the group
 * active — the checkpoint is the group's surface anchor.
 * @param state - accumulator mutated in place.
 * @param event - durable event in log order.
 * @returns whether the fold changed observable state.
 */
export function foldIterationEvent(state: IterationFoldState, event: IterationFoldEvent): boolean {
  if (event.type === 'user/message') {
    const sourceKind = (event.data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
    if (sourceKind !== 'user') return false
    state.userOriginSeqs.add(event.seq)
    const surfaceOp = event.surfaceOp as {
      readonly op?: string
      readonly startSeq?: number
      readonly endSeq?: number
    } | undefined
    if (surfaceOp?.op !== 'replace'
      || typeof surfaceOp.startSeq !== 'number'
      || typeof surfaceOp.endSeq !== 'number') return false
    deactivateShadowed(state, surfaceOp.startSeq, surfaceOp.endSeq)
    // Fallback edges exist only for replacements of an earlier user-origin
    // message; a checkpoint-anchored restore carries its own marker instead.
    if (state.userOriginSeqs.has(surfaceOp.startSeq)) {
      recordVariant(state, iterationAnchorOf(state, surfaceOp.startSeq) ?? surfaceOp.startSeq, event.seq, surfaceOp.startSeq)
    }
    return true
  }
  if (event.type === 'revert/iteration') {
    const data = event.data as {
      readonly groupAnchor?: unknown
      readonly previousSeq?: unknown
      readonly variantSeq?: unknown
    } | undefined
    if (typeof data?.groupAnchor !== 'number' || typeof data.variantSeq !== 'number') return false
    const previousSeq = typeof data.previousSeq === 'number' ? data.previousSeq : null
    // The marker is the durable edge and outranks a fallback derivation.
    return recordVariant(state, data.groupAnchor, data.variantSeq, previousSeq, true)
  }
  return false
}

/**
 * Fold a complete prefix of a durable log into a fresh index.
 * @param events - dense zero-based log events.
 * @param throughSeq - inclusive final seq; defaults to the last event.
 * @returns the folded index.
 */
export function foldIterationEvents(
  events: readonly IterationFoldEvent[],
  throughSeq = events.length - 1,
): IterationFoldState {
  const state = emptyIterationFoldState()
  for (let seq = 0; seq <= throughSeq && seq < events.length; seq++) {
    const event = events[seq]
    if (event !== undefined) foldIterationEvent(state, event)
  }
  return state
}

/**
 * Adopt a durable wire block as a mutable index.
 * @param edges - groups delivered with a history page or follow snapshot.
 * @returns an index with copied maps.
 */
export function adoptIterationEdges(edges: readonly SessionIterationEdge[] | undefined): IterationFoldState {
  const state = emptyIterationFoldState()
  // Legacy transports predate the iteration block; absence means no groups.
  for (const edge of edges ?? []) {
    for (const variant of edge.variants) {
      recordVariant(state, edge.anchorSeq, variant.seq, variant.previousSeq)
    }
    const group = state.groups.get(edge.anchorSeq)
    // The wire's active pointer may be null (shadowed away) or an earlier
    // variant than the last created one; both are deliberate, so adopt it.
    if (group !== undefined) group.activeVariantSeq = edge.activeVariantSeq
  }
  return state
}

/**
 * Encode the index as the durable wire block carried by history pages.
 * @param state - folded index.
 * @returns groups sorted by anchor seq, variants in creation order.
 */
export function iterationEdges(state: IterationFoldState): SessionIterationEdge[] {
  return [...state.groups.values()]
    .sort((left, right) => left.anchorSeq - right.anchorSeq)
    .map(group => ({
      anchorSeq: group.anchorSeq,
      activeVariantSeq: group.activeVariantSeq,
      variants: [...group.variants.entries()].map(([seq, previousSeq]): SessionIterationEdgeVariant => ({
        seq,
        previousSeq,
      })),
    }))
}

/** Clear the active variant of every group whose representation the span shadowed. */
function deactivateShadowed(state: IterationFoldState, startSeq: number, endSeq: number): void {
  for (const group of state.groups.values()) {
    const active = group.activeVariantSeq
    if (active !== null && active >= startSeq && active <= endSeq) group.activeVariantSeq = null
  }
}

/** Record one variant edge and make it the group's active variant. */
function recordVariant(
  state: IterationFoldState,
  groupAnchor: number,
  variantSeq: number,
  previousSeq: number | null,
  overwrite = false,
): boolean {
  let group = state.groups.get(groupAnchor)
  if (group === undefined) {
    // The original message is the chain's first variant (DESIGN §1.1): the
    // group's variant list must count it, not start at the first replacement.
    group = { anchorSeq: groupAnchor, variants: new Map([[groupAnchor, null]]), activeVariantSeq: null }
    state.groups.set(groupAnchor, group)
  }
  const known = group.variants.get(variantSeq)
  if (known === undefined || (overwrite && known !== previousSeq)) group.variants.set(variantSeq, previousSeq)
  state.variantBySeq.set(variantSeq, groupAnchor)
  if (group.activeVariantSeq === variantSeq) return false
  group.activeVariantSeq = variantSeq
  return true
}
