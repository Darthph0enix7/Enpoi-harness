/**
 * Host and client shared fold for transcript revert state.
 *
 * The fold is a pure left fold over durable Session events. The Host folds the
 * complete log once per history request and ships the result on each page and
 * follow snapshot; the Client adopts that durable baseline and folds only the
 * events appended after its `asOfSeq`. Sharing this module is what keeps both
 * sides from diverging (a window-bounded client fold resurrects shadowed
 * content once a page cut separates a marker from its replacement).
 */
import type {
  RevertFileConflict,
  RevertFileOutcome,
  SessionRevertFold,
  SessionRevertShadowRange,
} from './types.ts'
import {
  adoptIterationEdges,
  emptyIterationFoldState,
  foldIterationEvent,
  iterationEdges,
  type IterationFoldState,
} from './iteration-fold.ts'

/** Mutable fold accumulator; every applied event replaces changed fields by value. */
export interface RevertFoldState {
  /** Active revert boundary (user-message seq), or null when none is armed. */
  revertFromSeq: number | null
  /** Half-open spans shadowed by user-origin revert commits. */
  revertShadowRanges: SessionRevertShadowRange[]
  /** File-revert conflicts awaiting operator resolution. */
  revertFileConflicts: RevertFileConflict[]
  /** File-revert outcomes by target path after resolutions. */
  revertFileOutcomes: Record<string, RevertFileOutcome>
  /** Durable revert-iteration pointer index folded from the same event stream. */
  iterations: IterationFoldState
}

/** Structural event fields the fold reads; durable Session events and test doubles qualify. */
export interface RevertFoldEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** @returns an empty accumulator. */
export function emptyRevertFoldState(): RevertFoldState {
  return {
    revertFromSeq: null,
    revertShadowRanges: [],
    revertFileConflicts: [],
    revertFileOutcomes: {},
    iterations: emptyIterationFoldState(),
  }
}

/**
 * Adopt one Host-folded baseline as a mutable accumulator.
 * @param fold - durable fold delivered with a history page or follow snapshot.
 * @returns an accumulator with copied collections.
 */
export function adoptRevertFold(fold: SessionRevertFold): RevertFoldState {
  return {
    revertFromSeq: fold.fromSeq,
    revertShadowRanges: [...fold.shadowRanges],
    revertFileConflicts: [...fold.conflicts],
    revertFileOutcomes: { ...fold.outcomes },
    iterations: adoptIterationEdges(fold.iterations),
  }
}

/**
 * Encode one accumulator as the durable wire value.
 * @param state - accumulated fold.
 * @param asOfSeq - inclusive log seq the fold covers.
 * @returns the wire block carried by history pages and follow snapshots.
 */
export function revertFoldValue(state: RevertFoldState, asOfSeq: number): SessionRevertFold {
  return {
    fromSeq: state.revertFromSeq,
    shadowRanges: [...state.revertShadowRanges],
    conflicts: [...state.revertFileConflicts],
    outcomes: { ...state.revertFileOutcomes },
    iterations: iterationEdges(state.iterations),
    asOfSeq,
  }
}


/**
 * Fold one durable event into the accumulator.
 *
 * A `revert/state` marker opens a fresh boundary window and clears prior file
 * conflicts/outcomes; a user-origin replacement while a boundary is armed
 * records the shadowed span and consumes the boundary; file events accumulate.
 * @param state - accumulator mutated in place (changed fields get fresh references).
 * @param event - durable event in log order.
 * @returns whether the fold changed observable state.
 */
