/**
 * Two-phase update engine (`dsh update --prepare` / `dsh update --apply`) from
 * `scripts/install.sh`.
 *
 * Prepare runs the full flow and stops immediately before the `current` switch,
 * recording the staged tree in `$PREFIX/harness/.staged-apply.json` (the field
 * set is the UI/plugin contract). Apply consumes that record: switch ->
 * service restart -> self-check -> health proof -> retention prune -> delete
 * the record, with the record surviving any failure so the UI can retry.
 *
 * Library-level tests source the installer (`DSH_INSTALL_LIB_ONLY=1`) and call
 * the helpers directly: the staged-record contract, the no-download idempotency
 * probe, the orphan-artifact sweep's live-owner guard, and rollback tolerating
 * an empty backup. Flag validation and the `--apply` "nothing staged" refusal
 * are driven through real script invocations against scratch prefixes. All
 * paths live under unique mkdtemp roots; no network is used (DSH_RELEASE_TAG
 * pins the release probe).
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-two-phase-'))
  cleanups.push(dir)
  return dir
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

/** Run the real script (dispatch included) against a scratch prefix. */
function runScript(args: string[], env: Record<string, string> = {}): LibResult {
  const result = spawnSync('bash', [installSh, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** A minimal consistent install: current symlink, marker, state, per-tree CLI. */
function minimalInstall(): { root: string; prefix: string; home: string; binDir: string; version: string } {
  const root = scratch()
  const prefix = join(root, 'prefix')
  const home = join(root, 'home')
  const binDir = join(root, 'bin')
  const version = '0.1.7-enpoi.2.80'
  const tree = join(prefix, 'harness', version)
  mkdirSync(tree, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  write(tree, 'package.json', `{"version":"${version}"}\n`)
  write(tree, '.dsh-install-complete', `{"version":"${version}","commit":"","installedAt":"2026-01-01T00:00:00Z"}\n`)
  write(tree, 'apps/cli/lib/bin.js', `console.log('${version}')\n`)
  symlinkSync(version, join(prefix, 'harness', 'current'))
  write(prefix, 'harness/install-state.json', `${JSON.stringify({
    prefix,
    version,
    harnessDir: version,
    commit: '',
    channel: 'beta',
    ref: 'beta',
    source: '',
    sourceUrl: '',
    profile: 'web',
    profileSource: '',
    profileRef: '',
    profileRefDerived: false,
    binDir,
    dshHome: home,
    node: process.execPath,
    nodeOrigin: 'test',
    pnpm: '',
    serviceUnit: null,
    serviceInstall: false,
    updatedAt: '2026-01-01T00:00:00Z',
  }, null, 2)}\n`)
  return { root, prefix, home, binDir, version }
}

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(win32)('two-phase flag validation', () => {
  it('refuses --prepare without --update', () => {
    const result = runScript(['--prepare'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--prepare/--apply apply to --update only')
  })

  it('refuses --prepare together with --apply', () => {
    const result = runScript(['--update', '--prepare', '--apply'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('choose one of --prepare, --apply')
  })

  it('refuses --apply with --dry-run', () => {
    const result = runScript(['--update', '--apply', '--dry-run'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('--dry-run does not apply to --apply')
  })
})

describe.skipIf(win32)('staged apply record (contract)', () => {
  it('writes exactly the contract fields, with null releaseCommit and false prebuilt when absent', () => {
    const prefix = scratch()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"
write_staged_apply "0.1.7-enpoi.2.84" "0.1.7-enpoi.2.84" "beta" "" 0
cat "$PREFIX/harness/.staged-apply.json"
`, { PREFIX_DIR: prefix })
    expect(result.status).toBe(0)
    const record = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(['channel', 'prebuilt', 'preparedAt', 'releaseCommit', 'treeDirName', 'version'])
    expect(record.version).toBe('0.1.7-enpoi.2.84')
    expect(record.treeDirName).toBe('0.1.7-enpoi.2.84')
    expect(record.channel).toBe('beta')
    expect(record.releaseCommit).toBeNull()
    expect(record.prebuilt).toBe(false)
    expect(String(record.preparedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('records a release commit and prebuilt=true for a prebuilt target', () => {
    const prefix = scratch()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"
write_staged_apply "x" "x" "stable" "abcdef1234567890" 1
cat "$PREFIX/harness/.staged-apply.json"
`, { PREFIX_DIR: prefix })
    const record = JSON.parse(result.stdout) as Record<string, unknown>
    expect(record.releaseCommit).toBe('abcdef1234567890')
    expect(record.prebuilt).toBe(true)
  })
})

describe.skipIf(win32)('prepare idempotency probe', () => {
  it('resolves the pinned release tag without a network call', () => {
    const result = runLib('prepare_target_probe', { DSH_RELEASE_TAG: 'v0.1.7-enpoi.2.84' })
    expect(result.stdout).toBe('0.1.7-enpoi.2.84')
  })

  it('reads a local source directory version', () => {
    const src = scratch()
    write(src, 'package.json', '{"version":"9.9.9-src"}\n')
    const result = runLib('SOURCE="$SRC_DIR"; NODE="$NODE_BIN"; prepare_target_probe', { SRC_DIR: src, NODE_BIN: process.execPath })
    expect(result.stdout).toBe('9.9.9-src')
  })
})

describe.skipIf(win32)('orphan artifact sweep', () => {
  it('removes dead-owner downloads and delta scratch but keeps live owners, the staged record, current, and the live tree', () => {
    const { prefix, home } = minimalInstall()
    const harness = join(prefix, 'harness')
    // A dead owner pid: spawn and reap a process, then reuse its pid.
    const dead = spawnSync(process.execPath, ['-e', '']).pid
    if (dead === undefined) throw new Error('no pid')
    writeFileSync(join(harness, '.download-21919.tar.gz'), Buffer.alloc(2048, 1))
    writeFileSync(join(harness, '.download-21919.tar.gz.sha256'), 'x  f\n')
    writeFileSync(join(harness, `.download-${dead}.tar.gz`), Buffer.alloc(1024, 1))
    writeFileSync(join(harness, `.release-0.1.7-enpoi.2.84-${dead}`), 'scratch\n')
    writeFileSync(join(harness, `.update-plan-${dead}.json`), 'scratch\n')
    writeFileSync(join(harness, '.staged-apply.json'), '{"version":"0.1.7-enpoi.2.84"}\n')
    writeFileSync(join(harness, '.last-update-1.txt'), 'report\n')
    writeFileSync(join(harness, '.update.lock'), '1\n')
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; PROFILE=web; LOG_FILE=""
# A live-owner download: the trailing pid is this very shell.
printf 'live\n' > "$PREFIX/harness/.download-$$.tar.gz"
prune_orphaned_update_artifacts
printf 'rc=%s\n' "$?"
`, { PREFIX_DIR: prefix, HOME_DIR: home })
    expect(result.status).toBe(0)
    expect(existsSync(join(harness, '.download-21919.tar.gz'))).toBe(false)
    expect(existsSync(join(harness, '.download-21919.tar.gz.sha256'))).toBe(false)
    // The dead-pid file is removed too (its owner is gone).
    expect(existsSync(join(harness, `.download-${dead}.tar.gz`))).toBe(false)
    expect(existsSync(join(harness, `.release-0.1.7-enpoi.2.84-${dead}`))).toBe(false)
    expect(existsSync(join(harness, `.update-plan-${dead}.json`))).toBe(false)
    // Kept: the staged record, the run report, current, the live tree, and the
    // download whose owner (this shell) is alive.
    expect(existsSync(join(harness, '.staged-apply.json'))).toBe(true)
    expect(existsSync(join(harness, '.last-update-1.txt'))).toBe(true)
    expect(existsSync(join(harness, '.update.lock'))).toBe(true)
    expect(existsSync(join(harness, 'current'))).toBe(true)
    expect(existsSync(join(harness, '0.1.7-enpoi.2.80/.dsh-install-complete'))).toBe(true)
  })

  it('leaves a live .download-<pid>.tar.gz alone in cleanup_stale_artifacts', () => {
    const { prefix } = minimalInstall()
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; LOG_FILE=""
printf 'live\n' > "$PREFIX/harness/.download-$$.tar.gz"
cleanup_stale_artifacts >/dev/null 2>&1
[ -e "$PREFIX/harness/.download-$$.tar.gz" ] && echo KEPT || echo REMOVED
`, { PREFIX_DIR: prefix })
    expect(result.stdout).toContain('KEPT')
  })
})

describe.skipIf(win32)('apply refusals', () => {
  it('refuses with a typed message and non-zero when nothing is staged', () => {
    const { prefix, home } = minimalInstall()
    const result = runScript(['--update', '--apply', '--prefix', prefix, '--dsh-home', home])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('nothing staged at')
    expect(result.stderr).toContain('dsh update --prepare')
  })

  it('refuses a staged record whose tree is missing, changing nothing', () => {
    const { prefix, home, version } = minimalInstall()
    writeFileSync(join(prefix, 'harness', '.staged-apply.json'), `${JSON.stringify({
      version: '0.1.7-enpoi.2.84',
      treeDirName: '0.1.7-enpoi.2.84',
      channel: 'beta',
      releaseCommit: null,
      prebuilt: true,
      preparedAt: '2026-01-01T00:00:00Z',
    })}\n`)
    const result = runScript(['--update', '--apply', '--prefix', prefix, '--dsh-home', home])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('missing or incomplete')
    // Nothing switched, record kept for the UI.
    expect(readlinkSync(join(prefix, 'harness', 'current'))).toBe(version)
    expect(existsSync(join(prefix, 'harness', '.staged-apply.json'))).toBe(true)
  })
})

const stagedRecord = {
  version: '0.1.7-enpoi.2.84', treeDirName: 'a', channel: 'beta', releaseCommit: null,
  prebuilt: true, preparedAt: '2026-01-01T00:00:00Z',
}

function applyFixture() {
  const { prefix, version } = minimalInstall()
  const harness = join(prefix, 'harness')
  const record = write(harness, '.staged-apply.json', `${JSON.stringify(stagedRecord)}\n`)
  for (const tree of ['a', 'b']) write(harness, `${tree}/.dsh-install-complete`, '{}\n')
  return { harness, record, version, env: { PREFIX_DIR: prefix, NODE_BIN: process.execPath, PREVIOUS: version, IN_SESSION: '0' } }
}

const applyStubs = String.raw`
PREFIX="$PREFIX_DIR"; NODE="$NODE_BIN"; OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; PROFILE=web; CHANNEL=beta
SERVICE_UNIT=dsh-test; TRACE="$PREFIX/trace"
init_log_file() { :; }
run_marker_phase() { :; }
service_generation() { if [ -f "$TRACE" ]; then printf new; else printf old; fi; }
restart_service() { printf 'restart\n' >> "$TRACE"; }
run_backfill() { printf 'backfill\n' >> "$TRACE"; }
running_under_service() { [ "$IN_SESSION" = 1 ]; }
selfcheck() { printf 'selfcheck\n' >> "$TRACE"; }
health_proof_robust() { printf 'health %s\n' "$*" >> "$TRACE"; }
restore_state_for_tree() { :; }
prune_versions() { :; }
prune_update_artifacts() { :; }
delegate_service_restart() { printf 'delegate %s\n' "$*" >> "$TRACE"; }
`

describe.skipIf(win32)('staged apply admission and completion', () => {
  it.each([
    { treeDirName: 'b', version: '0.1.7-enpoi.2.85' },
    { version: '0.1.7-enpoi.2.85' }, { treeDirName: 'b' }, { channel: 'stable' },
    { releaseCommit: 'fedcba1234' }, { prebuilt: false }, { preparedAt: '2026-01-02T00:00:00Z' },
  ])('refuses a replacement at lock admission (%j)', (replacement) => {
    const f = applyFixture()
    const contents = `${JSON.stringify({ ...stagedRecord, ...replacement })}\n`
    write(f.harness, 'replacement.json', contents)
    const result = runLib(`${applyStubs}
acquire_update_lock() { mv "$PREFIX/harness/replacement.json" "$(staged_apply_path)"; }
do_apply_staged "$PREVIOUS"
`, f.env)
    expect(result.stderr).toContain('changed while waiting for the update lock')
    expect(result.status).toBe(1)
    expect(readlinkSync(join(f.harness, 'current'))).toBe(f.version)
    expect(readFileSync(f.record, 'utf8')).toBe(contents)
  })

  it('refuses when the admitted staged tree becomes incomplete', () => {
    const f = applyFixture()
    const result = runLib(`${applyStubs}
acquire_update_lock() { rm "$PREFIX/harness/a/.dsh-install-complete"; }
do_apply_staged "$PREVIOUS"
`, f.env)
    expect(result.stderr).toContain('changed while waiting for the update lock')
    expect(result.status).toBe(1)
    expect(readlinkSync(join(f.harness, 'current'))).toBe(f.version)
    expect(existsSync(f.record)).toBe(true)
  })

  it('does not consume a replacement observed after the switch', () => {
    const f = applyFixture()
    const contents = `${JSON.stringify({ ...stagedRecord, treeDirName: 'b' })}\n`
    write(f.harness, 'replacement.json', contents)
    const result = runLib(`${applyStubs}
acquire_update_lock() { :; }
prune_versions() { mv "$PREFIX/harness/replacement.json" "$(staged_apply_path)"; }
do_apply_staged "$PREVIOUS"
`, f.env)
    expect(result.status, result.stderr).toBe(0)
    expect(readlinkSync(join(f.harness, 'current'))).toBe('a')
    expect(readFileSync(f.record, 'utf8')).toBe(contents)
  })

  it.each([
    ['0', 'restart\nbackfill\nselfcheck\nhealth 0\n'],
    ['1', 'selfcheck\nhealth 1\ndelegate a\n'],
  ])('finishes apply with ordered backfill work (in-session=%s)', (inSession, expected) => {
    const f = applyFixture()
    const result = runLib(`${applyStubs}
acquire_update_lock() { :; }
do_apply_staged "$PREVIOUS"
`, { ...f.env, IN_SESSION: inSession })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(f.harness, '../trace'), 'utf8')).toBe(expected)
    expect(existsSync(f.record)).toBe(false)
  })
})

describe.skipIf(win32)('staged backfill readiness', () => {
  it.each([
    ['old-runtime', ''],
    ['not-ready', ''],
    ['ready', 'status\nrun\n'],
  ])('runs against the new runtime only when it answers (%s)', (runtime, expected) => {
    const result = runLib(String.raw`
SERVICE_UNIT=dsh-test; NODE="$NODE_BIN"
find_backfill() { printf '%s' '/unused/dsh-projections-backfill.mjs'; }
unit_is_active() { :; }
service_generation() { if [ "$RUNTIME" = 'old-runtime' ]; then printf old; else printf new; fi; }
curl() { [ "$RUNTIME" = ready ]; }
sleep() { :; }
run_limited() { printf '%s\n' "$4" >> "$TRACE"; }
run_backfill require-web old
if [ -f "$TRACE" ]; then cat "$TRACE"; fi
`, { NODE_BIN: process.execPath, RUNTIME: runtime, TRACE: join(scratch(), 'backfill-trace') })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(expected)
  })

  it.each([
    ['a', 'waiting\nweb\nstatus\nrun\n'],
    ['b', 'waiting\n'],
  ])('the detached guard waits for a restart and checks the active tree (%s)', (tree, expected) => {
    const f = applyFixture()
    rmSync(join(f.harness, 'current'))
    symlinkSync(tree, join(f.harness, 'current'))
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; SERVICE_UNIT=dsh-test; GUARD_BACKFILL_TREE=a; GUARD_BASELINE=old
TRACE="$PREFIX/guard-trace"
resolve_node() { NODE="$NODE_BIN"; }
unit_is_active() { :; }
service_generation() { if [ -f "$TRACE" ]; then printf new; else printf old; fi; }
find_backfill() { printf '%s' "$HARNESS/scripts/dsh-projections-backfill.mjs"; }
sleep() { printf 'waiting\n' >> "$TRACE"; }
curl() { printf 'web\n' >> "$TRACE"; }
run_limited() { printf '%s\n' "$4" >> "$TRACE"; }
do_service_guard_run
cat "$TRACE"
`, f.env)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(expected)
  })

  it('passes the applied tree to the guard for the after-turn restart', () => {
    const result = runLib(String.raw`
SERVICE_UNIT=dsh-test; DSH_SESSION_ID=test-session; DSH_PTY_SESSION_ID=""
service_generation() { printf old; }
spawn_service_guard() { printf 'guard %s\n' "$*"; }
write_restart_marker() { printf 'marker %s\n' "$*"; }
fire_detached_restart() { die 'unexpected immediate restart'; }
delegate_service_restart a
`)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('guard old 0 900 a\nmarker test-session\n')
  })
})

describe.skipIf(win32)('plain update and the staged record', () => {
  it.each(['quick release probe', 'delta planner', 'different target'])('protects the record until build/install (%s)', (route) => {
    const { prefix, home, version } = minimalInstall()
    const contents = `${JSON.stringify(stagedRecord)}\n`
    const record = write(prefix, 'harness/.staged-apply.json', contents)
    const result = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; WRITE_RC=0
acquire_update_lock() { :; }
resolve_node() { :; }
init_log_file() { :; }
sudo_trap() { :; }
prune_failed_versions() { :; }
sweep_experimental_residue() { :; }
delta_plan_init() {
  DELTA_MODE=""; DELTA_TARGET_VERSION="$1"; DELTA_UP_TO_DATE=0
  if [ "$ROUTE" = 'delta planner' ]; then DELTA_UP_TO_DATE=1; fi
}
latest_release_is_installed() { if [ "$ROUTE" != 'different target' ]; then printf 'v%s\n' "$1"; fi; }
prepare_source() { VERSION=0.1.7-enpoi.2.81; PREBUILT=1; }
resolve_target_for_source() { :; }
ensure_update_pnpm() { :; }
install_tree() { [ ! -e "$(staged_apply_path)" ] || die 'record present during install'; printf 'building target\n'; exit 0; }
prepare_profile() { :; }
seed_home() { :; }
profile_refresh() { :; }
ensure_service() { :; }
ensure_tailnet_exposure() { :; }
selfcheck() { :; }
write_shim() { :; }
write_peer_cli() { :; }
health_proof_robust() { :; }
prune_update_artifacts() { :; }
sweep_old_tree_backups() { :; }
do_update
`, { PREFIX_DIR: prefix, HOME_DIR: home, NODE_BIN: process.execPath, ROUTE: route })
    expect(result.status, result.stderr).toBe(0)
    if (route === 'different target') {
      expect(result.stdout).toContain('building target')
      expect(existsSync(record)).toBe(false)
    } else {
      expect(result.stdout).toContain(`already up to date: ${version}`)
      expect(readFileSync(record, 'utf8')).toBe(contents)
    }
  })
})

describe.skipIf(win32)('prepare same-version idempotency (no network)', () => {
  it('prints already-staged and exits 0 without touching current', () => {
    const { prefix, home, version } = minimalInstall()
    const staged = '0.1.7-enpoi.2.84'
    const tree = join(prefix, 'harness', staged)
    mkdirSync(tree, { recursive: true })
    write(tree, 'package.json', `{"version":"${staged}"}\n`)
    write(tree, '.dsh-install-complete', `{"version":"${staged}","commit":"","installedAt":"2026-01-01T00:00:00Z"}\n`)
    writeFileSync(join(prefix, 'harness', '.staged-apply.json'), `${JSON.stringify({
      version: staged,
      treeDirName: staged,
      channel: 'beta',
      releaseCommit: null,
      prebuilt: true,
      preparedAt: '2026-01-01T00:00:00Z',
    })}\n`)
    const result = runScript(['--update', '--prepare', '--prefix', prefix, '--dsh-home', home], {
      DSH_RELEASE_TAG: `v${staged}`,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('already staged')
    expect(readlinkSync(join(prefix, 'harness', 'current'))).toBe(version)
    // The record is byte-identical (not rewritten).
    const record = JSON.parse(readFileSync(join(prefix, 'harness', '.staged-apply.json'), 'utf8')) as { preparedAt: string }
    expect(record.preparedAt).toBe('2026-01-01T00:00:00Z')
    expect(existsSync(join(prefix, 'logs'))).toBe(false)
  })
})

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

interface PrepareRollbackFixture {
  root: string
  prefix: string
  home: string
  profileDir: string
  prev: string
  next: string
  env: Record<string, string>
}

function prepareRollbackFixture(): PrepareRollbackFixture {
  const base = minimalInstall()
  const next = '0.1.7-enpoi.2.84'
  const nextTree = join(base.prefix, 'harness', next)
  write(nextTree, 'package.json', `{"version":"${next}"}\n`)
  write(nextTree, '.dsh-install-complete', `{"version":"${next}","commit":"","installedAt":"2026-01-01T00:00:00Z"}\n`)
  write(nextTree, 'apps/cli/lib/bin.js', `console.log('${next}')\n`)

  const profileDir = join(base.home, 'profiles', 'web')
  write(profileDir, 'cordis.patch.yml', '- id: old-row\n')
  write(profileDir, 'package.json', '{"name":"web","dependencies":{"old":"1.0.0"}}\n')
  write(profileDir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n# old\n')
  write(profileDir, 'settings.yaml', 'model: original-choice\n')
  write(profileDir, 'device-patches/host.yaml', 'patch: original\n')
  write(profileDir, 'build-plugins.sh', '#!/bin/sh\nexit 0\n', 0o755)
  write(profileDir, 'node_modules/pkg/index.js', 'module.exports = "old"\n')
  write(profileDir, 'packages/enpoi-demo/lib/index.js', 'export const v = "old"\n')

  return {
    root: base.root,
    prefix: base.prefix,
    home: base.home,
    profileDir,
    prev: base.version,
    next,
    env: {
      PREFIX_DIR: base.prefix,
      HOME_DIR: base.home,
      PROFILE_DIR_VAL: profileDir,
      NODE_BIN: process.execPath,
      PREVIOUS: base.version,
      NEXT_VER: next,
    },
  }
}

function runPreparePhase(f: PrepareRollbackFixture, options: { touchSettings?: boolean } = {}): LibResult {
  const touchSettings = options.touchSettings ?? true
  return runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; CHANNEL=beta; PROFILE=web
PROFILE_DIR="$PROFILE_DIR_VAL"; UPDATE_PREPARE=1; UPDATE_APPLY=0
init_log_file() { :; }
run_marker_init() { :; }
run_marker_phase() { :; }
sudo_trap() { :; }
prune_failed_versions() { :; }
sweep_experimental_residue() { :; }
delta_plan_init() { DELTA_MODE=""; DELTA_TARGET_VERSION=""; DELTA_UP_TO_DATE=0; }
latest_release_is_installed() { :; }
prepare_source() { VERSION="$NEXT_VER"; PREBUILT=1; RELEASE_COMMIT=""; }
resolve_target_for_source() { :; }
ensure_update_pnpm() { :; }
install_tree() { HARNESS="$PREFIX/harness/$NEXT_VER"; return 0; }
apply_user_patches() { :; }
prepare_profile() {
  printf '%s\n' '- id: prepared-row' > "$PROFILE_DIR/cordis.patch.yml"
  printf '{"name":"web","dependencies":{"new":"2.0.0"}}\n' > "$PROFILE_DIR/package.json"
}
run_migrations() {
  printf 'lockfileVersion: 9.0\n# prepared\n' > "$PROFILE_DIR/pnpm-lock.yaml"
  if [ "$TOUCH_SETTINGS" = 1 ]; then
    printf 'model: prepared-choice\n' > "$PROFILE_DIR/settings.yaml"
  fi
  printf 'patch: prepared\n' > "$PROFILE_DIR/device-patches/host.yaml"
  printf 'module.exports = "prepared"\n' > "$PROFILE_DIR/node_modules/pkg/index.js"
  printf 'export const v = "prepared"\n' > "$PROFILE_DIR/packages/enpoi-demo/lib/index.js"
}
do_update
`, { ...f.env, TOUCH_SETTINGS: touchSettings ? '1' : '0' })
}

function runApplyPhase(f: PrepareRollbackFixture, options: { selfcheckFails?: boolean; healthFails?: boolean } = {}): LibResult {
  const selfcheckFails = options.selfcheckFails ?? true
  const healthFails = options.healthFails ?? false
  return runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; CHANNEL=beta; PROFILE=web
PROFILE_DIR="$PROFILE_DIR_VAL"; SERVICE_UNIT=""
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
init_log_file() { :; }
run_marker_phase() { :; }
restart_service() { :; }
run_backfill() { :; }
running_under_service() { return 1; }
selfcheck() {
  if [ "$FAIL_SELFTEST" = 1 ] && [ "$(basename "$HARNESS")" = "$NEXT_VER" ]; then
    return 1
  fi
  return 0
}
health_proof_robust() {
  if [ "$FAIL_HEALTH" = 1 ]; then
    return 1
  fi
  return 0
}
prune_versions() { :; }
prune_update_artifacts() { :; }
write_diagnostics() { :; }
emit_json() { :; }
do_apply_staged "$PREVIOUS"
`, { ...f.env, FAIL_SELFTEST: selfcheckFails ? '1' : '0', FAIL_HEALTH: healthFails ? '1' : '0' })
}

interface StagedBackupRecord {
  version: string
  treeDirName: string
  preparedAt: string
  backupDir: string
  profileDir: string
  files: Array<{ path: string; sha256: string; existed?: boolean }>
}

describe.skipIf(win32)('two-phase prepare-state backup and selective rollback', () => {
  it('records pre-prepare backup + sha256 of changed profile files and restores them on post-switch apply failure (idempotently)', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: false })
    expect(prep.status, prep.stderr).toBe(0)

    const stagedRecord = JSON.parse(readFileSync(join(f.prefix, 'harness', '.staged-apply.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(stagedRecord).sort()).toEqual(['channel', 'prebuilt', 'preparedAt', 'releaseCommit', 'treeDirName', 'version'])

    const backupRecordPath = join(f.prefix, 'harness', '.staged-apply-backup.json')
    expect(existsSync(backupRecordPath)).toBe(true)
    const backupRecord = JSON.parse(readFileSync(backupRecordPath, 'utf8')) as StagedBackupRecord
    expect(existsSync(backupRecord.backupDir)).toBe(true)
    expect(backupRecord.version).toBe(f.next)
    expect(backupRecord.treeDirName).toBe(f.next)
    const recordedPaths = backupRecord.files.map(entry => entry.path).sort()
    expect(recordedPaths).toEqual([
      join(f.profileDir, 'cordis.patch.yml'),
      join(f.profileDir, 'device-patches/host.yaml'),
      join(f.profileDir, 'package.json'),
      join(f.profileDir, 'pnpm-lock.yaml'),
    ].sort())
    // Untouched settings.yaml is NOT listed when prepare did not change it.
    expect(recordedPaths).not.toContain(join(f.profileDir, 'settings.yaml'))
    expect(backupRecord.files.find(entry => entry.path.endsWith('cordis.patch.yml'))?.sha256).toBe(sha256Hex('- id: prepared-row\n'))

    const apply = runApplyPhase(f, { selfcheckFails: true })
    expect(apply.status).toBe(1)
    expect(readlinkSync(join(f.prefix, 'harness', 'current'))).toBe(f.prev)
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: old-row\n')
    expect(readFileSync(join(f.profileDir, 'package.json'), 'utf8')).toBe('{"name":"web","dependencies":{"old":"1.0.0"}}\n')
    expect(readFileSync(join(f.profileDir, 'pnpm-lock.yaml'), 'utf8')).toBe('lockfileVersion: 9.0\n# old\n')
    expect(readFileSync(join(f.profileDir, 'device-patches/host.yaml'), 'utf8')).toBe('patch: original\n')
    expect(readFileSync(join(f.profileDir, 'settings.yaml'), 'utf8')).toBe('model: original-choice\n')
    // When node_modules/plugin bundles are not in the backup, rollback prints the exact manual commands.
    expect(apply.stderr).toContain('pnpm install --prefer-offline --config.confirmModulesPurge=false')
    expect(apply.stderr).toContain('build-plugins.sh')

    // Idempotent second call under lock does not fail or emit false operator-modified warnings.
    const rerun = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; PROFILE_DIR="$PROFILE_DIR_VAL"
acquire_update_lock
restore_staged_profile_backup "$(staged_apply_backup_path)"
`, f.env)
    expect(rerun.status, rerun.stderr).toBe(0)
    expect(rerun.stderr).not.toContain('operator-modified')
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: old-row\n')
  })

  it('restores node_modules and plugin bundles from the recorded backup when present', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    const backupRecord = JSON.parse(readFileSync(join(f.prefix, 'harness', '.staged-apply-backup.json'), 'utf8')) as StagedBackupRecord
    const backupProfile = join(backupRecord.backupDir, 'root', f.profileDir.slice(1))
    write(backupProfile, 'node_modules/pkg/index.js', 'module.exports = "old"\n')
    write(backupProfile, 'packages/enpoi-demo/lib/index.js', 'export const v = "old"\n')

    const apply = runApplyPhase(f, { selfcheckFails: false, healthFails: true })
    expect(apply.status).toBe(1)
    expect(readFileSync(join(f.profileDir, 'node_modules/pkg/index.js'), 'utf8')).toBe('module.exports = "old"\n')
    expect(readFileSync(join(f.profileDir, 'packages/enpoi-demo/lib/index.js'), 'utf8')).toBe('export const v = "old"\n')
    expect(apply.stderr).not.toContain('was not included in')
  })

  it('preserves operator edits made after prepare and warns naming each file', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    // Operator edits settings.yaml and cordis.patch.yml after prepare; package.json stays as prepare wrote it.
    write(f.profileDir, 'settings.yaml', 'model: operator-choice-after-prepare\n')
    write(f.profileDir, 'cordis.patch.yml', '- id: operator-edited-row\n')

    const apply = runApplyPhase(f, { selfcheckFails: true })
    expect(apply.status).toBe(1)
    expect(readlinkSync(join(f.prefix, 'harness', 'current'))).toBe(f.prev)
    // Untouched prepared file is restored.
    expect(readFileSync(join(f.profileDir, 'package.json'), 'utf8')).toBe('{"name":"web","dependencies":{"old":"1.0.0"}}\n')
    // Operator-modified files are kept and warned by name.
    expect(readFileSync(join(f.profileDir, 'settings.yaml'), 'utf8')).toBe('model: operator-choice-after-prepare\n')
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: operator-edited-row\n')
    expect(apply.stderr).toContain(join(f.profileDir, 'settings.yaml'))
    expect(apply.stderr).toContain(join(f.profileDir, 'cordis.patch.yml'))
    expect(apply.stderr).toContain('operator')
  })

  it('restores nothing on the success path and removes both staged records', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    const apply = runApplyPhase(f, { selfcheckFails: false })
    expect(apply.status, apply.stderr).toBe(0)
    expect(readlinkSync(join(f.prefix, 'harness', 'current'))).toBe(f.next)
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: prepared-row\n')
    expect(readFileSync(join(f.profileDir, 'package.json'), 'utf8')).toBe('{"name":"web","dependencies":{"new":"2.0.0"}}\n')
    expect(readFileSync(join(f.profileDir, 'settings.yaml'), 'utf8')).toBe('model: prepared-choice\n')
    expect(existsSync(join(f.prefix, 'harness', '.staged-apply.json'))).toBe(false)
    expect(existsSync(join(f.prefix, 'harness', '.staged-apply-backup.json'))).toBe(false)
  })

  it('degrades safely with a clear message when the recorded backup directory is missing', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    const backupRecord = JSON.parse(readFileSync(join(f.prefix, 'harness', '.staged-apply-backup.json'), 'utf8')) as StagedBackupRecord
    rmSync(backupRecord.backupDir, { recursive: true, force: true })

    const apply = runApplyPhase(f, { selfcheckFails: true })
    expect(apply.status).toBe(1)
    expect(readlinkSync(join(f.prefix, 'harness', 'current'))).toBe(f.prev)
    expect(apply.stderr).toContain('missing')
    expect(apply.stderr).toContain(backupRecord.backupDir)
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: prepared-row\n')
  })

  it('refuses a staged backup record with a malformed hash field', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    const backupRecordPath = join(f.prefix, 'harness', '.staged-apply-backup.json')
    const backupRecord = JSON.parse(readFileSync(backupRecordPath, 'utf8')) as StagedBackupRecord
    backupRecord.files[0] = { path: backupRecord.files[0]!.path, sha256: 'not-a-valid-sha256-digest' }
    writeFileSync(backupRecordPath, `${JSON.stringify(backupRecord, null, 2)}\n`)

    const applyCli = runScript(['--update', '--apply', '--prefix', f.prefix, '--dsh-home', f.home])
    expect(applyCli.status).not.toBe(0)
    expect(applyCli.stderr).toContain('malformed')
    expect(readlinkSync(join(f.prefix, 'harness', 'current'))).toBe(f.prev)
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: prepared-row\n')

    const direct = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; PROFILE_DIR="$PROFILE_DIR_VAL"
acquire_update_lock
restore_staged_profile_backup "$(staged_apply_backup_path)"
`, f.env)
    expect(direct.status).not.toBe(0)
    expect(direct.stderr).toContain('malformed')
  })

  it('refuses staged profile restore when the update lock is not held', () => {
    const f = prepareRollbackFixture()
    const prep = runPreparePhase(f, { touchSettings: true })
    expect(prep.status, prep.stderr).toBe(0)

    const unlocked = runLib(String.raw`
PREFIX="$PREFIX_DIR"; DSH_HOME="$HOME_DIR"; NODE="$NODE_BIN"; PROFILE=web; PROFILE_DIR="$PROFILE_DIR_VAL"
UPDATE_LOCK_OWNED=0
restore_staged_profile_backup "$(staged_apply_backup_path)"
`, f.env)
    expect(unlocked.status).not.toBe(0)
    expect(unlocked.stderr).toContain('update lock')
    expect(readFileSync(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: prepared-row\n')
  })
})
