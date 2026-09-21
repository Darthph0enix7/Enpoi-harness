/**
 * Step-level model-group escalation: a request-error retry prepares the
 * group's next link for the same turn/step, links are snapshotted at step
 * start, and an absent or unusable group keeps single-model routing.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelChainLink, ModelChainResolver } from '@deepseek-ai/dsh-llm'
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

/** A failure code the runtime's own chain loop never absorbs, so the consumer retry owns escalation. */
const CONSUMER_ONLY = 'MIDDLEWARE_FAILURE'

describe('step model-group escalation', () => {
  it('retries a failed step on the next link with the same turn and step', async () => {
    const adapter = new MockAdapter([
      fail('busy', CONSUMER_ONLY),
      fail('busy', CONSUMER_ONLY),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', {
      resolve: (id: string) => id === 'stable'
        ? {
          id,
          links: [
            { provider: 'mock', model: 'alpha' },
            { provider: 'mock', model: 'beta' },
            { provider: 'mock', model: 'gamma' },
          ],
        }
        : undefined,
    } satisfies ModelChainResolver)
    const agent = await ctx.agentLoop.create(SessionId('model-chain-escalation'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'stable',
    })
    const seen: { turn: number; step: number }[] = []
    ctx.on('agent/request-error', async ({ turn, step }) => {
      seen.push({ turn, step })
      return { kind: 'retry' }
    })

    send(agent)
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'beta', 'gamma'])
    expect(adapter.requests.map(request => request.chain)).toEqual(['stable', 'stable', 'stable'])
    expect(seen).toEqual([
      { turn: 1, step: 1 },
      { turn: 1, step: 1 },
    ])
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.find(event => event.type === 'assistant/message')).toMatchObject({
      data: { message: { source: { provider: 'mock', model: 'gamma' } } },
    })
  })

  it('keeps the single-model route when no group registry is mounted', async () => {
    const adapter = new MockAdapter([fail('busy', CONSUMER_ONLY), textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('model-chain-no-service'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'stable',
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    send(agent)
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'alpha'])
    expect(adapter.requests.map(request => request.chain)).toEqual(['stable', 'stable'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
  })

  it('fails open to the current model with one warning when the group id is unknown', async () => {
    const adapter = new MockAdapter([fail('busy', CONSUMER_ONLY), textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', { resolve: () => undefined } satisfies ModelChainResolver)
    const lines: string[] = []
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const agent = await ctx.agentLoop.create(SessionId('model-chain-dangling'), {
        provider: 'mock',
        model: 'alpha',
        chain: 'dangling-group',
      })
      ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

      send(agent)
      await agent.whenIdle()

      expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'alpha'])
      const stepWarnings = lines.filter(line => line.includes('step retries keep the current model'))
      expect(stepWarnings).toHaveLength(1)
      expect(stepWarnings[0]).toContain('dangling-group')
    } finally {
      stderr.mockRestore()
    }
  })

  it('keeps the requested effort when a retry lands on the same link', async () => {
    const adapter = new MockAdapter(
      [fail('busy', CONSUMER_ONLY), textResponse('ok')],
      { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] },
    )
    const ctx = await harness(adapter)
    ctx.provide('modelChains', {
      resolve: (id: string) => (id === 'stable'
        ? { id, links: [{ provider: 'mock', model: 'alpha' }] }
        : undefined),
    } satisfies ModelChainResolver)
    const agent = await ctx.agentLoop.create(SessionId('model-chain-single-link'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'stable',
      reasoningEffort: ReasoningEffortId('high'),
    })
    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    send(agent)
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'alpha'])
    expect(adapter.requests.map(request => request.reasoningEffort)).toEqual(['high', 'high'])
  })

  it('does not re-read group links between the attempts of one step', async () => {
    const links: ModelChainLink[] = [
      { provider: 'mock', model: 'alpha' },
      { provider: 'mock', model: 'beta' },
    ]
    const adapter = new MockAdapter([fail('busy', CONSUMER_ONLY), textResponse('ok')])
    const ctx = await harness(adapter)
    ctx.provide('modelChains', {
      resolve: (id: string) => (id === 'stable' ? { id, links } : undefined),
    } satisfies ModelChainResolver)
    const agent = await ctx.agentLoop.create(SessionId('model-chain-snapshot'), {
      provider: 'mock',
      model: 'alpha',
      chain: 'stable',
    })
    ctx.on('agent/request-error', async () => {
      // Inserting before the active link must not change this step's retry:
      // the attempt resolves against the links snapshotted at step start.
      links.unshift({ provider: 'mock', model: 'zero' })
      return { kind: 'retry' }
    })

    send(agent)
    await agent.whenIdle()

    expect(links.map(link => link.model)).toEqual(['zero', 'alpha', 'beta'])
    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'beta'])
  })
})
