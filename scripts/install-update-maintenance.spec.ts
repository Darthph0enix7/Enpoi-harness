/**
 * scripts/install.sh update-request flags and maintenance guards.
 *
 * Library-level tests source the installer (`DSH_INSTALL_LIB_ONLY=1`) and call
 * the helpers directly: `--forget` / `--accept-shipped` semantics (path
 * validation, idempotency, pin removal, pristine-archive restore and its honest
 * fallback), the pnpm skip for source-less updates, the `dsh clean` staging
 * guard (a live owner keeps staging resumable), and update-report retention by
 * RUN rather than by file. A real `install.sh --clean` run proves the guard
 * through the dispatched mode. All paths live under unique mkdtemp roots.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const win32 = process.platform === 'win32'
const cleanups: string[] = []
let counter = 0

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-maintenance-'))
  cleanups.push(dir)
  return dir
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/** Write a sidecar in sha256sum format. */
function sidecar(file: string): string {
  const digest = sha256(readFileSync(file))
  writeFileSync(`${file}.sha256`, `${digest}  ${file.split('/').pop() ?? file}\n`)
  return digest
}

function write(dir: string, rel: string, content: string, mode = 0o644): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

interface LibResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Run a bash body with the installer sourced as a library. */
function runLib(body: string, env: Record<string, string> = {}): LibResult {
  counter += 1
  const dir = scratch()
  const file = join(dir, `lib-${counter}.sh`)
  writeFileSync(file, ['set -u', 'export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" >/dev/null 2>&1', body, ''].join('\n'))
  const result = spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, INSTALL_SH: installSh, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sleepers: ReturnType<typeof spawn>[] = []
afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL')
})

