import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CompactionId,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, createSystemMessage, CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, resolveRetryPolicy , createMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { Session, SessionId, type SessionEvent, type SessionSeq, type SurfaceEvent } from '@deepseek-ai/dsh-session'

/** Summariser route with a window large enough to replay the span it condenses. */
const SUMMARISER_PROVIDER = 'summariser'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'keeper-synthetic': { kind: 'keeper-synthetic' } & ContextFormed
  }
}

/**
 * CBR-001 regression through the real loop. A replacement checkpoint has a high
 * log seq at the surface head and carries no tool pair, so both adjacent cuts
 * must be safe and re-compacting that checkpoint alone must succeed. This pins
 * surface-position semantics rather than raw-log scanning.
 */

/** Records every region the pressure loop actually summarised. */
class GuardProbeEngine extends BasicCompactionEngine {
  readonly regions: Array<{ start: SessionSeq; end: SessionSeq }> = []

  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return {
      summary: [{ type: 'text', text: 'GUARD SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }

  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    this.regions.push({ start, end })
    return super.compactRegion(start, end, agent, signal)
  }
}

class ReproCompactionEngine extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return {
      summary: [{ type: 'text', text: 'CHECKPOINT SUMMARY' }],
      provider: 'mock',
      model: 'stub',
    }
  }
}

/** Each call emits one tool-call until exhausted, then a final text answer. */
class StepwiseToolAdapter extends LlmAdapter {
  calls = 0
  constructor(private toolSteps: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 400 },
    })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const n = this.calls
    this.calls += 1
    if (n < this.toolSteps) {
      const id = ToolCallId(`c${n}`)
      const args = `{"i":${n}}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `step ${n}` } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'work', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'all done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** First conversation request overflows, then the rebuilt retry succeeds. */
class OverflowRecoveryAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'compaction test provider retryPolicy')

  constructor(
    private readonly delivery: 'thrown' | 'in-band',
    private readonly transientAfterOverflow = false,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // The conversation route overflows at 128 tokens; the compaction route is
      // a separate target with room to actually replay the span it condenses.
      context: { contextWindow: provider === SUMMARISER_PROVIDER ? 100_000 : 128 },
    })
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The cache-reusing summarizer replays the conversation prefix and marks
    // its call only by the compaction instruction in the trailing user message.
    const trailing = options.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    if (this.conversationRequests.length === 1) {
      if (this.delivery === 'thrown') {
        throw new LlmError('request too large for model context', CONTEXT_WINDOW_EXCEEDED_CODE)
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'request too large for model context',
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        },
      }
      return
    }
    if (this.transientAfterOverflow && this.conversationRequests.length === 2) {
      throw new LlmError('temporary provider outage', 'SERVER')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

// Small window so several tool steps cross the threshold and compaction fires
// within the runaway turn after enough history can shrink.
const REPRO_COMPACT_CONFIG = {
  auto: true,
  headroomTokens: 0,
  thresholdRatio: 0.5,
  retainTokens: 50,
  maxTokens: 8192,
  compactionRetries: 1,
} as const

async function mountHarness(toolSteps: number): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['mock'], new StepwiseToolAdapter(toolSteps))
  ctx.tools.register(defineContentToolFixture({
    name: 'work',
    description: 'does work',
    parameters: { i: { type: 'number' } },
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  return ctx
}

async function harness(toolSteps: number): Promise<{ ctx: Context; compact: ReproCompactionEngine }> {
  const ctx = await mountHarness(toolSteps)
  const compact = new ReproCompactionEngine(ctx, { ...REPRO_COMPACT_CONFIG })
  return { ctx, compact }
}

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

function overflowHistorySeed(): readonly SessionEvent[] {
  const session = Session.create(SessionId('overflow-history-seed'))
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    session.append('turn/start', {
      turn,
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${sentinel} ${'old context '.repeat(200)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail '.repeat(200)}` }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return session.snapshotEvents()
}

