import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, MODEL_CHAIN_EXHAUSTED_CODE, POLICY_REFUSAL_CODE, ProviderRequestId, expandAssistantStream, resolveRetryPolicy  } from '@deepseek-ai/dsh-llm'
import type {
  AlwaysRetryPolicyConfig,
  BackoffConfig,
  GenerateOptions,
  ModelChainResolver,
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmRetryEventData } from '@deepseek-ai/dsh-llm-retry/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as retry from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

it('keeps the browser-safe retry payload identical to the session event', () => {
  expectTypeOf<LlmRetryEventData>().toEqualTypeOf<SessionEventMap['llm/retry']>()
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('retry test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `retry test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

async function* partialToolFailure(error: Error): AsyncGenerator<StreamChunk> {
  const id = ToolCallId('discarded-call')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'discarded partial output' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'discarded partial output' } }
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id, name: 'danger', argumentsDelta: '{}' }
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: 'danger', arguments: '{}' } }
  throw error
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(callId: string, name: string, args: string): StreamChunk[] {
  const id = ToolCallId(callId)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function* slowFailure(
  started: () => void,
  delayMs: number,
  error: Error,
): AsyncGenerator<StreamChunk> {
  started()
  await new Promise(resolve => setTimeout(resolve, delayMs))
  throw error
}

async function* partialSlowFailure(
  started: () => void,
  delayMs: number,
  error: Error,
): AsyncGenerator<StreamChunk> {
  started()
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'partial work' }
  await new Promise(resolve => setTimeout(resolve, delayMs))
  throw error
}

async function* slowSuccess(started: () => void, delayMs: number): AsyncGenerator<StreamChunk> {
  started()
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'long answer' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'long answer' } }
  await new Promise(resolve => setTimeout(resolve, delayMs))
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * A degenerate empty provider completion as an error finish chunk. Both
 * adapters emit this shape and the EMPTY_RESPONSE code (the field the policy
 * routes on); the message text here is the deepseek adapter's phrasing (pi-ai
 * qualifies it with the model name).
 */
