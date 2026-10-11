/**
 * scripts/install.sh delta apply path — scratch-prefix E2E and drills.
 *
 * Every case builds synthetic releases (trees, manifests, tarballs, and diff
 * archives via scripts/release-delta.mjs), serves them from an in-process HTTP
 * fixture server that stands in for GitHub Releases, seeds a scratch $PREFIX
 * with a v1 install and user modifications, and runs the real updater
 * (`scripts/install.sh --update`) against it. The live install is never
 * touched: every path lives under a unique mkdtemp root.
 *
 * Drills: interruption/resume (engine stopAfterActions), corrupt diff (wrong
 * hash and bad gzip), network sever during download, channel-style full
 * fallback beyond three hops, atomic switch, retention GC, and rollback after
 * the switch.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { engineBundle, repoRoot, tarTree, writeSha256Sidecar } from './update-delta-fixtures.ts'
import type { ReleaseManifestDocument } from './release-delta.d.mts'
import { buildManifest, manifestDocument, writeDiff, writeManifest } from './release-delta.mjs'

const win32 = process.platform === 'win32'
const platform = `${process.platform}-${process.arch}`
const installSh = join(repoRoot, 'scripts', 'install.sh')

const STUB_CLI = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  // The real CLI reports the active tree's recorded identity; mirror that so
  // tests can compare dsh --version with the updater's resolver.
  let version = 'unknown'
  try {
    const root = path.resolve(__dirname, '..', '..', '..')
    version = JSON.parse(fs.readFileSync(path.join(root, '.dsh-install-complete'), 'utf8')).version
  } catch {}
  console.log(version)
  process.exit(0)
}
process.exit(0)
`

const cleanups: string[] = []
const servers: http.Server[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-e2e-'))
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

const VERSION_LINES = ['FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT']

/** Shipped core file for one version: every version appends one more line. */
function versionCore(version: string): string {
  const lines = ['core', 'line2', 'line3']
  for (let index = 0; index < Number(version) - 1 && index < VERSION_LINES.length; index += 1) lines.push(VERSION_LINES[index]!)
  return `${lines.join('\n')}\n`
}

/** Shipped both-changed config for one version: every version appends a key. */
function versionBoth(version: string): string {
  return version === '1' ? 'x: 1\ny: 2\n' : `x: 1\ny: 2\nz: ${version}\n`
}

function releaseFiles(version: string): Record<string, { content: string; mode?: number }> {
  const first = version === '1'
  const files: Record<string, { content: string; mode?: number }> = {
    'package.json': { content: `{"version":"${version}"}\n` },
    'apps/cli/lib/bin.js': { content: STUB_CLI, mode: 0o755 },
    'core/app.js': { content: versionCore(version) },
    'cfg/app.yaml': { content: 'a: 1\nb: 2\n' },
    'cfg/stable.yaml': { content: 'stable: true\n' },
    'cfg/both.yaml': { content: versionBoth(version) },
    'docs/keep.txt': { content: first ? 'shipped v1\n' : `shipped ${version}\n` },
    'docs/pinme.txt': { content: first ? 'pin v1\n' : `pin ${version}\n` },
    'docs/remove.txt': { content: first ? 'gone v1\n' : `gone ${version}\n` },
    'docs/lost.txt': { content: first ? 'lost v1\n' : `lost ${version}\n` },
    'node_modules/pkg/index.js': { content: first ? 'A\nB\nC\n' : 'A\nB\nC\nNEW\n' },
    'node_modules/@fixture/pkg/index.js': { content: first ? 'A\nB\nC\n' : 'A\nB\nC\nNEW\n' },
    'modefile.txt': { content: 'same\n', mode: first ? 0o644 : 0o755 },
  }
  if (!first) {
    files['collide.txt'] = { content: 'shipped collide\n' }
    files['docs/added.txt'] = { content: 'added in v2\n' }
  }
  return files
}

interface FixtureOptions {
  versions?: string[]
  installed?: string
  target?: string
  /**
   * Releases the server publishes initially; `server.publish(version)`
   * exposes a later one, which is how successive delta hops are simulated
   * (a real device updates to whatever release is newest at that moment).
   */
  visible?: string[]
  /** Per-version tree mutation applied before manifests, diffs, and tarballs are built. */
  mutate?: (version: string, tree: string) => void
}

interface Fixture {
  root: string
  prefix: string
  home: string
  binDir: string
  trees: Map<string, string>
  assets: Map<string, Buffer>
  server: { base: string; close: () => Promise<void>; failures: Map<string, string>; publish: (version: string) => void }
  fullName: (version: string) => string
  manifestName: (version: string) => string
  diffName: (from: string, to: string) => string
  installed: string
  target: string
}

