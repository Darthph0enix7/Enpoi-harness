/**
 * Manifest-table invariants: every heavy provider is fully declared, only a
 * route served by its own adapter declares a key pool (an llm-pi-ai route
 * must not — its fronting service owns the keys), and commandcode is a
 * direct-vendor route whose fresh-machine dependency is the provider package.
 */
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS, manifestById, manifestProblems, platformUnsupported, resolveHeavyInstall } from '../src/manifests.js'
import { substitute } from '../src/planner.js'

it('declares the three heavy providers with no structural problems', () => {
  expect(manifestProblems()).toEqual([])
  expect(HEAVY_MANIFESTS.map(manifest => manifest.id)).toEqual(['freellmapi', 'antigravity', 'commandcode'])
})

it('declares a key pool only on routes served by their own settings namespace', () => {
  // The shipped llm-pi-ai heavy routes must never declare a DSH pool: the
  // antigravity proxy runs its own account pool and freellmapi uses one
  // unified key, so a pool there would double-manage the same credentials.
  for (const manifest of HEAVY_MANIFESTS) {
    if (manifest.settingsNs === undefined) {
      expect(JSON.stringify(manifest), manifest.id).not.toContain('"pool"')
      expect(JSON.stringify(manifest), manifest.id).not.toContain('identities')
    }
  }
  // commandcode is served by its own adapter, so `pool` is that adapter's own
  // schema and never reaches the llm-pi-ai section.
  const commandcode = manifestById('commandcode')
  expect(commandcode?.pool).toEqual({
    strategy: 'priority-sticky',
    identities: [{ id: 'key-1', credentialRef: 'COMMANDCODE_KEY_1', priority: 1 }],
  })
})

it('rejects a key pool on a manifest that writes to llm-pi-ai', () => {
  const broken = { ...manifestById('freellmapi')!, pool: manifestById('commandcode')!.pool }
  expect(manifestProblems([broken]).join('\n')).toContain('a key pool needs its own settingsNs')
})

it('rejects a direct manifest that could only send anonymous requests', () => {
  const direct = manifestById('commandcode')!
  const broken = { ...direct, pool: undefined, auth: { kind: 'none' as const, apiKeyEnv: 'COMMANDCODE_KEY_1', keyless: true } }
  expect(manifestProblems([broken]).join('\n')).toContain('a direct route must declare a key pool or a non-keyless auth kind')
})

it('antigravity is a loopback anthropic route with a placeholder ref, never keyless', () => {
  const manifest = manifestById('antigravity')
  expect(manifest?.protocol).toBe('anthropic-messages')
  expect(manifest?.auth).toEqual({ kind: 'placeholder', apiKeyEnv: 'ANTIGRAVITY_API_KEY', keyless: false })
  expect(manifest?.reuse.baseURL).toBe('http://127.0.0.1:8082')
  expect(manifest?.local.baseURL).toBe('http://127.0.0.1:8082')
  expect(manifest?.defaultPort).toBe(8082)
})

it('antigravity removal warns about other proxy consumers and a synced unit file', () => {
  const warnings = manifestById('antigravity')?.removal.warnings.join('\n') ?? ''
  expect(warnings).toContain('other tool')
  expect(warnings).toContain('dotfiles')
})

it('freellmapi removal drops the volume, the image, and the clone directory', () => {
  const steps = manifestById('freellmapi')?.removal.steps.map(step => step.command).join('\n') ?? ''
  expect(steps).toContain('compose down -v')
  expect(steps).toContain('image rm')
  // The install offers Podman as the Docker substitute, so teardown resolves
  // whichever engine exists instead of hardcoding `docker`.
  expect(steps).toContain('command -v docker || command -v podman')
  expect(steps).toContain('rm -rf {home}/freellmapi')
})

it('freellmapi surface quirks name the unified key, ENCRYPTION_KEY, and the local dependency statement', () => {
  const quirks = manifestById('freellmapi')?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Unified key')
  expect(quirks).toContain('ENCRYPTION_KEY')
  expect(quirks).toContain('native installers for Linux/macOS/Windows; Docker required only for the fallback path')
})

it('browser badges belong only to the browser-bound account flow (antigravity OAuth)', () => {
  expect(manifestById('freellmapi')?.requiresBrowser).toEqual([])
  expect(manifestById('commandcode')?.requiresBrowser).toEqual([])
  expect(manifestById('antigravity')?.requiresBrowser.length).toBeGreaterThan(0)
  expect(manifestById('antigravity')?.requiresBrowser.join('\n')).toContain('OAuth')
})

it('every heavy provider states its local install dependencies (Docker never required except the fallback path)', () => {
  for (const manifest of HEAVY_MANIFESTS) {
    expect(manifest.quirks.join('\n'), manifest.id).toContain('Local install dependencies:')
  }
  expect(manifestById('antigravity')?.quirks.join('\n')).toContain('Docker is never required')
  expect(manifestById('commandcode')?.quirks.join('\n')).toContain('Docker is never required')
})

