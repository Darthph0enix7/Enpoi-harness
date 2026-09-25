/**
 * Host execution-latch and Session-digest behavior: the latch priority order
 * (pending ask → open turn with working descendants → open turn → idle) with a
 * real Session and real child Agents, and the digest's bounded previews,
 * injection index, subagent tree, and pending interactions.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SessionExecutionStateValue,
  SessionPromptRequest,
  SessionRequestId,
} from '../src/types.ts'
import type { TestSessionRemote } from './test-remote.ts'
import { createSessionTestRemote } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only producer kind: the digest fixture's injected context source. */
    'digest-test': { kind: 'digest-test' } & ContextFormed
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** One held stream: resolves `started` when the stream begins, `release()` ends the hold. */
interface HeldStream {
  readonly started: Promise<undefined>
  release(): undefined
}

/**
 * Scripted model that holds individual streams open so several turns can stay
 * live at once (a parent and its child), each on its own gate.
 */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  private readonly holds: { readonly gate: PromiseWithResolvers<undefined>; readonly started: PromiseWithResolvers<undefined> }[] = []

  /** Hold the next stream call until its `release()` is called. */
  holdNext(): HeldStream {
    const gate = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    this.holds.push({ gate, started })
    return {
      started: started.promise,
      release: () => {
        gate.resolve(undefined)
        return undefined
      },
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const hold = this.holds.shift()
    if (hold !== undefined) {
      hold.started.resolve(undefined)
      // Bounded hold: an unreleased stream must not keep a failed spec's fibers alive.
      const timer = setTimeout(() => { hold.gate.resolve(undefined) }, 2_000)
      timer.unref()
      await hold.gate.promise
      clearTimeout(timer)
    }
    const text = `reply-${String(this.calls.length)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Harness {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly adapter: ScriptedAdapter
  readonly parent: Agent
  readonly sessionId: SessionId
  readonly root: string
}

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'exec-state-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'scripted', model: 'mock' }),
    saveSelection: async () => {},
  } as never)
  const adapter = new ScriptedAdapter()
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'scripted', model: 'mock' }),
    cwd: root,
  })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['scripted'], adapter)
  const created = await remote.create({ cwd: root })
  const sessionId = valueOf(created).sessionId
  return { ctx, remote, adapter, parent: ctx.agents.get(sessionId) as Agent, sessionId, root }
}

/**
 * Create one resident child Agent under the parent and make it genuinely
 * working: a host-side followup starts its own turn, and the adapter holds
 * that turn's stream open until the caller releases it.
 */
async function startWorkingChild(
  test: Harness,
  childId: string,
  prompt: string,
): Promise<{ readonly child: AgentHandle; readonly hold: HeldStream }> {
  const child = await test.ctx.agents.create({
    sessionId: brandString<SessionId>(childId),
    parentAgent: test.parent,
    agentOptions: { provider: 'scripted', model: 'mock' },
    meta: { parentSession: test.sessionId, origin: 'subagent', delegationDepth: 1, cwd: test.root },
  })
  child.agent.session.append('subagent/descriptor', {
    version: 3,
    mode: 'continuable',
    provider: 'spawn',
    label: childId,
    quiet: true,
  })
  const hold = test.adapter.holdNext()
  child.agent.followup(createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  }))
  await hold.started
  await waitFor(() => child.agent.status === 'running')
  return { child, hold }
}

/** Unwrap one Remote result or fail the test with its structured error. */
function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await assertion()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`condition not met within ${String(timeoutMs)}ms`)
}

function latchOf(test: Harness): Promise<RemoteResult<SessionExecutionStateValue>> {
  return test.remote.executionState({ sessionId: test.sessionId })
}

/** One prompt request body with a fresh identity. */
let nextRequest = 1
function promptBody(sessionId: SessionId, text: string): SessionPromptRequest {
  return {
    sessionId,
    mode: 'queue',
    requestId: brandString<SessionRequestId>(`exec-state-${String(nextRequest++)}`),
    content: [{ type: 'text', text }],
  }
}

/**
 * Append a fork event the typed event map does not declare. The runtime log
 * vocabulary is open (the reader validates it separately), so the cast is
 * deliberate and confined to this one seam.
 * @param session - the session to append to.
 * @param type - the fork event type.
 * @param data - the event payload.
 */
function appendForkEvent(
  session: { append: (...args: never[]) => unknown } | undefined,
  type: string,
  data: Record<string, unknown>,
): void {
  if (session === undefined) throw new Error('appendForkEvent: session is undefined')
  const append = session.append.bind(session) as unknown as (type: string, data: Record<string, unknown>) => unknown
  append(type, data)
}

describe('session execution latch', () => {
  it('follows idle → running → waiting_subagents (working quiet child) → waiting_approval → idle', async () => {
    const test = await harness()
    const { ctx, remote, adapter, parent, sessionId } = test
    await ctx.plugin(ApprovalService)

    const idle = valueOf(await latchOf(test))
    expect(idle).toMatchObject({
      latch: 'idle',
      source: 'host-latch',
      activeDescendants: 0,
      descendantsExact: true,
      pendingAsks: [],
    })
    expect(idle.model).toEqual({ provider: 'scripted', model: 'mock' })

    // Open turn: the driver is holding the stream, so the turn stays live.
    const hold = adapter.holdNext()
    expect(valueOf(await remote.prompt(promptBody(sessionId, 'hold the turn'))).accepted).toBe(true)
    await hold.started
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'running')
    const running = valueOf(await latchOf(test))
    expect(running.activeDescendants).toBe(0)
    expect(running.since).toBeGreaterThan(0)

    // A genuinely working quiet child: a resident child Agent with its own held
    // turn and a quiet descriptor, and no parent-catalog record.
    const { child, hold: childHold } = await startWorkingChild(test, 'exec-state-child', 'child work')
    const session = ctx.sessions.get(sessionId)
    expect(session).toBeDefined()
    // The descendant count is registry-derived: the parent log holds no
    // subagent/catalog record for the quiet child.
    expect(session?.snapshotEvents().some(event => event.type === 'subagent/catalog')).toBe(false)

    await waitFor(async () => valueOf(await latchOf(test)).latch === 'waiting_subagents')
    const waitingSubagents = valueOf(await latchOf(test))
    expect(waitingSubagents).toMatchObject({ activeDescendants: 1, descendantsExact: true })

    // A pending approval wins over the open turn with a working descendant.
    const parked = Promise.withResolvers<ApprovalOutcome>()
    ctx.on('approval/request', () => parked.promise)
    const approvalAbort = new AbortController()
    const deciding = ctx.approval.request({
      agent: parent,
      toolName: 'bash',
      callId: ToolCallId('exec-state-ask'),
      reason: 'needs a human',
      signal: approvalAbort.signal,
    })
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'waiting_approval')
    const waiting = valueOf(await latchOf(test))
    expect(waiting.pendingAsks).toHaveLength(1)
    expect(waiting.pendingAsks[0]).toMatchObject({
      kind: 'approval',
      toolName: 'bash',
      callId: 'exec-state-ask',
      reason: 'needs a human',
    })
    expect(waiting.pendingAsks[0]?.askId.length).toBeGreaterThan(0)
    expect(waiting.pendingAsks[0]?.since).toBeGreaterThan(0)

    // A pending question joins the same list while the approval stays pending.
    const questionAbort = new AbortController()
    const asking = waterfallQuestion(ctx, parent, questionAbort.signal, [
      { id: 'q1', question: 'Deploy where?' },
    ])
    void asking.catch(() => undefined)
    await waitFor(async () => valueOf(await latchOf(test)).pendingAsks.some(ask => ask.kind === 'question'))
    const withQuestion = valueOf(await latchOf(test))
    expect(withQuestion.pendingAsks.map(ask => ask.kind).sort()).toEqual(['approval', 'question'])
    const question = withQuestion.pendingAsks.find(ask => ask.kind === 'question')
    expect(question?.kind === 'question' ? question.questions[0]?.question : undefined).toBe('Deploy where?')

    // Settling both asks returns the latch to the open turn with its working child.
    approvalAbort.abort()
    await expect(deciding).resolves.toBe('cancelled')
    questionAbort.abort()
    await expect(asking).rejects.toThrow()
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'waiting_subagents')
    expect(valueOf(await latchOf(test)).pendingAsks).toEqual([])

    // No open parent turn: idle, while the still-working child keeps the count.
    hold.release()
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'idle')
    const finished = valueOf(await latchOf(test))
    expect(finished).toMatchObject({ activeDescendants: 1, descendantsExact: true })
    expect(finished.lastTurnEnd).toMatchObject({ turn: 1, reason: 'completed' })
    expect(finished.lastParticipantAction).toMatchObject({ action: 'prompt', actor: { kind: 'human', name: 'local' } })
    const missing = await remote.executionState({ sessionId: 'missing' as never })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('session/not-found')

    // Park the child before teardown so its held stream does not linger.
    child.agent.cancel({ kind: 'user' })
    childHold.release()
    await waitFor(() => child.agent.status === 'idle')
  })

  it('does not hold waiting_subagents for a resident but idle child', async () => {
    const test = await harness()
    const { remote, adapter, sessionId } = test
    const hold = adapter.holdNext()
    expect(valueOf(await remote.prompt(promptBody(sessionId, 'parent turn'))).accepted).toBe(true)
    await hold.started

    const { child, hold: childHold } = await startWorkingChild(test, 'exec-state-idle-child', 'child work')
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'waiting_subagents')
    expect(valueOf(await latchOf(test)).activeDescendants).toBe(1)

    // Parking the child returns the parent to running: a resident agent that is
    // no longer working must not pin the latch.
    child.agent.cancel({ kind: 'user' })
    childHold.release()
    await waitFor(() => child.agent.status === 'idle')
    await waitFor(async () => valueOf(await latchOf(test)).latch === 'running', 1_000)
    expect(valueOf(await latchOf(test)).activeDescendants).toBe(0)
    hold.release()
  })
})

describe('session digest', () => {
  it('bounds tool previews, injections, the tree, and pending interactions', async () => {
    const test = await harness()
    const { ctx, adapter, remote, sessionId } = test
    const session = ctx.sessions.get(sessionId)
    expect(session).toBeDefined()
    if (session === undefined) return

    const longArgument = 'x'.repeat(300)
    const longResult = 'y'.repeat(300)
    const callSeq = session.append('tool/call', {
      turn: 1,
      step: 0,
      callId: ToolCallId('call-ok'),
      name: 'probe',
      arguments: longArgument,
    }).seq
    session.append('tool/result', {
      turn: 1,
      step: 0,
      message: createToolResultMessage({
        callId: ToolCallId('call-ok'),
        content: [{ type: 'text', text: longResult }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    session.append('tool/call', {
      turn: 2,
      step: 0,
      callId: ToolCallId('call-running'),
      name: 'slow-tool',
      arguments: '{}',
    })
    session.append('tool/result', {
      turn: 3,
      step: 0,
      message: createToolResultMessage({
        callId: ToolCallId('call-failed'),
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      }),
      error: { name: 'ToolError', code: 'PROBE_FAILED', reason: 'the probe failed' },
    }, { surfaceOp: 'append', sourceEventSeqs: [session.append('tool/call', {
      turn: 3,
      step: 0,
      callId: ToolCallId('call-failed'),
      name: 'failing-tool',
      arguments: '{}',
    }).seq] })
    const injectionSeq = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'i'.repeat(300) }],
      source: {
        kind: 'digest-test',
        form: 'snapshot',
        sections: [{ name: 'runtime-context', text: 'context' }],
      },
    }), { surfaceOp: 'append' }).seq

    // A genuinely working child: its own held turn, its descriptor, and its
    // first prompt, which the tree reports as a running child.
    const { hold: childHold } = await startWorkingChild(test, 'digest-child', 'do the child task')

    const digest = valueOf(await remote.digest({ sessionId, recentTools: 5 }))
    expect(digest.state).toMatchObject({ latch: 'idle', activeDescendants: 1, descendantsExact: true })
    expect(digest.pendingInteractions).toEqual([])

    // Durable pre-commit attempt failures surface as bounded rows (the fork's
    // llm/attempt-failed vocabulary is read defensively, never trusted blindly).
    const sessionForFailures = ctx.sessions.get(sessionId)
    expect(sessionForFailures).toBeDefined()
    appendForkEvent(sessionForFailures, 'llm/attempt-failed', {
      provider: 'primary',
      model: 'big-model',
      code: 'INSUFFICIENT_BALANCE',
      message: 'x'.repeat(400),
      chain: 'scratch',
      link: 1,
      next: { provider: 'fallback', model: 'small-model' },
    })
    appendForkEvent(sessionForFailures, 'llm/attempt-failed', {
      provider: 'fallback',
      model: 'small-model',
      code: 'POOL_EXHAUSTED',
      message: 'no identity left',
      identity: 'p1',
      next: { identity: 'p2' },
    })
    const withFailures = valueOf(await remote.digest({ sessionId, recentTools: 5 }))
    expect(withFailures.recentFailures).toHaveLength(2)
    expect(withFailures.recentFailures[1]).toMatchObject({
      provider: 'primary',
      model: 'big-model',
      code: 'INSUFFICIENT_BALANCE',
      link: 1,
      next: { provider: 'fallback', model: 'small-model' },
    })
    expect(withFailures.recentFailures[1]?.message.length).toBeLessThanOrEqual(200)
    expect(withFailures.recentFailures[0]).toMatchObject({ provider: 'fallback', identity: 'p1' })
    // A `next` that names no provider/model is dropped rather than guessed.
    expect(withFailures.recentFailures[0]?.next).toBeUndefined()

    const ok = digest.recentToolCalls.find(call => call.tool === 'probe')
    expect(ok).toMatchObject({ status: 'ok' })
    expect(ok?.argumentPreview?.endsWith('…')).toBe(true)
    expect(ok?.argumentPreview?.length).toBeLessThanOrEqual(200)
    expect(ok?.resultPreview?.endsWith('…')).toBe(true)
    expect(ok?.resultPreview?.length).toBeLessThanOrEqual(200)

    const failed = digest.recentToolCalls.find(call => call.tool === 'failing-tool')
    expect(failed).toMatchObject({
      status: 'error',
      error: { name: 'ToolError', code: 'PROBE_FAILED', reason: 'the probe failed' },
    })
    expect(digest.recentToolCalls.find(call => call.tool === 'slow-tool')).toMatchObject({ status: 'running' })
    expect(digest.recentToolCalls).toHaveLength(3)

    expect(digest.injectionIndex).toEqual([
      { kind: 'digest-test', label: 'runtime-context', chars: 300, seq: injectionSeq },
    ])
    expect(digest.subagentTree).toEqual([
      {
        childSessionId: 'digest-child',
        mode: 'continuable',
        quiet: true,
        status: 'running',
        queryPreview: 'do the child task',
      },
    ])
    expect(digest.lastParticipantAction).toBeUndefined()

    const capped = valueOf(await remote.digest({ sessionId, recentTools: 1 }))
    expect(capped.recentToolCalls).toHaveLength(1)
    expect(capped.recentToolCalls[0]?.tool).toBe('failing-tool')
    const none = valueOf(await remote.digest({ sessionId, recentTools: 0 }))
    expect(none.recentToolCalls).toEqual([])
    expect((await remote.digest({ sessionId: 'missing' as never, recentTools: 1 })).ok).toBe(false)

    childHold.release()
    void adapter
  })
})

/** Dispatch the user-questions waterfall as the real seam does, with a signal-bound answerer. */
function waterfallQuestion(
  ctx: Context,
  agent: Agent,
  signal: AbortSignal,
  questions: readonly { readonly id: string; readonly question: string }[],
): Promise<unknown> {
  interface QuestionWaterfall {
    waterfall(target: unknown, name: string, request: unknown, fallback: () => Promise<never>): Promise<unknown>
  }
  const waterfall = (ctx as unknown as QuestionWaterfall).waterfall.bind(ctx)
  const fallback = (): Promise<never> => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('question aborted')) }, { once: true })
  })
  return waterfall(scopeTarget(agent, agent), 'user-questions/request', { questions, signal, agent }, fallback)
}
