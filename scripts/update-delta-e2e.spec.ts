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

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('0.0.0-fixture'); process.exit(0) }
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

function releaseFiles(version: string): Record<string, { content: string; mode?: number }> {
  const first = version === '1'
  const files: Record<string, { content: string; mode?: number }> = {
    'package.json': { content: `{"version":"${version}"}\n` },
    'apps/cli/lib/bin.js': { content: STUB_CLI, mode: 0o755 },
    'core/app.js': { content: first ? 'core\nline2\nline3\n' : 'core\nline2\nline3\nFOUR\n' },
    'cfg/app.yaml': { content: 'a: 1\nb: 2\n' },
    'cfg/stable.yaml': { content: 'stable: true\n' },
    'docs/keep.txt': { content: first ? 'shipped v1\n' : `shipped ${version}\n` },
    'docs/pinme.txt': { content: first ? 'pin v1\n' : `pin ${version}\n` },
    'docs/remove.txt': { content: first ? 'gone v1\n' : `gone ${version}\n` },
    'docs/lost.txt': { content: first ? 'lost v1\n' : `lost ${version}\n` },
    'node_modules/pkg/index.js': { content: first ? 'A\nB\nC\n' : 'A\nB\nC\nNEW\n' },
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
  server: { base: string; close: () => Promise<void>; failures: Map<string, string> }
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
  write(installedTree, 'user/notes.txt', 'notes\n')
  write(installedTree, 'profiles/web/packages/my-plugin/package.json', '{"name":"my-plugin"}\n')
  write(installedTree, 'skills/my-skill/SKILL.md', '# my skill\n')
  write(installedTree, 'collide.txt', 'user collide\n')
  rmSync(join(installedTree, 'docs/lost.txt'))
  rmSync(join(installedTree, 'docs/remove.txt'))
  write(home, 'update/pins.yaml', 'paths:\n  - docs/pinme.txt\n')
  write(home, 'update/tombstones.txt', 'docs/remove.txt\n')
  write(installedTree, 'pnpm-workspace.yaml', 'patchedDependencies:\n  pkg: patches/pkg.patch\n')
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

  const server = await startFixtureServer(assets, versions, target)
  servers.push(server.http)
  return {
    root,
    prefix,
    home,
    binDir,
    trees,
    assets,
    server: { base: server.base, close: server.close, failures: server.failures },
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
  close: () => Promise<void>
}

function startFixtureServer(assets: Map<string, Buffer>, versions: string[], latest: string): Promise<ServerHandle> {
  const failures = new Map<string, string>()
  const state: { base: string } = { base: '' }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/releases/latest') {
      res.writeHead(302, { Location: `${state.base}/releases/tag/v${latest}` })
      res.end()
      return
    }
    if (url.pathname.includes('/repos/') && url.pathname.endsWith('/releases')) {
      const list = [...versions].reverse().map((version, index) => {
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

async function runUpdate(fixture: Fixture, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): Promise<UpdateResult> {
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
      '--json',
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

function currentTarget(prefix: string): string {
  return readlinkSync(join(prefix, 'harness/current'))
}

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

    // Atomic switch and marker.
    expect(currentTarget(fixture.prefix)).toBe('2')
    expect((JSON.parse(readFileSync(join(fixture.prefix, 'harness/2/.dsh-install-complete'), 'utf8')) as { version: string }).version).toBe('2')

    // Preservation: merged core edit, untracked file/plugin/skill, pinned and
    // tombstoned paths, collision sidecar, restored deletion.
    const v2 = join(fixture.prefix, 'harness/2')
    expect(readFileSync(join(v2, 'core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
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

    // User patch applied to the fresh shipped node_modules.
    expect(readFileSync(join(v2, 'node_modules/pkg/index.js'), 'utf8')).toBe('A-patched\nB\nC\nNEW\n')

    // Retention K=3: v2, v1, and exactly one older complete tree survive.
    const kept = completeVersions(fixture.prefix)
    expect(kept).toEqual(['1', '2', 'old-a'])

    // Engine report on disk (stable path, survives scratch cleanup).
    const reportFile = join(fixture.prefix, 'harness', '.last-update-2.json')
    expect(existsSync(reportFile)).toBe(true)
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { verification: { ok: boolean }; bytesWritten: number }
    expect(report.verification.ok).toBe(true)
    console.log(`[e2e] rung-1 delta: ${elapsedMs}ms, downloaded ${update.downloadedBytes} B vs full ${update.fullTarballBytes} B, written ${report.bytesWritten} B`)
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
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2'))).toBe(true)
    expect(existsSync(join(fixture.prefix, 'harness', '.staging-2.journal.json'))).toBe(true)
    const second = await runUpdate(fixture)
    expect(second.status, second.stderr).toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('2')
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
    expect(readFileSync(join(fixture.prefix, 'harness/3/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
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
    expect(readFileSync(join(fixture.prefix, 'harness/5/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\nFOUR\n')
  }, 240_000)

  it('rolls back to the previous tree and restores user files when the self-check fails after the switch', async () => {
    const fixture = await buildFixture()
    const result = await runUpdate(fixture, { DSH_UPDATE_SELFTEST_FAIL: '1' })
    expect(result.status).not.toBe(0)
    expect(currentTarget(fixture.prefix)).toBe('1')
    expect(result.json?.rolledBack).toBe(1)
    const failed = readdirSync(join(fixture.prefix, 'harness')).filter(name => name.startsWith('2.failed-'))
    expect(failed.length).toBe(1)
    expect(readFileSync(join(fixture.prefix, 'harness/1/core/app.js'), 'utf8')).toBe('core\nUSER\nline2\nline3\n')
    expect(readFileSync(join(fixture.prefix, 'harness/1/user/notes.txt'), 'utf8')).toBe('notes\n')
  }, 240_000)
})
