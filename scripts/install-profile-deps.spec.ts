/**
 * Profile dependency install guards in `scripts/install.sh`.
 *
 * pnpm packages a node_modules tree from the lockfile alone, so a link it did
 * not create — a dev box's manual workspace link pointing outside the profile —
 * is pruned silently; the running harness only notices at the next profile
 * reload, where every plugin row (the web server included) then fails
 * admission. The installer therefore snapshots foreign links before the
 * install and restores every entry that went missing, on success and failure
 * alike, and a failed dependency install or plugin verification now fails its
 * phase instead of reporting "already up to date" on a broken profile.
 *
 * Library-level tests source the installer (`DSH_INSTALL_LIB_ONLY=1`) and call
 * the helpers directly against scratch homes; pnpm and the plugin build are
 * stubs. No network is used.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const win32 = process.platform === 'win32'
const cleanups: string[] = []
let counter = 0

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-deps-'))
  cleanups.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run a bash body with the installer sourced as a library. */
function runLib(body: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
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

interface Fixture {
  root: string
  home: string
  profile: string
  outside: string
  log: string
  stub: string
}

/**
 * A scratch home whose `profiles/web` carries one real dependency directory,
 * two foreign links (an absolute top-level one and a scoped one), and one link
 * that resolves inside the profile — which must never be captured.
 */
function fixture(): Fixture {
  const root = scratch()
  const home = join(root, 'home')
  const profile = join(home, 'profiles/web')
  const outside = join(root, 'outside')
  const log = join(root, 'install.log')
  mkdirSync(join(profile, 'node_modules/@scope/nested'), { recursive: true })
  mkdirSync(join(profile, 'node_modules/.pnpm/inside'), { recursive: true })
  mkdirSync(join(profile, 'node_modules/plain-dir'), { recursive: true })
  mkdirSync(join(profile, '.payload/x'), { recursive: true })
  mkdirSync(join(outside, 'foreign-a'), { recursive: true })
  mkdirSync(join(outside, 'foreign-b'), { recursive: true })
  symlinkSync(join(outside, 'foreign-a'), join(profile, 'node_modules/outside-link'))
  symlinkSync(join(outside, 'foreign-b'), join(profile, 'node_modules/@scope/outside'))
  // Resolves inside the profile (via `..`) and through `.pnpm`: not foreign.
  symlinkSync('../.payload/x', join(profile, 'node_modules/inside-link'))
  symlinkSync('.pnpm/inside', join(profile, 'node_modules/@scope/inside'))
  // One level deeper than `@*/*`: outside the snapshot's scope.
  symlinkSync(join(outside, 'foreign-a'), join(profile, 'node_modules/@scope/nested/deep-link'))
  const stub = join(root, 'pnpm-stub.sh')
  writeFileSync(stub, [
    '#!/bin/sh',
    'echo "$@" >> "$STUB_LOG"',
    'rm -f "$PROFILE_NODE_MODULES/outside-link" "$PROFILE_NODE_MODULES/@scope/outside"',
    'exit "${PNPM_EXIT:-0}"',
  ].join('\n'))
  chmodSync(stub, 0o755)
  return { root, home, profile, outside, log, stub }
}

/** The profile package.json/lock/workspace files the hash skip reads. */
function writeDepsInputs(f: Fixture): string {
  const pkg = '{"name":"dsh-profile-web","dependencies":{}}\n'
  const lock = 'lockfileVersion: 9.0\n'
  const workspace = 'packages:\n  - .\n'
  writeFileSync(join(f.profile, 'package.json'), pkg)
  writeFileSync(join(f.profile, 'pnpm-lock.yaml'), lock)
  writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), workspace)
  return createHash('sha256').update(pkg + lock + workspace).digest('hex')
}

/** The env the sourced profile helpers expect. */
function baseEnv(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME_DIR: f.home,
    PREFIX_DIR: join(f.root, 'prefix'),
    LOG: f.log,
    PROFILE: 'web',
    PROFILE_SOURCE: 'local',
    STUB: f.stub,
    STUB_LOG: join(f.root, 'pnpm-calls.log'),
    PROFILE_NODE_MODULES: join(f.profile, 'node_modules'),
    NODE_BIN: process.execPath,
    ...extra,
  }
}