async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const versions = options.versions ?? ['1', '2']
  const installed = options.installed ?? versions[0]!
  const target = options.target ?? versions[versions.length - 1]!
  const root = scratch()
  const work = join(root, 'work')
  const treeRoot = join(work, 'trees')
  const assetsDir = join(work, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  const bundle = bundleOnce()

  const trees = new Map<string, string>()
  for (const version of versions) {
    const tree = join(treeRoot, version)
    for (const [rel, spec] of Object.entries(releaseFiles(version))) write(tree, rel, spec.content, spec.mode ?? 0o644)
    // The engine ships inside the release tree (production shape).
    const engineDir = join(tree, 'packages/host/update-engine/lib')
    mkdirSync(engineDir, { recursive: true })
    cpSync(bundle, join(engineDir, 'index.js'))
    options.mutate?.(version, tree)
    trees.set(version, tree)
  }

  const assets = new Map<string, Buffer>()
  const fullName = (version: string): string => `dsh-harness-${version}-${platform}.tar.gz`
  const manifestName = (version: string): string => `manifest-${platform}-${version}.json.gz`
  const diffName = (from: string, to: string): string => `diff-${platform}-${from}-${to}.tar.gz`

  const docs = new Map<string, ReleaseManifestDocument>()
  for (const version of versions) {
    const tree = trees.get(version)!
    const manifestFile = join(assetsDir, manifestName(version))
    writeManifest({ tree, platform, version, out: manifestFile })
    docs.set(version, JSON.parse(manifestDocument(buildManifest(tree), version, platform)) as ReleaseManifestDocument)
    const fullFile = join(assetsDir, fullName(version))
    tarTree(tree, fullFile)
    writeSha256Sidecar(fullFile)
    const tag = `v${version}`
    assets.set(`${tag}/${manifestName(version)}`, readFileSync(manifestFile))
    assets.set(`${tag}/${manifestName(version)}.sha256`, readFileSync(`${manifestFile}.sha256`))
    assets.set(`${tag}/${fullName(version)}`, readFileSync(fullFile))
    assets.set(`${tag}/${fullName(version)}.sha256`, readFileSync(`${fullFile}.sha256`))
  }
  for (let index = 0; index + 1 < versions.length; index += 1) {
    const from = versions[index]!
    const to = versions[index + 1]!
    const out = join(assetsDir, diffName(from, to))
    writeDiff({ tree: trees.get(to)!, oldManifest: docs.get(from)!, newManifest: docs.get(to)!, platform, from, to, out })
    // Each diff asset is published on the release it updates to.
    assets.set(`v${to}/${diffName(from, to)}`, readFileSync(out))
    assets.set(`v${to}/${diffName(from, to)}.sha256`, readFileSync(`${out}.sha256`))
  }

  // Scratch install prefix.
  const prefix = join(root, 'prefix')
  const home = join(root, 'home')
  const binDir = join(root, 'bin')
  mkdirSync(join(prefix, 'harness'), { recursive: true })
  mkdirSync(join(prefix, 'harness', '.cache'), { recursive: true })
  mkdirSync(join(prefix, 'runtime'), { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  // A pnpm stub makes setup_pnpm a no-op; this flow never runs pnpm.
  write(binDir, 'pnpm', '#!/bin/sh\nexit 0\n', 0o755)

  const installedTree = join(prefix, 'harness', installed)
  cpSync(trees.get(installed)!, installedTree, { recursive: true })
  write(installedTree, '.dsh-install-complete', `{"version": "${installed}", "commit": "0000000000000000000000000000000000000000", "installedAt": "2026-01-01T00:00:00Z"}\n`)
  symlinkSync(installed, join(prefix, 'harness', 'current'))

  // The installed version's full release archive is the pristine merge base.
  const cacheArchive = join(prefix, 'harness', '.cache', fullName(installed))
  cpSync(join(assetsDir, fullName(installed)), cacheArchive)
  cpSync(`${join(assetsDir, fullName(installed))}.sha256`, `${cacheArchive}.sha256`)

  // User modifications: edited core file, added files/plugins/skills, deleted
  // paths (one tombstoned), an untracked collision, and a user pnpm patch.
  write(installedTree, 'core/app.js', 'core\nUSER\nline2\nline3\n')
  write(installedTree, 'cfg/stable.yaml', 'stable: user\n')
  write(installedTree, 'cfg/both.yaml', 'x: LOCAL\ny: 2\n')
  write(installedTree, 'user/notes.txt', 'notes\n')
  write(installedTree, 'profiles/web/packages/my-plugin/package.json', '{"name":"my-plugin"}\n')
  write(installedTree, 'skills/my-skill/SKILL.md', '# my skill\n')
  write(installedTree, 'collide.txt', 'user collide\n')
  rmSync(join(installedTree, 'docs/lost.txt'))
  rmSync(join(installedTree, 'docs/remove.txt'))
  write(home, 'update/pins.yaml', 'paths:\n  - docs/pinme.txt\n')
  write(home, 'update/tombstones.txt', 'docs/remove.txt\n')
  // A quoted scoped key (the shape pnpm writes for scoped packages) plus the
  // plain form: both must resolve to their node_modules directories.
  write(installedTree, 'pnpm-workspace.yaml', 'patchedDependencies:\n  pkg: patches/pkg.patch\n  \'@fixture/pkg\': patches/scoped.patch\n')
  write(installedTree, 'patches/scoped.patch', [
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1,3 +1,3 @@',
    '-A',
    '+A-scoped',
    ' B',
    ' C',
    '',
  ].join('\n'))
  write(installedTree, 'patches/pkg.patch', [
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1,3 +1,3 @@',
    '-A',
    '+A-patched',
    ' B',
    ' C',
    '',
  ].join('\n'))

  // Retention material: older complete version dirs that must be GC'd beyond K.
  const oldTime = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  for (const [index, name] of ['old-a', 'old-b', 'old-c', 'old-d'].entries()) {
    const dir = join(prefix, 'harness', name)
    mkdirSync(dir, { recursive: true })
    write(dir, '.dsh-install-complete', `{"version": "${name}", "commit": "", "installedAt": "2026-01-01T00:00:00Z"}\n`)
    const stamp = new Date(oldTime.getTime() - index * 3600 * 1000)
    utimesSync(dir, stamp, stamp)
  }
  // Retained merge-base slots: old-a follows its kept version; old-b and the
  // version-less ghost must be GC'd by the retention/orphan sweep.
  mkdirSync(join(prefix, 'harness', '.bases'), { recursive: true })
  for (const name of ['old-a', 'old-b', 'ghost']) {
    const slot = join(prefix, 'harness', '.bases', `${name}.tar`)
    writeFileSync(slot, `not a real archive: ${name}\n`)
    writeFileSync(`${slot}.sha256`, `${sha256Bytes(readFileSync(slot))}  ${name}.tar\n`)
  }

  write(prefix, 'harness/install-state.json', `${JSON.stringify({
    prefix,
    version: installed,
    harnessDir: installed,
    commit: '0000000000000000000000000000000000000000',
    channel: 'stable',
    ref: 'stable',
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
    pnpm: join(binDir, 'pnpm'),
    serviceUnit: null,
    serviceInstall: false,
    updatedAt: '2026-01-01T00:00:00Z',
  }, null, 2)}\n`)

  const server = await startFixtureServer(assets, [...(options.visible ?? versions)])
  servers.push(server.http)
  return {
    root,
    prefix,
    home,
    binDir,
    trees,
    assets,
    server: { base: server.base, close: server.close, failures: server.failures, publish: server.publish },
    fullName,
    manifestName,
    diffName,
    installed,
    target,
  }
}

interface ServerHandle {
  http: http.Server
  base: string
  failures: Map<string, string>
  /** Expose one more release as newest (successive-hop simulation). */
  publish: (version: string) => void
  close: () => Promise<void>
}

function startFixtureServer(assets: Map<string, Buffer>, visibleVersions: string[]): Promise<ServerHandle> {
  const failures = new Map<string, string>()
  const state: { base: string; visible: string[] } = { base: '', visible: [...visibleVersions] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/releases/latest') {
      const latest = state.visible[state.visible.length - 1]
      res.writeHead(302, { Location: `${state.base}/releases/tag/v${latest}` })
      res.end()
      return
    }
    if (url.pathname.includes('/repos/') && url.pathname.endsWith('/releases')) {
      const list = [...state.visible].reverse().map((version, index) => {
        const tag = `v${version}`
        const names = [...assets.keys()].filter(key => key.startsWith(`${tag}/`)).map(key => key.slice(tag.length + 1))
        return {
          tag_name: tag,
          draft: false,
          prerelease: false,
          created_at: new Date(Date.parse('2026-01-01T00:00:00Z') - index * 1000).toISOString(),
          assets: names.map(name => ({
            name,
            size: assets.get(`${tag}/${name}`)?.length ?? 0,
            browser_download_url: `${state.base}/releases/download/${tag}/${name}`,
          })),
        }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(list))
      return
    }
    const match = /^\/releases\/download\/(v[^/]+)\/(.+)$/.exec(url.pathname)
    if (match !== null) {
      const key = `${match[1]}/${match[2]}`
      const name = match[2]!
      const file = assets.get(key)
      if (file === undefined) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const isSidecar = name.endsWith('.sha256')
      const failure = failures.get(isSidecar ? name.slice(0, -'.sha256'.length) : name)
      if (failure === 'sever') {
        if (req.method === 'HEAD') {
          res.writeHead(500)
          res.end()
          return
        }
        res.writeHead(200, { 'content-length': String(file.length) })
        res.write(Buffer.from(file.subarray(0, Math.max(1, Math.floor(file.length / 2)))))
        res.destroy()
        return
      }
      let body = file
      if (!isSidecar && (failure === 'corrupt-bytes' || failure === 'badgzip')) {
        body = failure === 'badgzip' ? Buffer.from('this is not a gzip stream') : Buffer.from('corrupted payload that is not the artifact')
      }
      if (isSidecar && failure === 'badgzip') {
        // A bad gzip with a *valid* hash: the sidecar must describe the corrupt
        // bytes so the download passes verification and extraction refuses it.
        const base = name.slice(0, -'.sha256'.length)
        const corrupt = Buffer.from('this is not a gzip stream')
        body = Buffer.from(`${sha256Bytes(corrupt)}  ${base}\n`)
      }
      const range = typeof req.headers.range === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) : null
      if (range !== null) {
        const start = Number(range[1])
        const end = Math.min(Number(range[2]), body.length - 1)
        res.writeHead(206, {
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'accept-ranges': 'bytes',
        })
        res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { 'content-length': String(body.length), 'accept-ranges': 'bytes' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      state.base = `http://127.0.0.1:${port}`
      resolve({
        http: server,
        base: state.base,
        failures,
        publish: (version: string) => { if (!state.visible.includes(version)) state.visible.push(version) },
        close: () => new Promise<void>((done) => { server.close(() => { done() }) }),
      })
    })
  })
}

function sha256Bytes(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

interface UpdateResult {
  status: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

async function runUpdate(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
  options: { json?: boolean } = {},
): Promise<UpdateResult> {
  // The fixture server lives in this process, so the updater must run
  // asynchronously: a blocking spawnSync would starve the event loop and every
  // HTTP request would time out.
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('bash', [
      installSh,
      '--update',
      '--prefix', fixture.prefix,
      '--dsh-home', fixture.home,
      '--bin-dir', fixture.binDir,
      '--channel', 'stable',
      ...(options.json === false ? [] : ['--json']),
      ...extraArgs,
    ], {
      env: {
        ...process.env,
        DSH_GITHUB_URL: fixture.server.base,
        DSH_GITHUB_REPO: 'fixture/repo',
        DSH_NO_TAILNET: '1',
        DSH_DELTA_FETCH_TIMEOUT: '30',
        DSH_PREBUILT_TIMEOUT: '60',
        DSH_PROGRESS_INTERVAL: '60',
        ...extraEnv,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (status) => { resolve({ status, stdout, stderr }) })
  })
  const lines = result.stdout.trim().split('\n')
  let json: Record<string, unknown> | null = null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('{')) continue
    try {
      json = JSON.parse(line) as Record<string, unknown>
      break
    } catch {
      // keep looking
    }
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json }
}

interface TimedLine {
  at: number
  text: string
}

/** Like runUpdate, but timestamps every stderr line for gap analysis. */
async function runUpdateTimed(
  fixture: Fixture,
  extraEnv: Record<string, string> = {},
  extraArgs: string[] = [],
): Promise<{ status: number | null; stderr: string; lines: TimedLine[] }> {
  return await new Promise((resolve) => {
    const child = spawn('bash', [
      installSh,
      '--update',
      '--prefix', fixture.prefix,
      '--dsh-home', fixture.home,
      '--bin-dir', fixture.binDir,
      '--channel', 'stable',
      ...extraArgs,
    ], {
      env: {
        ...process.env,
        DSH_GITHUB_URL: fixture.server.base,
        DSH_GITHUB_REPO: 'fixture/repo',
        DSH_NO_TAILNET: '1',
        DSH_DELTA_FETCH_TIMEOUT: '30',
        DSH_PREBUILT_TIMEOUT: '60',
        DSH_PROGRESS_INTERVAL: '60',
        ...extraEnv,
      },
    })
    const lines: TimedLine[] = []
    let stderr = ''
    let buffered = ''
    const take = (chunk: Buffer): void => {
      stderr += chunk.toString()
      buffered += chunk.toString()
      let index = buffered.indexOf('\n')
      while (index !== -1) {
        const text = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        if (text.trim() !== '') lines.push({ at: Date.now(), text })
        index = buffered.indexOf('\n')
      }
    }
    child.stderr.on('data', take)
    child.stdout.on('data', () => { /* stdout is the JSON object; not timed */ })
    child.on('close', (status) => {
      if (buffered.trim() !== '') lines.push({ at: Date.now(), text: buffered })
      resolve({ status, stderr, lines })
    })
  })
}

/** Spawn an update, wait for a stderr line, then SIGINT the whole group. */
async function runUpdateUntilLine(
  fixture: Fixture,
  needle: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stderr: string; signalled: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn('bash', [
      installSh,
      '--update',
      '--prefix', fixture.prefix,
      '--dsh-home', fixture.home,
      '--bin-dir', fixture.binDir,
      '--channel', 'stable',
    ], {
      detached: true,
      env: {
        ...process.env,
        DSH_GITHUB_URL: fixture.server.base,
        DSH_GITHUB_REPO: 'fixture/repo',
        DSH_NO_TAILNET: '1',
        DSH_DELTA_FETCH_TIMEOUT: '30',
        DSH_PREBUILT_TIMEOUT: '60',
        DSH_PROGRESS_INTERVAL: '60',
        ...extraEnv,
      },
    })
    let stderr = ''
    let signalled = false
    let buffered = ''
    const killTimer = setTimeout(() => {
      // The needle never appeared; end the run so the test can report.
      if (!signalled) { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }
    }, 60_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      buffered += chunk.toString()
      if (!signalled && buffered.includes(needle)) {
        signalled = true
        try { process.kill(-child.pid!, 'SIGINT') } catch { /* already gone */ }
      }
      buffered = buffered.slice(-4096)
    })
    child.stdout.on('data', () => { /* ignored */ })
    child.on('close', (status) => {
      clearTimeout(killTimer)
      resolve({ status, stderr, signalled })
    })
  })
}

