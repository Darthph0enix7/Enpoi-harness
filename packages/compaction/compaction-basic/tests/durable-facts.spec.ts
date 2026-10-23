/**
 * C1: the pure Durable Facts grammar shared by the summarizer instruction and
 * the memory consumer.
 */
import { describe, expect, it } from 'vitest'
import {
  DURABLE_FACT_KINDS,
  DURABLE_FACT_MAX_CHARS,
  DURABLE_FACTS_HEADING,
  parseDurableFacts,
} from '../src/durable-facts.ts'

describe('durable facts grammar', () => {
  it('pins the frozen heading, kinds, and size cap', () => {
    expect(DURABLE_FACTS_HEADING).toBe('## Durable Facts')
    expect(DURABLE_FACT_KINDS).toEqual(['decision', 'constraint', 'requirement', 'fact'])
    expect(DURABLE_FACT_MAX_CHARS).toBe(400)
  })

  it('parses every kind in emission order and collapses whitespace', () => {
    const summary = [
      '## Primary Request and Intent',
      '- ship the thing',
      '',
      DURABLE_FACTS_HEADING,
      '- [decision] use   SQLite\n  for durable state',
      '* [Constraint] keep the public API stable',
      '  - [requirement] expose /healthz on port 3000',
      '- [fact] the config lives at /etc/enpoi/config.yml',
      '',
      '## Next Step',
      '- done',
    ].join('\n')

    expect(parseDurableFacts(summary)).toEqual([
      { kind: 'decision', text: 'use SQLite for durable state' },
      { kind: 'constraint', text: 'keep the public API stable' },
      { kind: 'requirement', text: 'expose /healthz on port 3000' },
      { kind: 'fact', text: 'the config lives at /etc/enpoi/config.yml' },
    ])
  })

  it('returns [] when the section is absent, empty, or "(none)"', () => {
    expect(parseDurableFacts('')).toEqual([])
    expect(parseDurableFacts('## Primary Request and Intent\n- something')).toEqual([])
    expect(parseDurableFacts(`${DURABLE_FACTS_HEADING}\n(none)`)).toEqual([])
    expect(parseDurableFacts(`${DURABLE_FACTS_HEADING}\n- (none)`)).toEqual([])
    expect(parseDurableFacts(`${DURABLE_FACTS_HEADING}\n- [note] not a kind`)).toEqual([])
    expect(parseDurableFacts(`${DURABLE_FACTS_HEADING}\nnot a bullet`)).toEqual([])
  })

  it('ends the section at the next level-two heading', () => {
    const summary = [
      DURABLE_FACTS_HEADING,
      '- [fact] first',
      '## Errors and Fixes',
      '- [fact] second',
    ].join('\n')
    expect(parseDurableFacts(summary)).toEqual([{ kind: 'fact', text: 'first' }])
  })

  it('drops items over the character cap and keeps the boundary item', () => {
    const boundary = 'x'.repeat(DURABLE_FACT_MAX_CHARS)
    const summary = [
      DURABLE_FACTS_HEADING,
      `- [fact] ${boundary}`,
      `- [fact] ${'y'.repeat(DURABLE_FACT_MAX_CHARS + 1)}`,
      '- [fact] kept',
    ].join('\n')
    expect(parseDurableFacts(summary)).toEqual([
      { kind: 'fact', text: boundary },
      { kind: 'fact', text: 'kept' },
    ])
  })

  it('removes case-insensitive exact duplicates but keeps distinct kinds', () => {
    const summary = [
      DURABLE_FACTS_HEADING,
      '- [fact] Use SQLite',
      '- [fact] use sqlite',
      '- [constraint] use sqlite',
    ].join('\n')
    expect(parseDurableFacts(summary)).toEqual([
      { kind: 'fact', text: 'Use SQLite' },
      { kind: 'constraint', text: 'use sqlite' },
    ])
  })

  it('never throws on hostile or non-string input', () => {
    expect(parseDurableFacts(undefined as never)).toEqual([])
    expect(parseDurableFacts(42 as never)).toEqual([])
    const hostile = new Proxy({}, {
      get() {
        throw new Error('hostile')
      },
    })
    expect(parseDurableFacts(hostile as never)).toEqual([])
  })
})
