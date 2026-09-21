// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { chainAttribution, chainOfRecord } from '../src/client/chat/chain-attribution.ts'

const GROUPS = [
  {
    id: 'stable',
    label: 'Stable',
    links: [
      { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
      { provider: 'opencode-go', model: 'mimo-v2.5' },
    ],
  },
]

afterEach(() => {
  localStorage.clear()
})

describe('chain attribution', () => {
  it('renders the group with the answering model when the first link answered', () => {
    localStorage.setItem('dsh_model_groups_v1', JSON.stringify(GROUPS))
    expect(chainAttribution('stable', 'gemini-3.8-flash-tiered')).toEqual({
      chain: 'stable',
      badge: 'Stable (gemini-3.8-flash-tiered)',
    })
  })

  it('renders the arrow when the answering model differs from the first link', () => {
    localStorage.setItem('dsh_model_groups_v1', JSON.stringify(GROUPS))
    expect(chainAttribution('stable', 'mimo-v2.5')?.badge).toBe('Stable → mimo-v2.5')
  })

  it('falls back to the plain model when no group id was carried', () => {
    expect(chainAttribution(undefined, 'mimo-v2.5')).toBeUndefined()
    expect(chainAttribution('stable', undefined)).toBeUndefined()
  })

  it('dangling group id: keeps the id as the label instead of failing', () => {
    localStorage.setItem('dsh_model_groups_v1', JSON.stringify(GROUPS))
    expect(chainAttribution('retired', 'some-model')?.badge).toBe('retired (some-model)')
  })

  it('reads only string chain ids off durable records', () => {
    expect(chainOfRecord({ chain: 'stable' })).toBe('stable')
    expect(chainOfRecord({ chain: 42 })).toBeUndefined()
    expect(chainOfRecord({})).toBeUndefined()
    expect(chainOfRecord(undefined)).toBeUndefined()
  })
})
