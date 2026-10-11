/**
 * Selective merge-base materialization (scripts/update-delta.mjs): candidate
 * derivation from the three manifests, member extraction from a release
 * archive (prefixed and flat layouts), reuse across runs, the candidate cap
 * falling back to a full extraction, and missing members degrading exactly
 * like the no-base path.
 *
 * Fixtures are synthetic release archives built locally; no network and no
 * live prefix is touched.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { CanonicalManifest } from './release-delta.d.mts'
import { buildManifest, manifestDocument } from './release-delta.mjs'
import { baseCandidates, canonicalManifest, materializeBase, memberRelPath, parseBaseListing } from './update-delta.mjs'

const win32 = process.platform === 'win32'
const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-base-spec-'))
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

/** Engine manifests for a tree, via the release-delta document bridge. */
function manifestOf(tree: string): CanonicalManifest {
  const doc = JSON.parse(manifestDocument(buildManifest(tree), 'v', 'linux-x64')) as object
  return canonicalManifest(doc)
}

function countFiles(root: string): number {
  let count = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else count += 1
    }
  }
  walk(root)
  return count
}

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Build an archive whose members are `top/<rel>` (prefixed) or `./<rel>`. */
function buildArchive(
  files: Record<string, string>,
  options: { prefixed?: boolean; out?: string; gz?: boolean } = {},
): { archive: string; tree: string } {
  const root = scratch()
  const tree = join(root, 'tree')
  for (const [rel, content] of Object.entries(files)) write(tree, rel, content)
  const gz = options.gz !== false
  const archive = options.out ?? join(root, gz ? 'base.tar.gz' : 'base.tar')
  const parent = options.prefixed === false ? tree : root
  const top = options.prefixed === false ? '.' : 'tree'
  const tar = spawnSync('tar', [gz ? '-czf' : '-cf', archive, '-C', parent, top], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  // The prefixed layout names the top directory after the tree dir ("tree/");
  // that is the same shape as `dsh-harness-<version>/`.
  return { archive, tree }
}

describe('base candidate derivation', () => {
  it('selects release-changed+local-diverged, mode-only, and locally-missing paths', () => {
    const root = scratch()
    const baseTree = join(root, 'base')
    const nextTree = join(root, 'next')
    const localTree = join(root, 'local')
    write(baseTree, 'pkg/a.txt', 'release v1\n')
    write(nextTree, 'pkg/a.txt', 'release v2\n')
    write(baseTree, 'pkg/mode.txt', 'same\n', 0o644)
    write(nextTree, 'pkg/mode.txt', 'same\n', 0o755)
    write(baseTree, 'pkg/restore.txt', 'restored\n')
    write(nextTree, 'pkg/restore.txt', 'restored\n')
    write(baseTree, 'pkg/same.txt', 'same\n')
    write(nextTree, 'pkg/same.txt', 'same\n')
    write(baseTree, 'package.json', '{}\n')
    write(nextTree, 'package.json', '{}\n')
    cpSync(baseTree, localTree, { recursive: true })
    // Local: a.txt diverges (both-changed merge), mode.txt kept, restore.txt deleted.
    write(localTree, 'pkg/a.txt', 'local edit\n')
    rmSync(join(localTree, 'pkg/restore.txt'))

    const candidates = baseCandidates(manifestOf(baseTree), manifestOf(nextTree), manifestOf(localTree))
    expect(candidates).toContain('pkg/a.txt')
    expect(candidates).toContain('pkg/mode.txt')
    expect(candidates).toContain('pkg/restore.txt')
    expect(candidates).toContain('package.json')
    expect(candidates).not.toContain('pkg/same.txt')
  })
})

describe('member listing and layouts', () => {
  it('parses tar -tv output and maps prefixed and flat members', () => {
    const members = parseBaseListing([
      '-rw-r--r--  0 0      12 2026-01-01 00:00 dsh-harness-2/pkg/a.txt',
      'drwxr-xr-x  0 0       0 2026-01-01 00:00 dsh-harness-2/pkg/',
      'lrwxr-xr-x  0 0       4 2026-01-01 00:00 dsh-harness-2/link -> a.txt',
    ].join('\n'))
    expect(members.map(member => member.name)).toEqual(['dsh-harness-2/pkg/a.txt', 'dsh-harness-2/pkg/', 'dsh-harness-2/link'])
    expect(members[0]?.size).toBe(12)
    expect(memberRelPath('dsh-harness-2/pkg/a.txt', { prefixed: true })).toBe('pkg/a.txt')
    expect(memberRelPath('dsh-harness-2/pkg/', { prefixed: true })).toBe('pkg')
    expect(memberRelPath('./pkg/a.txt', { prefixed: false })).toBe('pkg/a.txt')
    expect(memberRelPath('pkg/a.txt', { prefixed: false })).toBe('pkg/a.txt')
  })
})

describe.skipIf(win32)('materialization', () => {
  const FILES = {
    'package.json': '{"version":"2"}\n',
    'merge/a.txt': 'base A\n',
    'merge/b.txt': 'base B\n',
    'unchanged/one.txt': 'one\n',
    'unchanged/two.txt': 'two\n',
    'unchanged/three.txt': 'three\n',
  }

  function fixture(): { archive: string; baseDir: string; previous: CanonicalManifest; next: CanonicalManifest; local: CanonicalManifest } {
    const { archive, tree } = buildArchive(FILES)
    const baseDir = join(scratch(), 'work')
    const previous = manifestOf(tree)
    const local: CanonicalManifest = {}
    return { archive, baseDir, previous, next: previous, local }
  }

  it('extracts only the candidates and records a reuse marker', async () => {
    const f = fixture()
    const result = await materializeBase({
      archivePath: f.archive,
      baseDir: f.baseDir,
      previous: f.previous,
      next: f.next,
      local: f.local,
      candidates: ['merge/a.txt', 'merge/b.txt', 'package.json'],
    })
    expect(result.mode).toBe('selective')
    expect(result.reused).toBe(false)
    expect(result.extracted).toBe(3)
    expect(result.missing).toEqual([])
    expect(countFiles(f.baseDir)).toBe(3)
    expect(readFileSync(join(f.baseDir, 'merge/a.txt'), 'utf8')).toBe('base A\n')
    expect(existsSync(join(f.baseDir, 'unchanged/one.txt'))).toBe(false)
    expect(existsSync(join(f.baseDir, '.dsh-base-manifest.json'))).toBe(true)
  })

  it('reuses a verified materialization without touching the archive again', async () => {
    const f = fixture()
    const archiveSha = 'a'.repeat(64)
    const first = await materializeBase({ archivePath: f.archive, baseDir: f.baseDir, archiveSha, previous: f.previous, next: f.next, local: f.local, candidates: ['merge/a.txt', 'package.json'] })
    expect(first.reused).toBe(false)
    chmodSync(f.archive, 0o000)
    try {
      const second = await materializeBase({ archivePath: f.archive, baseDir: f.baseDir, archiveSha, previous: f.previous, next: f.next, local: f.local, candidates: ['merge/a.txt', 'package.json'] })
      expect(second.reused).toBe(true)
      expect(second.extracted).toBe(2)
      expect(readFileSync(join(f.baseDir, 'merge/a.txt'), 'utf8')).toBe('base A\n')
    } finally {
      chmodSync(f.archive, 0o644)
    }
  })

  it('falls back to a full extraction above the candidate cap', async () => {
    const f = fixture()
    const result = await materializeBase({
      archivePath: f.archive,
      baseDir: f.baseDir,
      previous: f.previous,
      next: f.next,
      local: f.local,
      candidates: ['merge/a.txt', 'merge/b.txt', 'package.json'],
      cap: 2,
    })
    expect(result.mode).toBe('full')
    expect(result.dir).not.toBe(f.baseDir)
    expect(readFileSync(join(result.dir, 'unchanged/three.txt'), 'utf8')).toBe('three\n')
    expect(existsSync(join(result.dir, '.dsh-base-manifest.json'))).toBe(false)
    rmSync(result.dir, { recursive: true, force: true })
  })

  it('degrades missing members like the no-base path and remembers them', async () => {
    const { archive, tree } = buildArchive({ 'package.json': '{}\n', 'merge/a.txt': 'base A\n' })
    const baseDir = join(scratch(), 'work')
    const previous = manifestOf(tree)
    const archiveSha = 'b'.repeat(64)
    const result = await materializeBase({
      archivePath: archive,
      baseDir,
      archiveSha,
      previous,
      next: previous,
      local: {},
      candidates: ['merge/a.txt', 'merge/gone.txt', 'package.json'],
    })
    expect(result.mode).toBe('selective')
    expect(result.missing).toEqual(['merge/gone.txt'])
    expect(result.extracted).toBe(2)
    // Reuse keeps reporting the missing member without a second extraction.
    chmodSync(archive, 0o000)
    try {
      const second = await materializeBase({
        archivePath: archive,
        baseDir,
        archiveSha,
        previous,
        next: previous,
        local: {},
        candidates: ['merge/a.txt', 'merge/gone.txt', 'package.json'],
      })
      expect(second.reused).toBe(true)
      expect(second.missing).toEqual(['merge/gone.txt'])
    } finally {
      chmodSync(archive, 0o644)
    }
  })

  it('emits extraction start, tick and completion lines', async () => {
    const big = 'x'.repeat(24 * 1024 * 1024)
    const { archive, tree } = buildArchive({ 'package.json': '{}\n', 'merge/big.bin': big }, { gz: false })
    const baseDir = join(scratch(), 'work')
    const previous = manifestOf(tree)
    const lines: string[] = []
    const result = await materializeBase({
      archivePath: archive,
      baseDir,
      previous,
      next: previous,
      local: {},
      candidates: ['merge/big.bin', 'package.json'],
      tickMs: 1,
      progress: line => lines.push(line),
    })
    expect(result.mode).toBe('selective')
    expect(lines.some(line => line.startsWith('merge base: extracting '))).toBe(true)
    expect(lines.some(line => line.startsWith('merge base: extracted '))).toBe(true)
    expect(lines.some(line => /^merge base: extracting .+ \/ .+ \(\d+s\)$/u.test(line))).toBe(true)
  })

  it('extracts from a flat (dot-prefixed) archive too', async () => {
    const { archive, tree } = buildArchive({ 'package.json': '{}\n', 'merge/a.txt': 'base A\n' }, { prefixed: false })
    const baseDir = join(scratch(), 'work')
    const previous = manifestOf(tree)
    const result = await materializeBase({ archivePath: archive, baseDir, previous, next: previous, local: {}, candidates: ['merge/a.txt', 'package.json'] })
    expect(result.mode).toBe('selective')
    expect(readFileSync(join(baseDir, 'merge/a.txt'), 'utf8')).toBe('base A\n')
  })
})
