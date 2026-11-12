/**
 * Provider-routed model-request retry policy on the agent loop's request
 * recovery extension point. Each scheduled retry is durable before its cancellable wait.
 *
 * @module @deepseek-ai/dsh-llm-retry
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import {
  DEFAULT_RETRY_GUARD_MAX_ELAPSED_MS,
  DEFAULT_RETRY_GUARD_MAX_NO_WORK_ELAPSED_MS,
  LlmError,
  MODEL_CHAIN_EXHAUSTED_CODE,
  POLICY_REFUSAL_CODE,
} from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { RetryId } from './brand.ts'
import {
  applyRetryGuardEvent,
  applyRetryGuardLiveEvent,
  emptyRetryGuardState,
  retryGuardTrip,
  retryGuardUsage,
} from './guard.ts'
import type {
  RetryGuardLive,
  RetryGuardState,
  RetryGuardTrip,
  RetryGuardUsage,
} from './guard.ts'
import type { LlmRetryEventData } from './types.ts'

export type {
  RetryGuardLimit,
  RetryGuardLive,
  RetryGuardState,
  RetryGuardTrip,
  RetryGuardUsage,
} from './guard.ts'

export type { LlmRetryEventData, LlmRetryStartedEventData } from './types.ts'
export { RetryId } from './brand.ts'

export const name = 'llm-retry'
export const inject = ['agents', 'sessionProjections']

/** This policy executor has no config; providers own `retryPolicy`. */
export type Config = Readonly<Record<string, never>>

/** Runtime schema for {@link Config}. */
export const Config = z.object({}) as unknown as z<Config>

function validateConfig(config: Config): void {
  const [key] = Object.keys(config)
  if (key === undefined) return
  if (key === 'retryPolicy') {
    throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
  }
  throw new Error(`llm-retry: unknown key "${key}"`)
}

/** Non-serializable hooks used to make timing policy deterministic in tests. */
export interface RetryInternals {
  /** Random sample in the inclusive zero-to-one range used for jitter. */
  random?: () => number
  /** Monotonic millisecond clock used for live quota accounting. */
  now?: () => number
}

type DownstreamOutcome =
  | { readonly type: 'decision'; readonly decision: RequestErrorAction }
  | { readonly type: 'error'; readonly error: unknown }

async function settleDownstream(
  next: () => Promise<RequestErrorAction>,
): Promise<DownstreamOutcome> {
  try {
    return { type: 'decision', decision: await next() }
  } catch (error: unknown) {
    return { type: 'error', error }
  }
}

/** Stable code whose provider reset hint takes precedence over local backoff. */
const RATE_LIMIT_CODE = 'RATE_LIMIT'

/**
 * Failures that terminate before any policy or downstream recovery. A refusal
 * describes the request, and an exhausted chain already traversed every
 * eligible link; reissuing either spends quota without a different outcome.
 */
const MANDATORY_TERMINAL_CODES: ReadonlySet<string> = new Set([
  POLICY_REFUSAL_CODE,
  MODEL_CHAIN_EXHAUSTED_CODE,
])

function localDelay(config: ResolvedRetryPolicy, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const jitter = 1 - config.jitterRatio + 2 * config.jitterRatio * random()
  return Math.min(exponential * jitter, config.maxDelayMs)
}

/**
 * Read the provider reset hint that belongs to rate-limit semantics.
 * @param failure - the failed attempt's provider-neutral facts.
 * @returns a positive finite delay in milliseconds, or undefined when absent or inapplicable.
 */
function providerResetHint(failure: LlmFailure): number | undefined {
  if (failure.code !== RATE_LIMIT_CODE) return undefined
  const hint = failure.providerRetryAfterMs
  return hint !== undefined && Number.isFinite(hint) && hint > 0 ? hint : undefined
}

/**
 * Schedule a hinted retry no earlier than the provider reset. Jitter only
 * lengthens the wait so the retry never starts inside the window the provider
 * named; `maxDelayMs` remains the ceiling, which makes a hint exactly at the
 * boundary deterministic.
 * @param config - resolved provider policy owning the cap and jitter ratio.
 * @param retry - 1-based retry number, used for the local exponential floor.
 * @param hintMs - validated provider reset delay.
 * @param random - jitter sample in the inclusive zero-to-one range.
 * @returns the jittered, capped delay in milliseconds.
 */
