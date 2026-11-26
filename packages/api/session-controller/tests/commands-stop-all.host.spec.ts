import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Cascade from '../../../../profile/web/packages/enpoi-cascade/src/index.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Spawn from '../../../subagent/subagent-spawn-in-process/src/index.ts'
import { createSessionTestController } from './test-remote.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function send(agent: Agent, prompt: string): void {
  agent.followup(createUserMessage({ content: text(prompt), source: { kind: 'user' } }))
}

function turnEnds(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

function settlements(agent: Agent) {
  return agent.session.snapshotEvents().filter(event =>
    event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'session-stop-all-'))
  const ctx = new Context()
  const gates: Array<PromiseWithResolvers<undefined>> = []
  const roots: Agent[] = []
  cleanups.push(async () => {
    for (const gate of gates) gate.resolve(undefined)
    try {
      await ctx.get('subagents')?.drainContinuableDescendants(roots)
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  })
  function gate() {
    const barrier = Promise.withResolvers<undefined>()
    gates.push(barrier)
    return barrier
  }

  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const loop = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(Cascade)
  const model = { provider: 'mock', model: 'mock' }
  const controller = createSessionTestController(ctx, { defaultModelSelection: () => model, cwd: root })
  const streamGates: Array<Promise<void>> = []
  const requests: GenerateOptions[] = []
  ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      await streamGates.shift()
      options.signal?.throwIfAborted()
      yield* textResponse('done')
    }
  }())
  async function createRoot(id: string): Promise<Agent> {
    const agent = await loop.create(SessionId(id), model)
    roots.push(agent)
    return agent
  }
  const parent = await createRoot('parent')

  async function holdTurn(start: () => Promise<Agent>) {
    const barrier = gate()
    const index = requests.length
    streamGates.push(barrier.promise)
    const agent = await start()
    await vi.waitFor(() => { expect(requests).toHaveLength(index + 1) })
    const request = requests[index]
    if (request === undefined) throw new Error('missing model request')
    return { agent, request, finish: () => { barrier.resolve(undefined) } }
  }

  return {
    parent, controller, requests, gate, ctx,
    foreignParent: () => createRoot('other-parent'),
    childTurn: (owner = parent) => holdTurn(async () => {
      const { childId } = await ctx.subagents.startContinuable({
        provider: 'spawn', label: 'child', request: { parent: owner, prompt: text('child task'), maxDepth: 3 },
        signal: new AbortController().signal,
      })
      const child = ctx.agents.get(childId)
      if (child === undefined) throw new Error('missing live child')
      return child
    }),
    parentTurn: () => holdTurn(() => {
      send(parent, 'operator ask')
      return Promise.resolve(parent)
    }),
  }
}

