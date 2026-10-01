import { describe, expect, it } from 'vitest'
import {
  ENTITLEMENT_GATED_CODE,
  ENTITLEMENT_GATED_EXPLANATION,
  FREE_TIER_GATED_CODE,
  FREE_TIER_GATED_EXPLANATION,
  isEntitlementGatedError,
  isFreeTierGatedError,
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
