/**
 * PRESET-ONLY LISTING: heavy providers appear in the manifest table but are
 * never seeded into the provider-sync endpoint set. Without this, the hourly
 * sync would probe an uninstalled heavy route and rewrite a route that cannot
 * resolve (the deadlock the recon named).
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS, manifestById } from '../src/manifests.js'
import { routeProfile } from '../src/planner.js'

/** The advertised endpoint keys of the provider-sync bundle patch. */
function syncEndpointKeys(): string[] {
  const text = readFileSync(new URL('../../enpoi-provider-sync/cordis.patch.yml', import.meta.url), 'utf8')
  const block = text.split('\n        endpoints:\n')[1]
  if (block === undefined) return []
  // Bound the endpoint map: the capacityDefaults map below it also carries
  // 10-space-indented keys and must not leak into this answer.
  const [endpointsOnly] = block.split('# Capacity fallbacks')
  return [...(endpointsOnly ?? '').matchAll(/^ {10}([a-z0-9-]+):/gm)].map(match => match[1])
}

it('no heavy provider is seeded into the provider-sync endpoint set', () => {
  const endpoints = syncEndpointKeys()
  expect(endpoints.length).toBeGreaterThan(0)
  for (const manifest of HEAVY_MANIFESTS) {
    expect(endpoints, `${manifest.id} must stay preset-only`).not.toContain(manifest.id)
  }
})

it('every addable heavy provider carries a reuse endpoint and a local base URL', () => {
  for (const manifest of HEAVY_MANIFESTS) {
    if (manifest.unsupported !== undefined) continue
    expect(manifest.reuse.baseURL).not.toBe('')
    expect(manifest.local.baseURL).not.toBe('')
  }
})

it('a preset route writes catalog authority only when the manifest declares endpoint authority', () => {
  const manifest = manifestById('freellmapi')!
  expect(routeProfile(manifest, 'reuse', []).catalogAuthority).toBeUndefined()
  expect(routeProfile(manifest, 'reuse', [], { catalogAuthority: 'endpoint' }).catalogAuthority).toBe('endpoint')
})

it('the CLIProxyAPI preset writes endpoint authority, its session header, and no fallback', () => {
  const profile = routeProfile(manifestById('cliproxyapi')!, 'reuse', [])
  expect(profile.catalogAuthority).toBe('endpoint')
  expect(profile.sessionHeader).toBe('x-session-id')
  expect(profile.models).toEqual([])
  expect(profile.keyless).toBe(true)
})