describe.skipIf(win32)('foreign node_modules links', () => {
  it('snapshots only links leaving the profile and restores the ones pruned', () => {
    const f = fixture()
    const result = runLib(String.raw`
PROFILE_DIR="$HOME_DIR/profiles/web"; LOG_FILE="$LOG"
profile_foreign_links_snapshot "$HOME_DIR/snapshot"
printf 'SNAPSHOT count=%s\n' "$(wc -l < "$HOME_DIR/snapshot" | tr -d ' ')"
sort "$HOME_DIR/snapshot" | sed "s|$HOME_DIR|<home>|g"
rm -f "$PROFILE_DIR/node_modules/outside-link" "$PROFILE_DIR/node_modules/@scope/outside"
profile_foreign_links_restore "$HOME_DIR/snapshot"
printf 'RESTORED outside=%s scoped=%s\n' \
  "$(readlink "$PROFILE_DIR/node_modules/outside-link")" \
  "$(readlink "$PROFILE_DIR/node_modules/@scope/outside")"
printf 'INSIDE=%s\n' "$(readlink "$PROFILE_DIR/node_modules/inside-link")"
printf 'LOG=%s\n' "$(grep -c 'restored 2 foreign symlink' "$LOG" || true)"
`, baseEnv(f))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SNAPSHOT count=2')
    expect(result.stdout).toContain(`outside-link\t${f.outside}/foreign-a`)
    expect(result.stdout).toContain(`@scope/outside\t${f.outside}/foreign-b`)
    expect(result.stdout).not.toContain('inside-link')
    expect(result.stdout).not.toContain('deep-link')
    expect(result.stdout).toContain(`RESTORED outside=${f.outside}/foreign-a scoped=${f.outside}/foreign-b`)
    expect(result.stdout).toContain('LOG=1')
  })

  it('is a no-op when the profile has no foreign links, and never touches a link that survived', () => {
    const bare = scratch()
    mkdirSync(join(bare, 'node_modules'), { recursive: true })
    const empty = runLib(String.raw`
PROFILE_DIR="$HOME_DIR"; LOG_FILE="$LOG"
profile_foreign_links_snapshot "$HOME_DIR/snapshot"
printf 'SIZE=%s\n' "$(wc -c < "$HOME_DIR/snapshot" | tr -d ' ')"
profile_foreign_links_restore "$HOME_DIR/snapshot"
printf 'RC=%s\n' "$?"
logged="$(grep -c 'restored' "$LOG" 2>/dev/null || true)"
[ -n "$logged" ] || logged=0
printf 'LOG=%s\n' "$logged"
`, { HOME_DIR: bare, LOG: join(bare, 'install.log') })
    expect(empty.status).toBe(0)
    expect(empty.stdout).toContain('SIZE=0')
    expect(empty.stdout).toContain('RC=0')
    expect(empty.stdout).toContain('LOG=0')

    const f = fixture()
    const partial = runLib(String.raw`
PROFILE_DIR="$HOME_DIR/profiles/web"; LOG_FILE="$LOG"
profile_foreign_links_snapshot "$HOME_DIR/snapshot"
rm -f "$PROFILE_DIR/node_modules/@scope/outside"
ln -sfn "$OUTSIDE/foreign-b" "$PROFILE_DIR/node_modules/outside-link"
profile_foreign_links_restore "$HOME_DIR/snapshot"
printf 'KEPT=%s\n' "$(readlink "$PROFILE_DIR/node_modules/outside-link")"
printf 'LOG=%s\n' "$(grep -c 'restored 1 foreign symlink' "$LOG" || true)"
`, baseEnv(f, { OUTSIDE: f.outside }))
    expect(partial.status).toBe(0)
    // The surviving link keeps the target it had at restore time.
    expect(partial.stdout).toContain(`KEPT=${f.outside}/foreign-b`)
    expect(partial.stdout).toContain('LOG=1')
    expect(existsSync(join(f.profile, 'node_modules/@scope/outside'))).toBe(true)
  })
})