describe('Session cancel with live continuable descendants', () => {
  it.each(['stop-all', undefined] as const)('stops idle descendants with intent %s', async (intent) => {
    const { ctx, controller, parent, childTurn, foreignParent } = await harness()
    const child = await childTurn()
    const grandchild = await childTurn(child.agent)
    const foreign = await childTurn(await foreignParent())
    expect(parent.status).toBe('idle')
    expect(() => controller.cancel({ sessionId: child.agent.id, intent: 'stop-all' }))
      .toThrow(expect.objectContaining({ code: 'session/agent-busy' }))
    const interrupt = vi.spyOn(ctx.subagents, 'interrupt')
    const request = { sessionId: parent.id, ...intent === undefined ? {} : { intent } }
    expect(controller.cancel(request)).toEqual({ accepted: true })
    expect(controller.cancel(request)).toEqual({ accepted: true })
    await vi.waitFor(() => {
      expect(child.request.signal?.aborted).toBe(true)
      expect(grandchild.request.signal?.aborted).toBe(true)
    })
    expect(interrupt).toHaveBeenCalledTimes(2)
    expect(foreign.request.signal?.aborted).toBe(false)
    child.finish()
    grandchild.finish()
    await Promise.all([child.agent.whenIdle(), grandchild.agent.whenIdle()])
    expect(turnEnds(child.agent)[0]).toMatchObject({ kind: 'aborted', reason: { kind: 'parent' } })
    expect(turnEnds(grandchild.agent)).toEqual([{ kind: 'aborted', reason: { kind: 'parent' } }])
    expect(turnEnds(parent)).toEqual([])
  })

  it('parks a natural settlement after two idle Stop-all presses until the next human send', async () => {
    const { ctx, controller, parent, requests, childTurn, gate } = await harness()
    const child = await childTurn()
    const enteredFlush = gate()
    const releaseFlush = gate()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === child.agent.session) {
        enteredFlush.resolve(undefined)
        await releaseFlush.promise
      }
      return flush(session)
    })
    child.finish()
    await enteredFlush.promise
    expect(turnEnds(child.agent)).toEqual([{ kind: 'completed' }])
    expect(parent.status).toBe('idle')
    for (let press = 0; press < 2; press += 1) {
      expect(controller.cancel({ sessionId: parent.id, intent: 'stop-all' })).toEqual({ accepted: true })
    }
    releaseFlush.resolve(undefined)

    await vi.waitFor(() => { expect(parent.inbox.nextTurn).toHaveLength(1) })
    expect(parent.inbox.nextTurn[0]?.source.kind).toBe('subagent-settled')
    expect(settlements(parent)).toHaveLength(0)
    expect(parent.status).toBe('idle')
    expect(requests).toHaveLength(1)
    expect(turnEnds(parent)).toEqual([])

    send(parent, 'operator next')
    await parent.whenIdle()
    expect(parent.inbox.nextTurn).toEqual([])
    expect(settlements(parent)).toHaveLength(1)
    expect(requests).toHaveLength(3)

    await vi.waitFor(() => { expect(ctx.agents.get(child.agent.id)).toBeUndefined() })
    const interrupt = vi.spyOn(ctx.subagents, 'interrupt')
    expect(controller.cancel({ sessionId: parent.id, intent: 'stop-all' })).toEqual({ accepted: true })
    const nextChild = await childTurn()
    expect(interrupt).not.toHaveBeenCalled()
    nextChild.finish()
    await vi.waitFor(() => { expect(settlements(parent)).toHaveLength(2) })
  })

  it('leaves the child running on an idle detach and lets its settlement wake the parent', async () => {
    const { controller, parent, requests, childTurn } = await harness()
    const child = await childTurn()
    expect(controller.cancel({ sessionId: parent.id, intent: 'detach' })).toEqual({ accepted: true })
    expect(child.request.signal?.aborted).toBe(false)
    child.finish()
    await vi.waitFor(() => { expect(requests).toHaveLength(2) })
    await parent.whenIdle()
    expect(settlements(parent)).toHaveLength(1)
    expect(parent.inbox.nextTurn).toEqual([])
  })

  it('keeps a busy Stop-all on the durable abort path and interrupts the child once', async () => {
    const { controller, parent, childTurn, parentTurn } = await harness()
    const child = await childTurn()
    const childCancel = vi.spyOn(child.agent, 'cancel')
    const busy = await parentTurn()
    expect(controller.cancel({ sessionId: parent.id, intent: 'stop-all' })).toEqual({ accepted: true })
    expect(childCancel).not.toHaveBeenCalled()
    busy.finish()
    await parent.whenIdle()
    await vi.waitFor(() => { expect(child.request.signal?.aborted).toBe(true) })
    expect(childCancel).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    expect(turnEnds(parent)).toEqual([{ kind: 'aborted', reason: { kind: 'user', intent: 'stop-all' } }])
    child.finish()
    await vi.waitFor(() => { expect(parent.inbox.nextTurn).toHaveLength(1) })
    expect(turnEnds(child.agent)).toEqual([{ kind: 'aborted', reason: { kind: 'parent' } }])
    expect(settlements(parent)).toHaveLength(0)
  })
})
