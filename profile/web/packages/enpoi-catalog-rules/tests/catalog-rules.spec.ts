import { describe, expect, it } from 'vitest'
import { readCatalogue } from '../src/catalogue.ts'
import {
  decideVisibility, describePredicate, diffRules, evaluatePredicate, evaluateVisibility,
  formatHiddenReason, globMatches, parseRulesDocument, resolvePrivacy, withHiddenPins,
  type CatalogEntry, type ParsedRules,
} from '../src/rules.ts'

/** One catalogue entry with sensible defaults; override what the test needs. */
function entry(overrides: Partial<CatalogEntry> & Pick<CatalogEntry, 'provider' | 'id'>): CatalogEntry {
  return { contextWindow: 200_000, input: ['text'], reasoning: false, tools: true, ...overrides }
}

const rulesOf = (raw: unknown): ParsedRules => parseRulesDocument(raw)

describe('enpoi-catalog-rules privacy', () => {
  it('seeds provider policy, lets per-model entries win, and keeps unknown as unknown', () => {
    // Seed: groq does not train; bare model id override; provider fallback; unknown provider.
    expect(resolvePrivacy('groq', 'llama-3.3-70b')).toBe('no-train')
    expect(resolvePrivacy('mistral', 'mistral-small-latest')).toBe('no-train')
    expect(resolvePrivacy('mistral', 'some-new-model')).toBe('trains')
    expect(resolvePrivacy('mystery-route', 'model-x')).toBe('unknown')
  })

  it('applies document overrides over the seed and ignores invalid policy values', () => {
    const overrides = {
      providers: { 'mystery-route': 'no-train', google: 'maybe' },
      models: { 'mystery-route/model-x': 'trains' },
    }
    expect(resolvePrivacy('mystery-route', 'model-x', overrides)).toBe('trains')
    expect(resolvePrivacy('mystery-route', 'other', overrides)).toBe('no-train')
    // `google: 'maybe'` is invalid, so the seed value survives.
    expect(resolvePrivacy('google', 'gemini-x', overrides)).toBe('trains')
  })

  it('never reports unknown as safe for a noTraining predicate in either direction', () => {
    const unknown = entry({ provider: 'mystery-route', id: 'model-x' })
    expect(evaluatePredicate(unknown, { noTraining: true }, resolvePrivacy(unknown.provider, unknown.id))).toEqual({ matched: false, failed: 'no-training' })
    expect(evaluatePredicate(unknown, { noTraining: false }, resolvePrivacy(unknown.provider, unknown.id))).toEqual({ matched: false, failed: 'trains-on-content' })
    const trainer = entry({ provider: 'google', id: 'gemini-x' })
    expect(evaluatePredicate(trainer, { noTraining: false }, resolvePrivacy(trainer.provider, trainer.id)).matched).toBe(true)
    expect(evaluatePredicate(trainer, { noTraining: true }, resolvePrivacy(trainer.provider, trainer.id)).matched).toBe(false)
  })
})