describe('CBR-001: a real-loop checkpoint is a valid boundary on both sides', () => {
  it('uses the model actually routed by agent/request for post-step pressure', async () => {
    const { ctx } = await harness(8)
    ctx.on('agent/request', async (_payload, next) => ({
      ...await next(), provider: 'mock', model: 'mock',
    }))
    try {
      const agent = await ctx.agentLoop.create(SessionId('routed-pressure'), {
        provider: 'unconfigured-agent-fallback',
        model: 'unconfigured-agent-fallback',
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do a routed multi-step task' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(agent.session.requestHeader()?.config.model).toBe('mock')
      expect(agent.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs automatic pressure between the completed tool step and the next step', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = await ctx.agentLoop.create(SessionId('post-step-order'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do tool work' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const events = agent.session.snapshotEvents()
      const compactStart = events.find(event => event.type === 'compaction/start')
      expect(compactStart).toBeDefined()
      const precedingResult = events.findLast(event =>
        event.type === 'tool/result' && event.seq < compactStart!.seq,
      )
      if (precedingResult?.type !== 'tool/result') throw new Error('expected a durable tool result before compaction')
      const precedingStepEnd = events.find(event =>
        event.type === 'step/end'
        && event.data.step === precedingResult.data.step
        && event.seq > precedingResult.seq,
      )
      const nextStepStart = events.find(event =>
        event.type === 'step/start'
        && event.data.step === precedingResult.data.step + 1
        && event.seq > compactStart!.seq,
      )
      expect(precedingResult.seq).toBeLessThan(compactStart!.seq)
      expect(precedingStepEnd!.seq).toBeLessThan(compactStart!.seq)
      expect(compactStart!.seq).toBeLessThan(nextStepStart!.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a checkpoint-only or non-relieving retry and warns once with the priced numbers', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const ctx = await mountHarness(8)
    try {
      const engine = new GuardProbeEngine(ctx, { ...REPRO_COMPACT_CONFIG })
      const agent = await ctx.agentLoop.create(SessionId('no-relief'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do a long multi-step task' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const events = agent.session.snapshotEvents()
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      const warned = stderr.mock.calls
        .map(call => String(call[0]))
        .filter(line => line.includes('cannot relieve pressure'))
      expect(warned.length).toBeGreaterThan(0)
      expect(warned[0]).toContain('surface')
      expect(warned[0]).toContain('threshold')
      expect(engine.regions.length).toBeGreaterThan(0)
      // No summary ever targeted a checkpoint-only range: re-summarising a
      // replacement is the compounding-loss case the guard exists for.
      for (const region of engine.regions) {
        const nodes = agent.session.surface.nodes.filter(seq => seq >= region.start && seq <= region.end)
        const checkpointOnly = nodes.length > 0 && nodes.every((seq) => {
          const event = agent.session.eventAt(seq)
          if (event?.type !== 'user/message') return false
          const op = event.surfaceOp
          return typeof op === 'object' && op !== null && op.op === 'replace'
        })
        expect(checkpointOnly, `region ${region.start}-${region.end} must not be checkpoint-only`).toBe(false)
      }
    } finally {
      stderr.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('the head checkpoint the loop lands is a balanced cut on both sides', async () => {
    const { ctx } = await harness(8)
    try {
      const agent = await ctx.agentLoop.create(SessionId('repro'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do a long multi-step task' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const events = agent.session.snapshotEvents()
      // A compaction ran: at least one checkpoint landed on the surface.
      const checkpoints = events.filter(
        (e): e is SurfaceEvent =>
          e.type === 'user/message'
          && typeof (e as SurfaceEvent).surfaceOp === 'object',
      )
      expect(checkpoints.length).toBeGreaterThan(0)

      // High log position does not make a text-only checkpoint mid-step; both
      // its start and end cuts are balanced in surface order.
      const nodes = agent.session.surface.nodes
      for (const cp of checkpoints) {
        const index = nodes.indexOf(cp.seq)
        if (index === -1) continue // shadowed by a later checkpoint — no longer an edge.
        expect(toolPairingBalancedBefore(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region START`).toBe(true)
        expect(toolPairingBalancedAfter(agent.session, cp.seq),
          `checkpoint seq ${cp.seq} must be a balanced region END`).toBe(true)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/** Route used by the direct pressure/checkpoint regressions below. */
const PRESSURE_PROVIDER = 'pressure'
const PRESSURE_MODEL = 'model'
const PRESSURE_TARGET_PROVIDER = 'pressure-target'
const WIDE_PROVIDER = 'pressure-wide'
const PRESSURE_SIGNAL = new AbortController().signal

/** Declares the routed window the pressure policy scales against. */
class PressureWindowAdapter extends LlmAdapter {
  constructor(private readonly contextWindow = 4_000) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Scripted summary hook that counts paid attempts and records its exact replay input. */
class CircuitProbeEngine extends BasicCompactionEngine {
  calls = 0
  error: unknown
  /** Calls that throw `error`; defaults to every call so the circuit fixtures stay fail-all. */
  failureCalls = Number.MAX_SAFE_INTEGER
  summaryText = 'SMALL SUMMARY'
  summaryBlocks: ContentBlock[] | undefined
  windowClipped = false
  readonly inputs: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<SummaryResult> {
    this.calls += 1
    this.inputs.push(input)
    if (this.error !== undefined && this.calls <= this.failureCalls) throw this.error
    return {
      summary: this.summaryBlocks ?? [{ type: 'text', text: this.summaryText }],
      provider: 'mock',
      model: 'stub',
      ...this.windowClipped ? { windowClipped: true } : {},
    }
  }
}

/** A large tool schema makes the routed envelope dominate the removable range. */
function bulkTools(): { name: string; description: string; parameters: { type: 'object' } }[] {
  return [{ name: 'bulk', description: 'x'.repeat(12_000), parameters: { type: 'object' } }]
}

/**
 * Open-turn session whose removable head is one tiny user message and whose
 * retained tail is large: removing the whole selected range still leaves the
 * envelope plus tail above the configured threshold.
 * @param id - session identity for the replay.
 * @param provider - routed provider named by the request header.
 * @returns the open-turn session.
 */
function pressureSession(id: string, provider = PRESSURE_PROVIDER): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider, model: PRESSURE_MODEL }, tools: bulkTools() },
    reason: 'initial',
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'tiny context' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'history '.repeat(1_000) }],
      source: { kind: 'model', provider, model: PRESSURE_MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'tail note' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session
}

/**
 * Open-turn session whose only compactable head is a prior model checkpoint and
 * whose retained tail keeps the removable proof small enough to be checkpoint-only.
 * @param id - session identity for the replay.
 * @param provider - routed provider named by the request header.
 * @returns the open-turn session after its seeded checkpoint is replaced.
 */
function checkpointHeadSession(id: string, provider = WIDE_PROVIDER): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider, model: PRESSURE_MODEL }, tools: bulkTools() },
    reason: 'initial',
  })
  for (let step = 1; step <= 2; step += 1) {
    session.append('step/start', { turn: 1, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `old request ${step} `.repeat(40) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `old answer ${step} `.repeat(40) }],
        source: { kind: 'model', provider, model: PRESSURE_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  session.append('step/start', { turn: 1, step: 3 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 3,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'retained tail '.repeat(1_000) }],
      source: { kind: 'model', provider, model: PRESSURE_MODEL },
    }),
  }, { surfaceOp: 'append' })
  return session
}

/**
 * Land one durable model-written checkpoint over an inclusive surface span
 * without paying a summarizer call.
 * @param session - open-turn session whose surface is replaced.
 * @param shadowedSeqs - contiguous surface seqs the checkpoint replaces.
 * @param text - exact summary text the checkpoint carries.
 * @returns the surface seq of the new checkpoint.
 */
function appendSeedCheckpoint(
  session: Session,
  shadowedSeqs: readonly SessionSeq[],
  text: string,
  route: { readonly provider: string; readonly model: string } = {
    provider: 'prior-provider',
    model: 'prior-model',
  },
): SessionSeq {
  const compactionId = CompactionId(`seed-${shadowedSeqs[0]}`)
  const startEvent = session.append('compaction/start', { compactionId, turn: 1 })
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text }],
    shadowedRange: { start: shadowedSeqs[0]!, end: shadowedSeqs.at(-1)! },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount: 0,
    provider: route.provider,
    model: route.model,
  })
  const checkpoint = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(compactionId),
  }), {
    surfaceOp: { op: 'replace', startSeq: shadowedSeqs[0]!, endSeq: shadowedSeqs.at(-1)! },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  session.append('compaction/end', { compactionId, turn: 1 })
  return checkpoint.seq
}

/** Open-turn session with enough ordinary steps for a complete compaction lifecycle. */
/**
 * Open-turn session with a preserved head checkpoint, ordinary droppable
 * history, and a small retained tail. After a one-shot summary failure the
 * deterministic fallback leaves pressure above threshold while the reselected
 * range (checkpoint plus its droppable suffix) can still relieve by summary.
 * @param id - session identity for the replay.
 * @returns the open-turn session with its seeded checkpoint.
 */
function retryReliefSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL } },
    reason: 'initial',
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'seed request '.repeat(40) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed answer '.repeat(40) }],
      source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  appendSeedCheckpoint(
    session,
    session.surface.nodes.slice(0, 2),
    'PRIOR CHECKPOINT '.repeat(300),
  )
  for (let step = 2; step <= 4; step += 1) {
    session.append('step/start', { turn: 1, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'droppable request '.repeat(100) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'droppable answer '.repeat(100) }],
        source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  session.append('step/start', { turn: 1, step: 5 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 5,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'retained tail '.repeat(20) }],
      source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
    }),
  }, { surfaceOp: 'append' })
  return session
}

/** Open-turn session with enough ordinary steps for a complete compaction lifecycle. */
function completenessSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', {
    header: { config: { provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL } },
    reason: 'initial',
  })
  for (let step = 1; step <= 4; step += 1) {
    session.append('step/start', { turn: 1, step })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `old request ${step} `.repeat(200) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `old answer ${step} `.repeat(200) }],
        source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  return session
}
function pressureAgent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function circuitEngine(ctx: Context, config: BasicCompactionConfig = {}): CircuitProbeEngine {
  return new CircuitProbeEngine(ctx, {
    auto: false,
    headroomTokens: 0,
    maxTokens: 8192,
    thresholdRatio: 0.5,
    retainTokens: 100,
    compactionRetries: 1,
    ...config,
  })
}

async function pressureHarness(): Promise<Context> {
  const ctx = await mountHarness(0)
  ctx.llm.registerAdapter(
    [PRESSURE_PROVIDER, PRESSURE_TARGET_PROVIDER],
    new PressureWindowAdapter(4_000),
  )
  ctx.llm.registerAdapter([WIDE_PROVIDER], new PressureWindowAdapter(100_000))
  return ctx
}

function checkPressure(
  engine: BasicCompactionEngine,
  session: Session,
  trigger: 'pressure' | 'context-overflow' = 'pressure',
): Promise<CompactionResult | null> {
  return engine.compactIfNeeded(pressureAgent(session), trigger, PRESSURE_SIGNAL)
}

/** Checkpoint replacement messages currently live on the surface, in order. */
function surfaceCheckpoints(session: Session): SessionEvent<'user/message'>[] {
  const nodes = new Set(session.surface.nodes)
  return session.snapshotEvents().filter((event): event is SessionEvent<'user/message'> => (
    event.type === 'user/message'
    && nodes.has(event.seq)
    && event.data.source?.kind === 'compact-checkpoint'
  ))
}

function checkpointText(event: SessionEvent<'user/message'>): string {
  return event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** Sum the priced contribution of the exact seqs the result replaced. */
function pricedTokens(
  measurement: ReturnType<Context['tokenMeter']['measure']>,
  seqs: readonly SessionSeq[],
  field: 'tokens' | 'heuristicTokens',
): number {
  const prices = new Map(measurement.nodes.map(node => [node.seq, node[field]]))
  return seqs.reduce((total, seq) => total + (prices.get(seq) ?? 0), 0)
}

describe('pressure non-relief summary-attempt circuit', () => {
  it('suppresses the next paid summary for an unchanged non-relieving range', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-unchanged')
      const before = [...session.surface.nodes]

      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)
      expect(session.surface.nodes).toEqual(before)

      expect(await checkPressure(engine, session)).toBeNull()
      expect(engine.calls).toBe(1)
      expect(session.surface.nodes).toEqual(before)
      expect(stderr.mock.calls.map(call => String(call[0]))
        .filter(line => line.includes('cannot relieve pressure')).length).toBeGreaterThan(0)
    } finally {
      stderr.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('runs a new selected range after a checkpoint-only proof', async () => {
    const ctx = await pressureHarness()
    try {
      const session = checkpointHeadSession('circuit-new-range')
      const checkpointSeq = appendSeedCheckpoint(
        session,
        session.surface.nodes.slice(0, 4),
        'PRIOR CHECKPOINT '.repeat(20),
      )

      const measured = ctx.tokenMeter.measure(session)
      const range = selectCompactableRange(session, measured, 100, { count: 0, maxTokens: 0 })
      expect(range).toEqual({ start: checkpointSeq, end: checkpointSeq })
      const rangeTokens = pricedTokens(measured, [checkpointSeq], 'tokens')
      const projected = measured.totalTokens - rangeTokens
      const threshold = projected + Math.max(1, Math.floor((measured.totalTokens - projected) / 2))
      const engine = circuitEngine(ctx, { thresholdRatio: threshold / 100_000 })

      // The only removable node is the prior checkpoint: the cheap pass proves
      // a summary cannot relieve and records the proof without paying.
      expect(await checkPressure(engine, session)).toBeNull()
      expect(engine.calls).toBe(0)

      // A new plain-content range at the same position is materially different
      // and can relieve, so the circuit must clear and the paid call must run.
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'LIVE CONTENT '.repeat(40) }],
        source: { kind: 'user' },
      }), {
        surfaceOp: { op: 'replace', startSeq: checkpointSeq, endSeq: checkpointSeq },
        sourceEventSeqs: [checkpointSeq],
      })
      const result = await checkPressure(engine, session)
      expect(result).not.toBeNull()
      expect(engine.calls).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('always attempts context-overflow recovery while the pressure proof stands', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-overflow')
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)

      engine.error = undefined
      const result = await checkPressure(engine, session, 'context-overflow')
      expect(result).not.toBeNull()
      expect(engine.calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the proof on a routed target change', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-target')
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)

      session.append('request/header', {
        header: {
          config: { provider: PRESSURE_TARGET_PROVIDER, model: PRESSURE_MODEL },
          tools: bulkTools(),
        },
        reason: 'resume',
      })
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the proof on a compaction configuration change', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-config')
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)

      ctx.reflect.provide('settings', {
        describe: () => [{
          ns: 'enpoi-orchestration',
          value: { parameters: { compaction: { thresholdRatio: 0.4 } } },
        }],
      })
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the proof on an explicit manual compaction request', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-manual')
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)

      // A synchronous admission refusal is wrapped as `busy`; a rejected
      // promise would escape `compactNow`'s wrapper by design.
      const busy = {
        session,
        options: {},
        runMaintenance: (): never => { throw new Error('busy') },
      } as unknown as Agent
      expect(() => engine.compactNow(busy, PRESSURE_SIGNAL)).toThrow(/requires an idle agent/)

      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('clears the proof when measurement falls below the pressure threshold', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('summary unavailable')
      const session = pressureSession('circuit-below-threshold')
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)

      // Drop both the bulk tool schema and the surface bulk so the same
      // measure/select pass lands below the threshold.
      const historySeq = session.surface.nodes[1]!
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'small history' }],
        source: { kind: 'user' },
      }), {
        surfaceOp: { op: 'replace', startSeq: historySeq, endSeq: historySeq },
        sourceEventSeqs: [historySeq],
      })
      session.append('request/header', {
        header: { config: { provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL } },
        reason: 'resume',
      })
      expect(await checkPressure(engine, session)).toBeNull()
      expect(engine.calls).toBe(1)

      // Restoring pressure must pay again: the below-threshold measurement
      // cleared the proof instead of letting it outlive the range it described.
      session.append('assistant/message', {
        stream: [],
        turn: 1,
        step: 2,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'history '.repeat(1_000) }],
          source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('request/header', {
        header: {
          config: { provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
          tools: bulkTools(),
        },
        reason: 'resume',
      })
      await expect(checkPressure(engine, session)).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retries a second summary when the reselected range can relieve', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.error = new Error('one-shot summary failure')
      engine.failureCalls = 1
      engine.summaryText = 'SECOND SUMMARY'
      const session = retryReliefSession('retry-relief')
      const result = await checkPressure(engine, session)

      // The first selection paid and failed; its mechanical fallback changed
      // the surface. The reselected range (preserved checkpoint plus its suffix)
      // can relieve, so attempt > 0 must pay again instead of stopping merely
      // because it is the second attempt.
      expect(result).not.toBeNull()
      expect(engine.calls).toBe(2)
      const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
      expect(summaries.map(event => event.type === 'compaction/summary' ? event.data.provider : '')
        .slice(-2)).toEqual(['', 'mock'])
      expect(surfaceCheckpoints(session)).toHaveLength(1)
      expect(checkpointText(surfaceCheckpoints(session)[0]!)).toContain('SECOND SUMMARY')
    } finally {
      stderr.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})

describe('checkpoint completeness and mechanical omission safety', () => {
  it('retains one authoritative summary plus one marker and merges repeated omissions', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryText = 'PRIOR AUTHORITATIVE SUMMARY TEXT — durable context marker.'
      const session = completenessSession('checkpoint-completeness')
      const seedNodes = session.surface.nodes
      await engine.compactRegion(seedNodes[0]!, seedNodes[3]!, pressureAgent(session))
      const priorSeq = session.surface.nodes[0]!
      expect(surfaceCheckpoints(session)).toHaveLength(1)
      expect(checkpointText(surfaceCheckpoints(session)[0]!)).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')

      const before = ctx.tokenMeter.measure(session)
      engine.error = new Error('summary unavailable')
      const firstFailureNodes = session.surface.nodes
      const mechanical = await engine.compactRegion(
        firstFailureNodes[0]!,
        firstFailureNodes.at(-1)!,
        pressureAgent(session),
      )
      // The authoritative summary is outside the replaced range and stays live.
      expect(mechanical.shadowedSeqs).not.toContain(priorSeq)
      expect(mechanical.shadowedTokenCount).toBe(pricedTokens(before, mechanical.shadowedSeqs, 'heuristicTokens'))
      let checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints[0]!)).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')
      expect(checkpointText(checkpoints[1]!)).toContain('omission notice')
      const markerPrice = ctx.tokenMeter.estimateMessage(checkpoints[1]!.data)
      expect(markerPrice).toBeLessThan(pricedTokens(before, mechanical.shadowedSeqs, 'tokens'))
      const firstMarkerText = checkpointText(checkpoints[1]!)
      const firstRange = firstMarkerText.match(/Removed surface seqs (\d+)–(\d+)/)

      // A second mechanical pass replaces the prior marker, not the summary,
      // and carries the first notice's omitted range into the new text.
      const repeatNodes = session.surface.nodes
      await engine.compactRegion(repeatNodes[0]!, repeatNodes.at(-1)!, pressureAgent(session))
      checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints[0]!)).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')
      expect(checkpointText(checkpoints[1]!)).toContain('omission notice')
      expect(checkpointText(checkpoints[1]!))
        .toContain(`Earlier omitted surface seqs: ${firstRange?.[1]}–${firstRange?.[2]}`)
      const mergedMarkerSources = session.eventAt(checkpoints[1]!.seq)?.sourceEventSeqs ?? []
      const mechanicalSummaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary'
        && event.data.provider === '')
      expect(mergedMarkerSources).toEqual(expect.arrayContaining(mechanicalSummaries.map(event => event.seq)))

      // A successful model summary sees both texts and replaces both with one.
      engine.error = undefined
      engine.summaryText = 'MERGED SUMMARY'
      const mergeNodes = session.surface.nodes
      await engine.compactRegion(mergeNodes[0]!, mergeNodes.at(-1)!, pressureAgent(session))
      const replay = engine.inputs.at(-1)!.messages
        .flatMap(message => message.content)
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
      expect(replay).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')
      expect(replay).toContain('omission notice')
      checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(1)
      expect(checkpointText(checkpoints[0]!)).toContain('MERGED SUMMARY')
      const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
      expect(summaries.filter(event => event.type === 'compaction/summary'
        && event.data.provider.length > 0)).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a mechanical replacement over a checkpoint-only selection', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      const session = checkpointHeadSession('checkpoint-only-mechanical')
      const checkpointSeq = appendSeedCheckpoint(
        session,
        session.surface.nodes.slice(0, 4),
        'ONLY CHECKPOINT',
      )
      const before = [...session.surface.nodes]
      engine.error = new Error('summary unavailable')

      await expect(engine.compactRegion(
        checkpointSeq,
        checkpointSeq,
        pressureAgent(session),
      )).rejects.toThrow(/summary unavailable/)
      expect(engine.calls).toBe(1)
      expect(session.surface.nodes).toEqual(before)
      expect(surfaceCheckpoints(session)).toHaveLength(1)
      expect(session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data)
        .toHaveProperty('error')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a checkpoint that bounds the removable run inside the span', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryText = 'PRIOR AUTHORITATIVE SUMMARY TEXT'
      const session = completenessSession('checkpoint-mid-span')
      const seedNodes = session.surface.nodes
      const checkpointSeq = appendSeedCheckpoint(
        session,
        seedNodes.slice(2, 6),
        'MID SPAN CHECKPOINT',
      )
      const retainedSeq = session.surface.nodes.at(-1)!

      engine.error = new Error('summary unavailable')
      const surface = session.surface.nodes
      const result = await engine.compactRegion(
        surface[0]!,
        surface.at(-1)!,
        pressureAgent(session),
      )
      // The mid-span checkpoint bounds the removable run: it and the newer
      // content after it stay live while only the older run is replaced.
      expect(result.shadowedSeqs).not.toContain(checkpointSeq)
      expect(session.surface.nodes).toContain(checkpointSeq)
      expect(session.surface.nodes).toContain(retainedSeq)
      const checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints.find(event => event.seq === checkpointSeq)!))
        .toContain('MID SPAN CHECKPOINT')
      expect(checkpointText(checkpoints.find(event => event.seq !== checkpointSeq)!))
        .toContain('omission notice')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('preserves an unclassifiable custom checkpoint with no route or failure', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      const session = completenessSession('checkpoint-custom')
      const seedNodes = session.surface.nodes
      const checkpointSeq = appendSeedCheckpoint(
        session,
        seedNodes.slice(0, 4),
        'CUSTOM CHECKPOINT TEXT',
        { provider: '', model: '' },
      )

      engine.error = new Error('summary unavailable')
      const surface = session.surface.nodes
      const result = await engine.compactRegion(
        surface[0]!,
        surface.at(-1)!,
        pressureAgent(session),
      )
      // A custom summarizer that names no route is not classifiably mechanical:
      // keep its exact text rather than replacing it with an omission stub.
      expect(result.shadowedSeqs).not.toContain(checkpointSeq)
      const checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints.find(event => event.seq === checkpointSeq)!))
        .toContain('CUSTOM CHECKPOINT TEXT')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never shrinks a frame past a prior model summary into a second authoritative one', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryText = 'PRIOR AUTHORITATIVE SUMMARY TEXT'
      const session = completenessSession('checkpoint-shrink')
      const seedNodes = session.surface.nodes
      await engine.compactRegion(seedNodes[0]!, seedNodes[3]!, pressureAgent(session))
      const priorSeq = session.surface.nodes[0]!

      engine.error = new LlmError('request too large for model context', 'INVALID_REQUEST')
      const nodes = session.surface.nodes
      const result = await engine.compactRegion(
        nodes[0]!,
        nodes.at(-1)!,
        pressureAgent(session),
      )
      // The size refusal cannot shrink below the prior checkpoint: the same
      // prepared span goes to the mechanical suffix fallback, not a second
      // authoritative summary.
      expect(result.shadowedSeqs).not.toContain(priorSeq)
      expect(engine.calls).toBe(2)
      const checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints[0]!)).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')
      expect(checkpointText(checkpoints[1]!)).toContain('omission notice')
      const summaries = session.snapshotEvents().filter(event => event.type === 'compaction/summary')
      const authoritative = summaries.filter(event => event.type === 'compaction/summary'
        && event.data.provider.length > 0)
      expect(authoritative).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the mechanical suffix when a window clip excludes a prior summary', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryText = 'PRIOR AUTHORITATIVE SUMMARY TEXT'
      const session = completenessSession('checkpoint-window-clip')
      const seedNodes = session.surface.nodes
      await engine.compactRegion(seedNodes[0]!, seedNodes[3]!, pressureAgent(session))

      engine.windowClipped = true
      engine.summaryText = 'CLIPPED SUMMARY'
      const nodes = session.surface.nodes
      const result = await engine.compactRegion(
        nodes[0]!,
        nodes.at(-1)!,
        pressureAgent(session),
      )
      expect(result.shadowedSeqs).not.toContain(nodes[0]!)
      const checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(2)
      expect(checkpointText(checkpoints[0]!)).toContain('PRIOR AUTHORITATIVE SUMMARY TEXT')
      expect(checkpointText(checkpoints[1]!)).toContain('omission notice')
      expect(session.snapshotEvents().findLast(event => event.type === 'compaction/summary')?.data)
        .toMatchObject({ provider: '', model: '', summarizationFailure: { code: 'PriorCheckpointUnreplayedError' } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([
    ['empty', [] as ContentBlock[]],
    ['whitespace-only', [{ type: 'text', text: '  \n\t ' }] as ContentBlock[]],
    ['image-only', [{
      type: 'image',
      attachment: {
        attachmentId: `sha256:${'c'.repeat(64)}` as never,
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    }] as ContentBlock[]],
  ])('records a mechanical omission instead of an authoritative checkpoint for an %s summary', async (_label, blocks) => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryBlocks = blocks
      const session = completenessSession(`empty-summary-${_label}`)
      const nodes = session.surface.nodes

      const result = await engine.compactRegion(nodes[0]!, nodes.at(-1)!, pressureAgent(session))

      expect(result.summary).toHaveLength(1)
      expect(result.summary[0]?.type === 'text' ? result.summary[0].text : '')
        .toContain('Mechanical fallback')
      const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
      expect(summary?.data).toMatchObject({
        provider: '',
        model: '',
        summarizationFailure: { code: 'EmptySummaryContentError' },
      })
      const checkpoints = surfaceCheckpoints(session)
      expect(checkpoints).toHaveLength(1)
      expect(checkpointText(checkpoints[0]!)).toContain('omission notice')
      expect(checkpointText(checkpoints[0]!)).not.toContain('<compacted-summary>')
      expect(engine.calls).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails a manual compaction loudly when the custom summary has no text', async () => {
    const ctx = await pressureHarness()
    try {
      const engine = circuitEngine(ctx)
      engine.summaryBlocks = []
      const session = completenessSession('manual-empty-summary')
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const before = [...session.surface.nodes]
      const signal = new AbortController().signal
      const agent = {
        session,
        options: {},
        runMaintenance: <T>(task: (taskSignal: AbortSignal) => Promise<T>): Promise<T> => task(signal),
      } as unknown as Agent

      const failure = await engine.compactNow(agent, signal).then(
        () => { throw new Error('manual compaction unexpectedly committed') },
        (error: unknown) => error as { code?: string; cause?: unknown },
      )
      expect(failure.code).toBe('summary')
      expect(session.surface.nodes).toEqual(before)
      expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
      const end = session.snapshotEvents().findLast(event => event.type === 'compaction/end')
      expect(end?.type === 'compaction/end' ? end.data.error : '').toContain('no nonempty text summary content')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('leading pin selection', () => {
  it('pins the real human prompt after a synthetic keeper message without spending the pin slot on it', async () => {
    const ctx = await pressureHarness()
    try {
      const session = Session.create(SessionId('pin-keeper-head'))
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      const keeper = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'KEEPER RUNTIME CONTEXT' }],
        source: { kind: 'keeper-synthetic' },
      }), { surfaceOp: 'append' })
      const human = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'HUMAN TASK BRIEF' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const assistant = session.append('assistant/message', {
        stream: [],
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'answer '.repeat(20) }],
          source: { kind: 'model', provider: PRESSURE_PROVIDER, model: PRESSURE_MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'tail note' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })

      const measurement = ctx.tokenMeter.measure(session)
      const unpinned = selectCompactableRange(session, measurement, 0, { count: 0, maxTokens: 10_000 })
      expect(unpinned).toEqual({ start: keeper.seq, end: assistant.seq })
      // The synthetic head stays verbatim, the human prompt consumes the one
      // configured slot, and the range starts at the first non-pinned node.
      const pinned = selectCompactableRange(session, measurement, 0, { count: 1, maxTokens: 10_000 })
      expect(pinned).toEqual({ start: assistant.seq, end: assistant.seq })
      expect(assistant.seq).toBeGreaterThan(human.seq)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('token pressure after loop-admitted system prompts', () => {
  it.each([false, true])('counts initial and replaced prompts once with retry=%s', async (retry) => {
    const ctx = new Context()
    const requests: GenerateOptions[] = []
    const usage = { inputTokens: 1000, cacheReadTokens: 100, outputTokens: 10 }
    const adapter = new class extends StepwiseToolAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(options)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
        yield { type: 'usage', usage }
        yield retry && requests.length === 1
          ? { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry me' } } }
          : { type: 'finish', reason: { kind: 'stop' } }
      }
    }(0)
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      ctx.llm.registerAdapter(['mock'], adapter)
      let prompt = 'initial guidance '.repeat(8)
      ctx.systemPrompt.section({ name: 'meter-test', order: 0, complete: true, text: () => prompt })
      ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: 0.5 }))
      ctx.on('agent/request-error', async ({ agent, turn, step }, next) => {
        const action = await next()
        if (action !== undefined) return action
        const node = agent.session.surface.nodes[0]!
        agent.session.append('system/message', {
          turn,
          step,
          message: createSystemMessage('retry guidance'),
        }, { surfaceOp: { op: 'replace', startSeq: node, endSeq: node }, sourceEventSeqs: [node] })
        return { kind: 'retry' }
      })
      const agent = await ctx.agentLoop.create(SessionId('prompt-pressure'), { provider: 'mock', model: 'mock' })
      // Eager replay must observe the same anchor as a fresh reader of the finished log.
      ctx.tokenMeter.measure(agent.session)
      for (const nextPrompt of [prompt, 'expanded guidance '.repeat(20), 'short', '']) {
        prompt = nextPrompt
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'question' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
          type: 'turn/end', data: { reason: { kind: 'completed' } },
        })
        const measured = ctx.tokenMeter.measure(agent.session)
        expect(measured.baseline).toEqual({ kind: 'usage', tokens: 1110, usage })
        expect(measured.surfaceDeltaTokens).toBe(0)
        expect(measured.totalTokens).toBe(1110)
        const replay = Session.create(SessionId('prompt-pressure-replay'), agent.session.snapshotEvents())
        expect(ctx.tokenMeter.measure(replay)).toMatchObject({
          baseline: measured.baseline, surfaceDeltaTokens: 0, totalTokens: 1110, nodes: measured.nodes,
        })
      }
      const events = agent.session.snapshotEvents()
      const prompts = events.filter(event => event.type === 'system/message')
      expect(prompts[0]?.surfaceOp).toBe('append')
      expect(prompts.slice(1).every(event => typeof event.surfaceOp === 'object')).toBe(true)
      for (const event of prompts) {
        expect(events.find(start => start.type === 'step/start'
          && start.data.turn === event.data.turn && start.data.step === event.data.step)?.seq)
          .toBeLessThan(event.seq)
      }
      expect(requests).toHaveLength(retry ? 5 : 4)
      expect(requests.every(request => request.temperature === 0.5)).toBe(true)
      expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(retry ? 1 : 0)
      expect(events.filter(event => event.type === 'step/start')).toHaveLength(4)
      expect(requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'initial guidance '.repeat(8) }])
      if (retry) expect(requests[1]?.messages[0]?.content).toEqual(requests[0]?.messages[0]?.content)
      expect(requests.at(-1)?.messages.some(message => message.role === 'system')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('context-overflow recovery across the real loop and compaction-basic', () => {
  it.each(['thrown', 'in-band'] as const)(
    'force-compacts a %s overflow within the retried step',
    async (delivery) => {
      const ctx = new Context()
      const adapter = new OverflowRecoveryAdapter(delivery)
      await mountAgentLoopTestDependencies(ctx)
      await mountInvariants(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(TokenMeter)
      ctx.llm.registerAdapter(['mock', SUMMARISER_PROVIDER], adapter)
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(), provider: 'mock', model: 'mock',
      }))
      await ctx.plugin(BasicCompactionEngine, {
        headroomTokens: 0,
        thresholdRatio: 1,
        retainTokens: 100,
        maxTokens: 64,
        compactionRetries: 0,
        maxOverflowRetries: 1,
        summarizationProvider: SUMMARISER_PROVIDER,
        summarizationModel: 'mock',
      })

      try {
        const { agent } = await ctx.agentLoop.createAgent(ctx, {
          sessionId: SessionId(`overflow-${delivery}`),
          seed: overflowHistorySeed(),
          agentOptions: {
            provider: 'unconfigured-agent-fallback',
            model: 'unconfigured-agent-fallback',
          },
        })

        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue from history' }], source: { kind: 'user' } }))
        await agent.whenIdle()

        expect(adapter.conversationRequests).toHaveLength(2)
        expect(adapter.summaryRequests).toHaveLength(1)
        const instruction = adapter.summaryRequests[0]!.messages.at(-1)?.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('') ?? ''
        expect(instruction).toContain('Write concise English engineering prose.')
        expect(instruction).toContain('numeric values, function signatures, and syntax fragments.')
        expect(JSON.stringify(adapter.conversationRequests[0]!.messages)).toContain('OLD HISTORY SENTINEL')
        const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
        expect(retry).toContain('RECOVERY CHECKPOINT')
        expect(retry).not.toContain('OLD HISTORY SENTINEL')

        const events = agent.session.snapshotEvents()
        const stepStart = events.find(event =>
          event.type === 'step/start' && event.data.turn === 3 && event.data.step === 1,
        )!
        const stepEnd = events.find(event =>
          event.type === 'step/end' && event.data.turn === 3 && event.data.step === 1,
        )!
        const compaction = events.filter(event =>
          event.type === 'compaction/start'
          || event.type === 'compaction/summary'
          || event.type === 'compaction/end',
        )
        expect(compaction.map(event => event.type)).toEqual([
          'compaction/start',
          'compaction/summary',
          'compaction/end',
        ])
        expect(compaction.every(event =>
          event.seq > stepStart.seq && event.seq < stepEnd.seq,
        )).toBe(true)
        expect(events.filter(event => event.type === 'turn/start').slice(-1).map(event => event.data.turn))
          .toEqual([3])
        expect(events.filter(event => event.type === 'step/start' && event.data.turn === 3))
          .toHaveLength(1)
        expect(events.at(-1)).toMatchObject({
          type: 'turn/end',
          data: { reason: { kind: 'completed' } },
        })
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('keeps context-overflow and transient retry budgets independent in one sequence', async () => {
    const ctx = new Context()
    const adapter = new OverflowRecoveryAdapter('thrown', true)
    await mountAgentLoopTestDependencies(ctx)
    await mountInvariants(ctx)
    await ctx.plugin(LlmRetry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    ctx.llm.registerAdapter(['mock', SUMMARISER_PROVIDER], adapter)
    await ctx.plugin(BasicCompactionEngine, {
      headroomTokens: 0,
      thresholdRatio: 1,
      retainTokens: 100,
      maxTokens: 64,
      compactionRetries: 0,
      maxOverflowRetries: 1,
      summarizationProvider: SUMMARISER_PROVIDER,
      summarizationModel: 'mock',
    })

    try {
      const { agent } = await ctx.agentLoop.createAgent(ctx, {
        sessionId: SessionId('alternating-recovery'),
        seed: overflowHistorySeed(),
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue from history' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.conversationRequests).toHaveLength(3)
      expect(adapter.summaryRequests).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data))
        .toEqual([expect.objectContaining({
          turn: 3,
          step: 1,
          retry: 1,
          failure: { message: 'temporary provider outage', code: 'SERVER', provider: 'mock', model: 'mock' },
        })])
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start').slice(-1).map(event => event.data.turn))
        .toEqual([3])
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
