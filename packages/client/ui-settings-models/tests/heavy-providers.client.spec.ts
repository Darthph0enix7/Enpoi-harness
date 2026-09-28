/**
 * Heavy provider presets: listed in Add Provider, manifest-complete, and
 * usable only through the host's add flow (no route exists by listing alone).
 */
import { expect, it } from 'vitest'
import { HEAVY_PRESET_IDS, heavyProviderManifest, heavyProviderProblems } from '../src/client/heavy-providers.ts'
import { PROVIDER_TEMPLATES } from '../src/client/provider-templates.ts'

it('the manifest table is structurally complete', () => {
  expect(heavyProviderProblems()).toEqual([])
  expect([...HEAVY_PRESET_IDS]).toEqual(['freellmapi', 'antigravity', 'commandcode'])
})

it('an uninstalled heavy provider is listed in Add Provider with its manifest', () => {
  const listing = new Map(PROVIDER_TEMPLATES.map(template => [template.id, template]))
  for (const manifest of [heavyProviderManifest('freellmapi')!, heavyProviderManifest('antigravity')!, heavyProviderManifest('commandcode')!]) {
    const template = listing.get(manifest.id)
    expect(template, `${manifest.id} must be listed`).toBeDefined()
    expect(template?.heavy?.id).toBe(manifest.id)
    expect(template?.name).toBe(manifest.label)
  }
})

it('the heavy descriptors surface dashboard, browser badges, modes, and health', () => {
  for (const id of HEAVY_PRESET_IDS) {
    const manifest = heavyProviderManifest(id)
    expect(manifest?.dashboardUrl, id).toBeDefined()
    expect(manifest?.reuse.health.url, id).not.toBe('')
    expect(manifest?.requiresBrowser.length, id).toBeGreaterThan(0)
    if (manifest?.unsupported === undefined) {
      expect(manifest?.local.install.length, id).toBeGreaterThan(0)
      expect(manifest?.reuse.baseURL, id).not.toBe('')
    }
  }
})

it('antigravity never declares a DSH key pool and is not keyless', () => {
  const manifest = heavyProviderManifest('antigravity')
  expect(JSON.stringify(manifest)).not.toContain('"pool"')
  expect(manifest?.auth.keyless).toBe(false)
  expect(manifest?.protocol).toBe('anthropic-messages')
})

it('freellmapi reuse points at the server gateway, local at loopback', () => {
  const manifest = heavyProviderManifest('freellmapi')
  expect(manifest?.reuse.baseURL).toBe('http://100.122.163.25:3002/v1')
  expect(manifest?.local.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(manifest?.removal.steps.map(step => step.command).join('\n')).toContain('docker compose down -v')
})
