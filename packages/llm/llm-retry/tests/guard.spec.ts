import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { RetryId } from '../src/brand.ts'
import { applyRetryGuardLiveEvent, retryGuardUsage } from '../src/guard.ts'
import * as retry from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

async function projectionContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  context = ctx
  return ctx
}

describe('llm-retry guard projection', () => {
  it('derives durable attempt and no-work accounting from an existing log', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const ctx = await projectionContext()
    const session = ctx.sessions.create(SessionId('retry-guard-replay'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'initial',
    })
    vi.setSystemTime(1_300_050)
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })

    const seqBefore = session.seq
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {})
    }, { inject: retry.inject }))

    const first = ctx.sessionProjections.stateOf(session, 'llmRetryGuard')
    expect(first).toEqual({
      turn: 1,
      step: 1,
      stepStartedAt: 1_000_000,
      attemptStartedAt: 1_300_050,
      lastAttemptEndTime: 1_300_050,
      lastAttemptMs: 300_050,
      lastAttemptContent: false,
      noWorkMs: 300_050,
      failedAttempts: 1,
    })
    expect(retryGuardUsage(first!, undefined, 0)).toEqual({
      elapsedMs: 300_050,
      noWorkMs: 300_050,
      failedAttempts: 1,
    })
    expect(session.seq).toBe(seqBefore)

    vi.setSystemTime(1_300_080)
    session.append('llm/retry', {
      retryId: RetryId('replay-retry'),
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'normal-policy',
      retry: 1,
      maxRetries: 2,
      delayMs: 1,
      failure: { message: 'no work failed', code: 'SERVER' },
    })
    vi.setSystemTime(1_300_100)
    session.append('llm/retry-started', {
      retryId: RetryId('replay-retry'),
      turn: 1,
      step: 1,
      retry: 1,
    })
    vi.setSystemTime(1_300_200)
    session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{
        type: 'chunk',
        time: 1_300_150,
        chunk: { type: 'text-delta', index: 0, text: 'partial' },
      }],
    })

    const second = ctx.sessionProjections.stateOf(session, 'llmRetryGuard')
    expect(second).toMatchObject({
      lastAttemptMs: 100,
      lastAttemptContent: true,
      noWorkMs: 0,
      failedAttempts: 2,
    })

    vi.setSystemTime(1_300_500)
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    const third = ctx.sessionProjections.stateOf(session, 'llmRetryGuard')
    expect(third).toMatchObject({
      lastAttemptMs: 300,
      lastAttemptContent: false,
      noWorkMs: 300,
      failedAttempts: 3,
    })
  })

  it('resets the guard fold at step and turn boundaries', async () => {
    const ctx = await projectionContext()
    const session = ctx.sessions.create(SessionId('retry-guard-boundaries'))
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {})
    }, { inject: retry.inject }))

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    expect(ctx.sessionProjections.stateOf(session, 'llmRetryGuard')).toMatchObject({ failedAttempts: 1 })

    session.append('step/end', { turn: 1, step: 1 })
    expect(ctx.sessionProjections.stateOf(session, 'llmRetryGuard')).toEqual({
      lastAttemptMs: 0,
      lastAttemptContent: false,
      noWorkMs: 0,
      failedAttempts: 0,
    })

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ctx.sessionProjections.stateOf(session, 'llmRetryGuard')).toMatchObject({ failedAttempts: 0 })
  })

  it('takes the larger monotonic observation without losing durable time', () => {
    const state = {
      stepStartedAt: 1_000,
      lastAttemptEndTime: 1_400,
      lastAttemptMs: 400,
      lastAttemptContent: false,
      noWorkMs: 400,
      failedAttempts: 1,
    }
    expect(retryGuardUsage(state, { stepStartMono: 0, attemptStartMono: 0, noWorkMonoMs: 900 }, 1_000)).toEqual({
      elapsedMs: 1_000,
      noWorkMs: 900,
      failedAttempts: 1,
    })
    expect(retryGuardUsage(state, undefined, 0)).toEqual({
      elapsedMs: 400,
      noWorkMs: 400,
      failedAttempts: 1,
    })
  })

  it('accumulates monotonic no-work across failed attempts under a wall-clock change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const ctx = await projectionContext()
    const session = ctx.sessions.create(SessionId('retry-guard-live-no-work'))
    session.append('turn/start', { turn: 1 })
    const step = session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'initial',
    })
    vi.setSystemTime(1_000_100)
    const firstAttempt = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    session.append('llm/retry', {
      retryId: RetryId('live-no-work'),
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'normal-policy',
      retry: 1,
      maxRetries: 2,
      delayMs: 1,
      failure: { message: 'busy', code: 'SERVER' },
    })
    const retryStarted = session.append('llm/retry-started', {
      retryId: RetryId('live-no-work'),
      turn: 1,
      step: 1,
      retry: 1,
    })
    vi.setSystemTime(999_000)
    const secondAttempt = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })

    let live = applyRetryGuardLiveEvent(undefined, step, 1_000)
    expect(live).toEqual({ stepStartMono: 1_000, attemptStartMono: 1_000, noWorkMonoMs: 0 })
    live = applyRetryGuardLiveEvent(live, firstAttempt, 1_100)
    expect(live?.noWorkMonoMs).toBe(100)
    live = applyRetryGuardLiveEvent(live, retryStarted, 1_150)
    live = applyRetryGuardLiveEvent(live, secondAttempt, 1_400)
    expect(live?.noWorkMonoMs).toBe(350)

    const durable = {
      stepStartedAt: 1_000_000,
      lastAttemptEndTime: 999_000,
      lastAttemptMs: 0,
      lastAttemptContent: false,
      noWorkMs: 100,
      failedAttempts: 2,
    }
    expect(retryGuardUsage(durable, live, 1_400)).toEqual({
      elapsedMs: 400,
      noWorkMs: 350,
      failedAttempts: 2,
    })
  })
})
