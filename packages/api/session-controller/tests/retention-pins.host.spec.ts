/** Retention-pin manifest and the removal guard every future cleanup must route through. */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertRemovalSafe,
  computeRetentionPins,
  computeSessionRetentionPins,
  retentionGuardOf,
  RetentionViolationError,
  type RetentionPinCategory,
} from '../src/retention-pins.ts'
import { foldSurfaceNodes } from '../src/surface-view.ts'
import type { SessionVerifyEvent } from '../src/session-verify.ts'

function marker(seq: number, data: Record<string, unknown>): SessionVerifyEvent {
  return { type: 'revert/iteration', seq, time: seq, data, ignorable: true }
}

/**
 * One log touching every pin category: iteration marker and variant seqs, a
 * branch switch, an offload target, a compaction summary and checkpoint, a
 * revert boundary, and live surface nodes with sources.
 */
function pinnedLog(): SessionVerifyEvent[] {
  return [
    {
      type: 'user/message', seq: 0, time: 0,
      data: { content: [{ type: 'text', text: 'v1' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    {
      type: 'user/message', seq: 1, time: 1,
      data: { content: [{ type: 'text', text: 'v2' }], source: { kind: 'user' } },
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
      sourceEventSeqs: [0],
    },
    marker(2, {
      groupAnchor: 0, previousSeq: 0, variantSeq: 1, startSeq: 0, endSeq: 0, cause: 'commit', restoredFromSeq: 0,
    }),
    { type: 'image/offload', seq: 3, time: 3, data: { targets: [{ seq: 1, imageIndexes: [0] }] } },
    { type: 'compaction/summary', seq: 4, time: 4, data: { shadowedSeqs: [0, 1] } },
    {
      type: 'user/message', seq: 5, time: 5,
      data: { content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint' } },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1, 4],
    },
    {
      type: 'revert/branch', seq: 6, time: 6,
      data: {
        groupAnchor: 0, variantSeq: 1, previousVariantSeq: 1,
        startSeq: 5, endSeq: 5, shadowedSeqs: [5], restoredSeqs: [1],
      },
    },
    { type: 'revert/state', seq: 7, time: 7, data: { fromSeq: 5, cause: 'revert' } },
  ]
}

function categoriesOf(manifest: ReturnType<typeof computeRetentionPins>, seq: number): readonly RetentionPinCategory[] {
  return manifest.pins.get(seq)?.categories ?? []
}

describe('computeRetentionPins', () => {
  it('pins every marker field, branch record, offload target, compaction source, and boundary', () => {
    const manifest = computeRetentionPins(pinnedLog())
    // The marker itself and each field it names.
    expect(categoriesOf(manifest, 2)).toContain('iteration-marker')
    for (const field of [0, 1]) {
      expect(categoriesOf(manifest, field)).toContain('iteration-variant')
    }
    // The branch switch: shadowed and restored records.
    expect(categoriesOf(manifest, 6)).toContain('iteration-marker')
    expect(categoriesOf(manifest, 5)).toContain('branch-record')
    expect(categoriesOf(manifest, 1)).toContain('branch-record')
    // The offload target (the decision event itself stays removable).
    expect(categoriesOf(manifest, 1)).toContain('offload-target')
    expect(categoriesOf(manifest, 3)).toEqual([])
    // Compaction summary sources and the checkpoint's own citations.
    expect(categoriesOf(manifest, 0)).toContain('compaction-shadowed')
    expect(categoriesOf(manifest, 1)).toContain('compaction-shadowed')
    expect(categoriesOf(manifest, 5)).toContain('compaction-checkpoint')
    expect(categoriesOf(manifest, 4)).toContain('compaction-checkpoint')
    // The revert boundary target (the marker event itself stays removable).
    expect(categoriesOf(manifest, 5)).toContain('revert-boundary')
    expect(categoriesOf(manifest, 7)).toEqual([])
    // Every live surface node and its sources.
    expect(categoriesOf(manifest, 1)).toContain('surface-node')
    expect(categoriesOf(manifest, 0)).toContain('surface-source')
    expect(manifest.seqs()).toEqual([...manifest.seqs()].sort((left, right) => left - right))
    expect(manifest.has(99)).toBe(false)
  })

  it('folds the surface from the log when the caller supplies none', () => {
    const events = pinnedLog()
    const manifest = computeRetentionPins(events)
    expect(manifest.seqs()).toContain(6)
    expect(computeRetentionPins(events, [SessionSeq(6)]).has(6)).toBe(true)
    expect(computeRetentionPins(events, [SessionSeq(6)]).has(0)).toBe(true)
  })

  it('folds the live Session log and surface with no mounted projection', () => {
    const session = Session.create(SessionId('retention-pins'), [])
    const v1 = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'v1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const v2 = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'v2' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: v1.seq, endSeq: v1.seq }, sourceEventSeqs: [v1.seq] })
    session.append('revert/iteration', {
      groupAnchor: v1.seq, previousSeq: v1.seq, variantSeq: v2.seq, startSeq: v1.seq, endSeq: v1.seq, cause: 'commit',
    }, { ignorable: true })
    expect([...foldSurfaceNodes(session.snapshotEvents())]).toEqual([...session.surface.nodes])
    const manifest = computeSessionRetentionPins(session)
    for (const seq of [v1.seq, v2.seq, session.seq - 1]) expect(manifest.has(seq)).toBe(true)
  })
})

describe('assertRemovalSafe', () => {
  it('refuses a plan naming any pinned seq and reports every reason', () => {
    const manifest = computeRetentionPins(pinnedLog())
    let error: unknown
    try {
      assertRemovalSafe(manifest, [99, 1])
    } catch (caught: unknown) {
      error = caught
    }
    expect(error).toBeInstanceOf(RetentionViolationError)
    const violation = (error as RetentionViolationError).violations
    expect(violation).toHaveLength(1)
    expect(violation[0]?.seq).toBe(1)
    expect(violation[0]?.reasons.length).toBeGreaterThan(0)
    expect((error as Error).message).toContain('refusing to remove')
    expect((error as Error).message).toContain('1 (')
  })

  it('admits an all-unpinned plan and is idempotent over duplicates', () => {
    const manifest = computeRetentionPins(pinnedLog())
    expect(() => { assertRemovalSafe(manifest, [99, 100, 99]) }).not.toThrow()
    const guard = retentionGuardOf(manifest)
    expect(() => { guard([99]) }).not.toThrow()
    expect(() => { guard([0]) }).toThrow(RetentionViolationError)
  })
})
