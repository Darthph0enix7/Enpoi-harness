/**
 * Provider-owned request-retry policy configuration and resolution.
 *
 * Adapters expose one resolved policy per registered provider route; the
 * optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
 *
 * @module @deepseek-ai/dsh-llm/retry-policy
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { STREAM_CUT_CODE } from './assembler.ts'
import { EMPTY_RESPONSE_CODE, STREAM_CLOSED_CODE } from './error.ts'

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1
/** Default attempt-plus-wait ceiling for one open step's quota guard. */
export const DEFAULT_RETRY_GUARD_MAX_ELAPSED_MS = 600_000
/** Default failed no-work ceiling for one open step's quota guard. */
export const DEFAULT_RETRY_GUARD_MAX_NO_WORK_ELAPSED_MS = 300_000

/**
 * Canonical provider-neutral code for a request a provider refused under its
 * content, safety, or usage policy. The refusal is a property of the request,
 * so retry policy does not automatically resend it: this code is terminal in
 * every mode, including `always`, and downstream recovery cannot make it
 * retryable.
 */
export const POLICY_REFUSAL_CODE = 'POLICY_REFUSAL'

/** Terminal failure code for a chain whose eligible links have already failed. */
export const MODEL_CHAIN_EXHAUSTED_CODE = 'MODEL_CHAIN_EXHAUSTED'

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  EMPTY_RESPONSE_CODE,
  // A stream cut (truncated tool-call arguments, or a truncated answer) is a
  // provider-side failure, so a retried step restarts cleanly on the next link.
  STREAM_CUT_CODE,
  // A provider stream that ends without a terminal event is the same
  // provider-side truncation as a committed cut: retry the step.
  STREAM_CLOSED_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Bounded exponential backoff with symmetric jitter around each local delay. */
export interface BackoffConfig {
  /** Initial local exponential-backoff delay in milliseconds (default 500). */
  initialDelayMs?: number
  /** Maximum locally scheduled or accepted provider delay in milliseconds (default 10000). */
  maxDelayMs?: number
  /** Symmetric random multiplier range around one (default 0.1). */
  jitterRatio?: number
}

/**
 * Quota guard applied before any failure-triggered reissue in one open step.
 * Elapsed time counts every attempt and every retry wait on every provider and
 * policy used by the step, including time spent inside router pools and model
 * chains. Both exhausted limits terminate the failure with its original code,
 * status, request id, reset hint, provider, and model instead of scheduling
 * another request.
 */
export interface RetryGuardConfig {
  /** Maximum attempt-plus-wait milliseconds in one open step through the next delay (default 600000; 0 disables). */
  maxElapsedMs?: number
  /** Maximum failed-attempt milliseconds without a model token since the last content (default 300000; 0 disables). */
  maxNoWorkElapsedMs?: number
  /** Additional failure codes that must terminate without a retry in every mode. */
  terminalCodes?: string[]
}

/** Current bounded transient retry behavior for one provider route. */
export interface NormalRetryPolicyConfig {
  /** Retry only configured transient failure codes. */
  mode: 'normal'
  /** Maximum eligible retries after the first request (default 5). */
  maxRetries?: number
  /** Stable failure codes eligible for this policy. */
  retryableCodes?: string[]
  /** Local exponential-backoff and jitter configuration. */
  backoff?: BackoffConfig
  /** Quota guard for failure-triggered reissues in one open step. */
  guard?: RetryGuardConfig
}

/** Unbounded retry behavior for every model-request failure on one provider route. */
export interface AlwaysRetryPolicyConfig {
  /** Retry every model-request failure until success, cancellation, or disposal. */
  mode: 'always'
  /** Local exponential-backoff and jitter configuration. */
  backoff?: BackoffConfig
  /** Quota guard; its terminal codes and elapsed limits apply before downstream recovery. */
  guard?: RetryGuardConfig
}

/** Provider-owned model-request retry policy configuration. */
export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

/** Fully resolved backoff shared by both retry modes. */
export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Fully resolved quota guard captured with one provider policy. */
export interface ResolvedRetryGuard {
  readonly maxElapsedMs: number
  readonly maxNoWorkElapsedMs: number
  readonly terminalCodes: readonly string[]
}

/** Fully resolved bounded transient retry policy. */
export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
  readonly guard: ResolvedRetryGuard
}

/** Fully resolved unbounded retry policy. */
export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always'
  readonly guard: ResolvedRetryGuard
}

/** Immutable provider policy captured when its adapter route is registered. */
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

const backoffSchema: z<BackoffConfig> = z.object({
  initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
})

const guardSchema: z<RetryGuardConfig> = z.object({
  maxElapsedMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_RETRY_GUARD_MAX_ELAPSED_MS),
  maxNoWorkElapsedMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_RETRY_GUARD_MAX_NO_WORK_ELAPSED_MS),
  terminalCodes: z.array(z.string()).default([]),
})

