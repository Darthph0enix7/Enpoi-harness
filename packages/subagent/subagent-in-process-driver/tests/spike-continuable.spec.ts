/**
 * Enpoi Harness — quiet continuable fibers. A `startContinuable({ quiet: true })`
 * child must leave no trace in its parent's inbox: neither the runtime's
 * settlement notice nor an intermediate child→parent `sendMessage` delivery.
 * The non-quiet control cases prove both deliveries exist in this harness, so
 * the quiet assertions cannot pass vacuously.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

const testSignal = new AbortController().signal

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0)) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'temp-root cleanup failed')
})

async function setup(script: Script) {
  const ctx = new Context()
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-quiet-fiber-'))
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
  cleanups.push(async () => {
    await persistenceFiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function startSpec(parent: Agent, options: { quiet?: boolean } = {}) {
  return {
    provider: 'spawn',
    label: options.quiet === true ? 'quiet child' : 'loud child',
    ...options.quiet === undefined ? {} : { quiet: options.quiet },
    signal: testSignal,
    request: {
      prompt: [{ type: 'text' as const, text: 'child task' }],
      parent,
    },
  }
}

/** Every `user/message` source this agent has in its session log, in log order. */
function sessionUserSources(agent: Agent) {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'user/message' ? [event.data.source] : [])
}

/** Every `user/message` this agent has received, in log order. */
function sessionUserMessages(agent: Agent) {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'user/message' ? [event.data] : [])
}

/** Source kinds queued but not yet claimed by this agent's inbox. */
function pendingInboxKinds(agent: Agent): string[] {
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.source.kind)
}

/** Source kinds this agent has either logged or still holds unclaimed. */
function receivedKinds(agent: Agent): string[] {
  return [...sessionUserSources(agent), ...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    .map(source => source.kind)
}

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      try {
        if (pred()) return resolve()
      } catch { /* keep polling */ }
      if (Date.now() - start > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('quiet continuable fibers', () => {
  it('settles a quiet child without delivering a settlement notice to the parent', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('quiet answer')])
    const start = await ctx.subagents.startContinuable(startSpec(parent, { quiet: true }))

    // The child runs exactly one turn, then the parked activation settles.
    await waitFor(() => adapter.requests.filter(request => request.sessionId === start.childId).length >= 1)
    await waitFor(() => ctx.agents.get(start.childId) === undefined)
    // Flush the settlement continuation so a delivery would be observable.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.requests.filter(request => request.sessionId === start.childId)).toHaveLength(1)
    // The quiet child also never woke the parent, so no parent model request exists.
    expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(0)
    expect(receivedKinds(parent)).not.toContain('subagent-settled')
    expect(receivedKinds(parent)).not.toContain('agent-message')
  })

  it('delivers a settlement notice for a non-quiet child (control)', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('loud answer'), textResponse('parent ack')])
    const start = await ctx.subagents.startContinuable(startSpec(parent))

    await waitFor(() => receivedKinds(parent).includes('subagent-settled'))
    await parent.whenIdle()

    const notice = sessionUserSources(parent).find(source => source.kind === 'subagent-settled')
    expect(notice).toMatchObject({ kind: 'subagent-settled', senderSessionId: start.childId })
    // The notice woke the parent, so the parent's own turn consumed the next response.
    expect(adapter.requests.filter(request => request.sessionId === parent.id)).toHaveLength(1)
  })

  it('accepts a quiet child sendMessage without delivering it to the parent', async () => {
    const { ctx, parent, adapter } = await setup(['hang', 'hang', textResponse('parent ack')])
    const quiet = await ctx.subagents.startContinuable(startSpec(parent, { quiet: true }))
    const loud = await ctx.subagents.startContinuable(startSpec(parent))
    await waitFor(() => adapter.requests.length >= 2)

    const quietChild = ctx.agents.get(quiet.childId)
    const loudChild = ctx.agents.get(loud.childId)
    expect(quietChild).toBeDefined()
    expect(loudChild).toBeDefined()

    const quietId = await ctx.subagents.sendMessage(
      quietChild!,
      parent.id,
      [{ type: 'text', text: 'quiet report' }],
      { signal: testSignal },
    )
    const loudId = await ctx.subagents.sendMessage(
      loudChild!,
      parent.id,
      [{ type: 'text', text: 'loud report' }],
      { signal: testSignal },
    )
    // Both sends were accepted; only the loud one is allowed through to the parent.
    expect(quietId).toBeTruthy()
    expect(loudId).toBeTruthy()

    await waitFor(() => sessionUserMessages(parent).some(message => message.id === loudId))
    const relayed = sessionUserMessages(parent).filter(message => message.source.kind === 'agent-message')
    expect(relayed).toHaveLength(1)
    expect(relayed[0]?.source).toMatchObject({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: loud.childId,
    })
    expect(JSON.stringify(relayed[0]?.content)).not.toContain('quiet report')

    await parent.whenIdle()
    await ctx.subagents.interrupt(quiet.childId, { kind: 'ancestor', agent: parent })
    await ctx.subagents.interrupt(loud.childId, { kind: 'ancestor', agent: parent })
    await ctx.subagents.drainContinuableDescendants([parent])
  })
})
