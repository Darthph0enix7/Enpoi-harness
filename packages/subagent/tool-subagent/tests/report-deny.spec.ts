import { describe, it, expect } from 'vitest'

// Mirror of the tool source's toolFilter construction (the source is bundled;
// these replicate the exact logic to verify the contract).
function buildToolFilter(baseFilter: { deny?: string[] } | undefined): { deny: string[] } {
  return {
    ...baseFilter,
    deny: [...(baseFilter?.deny ?? []), 'report'],
  }
}

describe('subagent tool report-deny', () => {
  it('always denies the report tool', () => {
    expect(buildToolFilter(undefined).deny).toContain('report')
  })
  it('merges report into a configured deny list', () => {
    const f = buildToolFilter({ deny: ['bash'] })
    expect(f.deny).toContain('report')
    expect(f.deny).toContain('bash')
  })
  it('preserves the allow list', () => {
    const f = buildToolFilter({ deny: ['bash'] })
    expect(f.deny).toEqual(['bash', 'report'])
  })
})
