import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogRulesEngine } from 'dsh-enpoi-catalog-rules'
import {
  apply, builtinChainsOf, Config, ModelChainsResolver, ROUTE_HEALTH_ARTIFACT,
  SHIPPED_BUILTIN_CHAINS, SHIPPED_FREE_CHAIN,
  type SelectorExpander,
} from '../src/index.ts'

/**
 * Built-in group specs: the composition ships a `free` group, so the product
 * works on a fresh profile with no settings write. A settings row with the
 * same id replaces the built-in entirely; a disabled row is an opt-out;
 * deleting the row restores the shipped definition.
 */

const CATALOGUE = [
  { provider: 'groq', model: 'free-tool' },
  { provider: 'groq', model: 'free-small' },
]

function makeResolver(
  initial: Record<string, unknown>,
  options: { links?: Array<{ provider: string; model: string }>; builtin?: Record<string, unknown> } = {},
) {
  const doc: { chains: Record<string, unknown> } = { chains: { ...initial } }
  const expander: SelectorExpander = () => ({ links: options.links ?? CATALOGUE })
  const resolver = new ModelChainsResolver(() => doc.chains, {
    expandSelector: expander,
    builtinChains: options.builtin ?? builtinChainsOf(undefined),
    warn: () => {},
  })
  return { doc, resolver }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shipped built-in inventory', () => {
  it('ships the free group keyed by price, not by provider or model name', () => {
    // The schema normalizes the default (an empty `links` array materializes).
    expect(Config({}).builtinChains).toMatchObject({ free: SHIPPED_FREE_CHAIN })
    expect(Config({}).builtinChains?.free.links).toEqual([])
    expect(SHIPPED_FREE_CHAIN.label).toBe('Free')
    expect(SHIPPED_FREE_CHAIN.disabled).toBe(false)
    // Price is the meaning: no id/name matching, and an unknown price cannot
    // join a free group.
    expect(SHIPPED_FREE_CHAIN.selectors).toEqual([{
      when: {
        zeroPrice: true,
        tools: true,
        gated: false,
        visible: true,
        minContextWindow: 65_536,
      },
      adopt: true,
    }])
    expect(JSON.stringify(SHIPPED_FREE_CHAIN)).not.toMatch(/idGlob|nameGlob|provider/)
  })

  it('validates a cordis.yml override of the inventory', () => {
    const config = Config({
      builtinChains: {
        local: { label: 'Local', links: [{ provider: 'p', model: 'm' }] },
      },
    })
    expect(config.builtinChains?.local).toEqual({
      label: 'Local',
      links: [{ provider: 'p', model: 'm' }],
      selectors: [],
      disabled: false,
    })
    // A malformed group is refused at load instead of shipping a broken group.
    expect(() => Config({ builtinChains: { bad: { links: [{ provider: 'p' }] } } })).toThrow()
  })

  it('falls back to the shipped map when the plugin is applied without config', () => {
    expect(builtinChainsOf(undefined)).toBe(SHIPPED_BUILTIN_CHAINS)
  })
})

describe('built-in free group against the real rules engine', () => {
  it('adopts only free, tool-capable, visible, non-gated models with a large context', () => {
    const catalogue = [
      { provider: 'groq', id: 'free-tool', contextWindow: 200_000, tools: true, cost: { input: 0, output: 0 } },
      { provider: 'groq', id: 'hidden-free', contextWindow: 200_000, tools: true, cost: { input: 0, output: 0 } },
      { provider: 'kilo', id: 'gated-free', contextWindow: 200_000, tools: true, cost: { input: 0, output: 0 }, gated: true },
      { provider: 'groq', id: 'small-free', contextWindow: 32_768, tools: true, cost: { input: 0, output: 0 } },
      { provider: 'p', id: 'paid-tool', contextWindow: 200_000, tools: true, cost: { input: 1, output: 1 } },
      { provider: 'mystery', id: 'price-unknown', contextWindow: 200_000, tools: true },
      { provider: 'groq', id: 'llama', contextWindow: 200_000, cost: { input: 0, output: 0 } },
    ]
    const engine = new CatalogRulesEngine(() => undefined, () => catalogue, () => ({ groq: ['hidden-free'] }))
    const resolver = new ModelChainsResolver(() => ({}), {
      expandSelector: raw => engine.expandRawSelector(raw),
      builtinChains: builtinChainsOf(undefined),
      warn: () => {},
    })
    // Price is the meaning, and every exclusion has its reason: a hidden pin,
    // a gate, too small a context, a paid route, and an unknown price.
    expect(resolver.resolve('free')!.links).toEqual([{ provider: 'groq', model: 'free-tool' }])
    expect(resolver.resolvedGroups()['free']!.members).toEqual([{ provider: 'groq', model: 'free-tool' }])
  })
})

