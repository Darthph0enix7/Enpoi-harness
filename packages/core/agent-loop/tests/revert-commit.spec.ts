import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
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

  it('appends the revert/iteration marker immediately after the replacement with the appended seq', async () => {
    const adapter = new MockAdapter([textResponse('first')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-iteration-marker'),
      { provider: 'mock', model: 'mock' },
    )
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const firstUser = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    const atSeq = firstUser!.seq
    const nodes = agent.session.surface.nodes
    const end = nodes[nodes.length - 1]!
    agent.session.append('revert/state', { fromSeq: atSeq, cause: 'revert' })
    const commit = createUserMessage({ content: [{ type: 'text', text: 'goodbye' }], source: { kind: 'user' } })
    agent.followup(commit, {
      surfaceOp: { op: 'replace', startSeq: atSeq, endSeq: end },
      sourceEventSeqs: [...nodes.slice(nodes.indexOf(atSeq))],
      clearRevert: true,
      iteration: { groupAnchor: atSeq, previousSeq: atSeq, startSeq: atSeq, endSeq: end, cause: 'commit' },
    })
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const commitIdx = events.findIndex(e => e.type === 'user/message' && e.data.id === commit.id)
    expect(commitIdx).toBeGreaterThan(-1)
    // The marker is the very next event: variantSeq is known only at append.
    const marker = events[commitIdx + 1]
    expect(marker?.type).toBe('revert/iteration')
    expect(marker?.ignorable).toBe(true)
    expect(marker?.data).toEqual({
      groupAnchor: atSeq,
      previousSeq: atSeq,
      variantSeq: events[commitIdx]!.seq,
      startSeq: atSeq,
      endSeq: end,
      cause: 'commit',
    })
    // Log-only: the marker never enters the model surface.
    expect(agent.session.surface.nodes).not.toContain(marker!.seq)
  })

  it('recomputes a restore plan at append time so a settled tail is shadowed too', async () => {
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(
      SessionId('revert-iteration-restore'),
      { provider: 'mock', model: 'mock' },
    )
    // Two versions of one position: v1 (hello) replaced by v2 (world).
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const v1 = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.source.kind === 'user')!
    const firstNodes = agent.session.surface.nodes
    const v2 = createUserMessage({ content: [{ type: 'text', text: 'world' }], source: { kind: 'user' } })
    agent.followup(v2, {
      surfaceOp: { op: 'replace', startSeq: v1.seq, endSeq: firstNodes[firstNodes.length - 1]! },
      sourceEventSeqs: [...firstNodes.slice(firstNodes.indexOf(v1.seq))],
      iteration: { groupAnchor: v1.seq, previousSeq: v1.seq, startSeq: v1.seq, endSeq: firstNodes[firstNodes.length - 1]!, cause: 'commit' },
    })
    await waitForIdle(ctx, agent)
    const v2Event = agent.session.snapshotEvents().find(e => e.type === 'user/message' && e.data.id === v2.id)!
    // The plan the restore RPC validated: replace v2 through the then-tail.
    const staleTail = agent.session.surface.nodes[agent.session.surface.nodes.length - 1]!
    // A surface node lands after that validation (the interrupted-turn
    // settlement case); the admission-time recompute must shadow it too.
    const settled = createUserMessage({ content: [{ type: 'text', text: 'late settlement' }], source: { kind: 'user' } })
    const settledEvent = agent.session.append('user/message', settled, { surfaceOp: 'append' })
    agent.session.append('revert/state', { fromSeq: v2Event.seq, cause: 'restore' })
    const restored = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    agent.followup(restored, {
      surfaceOp: { op: 'replace', startSeq: v2Event.seq, endSeq: staleTail },
      sourceEventSeqs: [v2Event.seq],
      clearRevert: true,
      iteration: { groupAnchor: v1.seq, previousSeq: v2Event.seq, startSeq: v2Event.seq, endSeq: staleTail, cause: 'restore', restoredFromSeq: v1.seq },
    })
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const restoredEvent = events.find(e => e.type === 'user/message' && e.data.id === restored.id)!
    // The v2 turn's assistant answer and the settled tail are both shadowed.
    const v2Answer = events.find(e => e.type === 'assistant/message' && e.seq > v2Event.seq && e.seq < settledEvent.seq)!
    expect(restoredEvent.surfaceOp).toEqual({ op: 'replace', startSeq: v2Event.seq, endSeq: settledEvent.seq })
    expect(restoredEvent.sourceEventSeqs).toEqual([v2Event.seq, v2Answer.seq, settledEvent.seq])
    const marker = events.find(e => e.type === 'revert/iteration' && e.data.cause === 'restore')
    expect(marker?.data).toEqual({
      groupAnchor: v1.seq,
      previousSeq: v2Event.seq,
      variantSeq: restoredEvent.seq,
      startSeq: v2Event.seq,
      endSeq: settledEvent.seq,
      cause: 'restore',
      restoredFromSeq: v1.seq,
    })
    const derivedTexts = agent.session.deriveMessages()
      .filter(m => m.role === 'user')
      .flatMap(m => m.content)
      .filter(b => b.type === 'text')
      .map(b => b.text)
    expect(derivedTexts).toContain('hello')
    expect(derivedTexts).not.toContain('world')
    expect(derivedTexts).not.toContain('late settlement')
  })
})
