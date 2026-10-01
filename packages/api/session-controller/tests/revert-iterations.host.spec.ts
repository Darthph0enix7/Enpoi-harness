/** Revert-iteration RPCs: listing, restore validation, compaction anchors, and idempotency. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ fixture: true, provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

interface Harness {
  readonly ctx: Context
  readonly controller: SessionController
  readonly sessionId: SessionId
  readonly session: NonNullable<ReturnType<Context['sessions']['get']>>
  readonly followup: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  /** Seq of the independent message before the group. */
  readonly independentSeq: SessionSeq
  /** Seq of the group's original variant (v1). */
  readonly v1Seq: SessionSeq
  /** Seq of the replacement variant (v2). */
  readonly v2Seq: SessionSeq
}

/**
 * Compose one session with an independent message, a v1/v2 iteration group and
 * its marker, plus an idle Agent stub whose `followup` is observable (the real
 * loop is not mounted in these unit tests).
 */
async function composed(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const sessionId = SessionId('iteration-session')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const events: SessionEvent[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({ meta: header, events }),
  }) as never)
  const controller = createSessionTestController(ctx, defaults)
  const session = ctx.sessions.create(sessionId, { meta: header })
  const followup = vi.fn()
  const cancel = vi.fn()
  const agent = {
    id: sessionId,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup,
    cancel,
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  ctx.agents.register(agent)

  const independent = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'independent' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const v1 = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first version' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const answer = session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: MessageId('a-1'), role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' }, content: [{ type: 'text', text: 'first answer' }] },
    stream: [],
  }, { surfaceOp: 'append' })
  const v2 = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second version' }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', startSeq: v1.seq, endSeq: answer.seq },
    sourceEventSeqs: [v1.seq, answer.seq],
  })
  session.append('revert/iteration', {
    groupAnchor: v1.seq,
    previousSeq: v1.seq,
    variantSeq: v2.seq,
    startSeq: v1.seq,
    endSeq: answer.seq,
    cause: 'commit',
  }, { ignorable: true })
  return {
    ctx, controller, sessionId, session, followup, cancel,
    independentSeq: independent.seq,
    v1Seq: v1.seq,
    v2Seq: v2.seq,
  }
}