describe.skipIf(win32)('installed identity (symlink = truth)', () => {
  const POISON_MARKER = '{"version": "0.1.7-enpoi.2.60", "commit": "aa58eaf20bace6b3c082d40472bf07c175e9b460", "installedAt": "2026-10-11T14:54:50Z"}\n'
  const LIVE_COMMIT = 'c377833722838a2f02ccab73fde6961903c5fa4c'

  /** The PC's split: current -> 2.59, marker inside it claims 2.60, state 2.59. */
  function splitPrefix(): { prefix: string; home: string } {
    const root = scratch()
    const prefix = join(root, 'prefix')
    const home = join(root, 'home')
    const tree = join(prefix, 'harness/0.1.7-enpoi.2.59')
    mkdirSync(tree, { recursive: true })
    write(tree, 'package.json', '{"version":"0.1.7-enpoi.2"}\n')
    write(tree, '.dsh-install-complete', POISON_MARKER)
    symlinkSync('0.1.7-enpoi.2.59', join(prefix, 'harness/current'))
    write(join(prefix), 'harness/install-state.json', `${JSON.stringify({
      version: '0.1.7-enpoi.2.59',
      harnessDir: '0.1.7-enpoi.2.59',
      commit: LIVE_COMMIT,
      updatedAt: '2026-10-11T12:07:44Z',
    }, null, 2)}\n`)
    mkdirSync(home, { recursive: true })
    return { prefix, home }
  }

  it('resolves the version from the symlink and reports the stale-marker split', () => {
    const fixture = splitPrefix()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
installed_identity_resolve
printf 'DIR=[%s]\nVERSION=[%s]\nCOMMIT=[%s]\nMISMATCH=[%s]\n' \
  "$INSTALLED_LINK_DIR" "$INSTALLED_VERSION" "$INSTALLED_COMMIT" "$INSTALLED_MISMATCH"
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home, NODE_BIN: process.execPath })
    expect(result.stdout).toContain('DIR=[0.1.7-enpoi.2.59]')
    expect(result.stdout).toContain('VERSION=[0.1.7-enpoi.2.59]')
    expect(result.stdout).toContain(`COMMIT=[${LIVE_COMMIT}]`)
    expect(result.stdout).toMatch(/MISMATCH=\[current -> 0\.1\.7-enpoi\.2\.59 but its \.dsh-install-complete says '0\.1\.7-enpoi\.2\.60'; /)
  })

  it('heals the marker and the state to the symlink identity, then reports consistency', () => {
    const fixture = splitPrefix()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
installed_identity_resolve
installed_identity_heal
printf 'HEALED=%s\n' "$INSTALLED_HEALED"
installed_identity_resolve
printf 'AFTER=[%s]\n' "$INSTALLED_MISMATCH"
cat "$PREFIX/harness/0.1.7-enpoi.2.59/.dsh-install-complete"
cat "$PREFIX/harness/install-state.json"
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home, NODE_BIN: process.execPath })
    expect(result.stderr).toContain('identity mismatch')
    expect(result.stderr).toContain('self-healing from the current symlink')
    expect(result.stdout).toContain('HEALED=1')
    expect(result.stdout).toContain('AFTER=[]')
    expect(result.stdout).toContain(`"version": "0.1.7-enpoi.2.59", "commit": "${LIVE_COMMIT}"`)
    expect(result.stdout).toContain('"healedFrom": "0.1.7-enpoi.2.60"')
    expect(result.stdout).toContain('"harnessDir": "0.1.7-enpoi.2.59"')
    expect(result.stdout).not.toContain('aa58eaf20bace6b3c082d40472bf07c175e9b460')
  })

  it('reports no mismatch for a consistent prebuilt tree and a source-rebuild dir', () => {
    const root = scratch()
    const prefix = join(root, 'prefix')
    const home = join(root, 'home')
    for (const [dir, marker, state] of [
      ['0.1.7-enpoi.2.59', '0.1.7-enpoi.2.59', '0.1.7-enpoi.2.59'],
      ['0.1.7-enpoi.2-c377833', '0.1.7-enpoi.2', '0.1.7-enpoi.2'],
    ] as const) {
      rmSync(join(prefix, 'harness'), { recursive: true, force: true })
      const tree = join(prefix, 'harness', dir)
      mkdirSync(tree, { recursive: true })
      write(tree, 'package.json', '{"version":"0.1.7-enpoi.2"}\n')
      write(tree, '.dsh-install-complete', `{"version": "${marker}", "commit": "${LIVE_COMMIT}", "installedAt": "2026-01-01T00:00:00Z"}\n`)
      symlinkSync(dir, join(prefix, 'harness/current'))
      write(join(prefix), 'harness/install-state.json', `${JSON.stringify({ version: state, harnessDir: dir, commit: LIVE_COMMIT }, null, 2)}\n`)
    }
    mkdirSync(home, { recursive: true })
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
installed_identity_resolve
printf 'DIR=[%s] MISMATCH=[%s]\n' "$INSTALLED_LINK_DIR" "$INSTALLED_MISMATCH"
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath })
    expect(result.stdout).toContain('DIR=[0.1.7-enpoi.2-c377833] MISMATCH=[]')
  })

  it('repair --check reports the split read-only and self-heal reconciles it', () => {
    const fixture = splitPrefix()
    const bin = join(fixture.prefix, 'bin')
    const check = spawnSync('bash', [installSh, '--repair', '--check', '--prefix', fixture.prefix, '--bin-dir', bin], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: fixture.home },
    })
    const checkOutput = `${check.stdout}${check.stderr}`
    expect(checkOutput).toContain('identity split: current -> 0.1.7-enpoi.2.59')
    expect(checkOutput).toContain('re-run without --check to self-heal')
    // Read-only: the poisoned marker is untouched after --check.
    expect((JSON.parse(readFileSync(join(fixture.prefix, 'harness/0.1.7-enpoi.2.59/.dsh-install-complete'), 'utf8')) as { version: string }).version).toBe('0.1.7-enpoi.2.60')

    const heal = spawnSync('bash', [installSh, '--repair', '--prefix', fixture.prefix, '--bin-dir', bin], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: fixture.home },
    })
    const healOutput = `${heal.stdout}${heal.stderr}`
    expect(healOutput).toContain('identity reconciled to 0.1.7-enpoi.2.59')
    const healed = JSON.parse(readFileSync(join(fixture.prefix, 'harness/0.1.7-enpoi.2.59/.dsh-install-complete'), 'utf8')) as { version: string; healedFrom?: string }
    expect(healed.version).toBe('0.1.7-enpoi.2.59')
    expect(healed.healedFrom).toBe('0.1.7-enpoi.2.60')
  })

  it('refuses to stamp the active tree with a foreign version before the switch', () => {
    const fixture = splitPrefix()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
SWITCH_DONE=0
stamp_install_complete "$PREFIX/harness/0.1.7-enpoi.2.59" "0.1.7-enpoi.2.60" "aa58"; printf 'REFUSED=%s\n' "$?"
printf 'UNCHANGED=%s\n' "$(cat "$PREFIX/harness/0.1.7-enpoi.2.59/.dsh-install-complete")"
stamp_install_complete "$PREFIX/harness/0.1.7-enpoi.2.59" "0.1.7-enpoi.2.59" "c377"; printf 'SAME=%s\n' "$?"
printf 'STAMPED=%s\n' "$(cat "$PREFIX/harness/0.1.7-enpoi.2.59/.dsh-install-complete")"
mkdir -p "$PREFIX/harness/0.1.7-enpoi.2.60"
SWITCH_DONE=1
stamp_install_complete "$PREFIX/harness/0.1.7-enpoi.2.60" "0.1.7-enpoi.2.60" "aa58"; printf 'POST=%s\n' "$?"
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home, NODE_BIN: process.execPath })
    expect(result.stderr).toContain('refusing to stamp the active tree')
    expect(result.stdout).toContain('REFUSED=1')
    expect(result.stdout).toContain('SAME=0')
    expect(result.stdout).toContain('POST=0')
    expect(result.stdout).toContain('UNCHANGED={"version": "0.1.7-enpoi.2.60", "commit": "aa58eaf20bace6b3c082d40472bf07c175e9b460"')
    expect(result.stdout).toContain('STAMPED={"version": "0.1.7-enpoi.2.59", "commit": "c377')
  })
})

