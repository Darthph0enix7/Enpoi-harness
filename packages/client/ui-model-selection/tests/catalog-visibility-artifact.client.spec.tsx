// @vitest-environment jsdom
/** The artifact channel the picker reads the resolved visibility map through. */
import { afterEach, expect, it, vi } from 'vitest'
import {
  CATALOG_VISIBILITY_CHANGED_EVENT,
  catalogVisibilitySnapshot,
  refreshCatalogVisibility,
} from '../src/client/catalog-visibility.ts'

const RESOLVED = {
  'kilo/free-model': { state: 'hidden', reason: 'hidden by rule: zero-price', source: 'rule', rule: 'zero-price' },
}

const RESOLVED_NEXT = {
  'kilo/free-model': { state: 'visible', reason: 'pinned visible (rule: zero-price)', source: 'manual', overriddenRule: 'zero-price' },
}

/** Parse the wire envelope of one stubbed RPC request. */
function requestOf(input: unknown, init?: RequestInit): { method?: string; payload?: { args?: Record<string, unknown> } } {
  void input
  return JSON.parse(String(init?.body)) as { method?: string; payload?: { args?: Record<string, unknown> } }
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('reads the artifact revision-aware and never touches the document', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = requestOf(input, init)
    calls.push(String(request.method))
    if (request.method === 'settings.describeArtifact') {
      const known = request.payload?.args?.knownRevision
      return {
        ok: true,
        json: async () => known === 1
          ? { result: { ok: true, value: { key: 'catalogRules.resolved', revision: 1, changed: false } } }
          : { result: { ok: true, value: { key: 'catalogRules.resolved', revision: 1, changed: true, value: RESOLVED } } },
      }
    }
    return { ok: true, json: async () => ({ result: { value: { namespaces: [] } } }) }
  }))

  const listener = vi.fn()
  window.addEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, listener)
  try {
    await refreshCatalogVisibility()
    expect(calls).toEqual(['settings.describeArtifact'])
    expect(catalogVisibilitySnapshot().get('kilo/free-model')).toMatchObject({ state: 'hidden', source: 'rule' })
    expect(listener).toHaveBeenCalledTimes(1)

    // The unchanged revision answers without a value and publishes nothing.
    await refreshCatalogVisibility()
    expect(calls).toEqual(['settings.describeArtifact', 'settings.describeArtifact'])
    expect(listener).toHaveBeenCalledTimes(1)
  } finally {
    window.removeEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, listener)
  }
})

it('falls back to the legacy document read and re-reads the artifact once it exists', async () => {
  let artifactReady = false
  const artifactValue = { revision: 3, changed: true, value: RESOLVED_NEXT }
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const request = requestOf(input, init)
    if (request.method === 'settings.describeArtifact') {
      if (!artifactReady) return { ok: false, json: async () => ({}) }
      return { ok: true, json: async () => ({ result: { ok: true, value: artifactValue } }) }
    }
    return {
      ok: true,
      json: async () => ({ result: { value: { namespaces: [{ ns: 'enpoi-orchestration', value: { catalogRules: { resolved: RESOLVED } } }] } } }),
    }
  }))

  // A host without the artifact route answers 404: the legacy document map applies.
  await refreshCatalogVisibility()
  expect(catalogVisibilitySnapshot().get('kilo/free-model')).toMatchObject({ state: 'hidden', source: 'rule' })

  // Once the host serves the channel, its changed revision replaces the map.
  artifactReady = true
  await refreshCatalogVisibility()
  expect(catalogVisibilitySnapshot().get('kilo/free-model')).toMatchObject({ state: 'visible', source: 'manual' })
})
