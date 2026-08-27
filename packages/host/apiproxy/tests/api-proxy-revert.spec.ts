/** Revert RPC boundaries: anchor validation, in-flight guards, commit shadowing. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`revert-${String(nextRpc++)}`), payload }
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        session,
        status: 'idle',
        ctx: agentCtx,
        inbox: { hasPending: false },
        followup: () => {},
        steer: () => {},
      })
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('revert test sources are live')),
  })
  return ctx
}

/** Two completed turns with real user messages; returns the first user-message seq. */
function liveAgent(ctx: Context, id: string): { session: Session; firstUserSeq: number } {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  let firstUserSeq = -1
  for (let turn = 1; turn <= 2; turn++) {
    session.append('turn/start', { turn })
    const message = createUserMessage({
      content: [{ type: 'text', text: `prompt ${String(turn)}` }],
      source: { kind: 'user' },
    })
    const event = session.append('user/message', message, { surfaceOp: 'append' })
    if (turn === 1) firstUserSeq = event.seq
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `answer ${String(turn)}` }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx, inbox: { hasPending: false }, followup: () => {}, steer: () => {} } as unknown as Agent)
  return { session, firstUserSeq }
}

describe('session.revert', () => {
  it('accepts a user-message anchor and returns the reverted query text', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { firstUserSeq } = liveAgent(ctx, 'revert-ok')
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-ok'), atSeq: firstUserSeq }))
    expect(result.result.ok).toBe(true)
    if (result.result.ok) {
      expect(result.result.value.revertedText).toBe('prompt 1')
      expect(result.result.value.revertedCount).toBe(1)
    }
    // The boundary is durable in the log.
    const session = ctx.agents.get(sid('revert-ok'))!.session
    const state = session.events.findLast(e => e.type === 'revert/state')
    expect(state).toBeDefined()
    expect((state as { data: { fromSeq: number | null } }).data.fromSeq).toBe(firstUserSeq)
  })

  it('rejects a non-user surface anchor (assistant message)', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { session } = liveAgent(ctx, 'revert-assistant')
    const assistantSeq = session.events.find(e => e.type === 'assistant/message')!.seq
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-assistant'), atSeq: assistantSeq }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('revert-invalid')
  })

  it('rejects a seq that is not an active surface node', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    liveAgent(ctx, 'revert-nonsurface')
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-nonsurface'), atSeq: 999 }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('revert-invalid')
  })

  it('rejects an unknown session', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-missing'), atSeq: 1 }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('session-not-found')
  })

  it('rejects while the agent is running (in-flight guard)', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { firstUserSeq } = liveAgent(ctx, 'revert-running')
    const agent = ctx.agents.get(sid('revert-running'))!
    Object.assign(agent, { status: 'running' })
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-running'), atSeq: firstUserSeq }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('agent-busy')
  })

  it('rejects while the inbox has pending work', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { firstUserSeq } = liveAgent(ctx, 'revert-pending')
    const agent = ctx.agents.get(sid('revert-pending'))!
    Object.assign(agent, { inbox: { hasPending: true } })
    const result = await proxy.sessions.revert(request({ sessionId: sid('revert-pending'), atSeq: firstUserSeq }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('agent-busy')
  })
})

describe('session.revertRestore', () => {
  it('clears the boundary when restoring everything', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { session, firstUserSeq } = liveAgent(ctx, 'restore-all')
    await proxy.sessions.revert(request({ sessionId: sid('restore-all'), atSeq: firstUserSeq }))
    const result = await proxy.sessions.revertRestore(request({ sessionId: sid('restore-all') }))
    expect(result.result.ok).toBe(true)
    const state = session.events.findLast(e => e.type === 'revert/state')
    expect((state as { data: { fromSeq: number | null } }).data.fromSeq).toBeNull()
  })

  it('moves the boundary back when restoring a specific message', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { session, firstUserSeq } = liveAgent(ctx, 'restore-one')
    await proxy.sessions.revert(request({ sessionId: sid('restore-one'), atSeq: firstUserSeq }))
    const result = await proxy.sessions.revertRestore(request({ sessionId: sid('restore-one'), restoreSeq: firstUserSeq }))
    expect(result.result.ok).toBe(true)
    const state = session.events.findLast(e => e.type === 'revert/state')
    expect((state as { data: { fromSeq: number | null } }).data.fromSeq).toBe(firstUserSeq)
  })
})

describe('session.prompt with revertFromSeq', () => {
  it('commits the revert: the new message shadows the reverted span', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { session, firstUserSeq } = liveAgent(ctx, 'commit-ok')
    // Set the boundary first (the real UI flow).
    await proxy.sessions.revert(request({ sessionId: sid('commit-ok'), atSeq: firstUserSeq }))
    // Capture the followup call to verify the surface metadata.
    const agent = ctx.agents.get(sid('commit-ok'))!
    let captured: { surfaceOp?: unknown; sourceEventSeqs?: unknown; clearRevert?: boolean } | undefined
    agent.followup = (_message: unknown, options?: { surfaceOp?: unknown; sourceEventSeqs?: unknown; clearRevert?: boolean }) => {
      captured = options
    }
    const result = await proxy.sessions.prompt(request({
      sessionId: sid('commit-ok'),
      mode: 'queue',
      content: [{ type: 'text', text: 'goodbye' }],
      revertFromSeq: firstUserSeq,
    }))
    expect(result.result.ok).toBe(true)
    // The followup carries the replace surface metadata + atomic clear.
    expect(captured).toBeDefined()
    expect(captured?.surfaceOp).toEqual({ op: 'replace', start: firstUserSeq, end: session.surface.nodes.at(-1) })
    expect(captured?.sourceEventSeqs).toEqual(session.surface.nodes.slice(session.surface.nodes.indexOf(firstUserSeq)))
    expect(captured?.clearRevert).toBe(true)
  })

  it('rejects steer mode with revertFromSeq', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { firstUserSeq } = liveAgent(ctx, 'commit-steer')
    const result = await proxy.sessions.prompt(request({
      sessionId: sid('commit-steer'),
      mode: 'steer',
      content: [{ type: 'text', text: 'goodbye' }],
      revertFromSeq: firstUserSeq,
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('revert-invalid')
  })

  it('rejects revertFromSeq while the agent is running', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { firstUserSeq } = liveAgent(ctx, 'commit-running')
    const agent = ctx.agents.get(sid('commit-running'))!
    Object.assign(agent, { status: 'running' })
    const result = await proxy.sessions.prompt(request({
      sessionId: sid('commit-running'),
      mode: 'queue',
      content: [{ type: 'text', text: 'goodbye' }],
      revertFromSeq: firstUserSeq,
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('agent-busy')
  })

  it('rejects a non-user revertFromSeq anchor', async () => {
    const ctx = await composed()
    const proxy = api(ctx)
    const { session } = liveAgent(ctx, 'commit-anchor')
    const assistantSeq = session.events.find(e => e.type === 'assistant/message')!.seq
    const result = await proxy.sessions.prompt(request({
      sessionId: sid('commit-anchor'),
      mode: 'queue',
      content: [{ type: 'text', text: 'goodbye' }],
      revertFromSeq: assistantSeq,
    }))
    expect(result.result.ok).toBe(false)
    if (!result.result.ok) expect(result.result.error.code).toBe('revert-invalid')
  })
})