describe.skipIf(win32)('pnpm store and pin', () => {
  it('resolves the pin from the profile first, then the harness', () => {
    const root = scratch()
    const home = join(root, 'home')
    const prefix = join(root, 'prefix')
    mkdirSync(join(prefix, 'harness'), { recursive: true })
    const profile = join(home, 'profiles/web')
    mkdirSync(profile, { recursive: true })
    write(profile, 'package.json', '{"packageManager": "pnpm@11.7.0"}\n')
    const harnessTree = join(prefix, 'harness/2')
    mkdirSync(harnessTree, { recursive: true })
    write(harnessTree, 'package.json', '{"packageManager": "pnpm@9.9.9"}\n')
    const env = { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath }
    const fromProfile = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; HARNESS="$PREFIX/harness/2"
resolve_home
printf 'PIN=[%s] rc=%s\n' "$(resolve_pnpm_pin)" "$?"
`, env)
    expect(fromProfile.stdout).toContain('PIN=[11.7.0]')
    rmSync(join(profile, 'package.json'))
    const fromHarness = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; HARNESS="$PREFIX/harness/2"
resolve_home
printf 'PIN=[%s] rc=%s\n' "$(resolve_pnpm_pin)" "$?"
`, env)
    expect(fromHarness.stdout).toContain('PIN=[9.9.9]')
    const none = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; HARNESS=""
if resolve_pnpm_pin >/dev/null; then printf 'PIN=found\n'; else printf 'PIN=none\n'; fi
`, env)
    expect(none.stdout).toContain('PIN=none')
  })

  it('activates the pin through corepack prepare --activate', () => {
    const root = scratch()
    const home = join(root, 'home')
    const prefix = join(root, 'prefix')
    const capture = join(root, 'core.log')
    mkdirSync(prefix, { recursive: true })
    const profile = join(home, 'profiles/web')
    mkdirSync(profile, { recursive: true })
    write(profile, 'package.json', '{"packageManager": "pnpm@11.7.0"}\n')
    write(root, 'corepack-stub', '#!/bin/sh\nprintf "CORE=%s\\n" "$*" >> "$CAPTURE"\nexit 0\n', 0o755)
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; HARNESS=""
resolve_home
COREPACK_BIN="$CORE_STUB"; CAPTURE="$CAPTURE"; export CAPTURE
PNPM=/nowhere/pnpm
activate_pnpm_pin
printf 'rc=%s PIN=[%s]\n' "$?" "$PNPM_PIN"
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath, CORE_STUB: join(root, 'corepack-stub'), CAPTURE: capture })
    expect(result.stdout).toContain('rc=0 PIN=[11.7.0]')
    expect(readFileSync(capture, 'utf8')).toContain('CORE=prepare pnpm@11.7.0 --activate')
    expect(result.stdout + result.stderr).toContain('pnpm pinned to 11.7.0')
  })

  it('profile install keeps the store inside the prefix and exports it for nested scripts', () => {
    const root = scratch()
    const home = join(root, 'home')
    const prefix = join(root, 'prefix')
    const capture = join(root, 'pnpm.log')
    const profile = join(home, 'profiles/web')
    mkdirSync(profile, { recursive: true })
    write(profile, 'package.json', '{"name":"web"}\n')
    write(profile, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
    write(root, 'pnpm-stub', '#!/bin/sh\n{ printf "ARGS=%s\\n" "$*"; printf "STORE_ENV=%s\\n" "${npm_config_store_dir:-}"; } >> "$CAPTURE"\nexit 0\n', 0o755)
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
PROFILE_SOURCE="$PREFIX/harness/2/profile/web"
PNPM="$PNPM_STUB"; CAPTURE="$CAPTURE"; export CAPTURE
PNPM_STORE_DIR="$PREFIX/.pnpm-store"; npm_config_store_dir="$PNPM_STORE_DIR"; export npm_config_store_dir
profile_install; printf 'rc=%s\n' "$?"
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath, PNPM_STUB: join(root, 'pnpm-stub'), CAPTURE: capture })
    expect(result.stdout).toContain('rc=0')
    const logged = readFileSync(capture, 'utf8')
    expect(logged).toContain(`--store-dir ${prefix}/.pnpm-store`)
    expect(logged).toContain(`STORE_ENV=${prefix}/.pnpm-store`)
  })

  it('setup_pnpm keeps the store in the prefix without activating when pinned off', () => {
    const root = scratch()
    const home = join(root, 'home')
    const prefix = join(root, 'prefix')
    write(prefix, 'bin/pnpm', '#!/bin/sh\nexit 0\n', 0o755)
    mkdirSync(home, { recursive: true })
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; PROFILE=web; NODE="$NODE_BIN"
DSH_PNPM_PIN=0
setup_pnpm; printf 'rc=%s PNPM=[%s] STORE=[%s] ENV=[%s]\n' "$?" "$PNPM" "$PNPM_STORE_DIR" "$npm_config_store_dir"
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath })
    expect(result.stdout).toContain(`rc=0 PNPM=[${prefix}/bin/pnpm] STORE=[${prefix}/.pnpm-store] ENV=[${prefix}/.pnpm-store]`)
  })
})

describe.skipIf(win32)('merge base work lifecycle', () => {
  it('keeps materialized bases with their version, reaps orphans and stale transients', async () => {
    const root = scratch()
    const prefix = join(root, 'prefix')
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    write(join(prefix, 'harness/2'), '.dsh-install-complete', '{"version": "2"}\n')
    write(join(prefix, 'harness/.bases/work/2'), 'merge/file.txt', 'base bytes\n')
    write(join(prefix, 'harness/.bases/work/ghost'), 'merge/stale.txt', 'stale\n')
    const dead = spawn('sleep', ['30'])
    const deadPid = dead.pid
    dead.kill('SIGKILL')
    await new Promise<void>((resolve) => { dead.on('exit', () => { resolve() }) })
    write(join(prefix, `harness/.bases/work/3.full-${deadPid}`), 'bulk/file.txt', 'partial\n')

    const reap = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
prune_orphaned_bases
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath })
    expect(reap.status).toBe(0)
    expect(existsSync(join(prefix, 'harness/.bases/work/2/merge/file.txt'))).toBe(true)
    expect(existsSync(join(prefix, 'harness/.bases/work/ghost'))).toBe(false)
    expect(existsSync(join(prefix, `harness/.bases/work/3.full-${deadPid}`))).toBe(false)

    const logFile = join(prefix, 'harness/lifecycle.log')
    const prune = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web
LOG_FILE="$LOG_PATH"
prune_version_bases 2
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath, LOG_PATH: logFile })
    expect(prune.status).toBe(0)
    expect(existsSync(join(prefix, 'harness/.bases/work/2'))).toBe(false)
    expect(readFileSync(logFile, 'utf8')).toContain('pruned merge base for 2')
  })
})

describe.skipIf(win32)('step numbering helpers', () => {
  it('prints N numbered steps with matching totals, and banners consume no step', () => {
    const result = runLib(String.raw`
STEP_TOTAL=3; STEP_NO=0
step "one"
banner "fallback banner"
step "two"
step "three"
`)
    expect(result.status).toBe(0)
    const numbered = result.stderr.split('\n').filter(line => line.startsWith('['))
    expect(numbered).toEqual(['[1/3] one', '[2/3] two', '[3/3] three'])
    expect(result.stderr).toContain('fallback banner')
    expect(result.stderr).not.toMatch(/\[4\/3\]/u)
  })
})

describe.skipIf(win32)('update path validation', () => {
  it('accepts plain relative paths and refuses traversal, control characters, and empty segments', () => {
    const result = runLib(String.raw`
ok=0
for p in 'ok.txt' 'deep/nested/file.js' 'a-b_c.d' "@scope/pkg/index.js"; do
  update_path_unsafe "$p" && { printf 'ACCEPT-MISS:[%s]\n' "$p"; ok=1; }
done
for p in '' '/abs' '../evil' 'a/../b' './a' 'a//b' 'dir/' 'back\slash' $'a\tb' $'a\nb'; do
  update_path_unsafe "$p" || { printf 'REJECT-MISS:[%s]\n' "$p"; ok=1; }
done
printf 'VALIDATION=%s\n' "$ok"
`)
    expect(result.stdout).toContain('VALIDATION=0')
    expect(result.stdout).not.toContain('ACCEPT-MISS')
    expect(result.stdout).not.toContain('REJECT-MISS')
  })
})

describe.skipIf(win32)('--forget recording', () => {
  it('appends idempotently, recognizes quoted entries, and refuses unsafe paths', () => {
    const home = join(scratch(), 'home')
    const tombstones = join(home, 'update/tombstones.txt')
    mkdirSync(join(home, 'update'), { recursive: true })
    writeFileSync(tombstones, "existing.txt\n'quoted/path.txt'\n")
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"
update_forget_path 'docs/lost.txt'; printf 'OUTCOME1=%s\n' "$FORGET_OUTCOME"
update_forget_path 'docs/lost.txt'; printf 'OUTCOME2=%s\n' "$FORGET_OUTCOME"
update_forget_path 'quoted/path.txt'; printf 'OUTCOME3=%s\n' "$FORGET_OUTCOME"
update_forget_path '../evil'; printf 'OUTCOME4=%s\n' "$FORGET_OUTCOME"
update_forget_path 'ambiguous.txt'; printf 'OUTCOME5=%s\n' "$FORGET_OUTCOME"
`, { HOME_DIR: home })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OUTCOME1=recorded')
    expect(result.stdout).toContain('OUTCOME2=already')
    // A pre-existing quoted entry is recognized: appended once, then "already".
    expect(result.stdout).toContain('OUTCOME3=already')
    expect(result.stdout).toContain('OUTCOME4=refused: unsafe path')
    expect(result.stdout).toContain('OUTCOME5=recorded')
    expect(result.stderr).toContain('refusing unsafe path')
    const lines = readFileSync(tombstones, 'utf8').trim().split('\n')
    expect(lines).toEqual(['existing.txt', "'quoted/path.txt'", 'docs/lost.txt', 'ambiguous.txt'])
  })
})

