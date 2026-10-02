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
  /**
   * The shadowed surface records of every inactive variant, ascending. A
   * branch switch restores one entry and records the branch it shadowed, so
   * switching back is exact; the active variant has no entry.
   */
  readonly branchSeqs: Map<number, number[]>
  /** Replacement seq → the surface nodes it shadowed, until its marker names the variant. */
  readonly pendingShadowed: Map<number, number[]>
  /**
   * Every seq cited by a compaction checkpoint's `sourceEventSeqs`. The
   * checkpoint represents the group position for the variants it cites, so
   * this set answers "is this variant still represented?" without scanning
   * the live surface on every listing.
   */
  readonly checkpointCited: Set<number>
}

/** Structural event fields the fold reads; durable Session events and test doubles qualify. */
export interface IterationFoldEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

/**
 * Create an accumulator with no groups, variants, or user-origin seqs.
 * @returns an empty accumulator.
 */
export function emptyIterationFoldState(): IterationFoldState {
  return {
    groups: new Map(),
    variantBySeq: new Map(),
    userOriginSeqs: new Set(),
    branchSeqs: new Map(),
    pendingShadowed: new Map(),
    checkpointCited: new Set(),
  }
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
    if (sourceKind === 'compact-checkpoint') {
      // A compaction checkpoint represents every variant it cites; the
      // listing reads this set instead of scanning the live surface.
      if (Array.isArray(event.sourceEventSeqs)) {
        for (const cited of event.sourceEventSeqs) {
          if (typeof cited === 'number') state.checkpointCited.add(cited)
        }
      }
      return false
    }
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
    const shadowed = Array.isArray(event.sourceEventSeqs)
      ? event.sourceEventSeqs.filter((seq): seq is number => typeof seq === 'number').sort((left, right) => left - right)
      : undefined
    if (shadowed !== undefined && shadowed.length > 0) {
      // The marker that names this replacement's previous variant may arrive
      // next; until then the shadowed records belong to that variant.
      state.pendingShadowed.set(event.seq, shadowed)
    }
    deactivateShadowed(state, surfaceOp.startSeq, surfaceOp.endSeq)
    // Fallback edges exist only for replacements of an earlier user-origin
    // message; a checkpoint-anchored replacement carries its own marker.
    if (state.userOriginSeqs.has(surfaceOp.startSeq)) {
      if (shadowed !== undefined && shadowed.length > 0) {
        state.branchSeqs.set(surfaceOp.startSeq, shadowed)
      }
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
    if (previousSeq !== null) {
      const shadowed = state.pendingShadowed.get(data.variantSeq)
      if (shadowed !== undefined) state.branchSeqs.set(previousSeq, shadowed)
    }
    state.pendingShadowed.delete(data.variantSeq)
    // The marker is the durable edge and outranks a fallback derivation.
    return recordVariant(state, data.groupAnchor, data.variantSeq, previousSeq, true)
  }
  if (event.type === 'revert/branch') {
    return foldBranchEvent(state, event)
  }
  return false
}

/**
 * Fold one durable branch switch: the shadowed records become the previous
 * variant's restorable branch, the target variant's entry is cleared, the
 * group's active pointer moves, and every group represented inside the
 * restored records becomes active again.
 */
