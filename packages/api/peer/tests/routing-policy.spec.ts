import { describe, expect, it } from 'vitest'
import {
  clampTokenCeiling,
  isRoutingPattern,
  matchesPattern,
  policyAllowsChain,
  policyAllowsModel,
} from '../src/routing-policy.ts'
import type { PeerRoutingPolicy } from '../src/types.ts'

describe('routing pattern matching', () => {
  it('anchors a pattern at both ends and spans slashes with `*`', () => {
    expect(matchesPattern('kilo/kilo-auto/free', 'kilo', 'kilo-auto/free')).toBe(true)
    expect(matchesPattern('kilo/*:free', 'kilo', 'nvidia/nemotron:free')).toBe(true)
    expect(matchesPattern('kilo/*:free', 'kilo', 'nvidia/nemotron:free')).toBe(true)
    // Anchored: a prefix or suffix alone never matches.
    expect(matchesPattern('kilo', 'kilo', 'kilo-auto/free')).toBe(false)
    expect(matchesPattern(':free', 'kilo', 'kilo-auto/free')).toBe(false)
    expect(matchesPattern('*:free', 'kilo', 'kilo-auto/free:beta')).toBe(false)
    expect(matchesPattern('kilo/*', 'openrouter', 'kilo-auto/free')).toBe(false)
    // A bare wildcard matches every route.
    expect(matchesPattern('*', 'kilo', 'anything/at/all')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    expect(matchesPattern('a.b/c', 'a.b', 'c')).toBe(true)
    expect(matchesPattern('a.b/c', 'axb', 'c')).toBe(false)
    expect(matchesPattern('a+b/c', 'a+b', 'c')).toBe(true)
    expect(matchesPattern('a+b/c', 'aab', 'c')).toBe(false)
    expect(matchesPattern('a(b)/c', 'a(b)', 'c')).toBe(true)
    expect(matchesPattern('a(b)/c', 'ab', 'c')).toBe(false)
    expect(matchesPattern('a[b]/c', 'a[b]', 'c')).toBe(true)
    expect(matchesPattern('a?/c', 'a?', 'c')).toBe(true)
    expect(matchesPattern('a?/c', 'ab', 'c')).toBe(false)
    expect(matchesPattern('a|b/c', 'a|b', 'c')).toBe(true)
    expect(matchesPattern('a|b/c', 'a', 'c')).toBe(false)
    expect(matchesPattern('a^b$c/d', 'a^b$c', 'd')).toBe(true)
    expect(matchesPattern('a\\b/c', 'a\\b', 'c')).toBe(true)
  })

  it('validates the routing charset', () => {
    for (const valid of ['free', 'kilo/*:free', 'openrouter/*:free', '@scope/model-1.2_3', 'a+b/c']) {
      expect(isRoutingPattern(valid)).toBe(true)
    }
    for (const invalid of ['', 'a b', 'a!b', 'a,b', '(a)', 'a?b', 'a[b]', 'a\\b']) {
      expect(isRoutingPattern(invalid)).toBe(false)
    }
  })
})

describe('policy helpers', () => {
  it('allows only chain ids the policy names, exactly', () => {
    const policy: PeerRoutingPolicy = { allowChains: ['free', 'cheap'] }
    expect(policyAllowsChain(policy, 'free')).toBe(true)
    expect(policyAllowsChain(policy, 'cheap')).toBe(true)
    expect(policyAllowsChain(policy, 'paid')).toBe(false)
    // Chain ids are exact values; a wildcard entry is not a glob.
    expect(policyAllowsChain({ allowChains: ['*'] }, 'free')).toBe(false)
    expect(policyAllowsChain({}, 'free')).toBe(false)
  })

  it('allows a pinned route only when a pattern matches it', () => {
    const policy: PeerRoutingPolicy = { allowModels: ['scripted/*', 'kilo/*:free'] }
    expect(policyAllowsModel(policy, 'scripted', 'routed')).toBe(true)
    expect(policyAllowsModel(policy, 'kilo', 'nvidia/nemotron:free')).toBe(true)
    expect(policyAllowsModel(policy, 'openai', 'gpt-5')).toBe(false)
    // An absent or empty list selects nothing.
    expect(policyAllowsModel({}, 'scripted', 'routed')).toBe(false)
    expect(policyAllowsModel({ allowModels: [] }, 'scripted', 'routed')).toBe(false)
  })

  it('passes a requested ceiling through without a policy cap', () => {
    expect(clampTokenCeiling(undefined, 500)).toBe(500)
    expect(clampTokenCeiling(undefined, undefined)).toBeUndefined()
    expect(clampTokenCeiling({}, 500)).toBe(500)
    expect(clampTokenCeiling({}, undefined)).toBeUndefined()
  })

  it('caps an absent ceiling and refuses one above the policy', () => {
    const policy: PeerRoutingPolicy = { maxTotalTokens: 1000 }
    expect(clampTokenCeiling(policy, undefined)).toBe(1000)
    expect(clampTokenCeiling(policy, 400)).toBe(400)
    expect(clampTokenCeiling(policy, 1000)).toBe(1000)
    expect(clampTokenCeiling(policy, 1001)).toBe('over')
  })
})
