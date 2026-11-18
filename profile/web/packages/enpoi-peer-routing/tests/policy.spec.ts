import { describe, expect, it } from 'vitest'
import {
  matchesPattern, policyAllowsChain, policyAllowsEffort, policyAllowsModel,
} from '../src/index.ts'

/** Local glob semantics: `*` only, anchored, every other character literal. */
describe('peer routing policy globs', () => {
  it('spans any run of characters, `/` included', () => {
    expect(matchesPattern('kilo/*:free', 'kilo/nvidia/ultra:free')).toBe(true)
    expect(matchesPattern('*', 'provider/model/with/slashes')).toBe(true)
    expect(matchesPattern('openrouter/*', 'openrouter/minimax/m2.7:free')).toBe(true)
  })

  it('is anchored at both ends', () => {
    expect(matchesPattern('kilo/*', 'kilo/a')).toBe(true)
    expect(matchesPattern('kilo/a', 'xkilo/a')).toBe(false)
    expect(matchesPattern('kilo/a', 'kilo/ab')).toBe(false)
  })

  it('treats every other character literally, regex metacharacters included', () => {
    expect(matchesPattern('p/a.b', 'p/a.b')).toBe(true)
    // A literal dot is not a regex wildcard.
    expect(matchesPattern('p/a.b', 'p/aXb')).toBe(false)
    expect(matchesPattern('p/a+b', 'p/a+b')).toBe(true)
    expect(matchesPattern('p/a+b', 'p/aaab')).toBe(false)
    expect(matchesPattern('p/(x)', 'p/(x)')).toBe(true)
    expect(matchesPattern('p/[x]', 'p/[x]')).toBe(true)
    expect(matchesPattern('p/a?b', 'p/a?b')).toBe(true)
    expect(matchesPattern('p/a?b', 'p/axb')).toBe(false)
  })

  it('allows only chains explicitly listed, never globs', () => {
    expect(policyAllowsChain({ allowChains: ['free'] }, 'free')).toBe(true)
    expect(policyAllowsChain({ allowChains: ['f*'] }, 'free')).toBe(false)
    expect(policyAllowsChain({ allowChains: [] }, 'free')).toBe(false)
    expect(policyAllowsChain({}, 'free')).toBe(false)
  })

  it('selects no pinned model without an allowModels pattern', () => {
    expect(policyAllowsModel({ allowModels: ['kilo/*:free'] }, 'kilo', 'nvidia/ultra:free')).toBe(true)
    expect(policyAllowsModel({ allowModels: ['kilo/*:free'] }, 'openrouter', 'x:free')).toBe(false)
    expect(policyAllowsModel({ allowModels: [] }, 'kilo', 'x')).toBe(false)
    expect(policyAllowsModel({}, 'kilo', 'x')).toBe(false)
  })

  it('permits any effort unless a list is declared', () => {
    expect(policyAllowsEffort({}, 'high')).toBe(true)
    expect(policyAllowsEffort({ allowReasoningEfforts: ['minimal', 'medium'] }, 'medium')).toBe(true)
    expect(policyAllowsEffort({ allowReasoningEfforts: ['minimal'] }, 'high')).toBe(false)
    expect(policyAllowsEffort({ allowReasoningEfforts: [] }, 'high')).toBe(false)
  })
})