function foldBranchEvent(state: IterationFoldState, event: IterationFoldEvent): boolean {
  const data = event.data as {
    readonly variantSeq?: unknown
    readonly previousVariantSeq?: unknown
    readonly shadowedSeqs?: unknown
    readonly restoredSeqs?: unknown
  } | undefined
  if (typeof data?.variantSeq !== 'number') return false
  const shadowed = Array.isArray(data.shadowedSeqs)
    ? data.shadowedSeqs.filter((seq): seq is number => typeof seq === 'number').sort((left, right) => left - right)
    : []
  const restored = Array.isArray(data.restoredSeqs)
    ? data.restoredSeqs.filter((seq): seq is number => typeof seq === 'number').sort((left, right) => left - right)
    : []
  if (shadowed.length === 0 && restored.length === 0) return false
  const shadowedFirst = shadowed[0]
  const shadowedLast = shadowed[shadowed.length - 1]
  if (shadowedFirst !== undefined && shadowedLast !== undefined) {
    deactivateShadowed(state, shadowedFirst, shadowedLast)
  }
  if (typeof data.previousVariantSeq === 'number' && shadowed.length > 0) {
    state.branchSeqs.set(data.previousVariantSeq, shadowed)
  }
  state.branchSeqs.delete(data.variantSeq)
  const groupAnchor = state.variantBySeq.get(data.variantSeq) ?? data.variantSeq
  const group = state.groups.get(groupAnchor)
  if (group !== undefined) group.activeVariantSeq = data.variantSeq
  // The restored records may contain later groups' variants; those branches
  // are part of the restored suffix and become active with it.
  const restoredSet = new Set(restored)
  for (const candidate of state.groups.values()) {
    // Variant keys are in creation order, so the last match is the branch tip.
    let latest: number | undefined
    for (const seq of candidate.variants.keys()) {
      if (restoredSet.has(seq)) latest = seq
    }
    if (latest !== undefined) candidate.activeVariantSeq = latest
  }
  return true
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
    /* v8 ignore next -- the loop bound guarantees a dense event at every index */
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
    /* v8 ignore next -- recordVariant always creates the group for its anchor */
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

/**
 * Resolve the iteration group a **compaction checkpoint** stands for, through
 * the variants the checkpoint cites. A revert whose anchor is the checkpoint
 * node must stay in the original group chain instead of minting a new group
 * keyed by the checkpoint seq.
 * @param state - folded index.
 * @param citedSeqs - the checkpoint's `sourceEventSeqs`.
 * @returns the group anchor and the variant the checkpoint currently represents, or undefined.
 */
export function resolveIterationCheckpointAnchor(
  state: IterationFoldState,
  citedSeqs: readonly number[] | undefined,
): { readonly groupAnchor: number; readonly previousSeq: number } | undefined {
  if (citedSeqs === undefined) return undefined
  const cited = new Set(citedSeqs)
  for (const group of state.groups.values()) {
    let latest: number | undefined
    for (const seq of group.variants.keys()) {
      if (cited.has(seq)) latest = seq
    }
    if (latest === undefined) continue
    const active = group.activeVariantSeq
    return {
      groupAnchor: group.anchorSeq,
      previousSeq: active !== null && cited.has(active) ? active : latest,
    }
  }
  return undefined
}

/** One bounded iteration-group listing row. */
export interface ListedIterationGroup {
  /** Seq of the original variant (the group key). */
  readonly anchorSeq: number
  /** Variant currently representing the group position, or null. */
  readonly activeVariantSeq: number | null
  /** At most `limit` variants, in creation order, oldest dropped first. */
  readonly variants: readonly { readonly seq: number; readonly previousSeq: number | null }[]
}

/**
 * List iteration groups without materializing every group or variant. The
 * fold's group map is in creation order, so a full listing stops after
 * `limit` groups; one group keeps only its last `limit` variants.
 * @param state - folded index.
 * @param options - group anchor, listing bound, and backwards variant cursor.
 * @returns the bounded groups.
 */
export function listIterationGroups(
  state: IterationFoldState,
  options: {
    readonly anchorSeq?: number
    readonly limit: number
    readonly beforeVariantSeq?: number
  },
): ListedIterationGroup[] {
  const listed: ListedIterationGroup[] = []
  const groups = options.anchorSeq === undefined
    ? state.groups.values()
    : (() => {
      const only = state.groups.get(options.anchorSeq)
      return only === undefined ? [].values() : [only].values()
    })()
  for (const group of groups) {
    if (listed.length >= options.limit) break
    const variants: Array<{ seq: number; previousSeq: number | null }> = []
    for (const [seq, previousSeq] of group.variants) {
      if (options.beforeVariantSeq !== undefined && seq >= options.beforeVariantSeq) continue
      variants.push({ seq, previousSeq })
      if (variants.length > options.limit) variants.shift()
    }
    listed.push({ anchorSeq: group.anchorSeq, activeVariantSeq: group.activeVariantSeq, variants })
  }
  return listed
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
