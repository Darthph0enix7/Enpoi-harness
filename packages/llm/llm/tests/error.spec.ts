import { describe, expect, it } from 'vitest'
import {
  ENTITLEMENT_GATED_CODE,
  ENTITLEMENT_GATED_EXPLANATION,
  FREE_TIER_GATED_CODE,
  FREE_TIER_GATED_EXPLANATION,
  isEntitlementGatedError,
  isFreeTierGatedError,
  isRequestSizeFailure,
} from '@deepseek-ai/dsh-llm'

describe('isFreeTierGatedError', () => {
  it('recognizes the OpenCode FreeTierError body and its policy phrase', () => {
    expect(isFreeTierGatedError(
      '403 {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode"}',
    )).toBe(true)
    expect(isFreeTierGatedError('Generation.FreeTierError')).toBe(true)
    expect(isFreeTierGatedError('free tier can only be used from within OpenCode')).toBe(true)
  })

  it('leaves generic auth, quota, and free-tier mentions to their own classifiers', () => {
    expect(isFreeTierGatedError('401 Unauthorized: invalid api key')).toBe(false)
    expect(isFreeTierGatedError('429 rate limit exceeded on the free tier')).toBe(false)
    expect(isFreeTierGatedError('introductory free tier credits exhausted')).toBe(false)
  })

  it('pins the stable code and the user-facing explanation', () => {
    expect(FREE_TIER_GATED_CODE).toBe('FREE_TIER_GATED')
    expect(FREE_TIER_GATED_EXPLANATION).toContain('only be used from within OpenCode')
    expect(FREE_TIER_GATED_EXPLANATION).toContain('paid OpenCode Go key')
  })
})

describe('isEntitlementGatedError', () => {
  it('recognizes subscription and plan-entitlement gates', () => {
    expect(isEntitlementGatedError('An active OpenCode Go subscription is required to use Go models.')).toBe(true)
    expect(isEntitlementGatedError('You need an active subscription to use this model')).toBe(true)
    expect(isEntitlementGatedError('Your plan does not include this model.')).toBe(true)
    expect(isEntitlementGatedError("Your current plan doesn't include claude-opus")).toBe(true)
    expect(isEntitlementGatedError('not entitled to use this model')).toBe(true)
    expect(isEntitlementGatedError('Upgrade your plan to access it')).toBe(true)
  })

  it('leaves payment, quota, and free-tier mentions to their own classifiers', () => {
    expect(isEntitlementGatedError('402 payment required: insufficient credits')).toBe(false)
    expect(isEntitlementGatedError('429 rate limit exceeded')).toBe(false)
    expect(isEntitlementGatedError('free tier can only be used from within OpenCode')).toBe(false)
  })

  it('pins the stable code and the identity-gate explanation', () => {
    expect(ENTITLEMENT_GATED_CODE).toBe('ENTITLEMENT_GATED')
    expect(ENTITLEMENT_GATED_EXPLANATION).toContain('plan does not include')
    expect(ENTITLEMENT_GATED_EXPLANATION).toContain('identity whose plan grants it')
  })
})

describe('isRequestSizeFailure', () => {
  it('recognizes the pool vocabulary, payload-size wording, and empty-body 400s', () => {
    expect(isRequestSizeFailure(new Error('llm-pi-ai: provider "kilo" request failed without failover (INVALID_REQUEST): 400 "The upstream provider was unable to process the request"'))).toBe(true)
    expect(isRequestSizeFailure(new Error('413 payload too large'))).toBe(true)
    expect(isRequestSizeFailure(new Error('maximum context length is 8192 tokens'))).toBe(true)
    expect(isRequestSizeFailure(new Error('token limit exceeded'))).toBe(true)
    // The pool classifies a 400 as INVALID_REQUEST; the code alone carries the class.
    const classified = Object.assign(new Error('request failed'), { code: 'INVALID_REQUEST' })
    expect(isRequestSizeFailure(classified)).toBe(true)
    expect(isRequestSizeFailure(Object.assign(new Error('context overflow'), { code: 'CONTEXT_WINDOW_EXCEEDED' }))).toBe(true)
  })

  it('follows the cause chain and leaves unrelated failures alone', () => {
    expect(isRequestSizeFailure(new Error('summary failed', {
      cause: Object.assign(new Error('upstream refused'), { code: 'INVALID_REQUEST' }),
    }))).toBe(true)
    expect(isRequestSizeFailure(new Error('429 rate limit exceeded'))).toBe(false)
    expect(isRequestSizeFailure(Object.assign(new Error('unauthorized'), { code: 'AUTH' }))).toBe(false)
    expect(isRequestSizeFailure('plain string failure')).toBe(false)
  })

  it('pins the reported wording without a circular-cause hang', () => {
    const circular = new Error('loop')
    circular.cause = circular
    expect(isRequestSizeFailure(circular)).toBe(false)
  })
})