describe('SessionController revert-iteration RPCs', () => {
  it('lists the group with the active variant and capped previews, and the marker stays log-only', async () => {
    const { controller, sessionId, session, v1Seq, v2Seq } = await composed()
    const nodesBefore = [...session.surface.nodes]

    const value = await controller.revertIterations({ sessionId })

    expect(value.groups).toHaveLength(1)
    expect(value.groups[0]).toMatchObject({ anchorSeq: v1Seq, activeVariantSeq: v2Seq })
    expect(value.groups[0]!.variants).toHaveLength(2)
    expect(value.groups[0]!.variants[0]).toMatchObject({
      seq: v1Seq, previousSeq: null, surfaceActive: false, text: 'first version',
    })
    expect(value.groups[0]!.variants[1]).toMatchObject({
      seq: v2Seq, previousSeq: v1Seq, surfaceActive: true, text: 'second version',
    })
    expect(typeof value.groups[0]!.variants[0]!.time).toBe('number')
    // The marker is never a surface node.
    expect([...session.surface.nodes]).toEqual(nodesBefore)
    expect(session.snapshotEvents().some(event => event.type === 'revert/iteration')).toBe(true)
  })

  it('rejects a missing Session with session/not-found', async () => {
    const { controller } = await composed()
    await expect(controller.revertIterations({ sessionId: SessionId('missing-session') }))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('rejects a foreign target, an already-active target, and a shadowed group before any write', async () => {
    const { controller, sessionId, session, followup, independentSeq, v1Seq, v2Seq } = await composed()

    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: 99, requestId: 'r-foreign' as never,
    })).rejects.toMatchObject({ code: 'revert-invalid' })
    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v2Seq, requestId: 'r-active' as never,
    })).rejects.toMatchObject({ code: 'revert-invalid' })
    expect(session.snapshotEvents().some(event => event.type === 'revert/state')).toBe(false)
    expect(followup).not.toHaveBeenCalled()

    // A later user-origin commit from the independent earlier message shadows
    // the whole group: its active variant is gone and restore must reject.
    const tail = session.surface.nodes.at(-1)!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new independent' }],
      source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: independentSeq, endSeq: tail }, sourceEventSeqs: [independentSeq, tail] })
    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v2Seq, requestId: 'r-shadowed' as never,
    })).rejects.toMatchObject({ code: 'revert-invalid' })
    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v1Seq, requestId: 'r-shadowed-old' as never,
    })).rejects.toMatchObject({ code: 'revert-invalid' })
    expect(followup).not.toHaveBeenCalled()
  })

  it('restores an older variant with an overwrite-since-point plan, fresh rpcId, and boundary after validation', async () => {
    const { controller, sessionId, session, followup, v1Seq, v2Seq } = await composed()

    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v1Seq, requestId: 'r-valid' as never,
    })).resolves.toEqual({ accepted: true })

    // The boundary moved first (file-revert side effect), after validation.
    const boundary = session.snapshotEvents().find(event => event.type === 'revert/state')
    expect(boundary?.data).toMatchObject({ fromSeq: v1Seq, cause: 'restore' })
    // The replacement is the v1 content copied into a fresh user message,
    // anchored on the group's CURRENT surface node (v2), not the shadowed v1.
    expect(followup).toHaveBeenCalledTimes(1)
    const [message, options] = followup.mock.calls[0] as [UserMessage, {
      surfaceOp: unknown
      sourceEventSeqs: readonly number[]
      clearRevert: boolean
      iteration: unknown
    }]
    expect(message.content).toEqual([{ type: 'text', text: 'first version' }])
    expect(message.source).toMatchObject({ kind: 'user', rpcId: 'r-valid' })
    expect(options.surfaceOp).toEqual({ op: 'replace', startSeq: v2Seq, endSeq: v2Seq })
    expect(options.sourceEventSeqs).toEqual([v2Seq])
    expect(options.clearRevert).toBe(true)
    expect(options.iteration).toMatchObject({
      groupAnchor: v1Seq, previousSeq: v2Seq, startSeq: v2Seq, endSeq: v2Seq, cause: 'restore', restoredFromSeq: v1Seq,
    })
  })

  it('treats a retried restore with the same requestId as accepted without a second replacement', async () => {
    const { controller, sessionId, session, followup, v1Seq } = await composed()
    await controller.revertIterationRestore({ sessionId, variantSeq: v1Seq, requestId: 'r-retry' as never })
    expect(followup).toHaveBeenCalledTimes(1)
    // Simulate the loop's durable append of the replacement.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first version' }],
      source: { kind: 'user', rpcId: 'r-retry' as never },
    }), { surfaceOp: 'append' })

    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v1Seq, requestId: 'r-retry' as never,
    })).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('keeps a compaction-shadowed iteration restorable through the checkpoint anchor', async () => {
    const { controller, sessionId, session, followup, v1Seq, v2Seq } = await composed()
    // Compaction replaces the group's current node with a checkpoint that
    // cites both variants (the durable representation of the group position).
    const checkpoint = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'compact-checkpoint', compactionId: 'compaction-1' as never },
    }), {
      surfaceOp: { op: 'replace', startSeq: v2Seq, endSeq: v2Seq },
      sourceEventSeqs: [v1Seq, v2Seq],
    })

    const value = await controller.revertIterations({ sessionId })
    // The active variant survives; its representation is the checkpoint.
    expect(value.groups[0]).toMatchObject({ anchorSeq: v1Seq, activeVariantSeq: v2Seq })
    expect(value.groups[0]!.variants[0]).toMatchObject({ seq: v1Seq, surfaceActive: true })
    expect(value.groups[0]!.variants[1]).toMatchObject({ seq: v2Seq, surfaceActive: true })

    await expect(controller.revertIterationRestore({
      sessionId, variantSeq: v1Seq, requestId: 'r-compaction' as never,
    })).resolves.toEqual({ accepted: true })
    const [, options] = followup.mock.calls[0] as [UserMessage, { surfaceOp: unknown }]
    expect(options.surfaceOp).toEqual({ op: 'replace', startSeq: checkpoint.seq, endSeq: checkpoint.seq })
  })
})