describe.skipIf(win32)('--accept-shipped', () => {
  /** Build a scratch prefix with an installed tree, pin, and a base archive. */
  function acceptFixture(): { prefix: string; home: string; tree: string; pins: string } {
    const root = scratch()
    const prefix = join(root, 'prefix')
    const home = join(root, 'home')
    const tree = join(prefix, 'harness/1')
    mkdirSync(tree, { recursive: true })
    mkdirSync(join(home, 'update'), { recursive: true })
    const pins = join(home, 'update/pins.yaml')
    writeFileSync(pins, 'paths:\n  - docs/pinme.txt\n  - other.txt\n')
    return { prefix, home, tree, pins }
  }

  function makeBase(prefix: string, layout: 'flat' | 'topdir', name: '1.tar' | '1.tar.gz'): void {
    const staging = scratch()
    const source = layout === 'flat' ? staging : join(staging, 'dsh-harness-1')
    write(source, 'docs/pinme.txt', 'pin shipped\n')
    write(source, 'package.json', '{"version":"1"}\n')
    const out = join(prefix, 'harness/.bases', name)
    mkdirSync(dirname(out), { recursive: true })
    const args = name.endsWith('.gz')
      ? ['-czf', out, '-C', staging, layout === 'flat' ? '.' : 'dsh-harness-1']
      : ['-cf', out, '-C', staging, layout === 'flat' ? '.' : 'dsh-harness-1']
    const tar = spawnSync('tar', args, { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
    sidecar(out)
  }

  it('removes the pin and restores the shipped file from a synthesized (flat) archive', () => {
    const fixture = acceptFixture()
    write(fixture.tree, 'docs/pinme.txt', 'pin USER\n')
    makeBase(fixture.prefix, 'flat', '1.tar')
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
printf 'RESTORED=%s\nNOTE=[%s]\n' "$ACCEPT_RESULT_RESTORED" "$ACCEPT_RESULT_NOTE"
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('RESTORED=1')
    expect(result.stdout).toContain('NOTE=[]')
    expect(readFileSync(join(fixture.tree, 'docs/pinme.txt'), 'utf8')).toBe('pin shipped\n')
    expect(readFileSync(fixture.pins, 'utf8')).toBe('paths:\n  - other.txt\n')
  })

  it('restores from a release-style top-directory gzip archive and leaves the file when already shipped', () => {
    const fixture = acceptFixture()
    makeBase(fixture.prefix, 'topdir', '1.tar.gz')
    write(fixture.tree, 'docs/pinme.txt', 'pin shipped\n')
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
printf 'RESTORED=%s\nNOTE=[%s]\n' "$ACCEPT_RESULT_RESTORED" "$ACCEPT_RESULT_NOTE"
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home })
    expect(result.stdout).toContain('RESTORED=0')
    expect(result.stdout).toContain('NOTE=[already the shipped file]')
    expect(readFileSync(join(fixture.tree, 'docs/pinme.txt'), 'utf8')).toBe('pin shipped\n')
  })

  it('honestly reports a missing base, a bad checksum, and a non-file member', () => {
    const missing = acceptFixture()
    write(missing.tree, 'docs/pinme.txt', 'pin USER\n')
    const missingRun = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
printf 'RESTORED=%s\nNOTE=[%s]\n' "$ACCEPT_RESULT_RESTORED" "$ACCEPT_RESULT_NOTE"
`, { PREFIX_DIR: missing.prefix, HOME_DIR: missing.home })
    expect(missingRun.stdout).toContain('RESTORED=0')
    expect(missingRun.stdout).toContain('no pristine archive for 1; the next update will take the shipped file')
    expect(readFileSync(join(missing.tree, 'docs/pinme.txt'), 'utf8')).toBe('pin USER\n')
    expect(readFileSync(missing.pins, 'utf8')).not.toContain('pinme')

    const corrupt = acceptFixture()
    write(corrupt.tree, 'docs/pinme.txt', 'pin USER\n')
    makeBase(corrupt.prefix, 'flat', '1.tar')
    writeFileSync(join(corrupt.prefix, 'harness/.bases/1.tar.sha256'), `${'0'.repeat(64)}  1.tar\n`)
    const corruptRun = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
printf 'RESTORED=%s\nNOTE=[%s]\n' "$ACCEPT_RESULT_RESTORED" "$ACCEPT_RESULT_NOTE"
`, { PREFIX_DIR: corrupt.prefix, HOME_DIR: corrupt.home })
    expect(corruptRun.stdout).toContain('failed its checksum')

    const directory = acceptFixture()
    write(directory.tree, 'docs/pinme.txt', 'pin USER\n')
    const staging = scratch()
    mkdirSync(join(staging, 'docs/pinme.txt'), { recursive: true })
    write(staging, 'package.json', '{"version":"1"}\n')
    const out = join(directory.prefix, 'harness/.bases/1.tar')
    mkdirSync(dirname(out), { recursive: true })
    expect(spawnSync('tar', ['-cf', out, '-C', staging, 'docs/pinme.txt', 'package.json'], { encoding: 'utf8' }).status).toBe(0)
    sidecar(out)
    const directoryRun = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
printf 'RESTORED=%s\nNOTE=[%s]\n' "$ACCEPT_RESULT_RESTORED" "$ACCEPT_RESULT_NOTE"
`, { PREFIX_DIR: directory.prefix, HOME_DIR: directory.home })
    expect(directoryRun.stdout).toContain('not a regular file')
    expect(readFileSync(join(directory.tree, 'docs/pinme.txt'), 'utf8')).toBe('pin USER\n')
  })

  it('removes pins from plain, YAML, and quoted list shapes and reports an absent entry', () => {
    const fixture = acceptFixture()
    writeFileSync(fixture.pins, 'paths:\n  - docs/pinme.txt\n  - \'quoted.txt\'\nplain.txt\n# comment\n')
    mkdirSync(join(fixture.prefix, 'harness/.bases'), { recursive: true })
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
update_accept_shipped_path 'quoted.txt'
update_accept_shipped_path 'plain.txt'
update_accept_shipped_path 'absent.txt'
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no pin for absent.txt')
    expect(readFileSync(fixture.pins, 'utf8')).toBe('paths:\n# comment\n')
    const before = readFileSync(fixture.pins, 'utf8')
    const again = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; OS=linux; ARCH=x64
installed_version=1; current=1
update_accept_shipped_path 'docs/pinme.txt'
`, { PREFIX_DIR: fixture.prefix, HOME_DIR: fixture.home })
    expect(again.stdout).toContain('no pin for docs/pinme.txt')
    expect(readFileSync(fixture.pins, 'utf8')).toBe(before)
  })
})

