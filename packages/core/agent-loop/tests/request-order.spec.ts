/**
 * Request-boundary tool-batch adjacency.
 *
 * A strict provider rejects an assistant message whose tool calls are not
 * immediately followed by their results. The durable log can hold that split —
 * a checkpoint plugin commits a user message while the batch is still running —
 * and every later turn re-sends it. `orderToolBatches` heals the wire order
 * without touching the stored order, which is exactly what these tests pin:
 * unit rules, idempotence, and one integration replay through the real loop.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ToolCallId,
  createAssistantMessage,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, interruptedToolRecovery } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { completeToolBatches, orderToolBatches } from '../src/request-order.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** An assistant message carrying one tool call per id, in the given order. */
function assistantCalls(...ids: string[]): AssistantMessage {
  return createAssistantMessage({
    content: ids.map(id => ({
      type: 'tool-call' as const,
      id: ToolCallId(id),
      name: 'echo',
      arguments: '{}',
    })),
    source: { provider: 'mock', model: 'mock' },
  })
}

function toolResult(callId: string, text = callId): Message {
  return createToolResultMessage({
    callId: ToolCallId(callId),
    content: [{ type: 'text', text }],
    isError: false,
  })
}

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function ids(messages: readonly Message[]): string[] {
  return messages.map(message => message.id)
}

describe('orderToolBatches', () => {
  it('moves a checkpoint injected between calls and results to after the batch', () => {
    const assistant = assistantCalls('call_1', 'call_2')
    const checkpoint = user('### State checkpoint')
    const result1 = toolResult('call_1')
    const result2 = toolResult('call_2')
    const input: Message[] = [user('go'), assistant, checkpoint, result1, result2]

    const output = orderToolBatches(input)

    expect(output.map(message => message.id)).toEqual([
      input[0]!.id,
      assistant.id,
      result1.id,
      result2.id,
      checkpoint.id,
    ])
    // No message is lost or duplicated.
    expect(new Set(ids(output))).toEqual(new Set(ids(input)))
    expect(output).toHaveLength(input.length)
    // Only the wire order changed; the same references are re-emitted.
    for (const message of output) expect(input).toContain(message)
  })

  it('normalizes two consecutive batches independently', () => {
    const assistant1 = assistantCalls('call_1')
    const checkpoint1 = user('### State checkpoint one')
    const result1 = toolResult('call_1')
    const assistant2 = assistantCalls('call_2')
    const checkpoint2 = user('### State checkpoint two')
    const result2 = toolResult('call_2')
    const tail = user('next')
    const input: Message[] = [
      user('go'), assistant1, checkpoint1, result1, assistant2, checkpoint2, result2, tail,
    ]

    const output = orderToolBatches(input)

    expect(output.map(message => message.id)).toEqual([
      input[0]!.id, assistant1.id, result1.id, checkpoint1.id,
      assistant2.id, result2.id, checkpoint2.id, tail.id,
    ])
    expect(ids(output)).toHaveLength(input.length)
  })

  it('emits out-of-order results in call order', () => {
    const assistant = assistantCalls('call_1', 'call_2')
    const result1 = toolResult('call_1')
    const result2 = toolResult('call_2')
    const input: Message[] = [assistant, result2, result1]

    expect(orderToolBatches(input).map(message => message.id)).toEqual([
      assistant.id, result1.id, result2.id,
    ])
  })

  it('leaves a batch with a missing result untouched', () => {
    const assistant = assistantCalls('call_1', 'call_2')
    const checkpoint = user('### State checkpoint')
    const result1 = toolResult('call_1')
    const input: Message[] = [user('go'), assistant, checkpoint, result1, user('later')]

    const output = orderToolBatches(input)

    // Same messages, same references, same positions: a repair path that can
    // synthesize the missing result owns this batch instead.
    expect(output.map(message => message.id)).toEqual(ids(input))
    output.forEach((message, index) => { expect(message).toBe(input[index]) })
  })

  it('does not cross into the next batch to complete an earlier one', () => {
    const assistant1 = assistantCalls('call_1')
    const assistant2 = assistantCalls('call_2')
    const checkpoint = user('### State checkpoint')
    const result2 = toolResult('call_2')
    const input: Message[] = [assistant1, checkpoint, assistant2, result2]

    const output = orderToolBatches(input)

    expect(output.map(message => message.id)).toEqual(ids(input))
    output.forEach((message, index) => { expect(message).toBe(input[index]) })
  })

  it('displaces every interleaved role after the batch, preserving their relative order', () => {
    const assistant = assistantCalls('call_1')
    const system = createDeveloperMessage({
      content: [{ type: 'tool-addition', toolName: 'echo' }],
      source: { kind: 'tool-registry' },
    })
    const checkpoint = user('### State checkpoint')
    const context = user('runtime context')
    const result = toolResult('call_1')
    const input: Message[] = [assistant, system, checkpoint, context, result, user('next')]

    const output = orderToolBatches(input)

    expect(output.map(message => message.id)).toEqual([
      assistant.id, result.id, system.id, checkpoint.id, context.id, input[5]!.id,
    ])
  })

  it('is idempotent', () => {
    const assistant1 = assistantCalls('call_1', 'call_2')
    const checkpoint1 = user('### State checkpoint')
    const result2 = toolResult('call_2')
    const result1 = toolResult('call_1')
    const assistant2 = assistantCalls('call_3')
    const checkpoint2 = user('### State checkpoint two')
    const input: Message[] = [
      user('go'), assistant1, checkpoint1, result2, result1, assistant2, checkpoint2, user('tail'),
    ]

    const first = orderToolBatches(input)
    const second = orderToolBatches(first)

    expect(ids(second)).toEqual(ids(first))
    second.forEach((message, index) => { expect(message).toBe(first[index]) })
  })
})

