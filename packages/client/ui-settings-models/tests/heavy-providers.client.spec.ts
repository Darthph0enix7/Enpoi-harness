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
  heavyManifestProblems,
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

it('the heavy descriptors surface dashboard, modes, and health', () => {
  for (const id of HEAVY_PRESET_IDS) {
    const manifest = fallbackHeavyManifest(id)
    expect(manifest?.docsUrl, id).toBeDefined()
    expect(manifest?.reuse.health.url, id).not.toBe('')
    if (manifest?.unsupported === undefined) {
      expect(manifest?.local.install.default.steps.length, id).toBeGreaterThan(0)
      expect(manifest?.reuse.baseURL, id).not.toBe('')
    }
  }
  // A service provider links its loopback dashboard; the direct vendor route
  // has no provider-owned UI (its dashboard is the vendor site in docsUrl).
  expect(fallbackHeavyManifest('freellmapi')?.dashboardUrl).toBeDefined()
  expect(fallbackHeavyManifest('antigravity')?.dashboardUrl).toBeDefined()
  expect(fallbackHeavyManifest('commandcode')?.dashboardUrl).toBeUndefined()
})

it('browser badges belong only to the browser-bound account flow (antigravity OAuth)', () => {
  expect(fallbackHeavyManifest('freellmapi')?.requiresBrowser).toEqual([])
  expect(fallbackHeavyManifest('commandcode')?.requiresBrowser).toEqual([])
  expect(fallbackHeavyManifest('antigravity')?.requiresBrowser.length).toBeGreaterThan(0)
  expect(fallbackHeavyManifest('antigravity')?.requiresBrowser.join('\n')).toContain('OAuth')
})

it('every heavy provider states its local dependency line, Docker never the general requirement', () => {
  for (const id of HEAVY_PRESET_IDS) {
    expect(fallbackHeavyManifest(id)?.quirks.join('\n'), id).toContain('Local install dependencies:')
  }
  expect(fallbackHeavyManifest('freellmapi')?.quirks.join('\n'))
    .toContain('native installers for Linux/macOS/Windows; Docker required only for the fallback path')
  expect(fallbackHeavyManifest('antigravity')?.quirks.join('\n')).toContain('Docker is never required')
  expect(fallbackHeavyManifest('commandcode')?.quirks.join('\n')).toContain('Docker is never required')
})

it('antigravity never declares a DSH key pool and is not keyless', () => {
  const manifest = fallbackHeavyManifest('antigravity')
  expect(JSON.stringify(manifest)).not.toContain('"pool"')
  expect(manifest?.auth.keyless).toBe(false)
  expect(manifest?.protocol).toBe('anthropic-messages')
})

it('the pre-connection fallback marks commandcode addable with the direct-vendor facts', () => {
  const manifest = fallbackHeavyManifest('commandcode')
  expect(manifest?.unsupported).toBeUndefined()
  expect(manifest?.delivery).toBe('direct')
  expect(manifest?.settingsNs).toBe('commandcode-provider')
  expect(manifest?.auth).toEqual({ kind: 'unified', apiKeyEnv: 'COMMANDCODE_KEY_1', keyless: false })
  expect(manifest?.pool).toEqual({
    strategy: 'priority-sticky',
    identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }],
  })
  expect(manifest?.defaultPort).toBe(443)
  expect(manifest?.reuse.baseURL).toBe('https://api.commandcode.ai')
  expect(manifest?.reuse.health.url).toBe('https://api.commandcode.ai/')
  expect(manifest?.local.baseURL).toBe('https://api.commandcode.ai')
  const steps = manifest?.local.install.default.steps.map(step => step.command).join('\n') ?? ''
  expect(steps).toContain('enpoi-commandcode-provider/scripts/install.mjs')
  expect(steps).toContain('{dshHome}')
  expect(steps).not.toContain('keypool-seed.mjs')
  // Windows is refused with the honest /bin/bash reason before any step runs.
  expect(manifest?.local.install.win32?.unsupported).toContain('/bin/bash')
  expect(resolveHeavyInstall(manifest!.local, 'win32')).toMatchObject({ label: 'Not supported on Windows', steps: [] })
  // No keypool teardown: removal carries no local steps and names only DSH state.
  expect(manifest?.removal.steps).toEqual([])
  expect(JSON.stringify(manifest?.removal)).toContain('COMMANDCODE_KEY_1')
  expect(JSON.stringify(manifest?.removal)).toContain('Keys card')
  const quirks = manifest?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Docker is never required')
  expect(quirks).toContain('Proxy use detected')
  expect(quirks).toContain('QUOTA failure')
  expect(quirks).toContain('MISSING_CREDENTIAL')
  expect(quirks).toContain('import-keypool-keys.mjs')
  expect(quirks).not.toContain(':8899')
})