describe.skipIf(win32)('pnpm requirement', () => {
  it('proceeds without pnpm only when no profile source is recorded', () => {
    const result = runLib(String.raw`
setup_pnpm() { return 1; }
PROFILE_SOURCE=""
ensure_update_pnpm
printf 'SKIP_RC=%s\n' "$?"
( PROFILE_SOURCE="https://profile.invalid/x.git"; ensure_update_pnpm )
printf 'SOURCE_RC=%s\n' "$?"
setup_pnpm() { PNPM=/stub/pnpm; return 0; }
PROFILE_SOURCE="https://profile.invalid/x.git"
ensure_update_pnpm
printf 'OK_RC=%s PNPM=%s\n' "$?" "$PNPM"
`)
    expect(result.stdout).toContain('SKIP_RC=0')
    expect(result.stdout).toContain('SOURCE_RC=1')
    expect(result.stdout).toContain('OK_RC=0 PNPM=/stub/pnpm')
    expect(result.stderr).toContain('pnpm unavailable; this update has no profile dependency step')
    expect(result.stderr).toContain('could not enable pnpm through corepack')
  })
})

describe.skipIf(win32)('dsh clean staging guard', () => {
  it('keeps staging with a live owner (and its journal) and removes stale staging', async () => {
    const prefix = join(scratch(), 'prefix')
    const harness = join(prefix, 'harness')
    mkdirSync(join(harness, '.staging-live'), { recursive: true })
    mkdirSync(join(harness, '.staging-stale'), { recursive: true })
    const live = spawn('sleep', ['30'])
    sleepers.push(live)
    const dead = spawn('sleep', ['30'])
    const deadPid = dead.pid
    dead.kill('SIGKILL')
    await new Promise<void>((resolve) => { dead.on('exit', () => { resolve() }) })
    writeFileSync(join(harness, '.staging-live.owner'), `${live.pid}\n`)
    writeFileSync(join(harness, '.staging-live.journal.json'), '{}\n')
    writeFileSync(join(harness, '.staging-stale.owner'), `${deadPid}\n`)
    writeFileSync(join(harness, '.staging-stale.journal.json'), '{}\n')

    // A private TMPDIR keeps do_clean's `/tmp/dsh-install-*` sweep away from
    // other specs' scratch homes running in parallel workers.
    const cleanTmp = scratch()
    const result = spawnSync('bash', [installSh, '--clean', '--prefix', prefix], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: join(prefix, 'home'), TMPDIR: cleanTmp },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('skipped active staging')
    expect(existsSync(join(harness, '.staging-live'))).toBe(true)
    expect(existsSync(join(harness, '.staging-live.journal.json'))).toBe(true)
    expect(existsSync(join(harness, '.staging-live.owner'))).toBe(true)
    expect(existsSync(join(harness, '.staging-stale'))).toBe(false)
    expect(existsSync(join(harness, '.staging-stale.journal.json'))).toBe(false)
    expect(existsSync(join(harness, '.staging-stale.owner'))).toBe(false)
  })
})