describe('completeToolBatches', () => {
  it('synthesizes one transient result per unanswered call, then the batch orders them', () => {
    const assistant = assistantCalls('call_1', 'call_2')
    const result1 = toolResult('call_1')
    const input: Message[] = [user('go'), assistant, result1, user('later')]

    const completed = completeToolBatches(input)
    expect(completed).toHaveLength(input.length + 1)
    // Input elements are returned by reference; nothing durable is mutated.
    expect(completed[0]).toBe(input[0])
    expect(completed[1]).toBe(input[1])
    expect(completed[3]).toBe(input[2])
    expect(completed[4]).toBe(input[3])
    expect(input).toHaveLength(4)
    const synthetic = completed[2]!
    expect(synthetic).toMatchObject({
      role: 'tool',
      toolCallId: 'call_2',
      isError: true,
      source: { kind: 'tool', callId: 'call_2' },
      content: [{ type: 'text', text: interruptedToolRecovery(true).text }],
    })
    expect(synthetic.id.startsWith('request-tool-result-call_2-')).toBe(true)
    expect(Object.isFrozen(synthetic)).toBe(true)

    // The wire shows the answered and synthesized results in call order.
    const wire = orderToolBatches(completed)
    const batch = wire.findIndex(message => message.id === assistant.id)
    expect(wire.slice(batch + 1, batch + 3).map(message =>
      message.role === 'tool' ? message.toolCallId : message.role)).toEqual(['call_1', 'call_2'])
  })

  it('returns the same references for a fully answered batch', () => {
    const assistant = assistantCalls('call_1')
    const input: Message[] = [user('go'), assistant, toolResult('call_1')]

    const completed = completeToolBatches(input)

    expect(completed).toHaveLength(input.length)
    completed.forEach((message, index) => { expect(message).toBe(input[index]) })
  })

  it('is idempotent', () => {
    const assistant = assistantCalls('call_1', 'call_2')
    const first = completeToolBatches([user('go'), assistant, toolResult('call_1')])
    const second = completeToolBatches(first)

    expect(ids(second)).toEqual(ids(first))
    second.forEach((message, index) => { expect(message).toBe(first[index]) })
  })

  it('does not cross into the next batch to answer an earlier call', () => {
    const assistant1 = assistantCalls('call_1')
    const assistant2 = assistantCalls('call_2')
    const input: Message[] = [assistant1, assistant2, toolResult('call_2')]

    const completed = completeToolBatches(input)

    expect(completed).toHaveLength(4)
    expect(completed[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1' })
    // Batch two stays untouched: its own result answers `call_2`.
    expect(completed[2]).toBe(assistant2)
    expect(completed[3]).toBe(input[2])
  })

  it('synthesizes once for duplicate call ids answered fewer times', () => {
    const assistant = assistantCalls('call_1', 'call_1')
    const input: Message[] = [assistant, toolResult('call_1')]

    expect(completeToolBatches(input)).toHaveLength(3)
    expect(completeToolBatches(completeToolBatches(input))).toHaveLength(3)
  })
})

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('tool-batch adjacency at the request boundary', () => {
  it('heals a replayed poisoned session without changing the durable order', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const callId = 'call_00_9boejr0piu3rhreimujs7766'
    const adapter = new MockAdapter([
      toolCallResponse(callId, 'checkpoint', {}),
      textResponse('recovered'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const agent = await ctx.agentLoop.create(SessionId('poisoned-replay'), { provider: 'mock', model: 'mock' })
    let checkpoint: UserMessage | undefined
    ctx.tools.register(defineContentToolFixture({
      name: 'checkpoint',
      description: 'commits a state checkpoint while the tool batch is still open',
      parameters: {},
      async execute() {
        // The incident producer: a user message committed mid-batch, between
        // the assistant's tool-call message and the tool result. Session
        // append snapshots its payload, so hold the recorded message.
        checkpoint = agent.session.append('user/message', user(
          '### State checkpoint: replay of the poisoned session',
        ), { surfaceOp: 'append' }).data
        return [{ type: 'text', text: 'ok' }]
      },
    }))

    agent.followup(user('go'))
    await waitForIdle(ctx, agent)
    expect(errors).toEqual([])

    const derived = agent.session.deriveMessages()
    const callMessage = derived.find(
      (message): message is AssistantMessage => message.role === 'assistant'
        && message.content.some(block => block.type === 'tool-call'),
    )!
    const resultMessage = derived.find(
      message => message.role === 'tool' && message.toolCallId === callId,
    )!
    // The durable log really is poisoned: the checkpoint precedes the result.
    expect(derived.indexOf(checkpoint!)).toBeLessThan(derived.indexOf(resultMessage))

    // The next request was still dispatched; its wire order is healed.
    const request = adapter.requests[1]
    expect(request).toBeDefined()
    const messages = request!.messages
    const callIndex = messages.indexOf(callMessage)
    expect(callIndex).toBeGreaterThanOrEqual(0)
    expect(messages[callIndex + 1]).toBe(resultMessage)
    expect(messages[callIndex + 2]).toBe(checkpoint)

    // No user message sits between any call and its result.
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!
      if (message.role !== 'assistant') continue
      const calls = message.content.filter(block => block.type === 'tool-call')
      if (calls.length === 0) continue
      let next = index + 1
      const answered = new Set<string>()
      for (;;) {
        const candidate = messages[next]
        if (candidate === undefined || candidate.role !== 'tool') break
        answered.add(candidate.toolCallId)
        next += 1
      }
      if (calls.every(call => answered.has(call.id))) {
        expect(next - index - 1).toBe(calls.length)
      }
    }
  })
})
