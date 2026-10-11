/**
 * scripts/update-delta.mjs: manifest-document parity with the release emitter,
 * diff-archive path safety, chain extraction, release-view supplementation,
 * and the apply pipeline over synthetic releases (plan + staged apply through
 * the real preservation engine).
 *
 * The engine is imported from source (`packages/host/update-engine/src`) via a
 * generated ESM shim, so these cases exercise the shipped source plane; the
 * heavier scratch-prefix E2E through `scripts/install.sh` lives in
 * scripts/update-delta-e2e.spec.ts.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ReleaseManifestDocument } from './release-delta.d.mts'
import type { RunApplyPipelineOptions } from './update-delta.d.mts'

import { scanTree, serializeManifest } from '../packages/host/update-engine/src/index.ts'
import { buildManifest, manifestDocument, readManifest as readEmittedManifest, toCanonicalManifest, writeDiff } from './release-delta.mjs'
import {
  canonicalManifest,
  contentEqual,
  extractDiffChain,
  listArchiveMembers,
  readManifestDocument,
  runApplyPipeline,
  sha256FileSync,
  supplementReleaseView,
  validateArchiveMember,
  verifyExtractedTree,
} from './update-delta.mjs'

const root = join(import.meta.dirname, '..')
const win32 = process.platform === 'win32'
const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-delta-spec-'))
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

interface ReleaseFixture {
  root: string
  t1: string
  t2: string
  t3: string
  m1: object
  m2: object
  m3: object
  d12: string
  d23: string
}

function releaseFixture(): ReleaseFixture {
  const dir = scratch()
  const t1 = join(dir, 'v1')
  const t2 = join(dir, 'v2')
  const t3 = join(dir, 'v3')
  write(t1, 'core/app.js', 'one\ntwo\nthree\n')
  write(t1, 'cfg/app.yaml', 'a: 1\nb: 2\n')
  write(t1, 'cfg/both.yaml', 'x: 1\ny: 2\n')
  write(t1, 'docs/readme.txt', 'v1\n')
  write(t1, 'mode/mode.txt', 'same\n', 0o644)
  write(t2, 'core/app.js', 'one\ntwo\nthree\nFOUR\n')
  write(t2, 'cfg/app.yaml', 'a: 1\nb: 2\n')
  write(t2, 'cfg/both.yaml', 'x: 1\ny: 2\n')
  write(t2, 'docs/readme.txt', 'v1\n')
  write(t2, 'mode/mode.txt', 'same\n', 0o755)
  write(t2, 'added.txt', 'new in v2\n')
  write(t3, 'core/app.js', 'one\ntwo\nthree\nFOUR\nFIVE\n')
  write(t3, 'cfg/app.yaml', 'a: 1\nb: 2\n')
  write(t3, 'cfg/both.yaml', 'x: 1\ny: SHIPPED\n')
  write(t3, 'docs/readme.txt', 'v3\n')
  write(t3, 'mode/mode.txt', 'same\n', 0o755)
  write(t3, 'added.txt', 'new in v2\n')
  const l1 = manifestDocument(buildManifest(t1), 'v1', 'linux-x64')
  const l2 = manifestDocument(buildManifest(t2), 'v2', 'linux-x64')
  const l3 = manifestDocument(buildManifest(t3), 'v3', 'linux-x64')
  const m1 = JSON.parse(l1) as ReleaseManifestDocument
  const m2 = JSON.parse(l2) as ReleaseManifestDocument
  const m3 = JSON.parse(l3) as ReleaseManifestDocument
  const d12 = join(dir, 'diff-linux-x64-v1-v2.tar.gz')
  const d23 = join(dir, 'diff-linux-x64-v2-v3.tar.gz')
  writeDiff({ tree: t2, oldManifest: m1, newManifest: m2, platform: 'linux-x64', from: 'v1', to: 'v2', out: d12 })
  writeDiff({ tree: t3, oldManifest: m2, newManifest: m3, platform: 'linux-x64', from: 'v2', to: 'v3', out: d23 })
  return { root: dir, t1, t2, t3, m1, m2, m3, d12, d23 }
}

/** Minimal single-member tar (name, content) — for unsafe-archive fixtures. */
function writeTarGz(file: string, name: string, content: string): void {
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512)
  Buffer.from(name, 'utf8').copy(header, 0, 0, Math.min(Buffer.byteLength(name), 100))
  header.write('0000644\0', 100, 'utf8')
  header.write('0000000\0', 108, 'utf8')
  header.write('0000000\0', 116, 'utf8')
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
  header.write('00000000000\0', 136, 'utf8')
  header.write('        ', 148, 'utf8')
  header.write('0', 156, 'utf8')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  const padding = data.length % 512 === 0 ? 0 : 512 - (data.length % 512)
  const blocks = [header, data, Buffer.alloc(padding), Buffer.alloc(1024)]
  writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)))
}

