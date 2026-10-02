/**
 * A turn abort must not lose a settlement notice that is already queued in
 * the parent's inbox: the notice records work the fleet already finished,
 * while operator steering input is what the stop rejects. The next parent
 * turn claims and delivers the preserved notice.
 * @module dsh-subagent/tests/cancel-preserves-settlement
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSettlementMessage } from '../src/continuation-messages.ts'

const contexts = new Set<Context>()
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
})

async function setup(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

/** Every model-visible user-message text block recorded by one agent. */
function userTexts(agent: { session: { snapshotEvents(): readonly unknown[] } }): string[] {
  return (agent.session.snapshotEvents() as readonly {
    type: string
    data: { content?: readonly { type: string; text?: string }[] }
  }[])
    .filter(event => event.type === 'user/message')
    .flatMap(event => event.data.content ?? [])
    .flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : [])
}

function operatorMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('Agent.cancel preserves queued settlement notices', () => {
  it('keeps the notice, drops operator steering, and delivers the notice on the next turn', async () => {
    const adapter = new MockAdapter(['hang', textResponse('notice processed')])
    const { parent } = await setup(adapter)

    parent.followup(operatorMessage('start the long turn'))
    await vi.waitFor(() => { expect(adapter.requests.length).toBe(1) })

    // Both land in next-step while the turn is running: a real settlement
    // notice (the fleet's work) and operator steering (what a stop rejects).
    const notice = createSettlementMessage(SessionId('child-1'), {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'CHILD DONE' }],
    })
    parent.steer(notice)
    parent.steer(operatorMessage('operator steer'))

    parent.cancel({ kind: 'user' })
    await parent.whenIdle()

    // The steer is durably canceled; the notice is still pending.
    const canceled = parent.session.snapshotEvents()
      .flatMap(event => event.type === 'agent/inbox/spliced' ? [event.data] : [])
      .filter(data => data.outcome === 'canceled')
    expect(canceled).toHaveLength(1)
    expect(canceled[0]).toMatchObject({ target: 'next-step', removedCount: 1 })
    expect([...parent.inbox.nextTurn, ...parent.inbox.nextStep].map(message => message.id))
      .toEqual([notice.id])

    // The next operator turn claims and delivers the preserved notice.
    parent.followup(operatorMessage('next'))
    await parent.whenIdle()

    const texts = userTexts(parent)
    expect(texts).toContain('Background subagent child-1 finished.')
    expect(texts.filter(text => text === 'operator steer')).toEqual([])
    expect(texts).toContain('next')
  })
})
