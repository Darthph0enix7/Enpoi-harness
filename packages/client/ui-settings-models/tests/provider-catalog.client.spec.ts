/**
 * Provider-catalog data and operator overrides: the keyless/popular sets
 * derive from the generated rows, the live host heavy table when one was
 * accepted, and `enpoi-orchestration.uiPreferences.providerCatalog` can hide,
 * keyless-enable, or popularize a preset without touching generated data.
 */
import { afterEach, expect, it } from 'vitest'
import {
  applyProviderPresetOverrides, keylessProviders, liveProviderTemplates,
  popularProviders, providerPreset, SHIPPED_KEYLESS_PROVIDERS,
  SHIPPED_POPULAR_PROVIDERS, SHIPPED_PROVIDER_TEMPLATES,
} from '../src/client/provider-templates.ts'
import { parseProviderPresetOverrides } from '../src/client/provider-overrides.ts'
import { bindHostHeavyManifests, resetHeavyManifestSource } from '../src/client/heavy-manifest-source.ts'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'

afterEach(() => {
  resetHeavyManifestSource()
})

it('derives the shipped popular order and keyless set from the generated rows', () => {
  expect(SHIPPED_POPULAR_PROVIDERS).toEqual([
    'opencode', 'opencode-go', 'anthropic', 'github-copilot',
    'openai', 'google', 'openrouter', 'vercel',
  ])
  // Every listed id carries the data rank its position came from, and no
  // unlisted template carries one.
  const ranked = SHIPPED_PROVIDER_TEMPLATES
    .filter(template => template.popular !== undefined).map(template => template.id)
  expect([...SHIPPED_POPULAR_PROVIDERS].sort()).toEqual([...ranked].sort())
  for (const [index, id] of SHIPPED_POPULAR_PROVIDERS.entries()) {
    expect(providerPreset(id)?.popular).toBe(index + 1)
  }
  expect(SHIPPED_KEYLESS_PROVIDERS).toEqual(new Set(['kilo', 'lmstudio', 'ollama']))
  // The verdict lives on the row, not only in the derived set.
  expect(providerPreset('kilo')?.keyless).toBe(true)
  expect(providerPreset('ollama')?.keyless).toBe(true)
  expect(providerPreset('lmstudio')?.keyless).toBe(true)
  expect(providerPreset('openai')?.keyless).toBeUndefined()
})

it('falls back to the shipped sets and catalog before a host heavy reply', () => {
  // No reply was accepted: the selectors must equal the shipped fallbacks.
  expect(popularProviders()).toEqual(SHIPPED_POPULAR_PROVIDERS)
  expect(keylessProviders()).toEqual(SHIPPED_KEYLESS_PROVIDERS)
  expect(providerPreset('commandcode')).toBe(
    SHIPPED_PROVIDER_TEMPLATES.find(template => template.id === 'commandcode'))
})

it('derives the selectors from the live host table once a heavy reply lands', () => {
  const shipped = fallbackHeavyManifest('commandcode')!
  bindHostHeavyManifests({
    items: [{ ...shipped, label: 'Command Code (host)', auth: { ...shipped.auth, keyless: true } }],
    problems: [],
  })
  // The host row wins, and an id the host omitted stops resolving.
  expect(providerPreset('commandcode')?.name).toBe('Command Code (host)')
  expect(providerPreset('commandcode')?.keyless).toBe(true)
  expect(providerPreset('freellmapi')).toBeUndefined()
  // Keyless now tracks the live table (host heavy row plus shipped mainstream).
  expect(keylessProviders().has('commandcode')).toBe(true)
  expect(keylessProviders().has('kilo')).toBe(true)
  // Heavy rows carry no popular rank, so the mainstream order is unchanged.
  expect(popularProviders()).toEqual(SHIPPED_POPULAR_PROVIDERS)
})

it('parses overrides only from well-formed boolean fields', () => {
  expect(parseProviderPresetOverrides(undefined)).toEqual({})
  expect(parseProviderPresetOverrides({ uiPreferences: 'nope' })).toEqual({})
  expect(parseProviderPresetOverrides({ uiPreferences: { providerCatalog: 'nope' } })).toEqual({})
  // A non-boolean field is dropped rather than coerced; a fieldless entry
  // is not an override at all.
  expect(parseProviderPresetOverrides({
    uiPreferences: { providerCatalog: { openai: { hidden: true, keyless: 'yes', popular: false }, ghost: {} } },
  })).toEqual({ openai: { hidden: true, popular: false } })
  expect(parseProviderPresetOverrides({
    uiPreferences: { providerCatalog: { kilo: { keyless: false }, anthropic: { popular: true } } },
  })).toEqual({ kilo: { keyless: false }, anthropic: { popular: true } })
})

it('removes a hidden preset from the picker listing without dropping the catalog row', () => {
  const listing = liveProviderTemplates()
  const visible = applyProviderPresetOverrides(listing, { anthropic: { hidden: true } })
  expect(visible.find(template => template.id === 'anthropic')).toBeUndefined()
  expect(visible.some(template => template.id === 'openai')).toBe(true)
  // A configured route's lookup must keep resolving after the preset left the
  // picker: the shipped catalog and `providerPreset` are untouched.
  expect(listing.find(template => template.id === 'anthropic')).toBeDefined()
  expect(providerPreset('anthropic')).toBeDefined()
})

it('replaces keyless and popular verdicts from the override map', () => {
  const listing = liveProviderTemplates()
  const visible = applyProviderPresetOverrides(listing, {
    openai: { keyless: true, popular: true },
    anthropic: { keyless: false, popular: false },
    cohere: { popular: true },
  })
  const byId = new Map(visible.map(template => [template.id, template]))
  expect(byId.get('openai')).toMatchObject({ keyless: true })
  // A ranked provider keeps its generated rank under a popular override.
  expect(byId.get('openai')?.popular).toBe(5)
  expect(byId.get('anthropic')).toMatchObject({ keyless: false })
  expect(byId.get('anthropic')?.popular).toBeUndefined()
  // An override-added popular provider sorts after every ranked row.
  expect(byId.get('cohere')?.popular).toBe(Number.MAX_SAFE_INTEGER)
  // An untouched row is the same object, not a copy.
  expect(byId.get('google')).toBe(listing.find(template => template.id === 'google'))
})