/**
 * Bundle the engine source with esbuild (the same artifact shape tsdown emits
 * as lib/index.js) so the plain-JS apply module can import it without a
 * TypeScript loader.
 */
function engineBundle(outDir: string): string {
  const pnpmDir = join(root, 'node_modules/.pnpm')
  const versions = readdirSync(pnpmDir)
    .filter(name => /^esbuild@/u.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  let binary = ''
  for (const version of versions.reverse()) {
    const candidate = join(pnpmDir, version, 'node_modules/esbuild/bin/esbuild')
    if (existsSync(candidate)) { binary = candidate; break }
  }
  if (binary === '') throw new Error('esbuild binary not found under node_modules/.pnpm')
  const out = join(outDir, 'engine-bundle.js')
  const result = spawnSync(binary, [
    join(root, 'packages/host/update-engine/src/index.ts'),
    '--bundle', '--format=esm', '--platform=node', '--target=node22', `--outfile=${out}`,
  ], { encoding: 'utf8', cwd: root })
  if (result.status !== 0) throw new Error(`esbuild failed: ${result.stderr}`)
  return out
}

let enginePath = ''
beforeAll(() => {
  enginePath = engineBundle(scratch())
})

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('manifest-document parity with release-delta.mjs', () => {
  it('projects and serializes identically to the emitter and the engine scan', async () => {
    const f = releaseFixture()
    const doc = JSON.parse(manifestDocument(buildManifest(f.t1), 'v1', 'linux-x64')) as object
    const viaEmitter = toCanonicalManifest(doc)
    const viaApply = canonicalManifest(doc)
    expect(viaApply).toEqual(viaEmitter)
    expect(serializeManifest(viaApply)).toBe(serializeManifest(await scanTree(f.t1)))
    const gzipped = zlib.gzipSync(Buffer.from(`${JSON.stringify(doc)}\n`))
    expect(canonicalManifest(readManifestDocument(gzipped))).toEqual(viaApply)
  })

  it('rejects the same path/entry violations as the emitter', () => {
    const file = (path: string, extra: object = {}): object => ({ path, type: 'file', mode: '0644', size: 1, sha256: 'a'.repeat(64), target: null, binary: false, ...extra })
    const docWith = (entry: object): object => ({ schema: 'dsh-release-manifest/1', version: 'v', platform: 'p', entries: [entry] })
    for (const path of ['../evil', 'a/../../evil', '', '/abs', 'a//b', './a', 'a/./b', 'a\\b', 'a\nb', 'a\tb', 'a\u0001b']) {
      expect(() => readManifestDocument(Buffer.from(JSON.stringify(docWith(file(path)))))).toThrow()
      expect(() => readEmittedManifest(Buffer.from(JSON.stringify(docWith(file(path)))))).toThrow()
    }
    for (const entry of [
      file('neg', { size: -1 }),
      file('mode', { mode: 'zzz' }),
      file('binary', { binary: 'yes' }),
      file('link', { type: 'symlink', target: null }),
      file('kind', { type: 'fifo' }),
    ]) {
      expect(() => canonicalManifest(docWith(entry))).toThrow()
      expect(() => readEmittedManifest(Buffer.from(JSON.stringify(docWith(entry))))).toThrow()
    }
    expect(() => readManifestDocument(Buffer.from(JSON.stringify({ schema: 'other/1', entries: [] })))).toThrow(/not a dsh-release-manifest\/1/)
  })

  it('contentEqual ignores mode and keeps kind/hash/target identity', () => {
    const base = { type: 'file', sha256: 'x', target: null, mode: '0644' }
    expect(contentEqual(base, { ...base, mode: '0755' })).toBe(true)
    expect(contentEqual(base, { ...base, sha256: 'y' })).toBe(false)
    expect(contentEqual(base, { ...base, type: 'symlink', target: 't' })).toBe(false)
  })
})

describe('diff archive path safety', () => {
  it('accepts regular members and the reserved metadata, rejects everything else', () => {
    for (const name of ['a.txt', 'deep/nested/file.js', 'deep', 'deep/', '.dsh-diff/deleted.txt', '.dsh-diff/diff.json']) {
      expect(validateArchiveMember(name)).toBe(name.endsWith('/') ? name.slice(0, -1) : name)
    }
    for (const name of ['/abs', '../evil', 'a/../b', 'a/./b', './a', 'a//b', 'a\\b', 'a\nb', 'a\u0000b', '', '.dsh-diff/extra.txt', '.dsh-diff']) {
      expect(() => validateArchiveMember(name)).toThrow()
    }
  })

  it.skipIf(win32)('refuses a member that would extract outside the view', () => {
    const dir = scratch()
    const archive = join(dir, 'evil.tar.gz')
    writeTarGz(archive, '../escape.txt', 'pwned\n')
    expect(() => listArchiveMembers(archive)).toThrow(/unsafe archive member/)
    const view = join(dir, 'view')
    mkdirSync(view)
    expect(() => extractDiffChain({ archives: [archive], viewDir: view, from: 'v1', to: 'v2', platform: 'linux-x64' })).toThrow()
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
    expect(existsSync(join(view, '..', 'escape.txt'))).toBe(false)
  })

  it('refuses a corrupt gzip and unknown metadata members', () => {
    const dir = scratch()
    const corrupt = join(dir, 'corrupt.tar.gz')
    writeFileSync(corrupt, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not gzip at all')]))
    expect(() => listArchiveMembers(corrupt)).toThrow()
    const extra = join(dir, 'extra.tar.gz')
    writeTarGz(extra, '.dsh-diff/extra.txt', 'x')
    expect(() => listArchiveMembers(extra)).toThrow(/unexpected diff metadata member/)
  })

  it('rejects hardlinked files in an extracted view', () => {
    const dir = scratch()
    const view = join(dir, 'view')
    mkdirSync(view)
    writeFileSync(join(view, 'a.txt'), 'a')
    linkSync(join(view, 'a.txt'), join(view, 'b.txt'))
    expect(() => verifyExtractedTree(view)).toThrow(/hardlinked/)
  })
})

describe('diff chain extraction', () => {
  it('assembles a two-hop chain, marks completion, and resumes without re-extracting', () => {
    const f = releaseFixture()
    const view = join(scratch(), 'view')
    const first = extractDiffChain({ archives: [f.d12, f.d23], viewDir: view, from: 'v1', to: 'v3', platform: 'linux-x64' })
    expect(first.assembled).toBe(true)
    expect(first.hops).toBe(2)
    expect(readFileSync(join(view, 'core/app.js'), 'utf8')).toBe('one\ntwo\nthree\nFOUR\nFIVE\n')
    expect(readFileSync(join(view, 'added.txt'), 'utf8')).toBe('new in v2\n')
    expect(readFileSync(join(view, 'docs/readme.txt'), 'utf8')).toBe('v3\n')
    // A mode-only change ships no bytes: the archive carries it in
    // mode-changes.txt only, and the view supplement supplies pristine bytes.
    expect(existsSync(join(view, 'mode/mode.txt'))).toBe(false)
    expect(existsSync(join(view, '.dsh-diff'))).toBe(true)
    const second = extractDiffChain({ archives: [f.d12, f.d23], viewDir: view, from: 'v1', to: 'v3', platform: 'linux-x64' })
    expect(second.assembled).toBe(false)
  })

  it('rejects wrong hop metadata and a non-consecutive chain', () => {
    const f = releaseFixture()
    const view = join(scratch(), 'view')
    expect(() => extractDiffChain({ archives: [f.d12], viewDir: view, from: 'v1', to: 'v9', platform: 'linux-x64' })).toThrow(/targets v2/)
    const other = join(scratch(), 'other')
    expect(() => extractDiffChain({ archives: [f.d23, f.d12], viewDir: other, from: 'v2', to: 'v2', platform: 'linux-x64' })).toThrow()
  })
})

describe('release view supplementation', () => {
  it('fills mode-only and local-missing paths from the pristine base', () => {
    const dir = scratch()
    const f = releaseFixture()
    const base = join(dir, 'base')
    const local = join(dir, 'local')
    cpSync(f.t1, base, { recursive: true })
    cpSync(f.t1, local, { recursive: true })
    // Local: docs/readme.txt deleted (unchanged in v2 -> integrity restore),
    // mode/mode.txt edited locally (content still equals v2's bytes).
    rmSync(join(local, 'docs/readme.txt'))
    write(local, 'mode/mode.txt', 'same\n', 0o600)
    const view = join(dir, 'view')
    mkdirSync(view)
    const previous = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t1), 'v1', 'linux-x64')))
    const next = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t2), 'v2', 'linux-x64')))
    const result = supplementReleaseView({ viewDir: view, previous, next, localRoot: local, baseRoot: base })
    expect(result.supplemented.sort()).toEqual(['docs/readme.txt', 'mode/mode.txt'])
    expect(result.unresolved).toEqual([])
    expect(readFileSync(join(view, 'docs/readme.txt'), 'utf8')).toBe('v1\n')
    expect(sha256FileSync(join(view, 'mode/mode.txt'))).toBe(sha256FileSync(f.t2 + '/mode/mode.txt'))
  })

  it('treats an occupied view path as present even when the entry is a dead symlink', () => {
    const dir = scratch()
    const f = releaseFixture()
    const base = join(dir, 'base')
    const local = join(dir, 'local')
    cpSync(f.t1, base, { recursive: true })
    cpSync(f.t1, local, { recursive: true })
    const view = join(dir, 'view')
    mkdirSync(join(view, 'mode'), { recursive: true })
    symlinkSync('missing-target', join(view, 'mode/mode.txt'))
    const previous = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t1), 'v1', 'linux-x64')))
    const next = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t2), 'v2', 'linux-x64')))
    const result = supplementReleaseView({ viewDir: view, previous, next, localRoot: local, baseRoot: base })
    expect(result.supplemented).not.toContain('mode/mode.txt')
    expect(result.unresolved).not.toContain('mode/mode.txt')
  })

  it('reports unresolved paths when no pristine source has the bytes', () => {
    const dir = scratch()
    const f = releaseFixture()
    const local = join(dir, 'local')
    const base = join(dir, 'base')
    cpSync(f.t1, local, { recursive: true })
    mkdirSync(base)
    rmSync(join(local, 'docs/readme.txt'))
    const view = join(dir, 'view')
    mkdirSync(view)
    const previous = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t1), 'v1', 'linux-x64')))
    const next = canonicalManifest(JSON.parse(manifestDocument(buildManifest(f.t2), 'v2', 'linux-x64')))
    const result = supplementReleaseView({ viewDir: view, previous, next, localRoot: local, baseRoot: base })
    expect(result.unresolved).toEqual(['docs/readme.txt'])
  })
})

