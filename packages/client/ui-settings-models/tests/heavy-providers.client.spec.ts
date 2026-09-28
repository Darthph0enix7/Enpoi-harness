/**
 * Heavy provider presets: listed in Add Provider, manifest-complete, usable
 * only through the host's add flow (no route exists by listing alone), and
 * carrying platform-keyed install paths with a default fallback.
 */
import { expect, it } from 'vitest'
import {
  HEAVY_PRESET_IDS,
  fallbackHeavyManifest,
  heavyDashboardUrls,
  heavyProviderProblems,
  resolveHeavyInstall,
} from '../src/client/heavy-providers.ts'
import { PROVIDER_TEMPLATES, providerDashboardUrls } from '../src/client/provider-templates.ts'

it('the manifest table is structurally complete', () => {
  expect(heavyProviderProblems()).toEqual([])
  expect([...HEAVY_PRESET_IDS]).toEqual(['freellmapi', 'antigravity', 'commandcode'])
})

it('an uninstalled heavy provider is listed in Add Provider with its manifest', () => {
  const listing = new Map(PROVIDER_TEMPLATES.map(template => [template.id, template]))
  for (const manifest of [fallbackHeavyManifest('freellmapi')!, fallbackHeavyManifest('antigravity')!, fallbackHeavyManifest('commandcode')!]) {
    const template = listing.get(manifest.id)
    expect(template, `${manifest.id} must be listed`).toBeDefined()
    expect(template?.heavy?.id).toBe(manifest.id)
    expect(template?.name).toBe(manifest.label)
  }
})

it('the heavy descriptors surface dashboard, browser badges, modes, and health', () => {
  for (const id of HEAVY_PRESET_IDS) {
    const manifest = fallbackHeavyManifest(id)
    expect(manifest?.dashboardUrl, id).toBeDefined()
    expect(manifest?.reuse.health.url, id).not.toBe('')
    expect(manifest?.requiresBrowser.length, id).toBeGreaterThan(0)
    if (manifest?.unsupported === undefined) {
      expect(manifest?.local.install.default.steps.length, id).toBeGreaterThan(0)
      expect(manifest?.reuse.baseURL, id).not.toBe('')
    }
  }
})

it('antigravity never declares a DSH key pool and is not keyless', () => {
  const manifest = fallbackHeavyManifest('antigravity')
  expect(JSON.stringify(manifest)).not.toContain('"pool"')
  expect(manifest?.auth.keyless).toBe(false)
  expect(manifest?.protocol).toBe('anthropic-messages')
})

it('the pre-connection fallback marks commandcode addable with the real keypool facts', () => {
  const manifest = fallbackHeavyManifest('commandcode')
  expect(manifest?.unsupported).toBeUndefined()
  expect(manifest?.settingsNs).toBe('commandcode-provider')
  expect(manifest?.auth).toEqual({ kind: 'none', apiKeyEnv: 'COMMANDCODE_API_KEY', keyless: true })
  expect(manifest?.reuse.baseURL).toBe('http://127.0.0.1:8899/commandcode')
  expect(manifest?.local.install.default.steps.length).toBeGreaterThan(0)
  expect(manifest?.local.install.default.steps.map(step => step.command).join('\n'))
    .toContain('enpoi-commandcode-provider/scripts/install.mjs')
  expect(manifest?.removal.steps.map(step => step.command).join('\n')).toContain('keypool-remove.mjs')
  expect(JSON.stringify(manifest?.removal)).toContain('never stops or removes the shared keypool service')
  const quirks = manifest?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Proxy use detected')
  expect(quirks).toContain('QUOTA failure')
})

it('freellmapi defaults to the loopback endpoint in both modes', () => {
  const manifest = fallbackHeavyManifest('freellmapi')
  expect(manifest?.reuse.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(manifest?.local.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(manifest?.defaultPort).toBe(3002)
  expect(manifest?.reuse.label).toBe('Use a detected instance')
  expect(manifest?.removal.steps.map(step => step.command).join('\n')).toContain('docker compose down -v')
})

it('selects platform-keyed installs and falls back to the Docker path', () => {
  const local = fallbackHeavyManifest('freellmapi')!.local
  const linux = resolveHeavyInstall(local, 'linux')
  expect(linux.steps[0]!.command).toContain('freellmapi.co/install.sh')
  expect(linux.steps[0]!.command).toContain('PORT=3002')
  const darwin = resolveHeavyInstall(local, 'darwin')
  expect(darwin.label).toContain('desktop app')
  expect(darwin.deps).toEqual(['macOS 11+'])
  expect(darwin.steps[0]!.command).toContain('.dmg')
  expect(darwin.steps.map(step => step.command).join('\n')).toContain('"port":3002')
  const win32 = resolveHeavyInstall(local, 'win32')
  expect(win32.deps).toEqual(['Windows 10+'])
  expect(win32.steps[0]!.command).toContain('.exe')
  const unknown = resolveHeavyInstall(local, 'freebsd')
  expect(unknown.label).toBe(local.label)
  expect(unknown.steps[0]!.command).toContain('git clone')
})

it('dashboard URLs cover both modes and deduplicate to the loopback dashboard', () => {
  const manifest = fallbackHeavyManifest('freellmapi')!
  expect(heavyDashboardUrls(manifest)).toEqual(['http://127.0.0.1:3002'])
  expect(heavyDashboardUrls(manifest, 'reuse')).toEqual(['http://127.0.0.1:3002'])
  expect(heavyDashboardUrls(manifest, 'local')).toEqual(['http://127.0.0.1:3002'])
  expect(providerDashboardUrls('freellmapi')).toEqual(heavyDashboardUrls(manifest))
  // An ordinary API provider with no declared console yields no fake URL.
  expect(providerDashboardUrls('openai')).toEqual([])
})