describe('enpoi-catalog-rules predicates', () => {
  it('matches zero-price only on known-zero costs, not on unknown price', () => {
    const free = entry({ provider: 'p', id: 'free', cost: { input: 0, output: 0 } })
    const paid = entry({ provider: 'p', id: 'paid', cost: { input: 0.1, output: 0.2 } })
    const unknown = entry({ provider: 'p', id: 'unknown' })
    expect(evaluatePredicate(free, { zeroPrice: true }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(paid, { zeroPrice: true }, 'unknown')).toEqual({ matched: false, failed: 'zero-price' })
    expect(evaluatePredicate(unknown, { zeroPrice: true }, 'unknown')).toEqual({ matched: false, failed: 'zero-price' })
    expect(evaluatePredicate(unknown, { zeroPrice: false }, 'unknown').matched).toBe(true)
  })

  it('applies maxPrice to every known dimension and fails when price is unknown', () => {
    const cheap = entry({ provider: 'p', id: 'cheap', cost: { input: 0.5, output: 1 } })
    const pricey = entry({ provider: 'p', id: 'pricey', cost: { input: 0.5, output: 8 } })
    expect(evaluatePredicate(cheap, { maxPrice: 1 }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(pricey, { maxPrice: 1 }, 'unknown')).toEqual({ matched: false, failed: 'price ≤ 1' })
    expect(evaluatePredicate(entry({ provider: 'p', id: 'n' }), { maxPrice: 1 }, 'unknown').matched).toBe(false)
  })

  it('matches capability clauses and fails unknown contextWindow on a minimum', () => {
    const capable = entry({ provider: 'p', id: 'm', input: ['text', 'image'], reasoning: true, tools: true, contextWindow: 32_768 })
    expect(evaluatePredicate(capable, { tools: true, vision: true, reasoning: true, minContextWindow: 32_768 }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(capable, { minContextWindow: 32_769 }, 'unknown')).toEqual({ matched: false, failed: 'context ≥ 32769' })
    const unknownContext = entry({ provider: 'p', id: 'm', contextWindow: undefined })
    expect(evaluatePredicate(unknownContext, { minContextWindow: 1 }, 'unknown').matched).toBe(false)
  })

  it('matches the disclosure-side modality clauses', () => {
    const omni = entry({ provider: 'p', id: 'omni', input: ['text', 'image', 'audio', 'video', 'pdf'] })
    expect(evaluatePredicate(omni, { audio: true, video: true, pdf: true }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(omni, { audio: false }, 'unknown')).toEqual({ matched: false, failed: 'no audio' })
    const textOnly = entry({ provider: 'p', id: 'text-only', input: ['text'] })
    expect(evaluatePredicate(textOnly, { audio: true }, 'unknown')).toEqual({ matched: false, failed: 'audio' })
    expect(evaluatePredicate(textOnly, { audio: false, video: false, pdf: false }, 'unknown').matched).toBe(true)
  })

  it('matches provider ids, globs, and refuses an empty predicate', () => {
    const target = entry({ provider: 'opencode-go', id: 'qwen3.8-2.4t-a95b', name: 'Qwen 3.8 2.4T' })
    expect(evaluatePredicate(target, { provider: 'opencode-go' }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(target, { provider: 'openrouter' }, 'unknown').matched).toBe(false)
    expect(evaluatePredicate(target, { providerGlob: 'opencode*' }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(target, { idGlob: 'qwen3.8-*' }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(target, { nameGlob: '*2.4T*' }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(target, {}, 'unknown')).toEqual({ matched: false, failed: 'empty predicate' })
    expect(globMatches('a?c', 'abc')).toBe(true)
    expect(globMatches('a.c', 'abc')).toBe(false)
  })

  it('describes predicates for reasons, including zero-price', () => {
    expect(describePredicate({ zeroPrice: true })).toBe('zero-price')
    expect(describePredicate({ tools: true, minContextWindow: 32_768 })).toBe('tool-calling + context ≥ 32768')
    expect(describePredicate({ audio: true, video: true, pdf: true })).toBe('audio + video + pdf')
    expect(describePredicate({})).toBe('empty predicate')
  })
})

describe('enpoi-catalog-rules visibility precedence', () => {
  const free = entry({ provider: 'p', id: 'free', cost: { input: 0, output: 0 } })

  it('hides by rule with the picker reason string', () => {
    const rules = rulesOf({ visibility: { hide: [{ label: 'free models', when: { zeroPrice: true } }] } })
    const decision = decideVisibility(free, rules, 'unknown')
    expect(decision.state).toBe('hidden')
    expect(decision.source).toBe('rule')
    expect(decision.reason).toBe('hidden by rule: free models')
    expect(formatHiddenReason(decision)).toBe('hidden by rule: free models')
    // Without a label the predicate summary is the reason (the example).
    const unlabeled = decideVisibility(free, rulesOf({ visibility: { hide: [{ when: { zeroPrice: true } }] } }), 'unknown')
    expect(unlabeled.reason).toBe('hidden by rule: zero-price')
  })

  it('lets a manual visible pin beat a hide rule and records the overridden rule', () => {
    const rules = rulesOf({
      visibility: { hide: [{ when: { zeroPrice: true } }] },
      overrides: { shown: { p: ['free'] } },
    })
    const decision = decideVisibility(free, rules, 'unknown')
    expect(decision.state).toBe('visible')
    expect(decision.source).toBe('manual')
    expect(decision.reason).toBe('pinned visible (rule: zero-price)')
    expect(decision.overriddenRule).toBe('zero-price')
    expect(formatHiddenReason(decision)).toBeNull()
  })

  it('lets a manual hidden pin beat a manual visible pin and any rule', () => {
    const rules = rulesOf({ overrides: { hidden: { p: ['free'] }, shown: { p: ['free'] } } })
    const decision = decideVisibility(free, rules, 'unknown')
    expect(decision.state).toBe('hidden')
    expect(decision.source).toBe('manual')
    expect(decision.reason).toBe('hidden manually')
  })

  it('gates entries but lets a manual pin show them', () => {
    const gated = entry({ provider: 'p', id: 'gated-model', gated: true })
    const rules = rulesOf({})
    expect(decideVisibility(gated, rules, 'unknown')).toMatchObject({ state: 'hidden', source: 'gated', reason: 'gated' })
    const shown = rulesOf({ overrides: { shown: { p: ['gated-model'] } } })
    expect(decideVisibility(gated, shown, 'unknown')).toMatchObject({ state: 'visible', reason: 'pinned visible (gated)' })
    // The overrides.gated map gates by provider or provider/model too.
    const byOverride = rulesOf({ overrides: { gated: { models: ['p/other'] } } })
    expect(decideVisibility(entry({ provider: 'p', id: 'other' }), byOverride, 'unknown').reason).toBe('gated')
  })

  it('renders the catalogue gate reason and lets a gated predicate exclude it', () => {
    // The provider sync stores `gated`/`gateReason` for a listing row marked
    // `isFree: false` (Kilo's sign-in-only models); the reason reaches the picker.
    const signInOnly = entry({ provider: 'kilo', id: 'kilo-auto/efficient', gated: true, gateReason: 'sign-in required' })
    expect(decideVisibility(signInOnly, rulesOf({}), 'unknown'))
      .toMatchObject({ state: 'hidden', source: 'gated', reason: 'sign-in required' })
    const hidePaid = rulesOf({ visibility: { hide: [{ when: { gated: true } }] } })
    expect(evaluatePredicate(signInOnly, { gated: true }, 'unknown').matched).toBe(true)
    expect(evaluatePredicate(entry({ provider: 'kilo', id: 'kilo-auto/free' }), { gated: true }, 'unknown'))
      .toEqual({ matched: false, failed: 'gated' })
    expect(evaluatePredicate(signInOnly, { gated: false }, 'unknown')).toEqual({ matched: false, failed: 'not gated' })
    expect(hidePaid.hide).toHaveLength(1)
  })

  it('projects the sync gate flag and reason from settings model rows', () => {
    const settings = {
      get: (ns: string) => ns === 'llm-pi-ai'
        ? {
            providers: {
              kilo: {
                models: [
                  { id: 'kilo-auto/efficient', name: 'Auto Efficient', isFree: false, gated: true, gateReason: 'sign-in required' },
                  { id: 'kilo-auto/free', name: 'Auto Free', isFree: true },
                  { id: 'hand-added' },
                ],
              },
            },
          }
        : undefined,
    }
    const entries = readCatalogue(settings)
    expect(entries.map(item => item.id)).toEqual(['kilo-auto/efficient', 'kilo-auto/free', 'hand-added'])
    expect(entries[0]).toMatchObject({ provider: 'kilo', gated: true, gateReason: 'sign-in required' })
    expect(entries[1]?.gated).toBeUndefined()
    expect(entries[1]?.gateReason).toBeUndefined()
    expect(entries[2]?.gated).toBeUndefined()
  })

  it('defaults to visible with a null reason', () => {
    const decision = decideVisibility(entry({ provider: 'p', id: 'plain' }), rulesOf(undefined), 'unknown')
    expect(decision).toMatchObject({ state: 'visible', source: 'default', reason: null })
  })

  it('merges the picker hiddenModels map as manual pins (same override tier as overrides.hidden)', () => {
    const rules = withHiddenPins(rulesOf({ visibility: { hide: [{ when: { zeroPrice: true } }] } }), { p: ['free'], q: ['other'] })
    expect(decideVisibility(free, rules, 'unknown')).toMatchObject({ state: 'hidden', source: 'manual', reason: 'hidden manually' })
    // A manual visible pin still beats the merged hidden pin only when the hidden pin is absent.
    const shown = withHiddenPins(rulesOf({ overrides: { shown: { p: ['free'] } } }), { q: ['other'] })
    expect(decideVisibility(free, shown, 'unknown')).toMatchObject({ state: 'visible', source: 'manual', reason: 'pinned visible' })
  })

  it('warns when a hide rule or a manual pin matches nothing', () => {
    const rules = rulesOf({
      visibility: { hide: [{ id: 'stale', when: { providerGlob: 'ghost-*' } }] },
      overrides: { hidden: { p: ['missing'] }, shown: { p: ['also-missing'] } },
    })
    const { warnings } = evaluateVisibility([entry({ provider: 'p', id: 'present' })], rules)
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('hide rule "stale"'),
      expect.stringContaining('matched no catalogue entries'),
      expect.stringContaining('manual hidden pin "p/missing"'),
      expect.stringContaining('manual visible pin "p/also-missing"'),
    ]))
  })

  it('drops malformed hide rules with warnings instead of hiding everything', () => {
    const rules = rulesOf({
      visibility: { hide: [
        { when: { tools: 'yes' } },
        { reason: 'no when' },
        { when: { zeroPrice: true } },
        'nope',
      ] },
    })
    expect(rules.hide).toHaveLength(1)
    expect(rules.warnings.some(line => line.includes('"tools" is not a boolean'))).toBe(true)
    expect(rules.warnings.some(line => line.includes('has no "when"'))).toBe(true)
    expect(rules.warnings.some(line => line.includes('no recognized predicate clauses'))).toBe(true)
    expect(rules.version).toBe(1)
  })
})

describe('enpoi-catalog-rules edit diff', () => {
  const catalogue = [
    entry({ provider: 'p', id: 'free', cost: { input: 0, output: 0 } }),
    entry({ provider: 'p', id: 'paid', cost: { input: 1, output: 1 } }),
    entry({ provider: 'p', id: 'gated', gated: true }),
  ]

  it('shows what a proposed edit adds and removes before applying', () => {
    const before = rulesOf(undefined)
    const after = rulesOf({ visibility: { hide: [{ when: { zeroPrice: true } }] }, overrides: { gated: { models: ['p/paid'] } } })
    const diff = diffRules(before, after, catalogue)
    expect(diff.hiddenAdded).toEqual(['p/free', 'p/paid'])
    expect(diff.hiddenRemoved).toEqual([])
    expect(diff.gatedAdded).toEqual(['p/paid'])
    expect(diff.warnings).toEqual([])
    const back = diffRules(after, before, catalogue)
    expect(back.hiddenRemoved).toEqual(['p/free', 'p/paid'])
  })

  it('surfaces the proposed document warnings in the diff', () => {
    const diff = diffRules(rulesOf(undefined), rulesOf({ visibility: { hide: [{ when: { provider: 'ghost' } }] } }), catalogue)
    expect(diff.warnings.some(line => line.includes('matched no catalogue entries'))).toBe(true)
  })
})
