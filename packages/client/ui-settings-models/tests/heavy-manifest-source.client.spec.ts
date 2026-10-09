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
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS, fallbackHeavyManifest } from '../src/client/heavy-providers.ts'
import { HEAVY_OVERLAY_GLOBAL } from '../src/heavy-overlay.ts'
import { liveProviderTemplates, SHIPPED_PROVIDER_TEMPLATES } from '../src/client/provider-templates.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  resetHeavyManifestSource()
})

it('renders the labelled fallback before any host reply', () => {
  const state = heavyManifestState()
  expect(state.live).toBe(false)
  expect(resolveHeavyManifest('commandcode')).toEqual(fallbackHeavyManifest('commandcode'))
  expect(resolveHeavyManifest('commandcode')?.unsupported).toBeUndefined()
  // The pre-connection listing still carries every fallback heavy row.
  expect(SHIPPED_PROVIDER_TEMPLATES.filter(template => template.heavy !== undefined))
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

it('the operator overlay disables and overrides fallback rows before any host reply', () => {
  vi.stubGlobal(HEAVY_OVERLAY_GLOBAL, {
    providers: {
      freellmapi: { disabled: true },
      antigravity: { label: 'Antigravity (operator)', fallbackModel: 'operator/model' },
    },
  })
  resetHeavyManifestSource()

  const state = heavyManifestState()
  expect(state.live).toBe(false)
  expect(resolveHeavyManifest('freellmapi')).toBeUndefined()
  expect(resolveHeavyManifest('antigravity')?.label).toBe('Antigravity (operator)')
  expect(resolveHeavyManifest('antigravity')?.fallbackModel).toBe('operator/model')
  // Rows without an overlay entry keep their shipped facts.
  expect(resolveHeavyManifest('commandcode')).toEqual(fallbackHeavyManifest('commandcode'))
  // The listing renders the overlaid table, not the compiled copy.
  expect(liveProviderTemplates().filter(template => template.heavy !== undefined).map(template => template.id))
    .toEqual(['antigravity', 'commandcode'])
})

it('a host reply replaces the overlay-applied fallback wholesale', () => {
  vi.stubGlobal(HEAVY_OVERLAY_GLOBAL, { providers: { freellmapi: { disabled: true } } })
  resetHeavyManifestSource()
  expect(resolveHeavyManifest('freellmapi')).toBeUndefined()

  bindHostHeavyManifests({ items: [fallbackHeavyManifest('freellmapi')!], platform: 'linux' })

  // Host truth wins: the pre-connection overlay does not re-disable or re-add.
  expect(resolveHeavyManifest('freellmapi')).toBeDefined()
  expect(resolveHeavyManifest('antigravity')).toBeUndefined()
  expect(heavyManifestState().live).toBe(true)
})

it('keeps the shipped fallback when no overlay is published', () => {
  resetHeavyManifestSource()
  expect(heavyManifestState().manifests).toEqual([...FALLBACK_HEAVY_PROVIDER_MANIFESTS])
  expect(heavyManifestState().manifests.map(manifest => manifest.id)).toEqual(['freellmapi', 'antigravity', 'commandcode'])
})