export function foldRevertEvent(state: RevertFoldState, event: RevertFoldEvent): boolean {
  // The iteration pointer index folds the same ordered stream; its change is
  // OR-ed into every branch below so a marker-only append still republishes.
  const iterationChanged = foldIterationEvent(state.iterations, event)
  if (event.type === 'revert/state') {
    const data = event.data as { readonly fromSeq?: number | null } | undefined
    // Every revert/state (revert, restore, commit) opens a fresh boundary
    // window: prior conflicts/outcomes no longer apply. Clearing them is an
    // observable change even when the boundary itself does not move, so the
    // publication signal must carry it (a stale RevertTray is a defect).
    let changed = false
    if (state.revertFileConflicts.length > 0) {
      state.revertFileConflicts = []
      changed = true
    }
    if (Object.keys(state.revertFileOutcomes).length > 0) {
      state.revertFileOutcomes = {}
      changed = true
    }
    if (data?.fromSeq === null) {
      if (state.revertFromSeq === null && state.revertShadowRanges.length === 0) return changed || iterationChanged
      state.revertFromSeq = null
      return true
    }
    if (data === undefined || state.revertFromSeq === data.fromSeq) return changed || iterationChanged
    state.revertFromSeq = data.fromSeq ?? null
    return true
  }
  if (event.type === 'user/message') {
    // Product rule: the viewer's fold may hide a span only for a
    // user-initiated revert, i.e. a user-origin replacement that lands while a
    // `revert/state` boundary is active. Every other `surfaceOp: replace`
    // writer (compaction, checkpoint keeper, future edit/retry flows) must
    // leave the transcript untouched.
    const surfaceOp = event.surfaceOp as {
      readonly op?: string
      readonly startSeq?: number
      readonly endSeq?: number
    } | undefined
    const sourceKind = (event.data as { readonly source?: { readonly kind?: unknown } } | undefined)?.source?.kind
    if (surfaceOp?.op === 'replace' && typeof surfaceOp.startSeq === 'number'
      && typeof surfaceOp.endSeq === 'number'
      && state.revertFromSeq !== null && sourceKind === 'user') {
      // Immutable: selectors compare the snapshot's array identity, so an
      // in-place push would keep the previous reference and skip a re-render.
      state.revertShadowRanges = [
        ...state.revertShadowRanges,
        { start: surfaceOp.startSeq, end: surfaceOp.endSeq + 1 },
      ]
      state.revertFromSeq = null
      return true
    }
    return iterationChanged
  }
  if (event.type === 'revert/branch') {
    // A branch switch re-points visibility: the restored branch's span stops
    // being hidden and the branch it displaced becomes hidden. Unlike a
    // revert-commit range, these ranges are replaced, not accumulated, so
    // switching back and forth is exact.
    const data = event.data as {
      readonly shadowedSeqs?: unknown
      readonly restoredSeqs?: unknown
    } | undefined
    const shadowed = Array.isArray(data?.shadowedSeqs)
      ? data.shadowedSeqs.filter((seq): seq is number => typeof seq === 'number')
      : []
    const restored = Array.isArray(data?.restoredSeqs)
      ? data.restoredSeqs.filter((seq): seq is number => typeof seq === 'number')
      : []
    if (shadowed.length === 0 && restored.length === 0) return iterationChanged
    let changed = false
    if (restored.length > 0) {
      const next = state.revertShadowRanges.filter(range =>
        !restored.some(seq => seq >= range.start && seq < range.end))
      if (next.length !== state.revertShadowRanges.length) {
        state.revertShadowRanges = next
        changed = true
      }
    }
    if (shadowed.length > 0) {
      const start = Math.min(...shadowed)
      const end = Math.max(...shadowed) + 1
      const already = state.revertShadowRanges.some(range => range.start === start && range.end === end)
      if (!already) {
        state.revertShadowRanges = [...state.revertShadowRanges, { start, end }]
        changed = true
      }
    }
    return changed || iterationChanged
  }
  if (event.type === 'revert/file-conflict') {
    const data = event.data as RevertFileConflict | undefined
    if (data !== undefined) {
      const index = state.revertFileConflicts.findIndex(c => c.conflictId === data.conflictId)
      state.revertFileConflicts = index < 0
        ? [...state.revertFileConflicts, data]
        : state.revertFileConflicts.map((c, i) => i === index ? data : c)
      return true
    }
    return iterationChanged
  }
  if (event.type === 'revert/file-result') {
    const data = event.data as { readonly revertSeq?: number; readonly outcomes?: Record<string, RevertFileOutcome> } | undefined
    if (data?.outcomes !== undefined) {
      state.revertFileOutcomes = { ...state.revertFileOutcomes, ...data.outcomes }
      // Only resolve conflicts whose outcome is NOT pending_conflict — a
      // pending conflict stays actionable (Keep/Force/Save Beside).
      const resolved = new Set(
        Object.entries(data.outcomes)
          .filter(([, out]) => out.status !== 'pending_conflict')
          .map(([path]) => path),
      )
      state.revertFileConflicts = state.revertFileConflicts.filter(c => !resolved.has(c.targetKey))
      return true
    }
    return iterationChanged
  }
  return iterationChanged
}

/**
 * Fold the complete prefix of a durable log into a fresh accumulator.
 * @param events - dense zero-based log events.
 * @param throughSeq - inclusive final seq; defaults to the last event.
 * @returns the folded state.
 */
export function foldRevertEvents(
  events: readonly RevertFoldEvent[],
  throughSeq = events.length - 1,
): RevertFoldState {
  const state = emptyRevertFoldState()
  for (let seq = 0; seq <= throughSeq && seq < events.length; seq++) {
    const event = events[seq]
    if (event !== undefined) foldRevertEvent(state, event)
  }
  return state
}
