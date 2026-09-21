/**
 * Runtime-level group escalation provenance: when the LLM runtime's own link
 * loop answers on a link other than the proposed route, the committed
 * assistant message names the link that answered; a request with no group, or
 * one answered by its own link, keeps the proposed route byte-identical.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, expandAssistantStream, LlmError } from '@deepseek-ai/dsh-llm'
import type { ModelChainResolver } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

function assistantMessage(agent: Agent): { source: unknown; stream: Parameters<typeof expandAssistantStream>[0] } {
  const message = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') throw new Error('expected a committed assistant/message')
  return { source: message.data.message.source, stream: message.data.stream }
}

/** The group the runtime's own loop must escalate inside one dispatch. */
function deadtest(): ModelChainResolver {
  return {
    resolve: (id: string) => (id === 'deadtest'
      ? { id, links: [{ provider: 'mock', model: 'alpha' }, { provider: 'mock', model: 'beta' }] }
      : undefined),
  }
}

describe('runtime escalation attribution', () => {
  it('names the answering link when the runtime escalates away from a route outside the group', async () => {
    const adapter = new MockAdapter([fail('route alpha is down', 'RATE_LIMIT'), textResponse('four')])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', deadtest())

    const agent = await ctx.agentLoop.create(SessionId('chain-attribution-outside'), {
      provider: 'no-such-route',
      model: 'nope',
      chain: 'deadtest',
    })
    send(agent)
    await agent.whenIdle()

    // The runtime ran the group from its first link and answered on the second.
    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'beta'])
    expect(assistantMessage(agent).source).toMatchObject({
      kind: 'model',
      provider: 'mock',
      model: 'beta',
      chain: 'deadtest',
    })
  })

  it('names the answering link when the request route is the group link that failed', async () => {
    const adapter = new MockAdapter([fail('link alpha is down', 'RATE_LIMIT'), textResponse('four')])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', deadtest())

    const agent = await ctx.agentLoop.create(SessionId('chain-attribution-first-link'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'deadtest',
    })
    send(agent)
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'beta'])
    expect(assistantMessage(agent).source).toMatchObject({
      kind: 'model',
      provider: 'mock',
      model: 'beta',
      chain: 'deadtest',
    })
  })

  it('keeps the proposed route and stream when the group link itself answered', async () => {
    const adapter = new MockAdapter([textResponse('own link')])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', deadtest())

    const agent = await ctx.agentLoop.create(SessionId('chain-attribution-own-link'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'deadtest',
    })
    send(agent)
    await agent.whenIdle()

    const committed = assistantMessage(agent)
    expect(committed.source).toEqual({ kind: 'model', provider: 'mock', model: 'alpha', chain: 'deadtest' })
    expect(expandAssistantStream(committed.stream).some(member => 'answeringLink' in member.chunk)).toBe(false)
  })

  it('keeps a plain single-model request byte-identical', async () => {
    const adapter = new MockAdapter([textResponse('plain')])
    const ctx = await harness(adapter)

    const agent = await ctx.agentLoop.create(SessionId('chain-attribution-plain'), {
      provider: 'mock',
      model: 'alpha',
    })
    send(agent)
    await agent.whenIdle()

    const committed = assistantMessage(agent)
    expect(committed.source).toEqual({ kind: 'model', provider: 'mock', model: 'alpha' })
    expect(expandAssistantStream(committed.stream).some(member => 'answeringLink' in member.chunk)).toBe(false)
  })
})
