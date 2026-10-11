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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