describe.skipIf(win32)('update report retention by run', () => {
  it('keeps the newest 3 runs (json+txt pairs) and prunes older runs file-by-file', () => {
    const prefix = join(scratch(), 'prefix')
    const harness = join(prefix, 'harness')
    mkdirSync(harness, { recursive: true })
    // Runs 1..4; run 4 is newest. Within a run the two files are written at
    // different moments, so pair grouping must not depend on adjacency.
    for (const run of [1, 2, 3, 4]) {
      for (const kind of ['json', 'txt']) {
        const file = join(harness, `.last-update-${run}.${kind}`)
        writeFileSync(file, `${run}-${kind}\n`)
        const when = new Date(Date.parse('2026-01-01T00:00:00Z') + run * 1000 + (kind === 'txt' ? 500 : 0))
        utimesSync(file, when, when)
      }
    }
    const first = runLib(String.raw`
PREFIX="$PREFIX_DIR"
prune_update_reports
`, { PREFIX_DIR: prefix })
    expect(first.status).toBe(0)
    expect(readdirSync(harness).sort()).toEqual([
      '.last-update-2.json', '.last-update-2.txt',
      '.last-update-3.json', '.last-update-3.txt',
      '.last-update-4.json', '.last-update-4.txt',
    ])

    // Run 5 becomes newest: run 2 falls out, both of its files together.
    for (const kind of ['json', 'txt']) {
      const file = join(harness, `.last-update-5.${kind}`)
      writeFileSync(file, `5-${kind}\n`)
      const when = new Date(Date.parse('2026-01-01T00:10:00Z') + (kind === 'txt' ? 500 : 0))
      utimesSync(file, when, when)
    }
    const second = runLib(String.raw`
PREFIX="$PREFIX_DIR"
prune_update_reports
`, { PREFIX_DIR: prefix })
    expect(second.status).toBe(0)
    expect(readdirSync(harness).sort()).toEqual([
      '.last-update-3.json', '.last-update-3.txt',
      '.last-update-4.json', '.last-update-4.txt',
      '.last-update-5.json', '.last-update-5.txt',
    ])
  })
})