it('commandcode is a direct-vendor custom-protocol route with its own pool', () => {
  const manifest = manifestById('commandcode')
  expect(manifest?.unsupported).toBeUndefined()
  expect(manifest?.delivery).toBe('direct')
  expect(manifest?.reuse.baseURL).toBe('https://api.commandcode.ai')
  expect(manifest?.local.baseURL).toBe('https://api.commandcode.ai')
  expect(manifest?.protocol).toBe('commandcode/alpha-generate')
  // llm-pi-ai cannot parse this protocol; the profile must go elsewhere.
  expect(manifest?.settingsNs).toBe('commandcode-provider')
  expect(manifest?.auth).toEqual({ kind: 'unified', apiKeyEnv: 'COMMANDCODE_KEY_1', keyless: false })
  expect(manifest?.local.install.default.steps.length).toBeGreaterThan(0)
})

it('commandcode local install only links/builds the provider package, never a keypool', () => {
  const manifest = manifestById('commandcode')!
  const commands = manifest.local.install.default.steps.map(step => step.command).join('\n')
  expect(commands).toContain('enpoi-commandcode-provider/scripts/install.mjs')
  expect(commands).not.toContain('keypool')
  expect(commands).not.toContain('systemctl')
  expect(commands).not.toContain('launchctl')
  expect(commands).not.toContain('curl')
  // Every POSIX platform resolves the one shared setup step.
  for (const platform of ['linux', 'darwin'] as const) {
    expect(resolveHeavyInstall(manifest.local, platform).steps).toEqual(manifest.local.install.default.steps)
  }
})

it('a served non-llm-pi-ai protocol without settingsNs is a manifest problem', () => {
  const broken = { ...manifestById('commandcode')!, settingsNs: undefined }
  expect(manifestProblems([broken]).some(problem => problem.includes('settingsNs'))).toBe(true)
})

it('commandcode removal has no local teardown and never mentions a shared keypool', () => {
  const manifest = manifestById('commandcode')
  expect(manifest?.removal.steps).toEqual([])
  const text = JSON.stringify(manifest?.removal)
  expect(text).toContain('Keys card')
  expect(text).not.toContain('keypool service')
  expect(text).not.toContain('usage.jsonl')
})

it('commandcode descriptions keep the vendor gate, adapter, migration, and quota facts', () => {
  const quirks = manifestById('commandcode')?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Proxy use detected')
  expect(quirks).toContain('dsh-enpoi-commandcode-provider')
  expect(quirks).toContain('Keys card')
  expect(quirks).toContain('import-keypool-keys.mjs')
  expect(quirks).toContain('QUOTA failure')
  expect(quirks).not.toContain('the shared keypool service')
  expect(manifestById('commandcode')?.reuse.note).toContain('provider package')
})

