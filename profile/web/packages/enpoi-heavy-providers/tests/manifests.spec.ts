/**
 * Manifest-table invariants: every heavy provider is fully declared, only a
 * route served by its own adapter declares a key pool (an llm-pi-ai route
 * must not — its fronting service owns the keys), and commandcode is a
 * direct-vendor route whose fresh-machine dependency is the provider package.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { COMMAND_CODE_CLI_HEADERS, COMMAND_CODE_CLI_VERSION } from '../../enpoi-commandcode-provider/src/headers.js'
import { HEAVY_MANIFESTS, manifestById, manifestProblems, platformUnsupported, resolveHeavyInstall } from '../src/manifests.js'
import { substitute } from '../src/planner.js'

it('declares the four heavy providers with no structural problems', () => {
  expect(manifestProblems()).toEqual([])
  expect(HEAVY_MANIFESTS.map(manifest => manifest.id)).toEqual(['freellmapi', 'antigravity', 'commandcode', 'meridian'])
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

it('antigravity is a loopback keyless anthropic route (llm-pi-ai serves keyless anthropic)', () => {
  const manifest = manifestById('antigravity')
  expect(manifest?.protocol).toBe('anthropic-messages')
  expect(manifest?.auth).toEqual({ kind: 'none', keyless: true })
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

it('meridian is a loopback keyless Anthropic Messages service route on port 3456', () => {
  const manifest = manifestById('meridian')!
  expect(manifest.label).toBe('Claude Code (Meridian)')
  expect(manifest.protocol).toBe('anthropic-messages')
  expect(manifest.delivery).toBe('service')
  // llm-pi-ai serves this route: no custom namespace, and an llm-pi-ai route
  // must never declare a credential pool.
  expect(manifest.settingsNs).toBeUndefined()
  expect(manifest.pool).toBeUndefined()
  expect(JSON.stringify(manifest)).not.toContain('"pool"')
  // The proxy is loopback-gated as shipped and its own credential is the CLI
  // login, so the route is written keyless.
  expect(manifest.auth).toEqual({ kind: 'none', keyless: true })
  expect(manifest.defaultPort).toBe(3456)
  expect(manifest.reuse.baseURL).toBe('http://127.0.0.1:3456')
  expect(manifest.reuse.health.url).toBe('http://127.0.0.1:3456/health')
  expect(manifest.local.baseURL).toBe('http://127.0.0.1:3456')
  expect(manifest.local.health).toEqual(manifest.reuse.health)
  expect(manifest.local.dashboardUrl).toBe('http://127.0.0.1:3456')
  expect(manifest.local.runtime).toBe('node')
  // /v1/models is the release catalog, so discovery supplies every model and
  // no id is fabricated here.
  expect(manifest.fallbackModel).toBeUndefined()
})

it('meridian badges the subscription login as a browser flow and carries the documented quirks', () => {
  const manifest = manifestById('meridian')!
  expect(manifest.requiresBrowser.join('\n')).toContain('claude auth login --claudeai')
  const quirks = manifest.quirks.join('\n')
  expect(quirks).toContain('Local install dependencies:')
  expect(quirks).toContain('Docker is never required')
  expect(quirks).toContain('Node.js >= 22')
  expect(quirks).toContain('ANTHROPIC_API_KEY must be unset')
  expect(quirks).toContain('node <resolved>/dist/cli.js')
  expect(quirks).toContain('npm global bin')
  expect(quirks).toContain('/v1/models')
  expect(quirks).toContain('MERIDIAN_ENFORCE_MAX_TOKENS=1')
  expect(quirks).toContain('x-session-affinity')
  expect(quirks).toContain('subscription usage windows')
})

it('the meridian install checks node and the subscription, installs both packages, then starts the unit', () => {
  const manifest = manifestById('meridian')!
  const linux = resolveHeavyInstall(manifest.local, 'linux')
  expect(linux.label).toBe('Install locally (npm + systemd user unit)')
  expect(linux.steps.map(step => step.label)).toEqual([
    'Check Node.js and npm',
    'Install the Claude Code CLI when it is missing or older than 2.1.293',
    'Require a Claude subscription login',
    'Install Meridian',
    'Write the systemd user unit',
    'Enable and start the unit',
    'Wait for Meridian',
  ])
  const [node, cli, login, install, unit, enable, health] = linux.steps.map(step => step.command)
  expect(node).toContain('command -v node')
  expect(node).toContain('command -v npm')
  expect(node).toContain('-ge 22')
  // The CLI install is skipped only when a sufficient version is present.
  expect(cli).toContain('claude --version')
  expect(cli).toContain('npm install -g @anthropic-ai/claude-code')
  expect(cli).toContain('c>=293')
  expect(cli).toContain('GLOBAL_BIN="$(npm prefix -g)/bin"')
  // Subscription login, not API-key auth; both env refs are unset for the probe.
  expect(login).toContain('env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude auth status')
  expect(login).toContain('"claude.ai"')
  expect(login).toContain('claude auth login --claudeai')
  expect(install).toBe('npm install -g @rynfar/meridian@latest')
  // The unit names the resolved cli.js (not the bin) and the documented env.
  expect(unit).toContain('realpathSync')
  expect(unit).toContain('ExecStart=$NODE_BIN $ENTRY')
  expect(unit).not.toContain('ExecStart=/usr')
  expect(unit).toContain('Environment=HOME=%h')
  expect(unit).toContain('Environment=MERIDIAN_HOST=127.0.0.1')
  expect(unit).toContain('Environment=MERIDIAN_PORT=3456')
  expect(unit).toContain('Environment=MERIDIAN_PASSTHROUGH=1')
  expect(unit).toContain('Environment=MERIDIAN_ENFORCE_MAX_TOKENS=1')
  expect(unit).toContain('Environment=PATH=$GLOBAL_BIN:')
  expect(enable).toContain('systemctl --user daemon-reload')
  expect(enable).toContain('systemctl --user enable --now meridian.service')
  expect(health).toContain('curl -fsS http://127.0.0.1:3456/health')
  expect(health).toContain('sleep 2')
  // The default variant is the systemd path: an unknown POSIX platform never
  // receives the launchd agent.
  expect(resolveHeavyInstall(manifest.local, 'freebsd').steps).toEqual(linux.steps)
})

it('the meridian macOS path writes the launchd agent and bootstraps it', () => {
  const manifest = manifestById('meridian')!
  const darwin = resolveHeavyInstall(manifest.local, 'darwin')
  expect(darwin.label).toBe('Install locally (npm + launchd agent)')
  const commands = darwin.steps.map(step => step.command).join('\n')
  expect(commands).toContain('{home}/Library/LaunchAgents/dev.meridian.proxy.plist')
  expect(commands).toContain('<key>MERIDIAN_PORT</key>')
  expect(commands).toContain('<string>3456</string>')
  expect(commands).toContain('launchctl bootstrap')
  expect(commands).toContain('launchctl kickstart')
  expect(commands).toContain('curl -fsS http://127.0.0.1:3456/health')
  // The macOS path never writes or enables a systemd unit; the health hint
  // names both service managers in one platform-neutral line.
  expect(commands).not.toContain('{config}/systemd/user')
  expect(commands).not.toContain('systemctl --user enable')
  // Windows is refused before any step runs, with the manual path named.
  const reason = platformUnsupported(manifest, 'win32') ?? ''
  expect(reason).toContain('Windows')
  expect(reason).toContain('claude auth login --claudeai')
  expect(reason).toContain('npm install -g @rynfar/meridian')
  expect(resolveHeavyInstall(manifest.local, 'win32').steps).toEqual([])
  expect(platformUnsupported(manifest, 'linux')).toBeUndefined()
  expect(platformUnsupported(manifest, 'darwin')).toBeUndefined()
})

it('every meridian step is one shell command that names placeholders instead of a literal home', () => {
  const manifest = manifestById('meridian')!
  const install = (['default', 'linux', 'darwin', 'win32'] as const)
    .flatMap(platform => resolveHeavyInstall(manifest.local, platform).steps.map(step => step.command))
  const commands = [...install, ...manifest.removal.steps.map(step => step.command)]
  expect(commands.length).toBeGreaterThan(0)
  for (const command of commands) {
    expect(command.trim()).toBe(command)
    expect(command).not.toMatch(/\/home\/[A-Za-z0-9._-]+/)
    expect(command).not.toContain('~/')
    expect(command).not.toContain('{home}/.dsh')
  }
  // Only the unit and the plist span lines, and each is one heredoc: the rest
  // are single-line shell commands. (The unit is shared by `default` and
  // `linux`, so it appears twice in the resolved lists.)
  const multiline = [...new Set(commands.filter(command => command.includes('\n')))]
  expect(multiline).toHaveLength(2)
  for (const command of multiline) {
    expect(command).toContain('<<EOF')
    expect(command.endsWith('\nEOF')).toBe(true)
  }
})

it('the meridian teardown removes the user service but never uninstalls the npm packages', () => {
  const manifest = manifestById('meridian')!
  const commands = manifest.removal.steps.map(step => step.command).join('\n')
  expect(commands).toContain('systemctl --user disable --now meridian.service')
  expect(commands).toContain('launchctl bootout gui/$(id -u)/dev.meridian.proxy')
  expect(commands).toContain('rm -f {config}/systemd/user/meridian.service {home}/Library/LaunchAgents/dev.meridian.proxy.plist')
  // No step removes the packages: the CLI is a shared tool and Meridian may be
  // the operator's only copy, so the last step states that instead.
  expect(manifest.removal.steps.some(step => /^\s*npm\s+(?:uninstall|rm)\b/.test(step.command))).toBe(false)
  const leave = manifest.removal.steps.at(-1)!
  expect(leave.label).toContain('not uninstalled')
  expect(leave.label).toContain('@rynfar/meridian')
  expect(leave.label).toContain('@anthropic-ai/claude-code')
  const warnings = manifest.removal.warnings.join('\n')
  expect(warnings).toContain('~/.claude')
  expect(warnings).toContain('usage windows')
})

/** Run one rendered Meridian step in a scratch home with a stubbed npm global prefix. */
function runMeridianStep(
  home: string,
  platform: 'linux' | 'darwin',
  stepIndex: number,
): { status: number; stdout: string } {
  const bin = join(home, 'stub-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'npm'),
    '#!/usr/bin/env bash\ncase "$*" in\n  "prefix -g") printf "%s\\n" "$HOME/stub-prefix" ;;\n  "root -g") printf "%s\\n" "$HOME/stub-prefix/lib/node_modules" ;;\n  *) exit 0 ;;\nesac\n',
    'utf8',
  )
  chmodSync(join(bin, 'npm'), 0o755)
  const entry = join(home, 'stub-prefix', 'lib', 'node_modules', '@rynfar', 'meridian', 'dist', 'cli.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, '//', 'utf8')
  const step = resolveHeavyInstall(manifestById('meridian')!.local, platform).steps[stepIndex]!
  try {
    const stdout = execFileSync('/bin/bash', ['-c', substitute(step.command, home, join(home, '.dsh'))], {
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '' }
  }
}

it('the meridian service file resolves the real cli.js and renders the documented environment', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heavy-meridian-unit-'))
  try {
    const home = join(scratch, 'home')
    const entry = join(home, 'stub-prefix', 'lib', 'node_modules', '@rynfar', 'meridian', 'dist', 'cli.js')

    const linux = runMeridianStep(home, 'linux', 4)
    expect(linux.status, linux.stdout).toBe(0)
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'meridian.service'), 'utf8')
    // `node <realpath>` — never a bin shim whose shebang would not resolve.
    const exec = unit.split('\n').find(line => line.startsWith('ExecStart='))!
    expect(exec).toMatch(/^ExecStart=\/\S*\/node /)
    expect(exec.endsWith(` ${entry}`)).toBe(true)
    expect(unit).toContain('Environment=HOME=%h')
    expect(unit).toContain('Environment=MERIDIAN_HOST=127.0.0.1')
    expect(unit).toContain('Environment=MERIDIAN_PORT=3456')
    expect(unit).toContain('Environment=MERIDIAN_PASSTHROUGH=1')
    expect(unit).toContain('Environment=MERIDIAN_ENFORCE_MAX_TOKENS=1')
    expect(unit).toContain(`Environment=PATH=${join(home, 'stub-prefix', 'bin')}:`)
    expect(unit).toContain('WantedBy=default.target')

    const darwin = runMeridianStep(home, 'darwin', 4)
    expect(darwin.status, darwin.stdout).toBe(0)
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'dev.meridian.proxy.plist'), 'utf8')
    expect(plist).toContain(`<string>${entry}</string>`)
    expect(plist).toContain('<key>MERIDIAN_PORT</key>\n    <string>3456</string>')
    expect(plist).toContain('<key>MERIDIAN_ENFORCE_MAX_TOKENS</key>\n    <string>1</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('the meridian display copy carries the same id, label, protocol, auth, and endpoint as the manifest', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../../../../../packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json', import.meta.url),
    'utf8',
  )) as ReadonlyArray<{ id: string; label: string; protocol: string; auth: { keyless: boolean }; reuse: { baseURL: string; health: { url: string } } }>
  const manifest = manifestById('meridian')!
  const row = fixture.find(entry => entry.id === manifest.id)
  expect(row).toBeDefined()
  expect(row?.label).toBe(manifest.label)
  expect(row?.protocol).toBe(manifest.protocol)
  expect(row?.auth.keyless).toBe(true)
  expect(row?.reuse.baseURL).toBe(manifest.reuse.baseURL)
  expect(row?.reuse.health.url).toBe(manifest.reuse.health.url)
})
