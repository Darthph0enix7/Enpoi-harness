/** Catalog integrity: the v1 provider set, unique registration ids, and the row templates. */
import { expect, it } from 'vitest'
import { anyProviderSpec, catalogKeyRefs, providerSpec, WEB_SETUP_PROVIDERS } from '../src/catalog.ts'

it('declares the frozen v1 provider set per kind', () => {
  expect(WEB_SETUP_PROVIDERS.filter(spec => spec.kind === 'search').map(spec => spec.id))
    .toEqual(['exa', 'deepseek-official', 'brave', 'tavily', 'searxng'])
  expect(WEB_SETUP_PROVIDERS.filter(spec => spec.kind === 'fetch').map(spec => spec.id))
    .toEqual(['http', 'jina'])
})

it('keeps ids, row ids, and row names unique and namespaced', () => {
  const ids = WEB_SETUP_PROVIDERS.map(spec => spec.id)
  const rowIds = WEB_SETUP_PROVIDERS.map(spec => spec.row.id)
  const rowNames = WEB_SETUP_PROVIDERS.map(spec => spec.row.name)
  expect(new Set(ids).size).toBe(ids.length)
  expect(new Set(rowIds).size).toBe(rowIds.length)
  expect(new Set(rowNames).size).toBe(rowNames.length)
  for (const name of rowNames) expect(name.startsWith('@deepseek-ai/dsh-')).toBe(true)
})

it('maps every provider to a canary that matches its kind', () => {
  for (const spec of WEB_SETUP_PROVIDERS) {
    if (spec.kind === 'search') {
      expect(spec.canary.kind === 'http-search' || spec.canary.kind === 'credential').toBe(true)
    } else {
      expect(spec.canary.kind === 'http-fetch' || spec.canary.kind === 'none').toBe(true)
    }
  }
})

it('carries a credential reference only where one is required', () => {
  expect(providerSpec('search', 'searxng')?.keyRef).toBeNull()
  expect(providerSpec('fetch', 'http')?.keyRef).toBeNull()
  expect(providerSpec('search', 'exa')?.keyRef).toBe('EXA_API_KEY')
  expect(providerSpec('search', 'deepseek-official')?.keyRef).toBe('DEEPSEEK_API_KEY')
  expect(providerSpec('search', 'brave')?.keyRef).toBe('BRAVE_API_KEY')
  expect(providerSpec('search', 'tavily')?.keyRef).toBe('TAVILY_API_KEY')
  expect(providerSpec('fetch', 'jina')?.keyRef).toBe('JINA_API_KEY')
})

it('resolves specs by kind and refuses cross-kind lookups', () => {
  expect(providerSpec('search', 'exa')?.kind).toBe('search')
  expect(providerSpec('fetch', 'exa')).toBeUndefined()
  expect(providerSpec('search', 'http')).toBeUndefined()
  expect(providerSpec('search', 'missing')).toBeUndefined()
  expect(anyProviderSpec('exa')?.kind).toBe('search')
  expect(anyProviderSpec('missing')).toBeUndefined()
})

it('lists each credential reference once', () => {
  expect(catalogKeyRefs()).toEqual(['EXA_API_KEY', 'DEEPSEEK_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'JINA_API_KEY'])
})
