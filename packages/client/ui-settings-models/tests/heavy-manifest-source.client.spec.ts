/**
 * The host is the single manifest source: the page starts on the labelled
 * fallback table and swaps to the host's `enpoiHeavy.manifests` reply
 * wholesale, so a stale page copy (commandcode's retired "unsupported" row)
 * can never render once connected.
 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  bindHostHeavyManifests,
  heavyManifestState,
  loadHostHeavyManifests,
  resetHeavyManifestSource,
  resolveHeavyManifest,
  subscribeHeavyManifests,
} from '../src/client/heavy-manifest-source.ts'
import { fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { liveProviderTemplates, PROVIDER_TEMPLATES } from '../src/client/provider-templates.ts'

afterEach(() => {
  resetHeavyManifestSource()
  vi.unstubAllGlobals()
})

it('renders the labelled fallback before any host reply', () => {
  const state = heavyManifestState()
  expect(state.live).toBe(false)
  expect(resolveHeavyManifest('commandcode')).toEqual(fallbackHeavyManifest('commandcode'))
  expect(resolveHeavyManifest('commandcode')?.unsupported).toBeUndefined()
  // The pre-connection listing still carries every fallback heavy row.
  expect(PROVIDER_TEMPLATES.filter(template => template.heavy !== undefined))
    .toHaveLength(state.manifests.length)
})

it('a host reply replaces the table wholesale, listing included', () => {
  const host = { ...fallbackHeavyManifest('commandcode')!, summary: 'HOST TRUTH', label: 'Command Code (host)' }
  bindHostHeavyManifests({ items: [host], platform: 'linux', problems: [] })

  expect(heavyManifestState().live).toBe(true)
  expect(heavyManifestState().platform).toBe('linux')
  expect(resolveHeavyManifest('commandcode')?.summary).toBe('HOST TRUTH')
  // Ids the host omitted are gone, not merged back from the page copy.
  expect(resolveHeavyManifest('freellmapi')).toBeUndefined()

  const heavy = liveProviderTemplates().filter(template => template.heavy !== undefined)
  expect(heavy).toHaveLength(1)
  expect(heavy[0]?.name).toBe('Command Code (host)')
  expect(heavy[0]?.baseURL).toBe(host.reuse.baseURL)
})

it('an empty reply keeps the fallback listing and marks the source connected', () => {
  bindHostHeavyManifests({ items: [] })
  expect(heavyManifestState().live).toBe(true)
  expect(resolveHeavyManifest('commandcode')).toBeDefined()
})

it('loadHostHeavyManifests accepts the gateway reply and keeps the fallback after a failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        ok: true,
        value: { items: [{ ...fallbackHeavyManifest('commandcode')!, summary: 'FROM GATEWAY' }], problems: [], platform: 'linux' },
      },
    }),
  } as unknown as Response)))
  await loadHostHeavyManifests()
  expect(resolveHeavyManifest('commandcode')?.summary).toBe('FROM GATEWAY')

  resetHeavyManifestSource()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  await loadHostHeavyManifests()
  expect(heavyManifestState().live).toBe(false)
  expect(resolveHeavyManifest('commandcode')).toEqual(fallbackHeavyManifest('commandcode'))
})

it('notifies subscribers on bind and stops after unsubscribe', () => {
  const seen: boolean[] = []
  const unsubscribe = subscribeHeavyManifests(() => { seen.push(heavyManifestState().live) })
  bindHostHeavyManifests({ items: [fallbackHeavyManifest('freellmapi')!] })
  unsubscribe()
  resetHeavyManifestSource()
  expect(seen).toEqual([true])
})

it('concurrent loads share one in-flight request', async () => {
  let settle: ((value: Response) => void) | undefined
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { settle = resolve }))
  vi.stubGlobal('fetch', fetchMock)

  const first = loadHostHeavyManifests()
  const second = loadHostHeavyManifests()
  expect(second).toBe(first)
  settle?.({
    ok: true,
    status: 200,
    json: async () => ({ result: { ok: true, value: { items: [fallbackHeavyManifest('commandcode')!], problems: [] } } }),
  } as unknown as Response)
  await first
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(heavyManifestState().live).toBe(true)
})