function currentTarget(prefix: string): string {
  return readlinkSync(join(prefix, 'harness/current'))
}

function markerVersionAt(prefix: string, version: string): string {
  return (JSON.parse(readFileSync(join(prefix, 'harness', version, '.dsh-install-complete'), 'utf8')) as { version: string }).version
}

function markerVersion(prefix: string): string {
  return markerVersionAt(prefix, currentTarget(prefix))
}

function stateField(prefix: string, key: string): string {
  return (JSON.parse(readFileSync(join(prefix, 'harness', 'install-state.json'), 'utf8')) as Record<string, string>)[key] ?? ''
}

function writeStateField(prefix: string, key: string, value: unknown): void {
  const file = join(prefix, 'harness', 'install-state.json')
  const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  doc[key] = value
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
}

/** `dsh --version` through the generated shim (active tree identity). */
function dshVersion(fixture: Fixture): string {
  const result = spawnSync(join(fixture.binDir, 'dsh'), ['--version'], { encoding: 'utf8' })
  return (result.stdout ?? '').trim()
}

/** Numbered step headers parsed from update output (`[k/N] title`). */
function stepSequence(output: string): { index: number; total: number; title: string }[] {
  const steps: { index: number; total: number; title: string }[] = []
  for (const raw of output.split('\n')) {
    const match = /^\[(\d+)\/(\d+)\]\s+(.*)$/u.exec(raw.trim())
    if (match !== null) steps.push({ index: Number(match[1]), total: Number(match[2]), title: match[3] ?? '' })
  }
  return steps
}

