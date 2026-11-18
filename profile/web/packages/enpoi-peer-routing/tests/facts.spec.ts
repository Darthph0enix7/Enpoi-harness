import { describe, expect, it } from 'vitest'
import type { CatalogEntry } from 'dsh-enpoi-catalog-rules'
import {
  projectReasoningEfforts, projectRouteFacts, readGatedCatalogue, readPrivacyOverrides, readRawEfforts,
  readZeroPriceKeys, routeKey, zeroPriceKeysOf, type CatalogRulesSeam, type RouteFacts,
} from '../src/index.ts'
import { entry, free, paid, unpriced } from './helpers.ts'

/** A settings reader whose `llm-pi-ai` namespace answers the given document. */
function settingsFor(llm: unknown, orchestration?: unknown) {
  return {
    get: (ns: string) => {
      if (ns === 'llm-pi-ai') return llm
      if (ns === 'enpoi-orchestration') return orchestration
      return undefined
    },
  }
}

/** Facts for one entry, with all defaults explicit. */
function factsOf(entryValue: CatalogEntry, options: {
  zeroPrice?: readonly string[]
  efforts?: Record<string, unknown>
  privacy?: Parameters<typeof projectRouteFacts>[0]['privacy']
  gated?: boolean
} = {}): RouteFacts {
  const projected = projectRouteFacts({
    entries: [{ ...entryValue, ...(options.gated === true ? { gated: true } : {}) }],
    rawEfforts: new Map(Object.entries(options.efforts ?? {})),
    zeroPriceKeys: options.zeroPrice === undefined ? undefined : new Set(options.zeroPrice),
    privacy: options.privacy,
  })
  const facts = projected.get(routeKey(entryValue.provider, entryValue.id))
  expect(facts).toBeDefined()
  return facts!
}

