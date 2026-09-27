import { describe, expect, it } from 'vitest'
import {
  FREE_TIER_GATED_CODE,
  FREE_TIER_GATED_EXPLANATION,
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
