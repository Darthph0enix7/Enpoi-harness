/**
 * Durable clock and no-work accounting for the quota guard on one open model
 * step. The fold reads only existing session events, so a restored or replayed
 * log derives the same accounting without a new event type or format change.
 *
 * @module @deepseek-ai/dsh-llm-retry/guard
 */

import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryGuard } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One open step's attempt timing and failed no-work accumulation. */
export interface RetryGuardState {
  /** Turn owning the open step. */
  readonly turn?: number | undefined
  /** Step being guarded. */
  readonly step?: number | undefined
  /** Unix epoch milliseconds when the open step started. */
  readonly stepStartedAt?: number | undefined
  /** Unix epoch milliseconds when the current attempt started. */
  readonly attemptStartedAt?: number | undefined
  /** Unix epoch milliseconds when the latest failed attempt settled. */
  readonly lastAttemptEndTime?: number | undefined
  /** Duration of the latest failed attempt in milliseconds. */
  readonly lastAttemptMs: number
  /** Whether the latest failed attempt produced a model token. */
  readonly lastAttemptContent: boolean
  /** Failed-attempt milliseconds since the last content-bearing attempt. */
  readonly noWorkMs: number
  /** Failed attempts settled inside the open step, across providers and policies. */
  readonly failedAttempts: number
}

/** Process-local attempt timing and no-work accumulation for one live session. */
export interface RetryGuardLive {
  /** Monotonic milliseconds when the open step started. */
  readonly stepStartMono: number
  /** Monotonic milliseconds when the current attempt started. */
  readonly attemptStartMono: number
  /** Monotonic failed-attempt milliseconds since the last content-bearing attempt. */
  readonly noWorkMonoMs: number
}

/** Elapsed and failed no-work time derived for one guard decision. */
export interface RetryGuardUsage {
  /** Attempt-plus-wait milliseconds in the open step. */
  readonly elapsedMs: number
  /** Failed-attempt milliseconds since the last content-bearing attempt. */
  readonly noWorkMs: number
  /** Failed attempts settled inside the open step. */
  readonly failedAttempts: number
}

/** Guard limit that stopped a failure-triggered reissue. */
export type RetryGuardLimit = 'maxElapsedMs' | 'maxNoWorkElapsedMs'

/** One guard limit reached by the proposed retry. */
export interface RetryGuardTrip {
  /** Resolved guard field that was reached. */
  readonly limit: RetryGuardLimit
  /** Configured limit in milliseconds. */
  readonly limitMs: number
  /** Observed value in milliseconds, including the proposed delay for `maxElapsedMs`. */
  readonly observedMs: number
  /** Delay the policy intended to wait before reissuing the request. */
  readonly proposedDelayMs: number
}

/**
 * Build the empty fold for a session with no open step.
 * @returns the initial guard state.
 */
export function emptyRetryGuardState(): RetryGuardState {
  return Object.freeze({
    lastAttemptMs: 0,
    lastAttemptContent: false,
    noWorkMs: 0,
    failedAttempts: 0,
  })
}

/**
 * Fold one committed session event into the open step's guard state.
 * @param state - guard state covering every prior event.
 * @param event - the next committed session event.
 * @returns the next guard state, or the same reference when the event is unrelated.
 */
export function applyRetryGuardEvent(
  state: RetryGuardState,
  event: SessionEvent,
): RetryGuardState {
  switch (event.type) {
    case 'step/start':
      return {
        turn: event.data.turn,
        step: event.data.step,
        stepStartedAt: event.time,
        attemptStartedAt: event.time,
        lastAttemptEndTime: event.time,
        lastAttemptMs: 0,
        lastAttemptContent: false,
        noWorkMs: 0,
        failedAttempts: 0,
      }
    case 'turn/start':
    case 'step/end':
    case 'turn/end':
      return emptyRetryGuardState()
    case 'llm/retry-started':
      if (state.turn !== event.data.turn || state.step !== event.data.step) return state
      return { ...state, attemptStartedAt: event.time }
    case 'assistant/attempt': {
      if (state.turn !== event.data.turn || state.step !== event.data.step) return state
      const startedAt = state.attemptStartedAt ?? state.lastAttemptEndTime ?? event.time
      const durationMs = Math.max(0, event.time - startedAt)
      const content = assistantStreamFirstTokenTime(event.data.stream) !== undefined
      return {
        ...state,
        attemptStartedAt: event.time,
        lastAttemptEndTime: event.time,
        lastAttemptMs: durationMs,
        lastAttemptContent: content,
        noWorkMs: content ? 0 : state.noWorkMs + durationMs,
        failedAttempts: state.failedAttempts + 1,
      }
    }
    default:
      return state
  }
}

