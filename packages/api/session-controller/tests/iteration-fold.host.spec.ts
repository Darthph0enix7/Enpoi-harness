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
import { foldRevertEvents, revertFoldValue } from '../src/revert-fold.ts'

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
})