describe('built-in group resolution', () => {
  it('resolves and lists the free group with no settings row', () => {
    const { resolver } = makeResolver({})
    const chain = resolver.resolve('free')
    expect(chain?.label).toBe('Free')
    expect(chain?.links).toEqual(CATALOGUE)
    const group = resolver.resolvedGroups()['free']!
    expect(group.source).toBe('builtin')
    expect(group.overridesBuiltin).toBeUndefined()
    expect(group.members).toEqual(CATALOGUE)
    expect(resolver.preview('free')?.links).toEqual(CATALOGUE)
  })

  it('reports a settings row that shadows the built-in and never merges the two', () => {
    const { resolver } = makeResolver({
      free: { label: 'Mine', links: [{ provider: 'p', model: 'm' }] },
    })
    const group = resolver.resolvedGroups()['free']!
    expect(group.source).toBe('settings')
    expect(group.overridesBuiltin).toBe(true)
    expect(group.members).toEqual([{ provider: 'p', model: 'm' }])
    expect(Object.keys(resolver.resolvedGroups())).toEqual(['free'])
  })

  it('treats a disabled settings row as an opt-out that does not fall back', () => {
    const { resolver } = makeResolver({
      free: { disabled: true, links: [{ provider: 'p', model: 'm' }] },
    })
    expect(resolver.resolve('free')).toBeUndefined()
    expect(resolver.resolvedGroups()['free']).toMatchObject({
      source: 'settings',
      overridesBuiltin: true,
      disabled: true,
    })
  })

  it('restores the built-in after the shadowing row is deleted', () => {
    const { doc, resolver } = makeResolver({
      free: { label: 'Mine', links: [{ provider: 'p', model: 'm' }] },
    })
    expect(resolver.resolve('free')?.label).toBe('Mine')
    delete doc.chains.free
    resolver.refresh()
    expect(resolver.resolve('free')?.label).toBe('Free')
    expect(resolver.resolvedGroups()['free']!.source).toBe('builtin')
  })

  it('honors a retired built-in and keeps it listed', () => {
    const { resolver } = makeResolver({}, {
      builtin: { free: { ...SHIPPED_FREE_CHAIN, disabled: true } },
    })
    expect(resolver.resolve('free')).toBeUndefined()
    expect(resolver.resolvedGroups()['free']).toMatchObject({ source: 'builtin', disabled: true })
  })

  it('answers undefined for an id no built-in or row declares', () => {
    const { resolver } = makeResolver({})
    expect(resolver.resolve('stable')).toBeUndefined()
    expect(resolver.preview('stable')).toBeUndefined()
  })
})

describe('route-health artifact', () => {
  /** Mount the plugin over a fake settings channel and an optional llm view. */
  function mount(view?: () => readonly unknown[]) {
    const artifacts: Array<{ key: string; value: unknown }> = []
    const listeners = new Map<string, () => void>()
    const settings = {
      get: () => ({ chains: {} }),
      publishArtifact: (key: string, value: unknown) => {
        artifacts.push({ key, value })
        return artifacts.length
      },
    }
    const ctx = {
      get: (name: string) => name === 'settings'
        ? settings
        : name === 'llm' && view !== undefined
          ? { routeHealth: view }
          : undefined,
      provide: () => () => undefined,
      on: (event: string, callback: () => void) => {
        listeners.set(event, callback)
        return () => undefined
      },
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    apply(ctx as never)
    return { artifacts, listeners }
  }

  it('publishes the runtime health view and republishes on its change event', () => {
    const view = vi.fn(() => [{ provider: 'p', model: 'm', cooling: true }])
    const { artifacts, listeners } = mount(view)
    expect(artifacts).toContainEqual({
      key: ROUTE_HEALTH_ARTIFACT,
      value: [{ provider: 'p', model: 'm', cooling: true }],
    })
    listeners.get('llm/route-health-updated')!()
    expect(view).toHaveBeenCalledTimes(2)
  })

  it('publishes no health artifact when no llm runtime is mounted', () => {
    const { artifacts } = mount()
    expect(artifacts.some(entry => entry.key === ROUTE_HEALTH_ARTIFACT)).toBe(false)
  })
})
