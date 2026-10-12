/**
 * scripts/release-delta.mjs: manifest schema, deterministic ordering, gzip
 * round trip, canonical alignment with the update engine's manifest rules,
 * manifest comparison, and the diff archive layout that harness-release.yml
 * publishes.
 *
 * The alignment suite generates the same fixture tree twice — once through the
 * emitter and once through the engine scanner — and asserts the canonical
 * serialization is byte-identical, including a symlink (never dereferenced), a
 * mode-bit file, and the NUL-probe binary classification.
 *
 * Fixture trees are built per test under a unique mkdtemp directory, so the
 * spec is safe beside parallel workers. Symlink and tar cases skip on Windows
 * (symlink creation is privileged there; the release workflow itself only runs
 * Linux/macOS).
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'

import type { ReleaseManifestDocument } from './release-delta.mjs'

import {
  BINARY_PROBE_BYTES as ENGINE_BINARY_PROBE_BYTES,
  assertSafeRelPath as engineAssertSafeRelPath,
  entryEquals,
  hashText,
  scanTree,
  serializeManifest,
} from '../packages/host/update-engine/src/manifest.ts'

import { buildManifest, computeDiff, manifestDocument, readManifest, sha256FileSync, toCanonicalManifest, writeDiff, writeManifest } from './release-delta.mjs'

const root = join(import.meta.dirname, '..')
const win32 = process.platform === 'win32'
const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-delta-spec-'))
  cleanups.push(dir)
  return dir
}

function afterAllCleanup(): void {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function write(dir: string, rel: string, content: string, mode = 0o644): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

function writeBytes(dir: string, rel: string, bytes: Buffer, mode = 0o644): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, bytes)
  chmodSync(file, mode)
  return file
}

describe('manifest schema', () => {
  it('lists every shipped path with type/mode/size/sha256 in byte order', () => {
    const dir = scratch()
    write(dir, 'bin/run.sh', '#!/bin/sh\nexit 0\n', 0o755)
    write(dir, 'a.txt', 'alpha\n')
    write(dir, 'deep/nested/file.js', 'export {}\n')
    mkdirSync(join(dir, 'empty'))

    const entries = buildManifest(dir)
    const paths = entries.map((entry: { path: string }) => entry.path)
    expect(paths).toEqual([...paths].sort((a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    expect(paths).toEqual(['a.txt', 'bin', 'bin/run.sh', 'deep', 'deep/nested', 'deep/nested/file.js', 'empty'])

    const run = entries.find((entry: { path: string }) => entry.path === 'bin/run.sh')
    expect(run).toMatchObject({ type: 'file', mode: '0755', size: statSync(join(dir, 'bin/run.sh')).size, target: null, binary: false })
    expect(run!.sha256).toBe(sha256FileSync(join(dir, 'bin/run.sh')))
    const empty = entries.find(entry => entry.path === 'empty')
    expect(empty).toMatchObject({ path: 'empty', type: 'dir', size: 0, sha256: null, target: null, binary: false })
    expect(empty?.mode).toMatch(/^0(7[0-9]{2}|6[0-9]{2})$/)
    const doc = JSON.parse(manifestDocument(entries, '0.1.7-enpoi.2.99', 'linux-x64')) as ReleaseManifestDocument
    expect(doc.schema).toBe('dsh-release-manifest/1')
    expect(doc.version).toBe('0.1.7-enpoi.2.99')
    expect(doc.platform).toBe('linux-x64')
    expect(doc.entries).toHaveLength(entries.length)
  })

  it.skipIf(win32)('hashes symlinks from their target string without dereferencing', () => {
    const dir = scratch()
    write(dir, 'target.txt', 'linked\n')
    symlinkSync('target.txt', join(dir, 'link'))
    const entries = buildManifest(dir)
    const link = entries.find((entry: { path: string }) => entry.path === 'link')
    expect(link).toMatchObject({
      type: 'symlink',
      target: 'target.txt',
      size: Buffer.byteLength('target.txt'),
      binary: false,
    })
    expect(link!.sha256).toBe(hashText('target.txt'))
    expect(link!.sha256).not.toBe(sha256FileSync(join(dir, 'target.txt')))
  })

  it('gzip round-trips through writeManifest with a sha256sum-format sidecar', () => {
    const dir = scratch()
    write(dir, 'a.txt', 'alpha\n')
    const out = join(dir, 'manifest-linux-x64-0.1.7-enpoi.2.99.json.gz')
    const stats = writeManifest({ tree: dir, platform: 'linux-x64', version: '0.1.7-enpoi.2.99', out })
    expect(stats.entries).toBeGreaterThan(0)
    const doc = readManifest(out)
    expect(doc.schema).toBe('dsh-release-manifest/1')
    expect(doc.entries.map((entry: { path: string }) => entry.path)).toContain('a.txt')
    const sidecar = readFileSync(`${out}.sha256`, 'utf8')
    expect(sidecar).toMatch(/^[0-9a-f]{64}  manifest-linux-x64-0\.1\.7-enpoi\.2\.99\.json\.gz\n$/)
    // The sidecar digest equals the artifact bytes (what SHA256SUMS will carry).
    const digest = spawnSync('sha256sum', [out], { encoding: 'utf8' })
    if (digest.status === 0) expect(sidecar.split(' ')[0]).toBe(digest.stdout.split(' ')[0])
  })

  it('is deterministic across repeated walks', () => {
    const dir = scratch()
    write(dir, 'b.txt', 'b\n')
    write(dir, 'a/c.txt', 'c\n')
    const first = manifestDocument(buildManifest(dir), 'v', 'linux-x64')
    const second = manifestDocument(buildManifest(dir), 'v', 'linux-x64')
    expect(second).toBe(first)
  })
})

describe('canonical alignment with @deepseek-ai/dsh-host-update-engine', () => {
  it.skipIf(win32)('serializes byte-identically to the engine scan of the same tree', async () => {
    const dir = scratch()
    write(dir, 'plain.txt', 'plain\n')
    write(dir, 'bin/run.sh', '#!/bin/sh\necho hi\n', 0o755)
    write(dir, 'deep/nested.txt', 'nested\n')
    writeBytes(dir, 'blob.bin', Buffer.from([0x89, 0x00, 0x01]))
    writeBytes(dir, 'late-nul.bin', Buffer.concat([Buffer.alloc(ENGINE_BINARY_PROBE_BYTES, 0x41), Buffer.from([0x00])]))
    write(dir, 'target.txt', 'shipped bytes\n')
    symlinkSync('target.txt', join(dir, 'link'))
    symlinkSync('deep', join(dir, 'dirlink'))
    mkdirSync(join(dir, 'empty'))

    const out = join(scratch(), 'manifest-linux-x64-9.9.9.json.gz')
    writeManifest({ tree: dir, platform: 'linux-x64', version: '9.9.9', out })

    const doc = readManifest(out)
    const engine = await scanTree(dir)
    // Byte-identical: the emitter's document projected onto the engine
    // manifest serializes exactly like the engine's own scan.
    expect(serializeManifest(toCanonicalManifest(doc))).toBe(serializeManifest(engine))

    const link = doc.entries.find((entry: { path: string }) => entry.path === 'link')
    expect(link!.sha256).toBe(hashText('target.txt'))
    expect(link!.sha256).not.toBe(sha256FileSync(join(dir, 'target.txt')))
    expect(engine['link']?.sha256).toBe(hashText('target.txt'))
    expect(engine['dirlink']?.type).toBe('symlink')

    const run = doc.entries.find((entry: { path: string }) => entry.path === 'bin/run.sh')
    expect(run!.mode).toBe('0755')
    expect(engine['bin/run.sh']?.mode).toBe(0o755)
    expect(engine['bin/run.sh']!.mode & 0o7777).toBe(0o755)

    // The NUL probe matches exactly: a NUL inside the first 8192 bytes is
    // binary; a NUL at offset 8192 is not.
    expect(doc.entries.find(entry => entry.path === 'blob.bin')!.binary).toBe(true)
    expect(engine['blob.bin']?.binary).toBe(true)
    expect(doc.entries.find(entry => entry.path === 'late-nul.bin')!.binary).toBe(false)
    expect(engine['late-nul.bin']?.binary).toBe(false)

    const empty = doc.entries.find((entry: { path: string }) => entry.path === 'empty')
    expect(empty).toMatchObject({ type: 'dir', sha256: null, size: 0, target: null, binary: false })
    expect(engine['empty']?.sha256).toBeNull()
    expect(engine['empty']?.size).toBe(0)
  })

  it('validates paths and entries with the engine rules on read', () => {
    const docWith = (entry: object): Buffer =>
      Buffer.from(JSON.stringify({ schema: 'dsh-release-manifest/1', version: 'v', platform: 'p', entries: [entry] }))
    const file = (path: string): object => ({ path, type: 'file', mode: '0644', size: 1, sha256: 'a'.repeat(64), target: null, binary: false })

    for (const path of ['../evil', 'a/../../evil', '', '/abs', 'a//b', './a', 'a/./b', 'a\\b']) {
      expect(() => readManifest(docWith(file(path)))).toThrow(/unsafe manifest path/)
      expect(() => toCanonicalManifest(JSON.parse(docWith(file(path)).toString('utf8')))).toThrow(/unsafe manifest path/)
      expect(() => { engineAssertSafeRelPath(path) }).toThrow(/unsafe manifest path/)
    }
    expect(readManifest(docWith(file('ok/path.txt'))).entries).toHaveLength(1)
    // Control characters (newlines included) are refused by the emitter and
    // the updater's document reader; the engine's own path assertion guards
    // traversal only.
    for (const path of ['a\nb.txt', 'a\tb.txt', 'a\u0000b']) {
      expect(() => readManifest(docWith(file(path)))).toThrow(/unsafe manifest path/)
      expect(() => toCanonicalManifest(JSON.parse(docWith(file(path)).toString('utf8')))).toThrow(/unsafe manifest path/)
    }

    expect(() => readManifest(Buffer.from(JSON.stringify({ schema: 'other/1', version: 'v', platform: 'p', entries: [] })))).toThrow(/not a dsh-release-manifest\/1 document/)
    expect(() => readManifest(Buffer.from(JSON.stringify({ schema: 'dsh-release-manifest/1', version: 'v', platform: 'p', entries: {} })))).toThrow(/entries must be an array/)
    expect(() => readManifest(docWith({ ...file('link'), type: 'symlink', target: null }))).toThrow(/symlink entry requires a target/)
    expect(() => readManifest(docWith({ ...file('neg'), size: -1 }))).toThrow(/size must be a non-negative integer/)
    expect(() => readManifest(docWith({ ...file('mode'), mode: 'zzz' }))).toThrow(/mode must be a POSIX mode/)
    expect(() => readManifest(docWith({ ...file('binary'), binary: 'yes' }))).toThrow(/binary must be a boolean/)
  })
})

describe('manifest comparison', () => {
  function pair(): { oldDoc: ReleaseManifestDocument; newDoc: ReleaseManifestDocument; newTree: string } {
    const oldTree = scratch()
    write(oldTree, 'keep.txt', 'keep\n')
    write(oldTree, 'change.txt', 'v1\n')
    write(oldTree, 'gone.txt', 'gone\n')
    write(oldTree, 'modeonly.txt', 'same\n', 0o644)
    const newTree = scratch()
    write(newTree, 'keep.txt', 'keep\n')
    write(newTree, 'change.txt', 'v2!\n')
    write(newTree, 'modeonly.txt', 'same\n', 0o755)
    write(newTree, 'added.txt', 'new\n')
    write(newTree, 'deep/nested.txt', 'nested\n')
    return {
      oldDoc: { schema: 'dsh-release-manifest/1', version: 'a', platform: 'p', entries: buildManifest(oldTree) },
      newDoc: { schema: 'dsh-release-manifest/1', version: 'b', platform: 'p', entries: buildManifest(newTree) },
      newTree,
    }
  }

  it('classifies changed, mode-only, and deleted paths', () => {
    const { oldDoc, newDoc } = pair()
    const diff = computeDiff(oldDoc, newDoc)
    expect(diff.changed.map((entry: { path: string }) => entry.path)).toEqual(['added.txt', 'change.txt', 'deep', 'deep/nested.txt'])
    expect(diff.changedBytes).toBe(4 + 4 + 7) // change.txt v2!, added.txt, deep/nested.txt
    expect(diff.modeChanges).toEqual([{ path: 'modeonly.txt', oldMode: '0644', newMode: '0755' }])
    expect(diff.deleted).toEqual(['gone.txt'])
  })

  it.skipIf(win32)('treats symlink target changes and mode changes as real changes (engine rule)', () => {
    const oldTree = scratch()
    const newTree = scratch()
    for (const tree of [oldTree, newTree]) {
      write(tree, 'file.txt', 'same\n', 0o644)
      write(tree, 'target-a.txt', 'A\n')
      write(tree, 'target-b.txt', 'B\n')
    }
    chmodSync(join(newTree, 'file.txt'), 0o600)
    symlinkSync('target-a.txt', join(oldTree, 'link'))
    symlinkSync('target-b.txt', join(newTree, 'link'))

    const oldDoc = { schema: 'dsh-release-manifest/1', version: 'a', platform: 'p', entries: buildManifest(oldTree) }
    const newDoc = { schema: 'dsh-release-manifest/1', version: 'b', platform: 'p', entries: buildManifest(newTree) }
    const diff = computeDiff(oldDoc, newDoc)
    expect(diff.changed.map((entry: { path: string }) => entry.path)).toEqual(['link'])
    expect(diff.modeChanges).toEqual([{ path: 'file.txt', oldMode: '0644', newMode: '0600' }])

    // The classification is exactly the engine's entryEquals rule: a shared
    // path is flagged iff its canonical projections are not entry-equal.
    const canonicalOld = toCanonicalManifest(oldDoc)
    const canonicalNew = toCanonicalManifest(newDoc)
    const flagged = new Set<string>([
      ...diff.changed.map(entry => entry.path),
      ...diff.modeChanges.map(change => change.path),
    ])
    for (const path of Object.keys(canonicalNew)) {
      expect(flagged.has(path)).toBe(!entryEquals(canonicalOld[path]!, canonicalNew[path]!))
    }

    // A target change rides the archive as the new symlink; a mode-only
    // change stays in mode-changes.txt and ships no bytes.
    const out = join(scratch(), 'diff-linux-x64-a-b.tar.gz')
    writeDiff({ tree: newTree, oldManifest: oldDoc, newManifest: newDoc, platform: 'linux-x64', from: 'a', to: 'b', out })
    const extracted = scratch()
    const untar = spawnSync('tar', ['-xzf', out, '-C', extracted], { encoding: 'utf8' })
    expect(untar.status).toBe(0)
    expect(readlinkSync(join(extracted, 'link'))).toBe('target-b.txt')
    expect(existsSync(join(extracted, 'file.txt'))).toBe(false)
  })

  it.skipIf(win32)('packs changed entries and .dsh-diff metadata into the diff archive', () => {
    const { oldDoc, newDoc, newTree } = pair()
    const out = join(scratch(), 'diff-linux-x64-a-b.tar.gz')
    const stats = writeDiff({ tree: newTree, oldManifest: oldDoc, newManifest: newDoc, platform: 'linux-x64', from: 'a', to: 'b', out })
    expect(stats).toMatchObject({ changed: 4, deleted: 1, modeChanges: 1 })
    expect(stats.diffBytes).toBeGreaterThan(0)

    const listing = spawnSync('tar', ['-tzf', out], { encoding: 'utf8' })
    expect(listing.status).toBe(0)
    const members = listing.stdout.trim().split('\n')
    expect(members).toContain('change.txt')
    expect(members).toContain('added.txt')
    expect(members).toContain('deep/nested.txt')
    expect(members).toContain('.dsh-diff/deleted.txt')
    expect(members).toContain('.dsh-diff/mode-changes.txt')
    expect(members).toContain('.dsh-diff/diff.json')
    expect(members).not.toContain('gone.txt')

    const meta = spawnSync('tar', ['-xzOf', out, '.dsh-diff/deleted.txt', '.dsh-diff/mode-changes.txt'], { encoding: 'utf8' })
    expect(meta.status).toBe(0)
    expect(meta.stdout).toContain('gone.txt')
    expect(meta.stdout).toContain('modeonly.txt\t0644\t0755')
    const metaJson = spawnSync('tar', ['-xzOf', out, '.dsh-diff/diff.json'], { encoding: 'utf8' })
    expect(JSON.parse(metaJson.stdout)).toMatchObject({ schema: 'dsh-release-diff/1', from: 'a', to: 'b', changed: 4, deleted: 1, modeChanges: 1 })
    expect(existsSync(`${out}.sha256`)).toBe(true)
  })

  it('produces an empty-but-valid diff when nothing changed', () => {
    const { oldDoc } = pair()
    const diff = computeDiff(oldDoc, oldDoc)
    expect(diff.changed).toEqual([])
    expect(diff.deleted).toEqual([])
    expect(diff.modeChanges).toEqual([])
  })
})

describe('harness-release.yml wiring', () => {
  function releaseSteps(): Record<string, unknown>[] {
    const workflow = yaml.load(readFileSync(join(root, '.github/workflows/harness-release.yml'), 'utf8')) as { jobs: Record<string, { steps: Record<string, unknown>[] }> }
    return workflow.jobs['build']!.steps.filter(step => typeof step === 'object' && step !== null)
  }

  it('publishes only the platform tarballs and SHA256SUMS (no delta-era assets)', () => {
    const steps = releaseSteps()
    const names = steps.map(step => step.name)
    // The retired delta updater's publication steps are gone: the default
    // updater downloads the full tarball and needs no manifests or diffs.
    expect(names).not.toContain('Emit release manifest')
    expect(names).not.toContain('Emit consecutive diff')
    expect(names).not.toContain('Upload manifest and diff assets to the draft release')
    expect(names).toContain('Pack artifact')
    expect(names.some(name => String(name).startsWith('Upload to the draft release'))).toBe(true)
    // The publish job still assembles every sidecar into SHA256SUMS.
    const workflow = yaml.load(readFileSync(join(root, '.github/workflows/harness-release.yml'), 'utf8')) as { jobs: Record<string, { steps: Record<string, unknown>[] }> }
    const publishRun = String(workflow.jobs['publish']!.steps.find(step => String(step.name).includes('SHA256SUMS'))?.run)
    expect(publishRun).toContain("--pattern '*.sha256'")
  })
})

afterAll(afterAllCleanup)
