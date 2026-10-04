import { describe, expect, it, vi } from 'vitest'
import { expandSelector, parseGroupSelector, selectorMatchKey } from '../src/selectors.ts'
import type { CatalogEntry } from '../src/rules.ts'

/** One catalogue entry with cost/context defaults. */
function entry(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return { provider, id, contextWindow: 200_000, input: ['text'], reasoning: false, tools: true, ...overrides }
}

const FREE_TOOL_SELECTOR = { zeroPrice: true, tools: true, minContextWindow: 32_768, noTraining: true }

describe('enpoi-catalog-rules group selectors — parse', () => {
  it('parses a selector, defaults adopt to false, and freezes it', () => {
    const selector = parseGroupSelector({ when: { tools: true }, label: ' tools ' }, () => {})
    expect(selector).toEqual({ when: { tools: true }, adopt: false, label: 'tools' })
    expect(Object.isFrozen(selector)).toBe(true)
    expect(parseGroupSelector({ when: { tools: true }, adopt: true }, () => {})!.adopt).toBe(true)
  })

  it('drops malformed selectors with a warning', () => {
    const warn = vi.fn()
    expect(parseGroupSelector('nope', warn)).toBeUndefined()
    expect(parseGroupSelector({}, warn)).toBeUndefined()
    expect(parseGroupSelector({ when: { tools: 'yes' } }, warn)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('enpoi-catalog-rules group selectors — expansion', () => {
  it('orders matches best-first: cheapest, then larger context, then id', () => {
    const entries = [
      entry('p', 'pricey', { cost: { input: 3, output: 3 }, contextWindow: 1_000_000 }),
      entry('p', 'mid-paid', { cost: { input: 0.5, output: 1 }, contextWindow: 100_000 }),
      entry('p', 'free-small', { cost: { input: 0, output: 0 }, contextWindow: 32_768 }),
      entry('p', 'free-big', { cost: { input: 0, output: 0 }, contextWindow: 1_000_000 }),
      entry('p', 'unknown-price', { contextWindow: 500_000 }),
    ]
    const expansion = expandSelector({ when: { tools: true } }, entries)
    expect(expansion.links.map(link => link.model)).toEqual(['free-big', 'free-small', 'mid-paid', 'pricey', 'unknown-price'])
    expect(expansion.matched).toBe(5)
    expect(expansion.warnings).toEqual([])
  })

  it('resolves the free tool-capable no-training chain, excluding unknown privacy', () => {
    const entries = [
      entry('groq', 'llama-3.3-70b', { cost: { input: 0, output: 0 } }),
      entry('google', 'gemini-free', { cost: { input: 0, output: 0 } }),
      entry('mystery', 'mystery-free', { cost: { input: 0, output: 0 } }),
      entry('groq', 'small-free', { cost: { input: 0, output: 0 }, contextWindow: 8_192 }),
    ]
    const expansion = expandSelector({ when: FREE_TOOL_SELECTOR }, entries)
    expect(expansion.links.map(selectorMatchKey)).toEqual(['groq/llama-3.3-70b'])
  })

  it('returns no matches for a paid entry and warns', () => {
    const expansion = expandSelector({ when: FREE_TOOL_SELECTOR }, [entry('p', 'paid', { cost: { input: 1, output: 1 } })])
    expect(expansion.links).toEqual([])
    expect(expansion.warnings).toHaveLength(1)
    expect(String(expansion.warnings[0])).toContain('matched no catalogue entries — group unchanged')
  })

  it('deduplicates repeated entries and uses document privacy overrides', () => {
    const entries = [
      entry('p', 'dup', { cost: { input: 0, output: 0 } }),
      entry('p', 'dup', { cost: { input: 0, output: 0 } }),
      entry('mystery', 'paid-but-private', { cost: {} }),
    ]
    const expansion = expandSelector({ when: { noTraining: true } }, entries, { providers: { mystery: 'no-train' } })
    expect(expansion.links.map(selectorMatchKey)).toEqual(['mystery/paid-but-private'])
  })
})
