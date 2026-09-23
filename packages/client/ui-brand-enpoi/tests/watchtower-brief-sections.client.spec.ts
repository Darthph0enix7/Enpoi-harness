import { describe, expect, it } from 'vitest'
import { parseBriefSections } from '../src/client/WatchtowerView.tsx'

describe('Watchtower brief section parser', () => {
  it('reads the keeper headers (markdown decorated, emoji decorated)', () => {
    const sections = parseBriefSections([
      '## GOAL TRAJECTORY',
      '- Ship the mobile layout',
      '### BLOCKERS',
      '- rg EAGAIN while five lanes ran',
      '## REJECTED EDGE CASES',
      '- Not deleting the plugin',
    ].join('\n'))
    expect(sections.goal).toEqual(['Ship the mobile layout'])
    expect(sections.blockers).toEqual(['rg EAGAIN while five lanes ran'])
    expect(sections.rejected).toEqual(['Not deleting the plugin'])
  })

  it('does not treat mid-sentence keywords as section switches', () => {
    const sections = parseBriefSections([
      '## GOAL TRAJECTORY',
      '- Keep the session OPEN until the wiki decisions land',
      '- The blocker report must be reproducible',
      '- A rejected idea is fine',
      '## INVARIANTS',
      '- Never fail closed',
    ].join('\n'))
    expect(sections.goal).toEqual([
      'Keep the session OPEN until the wiki decisions land',
      'The blocker report must be reproducible',
      'A rejected idea is fine',
    ])
    expect(sections.invariants).toEqual(['Never fail closed'])
    expect(sections.blockers).toBeUndefined()
    expect(sections.rejected).toBeUndefined()
  })
})
