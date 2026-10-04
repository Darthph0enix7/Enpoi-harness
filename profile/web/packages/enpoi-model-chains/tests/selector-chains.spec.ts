import { describe, expect, it, vi } from 'vitest'
import { ModelChainsResolver, parseChainEntry, type SelectorExpander } from '../src/index.ts'

/**
 * Selector-chain specs: a group may mix explicit links with live selectors,
 * evaluated through the catalogRules expander seam. Adopt semantics: `true`
 * (default) inlines live matches; `false` holds new matches as candidates.
 */

/** One resolver over a mutable chain document plus a scripted expander. */
function makeResolver(initial: Record<string, unknown>, expander: SelectorExpander) {
  const doc: { chains: Record<string, unknown> } = { chains: { ...initial } }
  const warnings: string[] = []
  const resolver = new ModelChainsResolver(() => doc.chains, { expandSelector: expander, warn: line => warnings.push(line) })
  return { doc, resolver, warnings }
}

describe('enpoi-model-chains selector parsing', () => {
  it('accepts a selector-only chain and freezes the selectors', () => {
    const chain = parseChainEntry('free', {
      selectors: [{ when: { zeroPrice: true }, adopt: false, label: ' free ' }],
    }, () => {})
    expect(chain).toBeDefined()
    expect(chain!.links).toEqual([])
    expect(chain!.selectors).toEqual([{ when: { zeroPrice: true }, adopt: false, label: 'free' }])
    // Auto-adoption is opt-in: an unmarked selector defaults to adopt false.
    expect(parseChainEntry('watch', { selectors: [{ when: { tools: true } }] }, () => {})!.selectors![0]!.adopt).toBe(false)
    expect(Object.isFrozen(chain!.selectors)).toBe(true)
    expect(Object.isFrozen(chain!.selectors![0])).toBe(true)
  })

  it('drops malformed selectors with a warning and still refuses a member-less chain', () => {
    const warn = vi.fn()
    const chain = parseChainEntry('mixed', {
      links: [{ provider: 'p', model: 'm' }],
      selectors: [{ when: {} }, 'nope', { when: { tools: true } }],
    }, warn)
    expect(chain!.selectors).toHaveLength(1)
    const lines = warn.mock.calls.map(call => String(call[0]))
    expect(lines.some(line => line.includes('dropped 2 malformed selector(s)'))).toBe(true)
    expect(lines.filter(line => line.includes('is not an object'))).toHaveLength(1)
    expect(lines.filter(line => line.includes('no "when" object'))).toHaveLength(1)
    expect(parseChainEntry('nothing', { links: [], selectors: [] }, () => {})).toBeUndefined()
    expect(parseChainEntry('missing', { label: 'x' }, () => {})).toBeUndefined()
  })
})

describe('enpoi-model-chains selector resolution', () => {
  const expander: SelectorExpander = () => ({
    links: [{ provider: 'groq', model: 'free-tool' }],
  })

  it('appends selector matches after explicit links, deduplicated and frozen', () => {
    const { resolver } = makeResolver({
      stable: {
        links: [{ provider: 'p', model: 'explicit' }, { provider: 'groq', model: 'free-tool', effort: 'high' }],
        selectors: [{ when: { zeroPrice: true } }],
      },
    }, expander)
    const chain = resolver.resolve('stable')!
    expect(chain.links.map(link => `${link.provider}/${link.model}`)).toEqual(['p/explicit', 'groq/free-tool'])
    // The explicit entry keeps its effort; the duplicate match does not replace it.
    expect(chain.links[1]!.effort).toBe('high')
    expect(Object.isFrozen(chain.links)).toBe(true)
    expect(Object.isFrozen(chain.links[1])).toBe(true)
  })

  it('warns and keeps the explicit links when a selector matches nothing', () => {
    const empty: SelectorExpander = () => ({ links: [], warnings: ['selector "x" matched no catalogue entries — group unchanged\n'] })
    const { resolver, warnings } = makeResolver({ stable: { links: [{ provider: 'p', model: 'm' }], selectors: [{ when: { provider: 'ghost' } }] } }, empty)
    expect(resolver.resolve('stable')!.links).toHaveLength(1)
    resolver.resolve('stable')
    expect(warnings).toHaveLength(1) // written once, deduped across resolves
  })

  it('fails open with a warning when a selector-only chain matches nothing', () => {
    const empty: SelectorExpander = () => ({ links: [] })
    const { resolver, warnings } = makeResolver({ free: { selectors: [{ when: { zeroPrice: true } }] } }, empty)
    expect(resolver.resolve('free')).toBeUndefined()
    expect(warnings.some(line => line.includes('has no usable links or selector matches'))).toBe(true)
  })
})