it('freellmapi installs are platform-keyed and fall back to the Docker path', () => {
  const local = manifestById('freellmapi')!.local
  const linux = resolveHeavyInstall(local, 'linux')
  // Linux uses the engine-aware compose path: the vendor one-liner is
  // Docker-only, while preflight accepts Podman as the substitute runtime.
  expect(linux.steps[0]!.command).toContain('git clone')
  expect(linux.steps.map(step => step.command).join('\n')).toContain('command -v docker || command -v podman')
  const darwin = resolveHeavyInstall(local, 'darwin')
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

it('freellmapi install steps are idempotent and resolve the container engine at run time', () => {
  const freellmapi = manifestById('freellmapi')!
  const compose = freellmapi.local.install.default.steps.map(step => step.command).join('\n')
  expect(compose).toContain('test -d {home}/freellmapi/.git || git clone')
  expect(compose).toContain('command -v docker || command -v podman')

  // Linux resolves to the same engine-aware compose path, so a Podman-only
  // host that preflight approved can actually install.
  const linux = resolveHeavyInstall(freellmapi.local, 'linux').steps.map(step => step.command).join('\n')
  expect(linux).toContain('command -v docker || command -v podman')
  expect(linux).not.toContain('needs Docker Engine')

  const darwin = resolveHeavyInstall(freellmapi.local, 'darwin').steps.map(step => step.command).join('\n')
  expect(darwin).toContain('uname -m')
  expect(darwin).toContain('no FreeLLMAPI $arch .dmg')
})

it('exposes {dshHome} substitution, never a literal ~/.dsh path', () => {
  expect(substitute('node {dshHome}/profiles/web/x.mjs {config}/y', '/users/jo', '/srv/dsh'))
    .toBe('node /srv/dsh/profiles/web/x.mjs /users/jo/.config/y')
  // Without an explicit DSH home the standard <home>/.dsh layout is used.
  expect(substitute('{dshHome}/cache', '/users/jo')).toBe('/users/jo/.dsh/cache')
  const commands = manifestById('commandcode')!.local.install.default.steps.map(step => step.command).join('\n')
  expect(commands).not.toContain('{home}/.dsh')
  expect(commands).toContain('{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/install.mjs')
  // A direct route has no local teardown step to substitute.
  expect(manifestById('commandcode')!.removal.steps).toEqual([])
})

it('runs a user service only where the manifest declares one (antigravity)', () => {
  const antigravity = manifestById('antigravity')!
  const linux = resolveHeavyInstall(antigravity.local, 'linux').steps.map(step => step.command).join('\n')
  expect(linux).toContain('systemctl --user')
  expect(linux).not.toContain('launchctl')

  const darwin = resolveHeavyInstall(antigravity.local, 'darwin').steps.map(step => step.command).join('\n')
  expect(darwin).toContain('{home}/Library/LaunchAgents/')
  expect(darwin).toContain('launchctl bootout')
  expect(darwin).toContain('launchctl bootstrap')
  expect(darwin).toContain('{home}/Library/Logs/')
  expect(darwin).not.toContain('systemctl')

  // The default variant is the systemd path, so an unknown POSIX platform
  // never receives launchd steps.
  expect(resolveHeavyInstall(antigravity.local, 'freebsd').steps).toEqual(
    resolveHeavyInstall(antigravity.local, 'linux').steps,
  )

  // commandcode is a direct vendor route: no user service on any platform.
  const commandcode = manifestById('commandcode')!
  for (const platform of ['linux', 'darwin'] as const) {
    const steps = resolveHeavyInstall(commandcode.local, platform).steps.map(step => step.command).join('\n')
    expect(steps, platform).not.toContain('systemctl')
    expect(steps, platform).not.toContain('launchctl')
    expect(steps, platform).not.toContain('curl')
  }
})

it('starts the antigravity proxy in its foreground mode, never a bare help invocation', () => {
  const manifest = manifestById('antigravity')!
  for (const platform of ['linux', 'darwin'] as const) {
    const commands = resolveHeavyInstall(manifest.local, platform).steps.map(step => step.command).join('\n')
    expect(commands, platform).toContain('antigravity-claude-proxy start --log')
    // A bare `antigravity-claude-proxy` only prints help and exits; the
    // service wrapper must never be built from it.
    expect(commands, platform).not.toMatch(/exec antigravity-claude-proxy(?! start --log)/)
  }
  const teardown = manifest.removal.steps.map(step => step.command).join('\n')
  expect(teardown).toContain('antigravity-claude-proxy stop')
})

it('refuses Windows with a declared reason instead of a command that cannot work', () => {
  for (const id of ['antigravity', 'commandcode']) {
    const manifest = manifestById(id)!
    const reason = platformUnsupported(manifest, 'win32')
    expect(reason, id).toBeDefined()
    expect(reason, id).toContain('Windows')
    expect(resolveHeavyInstall(manifest.local, 'win32').steps, id).toEqual([])
    expect(platformUnsupported(manifest, 'linux'), id).toBeUndefined()
    expect(platformUnsupported(manifest, 'darwin'), id).toBeUndefined()
  }
  // FreeLLMAPI keeps its vendor desktop-app path on Windows.
  const freellmapi = resolveHeavyInstall(manifestById('freellmapi')!.local, 'win32')
  expect(platformUnsupported(manifestById('freellmapi')!, 'win32')).toBeUndefined()
  expect(freellmapi.steps[0]!.command).toContain('.exe')
})

it('the antigravity teardown removes whichever user-service file the platform wrote', () => {
  const commands = manifestById('antigravity')!.removal.steps.map(step => step.command).join('\n')
  expect(commands).toContain('systemctl --user disable --now antigravity-proxy.service')
  expect(commands).toContain('launchctl bootout')
  expect(commands).toContain('{config}/systemd/user/antigravity-proxy.service')
  expect(commands).toContain('{home}/Library/LaunchAgents/dev.enpoi.antigravity-proxy.plist')
})

it('flags an install variant whose declared runtime contradicts its steps', () => {
  const antigravity = manifestById('antigravity')!
  const dockerDeclared = {
    ...antigravity,
    local: { ...antigravity.local, runtime: 'docker' as const },
  }
  expect(manifestProblems([dockerDeclared]).join('\n')).toContain('declares runtime "docker" but its steps invoke node tooling instead')
  const freellmapi = manifestById('freellmapi')!
  const nodeDeclared = {
    ...freellmapi,
    local: { ...freellmapi.local, runtime: 'node' as const },
  }
  expect(manifestProblems([nodeDeclared]).join('\n')).toContain('declares runtime "node" but its steps invoke docker/podman tooling instead')
  // ...and the shipped table stays clean.
  expect(manifestProblems()).toEqual([])
})