/**
 * Fold one live session event into process-local monotonic timing. The no-work
 * total accumulates every failed attempt observed since the last content-bearing
 * settlement, so a wall-clock adjustment during one attempt cannot hide earlier
 * failed attempts in the same step.
 * @param live - current live timing, or undefined before this process observed a step.
 * @param event - the committed session event.
 * @param nowMono - current monotonic milliseconds.
 * @returns the next live timing, or undefined after a step or turn boundary.
 */
export function applyRetryGuardLiveEvent(
  live: RetryGuardLive | undefined,
  event: SessionEvent,
  nowMono: number,
): RetryGuardLive | undefined {
  switch (event.type) {
    case 'step/start':
      return { stepStartMono: nowMono, attemptStartMono: nowMono, noWorkMonoMs: 0 }
    case 'llm/retry-started':
      return live === undefined ? undefined : { ...live, attemptStartMono: nowMono }
    case 'assistant/attempt': {
      if (live === undefined) return undefined
      const durationMs = Math.max(0, nowMono - live.attemptStartMono)
      const content = assistantStreamFirstTokenTime(event.data.stream) !== undefined
      return {
        stepStartMono: live.stepStartMono,
        attemptStartMono: nowMono,
        noWorkMonoMs: content ? 0 : live.noWorkMonoMs + durationMs,
      }
    }
    case 'step/end':
    case 'turn/end':
      return undefined
    default:
      return live
  }
}

/**
 * Combine durable fold times with process-local monotonic timing. Each value
 * takes the larger observation, so a wall-clock adjustment cannot shorten the
 * elapsed window and a replay has no monotonic timing to lose.
 * @param state - durable guard state for the open step.
 * @param live - process-local monotonic timing, when this process observed the step.
 * @param nowMono - current monotonic milliseconds.
 * @returns elapsed and failed no-work milliseconds for one guard decision.
 */
export function retryGuardUsage(
  state: RetryGuardState,
  live: RetryGuardLive | undefined,
  nowMono: number,
): RetryGuardUsage {
  const durableElapsed = state.stepStartedAt === undefined
    ? 0
    : Math.max(0, (state.lastAttemptEndTime ?? state.stepStartedAt) - state.stepStartedAt)
  const monoElapsed = live === undefined ? 0 : Math.max(0, nowMono - live.stepStartMono)
  return {
    elapsedMs: Math.max(durableElapsed, monoElapsed),
    noWorkMs: Math.max(state.noWorkMs, live?.noWorkMonoMs ?? 0),
    failedAttempts: state.failedAttempts,
  }
}

/**
 * Check the resolved guard against one proposed retry.
 * @param guard - resolved provider guard.
 * @param usage - derived elapsed and no-work values for the open step.
 * @param proposedDelayMs - delay the policy intends to wait before reissuing.
 * @returns the reached limit, or undefined when the proposed retry is allowed.
 */
export function retryGuardTrip(
  guard: ResolvedRetryGuard,
  usage: RetryGuardUsage,
  proposedDelayMs: number,
): RetryGuardTrip | undefined {
  if (guard.maxNoWorkElapsedMs > 0 && usage.noWorkMs >= guard.maxNoWorkElapsedMs) {
    return {
      limit: 'maxNoWorkElapsedMs',
      limitMs: guard.maxNoWorkElapsedMs,
      observedMs: usage.noWorkMs,
      proposedDelayMs,
    }
  }
  if (guard.maxElapsedMs > 0) {
    const observedMs = usage.elapsedMs + proposedDelayMs
    if (observedMs >= guard.maxElapsedMs) {
      return {
        limit: 'maxElapsedMs',
        limitMs: guard.maxElapsedMs,
        observedMs,
        proposedDelayMs,
      }
    }
  }
  return undefined
}
