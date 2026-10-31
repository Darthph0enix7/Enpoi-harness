/**
 * Installer update policy: published releases are the only automatic artifact.
 *
 * Every branch is exercised through the real `prepare_source` / `stage_prebuilt`
 * code with a stubbed curl, git, and pnpm:
 *   - channel head ahead of the newest release -> prebuilt path, no source build,
 *     no pnpm invocation (the live 2.109 -> 2.112 regression);
 *   - no published release -> hard error naming --source, never a silent build;
 *   - a release without this platform's asset -> hard error, never a fallback;
 *   - explicit SOURCE= -> the source path still works.
 *
 * The fixtures live under unique mkdtemp roots; no real network is used.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const win32 = process.platform === 'win32'
const cleanups: string[] = []

const RELEASE_VERSION = '0.1.7-enpoi.2.112'
const RELEASE_BASE = '0.1.7-enpoi.2'
const RELEASE_COMMIT = '8addce3848920000000000000000000000000000'
const HEAD_COMMIT = 'e0acea916b650000000000000000000000000000'
const AHEAD_BY = 3

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-policy-'))
  cleanups.push(dir)
  return dir
}

function write(file: string, content: string, mode = 0o644): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

interface Fixture {
  readonly root: string
  readonly tarball: string
  readonly shaFile: string
  readonly stubBin: string
  readonly pnpmLog: string
  readonly releaseUrl: string
}

/** A real prebuilt tarball (tree base version) plus curl/git/pnpm stubs. */
function releaseFixture(): Fixture {
  const root = scratch()
  const treeTop = join(root, 'stage-tree', `dsh-harness-${RELEASE_VERSION}`)
  write(join(treeTop, 'package.json'), JSON.stringify({ name: 'dsh-harness', version: RELEASE_BASE }))
  write(join(treeTop, 'PRESENT'), 'prebuilt\n')

  const tarball = join(root, 'asset.tar.gz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', join(root, 'stage-tree'), `dsh-harness-${RELEASE_VERSION}`], {
    encoding: 'utf8',
  })
  if (packed.status !== 0) throw new Error(`tar failed: ${packed.stderr}`)
  const sha = crypto.createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const shaFile = join(root, 'asset.sha256')
  writeFileSync(shaFile, `${sha}  dsh-harness-${RELEASE_VERSION}-linux-x64.tar.gz\n`)

  const stubBin = join(root, 'bin')
  write(join(stubBin, 'curl'), [
    '#!/bin/sh',
    'out=""; url=""; want_redirect=0; want_headers=0',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2;;',
    '    -w) case "$2" in *redirect_url*) want_redirect=1;; esac; shift 2;;',
    '    -D) [ "$2" = "-" ] && want_headers=1; shift 2;;',
    '    -C|--retry|--retry-delay|--connect-timeout|--speed-limit|--speed-time|--max-time|--range) shift 2;;',
    '    -*) shift;;',
    '    *) url="$1"; shift;;',
    '  esac',
    'done',
    'case "$url" in',
    '  */releases/latest)',
    '    if [ "$want_redirect" = 1 ]; then printf "%s\\n" "$FAKE_RELEASE_URL"; fi',
    '    exit 0;;',
    '  *api.github.com/repos/*/compare/*)',
    '    printf \'{"ahead_by": %s}\\n\' "${FAKE_AHEAD:-3}"',
    '    exit 0;;',
    '  *.sha256)',
    '    if [ -n "$out" ]; then cp "$FAKE_SHA_FILE" "$out"; fi',
    '    exit 0;;',
    '  *.tar.gz)',
    '    if [ "$want_headers" = 1 ]; then printf "content-range: bytes 0-0/1024\\n%s" "${FAKE_PROBE_STATUS:-200}"; exit 0; fi',
    '    if [ -n "$out" ]; then cp "$FAKE_TARBALL" "$out"; fi',
    '    exit 0;;',
    '  */archive/*)',
    '    printf "unexpected source archive fetch\\n" >&2',
    '    exit 1;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'), 0o755)
  write(join(stubBin, 'git'), [
    '#!/bin/sh',
    'ref=""',
    'for arg in "$@"; do',
    '  case "$arg" in refs/heads/*|refs/tags/*) ref="$arg";; esac',
    'done',
    'case "$ref" in',
    '  refs/heads/stable) printf "%s\\t%s\\n" "$FAKE_HEAD_COMMIT" "$ref"; exit 0;;',
    '  refs/tags/*) printf "%s\\t%s\\n" "$FAKE_RELEASE_COMMIT" "$ref"; exit 0;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'), 0o755)
  const pnpmLog = join(root, 'pnpm.log')
  write(join(stubBin, 'pnpm'), ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$PNPM_LOG"', 'exit 0', ''].join('\n'), 0o755)

  return {
    root,
    tarball,
    shaFile,
    stubBin,
    pnpmLog,
    releaseUrl: `https://github.com/example/repo/releases/tag/v${RELEASE_VERSION}`,
  }
}