describe('apply pipeline', () => {
  interface PipelineFixture {
    dir: string
    previous: string
    next: string
    base: string
    local: string
    view: string
    staging: string
    journal: string
    result: string
    localEdit: string
  }

  function pipelineFixture(editRuntime = true): PipelineFixture {
    const f = releaseFixture()
    const dir = f.root
    const previousFile = join(dir, 'previous.json.gz')
    const nextFile = join(dir, 'next.json.gz')
    const previousDoc = manifestDocument(buildManifest(f.t1), 'v1', 'linux-x64')
    const nextDoc = manifestDocument(buildManifest(f.t3), 'v3', 'linux-x64')
    writeFileSync(previousFile, zlib.gzipSync(Buffer.from(previousDoc)))
    writeFileSync(nextFile, zlib.gzipSync(Buffer.from(nextDoc)))
    const base = join(dir, 'base')
    cpSync(f.t1, base, { recursive: true })
    const local = join(dir, 'local')
    cpSync(f.t1, local, { recursive: true })
    const localEdit = 'one\nUSER\ntwo\nthree\n'
    if (editRuntime) write(local, 'core/app.js', localEdit)
    write(local, 'untracked/notes.txt', 'user notes\n')
    return {
      dir,
      previous: previousFile,
      next: nextFile,
      base,
      local,
      view: join(dir, 'view'),
      staging: join(dir, 'staging'),
      journal: join(dir, 'staging.journal.json'),
      result: join(dir, 'result.json'),
      localEdit,
    }
  }

  function pipelineOptions(f: PipelineFixture, extra: Partial<RunApplyPipelineOptions> = {}): RunApplyPipelineOptions {
    return {
      enginePath,
      localRoot: f.local,
      baseRoot: f.base,
      releaseRoot: f.view,
      previousPath: f.previous,
      nextPath: f.next,
      stagingRoot: f.staging,
      journalPath: f.journal,
      toVersion: 'v3',
      fromVersion: 'v1',
      diffArchives: [join(f.dir, 'diff-linux-x64-v1-v2.tar.gz'), join(f.dir, 'diff-linux-x64-v2-v3.tar.gz')],
      platform: 'linux-x64',
      ...extra,
    }
  }

  it('applies a diff chain over the seeded tree, preserving user edits', async () => {
    const f = pipelineFixture()
    const retained = join(f.dir, 'retained-base.tar')
    const outcome = await runApplyPipeline(pipelineOptions(f, { persistBasePath: retained }))
    expect(outcome.status).toBe('applied')
    expect(outcome.exitCode).toBe(0)
    if (outcome.status === 'applied') {
      expect(outcome.result.verification?.ok).toBe(true)
      expect(outcome.transport.mode).toBe('delta')
      const report = outcome.result.report
      expect(report.counts.add).toBeGreaterThan(0)
      expect(report.counts['keep-untracked']).toBeGreaterThan(0)
      // core/app.js was both-changed: with a pristine base the merge keeps the
      // user's line; the upstream additions land.
      expect(outcome.plan.actions.find((action: { path: string }) => action.path === 'core/app.js')?.kind).toBe('merge')
      expect(outcome.result.baseArchive?.path).toBe(retained)
      expect(outcome.result.baseArchive?.bytes ?? 0).toBeGreaterThan(0)
    }
    expect(readFileSync(join(f.staging, 'core/app.js'), 'utf8')).toBe('one\nUSER\ntwo\nthree\nFOUR\nFIVE\n')
    expect(readFileSync(join(f.staging, 'untracked/notes.txt'), 'utf8')).toBe('user notes\n')
    expect(readFileSync(join(f.staging, 'added.txt'), 'utf8')).toBe('new in v2\n')
    expect(existsSync(join(f.staging, 'mode/mode.txt'))).toBe(true)

    // The retained archive is pristine: shipped bytes, no user data, no
    // sidecars, and a valid sidecar hash of its own.
    expect(existsSync(`${retained}.sha256`)).toBe(true)
    const extracted = join(f.dir, 'base-extracted')
    mkdirSync(extracted, { recursive: true })
    const untar = spawnSync('tar', ['-xf', retained, '-C', extracted], { encoding: 'utf8' })
    expect(untar.status).toBe(0)
    expect(readFileSync(join(extracted, 'core/app.js'), 'utf8')).toBe('one\ntwo\nthree\nFOUR\nFIVE\n')
    expect(existsSync(join(extracted, 'untracked/notes.txt'))).toBe(false)
    expect(existsSync(join(extracted, 'core/app.js.new-v3'))).toBe(false)
    expect(readFileSync(join(extracted, 'mode/mode.txt'), 'utf8')).toBe('same\n')
    expect(readFileSync(join(extracted, 'docs/readme.txt'), 'utf8')).toBe('v3\n')
  })

  it('resolves a clean merge on a later hop from a synthesized base', async () => {
    const f = pipelineFixture()
    const retained = join(f.dir, 'retained-base.tar')
    const first = await runApplyPipeline(pipelineOptions(f, { persistBasePath: retained }))
    expect(first.status).toBe('applied')
    const baseDir = join(f.dir, 'base-for-second-hop')
    mkdirSync(baseDir, { recursive: true })
    const untar = spawnSync('tar', ['-xf', retained, '-C', baseDir], { encoding: 'utf8' })
    expect(untar.status).toBe(0)
    // The installed tree for the second hop is the applied v3 tree (user edit
    // preserved); the base must be the pristine v3 shipped bytes.
    const second = await runApplyPipeline({
      ...pipelineOptions(f, {}),
      localRoot: f.staging,
      baseRoot: baseDir,
      stagingRoot: join(f.dir, 'staging-2'),
      journalPath: join(f.dir, 'staging-2.journal.json'),
    })
    expect(second.status).toBe('applied')
    const action = second.plan.actions.find((candidate: { path: string }) => candidate.path === 'core/app.js')
    expect(action?.kind).toBe('merge')
    expect(action?.merge?.status).toBe('clean')
    expect(second.result.verification?.ok).toBe(true)
    expect(readFileSync(join(f.dir, 'staging-2', 'core/app.js'), 'utf8')).toBe('one\nUSER\ntwo\nthree\nFOUR\nFIVE\n')
  })

  it('degrades a both-changed config file to keep-local with a sidecar when no base exists', async () => {
    const f = pipelineFixture(false)
    write(f.local, 'cfg/both.yaml', 'x: LOCAL\ny: 2\n')
    const emptyBase = join(scratch(), 'empty-base')
    mkdirSync(emptyBase)
    const outcome = await runApplyPipeline(pipelineOptions(f, { baseRoot: emptyBase }))
    expect(outcome.status).toBe('applied')
    expect(readFileSync(join(f.staging, 'cfg/both.yaml'), 'utf8')).toBe('x: LOCAL\ny: 2\n')
    const action = outcome.plan.actions.find((candidate: { path: string }) => candidate.path === 'cfg/both.yaml')
    expect(action?.kind).toBe('keep-local-sidecar')
    expect(action?.merge?.status).toBe('type-mismatch')
    expect(existsSync(join(f.staging, 'cfg/both.yaml.new-v3'))).toBe(true)
    expect(outcome.result.verification?.ok).toBe(true)
    expect(outcome.result.report.conflicts.length).toBe(1)
  })

  it('never fails an update when the base archive cannot be retained', async () => {
    const f = pipelineFixture()
    const blocker = join(f.dir, 'blocker-file')
    writeFileSync(blocker, 'not a directory\n')
    const outcome = await runApplyPipeline(pipelineOptions(f, { persistBasePath: join(blocker, 'base.tar') }))
    expect(outcome.status).toBe('applied')
    expect(outcome.result.verification?.ok).toBe(true)
    expect(outcome.result.baseArchive).toBeNull()
    expect(outcome.result.baseArchiveError).toBeTruthy()
    expect(readFileSync(join(f.staging, 'core/app.js'), 'utf8')).toBe('one\nUSER\ntwo\nthree\nFOUR\nFIVE\n')
  })

  it('interrupts deterministically and resumes from the journal', async () => {
    const f = pipelineFixture()
    const first = await runApplyPipeline(pipelineOptions(f, { stopAfterActions: 2 }))
    expect(first.status).toBe('interrupted')
    expect(existsSync(f.journal)).toBe(true)
    expect(existsSync(f.staging)).toBe(true)
    const second = await runApplyPipeline(pipelineOptions(f))
    expect(second.status).toBe('applied')
    expect(second.result.resumed).toBe(true)
    expect(second.result.verification?.ok).toBe(true)
    expect(readFileSync(join(f.staging, 'core/app.js'), 'utf8')).toBe('one\nUSER\ntwo\nthree\nFOUR\nFIVE\n')
  })

  it('rejects a corrupt chain before touching the staging directory', async () => {
    const f = pipelineFixture()
    const corrupt = join(f.dir, 'corrupt.tar.gz')
    const good = readFileSync(join(f.dir, 'diff-linux-x64-v1-v2.tar.gz'))
    writeFileSync(corrupt, good.subarray(0, Math.floor(good.length / 2)))
    await expect(runApplyPipeline(pipelineOptions(f, { diffArchives: [corrupt] }))).rejects.toThrow()
    expect(existsSync(f.staging)).toBe(false)
  })

  it('runs the CLI end to end and writes the structured result', () => {
    const f = pipelineFixture()
    const cli = join(root, 'scripts/update-delta.mjs')
    const result = spawnSync(process.execPath, [
      cli, 'apply',
      '--engine', enginePath,
      '--local', f.local,
      '--base', f.base,
      '--release', f.view,
      '--previous', f.previous,
      '--next', f.next,
      '--staging', f.staging,
      '--journal', f.journal,
      '--to-version', 'v3',
      '--from-version', 'v1',
      '--platform', 'linux-x64',
      '--diff', join(f.dir, 'diff-linux-x64-v1-v2.tar.gz'),
      '--diff', join(f.dir, 'diff-linux-x64-v2-v3.tar.gz'),
      '--persist-base', join(f.dir, 'cli-retained.tar'),
      '--out', f.result,
    ], {
      encoding: 'utf8',
      cwd: root,
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dsh update:')
    const parsed = JSON.parse(readFileSync(f.result, 'utf8')) as { status: string; verification: { ok: boolean }; baseArchive: { path: string } | null }
    expect(parsed.status).toBe('applied')
    expect(parsed.verification.ok).toBe(true)
    expect(parsed.baseArchive?.path).toBe(join(f.dir, 'cli-retained.tar'))
    expect(existsSync(join(f.dir, 'cli-retained.tar'))).toBe(true)
  })

  it('reports a corrupt gzip through the CLI as exit 2', () => {
    const f = pipelineFixture()
    const corrupt = join(f.dir, 'corrupt-cli.tar.gz')
    writeFileSync(corrupt, Buffer.from('definitely not gzip'))
    const cli = join(root, 'scripts/update-delta.mjs')
    const result = spawnSync(process.execPath, [
      cli, 'apply',
      '--engine', enginePath,
      '--local', f.local,
      '--base', f.base,
      '--release', f.view,
      '--previous', f.previous,
      '--next', f.next,
      '--staging', f.staging,
      '--journal', f.journal,
      '--to-version', 'v3',
      '--diff', corrupt,
    ], {
      encoding: 'utf8',
      cwd: root,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('update-delta:')
  })
})
