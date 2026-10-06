/**
 * Manifest-table invariants: every heavy provider is fully declared, the
 * antigravity route never opts into DSH key pooling, and commandcode ships as
 * an explicit unsupported-but-documented reuse path.
 */
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS, manifestById, manifestProblems, platformUnsupported, resolveHeavyInstall } from '../src/manifests.js'
import { substitute } from '../src/planner.js'

it('declares the three heavy providers with no structural problems', () => {
  expect(manifestProblems()).toEqual([])
  expect(HEAVY_MANIFESTS.map(manifest => manifest.id)).toEqual(['freellmapi', 'antigravity', 'commandcode'])
})

it('keeps every manifest free of DSH key-pool declarations', () => {
  const serialized = JSON.stringify(HEAVY_MANIFESTS)
  expect(serialized).not.toContain('"pool"')
  expect(serialized).not.toContain('identities')
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

it('commandcode is a served custom-protocol route on its own settings namespace', () => {
  const manifest = manifestById('commandcode')
  expect(manifest?.unsupported).toBeUndefined()
  expect(manifest?.reuse.baseURL).toBe('http://127.0.0.1:8899/commandcode')
  expect(manifest?.protocol).toBe('commandcode/alpha-generate')
  // llm-pi-ai cannot parse this protocol; the profile must go elsewhere.
  expect(manifest?.settingsNs).toBe('commandcode-provider')
  expect(manifest?.local.baseURL).toBe('http://127.0.0.1:8899/commandcode')
  expect(manifest?.local.install.default.steps.length).toBeGreaterThan(0)
})

it('commandcode local install wires the provider package and the keypool', () => {
  const commands = manifestById('commandcode')!.local.install.default.steps.map(step => step.command).join('\n')
  expect(commands).toContain('enpoi-commandcode-provider/scripts/install.mjs')
  expect(commands).toContain('keypool-seed.mjs')
  expect(commands).toContain('keypool.service')
})

it('a served non-llm-pi-ai protocol without settingsNs is a manifest problem', () => {
  const broken = { ...manifestById('commandcode')!, settingsNs: undefined }
  expect(manifestProblems([broken]).some(problem => problem.includes('settingsNs'))).toBe(true)
})

it('commandcode removal drops only the commandcode pool, never the shared keypool service', () => {
  const manifest = manifestById('commandcode')
  const commands = manifest?.removal.steps.map(step => step.command).join('\n') ?? ''
  expect(commands).toContain('keypool-remove.mjs')
  expect(commands).not.toContain('systemctl')
  expect(commands).not.toContain('rm -rf')
  const text = JSON.stringify(manifest?.removal)
  expect(text).toContain('never stops or removes the shared keypool service')
  expect(text).toContain('usage.jsonl')
})

it('commandcode descriptions keep the keypool, package, removal, and quota facts', () => {
  const quirks = manifestById('commandcode')?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Proxy use detected')
  expect(quirks).toContain('dsh-enpoi-commandcode-provider')
  expect(quirks).toContain('never stop or remove the shared keypool service')
  expect(quirks).toContain('QUOTA failure')
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
  const removal = manifestById('commandcode')!.removal.steps.map(step => step.command).join('\n')
  expect(removal).not.toContain('{home}/.dsh')
  expect(removal).toContain('{dshHome}/profiles/web/packages/enpoi-commandcode-provider/scripts/keypool-remove.mjs')
})

it('fails the keypool-proxy step fast with every searched location instead of skipping silently', () => {
  const proxy = manifestById('commandcode')!.local.install.default.steps
    .find(step => step.command.includes('keypool/proxy.js'))
  expect(proxy?.optional).toBeUndefined()
  expect(proxy?.command).toContain('exit 1')
  expect(proxy?.command).toContain('not found')
  expect(proxy?.command).toContain('{config}/opencode/keypool/proxy.js')
  expect(proxy?.command).toContain('{dshHome}/dotfiles/opencode-dotfiles/keypool/proxy.js')
  expect(proxy?.command).toContain('{home}/dotfiles/opencode-dotfiles/keypool/proxy.js')
  // Re-running with a placed proxy is a no-op.
  expect(proxy?.command).toContain('already present')
})

it('provisions Linux with systemd and macOS with launchd for both user-service providers', () => {
  for (const id of ['antigravity', 'commandcode']) {
    const manifest = manifestById(id)!
    const linux = resolveHeavyInstall(manifest.local, 'linux').steps.map(step => step.command).join('\n')
    expect(linux, id).toContain('systemctl --user')
    expect(linux, id).not.toContain('launchctl')

    const darwin = resolveHeavyInstall(manifest.local, 'darwin').steps.map(step => step.command).join('\n')
    expect(darwin, id).toContain('{home}/Library/LaunchAgents/')
    expect(darwin, id).toContain('launchctl bootout')
    expect(darwin, id).toContain('launchctl bootstrap')
    expect(darwin, id).toContain('{home}/Library/Logs/')
    expect(darwin, id).not.toContain('systemctl')

    // The default variant is the systemd path, so an unknown POSIX platform
    // never receives launchd steps.
    expect(resolveHeavyInstall(manifest.local, 'freebsd').steps).toEqual(
      resolveHeavyInstall(manifest.local, 'linux').steps,
    )
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
