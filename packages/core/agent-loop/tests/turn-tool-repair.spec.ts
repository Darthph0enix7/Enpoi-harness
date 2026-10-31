import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createUserMessage,
  ToolCallId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineContentToolFixture, TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * Turn-end tool-batch closure: a step that fails, aborts, or is cancelled after
 * committing an assistant message with tool calls must still record one result
 * per call, so no later request carries an orphan call. The request-boundary
 * backstop covers histories the live close never saw.
 */

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function multiCall(calls: { id: string; name: string; args: object }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, index) => {
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args) } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function echoTool() {
  return defineContentToolFixture({
    name: 'echo',
    description: 'echo',
    parameters: { id: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `done-${args.id}` }]
    },
  })
}

function toolResults(agent: Agent) {
  return agent.session.snapshotEvents()
    .flatMap(event => event.type === 'tool/result' ? [event.data] : [])
}

function recoveryCodes(agent: Agent): (string | undefined)[] {
  return toolResults(agent)
    .map(data => data.error?.code)
    .filter(code => code === TOOL_OUTCOME_UNKNOWN || code === TOOL_NOT_STARTED)
}

describe('turn-end tool-batch closure', () => {
  it('records one synthetic result for the call left running when the step fails, and the next request carries both', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'echo', args: { id: '1' } },
        { id: 'c2', name: 'echo', args: { id: '2' } },
      ]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(echoTool())
    // The registry contains expected failures as results; replace its internal
    // view only to inject the scheduler invariant violation this boundary must
    // contain after the first call's result already committed.
    const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
    const dispatch = scheduler.dispatch.bind(scheduler)
    scheduler.dispatch = exec => exec.callId === ToolCallId('c2')
      ? Promise.reject(new Error('scheduler exploded'))
      : dispatch(exec)

    const agent = await ctx.agentLoop.create(SessionId('turn-tool-repair-failure'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(ending?.type === 'turn/end' && ending.data.reason).toMatchObject({
      kind: 'error',
      error: { message: 'scheduler exploded', code: 'UNKNOWN' },
    })
    // One real result for c1, exactly one synthetic result for c2.
    const results = toolResults(agent)
    expect(results).toHaveLength(2)
    expect(results.map(data => data.message.toolCallId)).toEqual(['c1', 'c2'])
    expect(results[0]?.error).toBeUndefined()
    expect(results[1]?.error).toEqual({
      name: 'ToolOutcomeUnknownError',
      code: TOOL_OUTCOME_UNKNOWN,
    })
    expect(results[1]?.message.id.startsWith('interrupted-tool-result-c2-')).toBe(true)
    expect(recoveryCodes(agent)).toEqual([TOOL_OUTCOME_UNKNOWN])

    // The next request carries both results, in call order, right after the batch.
    send(agent, 'next')
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const messages = adapter.requests[1]!.messages
    const batchIndex = messages.findIndex(message =>
      message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
    expect(batchIndex).toBeGreaterThanOrEqual(0)
    expect(messages.slice(batchIndex + 1, batchIndex + 3).map(message =>
      message.role === 'tool' ? message.toolCallId : message.role)).toEqual(['c1', 'c2'])
  })

  it('adds nothing when cancellation already recorded a result for every call', async () => {
    const adapter = new MockAdapter([
      multiCall([
        { id: 'c1', name: 'slow', args: {} },
        { id: 'c2', name: 'slow', args: {} },
      ]),
      textResponse('recovered'),
    ])
    const ctx = await harness(adapter)
    let started = false
    ctx.tools.register(defineContentToolFixture({
      name: 'slow',
      description: 'waits for cancellation',
      parameters: {},
      async execute(_args, exec) {
        started = true
        await new Promise<void>((resolve) => {
          if (exec.signal?.aborted) { resolve(); return }
          exec.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return [{ type: 'text', text: 'cancelled' }]
      },
    }))

    const agent = await ctx.agentLoop.create(SessionId('turn-tool-repair-cancel'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    for (let attempt = 0; attempt < 1000 && !started; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
    expect(started).toBe(true)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(ending?.type === 'turn/end' && ending.data.reason).toMatchObject({
      kind: 'aborted',
      reason: { kind: 'user' },
    })
    // The tool layer answered both calls itself; the close appended no recovery.
    const results = toolResults(agent)
    expect(results).toHaveLength(2)
    expect(results.map(data => data.message.toolCallId)).toEqual(['c1', 'c2'])
    expect(recoveryCodes(agent)).toEqual([])
  })

  it('adds nothing to a completed turn whose batch is answered', async () => {
    const adapter = new MockAdapter([
      multiCall([{ id: 'c1', name: 'echo', args: { id: '1' } }]),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(echoTool())

    const agent = await ctx.agentLoop.create(SessionId('turn-tool-repair-complete'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(ending?.type === 'turn/end' && ending.data.reason).toEqual({ kind: 'completed' })
    expect(toolResults(agent)).toHaveLength(1)
    expect(recoveryCodes(agent)).toEqual([])
  })
})

describe('request-build backstop for an orphan call', () => {
  it('synthesizes a transient result on the wire without touching the durable log', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(echoTool())
    const agent = await ctx.agentLoop.create(SessionId('turn-tool-repair-backstop'), { provider: 'mock', model: 'mock' })

    // Directly constructed history: an assistant message requests a call that
    // no tool/result ever answers (an older or interior log).
    const orphan = createAssistantMessage({
      content: [{ type: 'tool-call', id: ToolCallId('orphan'), name: 'echo', arguments: '{}' }],
      source: { provider: 'mock', model: 'mock' },
    })
    agent.session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: orphan,
      stream: [],
    }, { surfaceOp: 'append' })
    const durableBefore = agent.session.snapshotEvents()

    send(agent, 'go')
    await agent.whenIdle()

    const messages = adapter.requests[0]!.messages
    const orphanIndex = messages.findIndex(message => message.id === orphan.id)
    expect(orphanIndex).toBeGreaterThanOrEqual(0)
    const answer = messages[orphanIndex + 1]
    expect(answer?.role).toBe('tool')
    if (answer?.role !== 'tool') throw new Error('expected a synthetic tool result')
    expect(answer.toolCallId).toBe('orphan')
    expect(answer.id.startsWith('request-tool-result-orphan-')).toBe(true)
    expect(answer.isError).toBe(true)
    const text = answer.content[0]
    if (text?.type !== 'text') throw new Error('expected synthetic result text')
    expect(text.text).toContain('Its outcome is unknown.')

    // Durable history is unchanged: the backstop appended no result.
    expect(agent.session.snapshotEvents().slice(0, durableBefore.length)).toEqual(durableBefore)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result')).toEqual([])
    expect(agent.session.deriveMessages().some(message => message.role === 'tool')).toBe(false)
  })
})
