/** Revert RPC boundaries on the Session Controller: anchor validation, revert/state appends, restore. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Test double for the profile's file-revert resolution bridge. */
    'file-revert/resolve'(request: unknown, next: () => unknown): unknown
  }
}

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** Compose a session with two user messages and one assistant message. */
async function composed(): Promise<{ ctx: Context; controller: SessionController; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const sessionId = SessionId('revert-session')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
  const events: SessionEvent[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({ meta: header, events }),
  }) as never)
  const controller = createSessionTestController(ctx, defaults)
  const session = ctx.sessions.create(sessionId, { meta: header })
  // The controller only reads id/session/status/inbox; the rest of the Agent
  // face is unreachable from the revert RPCs.
  const agent = {
    id: sessionId,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  // Two user turns + one assistant turn.
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first query' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: { id: MessageId('a-1'), role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' }, content: [{ type: 'text', text: 'first answer' }] }, stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second query' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 2 })
  session.append('assistant/message', { turn: 2, step: 1, message: { id: MessageId('a-2'), role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' }, content: [{ type: 'text', text: 'second answer' }] }, stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return { ctx, controller, sessionId }
}

describe('SessionController revert RPC', () => {
  it('reverts from a user message and appends revert/state', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const firstUserSeq = session.snapshotEvents().find(e => e.type === 'user/message')!.seq

    const result = await controller.revert({ sessionId, atSeq: firstUserSeq })

    expect(result.accepted).toBe(true)
    expect(result.revertedText).toBe('first query')
    expect(result.revertedCount).toBe(1) // the second user query
    const revertEvent = session.snapshotEvents().find(e => e.type === 'revert/state')
    expect(revertEvent).toBeDefined()
    expect((revertEvent!.data as { fromSeq: number; cause: string }).fromSeq).toBe(firstUserSeq)
    expect((revertEvent!.data as { cause: string }).cause).toBe('revert')
  })

  it('preserves child settlement notices across the revert cancel and drops operator queue input', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const firstUserSeq = session.snapshotEvents().find(e => e.type === 'user/message')!.seq
    const queued = createUserMessage({
      content: [{ type: 'text', text: 'operator queued' }],
      source: { kind: 'user' },
    })
    const notice = createUserMessage({
      content: [{ type: 'text', text: 'Background subagent child was stopped before it finished.' }],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary: 'Background subagent child was stopped before it finished.',
        senderSessionId: SessionId('child-notice'),
      },
    })
    const cancelled = Promise.withResolvers<void>()
    const cancel = vi.fn()
    const send = vi.fn()
    Object.assign(ctx.agents.get(sessionId)!, {
      status: 'running',
      inbox: { nextTurn: [queued, notice], nextStep: [] },
      cancel,
      send,
      whenIdle: () => cancelled.promise,
    })

    await expect(controller.revert({ sessionId, atSeq: firstUserSeq })).resolves.toMatchObject({ accepted: true })

    // The revert cancel carries its own intent and span, and clears the
    // inbox immediately so no user-queued turn runs mid-revert.
    expect(cancel).toHaveBeenCalledWith(
      { kind: 'user', intent: 'revert', revertFromSeq: firstUserSeq },
      { keepInbox: false },
    )
    // The notice is re-queued quietly only after the abort converges; the
    // operator's queued message is not preserved.
    expect(send).not.toHaveBeenCalled()
    cancelled.resolve(undefined)
    await vi.waitFor(() => { expect(send).toHaveBeenCalledWith(notice, 'next-turn', false) })
    expect(send).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().find(e => e.type === 'revert/state')).toBeDefined()
  })

  it('lets a revert commit proceed past queued child notices but not operator input', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const firstUserSeq = session.snapshotEvents().find(e => e.type === 'user/message')!.seq
    const agent = ctx.agents.get(sessionId)!
    const request = {
      requestId: 'revert-commit' as never,
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'edited query' }],
      revertFromSeq: firstUserSeq,
    }
    Object.assign(agent, {
      status: 'idle',
      inbox: {
        nextTurn: [createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })],
        nextStep: [],
      },
    })
    const signal = new AbortController().signal
    await expect(controller.prompt(request, signal)).rejects.toMatchObject({ code: 'revert-invalid' })

    const notice = createUserMessage({
      content: [{ type: 'text', text: 'Background subagent child was stopped before it finished.' }],
      source: {
        kind: 'subagent-settled', form: 'notice',
        summary: 'Background subagent child was stopped before it finished.',
        senderSessionId: SessionId('child-notice'),
      },
    })
    Object.assign(agent, { inbox: { nextTurn: [notice], nextStep: [] } })
    // The commit proceeds past the revert guard; whatever the bare harness
    // does next, the quiet notice did not block the operator's resend.
    await expect(controller.prompt({ ...request, requestId: 'revert-commit-2' as never }, signal).then(
      () => 'accepted',
      (error: { code?: string }) => error.code ?? 'unknown',
    )).resolves.not.toBe('revert-invalid')
  })

  it('makes a revert with an empty (failed) tail a no-op and writes no boundary', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    // A turn whose provider failed leaves the user message as the last
    // surface node: there is nothing after it to shadow.
    const failed = createUserMessage({
      content: [{ type: 'text', text: 'failed query' }],
      source: { kind: 'user' },
    })
    session.append('user/message', failed, { surfaceOp: 'append' })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', {
      turn: 3,
      reason: { kind: 'error', error: { message: 'No API key for provider: fixture', code: 'PI_AI_ERROR' } },
    })
    const failedSeq = session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === failed.id)!.seq

    const result = await controller.revert({ sessionId, atSeq: failedSeq })

    expect(result).toMatchObject({
      accepted: true,
      revertedText: 'failed query',
      revertedCount: 0,
      noop: true,
    })
    expect(result.notice).toContain('no revert boundary was created')
    // The wedge root cause: no revert/state boundary may be committed when
    // there is no following surface node to shadow.
    expect(session.snapshotEvents().some(e => e.type === 'revert/state')).toBe(false)
  })

  it('clears a stored boundary that has nothing to shadow and admits the prompt', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const failed = createUserMessage({
      content: [{ type: 'text', text: 'failed query' }],
      source: { kind: 'user' },
    })
    session.append('user/message', failed, { surfaceOp: 'append' })
    session.append('turn/start', { turn: 3 })
    session.append('turn/end', {
      turn: 3,
      reason: { kind: 'error', error: { message: 'No API key for provider: fixture', code: 'PI_AI_ERROR' } },
    })
    const failedSeq = session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === failed.id)!.seq
    // Simulate a boundary persisted by an older binary before the no-op fix.
    session.append('revert/state', { fromSeq: failedSeq, cause: 'revert' })
    const followup = vi.fn()
    Object.assign(ctx.agents.get(sessionId)!, { followup })

    const signal = new AbortController().signal
    await expect(controller.prompt({
      requestId: 'stale-boundary' as never,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'retry' }],
      revertFromSeq: failedSeq,
    }, signal)).resolves.toMatchObject({ accepted: true })

    // The stale boundary is cleared atomically with admission, and the message
    // is appended plainly (no replace span to shadow).
    const lastRevert = session.snapshotEvents().filter(e => e.type === 'revert/state').at(-1)!
    expect(lastRevert.data).toMatchObject({ fromSeq: null, cause: 'commit' })
    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]).toHaveLength(1)
  })

  it('clears a stored boundary whose anchor is gone and admits the prompt', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    session.append('revert/state', { fromSeq: 999, cause: 'revert' })
    const followup = vi.fn()
    Object.assign(ctx.agents.get(sessionId)!, { followup })

    const signal = new AbortController().signal
    await expect(controller.prompt({
      requestId: 'missing-anchor' as never,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text' as const, text: 'retry' }],
      revertFromSeq: 999,
    }, signal)).resolves.toMatchObject({ accepted: true })

    const lastRevert = session.snapshotEvents().filter(e => e.type === 'revert/state').at(-1)!
    expect(lastRevert.data).toMatchObject({ fromSeq: null, cause: 'commit' })
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('restores an unusable stored boundary to promptable state', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const failed = createUserMessage({
      content: [{ type: 'text', text: 'failed query' }],
      source: { kind: 'user' },
    })
    session.append('user/message', failed, { surfaceOp: 'append' })
    const failedSeq = session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === failed.id)!.seq
    session.append('revert/state', { fromSeq: failedSeq, cause: 'revert' })

    await expect(controller.revertRestore({ sessionId })).resolves.toMatchObject({ accepted: true })

    const lastRevert = session.snapshotEvents().filter(e => e.type === 'revert/state').at(-1)!
    expect(lastRevert.data).toMatchObject({ fromSeq: null, cause: 'restore' })
  })

  it('rejects a non-user anchor', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const assistantSeq = session.snapshotEvents().find(e => e.type === 'assistant/message')!.seq
    await expect(controller.revert({ sessionId, atSeq: assistantSeq }))
      .rejects.toMatchObject({ code: 'revert-invalid' })
  })

  it('rejects an unknown seq', async () => {
    const { controller, sessionId } = await composed()
    await expect(controller.revert({ sessionId, atSeq: 999 }))
      .rejects.toMatchObject({ code: 'revert-invalid' })
  })

  it('restores everything when restoreSeq is omitted', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const firstUserSeq = session.snapshotEvents().find(e => e.type === 'user/message')!.seq
    await controller.revert({ sessionId, atSeq: firstUserSeq })

    const result = await controller.revertRestore({ sessionId })
    expect(result.accepted).toBe(true)
    const lastRevert = session.snapshotEvents().filter(e => e.type === 'revert/state').at(-1)!
    // Restoring everything clears the boundary (null), not a 0 sentinel.
    expect((lastRevert.data as { fromSeq: number | null; cause: string }).fromSeq).toBeNull()
    expect((lastRevert.data as { cause: string }).cause).toBe('restore')
  })

  it('restores to a boundary when restoreSeq is set', async () => {
    const { ctx, controller, sessionId } = await composed()
    const session = ctx.sessions.get(sessionId)!
    const firstUserSeq = session.snapshotEvents().find(e => e.type === 'user/message')!.seq
    await controller.revert({ sessionId, atSeq: firstUserSeq })

    const result = await controller.revertRestore({ sessionId, restoreSeq: firstUserSeq })
    expect(result.accepted).toBe(true)
    const lastRevert = session.snapshotEvents().filter(e => e.type === 'revert/state').at(-1)!
    expect((lastRevert.data as { fromSeq: number }).fromSeq).toBe(firstUserSeq)
  })

  it('is a no-op when no revert is active', async () => {
    const { controller, sessionId } = await composed()
    const result = await controller.revertRestore({ sessionId })
    expect(result.accepted).toBe(true)
  })

  it('rejects for an unknown session', async () => {
    const { controller } = await composed()
    await expect(controller.revert({ sessionId: SessionId('missing'), atSeq: 1 }))
      .rejects.toMatchObject({ code: 'session-not-found' })
  })

  it('rejects deleting an unknown session', async () => {
    const { controller } = await composed()
    await expect(controller.delete({ sessionId: SessionId('missing') }))
      .rejects.toMatchObject({
        code: 'session-not-found',
        message: expect.stringContaining('missing') as string,
      })
  })

  it('rejects a file-revert resolution the mounted bridge refuses', async () => {
    const { ctx, controller, sessionId } = await composed()
    ctx.on('file-revert/resolve', () => ({ accepted: false, reason: 'Error: conflict "nope" not found' }))
    await expect(controller.resolveFileConflict({ sessionId, conflictId: 'nope', resolution: 'keep' }))
      .rejects.toMatchObject({
        code: 'file-revert-invalid',
        message: expect.stringContaining('conflict "nope" not found') as string,
      })
  })

  it('keeps the unavailable code when no bridge listener answers', async () => {
    const { controller, sessionId } = await composed()
    await expect(controller.resolveFileConflict({ sessionId, conflictId: 'nope', resolution: 'keep' }))
      .rejects.toMatchObject({ code: 'file-revert-unavailable' })
  })
})
