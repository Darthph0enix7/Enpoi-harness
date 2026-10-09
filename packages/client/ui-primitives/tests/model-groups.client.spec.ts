/**
 * Shared `chains` parse parity: the picker registry and the Providers editor
 * read one parser, so the stored vocabulary cannot drift between them. The
 * effort trim is canonical: a valid effort is trimmed, a non-string or blank
 * one is absent (the link keeps inheriting).
 */
import { describe, expect, it } from 'vitest'
import { parseModelGroup, parseModelGroups } from '../src/model-groups.ts'

describe('parseModelGroups', () => {
  it('parses a full group in stored order', () => {
    expect(parseModelGroups({
      stable: {
        label: 'Stable',
        links: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          { provider: 'opencode-go', model: 'mimo-v2.5' },
        ],
        attempts: 3,
        onCut: 'continue',
        disabled: true,
      },
    })).toEqual([{
      id: 'stable',
      label: 'Stable',
      links: [
        { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
        { provider: 'opencode-go', model: 'mimo-v2.5' },
      ],
      attempts: 3,
      onCut: 'continue',
      disabled: true,
    }])
  })

  it('drops entries with an empty id or a non-object value', () => {
    expect(parseModelGroups({
      '': { label: 'empty id' },
      array: [],
      scalar: 'nope',
      nullish: null,
      kept: { label: 'Kept' },
    })).toEqual([{ id: 'kept', label: 'Kept', links: [], attempts: 2, onCut: 'failover', disabled: false }])
  })

  it('trims a valid link effort and drops a non-string or blank one', () => {
    const groups = parseModelGroups({
      stable: {
        links: [
          { provider: 'a', model: 'm', effort: ' high ' },
          { provider: 'b', model: 'm', effort: 7 },
          { provider: 'c', model: 'm', effort: '   ' },
        ],
      },
    })
    // A non-string or blank effort is absent, never a stored empty string.
    expect(groups[0]!.links).toEqual([
      { provider: 'a', model: 'm', effort: 'high' },
      { provider: 'b', model: 'm' },
      { provider: 'c', model: 'm' },
    ])
  })

  it('defaults label, attempts, onCut, and disabled, and drops malformed links', () => {
    expect(parseModelGroups({
      stable: {
        label: '',
        links: [null, 'nope', [], { provider: '', model: 'm' }, { provider: 'a', model: '' }, { provider: 'a', model: 'm' }],
        attempts: 0,
        onCut: 'nope',
      },
      loose: { attempts: 2.5, links: 'nope' },
    })).toEqual([
      { id: 'stable', label: 'stable', links: [{ provider: 'a', model: 'm' }], attempts: 2, onCut: 'failover', disabled: false },
      { id: 'loose', label: 'loose', links: [], attempts: 2, onCut: 'failover', disabled: false },
    ])
  })

  it('returns no groups for non-object values', () => {
    expect(parseModelGroups(null)).toEqual([])
    expect(parseModelGroups([])).toEqual([])
    expect(parseModelGroups('nope')).toEqual([])
    expect(parseModelGroups(7)).toEqual([])
    expect(parseModelGroups(undefined)).toEqual([])
  })
})

describe('parseModelGroup', () => {
  it('returns undefined for an empty id or a non-object raw value', () => {
    expect(parseModelGroup('', { label: 'x' })).toBeUndefined()
    expect(parseModelGroup('id', null)).toBeUndefined()
    expect(parseModelGroup('id', [])).toBeUndefined()
    expect(parseModelGroup('id', 'nope')).toBeUndefined()
  })

  it('parses one group without touching siblings', () => {
    expect(parseModelGroup('solo', { links: [{ provider: 'a', model: 'm' }] })).toEqual({
      id: 'solo', label: 'solo', links: [{ provider: 'a', model: 'm' }], attempts: 2, onCut: 'failover', disabled: false,
    })
  })
})