describe('peer routing facts', () => {
  it('projects capability, price, gated, and training facts honestly', () => {
    const zero = factsOf(free('kilo', 'auto/free', {
      contextWindow: 131_072,
      input: ['text', 'image'],
    }), { zeroPrice: ['kilo/auto/free'], efforts: { 'kilo/auto/free': { minimal: 'minimal', medium: 'medium' } } })
    expect(zero).toEqual({
      provider: 'kilo',
      model: 'auto/free',
      tools: true,
      vision: true,
      contextWindow: 131_072,
      zeroPrice: true,
      gated: false,
      deprecated: false,
      trainsOnData: 'yes',
      reasoningEfforts: ['medium', 'minimal'],
    })

    // Unknown price never becomes "not free" or "free": it is unproven.
    expect(factsOf(unpriced('kilo', 'mystery')).zeroPrice).toBe('unknown')
    // A known non-zero price is a known false.
    expect(factsOf(paid('kilo', 'premium'), { zeroPrice: [] }).zeroPrice).toBe(false)
    // Without the rule engine the price is unknown even for an obviously free row.
    expect(factsOf(free('kilo', 'free')).zeroPrice).toBe('unknown')
  })

  it('keeps unknown tools/vision unknown instead of guessing', () => {
    const unknown = factsOf(entry('acme', 'plain'))
    expect(unknown.tools).toBe('unknown')
    expect(unknown.vision).toBe('unknown')
    expect(factsOf(entry('acme', 'no-tools', { tools: false })).tools).toBe(false)
    expect(factsOf(entry('acme', 'vision', { input: ['vision'] })).vision).toBe(true)
    const textOnly = factsOf(entry('acme', 'text', { input: ['text'] }))
    expect(textOnly.vision).toBe(false)
    expect(textOnly.contextWindow).toBeUndefined()
  })

  it('maps the privacy seed and document overrides, never guessing unknown', () => {
    expect(factsOf(free('google', 'gemini')).trainsOnData).toBe('yes')
    expect(factsOf(free('groq', 'llama')).trainsOnData).toBe('no')
    expect(factsOf(free('acme', 'shadow')).trainsOnData).toBe('unknown')
    expect(factsOf(free('acme', 'shadow'), { privacy: { models: { 'acme/shadow': 'no-train' } } }).trainsOnData).toBe('no')
  })

  it('merges the manual gated marker and keeps the first duplicate row', () => {
    expect(factsOf(free('kilo', 'gated'), { gated: true }).gated).toBe(true)
    // The provider sync's `pinned-in-use` marker is a catalogue fact, read the
    // same way as `gated`, never inferred from a missing advertised row.
    expect(factsOf(free('kilo', 'retired', { deprecated: true })).deprecated).toBe(true)
    expect(factsOf(free('kilo', 'live')).deprecated).toBe(false)
    const projected = projectRouteFacts({
      entries: [
        free('kilo', 'dup', { contextWindow: 1 }),
        free('kilo', 'dup', { contextWindow: 2 }),
      ],
      rawEfforts: new Map(),
      zeroPriceKeys: undefined,
      privacy: undefined,
    })
    expect(projected.size).toBe(1)
    expect(projected.get('kilo/dup')?.contextWindow).toBe(1)
  })

  it('projects reasoning effort dicts and arrays defensively', () => {
    expect(projectReasoningEfforts({ medium: 'medium', minimal: 'minimal', blank: ' ' })).toEqual(['blank', 'medium', 'minimal'])
    expect(projectReasoningEfforts(['medium', ' ', 'minimal', 7])).toEqual(['medium', 'minimal'])
    expect(projectReasoningEfforts(false)).toEqual([])
    expect(projectReasoningEfforts(undefined)).toEqual([])
  })

  it('reads raw effort fields from the llm-pi-ai document only', () => {
    const settings = settingsFor({
      providers: {
        kilo: {
          models: [
            { id: 'auto/free', reasoningEfforts: { minimal: 'minimal' } },
            { id: 'auto/free', reasoningEfforts: { high: 'high' } },
            { id: '  ', reasoningEfforts: { high: 'high' } },
            'not-a-record',
          ],
        },
        broken: { models: 'nope' },
        skipped: 'nope',
      },
    })
    expect([...readRawEfforts(settings).entries()]).toEqual([['kilo/auto/free', { minimal: 'minimal' }]])
    expect(readRawEfforts(undefined).size).toBe(0)
    expect(readRawEfforts(settingsFor({ providers: 'nope' })).size).toBe(0)
    expect(readRawEfforts(settingsFor(undefined)).size).toBe(0)
  })

  it('uses the live rule engine catalogue when present and fails closed when it throws', () => {
    const entries = [free('kilo', 'free')]
    const engine: CatalogRulesSeam = { catalogue: () => entries }
    expect(readGatedCatalogue(engine, undefined)).toBe(entries)
    const broken: CatalogRulesSeam = { catalogue: () => { throw new Error('boom') } }
    expect(readGatedCatalogue(broken, settingsFor({ providers: { kilo: { models: [{ id: 'free' }] } } }))).toEqual([])
    // A mounted engine without the projection also answers no routes.
    expect(readGatedCatalogue({}, settingsFor({ providers: { kilo: { models: [{ id: 'free' }] } } }))).toEqual([])
    // No engine: the raw catalogue is the input (catalog gated markers included).
    expect(readGatedCatalogue(undefined, settingsFor({ providers: { kilo: { models: [{ id: 'free', gated: true }] } } }))).toEqual([
      { provider: 'kilo', id: 'free', gated: true },
    ])
  })

  it('reads the zero-price selector rule and refuses to prove it when unavailable', () => {
    const engine: CatalogRulesSeam = {
      expandRawSelector: () => ({ links: [{ provider: 'kilo', model: 'free' }] }),
    }
    expect([...readZeroPriceKeys(engine)!]).toEqual(['kilo/free'])
    expect(readZeroPriceKeys(undefined)).toBeUndefined()
    expect(readZeroPriceKeys({})).toBeUndefined()
    expect(readZeroPriceKeys({ expandRawSelector: () => { throw new Error('boom') } })).toBeUndefined()
    expect(zeroPriceKeysOf(undefined)).toBeUndefined()
    expect([...zeroPriceKeysOf({ links: [{ provider: 'a', model: 'b/c' }] })!]).toEqual(['a/b/c'])
  })

  it('reads privacy overrides from the orchestration document', () => {
    expect(readPrivacyOverrides(settingsFor({}, { catalogRules: { privacy: { providers: { acme: 'no-train' } } } })))
      .toEqual({ providers: { acme: 'no-train' } })
    expect(readPrivacyOverrides(settingsFor({}))).toEqual({})
    expect(readPrivacyOverrides(undefined)).toEqual({})
  })
})
