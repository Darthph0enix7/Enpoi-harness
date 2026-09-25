/** Revert RPC boundaries on the Session Controller: anchor validation, revert/state appends, restore. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
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
