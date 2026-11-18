import { describe, expect, it } from 'vitest'
import {
  RESOLVED_GROUPS_ARTIFACT, parseResolvedChains, readChainArtifact, readCoolingRoutes,
} from '../src/index.ts'

describe('peer routing chains', () => {
  it('reads the resolved-group artifact through the artifact seam', () => {
    const value = { free: { members: [{ provider: 'kilo', model: 'auto/free' }] } }
    const settings = { readArtifact: (key: string) => key === RESOLVED_GROUPS_ARTIFACT ? { value } : undefined }
    expect(readChainArtifact(settings)).toBe(value)
    expect(readChainArtifact({ readArtifact: () => undefined })).toBeUndefined()
    expect(readChainArtifact({})).toBeUndefined()
    expect(readChainArtifact(undefined)).toBeUndefined()
    expect(readChainArtifact({ readArtifact: () => { throw new Error('boom') } })).toBeUndefined()
  })

  it('parses usable chains, dropping disabled and empty groups', () => {
    const chains = parseResolvedChains({
      free: {
        id: 'free',
        label: ' Free ',
        selectors: [{ when: { zeroPrice: true }, adopt: true }],
        members: [
          { provider: ' kilo ', model: 'auto/free' },
          { provider: 'groq', model: 'llama', effort: ' high ' },
          { provider: '', model: 'x' },
          { provider: 'p', model: '  ' },
          'not-a-member',
        ],
      },
      pinned: { members: [{ provider: 'kilo', model: 'paid' }] },
      adopted: { selectorMatches: [{ adopt: true }], members: [{ provider: 'p', model: 'm' }] },
      held: { selectors: [{ adopt: false }], members: [{ provider: 'p', model: 'm' }] },
      off: { disabled: true, members: [{ provider: 'p', model: 'm' }] },
      empty: { members: [] },
      broken: { members: 'nope' },
      notARecord: 'nope',
    })
    expect([...chains.keys()]).toEqual(['free', 'pinned', 'adopted', 'held'])
    expect(chains.get('free')).toEqual({
      id: 'free',
      label: 'Free',
      dynamic: true,
      members: [
        { provider: 'kilo', model: 'auto/free' },
        { provider: 'groq', model: 'llama', effort: 'high' },
      ],
    })
    expect(chains.get('pinned')?.dynamic).toBe(false)
    expect(chains.get('pinned')?.label).toBeUndefined()
    expect(chains.get('adopted')?.dynamic).toBe(true)
    expect(chains.get('held')?.dynamic).toBe(false)
    expect(parseResolvedChains(undefined).size).toBe(0)
    expect(parseResolvedChains('nope').size).toBe(0)
  })

  it('projects only future cooling routes, last deadline winning', () => {
    const cooling = readCoolingRoutes([
      { provider: 'kilo', model: 'a', coolingUntil: 2_000 },
      { provider: 'kilo', model: 'a', coolingUntil: 3_000 },
      // A shorter deadline for the same row never shortens the recorded one.
      { provider: 'kilo', model: 'a', coolingUntil: 1_500 },
      { provider: 'kilo', model: 'b', coolingUntil: 500 },
      { provider: 'kilo', model: 'c', coolingUntil: 'later' },
      { provider: '', model: 'd', coolingUntil: 2_000 },
      { provider: 'p', model: '  ', coolingUntil: 2_000 },
      { provider: 'p', model: 'e' },
      'not-a-record',
    ], 1_000)
    expect([...cooling.entries()]).toEqual([['kilo/a', 3_000]])
    expect(readCoolingRoutes([], 1_000).size).toBe(0)
  })
})