function hintedDelay(
  config: ResolvedRetryPolicy,
  retry: number,
  hintMs: number,
  random: () => number,
): number {
  const exponent = Math.min(retry - 1, 1024)
  const exponential = Math.min(config.initialDelayMs * 2 ** exponent, config.maxDelayMs)
  const base = Math.min(Math.max(hintMs, exponential), config.maxDelayMs)
  return Math.min(base * (1 + config.jitterRatio * random()), config.maxDelayMs)
}

/**
 * Render an operator-actionable wait in the longest sensible unit pair. Every
 * value rounds up, so the printed reset is never earlier than the true one.
 * @param hintMs - validated provider reset delay in milliseconds.
 * @returns `{n}h{m}m`, `{n}m{s}s`, or `{n}s`.
 */
function providerWaitText(hintMs: number): string {
  const seconds = Math.max(1, Math.ceil(hintMs / 1_000))
  if (seconds >= 3_600) {
    // Ceil the total minutes first so a remainder that rounds to 60 carries
    // into the hour instead of printing `1h60m`.
    const minutes = Math.ceil(seconds / 60)
    return `${Math.floor(minutes / 60)}h${minutes % 60}m`
  }
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${seconds}s`
}

/** Render an operator-actionable wait for a provider reset. */
function providerWaitMessage(hintMs: number): string {
  return `rate limited by the provider; retry in ${providerWaitText(hintMs)}`
}

/**
 * Terminal failure surfaced when the provider reset cannot be honored inside
 * the policy's maximum wait (or its remaining attempt budget).
 */
function providerWaitError(failure: LlmFailure, hintMs: number): LlmError {
  return new LlmError(providerWaitMessage(hintMs), failure.code, {
    cause: failure,
    ...failure.status === undefined ? {} : { status: failure.status },
    providerRetryAfterMs: hintMs,
    ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
    ...failure.provider === undefined ? {} : { provider: failure.provider },
    ...failure.model === undefined ? {} : { model: failure.model },
  })
}

/**
 * Stable identity for one provider-policy retry chain. A non-default guard
 * appends its tuple so changing a quota limit starts a fresh chain; the
 * default tuple is omitted so a log recorded before the guard existed keeps
 * its chain across an upgrade.
 */
function retryPolicyKey(policy: ResolvedRetryPolicy): string {
  const base: (string | number | readonly string[])[] = policy.mode === 'always'
    ? [policy.mode, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]
    : [
      policy.mode,
      policy.maxRetries,
      [...policy.retryableCodes].sort(),
      policy.initialDelayMs,
      policy.maxDelayMs,
      policy.jitterRatio,
    ]
  const guard: (number | readonly string[])[] = [
    policy.guard.maxElapsedMs,
    policy.guard.maxNoWorkElapsedMs,
    [...policy.guard.terminalCodes].sort(),
  ]
  const defaultGuard = guard[0] === DEFAULT_RETRY_GUARD_MAX_ELAPSED_MS
    && guard[1] === DEFAULT_RETRY_GUARD_MAX_NO_WORK_ELAPSED_MS
    && (guard[2] as readonly string[]).length === 0
  return JSON.stringify(defaultGuard ? base : [...base, guard])
}

function retryStateKey(provider: string, policyKey: string): string {
  return JSON.stringify([provider, policyKey])
}

/**
 * Render the terminal failure a guard trip leaves in place of another request.
 * The provider's original code, status, reset hint, request id, provider, and
 * model stay attached; the message adds why automatic retries stopped.
 */
function retryGuardError(
  failure: LlmFailure,
  provider: string,
  model: string,
  trip: RetryGuardTrip,
  usage: RetryGuardUsage,
): LlmError {
  const delay = trip.proposedDelayMs > 0
    ? ` plus the next ${Math.ceil(trip.proposedDelayMs)} ms retry delay`
    : ''
  const detail = trip.limit === 'maxElapsedMs'
    ? `${Math.ceil(usage.elapsedMs)} ms of attempts and waits${delay} reaches `
      + `the ${trip.limitMs} ms total limit`
    : `${Math.ceil(trip.observedMs)} ms of failed attempts produced no model output `
      + `since the last token (${trip.limitMs} ms limit)`
  const attempts = usage.failedAttempts === 1 ? 'attempt' : 'attempts'
  return new LlmError(
    `auto-retry stopped to protect quota after ${usage.failedAttempts} failed ${attempts}: `
    + `${detail}; raise retryPolicy.guard.${trip.limit} to allow a longer window. `
    + `Last failure (${failure.code}): ${failure.message}`,
    failure.code,
    {
      cause: failure,
      ...failure.status === undefined ? {} : { status: failure.status },
      ...failure.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: failure.providerRetryAfterMs },
      ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
      provider: failure.provider ?? provider,
      model: failure.model ?? model,
    },
  )
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Install provider-routed normal or unbounded request recovery.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - empty executor config; provider registrations own policy.
 * @param internals - non-serializable deterministic hooks for tests.
 */
interface RetryStateEntry {
  retry: number
  retryId: RetryId
}

type LlmRetryState = Record<string, RetryStateEntry>

// The cast bridges the branded retry id, which Zod cannot express directly.
const llmRetryStateSchema: zod.ZodType<LlmRetryState> = zod.record(zod.string(), zod.object({
  retry: zod.number().int().nonnegative(),
  retryId: zod.string(),
})) as unknown as zod.ZodType<LlmRetryState>
const retryGuardStateSchema: zod.ZodType<RetryGuardState> = zod.object({
  turn: zod.number().int().nonnegative().optional(),
  step: zod.number().int().nonnegative().optional(),
  stepStartedAt: zod.number().nonnegative().optional(),
  attemptStartedAt: zod.number().nonnegative().optional(),
  lastAttemptEndTime: zod.number().nonnegative().optional(),
  lastAttemptMs: zod.number().nonnegative(),
  lastAttemptContent: zod.boolean(),
  noWorkMs: zod.number().nonnegative(),
  failedAttempts: zod.number().int().nonnegative(),
})
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Retry state for the current step by provider and policy. */
    llmRetry: LlmRetryState
    /** Attempt timing and failed no-work accounting for the open step's quota guard. */
    llmRetryGuard: RetryGuardState
  }
}

export function apply(ctx: Context, config: Config = {}, internals: RetryInternals = {}): void {
  validateConfig(config)
  ctx.sessionProjections.register({
    key: 'llmRetry',
    stateVersion: 1,
    stateSchema: llmRetryStateSchema,
    init: () => ({}),
    apply: (state, event) => {
      if (event.type === 'step/start' || event.type === 'turn/end') return {}
      if (event.type !== 'llm/retry') return state
      const key = retryStateKey(event.data.provider, event.data.policyKey)
      const entry = state[key]
      if (entry?.retry === event.data.retry && entry.retryId === event.data.retryId) return state
      return { ...state, [key]: { retry: event.data.retry, retryId: event.data.retryId } }
    },
  })
  ctx.sessionProjections.register({
    key: 'llmRetryGuard',
    stateVersion: 1,
    stateSchema: retryGuardStateSchema,
    init: () => emptyRetryGuardState(),
    apply: applyRetryGuardEvent,
  })
  const random = internals.random ?? Math.random
  const monotonicNow = internals.now ?? (() => performance.now())
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()
  const liveTimings = new WeakMap<Session, RetryGuardLive>()
  const disposeLive = ctx.on('session/event', (session, event) => {
    const next = applyRetryGuardLiveEvent(liveTimings.get(session), event, monotonicNow())
    if (next === undefined) liveTimings.delete(session)
    else liveTimings.set(session, next)
  })

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function backoff(
    agent: Agent,
    turn: number,
    step: number,
    failure: LlmFailure,
    provider: string,
    policy: ResolvedRetryPolicy,
    policyKey: string,
    retry: number,
    retryId: RetryId,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<RequestErrorAction> {
    const fusedSignal = AbortSignal.any([signal, lifetime.signal])
    if (fusedSignal.aborted) return
    const eventData: LlmRetryEventData = policy.mode === 'normal'
      ? {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        maxRetries: policy.maxRetries,
        delayMs,
        failure,
      }
      : {
        retryId,
        turn,
        step,
        provider,
        mode: policy.mode,
        policyKey,
        retry,
        delayMs,
        failure,
      }
    agent.session.append('llm/retry', eventData)
    if (!await cancellableDelay(delayMs, fusedSignal)) return
    agent.session.append('llm/retry-started', { retryId, turn, step, retry })
    return { kind: 'retry' }
  }

  function assertGuardAllows(
    agent: Agent,
    failure: LlmFailure,
    provider: string,
    model: string,
    policy: ResolvedRetryPolicy,
    proposedDelayMs: number,
    signal: AbortSignal,
  ): void {
    // Cancellation and disposal own the outcome; the guard must not turn them
    // into a quota error or spend another request.
    if (signal.aborted || lifetime.signal.aborted) return
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmRetryGuard')
    const usage = retryGuardUsage(
      state ?? emptyRetryGuardState(),
      liveTimings.get(agent.session),
      monotonicNow(),
    )
    const trip = retryGuardTrip(policy.guard, usage, proposedDelayMs)
    if (trip !== undefined) throw retryGuardError(failure, provider, model, trip, usage)
  }

  async function recover(
    { agent, turn, step, provider, model, failure, retryPolicy: policy, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    // A refusal or an already-exhausted chain must terminate in every mode and
    // before any downstream recovery, without a retry event.
    if (MANDATORY_TERMINAL_CODES.has(failure.code)) return undefined
    if (policy === undefined) return next()
    if (policy.guard.terminalCodes.includes(failure.code)) return undefined
    if (policy.mode === 'always') {
      if (signal.aborted || lifetime.signal.aborted) return
      // The guard owns the step's quota before any downstream recovery can
      // accept another request.
      assertGuardAllows(agent, failure, provider, model, policy, 0, signal)
      const fusedSignal = AbortSignal.any([signal, lifetime.signal])
      // The loop and plugin lifetime stay open until delegated recovery settles.
      // An abort then wins before the decision or fallback can mutate later state.
      const downstream = await settleDownstream(next)
      if (fusedSignal.aborted) return
      if (downstream.type === 'error') {
        ctx.logger.warn(
          `llm-retry: provider "${provider}" always policy ignored a downstream recovery failure: %o`,
          downstream.error,
        )
      }
      if (downstream.type === 'decision' && downstream.decision?.kind === 'retry') {
        assertGuardAllows(agent, failure, provider, model, policy, 0, signal)
        return downstream.decision
      }
    } else if (!policy.retryableCodes.includes(failure.code)) {
      // This policy will not reissue, so a downstream decision owns the failure;
      // the guard still blocks a downstream retry that would exceed the quota.
      const action = await next()
      if (action?.kind === 'retry') assertGuardAllows(agent, failure, provider, model, policy, 0, signal)
      return action
    }

    const policyKey = retryPolicyKey(policy)
    const retryState = ctx.sessionProjections.stateOf(agent.session, 'llmRetry') as LlmRetryState
    const previous = retryState[retryStateKey(provider, policyKey)]
    const previousRetry = previous?.retry ?? 0
    const hintMs = providerResetHint(failure)
    const budgetExhausted = policy.mode === 'normal' && previousRetry >= policy.maxRetries
    // A provider reset wider than the maximum wait, or one the remaining
    // attempt budget cannot reach, must not spend attempts retrying inside a
    // window the provider named. Surface the wait instead of delegating,
    // because the raw provider text rarely states an actionable delay.
    if (hintMs !== undefined && policy.mode === 'normal'
      && (hintMs > policy.maxDelayMs || budgetExhausted)) {
      throw providerWaitError(failure, hintMs)
    }
    if (budgetExhausted) {
      const action = await next()
      if (action?.kind === 'retry') assertGuardAllows(agent, failure, provider, model, policy, 0, signal)
      return action
    }
    const retry = previousRetry + 1
    const retryId = previous?.retryId ?? RetryId(randomUUID())
    const delayMs = hintMs !== undefined && hintMs <= policy.maxDelayMs
      ? hintedDelay(policy, retry, hintMs, random)
      // An over-cap hint under always mode keeps the unbounded-retry guarantee.
      : localDelay(policy, retry, random)
    assertGuardAllows(agent, failure, provider, model, policy, delayMs, signal)

    return backoff(agent, turn, step, failure, provider, policy, policyKey, retry, retryId, delayMs, signal)
  }

  const disposeListener = ctx.on('agent/request-error', (
    payload,
    next: () => Promise<RequestErrorAction>,
  ) => {
    // A waterfall may have captured this callback before its registration was
    // removed. Lifetime cancellation must prevent that stale callback from
    // entering a downstream policy after disposal.
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  ctx.effect(() => async () => {
    disposeListener()
    disposeLive()
    lifetime.abort(new Error('llm-retry plugin disposed'))
    await Promise.allSettled([...active])
  }, 'llm-retry: abort and drain active recovery')
}
