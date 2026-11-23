// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { resolveSectionCollapsed, toggleSearchCollapse } from '../src/client/picker-collapse.ts'

describe('picker collapse state', () => {
  const saved = new Set(['openrouter'])

  it('uses the saved preference outside a search', () => {
    expect(resolveSectionCollapsed('openrouter', false, saved, new Map())).toBe(true)
    expect(resolveSectionCollapsed('deepseek', false, saved, new Map())).toBe(false)
  })

  it('expands every matching section by default during a search', () => {
    expect(resolveSectionCollapsed('openrouter', true, saved, new Map())).toBe(false)
  })

  it('honours an explicit search-time collapse and expansion', () => {
    expect(resolveSectionCollapsed('openrouter', true, saved, new Map([['openrouter', true]]))).toBe(true)
    expect(resolveSectionCollapsed('deepseek', true, saved, new Map([['deepseek', false]]))).toBe(false)
  })

  it('flips one section without mutating the previous map', () => {
    const empty = new Map<string, boolean>()
    const collapsed = toggleSearchCollapse(empty, 'openrouter')
    expect(collapsed.get('openrouter')).toBe(true)
    expect(empty.size).toBe(0)
    const expanded = toggleSearchCollapse(collapsed, 'openrouter')
    expect(expanded.get('openrouter')).toBe(false)
    expect(collapsed.get('openrouter')).toBe(true)
    const untouched = toggleSearchCollapse(new Map([['a', true]]), 'b')
    expect(untouched.get('a')).toBe(true)
    expect(untouched.get('b')).toBe(true)
  })
})
