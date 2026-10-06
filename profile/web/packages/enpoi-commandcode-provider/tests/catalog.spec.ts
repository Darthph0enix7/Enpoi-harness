/**
 * Catalog capabilities: vision flags, reasoning efforts, plan badges and
 * context windows all come from catalog data; the live fetch falls back to the
 * bundled snapshot.
 */
import { expect, it, vi } from 'vitest'
import {
  CatalogStore,
  contextWindowOf,
  effortsOf,
  entryFor,
  isLoopbackBaseURL,
  modalitiesOf,
  parseCatalog,
  planBadgeOf,
  visionOf,
} from '../src/catalog.js'

const FIXTURE = parseCatalog([
  {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (latest) [Go+]',
    reasoning: true,
    reasoningEfforts: ['high', 'max'],
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1_000_000, output: 384_000 },
  },
  {
    id: 'vision/model',
    name: 'Vision Model [Max]',
    reasoning: false,
    attachment: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
  },
])

it('parses arrays and id-keyed objects, dropping malformed rows', () => {
  expect(parseCatalog(FIXTURE).map(entry => entry.id)).toHaveLength(2)
  expect(parseCatalog({ a: { id: 'a', name: 'A' }, b: null }).map(entry => entry.id)).toEqual(['a'])
  expect(parseCatalog(null)).toEqual([])
})

it('answers capabilities from the catalog, permissive only when unknown', () => {
  const pro = entryFor(FIXTURE, 'deepseek/deepseek-v4-pro')
  const vision = entryFor(FIXTURE, 'vision/model')
  expect(visionOf(pro)).toBe(false)
  expect(visionOf(vision)).toBe(true)
  expect(visionOf(entryFor(FIXTURE, 'not-in-catalog'))).toBe(true)
  expect(modalitiesOf(vision)).toEqual(['text', 'image'])
  expect(effortsOf(pro)).toEqual(['high', 'max'])
  expect(effortsOf(vision)).toEqual([])
  expect(contextWindowOf(pro)).toBe(1_000_000)
  expect(planBadgeOf(pro)).toBe('[Go+]')
  expect(planBadgeOf(vision)).toBe('[Max]')
})

it('matches vendor-prefixed and short model ids', () => {
  expect(entryFor(FIXTURE, 'deepseek-v4-pro')?.id).toBe('deepseek/deepseek-v4-pro')
  expect(entryFor(FIXTURE, 'vision/model')?.name).toContain('Vision Model')
})

it('fetches the live catalog at startup and reports its source', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: 'live/model', name: 'Live [Pro+]' }])))
  const store = new CatalogStore({
    baseURL: 'http://127.0.0.1:8899/commandcode/',
    snapshot: FIXTURE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  store.start()
  const entries = await store.entries()
  expect(entries.map(entry => entry.id)).toEqual(['live/model'])
  expect(store.source()).toBe('live')
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8899/commandcode/catalog.json')
})

it('recognizes only loopback base URLs as catalog-capable', () => {
  expect(isLoopbackBaseURL('http://127.0.0.1:8899/commandcode')).toBe(true)
  expect(isLoopbackBaseURL('http://127.0.0.2:8899')).toBe(true)
  expect(isLoopbackBaseURL('http://localhost:8899/commandcode')).toBe(true)
  expect(isLoopbackBaseURL('http://[::1]:8899')).toBe(true)
  expect(isLoopbackBaseURL('https://api.commandcode.ai')).toBe(false)
  expect(isLoopbackBaseURL('http://192.168.188.95:8899')).toBe(false)
  expect(isLoopbackBaseURL('not a url')).toBe(false)
})

it('resolves the bundled snapshot without fetching when the baseURL is the vendor, not the keypool', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('the vendor serves no catalog.json') })
  const store = new CatalogStore({
    baseURL: 'https://api.commandcode.ai',
    snapshot: FIXTURE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  store.start()
  const entries = await store.entries()
  expect(entries.map(entry => entry.id)).toEqual(['deepseek/deepseek-v4-pro', 'vision/model'])
  expect(store.source()).toBe('snapshot')
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('falls back to the bundled snapshot when the keypool is unreachable', async () => {
  const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
  const store = new CatalogStore({
    baseURL: 'http://127.0.0.1:8899/commandcode',
    snapshot: FIXTURE,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  const entries = await store.entries()
  expect(entries.map(entry => entry.id)).toEqual(['deepseek/deepseek-v4-pro', 'vision/model'])
  expect(store.source()).toBe('snapshot')
})

it('the bundled snapshot is real catalog data (not hardcoded capabilities)', async () => {
  const { readFileSync } = await import('node:fs')
  const snapshot = parseCatalog(JSON.parse(readFileSync(new URL('../catalog.snapshot.json', import.meta.url), 'utf8')))
  expect(snapshot.length).toBeGreaterThan(50)
  expect(snapshot.some(entry => entry.reasoningEfforts !== undefined)).toBe(true)
  expect(snapshot.every(entry => typeof entry.name === 'string' && entry.name.length > 0)).toBe(true)
})