/** util-linux `script` gives the child a pty (same probe as install-progress.spec). */
const ptyAvailable = process.platform !== 'win32'
  && spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf8', timeout: 10_000 }).status === 0

function completeVersions(prefix: string): string[] {
  return readdirSync(join(prefix, 'harness'))
    .filter(name => !name.startsWith('.') && name !== 'current' && !name.includes('.failed-'))
    .filter(name => existsSync(join(prefix, 'harness', name, '.dsh-install-complete')))
    .sort()
}

let bundlePath = ''

/** Build the engine bundle once per spec worker. */
function bundleOnce(): string {
  if (bundlePath === '') bundlePath = engineBundle(scratch())
  return bundlePath
}

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  // DSH_E2E_KEEP=1 keeps the scratch prefixes for post-mortem inspection.
  if (process.env.DSH_E2E_KEEP === '1') return
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(win32)('scratch-prefix delta update', () => {
  it('applies a rung-1 diff with the preservation net, atomic switch, and retention', async () => {
    const fixture = await buildFixture()
    const started = Date.now()
    const result = await runUpdate(fixture)
    const elapsedMs = Date.now() - started
    expect(result.status, result.stderr).toBe(0)
    expect(result.json?.ok).toBe(1)
    const update = result.json?.update as Record<string, unknown>
    expect(update.rung).toBe(1)
    expect(update.mode).toBe('delta')
    expect(update.verificationOk).toBe(true)
    expect(Number(update.downloadedBytes)).toBeGreaterThan(0)
    expect(Number(update.downloadedBytes)).toBeLessThan(Number(update.fullTarballBytes))
    const counts = update.counts as Record<string, number>
    expect(counts.merged).toBeGreaterThanOrEqual(1)
    expect(counts.keptLocal).toBeGreaterThanOrEqual(1)
    expect(counts.untracked).toBeGreaterThanOrEqual(3)
    expect(counts.pinned).toBe(1)
    expect(counts.restored).toBeGreaterThanOrEqual(1)
    expect(counts.conflicts).toBeGreaterThanOrEqual(1)

    // Atomic switch and marker; symlink, marker, state and the CLI agree.
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(markerVersion(fixture.prefix)).toBe('2')
    expect(stateField(fixture.prefix, 'version')).toBe('2')
    expect(stateField(fixture.prefix, 'harnessDir')).toBe('2')
    expect(dshVersion(fixture)).toBe('2')

    // Preservation: merged core edit, untracked file/plugin/skill, pinned and
    // tombstoned paths, collision sidecar, restored deletion.
    const v2 = join(fixture.prefix, 'harness/2')
    expect(readFileSync(join(v2, 'core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
    expect(readFileSync(join(v2, 'cfg/both.yaml'), 'utf8')).toBe('x: LOCAL\ny: 2\nz: 2\n')
    // The pristine base for the new version is retained for the next update.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar'))).toBe(true)
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar.sha256'))).toBe(true)
    const baseArchive = update.baseArchive as { path: string; bytes: number } | null
    expect(baseArchive?.path).toContain('.bases/2.tar')
    expect(baseArchive?.bytes ?? 0).toBeGreaterThan(0)
    expect(readFileSync(join(v2, 'user/notes.txt'), 'utf8')).toBe('notes\n')
    expect(readFileSync(join(v2, 'profiles/web/packages/my-plugin/package.json'), 'utf8')).toBe('{"name":"my-plugin"}\n')
    expect(readFileSync(join(v2, 'skills/my-skill/SKILL.md'), 'utf8')).toBe('# my skill\n')
    expect(readFileSync(join(v2, 'docs/pinme.txt'), 'utf8')).toBe('pin v1\n')
    expect(existsSync(join(v2, 'docs/remove.txt'))).toBe(false)
    expect(readFileSync(join(v2, 'docs/lost.txt'), 'utf8')).toBe('lost 2\n')
    expect(readFileSync(join(v2, 'docs/added.txt'), 'utf8')).toBe('added in v2\n')
    expect(readFileSync(join(v2, 'collide.txt'), 'utf8')).toBe('user collide\n')
    expect(readFileSync(join(v2, 'collide.txt.shipped-2'), 'utf8')).toBe('shipped collide\n')
    expect(readFileSync(join(v2, 'modefile.txt'), 'utf8')).toBe('same\n')
    expect(readFileSync(join(v2, 'cfg/stable.yaml'), 'utf8')).toBe('stable: user\n')

    // User patches applied to the fresh shipped node_modules (plain and
    // quoted-scoped keys both resolve).
    expect(readFileSync(join(v2, 'node_modules/pkg/index.js'), 'utf8')).toBe('A-patched\nB\nC\nNEW\n')
    expect(readFileSync(join(v2, 'node_modules/@fixture/pkg/index.js'), 'utf8')).toBe('A-scoped\nB\nC\nNEW\n')

    // Retention K=3: v2, v1, and exactly one older complete tree survive.
    const kept = completeVersions(fixture.prefix)
    expect(kept).toEqual(['1', '2', 'old-a'])

    // Engine report on disk (stable path, survives scratch cleanup).
    const reportFile = join(fixture.prefix, 'harness', '.last-update-2.json')
    expect(existsSync(reportFile)).toBe(true)
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { verification: { ok: boolean }; bytesWritten: number }
    expect(report.verification.ok).toBe(true)
    console.log(`[e2e] rung-1 delta: ${elapsedMs}ms, downloaded ${update.downloadedBytes} B vs full ${update.fullTarballBytes} B, written ${report.bytesWritten} B, base retained ${(baseArchive?.bytes ?? 0)} B`)
  }, 240_000)

  it('dry run reports the same ladder rung and writes nothing', async () => {
    const fixture = await buildFixture()
    const before = readdirSync(join(fixture.prefix, 'harness')).sort()
    const result = await runUpdate(fixture, {}, ['--dry-run'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.json?.dryRun).toBe(1)
    const inspection = result.json?.inspection as Record<string, unknown>
    const ladder = inspection.ladder as Record<string, unknown>
    expect(ladder.rung).toBe(1)
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(existsSync(join(fixture.prefix, 'harness/2'))).toBe(false)
    expect(readdirSync(join(fixture.prefix, 'harness')).sort()).toEqual(before)
  }, 240_000)

  it('interrupts mid-apply and resumes cleanly from the journal', async () => {
    const fixture = await buildFixture()
    const first = await runUpdate(fixture, { DSH_UPDATE_STOP_AFTER_ACTIONS: '5' })
    expect(first.status).not.toBe(0)
    expect(first.stderr).toContain('interrupted')
    expect(currentTarget(fixture.prefix)).toBe('1')
    // An interrupted apply never stamps the live tree.
    expect(markerVersionAt(fixture.prefix, '1')).toBe('1')
    expect(stateField(fixture.prefix, 'version')).toBe('1')
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2'))).toBe(true)
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2.journal.json'))).toBe(true)
    const second = await runUpdate(fixture)
    expect(second.status, second.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(markerVersion(fixture.prefix)).toBe('2')
    expect(readFileSync(join(fixture.prefix, 'harness/2/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2'))).toBe(false)
  }, 240_000)

  it('applies a two-hop rung-2 chain, fetching each hop from its own release', async () => {
    const fixture = await buildFixture({ versions: ['1', '2', '3'], installed: '1', target: '3' })
    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    const update = result.json?.update as Record<string, unknown>
    expect(update.rung).toBe(2)
    expect(update.kind).toBe('diff-chain')
    expect(update.mode).toBe('delta')
    expect(update.verificationOk).toBe(true)
    expect(currentTarget(fixture.prefix)).toBe('3')
    expect(readFileSync(join(fixture.prefix, 'harness/3/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\nFIVE\n')
    expect(readFileSync(join(fixture.prefix, 'harness/3/cfg/both.yaml'), 'utf8')).toBe('x: LOCAL\ny: 2\nz: 3\n')
    // The two-hop target's pristine base is synthesized from the verified tree.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/3.tar'))).toBe(true)
    expect(existsSync(join(fixture.prefix, 'harness/.bases/3.tar.sha256'))).toBe(true)
    // Both hops arrived: the v1->v2 hop's own change and the v2->v3 hop's.
    expect(readFileSync(join(fixture.prefix, 'harness/3/docs/keep.txt'), 'utf8')).toBe('shipped 3\n')
    expect(readFileSync(join(fixture.prefix, 'harness/3/docs/added.txt'), 'utf8')).toBe('added in v2\n')
  }, 240_000)

  it('aborts the switch on a runtime-code merge conflict and keeps the current tree active', async () => {
    // Conflicting adjacent edits to a shipped .js file: runtime-code severity
    // aborts the switch and parks the shipped merge attempt as a sidecar.
    const fixture = await buildFixture({
      mutate: (version, tree) => {
        if (version === '2') write(tree, 'core/app.js', 'core\nCHANGED\nline2\nline3\n')
      },
    })
    const result = await runUpdate(fixture)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ABORTED')
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(existsSync(join(fixture.prefix, 'harness/2'))).toBe(false)
    expect(existsSync(join(fixture.prefix, 'harness/1/core/app.js.new-2'))).toBe(true)
    expect(readFileSync(join(fixture.prefix, 'harness/1/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\n')
    // An aborted attempt must not retain a base for a version that is not installed.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar'))).toBe(false)
  }, 240_000)

  it('keeps a true merge base across consecutive delta hops', async () => {
    const fixture = await buildFixture({ versions: ['1', '2', '3'], installed: '1', visible: ['1', '2'] })
    const hop1 = await runUpdate(fixture)
    expect(hop1.status, hop1.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect((hop1.json?.update as Record<string, unknown>).rung).toBe(1)

    // The retained base for the first hop's version is pristine: shipped bytes
    // only, no user edits, no untracked files, no sidecars.
    const retained = join(fixture.prefix, 'harness/.bases/2.tar')
    expect(existsSync(retained)).toBe(true)
    expect(existsSync(`${retained}.sha256`)).toBe(true)
    const extracted = join(fixture.root, 'base-check')
    mkdirSync(extracted, { recursive: true })
    const untar = spawnSync('tar', ['-xf', retained, '-C', extracted], { encoding: 'utf8' })
    expect(untar.status, untar.stderr).toBe(0)
    expect(readFileSync(join(extracted, 'core/app.js'), 'utf8')).toBe(versionCore('2'))
    expect(readFileSync(join(extracted, 'cfg/both.yaml'), 'utf8')).toBe(versionBoth('2'))
    expect(existsSync(join(extracted, 'user/notes.txt'))).toBe(false)
    expect(existsSync(join(extracted, 'core/app.js.new-2'))).toBe(false)

    // Second hop: both-changed files must 3-way merge again, from the retained
    // base — not degrade to keep-local. Release 3 becomes newest only now.
    fixture.server.publish('3')
    const hop2 = await runUpdate(fixture)
    expect(hop2.status, hop2.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('3')
    const update = hop2.json?.update as Record<string, unknown>
    expect(update.rung).toBe(1)
    expect(update.mode).toBe('delta')
    expect(update.base).toBe('retained')
    expect(update.verificationOk).toBe(true)
    expect(readFileSync(join(fixture.prefix, 'harness/3/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\nFIVE\n')
    expect(readFileSync(join(fixture.prefix, 'harness/3/cfg/both.yaml'), 'utf8')).toBe('x: LOCAL\ny: 2\nz: 3\n')
    expect(existsSync(join(fixture.prefix, 'harness/.bases/3.tar'))).toBe(true)
    console.log(`[e2e] second hop: base=${String(update.base)} mode=${String(update.mode)} downloaded ${String(update.downloadedBytes)} B vs full ${String(update.fullTarballBytes)} B, merged ${String((update.counts as Record<string, number>).merged)}`)
  }, 240_000)

  it('degrades a both-changed config when the retained base is missing', async () => {
    const fixture = await buildFixture({ versions: ['1', '2', '3'], installed: '1', visible: ['1', '2'] })
    const hop1 = await runUpdate(fixture)
    expect(hop1.status, hop1.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
    // Only the config file stays both-changed: revert the runtime-code edit so
    // the missing base cannot abort the switch.
    write(join(fixture.prefix, 'harness/2'), 'core/app.js', versionCore('2'))
    rmSync(join(fixture.prefix, 'harness/.bases/2.tar'), { force: true })
    rmSync(join(fixture.prefix, 'harness/.bases/2.tar.sha256'), { force: true })

    fixture.server.publish('3')
    const hop2 = await runUpdate(fixture)
    expect(hop2.status, hop2.stderr).toBe(0)
    const update = hop2.json?.update as Record<string, unknown>
    expect(update.mode).toBe('delta')
    expect(update.base).toBe('empty')
    const counts = update.counts as Record<string, number>
    expect(counts.merged).toBe(0)
    expect(counts.keptLocal).toBeGreaterThanOrEqual(1)
    expect(readFileSync(join(fixture.prefix, 'harness/3/cfg/both.yaml'), 'utf8')).toBe('x: LOCAL\ny: 2\nz: 2\n')
    expect(existsSync(join(fixture.prefix, 'harness/3/cfg/both.yaml.new-3'))).toBe(true)
    expect(readFileSync(join(fixture.prefix, 'harness/3/core/app.js'), 'utf8')).toBe(versionCore('3'))
    // Retention does not depend on the previous base: shipped bytes for the
    // preserved config path are in the release view, so the new base is built.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/3.tar'))).toBe(true)
  }, 240_000)

  it('GC drops retained bases with their version dirs and reaps orphans', async () => {
    const fixture = await buildFixture()
    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    const bases = join(fixture.prefix, 'harness/.bases')
    // old-b/old-c/old-d fall outside retention K=3; old-b's base follows it.
    expect(existsSync(join(bases, 'old-b.tar'))).toBe(false)
    expect(existsSync(join(bases, 'old-b.tar.sha256'))).toBe(false)
    // old-a survives as the third retention slot, so its base stays.
    expect(existsSync(join(bases, 'old-a.tar'))).toBe(true)
    // A version-less base slot is orphaned and reaped even without a prune.
    expect(existsSync(join(bases, 'ghost.tar'))).toBe(false)
    expect(existsSync(join(bases, 'ghost.tar.sha256'))).toBe(false)
    // The freshly installed version keeps its retained base.
    expect(existsSync(join(bases, '2.tar'))).toBe(true)
  }, 240_000)

  it('prints nine coherent numbered steps on the no-op and delta paths', async () => {
    // Rung 0: the up-to-date path must show the transport step it never runs.
    const noopFixture = await buildFixture({ visible: ['1'] })
    const noop = await runUpdate(noopFixture)
    expect(noop.status, noop.stderr).toBe(0)
    const noopSteps = stepSequence(noop.stderr)
    expect(noopSteps.map(step => step.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(noopSteps.map(step => step.total))).toEqual(new Set([9]))
    expect(noopSteps[4]?.title).toContain('delta transport: nothing to do — already at 1')
    expect(noop.stderr).toContain('self-check passed')

    // Rung 1 without --json: numbered steps plus live progress on stderr.
    const deltaFixture = await buildFixture()
    const delta = await runUpdate(deltaFixture, { DSH_UPDATE_PROGRESS_EVERY_ACTIONS: '3' }, [], { json: false })
    expect(delta.status, delta.stderr).toBe(0)
    const deltaSteps = stepSequence(delta.stderr)
    expect(deltaSteps.map(step => step.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(deltaSteps.map(step => step.total))).toEqual(new Set([9]))
    expect(deltaSteps[4]?.title).toContain('delta transport (rung 1')
    expect(delta.stderr).toContain('apply: plan ')
    expect(delta.stderr).toContain('apply: working — snapshot')
    expect(delta.stderr).toContain('apply: snapshot ')
    expect(delta.stderr).toContain('apply: seeding ')
    expect(delta.stderr).toMatch(/apply: \d+\/\d+ actions — /u)
    expect(delta.stderr).toContain('verify: checking the staged tree')
    expect(delta.stderr).toContain('merge base: retaining the pristine merge base')
    expect(delta.stderr).toContain('merge base: retained ')
    expect(delta.stderr).toContain('switch: current → 2')
    expect(currentTarget(deltaFixture.prefix)).toBe('2')

    // --json: the machine object stays on stdout and progress is suppressed.
    const jsonFixture = await buildFixture()
    const jsonRun = await runUpdate(jsonFixture, { DSH_UPDATE_PROGRESS_EVERY_ACTIONS: '3' })
    expect(jsonRun.status, jsonRun.stderr).toBe(0)
    expect(jsonRun.json?.ok).toBe(1)
    expect(jsonRun.stderr).not.toContain('apply: plan')
    expect(jsonRun.stderr).not.toContain('merge base: retaining')
  }, 240_000)

  it('keeps a live non-TTY timeline with no silent interval beyond the bound', async () => {
    const fixture = await buildFixture()
    const run = await runUpdateTimed(fixture, { DSH_UPDATE_PROGRESS_EVERY_ACTIONS: '3' })
    expect(run.status, run.stderr).toBe(0)
    const texts = run.lines.map(line => line.text)
    const indexOf = (needle: string): number => texts.findIndex(text => text.includes(needle))
    const scan = indexOf('scan: hashing the installed tree')
    const plan = indexOf('apply: plan ')
    const working = indexOf('apply: working — snapshot')
    const snapshot = indexOf('apply: snapshot ')
    const seeding = indexOf('apply: seeding ')
    const verifying = indexOf('verify: checking the staged tree')
    expect(scan).toBeGreaterThanOrEqual(0)
    expect(plan).toBeGreaterThan(scan)
    expect(working).toBeGreaterThan(plan)
    expect(snapshot).toBeGreaterThan(working)
    expect(seeding).toBeGreaterThan(snapshot)
    expect(verifying).toBeGreaterThan(seeding)
    // No silent interval beyond 10 s (fixture-scale; structural bound).
    for (let index = 1; index < run.lines.length; index += 1) {
      const gap = run.lines[index]!.at - run.lines[index - 1]!.at
      expect(gap, `gap before: ${run.lines[index]!.text}`).toBeLessThan(10_000)
    }
    expect(currentTarget(fixture.prefix)).toBe('2')
  }, 240_000)

  it('interrupting inside the staging seed leaves the live tree untouched and resumes', async () => {
    const fixture = await buildFixture()
    const run = await runUpdateUntilLine(fixture, 'apply: seeding ', { DSH_UPDATE_PROGRESS_EVERY_ACTIONS: '2' })
    expect(run.signalled).toBe(true)
    expect(run.status).not.toBe(0)
    // Live identity is untouched and the staging survives for the resume.
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(markerVersionAt(fixture.prefix, '1')).toBe('1')
    expect(stateField(fixture.prefix, 'version')).toBe('1')
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2.owner')) || existsSync(join(fixture.prefix, 'harness', '.staging-2'))).toBe(true)
    // The next run continues from whatever staging/journal state it finds.
    const resumed = await runUpdate(fixture)
    expect(resumed.status, resumed.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(markerVersion(fixture.prefix)).toBe('2')
    expect(stateField(fixture.prefix, 'version')).toBe('2')
  }, 240_000)

  it.skipIf(!ptyAvailable)('renders TTY progress for the delta path through a pty', async () => {
    const fixture = await buildFixture()
    const command = [
      'env',
      `DSH_GITHUB_URL=${fixture.server.base}`,
      'DSH_GITHUB_REPO=fixture/repo',
      'DSH_NO_TAILNET=1',
      'DSH_DELTA_FETCH_TIMEOUT=30',
      'DSH_PREBUILT_TIMEOUT=60',
      'DSH_PROGRESS_INTERVAL=60',
      'DSH_UPDATE_PROGRESS_EVERY_ACTIONS=3',
      'TERM=xterm',
      'bash', installSh,
      '--update',
      '--prefix', fixture.prefix,
      '--dsh-home', fixture.home,
      '--bin-dir', fixture.binDir,
      '--channel', 'stable',
    ].join(' ')
    // Async spawn: the fixture server lives in this process, so a blocking
    // spawnSync would starve the event loop and every request would time out.
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('script', ['-qec', command, '/dev/null'], { cwd: repoRoot })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('close', (status) => { resolve({ status, stdout, stderr }) })
    })
    expect(result.status, result.stderr).toBe(0)
    const output = result.stdout ?? ''
    expect(output).toContain('[1/9]')
    expect(output).toContain('[5/9]')
    expect(output).toContain('delta transport (rung 1')
    expect(output).toContain('[9/9]')
    expect(output).toContain('⏳')
    expect(output).toContain('apply: plan')
    expect(output).toContain('\u001b[')
    expect(currentTarget(fixture.prefix)).toBe('2')
  }, 240_000)

  it('reconciles a split identity from the symlink and completes the switch', async () => {
    const fixture = await buildFixture()
    // The PC state: a complete but never-switched 2 tree, and the ACTIVE 1
    // tree's marker poisoned with the 2 identity.
    cpSync(fixture.trees.get('2')!, join(fixture.prefix, 'harness', '2'), { recursive: true })
    write(join(fixture.prefix, 'harness', '2'), '.dsh-install-complete', '{"version": "2", "commit": "aa58eaf20bace6b3c082d40472bf07c175e9b460", "installedAt": "2026-10-11T14:54:50Z"}\n')
    write(join(fixture.prefix, 'harness', '1'), '.dsh-install-complete', '{"version": "2", "commit": "aa58eaf20bace6b3c082d40472bf07c175e9b460", "installedAt": "2026-10-11T14:54:50Z"}\n')

    // A dry run reports the split and writes nothing (the poison survives).
    const dry = await runUpdate(fixture, {}, ['--dry-run'])
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.stderr).toContain('identity mismatch (dry run; nothing was changed)')
    expect(markerVersionAt(fixture.prefix, '1')).toBe('2')

    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('identity mismatch:')
    expect(result.stderr).toContain("its .dsh-install-complete says '2'")
    expect(result.stderr).toContain('self-healing from the current symlink (the truth): 1')
    // The real update ran (not a false "already up to date at 2").
    const update = result.json?.update as Record<string, unknown>
    expect(update.rung).toBe(1)
    expect(update.mode).toBe('delta')
    expect(currentTarget(fixture.prefix)).toBe('2')
    // Every identity source agrees afterwards, including dsh --version.
    expect(markerVersion(fixture.prefix)).toBe('2')
    expect(stateField(fixture.prefix, 'version')).toBe('2')
    expect(stateField(fixture.prefix, 'harnessDir')).toBe('2')
    expect(dshVersion(fixture)).toBe('2')
    // The leftover tree was reused, not rebuilt, and retention stays at K=3.
    const log = readFileSync(join(fixture.prefix, 'logs/install.log'), 'utf8')
    expect(log).toMatch(/delta: version 2 is already installed at .* \(reusing\)/)
    expect(completeVersions(fixture.prefix)).toEqual(['1', '2', 'old-a'])
    // The healed marker keeps its forensic origin.
    const healed = JSON.parse(readFileSync(join(fixture.prefix, 'harness', '1', '.dsh-install-complete'), 'utf8')) as { healedFrom?: string }
    expect(healed.healedFrom).toBe('2')
  }, 240_000)

  it('never stamps the live tree when the profile refresh fails pre-switch, and resumes from the leftover', async () => {
    const fixture = await buildFixture()
    // Force a pre-switch failure after the tree work: a fresh home plus a
    // missing profile source makes prepare_profile die before the switch.
    writeStateField(fixture.prefix, 'profileSource', '/nonexistent-profile-source')
    const failed = await runUpdate(fixture)
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('profile fetch failed')
    // Active identity untouched; the staged tree is complete but unswitched.
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(markerVersionAt(fixture.prefix, '1')).toBe('1')
    expect(stateField(fixture.prefix, 'version')).toBe('1')
    expect(markerVersionAt(fixture.prefix, '2')).toBe('2')
    // The staged tree's marker is its own inode: the engine's hardlink seed of
    // installer state must never be written through into the live tree.
    expect(statSync(join(fixture.prefix, 'harness', '2', '.dsh-install-complete')).ino)
      .not.toBe(statSync(join(fixture.prefix, 'harness', '1', '.dsh-install-complete')).ino)

    // Resume: the leftover verified tree is reused and the switch completes.
    writeStateField(fixture.prefix, 'profileSource', '')
    const resumed = await runUpdate(fixture)
    expect(resumed.status, resumed.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(markerVersion(fixture.prefix)).toBe('2')
    expect(stateField(fixture.prefix, 'version')).toBe('2')
    expect(stateField(fixture.prefix, 'harnessDir')).toBe('2')
    expect(dshVersion(fixture)).toBe('2')
    expect(completeVersions(fixture.prefix)).toEqual(['1', '2', 'old-a'])
    const log = readFileSync(join(fixture.prefix, 'logs/install.log'), 'utf8')
    expect(log).toMatch(/delta: version 2 is already installed at .* \(reusing\)/)
  }, 240_000)

  it('records --forget tombstones before planning, idempotently', async () => {
    const fixture = await buildFixture()
    const result = await runUpdate(fixture, {}, ['--forget', 'docs/lost.txt'])
    expect(result.status, result.stderr).toBe(0)
    const tombstones = readFileSync(join(fixture.home, 'update/tombstones.txt'), 'utf8')
    expect(tombstones.trim().split('\n')).toEqual(['docs/remove.txt', 'docs/lost.txt'])
    // The same run respected the fresh tombstone: no restore of the locally deleted file.
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(existsSync(join(fixture.prefix, 'harness/2/docs/lost.txt'))).toBe(false)
    const actions = (result.json?.updateActions as { forgotten: { path: string; outcome: string }[] })
    expect(actions.forgotten).toEqual([{ path: 'docs/lost.txt', outcome: 'recorded' }])

    // Idempotent: a second run records nothing new and reports it.
    const second = await runUpdate(fixture, {}, ['--forget', 'docs/lost.txt'])
    expect(second.status, second.stderr).toBe(0)
    expect(readFileSync(join(fixture.home, 'update/tombstones.txt'), 'utf8').trim().split('\n')).toEqual(['docs/remove.txt', 'docs/lost.txt'])
    const secondActions = (second.json?.updateActions as { forgotten: { path: string; outcome: string }[] })
    expect(secondActions.forgotten).toEqual([{ path: 'docs/lost.txt', outcome: 'already' }])

    // --dry-run reports the intent and writes nothing.
    const dry = await runUpdate(fixture, {}, ['--dry-run', '--forget', 'docs/extra.txt'])
    expect(dry.status, dry.stderr).toBe(0)
    expect(dry.json?.dryRun).toBe(1)
    expect(readFileSync(join(fixture.home, 'update/tombstones.txt'), 'utf8')).not.toContain('docs/extra.txt')
    expect(dry.stderr).toContain('would record docs/extra.txt')
  }, 240_000)

  it('--accept-shipped removes the pin and restores the shipped file from the pristine archive', async () => {
    const fixture = await buildFixture()
    // The pin was the only thing protecting this locally edited file.
    write(join(fixture.prefix, 'harness/1'), 'docs/pinme.txt', 'pin USER\n')
    const result = await runUpdate(fixture, {}, ['--accept-shipped', 'docs/pinme.txt'])
    expect(result.status, result.stderr).toBe(0)
    const pins = readFileSync(join(fixture.home, 'update/pins.yaml'), 'utf8')
    expect(pins).not.toContain('pinme')
    // The update then takes the target's shipped bytes (no pin left to skip it).
    expect(readFileSync(join(fixture.prefix, 'harness/2/docs/pinme.txt'), 'utf8')).toBe('pin 2\n')
    const counts = (result.json?.update as { counts: Record<string, number> }).counts
    expect(counts.pinned).toBe(0)
    const actions = (result.json?.updateActions as { acceptedShipped: { path: string; restored: boolean; note: string | null }[] })
    expect(actions.acceptedShipped).toEqual([{ path: 'docs/pinme.txt', restored: true, note: null }])
  }, 240_000)

  it('--accept-shipped reports honestly when no pristine archive is available', async () => {
    // Only release 1 is published: the run is a no-op, so the file cannot be
    // replaced by an update — the flag alone decides what happens now.
    const fixture = await buildFixture({ visible: ['1'] })
    write(join(fixture.prefix, 'harness/1'), 'docs/pinme.txt', 'pin USER\n')
    rmSync(join(fixture.prefix, 'harness/.cache', fixture.fullName('1')), { force: true })
    rmSync(join(fixture.prefix, 'harness/.cache', `${fixture.fullName('1')}.sha256`), { force: true })
    rmSync(join(fixture.prefix, 'harness/.bases/1.tar'), { force: true })
    rmSync(join(fixture.prefix, 'harness/.bases/1.tar.sha256'), { force: true })
    const result = await runUpdate(fixture, {}, ['--accept-shipped', 'docs/pinme.txt'])
    expect(result.status, result.stderr).toBe(0)
    const pins = readFileSync(join(fixture.home, 'update/pins.yaml'), 'utf8')
    expect(pins).not.toContain('pinme')
    expect(readFileSync(join(fixture.prefix, 'harness/1/docs/pinme.txt'), 'utf8')).toBe('pin USER\n')
    const actions = (result.json?.updateActions as { acceptedShipped: { path: string; restored: boolean; note: string | null }[] })
    expect(actions.acceptedShipped).toEqual([{ path: 'docs/pinme.txt', restored: false, note: 'no pristine archive for 1; the next update will take the shipped file' }])
  }, 240_000)

  it('falls back to the full tarball when the diff hash does not match', async () => {
    const fixture = await buildFixture()
    fixture.server.failures.set(fixture.diffName('1', '2'), 'corrupt-bytes')
    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    const update = result.json?.update as Record<string, unknown>
    expect(update.mode).toBe('full')
    expect(update.rung).toBe(1)
    expect(result.stderr).toContain('checksum mismatch')
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(readFileSync(join(fixture.prefix, 'harness/2/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
    // The fallback downloaded the full release; it is retained as the base.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar.gz'))).toBe(true)
  }, 240_000)

  it('falls back to the full tarball when the diff is a corrupt gzip with a valid hash', async () => {
    const fixture = await buildFixture()
    fixture.server.failures.set(fixture.diffName('1', '2'), 'badgzip')
    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    const update = result.json?.update as Record<string, unknown>
    expect(update.mode).toBe('full')
    expect(result.stderr).toContain('input rejected')
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect(readFileSync(join(fixture.prefix, 'harness/2/user/notes.txt'), 'utf8')).toBe('notes\n')
  }, 240_000)

  it('leaves the active install untouched when the network severs during download', async () => {
    const fixture = await buildFixture()
    // Both the diff and the full tarball are unreachable: the update must stop
    // before anything is switched and nothing may be written into the prefix
    // harness version set.
    fixture.server.failures.set(fixture.diffName('1', '2'), 'sever')
    fixture.server.failures.set(fixture.fullName('2'), 'sever')
    const before = readdirSync(join(fixture.prefix, 'harness')).sort()
    const result = await runUpdate(fixture)
    expect(result.status).not.toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(existsSync(join(fixture.prefix, 'harness/2'))).toBe(false)
    expect(existsSync(join(fixture.prefix, 'harness/.staging-2'))).toBe(false)
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar'))).toBe(false)
    expect(existsSync(join(fixture.prefix, 'harness/.bases/2.tar.gz'))).toBe(false)
    const after = readdirSync(join(fixture.prefix, 'harness')).sort().filter(name => !name.startsWith('.'))
    expect(after).toEqual(before.filter(name => !name.startsWith('.')))
    expect(readFileSync(join(fixture.prefix, 'harness/1/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\n')
  }, 240_000)

  it('uses the full tarball beyond three hops', async () => {
    const versions = ['1', '2', '3', '4', '5']
    const fixture = await buildFixture({ versions, installed: '1', target: '5' })
    const result = await runUpdate(fixture)
    expect(result.status, result.stderr).toBe(0)
    const update = result.json?.update as Record<string, unknown>
    expect(update.rung).toBe(3)
    expect(update.mode).toBe('full')
    expect(update.verificationOk).toBe(true)
    expect(currentTarget(fixture.prefix)).toBe('5')
    expect(markerVersion(fixture.prefix)).toBe('5')
    expect(stateField(fixture.prefix, 'version')).toBe('5')
    // The full path prints the same nine numbered phases.
    const fullSteps = stepSequence(result.stderr)
    expect(fullSteps.map(step => step.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(fullSteps.map(step => step.total))).toEqual(new Set([9]))
    expect(fullSteps[4]?.title).toContain('full release apply (preservation engine)')
    expect(readFileSync(join(fixture.prefix, 'harness/5/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\nFIVE\nSIX\nSEVEN\n')
    // A full update retains the downloaded archive verbatim as the base.
    expect(existsSync(join(fixture.prefix, 'harness/.bases/5.tar.gz'))).toBe(true)
  }, 240_000)

  it('rolls back to the previous tree and restores user files when the self-check fails after the switch', async () => {
    const fixture = await buildFixture()
    const result = await runUpdate(fixture, { DSH_UPDATE_SELFTEST_FAIL: '1' })
    expect(result.status).not.toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(result.json?.rolledBack).toBe(1)
    // The restored live tree carries its own identity, not the failed one.
    expect(markerVersionAt(fixture.prefix, '1')).toBe('1')
    expect(stateField(fixture.prefix, 'version')).toBe('1')
    const failed = readdirSync(join(fixture.prefix, 'harness')).filter(name => name.startsWith('2.failed-'))
    expect(failed.length).toBe(1)
    expect(readFileSync(join(fixture.prefix, 'harness/1/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\n')
    expect(readFileSync(join(fixture.prefix, 'harness/1/user/notes.txt'), 'utf8')).toBe('notes\n')
  }, 240_000)
})