describe.skipIf(win32)('progress residue pruning', () => {
  it('reaps dead-run .progress/.chunks residue and keeps a live run\'s artifacts', () => {
    const prefix = join(scratch(), 'prefix')
    const harness = join(prefix, 'harness')
    const cache = join(harness, '.cache')
    const chunks = join(cache, 'old-asset.tar.gz.chunks')
    mkdirSync(chunks, { recursive: true })
    writeFileSync(join(cache, 'old-asset.tar.gz.progress'), 'stale\n')
    writeFileSync(join(chunks, '.progress'), 'stale\n')
    writeFileSync(join(chunks, 'manifest.json'), '{}\n')
    writeFileSync(join(chunks, 'part-0'), 'partial\n')
    const old = new Date(Date.now() - 3600_000)
    for (const p of [join(cache, 'old-asset.tar.gz.progress'), chunks, join(chunks, '.progress'), join(chunks, 'manifest.json')]) {
      utimesSync(p, old, old)
    }
    const dead = runLib(String.raw`
PREFIX="$PREFIX_DIR"
prune_orphaned_update_artifacts
`, { PREFIX_DIR: prefix })
    expect(dead.status).toBe(0)
    expect(existsSync(join(cache, 'old-asset.tar.gz.progress'))).toBe(false)
    expect(existsSync(chunks)).toBe(false)

    // A live run marker keeps even old artifact mtimes: the sweep must never
    // touch the side channels of a running update.
    const live = spawn('sleep', ['30'])
    sleepers.push(live)
    const liveChunks = join(cache, 'live-asset.tar.gz.chunks')
    mkdirSync(liveChunks, { recursive: true })
    writeFileSync(join(cache, 'live-asset.tar.gz.progress'), 'live\n')
    writeFileSync(join(liveChunks, 'part-0'), 'live\n')
    for (const p of [join(cache, 'live-asset.tar.gz.progress'), liveChunks, join(liveChunks, 'part-0')]) {
      utimesSync(p, old, old)
    }
    writeFileSync(join(harness, '.update-run.json'), `{"runId":"t","pid":${String(live.pid)},"mode":"one-shot","step":1,"steps":9,"phase":"running","startedAt":"x","logPath":"/dev/null","version":"","target":""}\n`)
    const kept = runLib(String.raw`
PREFIX="$PREFIX_DIR"
prune_orphaned_update_artifacts
`, { PREFIX_DIR: prefix })
    expect(kept.status).toBe(0)
    expect(existsSync(join(cache, 'live-asset.tar.gz.progress'))).toBe(true)
    expect(existsSync(join(liveChunks, 'part-0'))).toBe(true)
  })
})