const normalPolicySchema: z<NormalRetryPolicyConfig> = z.object({
  mode: z.const('normal').required(),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  backoff: backoffSchema,
  guard: guardSchema,
})

const alwaysPolicySchema: z<AlwaysRetryPolicyConfig> = z.object({
  mode: z.const('always').required(),
  backoff: backoffSchema,
  guard: guardSchema,
})

/** Cordis schema embedded by each concrete provider configuration. */
export const RetryPolicySchema: z<RetryPolicyConfig> = z.union([
  normalPolicySchema,
  alwaysPolicySchema,
])

const NORMAL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'mode', 'maxRetries', 'retryableCodes', 'backoff', 'guard',
])
// Layered configuration can retain normal-only fields after switching modes;
// always mode ignores those inactive values while still rejecting unknown keys.
const ALWAYS_POLICY_KEYS: ReadonlySet<string> = new Set([
  'mode', 'maxRetries', 'retryableCodes', 'backoff', 'guard',
])
const BACKOFF_KEYS: ReadonlySet<string> = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio'])
const GUARD_KEYS: ReadonlySet<string> = new Set([
  'maxElapsedMs', 'maxNoWorkElapsedMs', 'terminalCodes',
])

function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function resolveBackoff(config: BackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  if (config !== undefined) validateKeys(config, BACKOFF_KEYS, path)
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  }

  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

function resolveGuard(config: RetryGuardConfig | undefined, path: string): ResolvedRetryGuard {
  if (config !== undefined) validateKeys(config, GUARD_KEYS, path)
  const maxElapsedMs = config?.maxElapsedMs ?? DEFAULT_RETRY_GUARD_MAX_ELAPSED_MS
  const maxNoWorkElapsedMs = config?.maxNoWorkElapsedMs ?? DEFAULT_RETRY_GUARD_MAX_NO_WORK_ELAPSED_MS
  const terminalCodes = config?.terminalCodes ?? []

  if (!Number.isSafeInteger(maxElapsedMs) || maxElapsedMs < 0 || maxElapsedMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxElapsedMs must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(maxNoWorkElapsedMs)
    || maxNoWorkElapsedMs < 0 || maxNoWorkElapsedMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxNoWorkElapsedMs must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (terminalCodes.some(code => typeof code !== 'string' || code.length === 0)) {
    throw new Error(`${path}.terminalCodes must contain only non-empty strings`)
  }
  if (new Set(terminalCodes).size !== terminalCodes.length) {
    throw new Error(`${path}.terminalCodes must not contain duplicates`)
  }

  return Object.freeze({
    maxElapsedMs,
    maxNoWorkElapsedMs,
    terminalCodes: Object.freeze([...terminalCodes]),
  })
}

/**
 * Validate, default, and detach one provider-owned retry policy.
 * @param config - optional provider configuration; omission selects normal defaults.
 * @param path - diagnostic path naming the provider config that owns the value.
 * @returns an immutable policy safe to capture in provider registration state.
 */
export function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path: string,
): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({
      mode: 'normal',
      maxRetries: DEFAULT_MAX_RETRIES,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      ...resolveBackoff(undefined, `${path}.backoff`),
      guard: resolveGuard(undefined, `${path}.guard`),
    })
  }

  switch (config.mode) {
    case 'normal': {
      validateKeys(config, NORMAL_POLICY_KEYS, path)
      const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
      const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
      const guard = resolveGuard(config.guard, `${path}.guard`)
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
      }
      if (retryableCodes.length === 0) {
        throw new Error(`${path}.retryableCodes must not be empty`)
      }
      if (retryableCodes.some(code => typeof code !== 'string' || code.length === 0)) {
        throw new Error(`${path}.retryableCodes must contain only non-empty strings`)
      }
      if (new Set(retryableCodes).size !== retryableCodes.length) {
        throw new Error(`${path}.retryableCodes must not contain duplicates`)
      }
      const terminal = new Set([
        POLICY_REFUSAL_CODE,
        MODEL_CHAIN_EXHAUSTED_CODE,
        ...guard.terminalCodes,
      ])
      const conflict = retryableCodes.find(code => terminal.has(code))
      if (conflict !== undefined) {
        throw new Error(`${path}.retryableCodes must not contain terminal code "${conflict}"`)
      }
      return Object.freeze({
        mode: 'normal',
        maxRetries,
        retryableCodes: Object.freeze([...retryableCodes]),
        ...resolveBackoff(config.backoff, `${path}.backoff`),
        guard,
      })
    }
    case 'always':
      validateKeys(config, ALWAYS_POLICY_KEYS, path)
      return Object.freeze({
        mode: 'always',
        ...resolveBackoff(config.backoff, `${path}.backoff`),
        guard: resolveGuard(config.guard, `${path}.guard`),
      })
    default:
      throw new Error(`${path}.mode must be "normal" or "always"`)
  }
}
