/**
 * Enpoi Harness — Spike A: live validation of the continuable spawn lifecycle.
 * Verifies the substrate the Oracle fiber + background dispatcher build on:
 * fresh-child isolation, persona/toolFilter overrides, multi-turn followups,
 * interrupt, and descendant drain.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, {
  type ContinuableStartSpec,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

type Script = ConstructorParameters<typeof MockAdapter>[0]

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
  const root = mkdtempSync(join(tmpdir(), 'dsh-spike-a-'))
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
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read a file',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [{ type: 'text', text: 'read' }] },
    execute: () => Promise.resolve({}),
  }))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent, adapter }
}

function continuableSpec(
  parent: SubagentStartRequest['parent'],
  overrides?: {
    provider?: 'spawn' | 'fork' | 'codex' | 'claude_code'
    label?: string
    signal?: AbortSignal
    request?: Partial<SubagentStartRequest>
  },
): ContinuableStartSpec {
  return {
    provider: overrides?.provider ?? 'spawn',
    label: overrides?.label ?? 'spike-a child',
    signal: overrides?.signal ?? new AbortController().signal,
    request: {
      prompt: [{ type: 'text', text: 'initial prompt' }],
      parent,
      ...overrides?.request,
    },
  }
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

describe('Spike A — continuable spawn lifecycle', () => {
  it('A1: fresh child with NO parent context + persona/toolFilter overrides applied', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('child answer'),
    ])
    const start = await ctx.subagents.startContinuable(continuableSpec(parent, {
      request: {
        persona: 'You are the Oracle — a senior reviewer.',
        toolFilter: { allow: ['read'] },
      } as Partial<SubagentStartRequest>,
    }))
    expect(start.childId).toBeTruthy()
    expect(start.messageId).toBeTruthy()

    // Wait for the child's turn to reach the adapter.
    await waitFor(() => adapter.requests.length >= 1)

    const childRequest = adapter.requests.at(-1)!
    // Persona override applied (replaces the deployment persona).
    expect(childRequest.system ?? '').toContain('You are the Oracle')
    // Tool filter: only `read` allowed.
    const names = (childRequest.tools ?? []).map(t => t.name)
    expect(names).toEqual(['read'])
    // Fresh session: no parent conversation leaked.
    expect(childRequest.messages.filter(m => m.role === 'user').length).toBeLessThanOrEqual(2)
    await ctx.subagents.interrupt(start.childId, { kind: 'ancestor', agent: parent })
  })

  it('A2: multi-turn continuity — followup delivers a next turn with history', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('first answer'),
      textResponse('second answer'),
    ])
    const start = await ctx.subagents.startContinuable(continuableSpec(parent))
    await waitFor(() => adapter.requests.length >= 1)
    // Wait for the child to PARK (cold-resume model) before following up.
    await waitFor(() => ctx.agents.get(start.childId) === undefined)
    const req1 = adapter.requests.at(-1)!

    // Follow up — a second child turn (fork's continuation tests use kind:'user').
    await ctx.subagents.followup(parent, start.childId, [
      { type: 'text', text: 'follow-up question' },
    ], { source: { kind: 'user' }, signal: new AbortController().signal })
    await waitFor(() => adapter.requests.length >= 2)

    const req2 = adapter.requests.at(-1)!
    if (req2 === req1) {
      console.log('DEBUG A2: requests=', adapter.requests.length)
      for (let i = 0; i < adapter.requests.length; i++) {
        const texts = (adapter.requests[i]?.messages ?? []).map(m => JSON.stringify(m).slice(0, 60)).join(' | ')
        console.log(`  req[${i}]: ${texts}`)
      }
    }
    expect(req2).not.toBe(req1)
    // The child sees its own first answer (history continuity).
    const allText = req2.messages.map(m => JSON.stringify(m)).join(' ')
    expect(allText).toContain('first answer')
    // And the follow-up content arrived.
    expect(allText).toContain('follow-up question')
    await ctx.subagents.interrupt(start.childId, { kind: 'ancestor', agent: parent })
  })

  it('A3: interrupt + drainContinuableDescendants release the child cleanly', async () => {
    const { ctx, parent, adapter } = await setup([
      textResponse('answer'),
      textResponse('answer 2'),
    ])
    const start = await ctx.subagents.startContinuable(continuableSpec(parent))
    await waitFor(() => adapter.requests.length >= 1)
    // Cold-resume model: after the turn the child PARKS (no live activation) —
    // `ctx.agents.get` is expectedly undefined until a followup re-activates.
    expect(ctx.agents.get(start.childId)).toBeUndefined()

    // Followup re-activates the child, then interrupt mid-life.
    await ctx.subagents.followup(parent, start.childId, [
      { type: 'text', text: 'continue' },
    ], { source: { kind: 'user' }, signal: new AbortController().signal })
    await waitFor(() => adapter.requests.length >= 2)
    await ctx.subagents.interrupt(start.childId, { kind: 'ancestor', agent: parent })

    // Descendant drain: manager-wide teardown releases everything cleanly.
    await ctx.subagents.drainContinuableDescendants([parent])
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
  })

  it('A4: start rejects on aborted signal (pre-publication abort path)', async () => {
    const { ctx, parent } = await setup([textResponse('never')])
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'seed' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.subagents.startContinuable(continuableSpec(parent, {
      signal: aborted.signal,
    }))).rejects.toThrow()
  })
})