describe('install log rotation', () => {
  it('rotates a log past the cap to exactly one predecessor, losing nothing', () => {
    const dir = scratch()
    const prefix = join(dir, 'prefix')
    const logs = join(prefix, 'logs')
    mkdirSync(logs, { recursive: true })
    const payload = 'A'.repeat(2048)
    writeFileSync(join(logs, 'install.log'), `${payload}last-step-output\n`)
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"
DSH_INSTALL_LOG_MAX_BYTES=1024
init_log_file
printf 'NEW=%s\n' "$(wc -c < "$PREFIX/logs/install.log" | tr -d ' ')"
printf 'HDR=%s\n' "$(grep -c 'dsh-install session' "$PREFIX/logs/install.log")"
`, { PREFIX_DIR: prefix })
    expect(result.status).toBe(0)
    // The fresh session file holds only its own header; the in-flight step
    // output moved intact to the predecessor.
    const newSize = Number(/NEW=(\d+)/u.exec(result.stdout)?.[1] ?? Number.NaN)
    expect(newSize).toBeGreaterThan(0)
    expect(newSize).toBeLessThan(1024)
    expect(result.stdout).toContain('HDR=1')
    const rolled = readFileSync(join(logs, 'install.log.1'), 'utf8')
    expect(rolled).toBe(`${payload}last-step-output\n`)
    expect(readdirSync(logs).sort()).toEqual(['install.log', 'install.log.1'])
  })

  it('leaves a log at or under the cap in place', () => {
    const dir = scratch()
    const prefix = join(dir, 'prefix')
    const logs = join(prefix, 'logs')
    mkdirSync(logs, { recursive: true })
    const payload = 'B'.repeat(1024)
    writeFileSync(join(logs, 'install.log'), payload)
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"
DSH_INSTALL_LOG_MAX_BYTES=1024
init_log_file
`, { PREFIX_DIR: prefix })
    expect(result.status).toBe(0)
    expect(existsSync(join(logs, 'install.log.1'))).toBe(false)
    const kept = readFileSync(join(logs, 'install.log'), 'utf8')
    expect(kept.startsWith(payload)).toBe(true)
    expect(kept).toContain('dsh-install session')
  })
})
