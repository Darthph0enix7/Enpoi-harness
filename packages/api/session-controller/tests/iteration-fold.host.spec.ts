/** Revert-iteration fold: marker edges, the pre-marker surfaceOp fallback, and consumer ignore. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  adoptIterationEdges,
  foldIterationEvent,
  foldIterationEvents,
  iterationAnchorOf,
  iterationEdges,
} from '../src/iteration-fold.ts'
import { foldRevertEvent, foldRevertEvents, revertFoldValue } from '../src/revert-fold.ts'

interface FoldEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

function user(seq: number, text: string, surfaceOp?: unknown, sourceKind = 'user'): FoldEvent {
  return {
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind } },
    ...surfaceOp === undefined ? {} : { surfaceOp },
  }
}

function marker(seq: number, data: {
  groupAnchor: number
  previousSeq: number | null
  variantSeq: number
  startSeq: number
  endSeq: number
  cause: 'commit' | 'restore'
  restoredFromSeq?: number
}): FoldEvent {
  return { type: 'revert/iteration', seq, data }
}

function replacement(seq: number, startSeq: number, endSeq: number, shadowed: number[]): FoldEvent {
  return {
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text: `variant-${String(seq)}` }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: shadowed,
  }
}

function branch(seq: number, data: {
  groupAnchor: number
  variantSeq: number
  previousVariantSeq: number | null
  startSeq: number
  endSeq: number
  shadowedSeqs: number[]
  restoredSeqs: number[]
}): FoldEvent {
  return { type: 'revert/branch', seq, data }
}

describe('iteration fold', () => {
  it('folds marker edges and counts the original message as the first variant', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ])
    expect(iterationEdges(state)).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 1,
        variants: [{ seq: 0, previousSeq: null }, { seq: 1, previousSeq: 0 }],
      },
    ])
    expect(iterationAnchorOf(state, 1)).toBe(0)
    expect(iterationAnchorOf(state, 0)).toBe(0)
    expect(iterationAnchorOf(state, 9)).toBeUndefined()
  })

  it('records a tree edge and keeps creation order when reverting to an intermediate variant', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
      // Revert to the original (v1) again: a branch, not a linear next step.
      user(3, 'v3', { op: 'replace', startSeq: 0, endSeq: 0 }),
      marker(4, { groupAnchor: 0, previousSeq: 1, variantSeq: 3, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ])
    expect(iterationEdges(state)).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 3,
        variants: [
          { seq: 0, previousSeq: null },
          { seq: 1, previousSeq: 0 },
          { seq: 3, previousSeq: 1 },
        ],
      },
    ])
  })

  it('derives pre-marker edges from user-origin replacements only', () => {
    const legacy = foldIterationEvents([
      user(0, 'v1'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }),
      // A compaction checkpoint replacement is not a user iteration.
      user(2, 'summary', { op: 'replace', startSeq: 1, endSeq: 1 }, 'compact-checkpoint'),
      // A user-origin replacement anchored on the checkpoint is the restore case
      // and carries its own marker; without one it is not an iteration edge.
      user(3, 'v4', { op: 'replace', startSeq: 2, endSeq: 2 }),
    ])
    expect(iterationEdges(legacy)).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 1,
        variants: [{ seq: 0, previousSeq: null }, { seq: 1, previousSeq: 0 }],
      },
    ])
  })

  it('deactivates a group whose variant a later user-origin commit shadowed', () => {
    const state = foldIterationEvents([
      user(0, 'X'),
      user(1, 'A'),
      user(2, 'A2', { op: 'replace', startSeq: 1, endSeq: 1 }),
      marker(3, { groupAnchor: 1, previousSeq: 1, variantSeq: 2, startSeq: 1, endSeq: 1, cause: 'commit' }),
      // Revert to X: the replacement shadows A2 (seq 2) and everything after.
      user(4, 'X2', { op: 'replace', startSeq: 0, endSeq: 2 }),
      marker(5, { groupAnchor: 0, previousSeq: 0, variantSeq: 4, startSeq: 0, endSeq: 2, cause: 'commit' }),
    ])
    const edges = iterationEdges(state)
    expect(edges).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 4,
        variants: [{ seq: 0, previousSeq: null }, { seq: 4, previousSeq: 0 }],
      },
      {
        anchorSeq: 1,
        activeVariantSeq: null,
        variants: [{ seq: 1, previousSeq: null }, { seq: 2, previousSeq: 1 }],
      },
    ])
  })

  it('keeps a compaction-cited variant active (the checkpoint represents the group)', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
      {
        type: 'user/message',
        seq: 3,
        data: { content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } },
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        sourceEventSeqs: [1],
      },
    ])
    expect(iterationEdges(state)).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 1,
        variants: [{ seq: 0, previousSeq: null }, { seq: 1, previousSeq: 0 }],
      },
    ])
  })

  it('adopts a durable wire block and then folds later markers', () => {
    const live = adoptIterationEdges([{
      anchorSeq: 0,
      activeVariantSeq: 1,
      variants: [{ seq: 0, previousSeq: null }, { seq: 1, previousSeq: 0 }],
    }])
    foldIterationEvent(live, user(2, 'v3', { op: 'replace', startSeq: 1, endSeq: 1 }))
    foldIterationEvent(live, marker(3, {
      groupAnchor: 0, previousSeq: 1, variantSeq: 2, startSeq: 1, endSeq: 1, cause: 'restore', restoredFromSeq: 0,
    }))
    expect(iterationEdges(live)).toEqual([
      {
        anchorSeq: 0,
        activeVariantSeq: 2,
        variants: [
          { seq: 0, previousSeq: null },
          { seq: 1, previousSeq: 0 },
          { seq: 2, previousSeq: 1 },
        ],
      },
    ])
  })

  it('is surface-inert: a real Session keeps its nodes and replace generation', () => {
    const session = Session.create(SessionId('iteration-surface'), [
      {
        type: 'user/message',
        seq: SessionSeq(0),
        time: 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'v1' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      {
        type: 'revert/iteration',
        seq: SessionSeq(1),
        time: 2,
        data: {
          groupAnchor: 0, previousSeq: 0, variantSeq: 0, startSeq: 0, endSeq: 0, cause: 'commit',
        },
        ignorable: true,
      },
    ] as SessionEvent[])
    expect([...session.surface.nodes]).toEqual([0])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.snapshotEvents()[1]?.ignorable).toBe(true)
  })

  it('is ignored by the revert fold: a marker-only append changes no consumer-visible state', () => {
    const base: FoldEvent[] = [
      user(0, 'v1'),
      user(1, 'v2', { op: 'replace', startSeq: 0, endSeq: 0 }),
      { type: 'revert/state', seq: 2, data: { fromSeq: 0, cause: 'revert' } },
    ]
    const withMarker: FoldEvent[] = [
      ...base,
      marker(3, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ]
    const without = revertFoldValue(foldRevertEvents(base), 2)
    const withIt = revertFoldValue(foldRevertEvents(withMarker), 3)
    expect(withIt.fromSeq).toBe(without.fromSeq)
    expect(withIt.shadowRanges).toEqual(without.shadowRanges)
    expect(withIt.conflicts).toEqual(without.conflicts)
    expect(withIt.outcomes).toEqual(without.outcomes)
    // The marker adds no iteration edge either: the fallback already derived
    // the identical edge from the replacement's surfaceOp.
    expect(withIt.iterations).toEqual(without.iterations)
    expect(withIt.iterations).toEqual([{
      anchorSeq: 0,
      activeVariantSeq: 1,
      variants: [{ seq: 0, previousSeq: null }, { seq: 1, previousSeq: 0 }],
    }])
  })
  it('switches the active branch and remembers both branches for switching back', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      replacement(1, 0, 0, [0]),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
      { type: 'assistant/message', seq: 3, data: {} },
      branch(4, {
        groupAnchor: 0, variantSeq: 0, previousVariantSeq: 1,
        startSeq: 1, endSeq: 3, shadowedSeqs: [1, 3], restoredSeqs: [0],
      }),
    ])
    expect(iterationEdges(state)[0]).toMatchObject({ anchorSeq: 0, activeVariantSeq: 0 })
    expect(state.branchSeqs.get(1)).toEqual([1, 3])
    expect(state.branchSeqs.has(0)).toBe(false)

    expect(foldIterationEvent(state, branch(5, {
      groupAnchor: 0, variantSeq: 1, previousVariantSeq: 0,
      startSeq: 0, endSeq: 0, shadowedSeqs: [0], restoredSeqs: [1, 3],
    }))).toBe(true)
    expect(iterationEdges(state)[0]).toMatchObject({ anchorSeq: 0, activeVariantSeq: 1 })
    expect(state.branchSeqs.get(0)).toEqual([0])
    expect(state.branchSeqs.has(1)).toBe(false)
  })

  it('reactivates later groups contained in the restored suffix', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      replacement(1, 0, 0, [0]),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
      user(3, 'w1'),
      replacement(4, 3, 3, [3]),
      marker(5, { groupAnchor: 3, previousSeq: 3, variantSeq: 4, startSeq: 3, endSeq: 3, cause: 'commit' }),
      branch(6, {
        groupAnchor: 0, variantSeq: 0, previousVariantSeq: 1,
        startSeq: 1, endSeq: 4, shadowedSeqs: [1, 4], restoredSeqs: [0],
      }),
    ])
    expect(iterationEdges(state).find(group => group.anchorSeq === 3)!.activeVariantSeq).toBeNull()

    foldIterationEvent(state, branch(7, {
      groupAnchor: 0, variantSeq: 1, previousVariantSeq: 0,
      startSeq: 0, endSeq: 0, shadowedSeqs: [0], restoredSeqs: [1, 4],
    }))
    expect(iterationEdges(state).find(group => group.anchorSeq === 3)!.activeVariantSeq).toBe(4)
    expect(iterationEdges(state).find(group => group.anchorSeq === 0)!.activeVariantSeq).toBe(1)
  })

  it('ignores malformed markers and branch events without changing state', () => {
    const state = foldIterationEvents([
      user(0, 'v1'),
      replacement(1, 0, 0, [0]),
      marker(2, { groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit' }),
    ])
    // Marker without data, without a variant, and without previousSeq.
    expect(foldIterationEvent(state, { type: 'revert/iteration', seq: 3, data: undefined })).toBe(false)
    expect(foldIterationEvent(state, { type: 'revert/iteration', seq: 4, data: { groupAnchor: 0 } })).toBe(false)
    expect(foldIterationEvent(state, { type: 'revert/iteration', seq: 5, data: { groupAnchor: 0, variantSeq: 9 } })).toBe(true)
    // Branch event without data, without a variant, with non-array lists, with
    // non-number entries, and with no usable seqs at all.
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 6, data: undefined })).toBe(false)
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 7, data: { variantSeq: 1 } })).toBe(false)
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 8, data: {
      variantSeq: 1, previousVariantSeq: 0, shadowedSeqs: 'x', restoredSeqs: 0,
    } })).toBe(false)
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 9, data: {
      variantSeq: 1, previousVariantSeq: 0, shadowedSeqs: ['x'], restoredSeqs: ['y'],
    } })).toBe(false)
    // A switch with no shadowed records but a restored target still moves the
    // groups the restored records represent.
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 10, data: {
      variantSeq: 1, previousVariantSeq: 0, shadowedSeqs: [], restoredSeqs: [0],
    } })).toBe(true)
    expect(iterationEdges(state).find(group => group.anchorSeq === 0)!.activeVariantSeq).toBe(0)
    // A switch whose target names no known group still moves the groups the
    // restored records represent.
    expect(foldIterationEvent(state, { type: 'revert/branch', seq: 11, data: {
      variantSeq: 99, previousVariantSeq: null, shadowedSeqs: [1], restoredSeqs: [0],
    } })).toBe(true)
    expect(iterationEdges(state).find(group => group.anchorSeq === 0)!.activeVariantSeq).toBe(0)
  })

  it('leaves the hidden spans unchanged when a branch event carries no usable seqs', () => {
    const state = foldRevertEvents([
      user(0, 'v1'),
      { type: 'revert/state', seq: 1, data: { fromSeq: 0, cause: 'revert' } },
      replacement(2, 0, 0, [0]),
    ])
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }])
    // Empty or malformed branch data changes nothing.
    foldRevertEvent(state, { type: 'revert/branch', seq: 3, data: { shadowedSeqs: [], restoredSeqs: [] } })
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }])
    foldRevertEvent(state, { type: 'revert/branch', seq: 4, data: { shadowedSeqs: 'x', restoredSeqs: 0 } })
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }])
    // A restored-only switch removes the matching span without adding one.
    foldRevertEvent(state, { type: 'revert/branch', seq: 5, data: { shadowedSeqs: [], restoredSeqs: [0] } })
    expect(state.revertShadowRanges).toEqual([])
    // Restore the state for the remaining assertions.
    foldRevertEvent(state, { type: 'revert/branch', seq: 6, data: { shadowedSeqs: [0], restoredSeqs: [] } })
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }])
    // A restored span that matches no current range only adds the shadowed span.
    foldRevertEvent(state, { type: 'revert/branch', seq: 4, data: {
      shadowedSeqs: [2], restoredSeqs: [1],
    } })
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }])
    // Re-adding the same shadowed span is idempotent.
    foldRevertEvent(state, { type: 'revert/branch', seq: 5, data: {
      shadowedSeqs: [2], restoredSeqs: [],
    } })
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3 }])
  })

  it('adopts an absent wire block as an empty index', () => {
    const state = adoptIterationEdges(undefined)
    expect(iterationEdges(state)).toEqual([])
  })

  it('re-points the hidden span on a branch switch and restores it on the way back', () => {
    const state = foldRevertEvents([
      user(0, 'v1'),
      { type: 'revert/state', seq: 1, data: { fromSeq: 0, cause: 'revert' } },
      replacement(2, 0, 0, [0]),
      { type: 'revert/state', seq: 3, data: { fromSeq: null, cause: 'commit' } },
      branch(4, {
        groupAnchor: 0, variantSeq: 0, previousVariantSeq: 2,
        startSeq: 2, endSeq: 2, shadowedSeqs: [2], restoredSeqs: [0],
      }),
    ])
    // The restored v1 span stops being hidden; the displaced v2 span becomes hidden.
    expect(state.revertShadowRanges).toEqual([{ start: 2, end: 3 }])

    foldRevertEvent(state, branch(5, {
      groupAnchor: 0, variantSeq: 2, previousVariantSeq: 0,
      startSeq: 0, endSeq: 0, shadowedSeqs: [0], restoredSeqs: [2],
    }))
    expect(state.revertShadowRanges).toEqual([{ start: 0, end: 1 }])
  })
})
