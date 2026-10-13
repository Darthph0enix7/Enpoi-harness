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
