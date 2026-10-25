/**
 * Shared resolved-group parse parity: the picker registry, the Providers
 * editor, and every seat read one parser over the host's resolved projection
 * (`modelChains.resolved`). The stored vocabulary cannot drift between them.
 * The effort trim is canonical: a valid effort is trimmed, a non-string or
 * blank one is absent (the link keeps inheriting).
 */
import { describe, expect, it } from 'vitest'
import {
  parseModelGroup, parseModelGroupList, parseModelGroups, parseResolvedModelGroup,
} from '../src/model-groups.ts'

/** The projection-only fields every parsed group carries, at their defaults. */
const PROJECTION = {
  selectors: [],
  selectorMatches: [],
  candidates: [],
  warnings: [],
  source: 'settings',
} as const

describe('parseModelGroups', () => {
  it('parses a full group in stored order', () => {
    expect(parseModelGroups({
      stable: {
        id: 'stable',
        label: 'Stable',
        links: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          { provider: 'opencode-go', model: 'mimo-v2.5' },
        ],
        members: [
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
      members: [
        { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
        { provider: 'opencode-go', model: 'mimo-v2.5' },
      ],
      attempts: 3,
      onCut: 'continue',
      disabled: true,
      ...PROJECTION,
    }])
  })

  it('carries the projection source and the built-in shadow marker', () => {
    const builtin = parseModelGroup('free', {
      label: 'Free',
      selectors: [{ when: { zeroPrice: true }, adopt: true }],
      members: [{ provider: 'groq', model: 'free-tool' }],
      source: 'builtin',
    })
    expect(builtin).toMatchObject({ source: 'builtin', label: 'Free' })
    expect(builtin?.overridesBuiltin).toBeUndefined()
    const shadow = parseModelGroup('free', {
      label: 'Mine',
      links: [{ provider: 'p', model: 'm' }],
      source: 'settings',
      overridesBuiltin: true,
    })
    expect(shadow).toMatchObject({ source: 'settings', overridesBuiltin: true })
    // An absent/unknown source stays an operator-owned settings group.
    expect(parseModelGroup('stable', { source: 'weird' })?.source).toBe('settings')
  })

  it('drops entries with an empty id or a non-object value', () => {
    expect(parseModelGroups({
      '': { label: 'empty id' },
      array: [],
      scalar: 'nope',
      nullish: null,
      kept: { label: 'Kept' },
    })).toEqual([{
      id: 'kept', label: 'Kept', links: [], members: [], attempts: 2, onCut: 'failover', disabled: false, ...PROJECTION,
    }])
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
      {
        id: 'stable', label: 'stable', links: [{ provider: 'a', model: 'm' }], members: [{ provider: 'a', model: 'm' }],
        attempts: 2, onCut: 'failover', disabled: false, ...PROJECTION,
      },
      {
        id: 'loose', label: 'loose', links: [], members: [], attempts: 2, onCut: 'failover', disabled: false, ...PROJECTION,
      },
    ])
  })

  it('returns no groups for non-object values', () => {
    expect(parseModelGroups(null)).toEqual([])
    expect(parseModelGroups([])).toEqual([])
    expect(parseModelGroups('nope')).toEqual([])
    expect(parseModelGroups(7)).toEqual([])
    expect(parseModelGroups(undefined)).toEqual([])
  })

  it('parses a selector-only group with its resolved members and kept-back candidates', () => {
    const [group] = parseModelGroups({
      free: {
        id: 'free',
        label: 'Free tools',
        links: [],
        selectors: [{ when: { zeroPrice: true, tools: true }, adopt: false }],
        selectorMatches: [{
          index: 0,
          when: { zeroPrice: true, tools: true },
          adopt: false,
          links: [{ provider: 'groq', model: 'free-tool' }],
          warnings: [],
        }],
        members: [{ provider: 'groq', model: 'free-tool' }],
        candidates: [{ provider: 'groq', model: 'newer-tool' }],
        warnings: ['1 new selector match awaiting adoption'],
        source: 'settings',
      },
    })
    expect(group).toEqual({
      id: 'free',
      label: 'Free tools',
      links: [],
      selectors: [{ when: { zeroPrice: true, tools: true }, adopt: false }],
      selectorMatches: [{
        index: 0,
        when: { zeroPrice: true, tools: true },
        adopt: false,
        links: [{ provider: 'groq', model: 'free-tool' }],
        warnings: [],
      }],
      members: [{ provider: 'groq', model: 'free-tool' }],
      candidates: [{ provider: 'groq', model: 'newer-tool' }],
      warnings: ['1 new selector match awaiting adoption'],
      attempts: 2,
      onCut: 'failover',
      disabled: false,
      source: 'settings',
    })
  })

  it('drops shapeless selectors while keeping a valid one', () => {
    const [group] = parseModelGroups({
      mixed: {
        selectors: [null, 'nope', { when: {} }, { when: ['not-an-object'] }, { when: { tools: true }, label: ' tools ' }],
      },
    })
    expect(group!.selectors).toEqual([{ when: { tools: true }, adopt: false, label: 'tools' }])
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
      id: 'solo',
      label: 'solo',
      links: [{ provider: 'a', model: 'm' }],
      members: [{ provider: 'a', model: 'm' }],
      attempts: 2,
      onCut: 'failover',
      disabled: false,
      ...PROJECTION,
    })
  })
})

describe('parseResolvedModelGroup / parseModelGroupList', () => {
  it('takes the group id from the entry itself', () => {
    expect(parseResolvedModelGroup({ id: 'free', selectors: [], members: [] })).toMatchObject({ id: 'free' })
    expect(parseResolvedModelGroup({ id: '' })).toBeUndefined()
    expect(parseResolvedModelGroup(null)).toBeUndefined()
  })

  it('parses the picker mirror and tolerates a pre-projection entry', () => {
    expect(parseModelGroupList([
      { id: 'stable', label: 'Stable', links: [{ provider: 'a', model: 'm' }] },
      { id: '', label: 'dropped' },
      'nope',
    ])).toEqual([{
      id: 'stable',
      label: 'Stable',
      links: [{ provider: 'a', model: 'm' }],
      members: [{ provider: 'a', model: 'm' }],
      attempts: 2,
      onCut: 'failover',
      disabled: false,
      ...PROJECTION,
    }])
    expect(parseModelGroupList(null)).toEqual([])
    expect(parseModelGroupList({})).toEqual([])
  })
})