it('freellmapi defaults to the loopback endpoint in both modes', () => {
  const manifest = fallbackHeavyManifest('freellmapi')
  expect(manifest?.reuse.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(manifest?.local.baseURL).toBe('http://127.0.0.1:3002/v1')
  expect(manifest?.defaultPort).toBe(3002)
  expect(manifest?.reuse.label).toBe('Use a detected instance')
  expect(manifest?.local.label).toBe('Install locally (Docker or Podman)')
  expect(manifest?.local.deps).toEqual(['Docker Engine or Podman, with Compose'])
  // Teardown resolves the engine the install used, so a Podman machine cleans up too.
  const removal = manifest?.removal.steps.map(step => step.command).join('\n') ?? ''
  expect(removal).toContain('command -v docker || command -v podman')
  expect(removal).toContain('compose down -v')
})

it('selects platform-keyed installs and falls back to the Docker path', () => {
  const local = fallbackHeavyManifest('freellmapi')!.local
  // No Linux override: the vendor one-liner is Docker-only, so Linux resolves
  // the same engine-aware compose path as every other unlisted platform.
  expect(local.install.linux).toBeUndefined()
  const linux = resolveHeavyInstall(local, 'linux')
  expect(linux.label).toBe('Install locally (Docker or Podman)')
  expect(linux.steps[0]!.command).toContain('test -d {home}/freellmapi/.git || git clone')
  expect(linux.steps.map(step => step.command).join('\n')).toContain('command -v docker || command -v podman')
  const darwin = resolveHeavyInstall(local, 'darwin')
  expect(darwin.label).toContain('desktop app')
  expect(darwin.deps).toEqual(['macOS 11+'])
  // The .dmg is picked by architecture: Apple Silicon vs Intel.
  expect(darwin.steps[0]!.command).toContain('.dmg')
  expect(darwin.steps[0]!.command).toContain('uname -m')
  expect(darwin.steps.map(step => step.command).join('\n')).toContain('"port":3002')
  const win32 = resolveHeavyInstall(local, 'win32')
  expect(win32.deps).toEqual(['Windows 10+'])
  expect(win32.steps[0]!.command).toContain('.exe')
  const unknown = resolveHeavyInstall(local, 'freebsd')
  expect(unknown.label).toBe(local.label)
  expect(unknown.steps[0]!.command).toContain('git clone')
})

it('antigravity installs resolve per platform: systemd on Linux, launchd on macOS, refused on Windows', () => {
  const local = fallbackHeavyManifest('antigravity')!.local
  expect(local.label).toBe('Install locally (npm + user service)')
  // The bare CLI only prints help; the service must keep `start --log` running.
  for (const platform of ['linux', 'default'] as const) {
    const resolved = resolveHeavyInstall(local, platform)
    expect(resolved.label).toBe('Install locally (npm + systemd user unit)')
    const commands = resolved.steps.map(step => step.command).join('\n')
    expect(commands).toContain('ExecStart=/bin/bash -lc \'exec antigravity-claude-proxy start --log\'')
    expect(commands).not.toMatch(/exec antigravity-claude-proxy(?! start --log)/)
    expect(resolved.unsupported).toBeUndefined()
  }
  const darwin = resolveHeavyInstall(local, 'darwin')
  expect(darwin.label).toBe('Install locally (npm + launchd agent)')
  expect(darwin.deps).toEqual(['Node.js >= 18', 'macOS 11+ (launchd)'])
  const launchd = darwin.steps.map(step => step.command).join('\n')
  expect(launchd).toContain('dev.enpoi.antigravity-proxy.plist')
  expect(launchd).toContain('<key>RunAtLoad</key>')
  expect(launchd).toContain('<key>KeepAlive</key>')
  expect(launchd).toContain('/opt/homebrew/bin:/usr/local/bin:{home}/.local/bin')
  expect(launchd).toContain('launchctl bootstrap')
  expect(launchd).not.toContain('systemctl')
  // Windows is refused with its reason before any step runs.
  const win32 = resolveHeavyInstall(local, 'win32')
  expect(win32.label).toBe('Not supported on Windows')
  expect(win32.steps).toEqual([])
  expect(win32.unsupported).toContain('POSIX user service (systemd or launchd)')
  // Teardown is platform-neutral: it stops whichever user service the platform wrote.
  const removal = fallbackHeavyManifest('antigravity')!.removal.steps.map(step => step.command).join('\n')
  expect(removal).toContain('systemctl --user disable --now antigravity-proxy.service')
  expect(removal).toContain('launchctl bootout gui/$(id -u)/dev.enpoi.antigravity-proxy')
  expect(removal).toContain('antigravity-claude-proxy stop')
})

it('the manifest mirror rejects malformed platform variants and unsupported reasons', () => {
  const antigravity = fallbackHeavyManifest('antigravity')!
  const emptyReason = {
    ...antigravity,
    local: {
      ...antigravity.local,
      install: { ...antigravity.local.install, win32: { ...antigravity.local.install.win32!, unsupported: '   ' } },
    },
  }
  expect(heavyManifestProblems(emptyReason).join('\n')).toContain('platform install variant 3 declares an empty unsupported reason')
  const stepLess = {
    ...antigravity,
    local: { ...antigravity.local, install: { ...antigravity.local.install, darwin: { label: 'Install locally (npm + launchd agent)', steps: [] } } },
  }
  expect(heavyManifestProblems(stepLess).join('\n')).toContain('platform install variant 2 has no steps')
  const freellmapi = fallbackHeavyManifest('freellmapi')!
  const missingLocalHealth = { ...freellmapi, local: { ...freellmapi.local, health: { url: '' } } }
  expect(heavyManifestProblems(missingLocalHealth).join('\n')).toContain('local.health.url is empty')
  const healthlessLocal = { ...freellmapi, local: { ...freellmapi.local, health: 42 } }
  expect(heavyManifestProblems(healthlessLocal).join('\n')).toContain('local.health.url is empty')
  const noLocal = { ...freellmapi, local: undefined }
  expect(heavyManifestProblems(noLocal).join('\n')).toContain('local.health.url is empty')
  // The shipped table (with the platform variants) is still problem-free.
  expect(heavyProviderProblems()).toEqual([])
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