function emptyCompletion(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  policies: Readonly<Record<string, RetryPolicyConfig | undefined>> = { mock: normalConfig() },
  beforeRetry?: (ctx: Context) => void,
  internals: retry.RetryInternals = {},
): Promise<{ ctx: Context; retryFiber: Fiber; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeRetry?.(ctx)
  adapter.configureRetryPolicies(policies)
  const retryFiber = await ctx.plugin(Object.assign((inner: Context) => {
    retry.apply(inner, {}, internals)
  }, { inject: retry.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock', 'other'], adapter)
  return { ctx, retryFiber, disposeAdapter }
}

function normalConfig(
  overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

function alwaysConfig(backoff: BackoffConfig = {}): AlwaysRetryPolicyConfig {
  return {
    mode: 'always',
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function waitForRetry(ctx: Context, agent: Agent, retryNumber: number): Promise<Extract<SessionEvent, { type: 'llm/retry' }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry' && event.data.retry === retryNumber) {
        dispose()
        resolve(event)
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

/** The Nvidia-relayed capacity overload, exactly as pi-ai flattened it. */
const OVERLOAD_MESSAGE = 'Upstream error from Nvidia: Service temporarily overloaded'

/**
 * An upstream overload as a pi-ai error finish chunk (the adapter's in-band
 * error delivery). The code is SERVER because the pi-ai classifier maps the
 * prose capacity wording to the retryable family.
 */
function overloadFailure(): StreamChunk[] {
  return [
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
    {
      type: 'finish',
      reason: { kind: 'error', failure: { message: OVERLOAD_MESSAGE, code: 'SERVER' } },
    },
  ]
}

describe('provider-routed retry policy', () => {
  it('records the scheduled delay before retrying the request', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      mock: normalConfig({ retryableCodes: ['SERVER', 'RATE_LIMIT'] }),
    }, undefined, { random: () => 0.5 }))
    const agent = await context.agentLoop.create(SessionId('retry-success'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await scheduled

    expect(event.data.retryId).toEqual(expect.any(String))
    expect(event.data).toEqual({
      retryId: event.data.retryId,
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: '["normal",2,["RATE_LIMIT","SERVER"],500,10000,0]',
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: {
        message: 'busy',
        code: 'RATE_LIMIT',
        status: 429,
        provider: 'mock',
        model: 'mock',
      },
    })
    expect(adapter.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499)
    expect(adapter.requests).toHaveLength(1)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'step/start').map(item => item.data))
      .toEqual([{ turn: 1, step: 1 }])
    expect(agent.session.deriveMessages().at(-1)).toEqual({
      id: expect.any(String) as unknown,
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
  })

  it('retries an EMPTY_RESPONSE error finish under the default retryable codes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      emptyCompletion(),
      textResponse('recovered'),
    ])
    // No retryableCodes override: this proves the default policy covers the
    // adapters' empty-completion classification end to end (finish-chunk error
    // delivery, not a thrown stream error).
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-empty-response'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await scheduled
    expect(event.data.failure).toEqual({
      message: 'model returned a completed response with no content',
      code: EMPTY_RESPONSE_CODE,
    })

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').map(event => ({
      turn: event.data.turn,
      step: event.data.step,
    }))).toEqual([{ turn: 1, step: 1 }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })

  it('retries an upstream capacity overload under the default retryable codes and completes the turn', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      overloadFailure(),
      textResponse('recovered after overload'),
    ])
    // No retryableCodes override: SERVER is in the resolved default set, so the
    // overload's classification alone recovers the turn.
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-overload'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await scheduled
    expect(event.data).toMatchObject({
      mode: 'normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 500,
      failure: { message: OVERLOAD_MESSAGE, code: 'SERVER' },
    })

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered after overload' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('stops overload retries at the configured budget and surfaces the terminal error', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      overloadFailure(),
      overloadFailure(),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-overload-exhausted'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: OVERLOAD_MESSAGE, code: 'SERVER' } } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves a non-retryable in-band failure terminal', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([[
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'HTTP 400: invalid input', code: 'INVALID_REQUEST' },
        },
      },
    ]])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-invalid-request'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST' } } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves partial failed chunks on their step without committing a message or tool side effect', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError('stream interrupted', 'TRANSPORT')),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter))
    let toolExecutions = 0
    context.tools.register(defineContentToolFixture({
      name: 'danger',
      description: 'must not run for a failed provider attempt',
      parameters: {},
      async execute() {
        toolExecutions += 1
        return [{ type: 'text', text: 'unexpected' }]
      },
    }))
    const agent = await context.agentLoop.create(SessionId('retry-partial'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    const retryEvent = agent.session.snapshotEvents().find(event => event.type === 'llm/retry')
    const failedAttempts = agent.session.snapshotEvents().filter((event): event is SessionEvent<'assistant/attempt'> =>
      event.type === 'assistant/attempt'
      && retryEvent !== undefined
      && event.seq < retryEvent.seq,
    )
    expect(failedAttempts).toHaveLength(1)
    expect(expandAssistantStream(failedAttempts[0]!.data.stream)).toHaveLength(7)
    const assistantMessages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    expect(assistantMessages.map(event => ({
      turn: event.data.turn,
      step: event.data.step,
    }))).toEqual([{ turn: 1, step: 1 }])
    expect(assistantMessages[0]?.sourceEventSeqs).toBeUndefined()
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
    expect(toolExecutions).toBe(0)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
  })

  it('applies bounded exponential jitter and stops after the configured budget', async () => {
    vi.useFakeTimers()
    const samples = [0, 1]
    const adapter = new ScriptedAdapter([
      new LlmError('busy one', 'SERVER'),
      new LlmError('busy two', 'SERVER'),
      new LlmError('busy three', 'SERVER'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { jitterRatio: 0.1 },
    }) }, undefined, {
      random: () => samples.shift() ?? 0.5,
    }))
    const agent = await context.agentLoop.create(SessionId('retry-exhausted'), { provider: 'mock', model: 'mock' })
    const first = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await first).data.delayMs).toBe(450)

    const second = waitForRetry(context, agent, 2)
    await vi.advanceTimersByTimeAsync(450)
    expect((await second).data.delayMs).toBe(1_100)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1_100)
    await idle

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'busy three', code: 'SERVER' } } },
    })
  })

  it('accepts the zero-delay lower jitter bound', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 },
    }) }, undefined, { random: () => 0 }))
    const agent = await context.agentLoop.create(SessionId('retry-zero-delay'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(0)

    const idle = waitForIdle(context, agent)
    await vi.runAllTimersAsync()
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('surfaces a rate-limit wait instead of retrying when the provider reset exceeds the cap', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rate limited', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 17_337 }),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      maxRetries: 5,
      backoff: { jitterRatio: 0.1 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-after-over-cap'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'rate limited by the provider; retry in 18s', code: 'RATE_LIMIT' },
        },
      },
    })
  })

  it('surfaces a multi-hour provider reset as hours and minutes', async () => {
    vi.useFakeTimers()
    // The live Claude Max window: 17337 seconds after the countdown settled.
    const adapter = new ScriptedAdapter([
      new LlmError('rate limited', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 17_337_000 }),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({ maxRetries: 5 }) }))
    const agent = await context.agentLoop.create(SessionId('retry-after-multi-hour'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'rate limited by the provider; retry in 4h49m', code: 'RATE_LIMIT' },
        },
      },
    })
  })

  it.each([
    [90_000, '1m30s'],
    [2_500, '3s'],
  ])('formats a %d ms provider reset as %s, rounding up', async (hintMs, wait) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('rate limited', 'RATE_LIMIT', { providerRetryAfterMs: hintMs })])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({ maxRetries: 0 }) }))
    const agent = await context.agentLoop.create(SessionId(`retry-after-${hintMs}`), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: `rate limited by the provider; retry in ${wait}`, code: 'RATE_LIMIT' },
        },
      },
    })
  })

  it('surfaces the wait when the remaining attempt budget cannot cover the reset', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rate limited', 'RATE_LIMIT', { providerRetryAfterMs: 2_000 }),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({ maxRetries: 0 }) }))
    const agent = await context.agentLoop.create(SessionId('retry-after-exhausted'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'rate limited by the provider; retry in 2s', code: 'RATE_LIMIT' },
        },
      },
    })
  })

  it('schedules a rate-limit retry at the provider reset, jittered upward', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rate limited', 'RATE_LIMIT', { providerRetryAfterMs: 2_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { jitterRatio: 0.1 },
    }) }, undefined, { random: () => 1 }))
    const agent = await context.agentLoop.create(SessionId('retry-after-accepted'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const delayMs = (await scheduled).data.delayMs
    expect(delayMs).toBeGreaterThanOrEqual(2_000)
    expect(delayMs).toBe(2_200)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(2_199)
    expect(adapter.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('keeps the exponential sequence for a rate limit without a reset hint', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy one', 'RATE_LIMIT'),
      new LlmError('busy two', 'RATE_LIMIT'),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-rate-limit-no-hint'), {
      provider: 'mock',
      model: 'mock',
    })
    const first = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await first).data.delayMs).toBe(500)

    const second = waitForRetry(context, agent, 2)
    await vi.advanceTimersByTimeAsync(500)
    expect((await second).data.delayMs).toBe(1_000)

    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1_000)
    await idle
    expect(adapter.requests).toHaveLength(3)
  })

  it('ignores a provider reset hint on a non-rate-limit failure', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('overloaded', 'SERVER', { providerRetryAfterMs: 2_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-server-hint-ignored'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(500)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('keeps a rate-limit hint exactly at the max wait deterministic', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rate limited', 'RATE_LIMIT', { providerRetryAfterMs: 10_000 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { maxDelayMs: 10_000, jitterRatio: 1 },
    }) }, undefined, { random: () => 1 }))
    const agent = await context.agentLoop.create(SessionId('retry-after-boundary'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(10_000)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(10_000)
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('uses local jittered backoff when always mode receives an over-cap rate-limit hint', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('wait too long', 'RATE_LIMIT', { providerRetryAfterMs: 10 }),
      textResponse('done'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 2,
      maxDelayMs: 4,
      jitterRatio: 0.5,
    }) }, undefined, { random: () => 1 }))
    const agent = await context.agentLoop.create(SessionId('retry-always-over-cap'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.delayMs).toBe(3)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(3)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('delegates non-transient failures without scheduling a timer', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-auth'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('delegates when no final adapter served the failed request', async () => {
    const adapter = new ScriptedAdapter([textResponse('must not run')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    mounted.disposeAdapter()
    const agent = await context.agentLoop.create(SessionId('retry-no-serving-policy'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'missing route' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    const end = agent.session.snapshotEvents().at(-1)
    expect(end).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } },
    })
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      expect(end.data.reason.error.message).toContain('no adapter registered for provider')
    }
  })

  it('selects policy by the failed request provider', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock auth failed', 'AUTH'),
      new LlmError('other auth failed', 'AUTH'),
      textResponse('other recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }))

    const normalAgent = await context.agentLoop.create(SessionId('retry-provider-normal'), {
      provider: 'mock',
      model: 'mock',
    })
    const normalIdle = waitForIdle(context, normalAgent)
    normalAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'normal' }], source: { kind: 'user' } }))
    await normalIdle
    expect(normalAgent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)

    const alwaysAgent = await context.agentLoop.create(SessionId('retry-provider-always'), {
      provider: 'other',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, alwaysAgent, 1)
    alwaysAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'always' }], source: { kind: 'user' } }))
    expect((await scheduled).data).toMatchObject({
      provider: 'other',
      mode: 'always',
      retry: 1,
      delayMs: 1,
    })
    const alwaysIdle = waitForIdle(context, alwaysAgent)
    await vi.advanceTimersByTimeAsync(1)
    await alwaysIdle

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'other'])
  })

  it('selects an always policy from the provider chosen by agent/request', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('rerouted auth failed', 'AUTH'),
      textResponse('rerouted recovery'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      other: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
    }, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(),
        provider: 'other',
      }))
    }))
    const agent = await context.agentLoop.create(SessionId('retry-provider-rerouted'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reroute' }], source: { kind: 'user' } }))
    expect((await scheduled).data).toMatchObject({ provider: 'other', mode: 'always' })
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests.map(request => request.provider)).toEqual(['other', 'other'])
  })

  it('keeps finite retry budgets scoped to the failed provider', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock failed', 'SERVER'),
      new LlmError('other failed', 'SERVER'),
      textResponse('other recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      mock: normalConfig({
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      }),
      other: normalConfig({
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      }),
    }, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(),
        provider: adapter.requests.length === 0 ? 'mock' : 'other',
      }))
    }))
    const agent = await context.agentLoop.create(SessionId('retry-provider-budgets'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'switch provider after failure' }],
      source: { kind: 'user' },
    }))
    await vi.runAllTimersAsync()
    await idle

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'other'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => ({
      provider: event.data.provider,
      retry: event.data.retry,
    }))).toEqual([
      { provider: 'mock', retry: 1 },
      { provider: 'other', retry: 1 },
    ])
  })

  it.each(['thrown', 'in-band'] as const)(
    'uses the serving registration policy and resets changed-policy history after a %s failure',
    async (failureKind) => {
      vi.useFakeTimers()
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const oldAdapter = new ScriptedAdapter([(async function * (): AsyncGenerator<StreamChunk> {
        entered.resolve(undefined)
        await release.promise
        if (failureKind === 'thrown') {
          throw new LlmError('old route auth failed', 'AUTH')
        }
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'old route auth failed', code: 'AUTH' },
          },
        }
      })()])
      const mounted = await harness(oldAdapter, { mock: alwaysConfig({
        initialDelayMs: 1,
        maxDelayMs: 1,
      }) })
      context = mounted.ctx
      const agent = await context.agentLoop.create(SessionId('retry-serving-registration'), {
        provider: 'mock',
        model: 'mock',
      })
      const scheduled = waitForRetry(context, agent, 1)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'replace while in flight' }],
        source: { kind: 'user' },
      }))
      await entered.promise

      mounted.disposeAdapter()
      const replacement = new ScriptedAdapter([
        new LlmError('replacement failed', 'AUTH'),
        textResponse('replacement recovered'),
      ])
      replacement.configureRetryPolicies({ mock: alwaysConfig({
        initialDelayMs: 3,
        maxDelayMs: 3,
      }) })
      context.llm.registerAdapter(['mock'], replacement)
      release.resolve(undefined)

      const firstEvent = await scheduled
      expect(firstEvent.data).toMatchObject({
        provider: 'mock',
        mode: 'always',
        retry: 1,
        delayMs: 1,
      })
      const replacementScheduled = waitForRetry(context, agent, 1)
      const idle = waitForIdle(context, agent)
      await vi.advanceTimersByTimeAsync(1)
      const replacementEvent = await replacementScheduled
      expect(replacementEvent.data).toMatchObject({
        provider: 'mock',
        mode: 'always',
        retry: 1,
        delayMs: 3,
      })
      expect(replacementEvent.data.policyKey).not.toBe(firstEvent.data.policyKey)
      await vi.advanceTimersByTimeAsync(3)
      await idle

      expect(oldAdapter.requests).toHaveLength(1)
      expect(replacement.requests).toHaveLength(2)
      expect(agent.session.deriveMessages().at(-1)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: 'replacement recovered' }],
      })
    },
  )

  it('keeps always mode unbounded while preserving cancellable jittered backoff', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('auth one', 'AUTH'),
      new LlmError('auth two', 'AUTH'),
      new LlmError('auth three', 'AUTH'),
      new LlmError('auth four', 'AUTH'),
      textResponse('eventually recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 4,
      jitterRatio: 0.1,
    }) }, undefined, { random: () => 1 }))
    const agent = await context.agentLoop.create(SessionId('retry-always-unbounded'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep trying' }], source: { kind: 'user' } }))
    await vi.runAllTimersAsync()
    await idle

    const events = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
    expect(adapter.requests).toHaveLength(5)
    expect(events.map(event => ({
      provider: event.data.provider,
      mode: event.data.mode,
      retry: event.data.retry,
      delayMs: event.data.delayMs,
      hasMax: 'maxRetries' in event.data,
    }))).toEqual([
      { provider: 'mock', mode: 'always', retry: 1, delayMs: 1.1, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 2, delayMs: 2.2, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 3, delayMs: 4, hasMax: false },
      { provider: 'mock', mode: 'always', retry: 4, delayMs: 4, hasMax: false },
    ])
  })

  it('keeps failed error text and partial output out of every retried model context', async () => {
    vi.useFakeTimers()
    const diagnostic = 'private provider diagnostic must not enter context'
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError(diagnostic, 'AUTH')),
      textResponse('recovered without leaked context'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-always-context-isolation'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'safe input' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
    const retriedContext = JSON.stringify(adapter.requests[1]?.messages)
    expect(retriedContext).not.toContain(diagnostic)
    expect(retriedContext).not.toContain('discarded partial output')
    expect(agent.session.snapshotEvents().some(event =>
      event.type === 'llm/retry' && event.data.failure.message === diagnostic,
    )).toBe(true)
  })

  it('lets downstream specialized recovery run before always fallback', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('requires specialized recovery', 'AUTH'),
      textResponse('specialized recovery won'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    context.on('agent/request-error', async () => ({ kind: 'retry' }))
    const agent = await context.agentLoop.create(SessionId('retry-always-composition'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
  })

  it.each([
    ['synchronously', () => { throw new Error('downstream recovery failed') }],
    ['asynchronously', async () => { throw new Error('downstream recovery failed') }],
  ])('falls back to always retry when downstream recovery throws %s', async (_kind, failDownstream) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('requires fallback', 'AUTH'),
      textResponse('always recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({
      initialDelayMs: 1,
      maxDelayMs: 1,
    }) }))
    context.on('agent/request-error', failDownstream)
    const agent = await context.agentLoop.create(SessionId('retry-always-downstream-error'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(1)
    await idle

    expect(adapter.requests).toHaveLength(2)
  })

  it('aborts and drains a captured backoff before plugin disposal completes', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'TRANSPORT'),
      textResponse('must not run'),
    ])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const agent = await context.agentLoop.create(SessionId('retry-hmr'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)

    await mounted.retryFiber.dispose()
    await idle
    await vi.advanceTimersByTimeAsync(60_000)

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains delegated recovery before completing plugin disposal', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const order: string[] = []
    context.on('agent/request-error', async () => {
      entered.resolve(undefined)
      await release.promise
      order.push('downstream')
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId('retry-delegated-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent).then(() => { order.push('idle') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise

    const disposing = mounted.retryFiber.dispose().then(() => { order.push('disposed') })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    release.resolve(undefined)
    await disposing
    await idle

    expect(order[0]).toBe('downstream')
    expect(order).toEqual(expect.arrayContaining(['disposed', 'idle']))
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('drains delegated recovery before turn cancellation reaches idle', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorAction>()
    const entered = Promise.withResolvers<undefined>()
    const order: string[] = []
    context.on('agent/request-error', async () => {
      entered.resolve(undefined)
      const decision = await downstream.promise
      order.push('downstream')
      return decision
    })
    const agent = await context.agentLoop.create(SessionId('retry-delegated-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent).then(() => { order.push('idle') })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise

    agent.cancel({ kind: 'user' })
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    downstream.resolve({ kind: 'retry' })
    await idle

    expect(order).toEqual(['downstream', 'idle'])
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation while entering delegated recovery', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, { mock: alwaysConfig() })
    context = mounted.ctx
    const downstream = Promise.withResolvers<RequestErrorAction>()
    const entered = Promise.withResolvers<undefined>()
    context.on('agent/request-error', ({ agent }) => {
      agent.cancel({ kind: 'user' })
      entered.resolve(undefined)
      return downstream.promise
    })
    const agent = await context.agentLoop.create(SessionId('retry-delegated-sync-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await entered.promise
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'blocked'>((resolve) => { timer = setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    expect(outcome).toBe('blocked')

    downstream.resolve({ kind: 'retry' })
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('fails a captured callback after disposal without entering downstream policy', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const captured = Promise.withResolvers<undefined>()
    let invokeCaptured: (() => Promise<void>) | undefined
    const mounted = await harness(adapter, {}, (ctx) => {
      ctx.on('agent/request-error', (_payload, next) => {
        return new Promise<RequestErrorAction>((resolve) => {
          invokeCaptured = async () => { resolve(await next()) }
          captured.resolve(undefined)
        })
      })
    })
    context = mounted.ctx
    let downstreamCalls = 0
    context.on('agent/request-error', async (_payload, next) => {
      downstreamCalls += 1
      return next()
    })
    const agent = await context.agentLoop.create(SessionId('retry-captured-disposal'), {
      provider: 'mock',
      model: 'mock',
    })
    const idle = waitForIdle(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await captured.promise

    await mounted.retryFiber.dispose()
    if (invokeCaptured === undefined) throw new Error('request-error waterfall did not capture retry callback')
    await invokeCaptured()
    await idle

    expect(downstreamCalls).toBe(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('lets turn cancellation win during backoff without opening another step', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('permanent', 'AUTH'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig() }))
    const agent = await context.agentLoop.create(SessionId('retry-cancel'), { provider: 'mock', model: 'mock' })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await scheduled
    const idle = waitForIdle(context, agent)
    agent.cancel({ kind: 'user' })
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['normal', normalConfig()],
    ['always', alwaysConfig()],
  ])('lets an earlier recovery listener cancel before %s retry policy runs', async (_mode, policy) => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: policy }, (ctx) => {
      ctx.on('agent/request-error', async ({ agent }, next) => {
        agent.cancel({ kind: 'user' })
        return next()
      })
    }))
    const agent = await context.agentLoop.create(SessionId('retry-pre-cancel'), { provider: 'mock', model: 'mock' })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('handles synchronous cancellation from the retry status event', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('temporary', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-event-cancel'), { provider: 'mock', model: 'mock' })
    context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') agent.cancel({ kind: 'user' })
    })
    const idle = waitForIdle(context, agent)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects retry policy configured on the executor instead of a provider', () => {
    expectTypeOf<{}>().toExtend<retry.Config>()
    expectTypeOf<{ retryPolicy: { mode: 'always' } }>().not.toExtend<retry.Config>()
    const ctx = new Context()
    // `apply` registers its projection unit first; the registry is a required
    // injection, so the direct-apply path must carry it too.
    new SessionProjectionRegistry(ctx)
    expect(() => {
      retry.apply(ctx, { retryPolicy: { mode: 'always' } } as unknown as retry.Config)
    }).toThrow(/retryPolicy belongs under each provider/)
  })

  it('rejects unknown executor config', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    expect(() => {
      retry.apply(ctx, { retryPolciy: {} } as unknown as retry.Config)
    }).toThrow(/unknown key "retryPolciy"/)
  })
})

describe('quota-safe retry guard', () => {
  it('stops after one 300-second no-output attempt under the default guard', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const failure = new LlmError('slow provider failure', 'SERVER', {
      status: 503,
      requestId: ProviderRequestId('req-guard'),
      providerRetryAfterMs: 4_321,
    })
    const adapter = new ScriptedAdapter(Array.from({ length: 6 }, () => slowFailure(
      () => { started.resolve(undefined) },
      300_050,
      failure,
    )))
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('retry-guard-six-slow'), {
      provider: 'mock',
      model: 'mock',
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(300_050)
    await agent.whenIdle()

    const events = agent.session.snapshotEvents()
    const ending = events.findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.some(event => event.type === 'llm/retry')).toBe(false)
    expect(ending.data.reason).toMatchObject({
      kind: 'error',
      error: {
        code: 'SERVER',
        status: 503,
        requestId: ProviderRequestId('req-guard'),
        providerRetryAfterMs: 4_321,
        provider: 'mock',
        model: 'mock',
      },
    })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message)
      .toContain('auto-retry stopped to protect quota after 1 failed attempt')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps fast rate-limit and server retries under the guard defaults', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 100 }),
      new LlmError('overloaded', 'SERVER'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      retryableCodes: ['RATE_LIMIT', 'SERVER'],
      backoff: { initialDelayMs: 100, maxDelayMs: 1_000 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-fast'), {
      provider: 'mock',
      model: 'mock',
    })
    const first = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await first).data.delayMs).toBe(100)

    const second = waitForRetry(context, agent, 2)
    await vi.advanceTimersByTimeAsync(100)
    expect((await second).data.delayMs).toBe(200)
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(200)
    await idle

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })

  it('never cancels a healthy long generation', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([slowSuccess(() => { started.resolve(undefined) }, 650)])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 600, maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-healthy-long'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(650)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'long answer' }],
    })
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('counts hidden pool and chain time inside one attempt', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([slowFailure(
      () => { started.resolve(undefined) },
      650,
      new LlmError('hidden route time', 'SERVER'),
    )])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 600, maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-hidden-time'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(650)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxElapsedMs')
  })

  it('resets no-work after content and stops on the next no-output attempt', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      partialSlowFailure(() => { started.resolve(undefined) }, 400, new LlmError('partial failed', 'SERVER')),
      slowFailure(() => { /* the second attempt needs no start signal */ }, 400, new LlmError('no work failed', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 0, maxNoWorkElapsedMs: 300 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-no-work-reset'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(801)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxNoWorkElapsedMs')
  })

  it('stops long partial-failure chains on the total step budget', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      partialSlowFailure(() => { started.resolve(undefined) }, 500, new LlmError('partial one', 'SERVER')),
      partialSlowFailure(() => { /* the second attempt needs no start signal */ }, 500, new LlmError('partial two', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 200, maxDelayMs: 200 },
      guard: { maxElapsedMs: 1_000, maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-partial-budget'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(1_200)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxElapsedMs')
  })

  it('keeps a zero no-work limit disabled', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      slowFailure(() => { started.resolve(undefined) }, 400, new LlmError('no work one', 'SERVER')),
      slowFailure(() => { /* the second attempt needs no start signal */ }, 400, new LlmError('no work two', 'SERVER')),
      textResponse('recovered after no-work retries'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 600_000, maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-no-work-disabled'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(802)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered after no-work retries' }],
    })
  })

  it('includes a configured guard in the retry policy key', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      retryableCodes: ['SERVER'],
      guard: { maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-policy-key'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    expect((await scheduled).data.policyKey).toBe('["normal",2,["SERVER"],500,10000,0,[600000,0,[]]]')
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle
    expect(adapter.requests).toHaveLength(2)
  })

  it('keeps a policy refusal terminal in always mode even when downstream asks to retry', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('blocked by provider policy', POLICY_REFUSAL_CODE, { status: 400, requestId: ProviderRequestId('refusal-req') }),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1 }) }))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId('retry-guard-refusal-always'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(ending.data.reason).toMatchObject({
      kind: 'error',
      error: {
        message: 'blocked by provider policy',
        code: POLICY_REFUSAL_CODE,
        status: 400,
        requestId: 'refusal-req',
      },
    })
  })

  it.each([
    ['normal', normalConfig()],
    ['always', alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1 })],
  ] as const)('keeps an exhausted model chain terminal in %s mode before downstream recovery', async (_mode, policy) => {
    const adapter = new ScriptedAdapter([
      new LlmError('model chain exhausted', MODEL_CHAIN_EXHAUSTED_CODE),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: policy }))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId(`retry-guard-chain-exhausted-${_mode}`), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(ending.data.reason).toMatchObject({
      kind: 'error',
      error: { code: MODEL_CHAIN_EXHAUSTED_CODE, message: 'model chain exhausted' },
    })
  })

  it.each([
    ['normal', normalConfig()],
    ['always', alwaysConfig({ initialDelayMs: 1, maxDelayMs: 1 })],
  ] as const)('does not reissue an exhausted model chain in %s mode', async (_mode, policy) => {
    const adapter = new ScriptedAdapter([
      new LlmError('route alpha busy', 'SERVER'),
      new LlmError('route beta busy', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: policy }))
    context.provide('modelChains', {
      resolve: (id: string) => id === 'exhaust-chain'
        ? {
          id,
          links: [
            { provider: 'mock', model: 'alpha' },
            { provider: 'mock', model: 'beta' },
          ],
        }
        : undefined,
    } satisfies ModelChainResolver)
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId(`retry-guard-chain-traversal-${_mode}`), {
      provider: 'mock',
      model: 'alpha',
      chain: 'exhaust-chain',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    // Each link ran once: one traversal, never a second full-chain reissue.
    expect(adapter.requests.map(request => request.model)).toEqual(['alpha', 'beta'])
    expect(downstreamCalls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
    expect(ending.data.reason).toMatchObject({
      kind: 'error',
      error: { code: MODEL_CHAIN_EXHAUSTED_CODE },
    })
  })

  it('keeps configured terminal codes terminal before downstream recovery', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('route is terminal', 'SERVER'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      retryableCodes: ['RATE_LIMIT'],
      guard: { terminalCodes: ['SERVER'] },
    }) }))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId('retry-guard-terminal-code'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
  })

  it.each([
    [POLICY_REFUSAL_CODE, 'refused once'],
    [MODEL_CHAIN_EXHAUSTED_CODE, 'chain exhausted once'],
  ])('keeps mandatory terminal code %s terminal when a raw policy lists it as retryable', async (code, message) => {
    class RawPolicyAdapter extends ScriptedAdapter {
      override providerRetryPolicy(): ResolvedRetryPolicy {
        return Object.freeze({
          mode: 'normal',
          maxRetries: 5,
          retryableCodes: Object.freeze([code]),
          initialDelayMs: 1,
          maxDelayMs: 1,
          jitterRatio: 0,
          guard: Object.freeze({
            maxElapsedMs: 600_000,
            maxNoWorkElapsedMs: 300_000,
            terminalCodes: Object.freeze([]),
          }),
        })
      }
    }
    const adapter = new RawPolicyAdapter([
      new LlmError(message, code),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId(`retry-guard-raw-${code}`), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(0)
    expect(agent.session.snapshotEvents().some(event => event.type === 'llm/retry')).toBe(false)
  })

  it('checks the guard before always-mode downstream recovery', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      slowFailure(() => { started.resolve(undefined) }, 60, new LlmError('no output', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: {
      mode: 'always',
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 0, maxNoWorkElapsedMs: 50 },
    } }))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId('retry-guard-before-always-downstream'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(60)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(0)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxNoWorkElapsedMs')
  })

  it('blocks a downstream retry when the normal budget delegates after a guard trip', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      slowFailure(() => { started.resolve(undefined) }, 60, new LlmError('no output', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      retryableCodes: ['SERVER'],
      maxRetries: 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 0, maxNoWorkElapsedMs: 50 },
    }) }))
    let downstreamCalls = 0
    context.on('agent/request-error', async (): Promise<RequestErrorAction> => {
      downstreamCalls += 1
      return { kind: 'retry' }
    })
    const agent = await context.agentLoop.create(SessionId('retry-guard-delegated-trip'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(60)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(downstreamCalls).toBe(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxNoWorkElapsedMs')
  })

  it('stops exactly at the no-work boundary', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      slowFailure(() => { started.resolve(undefined) }, 50, new LlmError('no output', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 0, maxNoWorkElapsedMs: 50 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-exact-no-work'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(50)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxNoWorkElapsedMs')
  })

  it('stops exactly at the total budget boundary including the proposed delay', async () => {
    vi.useFakeTimers()
    const started = Promise.withResolvers<undefined>()
    const adapter = new ScriptedAdapter([
      slowFailure(() => { started.resolve(undefined) }, 100, new LlmError('no output', 'SERVER')),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, { mock: normalConfig({
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      guard: { maxElapsedMs: 101, maxNoWorkElapsedMs: 0 },
    }) }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-exact-total'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await started.promise
    await vi.advanceTimersByTimeAsync(100)
    await agent.whenIdle()

    const ending = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (ending?.type !== 'turn/end') throw new Error('expected a terminal turn')
    expect(adapter.requests).toHaveLength(1)
    expect(ending.data.reason).toMatchObject({ kind: 'error', error: { code: 'SERVER' } })
    if (ending.data.reason.kind !== 'error') throw new Error('expected an error ending')
    expect(ending.data.reason.error.message).toContain('maxElapsedMs')
  })

  it('executes tools only from the committed successful attempt', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      partialToolFailure(new LlmError('stream cut', 'SERVER')),
      toolCallResponse('kept-call', 'lookup', '{}'),
      textResponse('tool done'),
    ])
    ;({ ctx: context } = await harness(adapter))
    let executions = 0
    context.tools.register(defineContentToolFixture({
      name: 'lookup',
      description: 'return one committed result',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: 'looked up' }]
      },
    }))
    const agent = await context.agentLoop.create(SessionId('retry-guard-tools'), {
      provider: 'mock',
      model: 'mock',
    })
    const scheduled = waitForRetry(context, agent, 1)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const retryEvent = await scheduled
    const idle = waitForIdle(context, agent)
    await vi.advanceTimersByTimeAsync(500)
    await idle

    const events = agent.session.snapshotEvents()
    expect(executions).toBe(1)
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(events.filter((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call' && event.seq < retryEvent.seq))
      .toHaveLength(0)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'tool done' }],
    })
  })
})