describe.skipIf(win32)('profile_install', () => {
  it('restores the foreign links pnpm pruned and records the durable list', () => {
    const f = fixture()
    writeDepsInputs(f)
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules"
profile_install; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('RC=0')
    expect(readlinkSync(join(f.profile, 'node_modules/outside-link'))).toBe(join(f.outside, 'foreign-a'))
    expect(readlinkSync(join(f.profile, 'node_modules/@scope/outside'))).toBe(join(f.outside, 'foreign-b'))
    expect(readFileSync(f.log, 'utf8')).toContain('restored 2 foreign symlink(s) pruned by install')
    const durable = readFileSync(join(f.profile, '.dsh-foreign-links'), 'utf8')
    expect(durable).toContain(`outside-link\t${f.outside}/foreign-a`)
    expect(durable).toContain(`@scope/outside\t${f.outside}/foreign-b`)
  })

  it('restores them on a failed install too, then reports the failure', () => {
    const f = fixture()
    writeDepsInputs(f)
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules" PNPM_EXIT=1
profile_install; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('RC=1')
    expect(result.stderr).toContain('profile pnpm install failed')
    expect(readlinkSync(join(f.profile, 'node_modules/outside-link'))).toBe(join(f.outside, 'foreign-a'))
    expect(readFileSync(f.log, 'utf8')).toContain('restored 2 foreign symlink(s) pruned by install')
  })

  it('keeps the hash-skip early return: no pnpm call, no snapshot, nothing restored', () => {
    const f = fixture()
    const hash = writeDepsInputs(f)
    writeFileSync(join(f.profile, '.pnpm-deps.hash'), `${hash}\n`)
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules"
profile_install; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('RC=0')
    expect(readFileSync(f.log, 'utf8')).toContain('dependencies already up to date (hash match); skipping pnpm install')
    expect(existsSync(join(f.root, 'pnpm-calls.log'))).toBe(false)
    // The links were never pruned and never touched.
    expect(readlinkSync(join(f.profile, 'node_modules/outside-link'))).toBe(join(f.outside, 'foreign-a'))
  })
})

describe.skipIf(win32)('profile_refresh and run_migrations blocking', () => {
  it('profile_refresh fails on a failed dependency install', () => {
    const f = fixture()
    writeDepsInputs(f)
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules" PNPM_EXIT=1
profile_refresh; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.stdout).toContain('RC=1')
    expect(result.stderr).toContain('profile pnpm install failed')
  })

  it('profile_refresh fails on a failed plugin verification even when deps succeed', () => {
    const f = fixture()
    writeDepsInputs(f)
    writeFileSync(join(f.profile, 'build-plugins.sh'), '#!/bin/sh\necho "verify failed" >&2\nexit 1\n')
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules"
profile_refresh; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.stdout).toContain('RC=1')
    expect(result.stderr).toContain('profile plugin build failed')
  })

  it('run_migrations refuses to continue past a failed profile dependency install', () => {
    const f = fixture()
    writeDepsInputs(f)
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"; VERSION=test; PREV_VERSION=test
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"; NODE=/bin/false; HARNESS="$PREFIX_DIR/harness/fake"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules" PNPM_EXIT=1
run_migrations; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.stdout).toContain('RC=1')
    expect(result.stderr).toContain('profile pnpm install failed')
  })

  it('run_migrations refuses to continue past a failed plugin verification', () => {
    const f = fixture()
    writeDepsInputs(f)
    writeFileSync(join(f.profile, 'build-plugins.sh'), '#!/bin/sh\nexit 1\n')
    const result = runLib(String.raw`
DSH_HOME="$HOME_DIR"; PROFILE=web; PROFILE_SOURCE="local"; VERSION=test; PREV_VERSION=test
PNPM="$STUB"; PREFIX="$PREFIX_DIR"; LOG_FILE="$LOG"; NODE=/bin/false; HARNESS="$PREFIX_DIR/harness/fake"
mkdir -p "$PREFIX_DIR"; export STUB_LOG PROFILE_NODE_MODULES="$DSH_HOME/profiles/web/node_modules"
run_migrations; printf 'RC=%s\n' "$?"
`, baseEnv(f))
    expect(result.stdout).toContain('RC=1')
    expect(result.stderr).toContain('profile plugin build failed')
  })
})
