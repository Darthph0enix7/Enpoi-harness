import { describe, expect, it } from 'vitest'
import {
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

describe('provider retry policy', () => {
  it('resolves immutable normal defaults', () => {
    const policy = resolveRetryPolicy(undefined, 'provider.retryPolicy')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['EMPTY_RESPONSE', 'STREAM_CUT', 'STREAM_CLOSED', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      guard: {
        maxElapsedMs: 600_000,
        maxNoWorkElapsedMs: 300_000,
        terminalCodes: [],
      },
    })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.guard)).toBe(true)
    expect(Object.isFrozen(policy.guard.terminalCodes)).toBe(true)
    if (policy.mode !== 'normal') throw new Error('expected normal policy')
    expect(Object.isFrozen(policy.retryableCodes)).toBe(true)
  })

  it('resolves and detaches a configured normal policy', () => {
    const retryableCodes = ['BUSY']
    const config: RetryPolicyConfig = {
      mode: 'normal',
      maxRetries: 4,
      retryableCodes,
      backoff: {
        initialDelayMs: 25,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
    }

    const policy = resolveRetryPolicy(config, 'provider.retryPolicy')
    retryableCodes.push('LATE')

    expect(policy).toEqual({
      mode: 'normal',
      maxRetries: 4,
      retryableCodes: ['BUSY'],
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0,
      guard: {
        maxElapsedMs: 600_000,
        maxNoWorkElapsedMs: 300_000,
        terminalCodes: [],
      },
    })
  })

  it('resolves always mode with default backoff', () => {
    expect(resolveRetryPolicy({ mode: 'always' }, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      guard: {
        maxElapsedMs: 600_000,
        maxNoWorkElapsedMs: 300_000,
        terminalCodes: [],
      },
    })
    expect(RetryPolicySchema).toBeDefined()
  })

  it('ignores normal-only fields retained after switching to always mode', () => {
    const layered = {
      mode: 'always',
      maxRetries: 5,
      retryableCodes: ['SERVER'],
    } as unknown as RetryPolicyConfig

    expect(resolveRetryPolicy(layered, 'provider.retryPolicy')).toEqual({
      mode: 'always',
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
      guard: {
        maxElapsedMs: 600_000,
        maxNoWorkElapsedMs: 300_000,
        terminalCodes: [],
      },
    })
  })

  it('resolves and detaches a configured guard', () => {
    const terminalCodes = ['AUTH']
    const policy = resolveRetryPolicy({
      mode: 'normal',
      guard: { maxElapsedMs: 0, maxNoWorkElapsedMs: 60_000, terminalCodes },
    }, 'provider.retryPolicy')
    terminalCodes.push('LATE')

    expect(policy.guard).toEqual({
      maxElapsedMs: 0,
      maxNoWorkElapsedMs: 60_000,
      terminalCodes: ['AUTH'],
    })
    expect(Object.isFrozen(policy.guard)).toBe(true)
    expect(Object.isFrozen(policy.guard.terminalCodes)).toBe(true)
  })

  it('accepts and defaults a guard through the config schema', () => {
    expect(RetryPolicySchema({
      mode: 'normal',
      guard: { maxNoWorkElapsedMs: 0, terminalCodes: ['AUTH'] },
    })).toMatchObject({
      mode: 'normal',
      guard: {
        maxElapsedMs: 600_000,
        maxNoWorkElapsedMs: 0,
        terminalCodes: ['AUTH'],
      },
    })
  })

  it('resolves always mode with a configured guard', () => {
    expect(resolveRetryPolicy({
      mode: 'always',
      guard: { maxElapsedMs: 1_000, maxNoWorkElapsedMs: 0 },
    }, 'provider.retryPolicy').guard).toEqual({
      maxElapsedMs: 1_000,
      maxNoWorkElapsedMs: 0,
      terminalCodes: [],
    })
  })

  it('rejects a custom retryable code that the guard makes terminal', () => {
    expect(() => resolveRetryPolicy({
      mode: 'normal',
      retryableCodes: ['POLICY_REFUSAL'],
    }, 'provider.retryPolicy')).toThrow(/terminal code "POLICY_REFUSAL"/)
    expect(() => resolveRetryPolicy({
      mode: 'normal',
      retryableCodes: ['MODEL_CHAIN_EXHAUSTED'],
    }, 'provider.retryPolicy')).toThrow(/terminal code "MODEL_CHAIN_EXHAUSTED"/)
    expect(() => resolveRetryPolicy({
      mode: 'normal',
      retryableCodes: ['SERVER', 'AUTH'],
      guard: { terminalCodes: ['AUTH'] },
    }, 'provider.retryPolicy')).toThrow(/terminal code "AUTH"/)
  })

  it.each([
    [{ mode: 'normal', maxRetries: -1 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: 1.5 }, /maxRetries/],
    [{ mode: 'normal', maxRetries: Number.MAX_SAFE_INTEGER + 1 }, /maxRetries/],
    [{ mode: 'always', backoff: { initialDelayMs: 0 } }, /initialDelayMs/],
    [{ mode: 'normal', backoff: { maxDelayMs: Number.POSITIVE_INFINITY } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /initialDelayMs/],
    [{ mode: 'always', backoff: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } }, /maxDelayMs/],
    [{ mode: 'normal', backoff: { initialDelayMs: 20, maxDelayMs: 10 } }, /less than or equal/],
    [{ mode: 'always', backoff: { jitterRatio: 1.1 } }, /jitterRatio/],
    [{ mode: 'normal', retryableCodes: [] }, /must not be empty/],
    [{ mode: 'normal', retryableCodes: ['SERVER', 'SERVER'] }, /duplicates/],
    [{ mode: 'normal', retryableCodes: [''] }, /non-empty strings/],
    [{ mode: 'normal', retryableCodes: [429] }, /non-empty strings/],
    [{ mode: 'normal', maxRetires: 1 }, /unknown key "maxRetires"/],
    [{ mode: 'always', backoff: { initialDelay: 1 } }, /unknown key "initialDelay"/],
    [{ mode: 'sometimes' }, /mode must be "normal" or "always"/],
    [{ mode: 'normal', guard: { maxElapsedMs: -1 } }, /maxElapsedMs/],
    [{ mode: 'always', guard: { maxElapsedMs: 1.5 } }, /maxElapsedMs/],
    [{ mode: 'normal', guard: { maxElapsedMs: MAX_TIMER_DELAY_MS + 1 } }, /maxElapsedMs/],
    [{ mode: 'normal', guard: { maxNoWorkElapsedMs: -1 } }, /maxNoWorkElapsedMs/],
    [{ mode: 'always', guard: { maxNoWorkElapsedMs: Number.POSITIVE_INFINITY } }, /maxNoWorkElapsedMs/],
    [{ mode: 'normal', guard: { terminalCodes: ['AUTH', 'AUTH'] } }, /terminalCodes must not contain duplicates/],
    [{ mode: 'normal', guard: { terminalCodes: [''] } }, /terminalCodes must contain only non-empty strings/],
    [{ mode: 'normal', guard: { terminalCode: ['AUTH'] } }, /unknown key "terminalCode"/],
  ] as const)('rejects invalid policy %#', (config, message) => {
    expect(() => {
      resolveRetryPolicy(config as unknown as RetryPolicyConfig, 'provider.retryPolicy')
    }).toThrow(message)
  })
})