interface LibResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Source the installer as a library and run one bash body. */
function runLib(body: string, env: Record<string, string>): LibResult {
  const root = scratch()
  const script = write(join(root, 'probe.sh'), ['set -u', 'export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" >/dev/null 2>&1', body, ''].join('\n'))
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, INSTALL_SH: installSh, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The shared prebuilt probe preamble (everything prepare_source needs). */
function prepareBody(extra = ''): string {
  return [
    'NODE="$NODE_BIN"',
    'PREFIX="$PREFIX_DIR"',
    'OS=linux',
    'ARCH=x64',
    'CHANNEL=stable',
    'DSH_GITHUB_URL=https://github.com/example/repo',
    'DSH_GITHUB_REPO=example/repo',
    'LOG_FILE="$LOG_FILE_VALUE"',
    'VERBOSE=1',
    'PATH="$STUB_BIN:$PATH"',
    'PNPM="$STUB_BIN/pnpm"',
    'resolve_fast_downloader() { return 1; }',
    extra,
    'prepare_source; rc=$?',
    'printf "PREPARE_RC=%s VERSION=%s PREBUILT=%s TAG=%s\\n" "$rc" "$VERSION" "$PREBUILT" "$PREBUILT_TAG"',
    'if [ "$rc" = 0 ] && [ "${SKIP_INSTALL:-0}" != 1 ]; then',
    '  install_tree; rc2=$?',
    '  printf "INSTALL_RC=%s\\n" "$rc2"',
    'fi',
  ].join('\n')
}

function baseEnv(fixture: Fixture, prefix: string, logFile: string): Record<string, string> {
  return {
    NODE_BIN: process.execPath,
    PREFIX_DIR: prefix,
    STUB_BIN: fixture.stubBin,
    LOG_FILE_VALUE: logFile,
    PNPM_LOG: fixture.pnpmLog,
    FAKE_RELEASE_URL: fixture.releaseUrl,
    FAKE_TARBALL: fixture.tarball,
    FAKE_SHA_FILE: fixture.shaFile,
    FAKE_RELEASE_COMMIT: RELEASE_COMMIT,
    FAKE_HEAD_COMMIT: HEAD_COMMIT,
    FAKE_AHEAD: String(AHEAD_BY),
    DSH_NO_PREBUILT: '0',
    DSH_RELEASE_TAG: '',
    SOURCE: '',
  }
}

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(win32)('prebuilt-only update policy', () => {
  it('installs the newest published release when the channel head is ahead (no source build)', () => {
    const fixture = releaseFixture()
    const prefix = join(fixture.root, 'prefix')
    const logFile = join(fixture.root, 'install.log')
    // The operator's failed 416 s prepare left a complete source tree at the
    // channel head. It must not win over the published release.
    const staleTree = join(prefix, 'harness', `${RELEASE_BASE}+g${HEAD_COMMIT.slice(0, 7)}`)
    write(join(staleTree, 'package.json'), JSON.stringify({ version: RELEASE_BASE }))
    write(join(staleTree, '.dsh-install-complete'), `${JSON.stringify({
      version: `${RELEASE_BASE}+g${HEAD_COMMIT.slice(0, 7)}`,
      commit: HEAD_COMMIT,
      installedAt: '2026-01-01T00:00:00Z',
    })}\n`)
    const result = runLib(prepareBody(), baseEnv(fixture, prefix, logFile))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`PREPARE_RC=0 VERSION=${RELEASE_VERSION} PREBUILT=1 TAG=v${RELEASE_VERSION}`)
    expect(result.stdout).toContain('INSTALL_RC=0')
    // The head-ahead fact is one informational line, never a fallback trigger.
    expect(readFileSync(logFile, 'utf8')).toContain(
      `stable head is ahead of v${RELEASE_VERSION} by ${AHEAD_BY} commits; installing the newest published release v${RELEASE_VERSION}`,
    )
    // No source build: neither pnpm nor the channel archive was touched.
    expect(existsSync(fixture.pnpmLog)).toBe(false)
    expect(result.stderr).not.toContain('unexpected source archive fetch')
    // The head tree is not reused; the verified prebuilt tree is installed.
    expect(readFileSync(logFile, 'utf8')).not.toContain('Target build already complete')
    expect(existsSync(staleTree)).toBe(true)
    const tree = join(prefix, 'harness', RELEASE_VERSION)
    expect(existsSync(join(tree, 'PRESENT'))).toBe(true)
    expect(existsSync(join(tree, '.dsh-install-complete'))).toBe(true)
    expect(readFileSync(join(tree, '.dsh-install-complete'), 'utf8')).toContain(RELEASE_COMMIT)
  })

  it('fails with publish/--source guidance when the channel has no published release', () => {
    const fixture = releaseFixture()
    const prefix = join(fixture.root, 'prefix')
    const result = runLib(prepareBody(), {
      ...baseEnv(fixture, prefix, join(fixture.root, 'install.log')),
      FAKE_RELEASE_URL: '',
      FAKE_HEAD_COMMIT: HEAD_COMMIT,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no published release on the stable channel')
    expect(result.stderr).toContain('--source <dir|tarball|url>')
    expect(result.stderr).not.toContain('unexpected source archive fetch')
    expect(existsSync(fixture.pnpmLog)).toBe(false)
  })

  it('fails instead of source-building when the release has no asset for this platform', () => {
    const fixture = releaseFixture()
    const prefix = join(fixture.root, 'prefix')
    const result = runLib(prepareBody(), {
      ...baseEnv(fixture, prefix, join(fixture.root, 'install.log')),
      FAKE_PROBE_STATUS: '404',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`newest published release v${RELEASE_VERSION}`)
    expect(result.stderr).toContain('source builds are disabled')
    expect(result.stderr).toContain('--source <dir|tarball|url>')
    expect(result.stderr).not.toContain('unexpected source archive fetch')
    expect(existsSync(fixture.pnpmLog)).toBe(false)
  })

  it('does not reuse a source recorded in install-state for a plain update', () => {
    const root = scratch()
    const state = join(root, 'install-state.json')
    write(state, `${JSON.stringify({ source: '/srv/src' })}\n`)
    const logFile = join(root, 'install.log')
    const result = runLib([
      'NODE="$NODE_BIN"',
      'LOG_FILE="$LOG_FILE_VALUE"',
      'SOURCE=""',
      'load_update_source "$STATE_FILE"',
      'printf "A=[%s] I=[%s]\\n" "$SOURCE" "$RECORDED_SOURCE_IGNORED"',
      'report_ignored_source',
      'SOURCE=/explicit',
      'load_update_source "$STATE_FILE"',
      'printf "B=[%s]\\n" "$SOURCE"',
    ].join('\n'), { STATE_FILE: state, LOG_FILE_VALUE: logFile, NODE_BIN: process.execPath })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('A=[] I=[/srv/src]')
    expect(result.stdout).toContain('B=[/explicit]')
    expect(readFileSync(logFile, 'utf8')).toContain("recorded source '/srv/src' is not reused")
    expect(readFileSync(logFile, 'utf8')).toContain('--source')
  })

  it('still takes an explicit SOURCE=<dir> build', () => {
    const fixture = releaseFixture()
    const sourceDir = join(fixture.root, 'explicit-source')
    write(join(sourceDir, 'package.json'), JSON.stringify({ name: 'dsh-harness', version: RELEASE_BASE }))
    const result = runLib(prepareBody('SOURCE="$SOURCE_DIR"'), {
      ...baseEnv(fixture, join(fixture.root, 'prefix'), join(fixture.root, 'install.log')),
      SOURCE_DIR: sourceDir,
      FAKE_RELEASE_URL: '',
      SKIP_INSTALL: '1',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`PREPARE_RC=0 VERSION=${RELEASE_BASE} PREBUILT=0 TAG=`)
  })
})
