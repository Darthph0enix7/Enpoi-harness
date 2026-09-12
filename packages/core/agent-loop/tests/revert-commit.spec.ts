import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

describe('revert-commit surface shadowing', () => {
  it('appends a followup message with the requested surfaceOp replace and sourceEventSeqs', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second'), textResponse('third')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-commit'),
      { provider: 'mock', model: 'mock' },
    )

    // Turn 1
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Turn 2
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'world' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Find the first user message seq
    const firstUser = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    expect(firstUser).toBeDefined()
    const atSeq = firstUser!.seq

    // Commit with surfaceOp replace shadowing everything after atSeq
    const commit = createUserMessage({ content: [{ type: 'text', text: 'goodbye' }], source: { kind: 'user' } })
    const nodes = agent.session.surface.nodes
    const startIdx = nodes.indexOf(atSeq)
    const shadowedSeqs = nodes.slice(startIdx)
    const end = nodes[nodes.length - 1]!
    agent.followup(commit, {
      surfaceOp: { op: 'replace', startSeq: atSeq, endSeq: end },
      sourceEventSeqs: shadowedSeqs,
    })
    await waitForIdle(ctx, agent)

    // The commit user/message event must carry the replace surfaceOp
    const commitEvent = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === commit.id)
    expect(commitEvent).toBeDefined()
    expect(commitEvent?.surfaceOp).toEqual({ op: 'replace', startSeq: atSeq, endSeq: end })
    expect(commitEvent?.sourceEventSeqs).toEqual(shadowedSeqs)

    // The derived model surface must contain the commit message and NOT the
    // shadowed span: the reverted-from message (atSeq) and everything after it
    // are replaced by the commit message.
    const derived = agent.session.deriveMessages()
    const derivedTexts = derived
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(b => b.type === 'text')
      .map(b => b.text)
    expect(derivedTexts).toContain('goodbye')
    expect(derivedTexts).not.toContain('hello')
    expect(derivedTexts).not.toContain('world')
  })

  it('appends normally when no surface options are supplied', async () => {
    const adapter = new MockAdapter([textResponse('first')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-plain'),
      { provider: 'mock', model: 'mock' },
    )
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plain' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const userEvent = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    expect(userEvent?.surfaceOp).toBe('append')
  })

  it('clears the revert boundary atomically with the shadowing append (clearRevert)', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-clear'),
      { provider: 'mock', model: 'mock' },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Simulate the host: set the boundary at the first user message, then
    // commit with clearRevert.
    const firstUser = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    const atSeq = firstUser!.seq
    agent.session.append('revert/state', { fromSeq: atSeq }, { ignorable: true })
    const commit = createUserMessage({ content: [{ type: 'text', text: 'goodbye' }], source: { kind: 'user' } })
    const nodes = agent.session.surface.nodes
    const startIdx = nodes.indexOf(atSeq)
    const shadowedSeqs = nodes.slice(startIdx)
    const end = nodes[nodes.length - 1]!
    agent.followup(commit, {
      surfaceOp: { op: 'replace', startSeq: atSeq, endSeq: end },
      sourceEventSeqs: shadowedSeqs,
      clearRevert: true,
    })
    await waitForIdle(ctx, agent)

    // The boundary must be cleared AFTER the shadowing append, in log order.
    const events = agent.session.snapshotEvents()
    const commitIdx = events.findIndex(e => e.type === 'user/message' && e.data.id === commit.id)
    const clearIdx = events.findIndex(e => e.type === 'revert/state' && e.data.fromSeq === null)
    expect(commitIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(commitIdx)
    // The commit event carries the replace surfaceOp.
    expect(events[commitIdx]?.surfaceOp).toEqual({ op: 'replace', startSeq: atSeq, endSeq: end })
    // The derived surface excludes the shadowed span.
    const derivedTexts = agent.session.deriveMessages()
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(b => b.type === 'text')
      .map(b => b.text)
    expect(derivedTexts).toContain('goodbye')
    expect(derivedTexts).not.toContain('hello')
  })

  it('writes revert/state with the ignorable envelope marker', async () => {
    const adapter = new MockAdapter([textResponse('first')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-ignorable'),
      { provider: 'mock', model: 'mock' },
    )
    agent.session.append('revert/state', { fromSeq: 1 }, { ignorable: true })
    const event = agent.session.snapshotEvents().find(e => e.type === 'revert/state')
    expect(event).toBeDefined()
    expect(event?.ignorable).toBe(true)
  })
})
