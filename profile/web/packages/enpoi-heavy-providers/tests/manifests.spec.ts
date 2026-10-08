/**
 * Manifest-table invariants: every heavy provider is fully declared, only a
 * route served by its own adapter declares a key pool (an llm-pi-ai route
 * must not — its fronting service owns the keys), and commandcode is a
 * direct-vendor route whose fresh-machine dependency is the provider package.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { COMMAND_CODE_CLI_HEADERS, COMMAND_CODE_CLI_VERSION } from '../../enpoi-commandcode-provider/src/headers.js'
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

it('freellmapi removal drops the volume, the image, the clone, and the desktop-app leftovers', () => {
  const steps = manifestById('freellmapi')!.removal.steps
  const commands = steps.map(step => step.command).join('\n')
  expect(commands).toContain('compose down -v')
  expect(commands).toContain('image rm')
  // The install offers Podman as the Docker substitute, so teardown resolves
  // whichever engine exists instead of hardcoding `docker`.
  expect(commands).toContain('command -v docker || command -v podman')
  expect(commands).toContain('rm -rf "{home}/freellmapi"')
  // Platform-guarded optional leftovers: the macOS app/data/dmg and the
  // Windows app/data/installer. Each is fail-soft on the other platforms.
  for (const label of ['Remove the macOS desktop app and its data', 'Remove the Windows desktop app and its data']) {
    const step = steps.find(candidate => candidate.label === label)
    expect(step, label).toBeDefined()
    expect(step?.optional, label).toBe(true)
  }
  expect(commands).toContain('test "$(uname -s)" = Darwin || exit 0')
  expect(commands).toContain('hdiutil detach "/tmp/freellmapi-dmg"')
  expect(commands).toContain('"$APPDATA/FreeLLMAPI"')
  expect(commands).toContain('"$LOCALAPPDATA/Programs/FreeLLMAPI"')
  expect(commands).toContain('FreeLLMAPI-Setup.exe')
  // A running desktop app must be stopped before its files are deleted; the
  // Each platform step guards first (so the kill never runs on a foreign OS),
  // then kills the running desktop app, then deletes.
  const mac = steps.find(step => step.label === 'Remove the macOS desktop app and its data')
  const win = steps.find(step => step.label === 'Remove the Windows desktop app and its data')
  expect(mac?.command.startsWith('test "$(uname -s)" = Darwin || exit 0; pkill -f FreeLLMAPI 2>/dev/null || true;')).toBe(true)
  expect(win?.command.startsWith('case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0;; esac; taskkill //F //IM FreeLLMAPI.exe 2>/dev/null || true;')).toBe(true)
})

it('freellmapi surface quirks name the unified key, ENCRYPTION_KEY, and the per-platform install fact', () => {
  const quirks = manifestById('freellmapi')?.quirks.join('\n') ?? ''
  expect(quirks).toContain('Unified key')
  expect(quirks).toContain('ENCRYPTION_KEY')
  // The stale "native installers for Linux" wording is gone: the shipped
  // Linux path is the Docker/Podman compose path.
  expect(quirks).toContain('Linux uses Docker/Podman compose; macOS/Windows use the vendor desktop app')
  expect(quirks).not.toContain('native installers for Linux/macOS/Windows')
  // Windows runs the install steps through Git Bash; the dependency is named.
  expect(quirks).toContain('Git Bash')
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

it('the freellmapi desktop-download steps resolve the one named release feed the manifest declares', () => {
  const manifest = manifestById('freellmapi')!
  expect(manifest.releasesApi).toBe('https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest')
  for (const platform of ['darwin', 'win32'] as const) {
    const download = resolveHeavyInstall(manifest.local, platform).steps[0]!
    expect(download.command, platform).toContain(`curl -fsSL ${manifest.releasesApi!}`)
  }
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
  expect(win32.deps).toEqual(['Windows 10+', 'Git Bash (the install steps run through bash)'])
  expect(win32.steps[0]!.command).toContain('.exe')
  // An empty asset match must fail the step before xargs ever runs.
  expect(win32.steps[0]!.command).toContain('freellmapi-setup-url')
  expect(win32.steps[0]!.command).toContain('test -s "{home}/Downloads/freellmapi-setup-url"')
  expect(win32.steps[0]!.command).toContain('no .exe in the latest release')
  const unknown = resolveHeavyInstall(local, 'freebsd')
  expect(unknown.label).toBe(local.label)
  expect(unknown.steps[0]!.command).toContain('git clone')
})

it('freellmapi install steps are idempotent and resolve the container engine at run time', () => {
  const freellmapi = manifestById('freellmapi')!
  const compose = freellmapi.local.install.default.steps.map(step => step.command).join('\n')
  // A stale non-git directory is replaced only when it holds no `.env`; the
  // ENCRYPTION_KEY in `.env` is unrecoverable once wiped.
  expect(compose).toContain('if [ -d "{home}/freellmapi" ] && [ ! -d "{home}/freellmapi/.git" ]')
  expect(compose).toContain('if [ -f "{home}/freellmapi/.env" ]')
  expect(compose).toContain('refusing to wipe it')
  expect(compose).toContain('test -d "{home}/freellmapi/.git" || git clone')
  expect(compose).toContain('grep -qE \'^ENCRYPTION_KEY=.+\'')
  expect(compose).toContain('command -v docker || command -v podman')
  // Podman without its compose plugin must fail at the version check, not
  // halfway through `up`.
  expect(compose).toContain('compose version >/dev/null 2>&1')
  expect(compose).toContain('podman compose plugin missing (need podman-compose)')

  // Linux resolves to the same engine-aware compose path, so a Podman-only
  // host that preflight approved can actually install.
  const linux = resolveHeavyInstall(freellmapi.local, 'linux').steps.map(step => step.command).join('\n')
  expect(linux).toContain('command -v docker || command -v podman')
  expect(linux).not.toContain('needs Docker Engine')

  const darwin = resolveHeavyInstall(freellmapi.local, 'darwin').steps.map(step => step.command).join('\n')
  expect(darwin).toContain('uname -m')
  expect(darwin).toContain('no FreeLLMAPI $arch .dmg')
  // The vendor asset name is `-<arch>.dmg`; the pattern must carry the
  // hyphen and the dmg is only fetched when missing.
  expect(darwin).toContain("+-'\"$arch\"'\\.dmg\"'")
  expect(darwin).toContain('test -f "{home}/Downloads/FreeLLMAPI.dmg" || curl')
  // The mount point is unique per run and always detached.
  expect(darwin).toContain('/tmp/freellmapi-dmg-$$')
  expect(darwin).toContain('hdiutil detach "$MOUNT"')
})

/**
 * Run the Clone FreeLLMAPI step for real against a scratch home and a stub
 * `git` on PATH: the guard, not the clone, is what these cases prove.
 */