describe('enpoi-model-chains adoption and preview', () => {
  it('includes every live match and announces newly joined models (adopt: true)', () => {
    let links = [{ provider: 'groq', model: 'one' }]
    const { resolver, warnings } = makeResolver(
      { free: { selectors: [{ when: { zeroPrice: true }, adopt: true }] } },
      () => ({ links }),
    )
    expect(resolver.resolve('free')!.links).toHaveLength(1)
    links = [{ provider: 'groq', model: 'one' }, { provider: 'groq', model: 'two' }]
    const second = resolver.resolve('free')!
    expect(second.links.map(link => link.model)).toEqual(['one', 'two'])
    expect(warnings.filter(line => line.includes('a new model joined chain "free"'))).toHaveLength(1)
    expect(String(warnings.find(line => line.includes('joined')))).toContain('groq/two')
  })

  it('holds new matches as preview candidates until opt-in (adopt: false)', () => {
    let links = [{ provider: 'groq', model: 'one' }]
    const { resolver, warnings } = makeResolver(
      { free: { selectors: [{ when: { zeroPrice: true }, adopt: false, label: 'free' }] } },
      () => ({ links }),
    )
    expect(resolver.resolve('free')!.links.map(link => link.model)).toEqual(['one'])
    links = [{ provider: 'groq', model: 'one' }, { provider: 'groq', model: 'two' }]
    expect(resolver.resolve('free')!.links.map(link => link.model)).toEqual(['one'])
    const preview = resolver.preview('free')!
    expect(preview.links.map(link => link.model)).toEqual(['one'])
    expect(preview.candidates.map(link => link.model)).toEqual(['two'])
    expect(warnings.filter(line => line.includes('joined'))).toHaveLength(0)
    // The held-back candidate is announced (once) instead of silently ignored.
    resolver.resolve('free')
    resolver.resolve('free')
    const candidateLines = warnings.filter(line => line.includes('awaiting adoption'))
    expect(candidateLines).toHaveLength(1)
    expect(String(candidateLines[0])).toContain('groq/two')
  })

  it('re-baselines adopt:false selectors when the document is refreshed', () => {
    let links = [{ provider: 'groq', model: 'one' }]
    const { doc, resolver } = makeResolver(
      { free: { selectors: [{ when: { zeroPrice: true }, adopt: false }] } },
      () => ({ links }),
    )
    resolver.resolve('free')
    links = [{ provider: 'groq', model: 'one' }, { provider: 'groq', model: 'two' }]
    expect(resolver.resolve('free')!.links).toHaveLength(1)
    // Operator edits the document: the edit re-baselines the selector.
    doc.chains.free = { selectors: [{ when: { zeroPrice: true }, adopt: false }] }
    resolver.refresh()
    expect(resolver.resolve('free')!.links.map(link => link.model)).toEqual(['one', 'two'])
  })

  it('previews what changed since the last resolve without consuming it', () => {
    let links = [{ provider: 'groq', model: 'one' }]
    const { resolver } = makeResolver(
      { free: { selectors: [{ when: { zeroPrice: true }, adopt: true }] } },
      () => ({ links }),
    )
    resolver.resolve('free')
    links = [{ provider: 'groq', model: 'two' }]
    const preview = resolver.preview('free')!
    expect(preview.links.map(link => link.model)).toEqual(['two'])
    expect(preview.previous!.map(link => link.model)).toEqual(['one'])
    expect(preview.added).toEqual(['groq/two'])
    expect(preview.removed).toEqual(['groq/one'])
    // Preview did not consume the change: the next resolve still announces it once.
    expect(resolver.preview('free')!.previous!.map(link => link.model)).toEqual(['one'])
    expect(resolver.resolve('free')!.links.map(link => link.model)).toEqual(['two'])
  })

  it('fails open when the catalogRules service is absent', async () => {
    const { apply } = await import('../src/index.ts')
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let provided: { resolve?: (id: string) => unknown, preview?: (id: string) => unknown } | undefined
    const doc = { chains: { free: { links: [{ provider: 'p', model: 'm' }], selectors: [{ when: { zeroPrice: true } }] } } }
    const ctx = {
      get: (ns: string) => ns === 'settings' ? { get: () => doc } : undefined,
      provide: (serviceName: string, value: { resolve?: (id: string) => unknown }) => {
        expect(serviceName).toBe('modelChains')
        provided = value
        return () => undefined
      },
      on: () => () => undefined,
    }
    apply(ctx as never)
    const resolved = provided!.resolve!('free') as { links: unknown[] }
    expect(resolved.links).toHaveLength(1)
    expect(provided!.preview!('free')).toBeDefined()
    expect(write.mock.calls.map(call => String(call[0])).some(line => line.includes('catalogRules service absent'))).toBe(true)
  })
})