function runCloneStep(home: string, gitStub: string): { status: number; stdout: string; stderr: string } {
  const bin = join(home, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'git'), gitStub, 'utf8')
  chmodSync(join(bin, 'git'), 0o755)
  const command = substitute(manifestById('freellmapi')!.local.install.default.steps[0]!.command, home, join(home, '.dsh'))
  try {
    return { status: 0, stdout: execFileSync('/bin/bash', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

it('the freellmapi clone guard refuses to wipe a non-git directory holding .env', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-clone-guard-'))
  try {
    const home = join(scratch, 'home')
    const clone = join(home, 'freellmapi')
    mkdirSync(clone, { recursive: true })
    writeFileSync(join(clone, '.env'), 'ENCRYPTION_KEY=deadbeef\n', 'utf8')
    // A stub git that must never run: the guard has to refuse before it.
    const result = runCloneStep(home, '#!/usr/bin/env bash\necho "git must not run" >&2\nexit 1\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to wipe it')
    // The .env survived untouched.
    expect(readFileSync(join(clone, '.env'), 'utf8')).toBe('ENCRYPTION_KEY=deadbeef\n')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('the freellmapi clone guard replaces a stale non-git directory without .env, then clones', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-clone-stale-'))
  try {
    const home = join(scratch, 'home')
    const clone = join(home, 'freellmapi')
    mkdirSync(clone, { recursive: true })
    writeFileSync(join(clone, 'stale.txt'), 'old', 'utf8')
    // The stub stands in for `git clone --depth 1 <url> <dest>`: it records the
    // destination's `.git`, which the following `test -d` sees on a re-run.
    const result = runCloneStep(home, '#!/usr/bin/env bash\nmkdir -p "$HOME/freellmapi/.git"\nprintf "cloned\\n" > "$HOME/git-stub-ran"\n')
    expect(result.status).toBe(0)
    expect(readFileSync(join(home, 'git-stub-ran'), 'utf8')).toBe('cloned\n')
    expect(existsSync(join(clone, 'stale.txt'))).toBe(false)
    expect(existsSync(join(clone, '.git'))).toBe(true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
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
    expect(commands, platform).toContain('exec "$BIN" start --log')
    // A bare `antigravity-claude-proxy` only prints help and exits; the
    // service wrapper must never be built from it.
    expect(commands, platform).not.toMatch(/exec antigravity-claude-proxy(?! start --log)/)
  }
  const teardown = manifest.removal.steps.map(step => step.command).join('\n')
  expect(teardown).toContain('antigravity-claude-proxy stop')
})

it('the antigravity install targets the fixed ~/.local prefix and both units fall back to the PATH binary', () => {
  const manifest = manifestById('antigravity')!
  const npmStep = manifest.local.install.default.steps[0]!
  // Unconditional: a version-manager prefix is not on either service's path,
  // so the binary must land where the units look for it.
  expect(npmStep.command).toContain('mkdir -p "{home}/.local/bin" && npm install -g --prefix "{home}/.local" antigravity-claude-proxy')
  expect(npmStep.command).not.toContain('npm config get prefix')
  // Never sudo, and never an exported NPM_CONFIG_PREFIX (it breaks nvm/fnm).
  expect(npmStep.command).not.toContain('sudo')
  expect(npmStep.command).not.toContain('NPM_CONFIG_PREFIX=')

  for (const platform of ['linux', 'default'] as const) {
    const steps = resolveHeavyInstall(manifest.local, platform).steps
    const commands = steps.map(step => step.command).join('\n')
    expect(commands, platform).toContain('ExecStart=/bin/bash -lc \'BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log\'')
    expect(commands, platform).toContain('Environment=PATH={home}/.local/bin:/usr/local/bin:/usr/bin:/bin')
    expect(steps.find(step => step.command.includes('loginctl enable-linger'))?.optional, platform).toBe(true)
  }
  const darwin = resolveHeavyInstall(manifest.local, 'darwin').steps.map(step => step.command).join('\n')
  expect(darwin).toContain('<string>BIN="{home}/.local/bin/antigravity-claude-proxy"; test -x "$BIN" || BIN="$(command -v antigravity-claude-proxy)"; exec "$BIN" start --log</string>')
  // nvm/fnm node directories are present as the shim's PATH fallback.
  expect(darwin).toContain('{home}/.nvm/versions/node/current/bin')
  expect(darwin).toContain('fnm/aliases/default/bin')
  // The removal sweeps every prefix a package can live in, fail-soft, and
  // reports anything it could not remove instead of failing the run.
  const uninstall = manifest.removal.steps.find(step => step.label === 'Uninstall the package from every npm prefix')
  expect(uninstall?.optional).toBe(true)
  expect(uninstall?.command).toContain('npm uninstall -g --prefix "$p" "$PKG"')
  expect(uninstall?.command).toContain('{home}/.local')
  expect(uninstall?.command).toContain('npm prefix -g')
  expect(uninstall?.command).toContain('.nvm/versions/node')
  expect(uninstall?.command).toContain('still holds $PKG')
})

it('the commandcode vendor health probe carries the adapter CLI identity and accepts the documented statuses', () => {
  const manifest = manifestById('commandcode')!
  expect(manifest.reuse.health.expectStatus).toContain(200)
  expect(manifest.reuse.health.expectStatus?.length).toBeGreaterThan(1)
  expect(manifest.reuse.health.headers).toEqual(COMMAND_CODE_CLI_HEADERS)
  expect(manifest.reuse.health.headers?.['x-command-code-version']).toBe(COMMAND_CODE_CLI_VERSION)
  // The local health probe mirrors the reuse one.
  expect(manifest.local.health).toEqual(manifest.reuse.health)
})

it('the commandcode Windows hint names the script from the package root', () => {
  const hint = manifestById('commandcode')!.local.install.win32!.unsupported ?? ''
  expect(hint).toContain('packages/enpoi-commandcode-provider/scripts/install.mjs')
  expect(hint).not.toContain('node scripts/install.mjs <profile>')
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

it('every rendered install and removal step parses as bash', () => {
  for (const manifest of HEAVY_MANIFESTS) {
    for (const platform of ['linux', 'darwin', 'win32', 'freebsd'] as const) {
      for (const step of resolveHeavyInstall(manifest.local, platform).steps) {
        const command = substitute(step.command, '/tmp/step-home', '/tmp/step-dsh')
        expect(
          () => execFileSync('/bin/bash', ['-n', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] }),
          `${manifest.id}/${platform}: ${step.label}`,
        ).not.toThrow()
      }
    }
    for (const step of manifest.removal.steps) {
      const command = substitute(step.command, '/tmp/step-home', '/tmp/step-dsh')
      expect(
        () => execFileSync('/bin/bash', ['-n', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] }),
        `${manifest.id}/removal: ${step.label}`,
      ).not.toThrow()
    }
  }
})

/** Run one rendered shell step in a scratch home with a recording npm stub on PATH. */
function runRenderedStep(home: string, command: string): { status: number; stdout: string; npmCalls: string } {
  const bin = join(home, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  const npmStub = join(bin, 'npm')
  writeFileSync(npmStub, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$HOME/npm-calls"\nexit 0\n', 'utf8')
  chmodSync(npmStub, 0o755)
  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync('/bin/bash', ['-c', command], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    status = failure.status ?? 1
    stdout = failure.stdout ?? ''
  }
  const calls = join(home, 'npm-calls')
  return { status, stdout, npmCalls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }
}

it('the antigravity teardown removes the package from ~/.local and nvm prefixes, keeps foreign shims, and reports the rest', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-agp-sweep-'))
  try {
    const home = join(scratch, 'home')
    const sweep = manifestById('antigravity')!.removal.steps
      .find(step => step.label === 'Uninstall the package from every npm prefix')!

    // ~/.local: the install's fixed prefix, package dir plus both npm shims.
    const localPkg = join(home, '.local', 'lib', 'node_modules', 'antigravity-claude-proxy')
    mkdirSync(join(localPkg, 'bin'), { recursive: true })
    writeFileSync(join(localPkg, 'bin', 'cli.js'), '//', 'utf8')
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync(join(localPkg, 'bin', 'cli.js'), join(home, '.local', 'bin', 'antigravity-claude-proxy'))
    symlinkSync(join(localPkg, 'bin', 'cli.js'), join(home, '.local', 'bin', 'acc'))

    // nvm version prefix: the same package, an interrupted-install staging
    // dir, and an `acc` shim another package owns, which must survive.
    const nvm = join(home, '.local', 'share', 'nvm', 'versions', 'node', 'v22.22.2')
    const nvmPkg = join(nvm, 'lib', 'node_modules', 'antigravity-claude-proxy')
    mkdirSync(join(nvmPkg, 'bin'), { recursive: true })
    writeFileSync(join(nvmPkg, 'bin', 'cli.js'), '//', 'utf8')
    mkdirSync(join(nvm, 'bin'), { recursive: true })
    mkdirSync(join(nvm, 'lib', 'node_modules', '.antigravity-claude-proxy-stage42'), { recursive: true })
    symlinkSync(join(nvmPkg, 'bin', 'cli.js'), join(nvm, 'bin', 'antigravity-claude-proxy'))
    const foreignTarget = join(nvm, 'bin', 'unrelated-tool')
    writeFileSync(foreignTarget, '//', 'utf8')
    symlinkSync(foreignTarget, join(nvm, 'bin', 'acc'))

    const result = runRenderedStep(home, substitute(sweep.command, home, join(home, '.dsh')))
    expect(result.status).toBe(0)
    expect(existsSync(localPkg)).toBe(false)
    expect(existsSync(join(home, '.local', 'bin', 'antigravity-claude-proxy'))).toBe(false)
    expect(existsSync(join(home, '.local', 'bin', 'acc'))).toBe(false)
    expect(existsSync(nvmPkg)).toBe(false)
    expect(existsSync(join(nvm, 'lib', 'node_modules', '.antigravity-claude-proxy-stage42'))).toBe(false)
    expect(existsSync(join(nvm, 'bin', 'antigravity-claude-proxy'))).toBe(false)
    // Both prefixes were also uninstalled through npm, fail-soft.
    expect(result.npmCalls).toContain('uninstall -g --prefix')
    expect(result.npmCalls).toContain('antigravity-claude-proxy')
    // The unrelated `acc` shim and its target belong to another package.
    expect(existsSync(join(nvm, 'bin', 'acc'))).toBe(true)
    expect(existsSync(foreignTarget)).toBe(true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('the macOS log step is platform-guarded and would remove only the proxy\'s own logs', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-agp-logs-'))
  try {
    const home = join(scratch, 'home')
    const step = manifestById('antigravity')!.removal.steps
      .find(candidate => candidate.label === 'Remove the macOS agent logs')!
    const logs = join(home, 'Library', 'Logs')
    mkdirSync(logs, { recursive: true })
    const proxyLog = join(logs, 'antigravity-proxy.log')
    const proxyErr = join(logs, 'antigravity-proxy.err.log')
    const foreignLog = join(logs, 'other-tool.log')
    for (const file of [proxyLog, proxyErr, foreignLog]) writeFileSync(file, 'x', 'utf8')

    const result = runRenderedStep(home, substitute(step.command, home, join(home, '.dsh')))
    expect(result.status).toBe(0)
    if (process.platform === 'darwin') {
      expect(existsSync(proxyLog)).toBe(false)
      expect(existsSync(proxyErr)).toBe(false)
    } else {
      // The guard exits before touching anything on a foreign platform.
      expect(existsSync(proxyLog)).toBe(true)
    }
    expect(existsSync(foreignLog)).toBe(true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('the antigravity teardown removes the proxy state directory and only the package\'s npx residue', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-agp-state-'))
  try {
    const home = join(scratch, 'home')
    const steps = manifestById('antigravity')!.removal.steps
    const stateDir = join(home, '.config', 'antigravity-proxy')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'accounts.json'), '{"accounts":[]}', 'utf8')
    writeFileSync(join(stateDir, 'usage-history.json'), '{}', 'utf8')
    const npxPkg = join(home, '.npm', '_npx', 'deadbeef', 'node_modules', 'antigravity-claude-proxy')
    mkdirSync(npxPkg, { recursive: true })
    const npxForeign = join(home, '.npm', '_npx', 'deadbeef', 'node_modules', 'other-tool')
    mkdirSync(npxForeign, { recursive: true })

    for (const label of [
      'Remove the config directory (accounts.json OAuth tokens, usage history, presets)',
      'Remove npm npx cache residue',
    ]) {
      const step = steps.find(candidate => candidate.label === label)!
      const result = runRenderedStep(home, substitute(step.command, home, join(home, '.dsh')))
      expect(result.status, label).toBe(0)
    }
    expect(existsSync(stateDir)).toBe(false)
    expect(existsSync(npxPkg)).toBe(false)
    // A foreign npx package tree is never touched.
    expect(existsSync(npxForeign)).toBe(true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
