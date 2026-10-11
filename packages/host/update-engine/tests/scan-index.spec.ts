/**
 * Scan index (doc 97 §3, AMD-01..07): trust model (FS-anchored racy rule,
 * ctime bypass closure, future guard), corruption self-heal, cold-vs-indexed
 * parity, reserved-path invisibility (verify passes with the index present),
 * no-hardlink fallback, index seeding from the verification walk, and the
 * zero-hash steady-state invariant.
 */

import { link, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshScanIndex, scanTree, walkTree } from '../src/manifest.ts'
import { SCAN_INDEX_NAME } from '../src/scan-index.ts'
import { verifyStagedTree } from '../src/verify.ts'
import { makeUpdateFixture, runUpdate } from './fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tree(files: Record<string, string | { content: string; mode?: number } | { symlink: string }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scan-index-'))
  roots.push(root)
  for (const [rel, spec] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'))
    await mkdir(join(file, '..'), { recursive: true })
    if (typeof spec === 'object' && 'symlink' in spec) {
      await symlink(spec.symlink, file)
      continue
    }
    const content = typeof spec === 'string' ? spec : spec.content
    await writeFile(file, content, typeof spec === 'object' && spec.mode !== undefined ? { mode: spec.mode } : {})
  }
  return root
}

function sizedFiles(count: number, size: number): Record<string, string> {
  const files: Record<string, string> = {}
  for (let index = 0; index < count; index += 1) files[`bulk/${String(index).padStart(4, '0')}.txt`] = 'x'.repeat(size)
  return files
}

describe('scan index trust model', () => {
  it('trusts a clean indexed tree with zero hashes and rebuilds when absent', async () => {
    const root = await tree({
      'package.json': '{}\n',
      'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      'blob.bin': 'a\u0000b',
      'link.txt': { symlink: 'package.json' },
      'dir/nested.txt': 'nested\n',
      ...sizedFiles(30, 64),
    })
    const cold = await scanTree(root, { useIndex: false })
    const fileCount = Object.values(cold).filter(entry => entry.type === 'file').length
    expect(fileCount).toBe(34)
    const firstInfo: { state: string; trusted: number; hashed: number }[] = []
    await scanTree(root, { onIndex: info => firstInfo.push(info) })
    expect(firstInfo[0]?.state).toBe('rebuilt')
    expect(firstInfo[0]?.trusted).toBe(0)
    expect(firstInfo[0]?.hashed).toBe(fileCount)

    const secondInfo: { state: string; trusted: number; hashed: number }[] = []
    const indexed = await scanTree(root, { onIndex: info => secondInfo.push(info) })
    expect(secondInfo[0]?.state).toBe('reused')
    expect(secondInfo[0]?.trusted).toBe(fileCount)
    expect(secondInfo[0]?.hashed).toBe(0)
    expect(indexed).toEqual(cold)
  })

  it('re-hashes same-size late edits, including the utimes bypass', async () => {
    const root = await tree({ 'a.txt': 'AAAA\n', 'b.txt': 'BBBB\n' })
    await scanTree(root, {})
    const indexBefore = await lstat(join(root, SCAN_INDEX_NAME))
    // Same-size content change: only mtime/ctime move.
    await writeFile(join(root, 'a.txt'), 'ZZZZ\n')
    const first: { hashed: number }[] = []
    const manifest = await scanTree(root, { onIndex: info => first.push(info) })
    expect(first[0]?.hashed).toBe(1)
    expect(manifest['a.txt']?.sha256).not.toBe(manifest['b.txt']?.sha256)

    // utimes bypass attempt: restore the old mtime after a same-size rewrite;
    // ctime is newer than the index and must force a re-hash anyway.
    const before = (await scanTree(root, {})), beforeHashes = before['a.txt']?.sha256
    await writeFile(join(root, 'a.txt'), 'YYYY\n')
    await utimes(join(root, 'a.txt'), indexBefore.atime, indexBefore.mtime)
    const second: { hashed: number }[] = []
    const healed = await scanTree(root, { onIndex: info => second.push(info) })
    expect(second[0]?.hashed).toBe(1)
    expect(healed['a.txt']?.sha256).not.toBe(beforeHashes)
  })

  it('re-hashes the racy boundary where the entry time equals the index time', async () => {
    const root = await tree({ 'a.txt': 'one\n' })
    await scanTree(root, {})
    const past = new Date(Date.now() - 60_000)
    await writeFile(join(root, 'a.txt'), 'two\n')
    // Pin BOTH clocks to the same instant: the entry is not strictly older
    // than the index, so the stat hit must not be trusted.
    await utimes(join(root, 'a.txt'), past, past)
    await utimes(join(root, SCAN_INDEX_NAME), past, past)
    const info: { hashed: number }[] = []
    const manifest = await scanTree(root, { onIndex: entry => info.push(entry) })
    expect(info[0]?.hashed).toBe(1)
    expect(manifest['a.txt']?.sha256).toBe(await hashOf(join(root, 'a.txt')))
  })

  it('self-heals truncated, invalid, and future-timestamped indexes', async () => {
    const root = await tree({ 'a.txt': 'one\n', 'b.txt': 'two\n' })
    const valid = await scanTree(root, {})
    const corruptions = [
      async (): Promise<void> => { await writeFile(join(root, SCAN_INDEX_NAME), '{"schema":"dsh-scan-index/1","entr') },
      async (): Promise<void> => { await writeFile(join(root, SCAN_INDEX_NAME), 'not json at all') },
      async (): Promise<void> => { await writeFile(join(root, SCAN_INDEX_NAME), '{"schema":"other/9","entries":{}}') },
      async (): Promise<void> => {
        const future = new Date(Date.now() + 120_000)
        await utimes(join(root, SCAN_INDEX_NAME), future, future)
      },
    ]
    for (const corrupt of corruptions) {
      await corrupt()
      const info: { state: string; hashed: number }[] = []
      const manifest = await scanTree(root, { onIndex: entry => info.push(entry) })
      expect(info[0]?.state).toBe('rebuilt')
      expect(info[0]?.hashed).toBe(2)
      expect(manifest).toEqual(valid)
    }
    // The rewrite is a usable index again.
    const info: { state: string; hashed: number }[] = []
    await scanTree(root, { onIndex: entry => info.push(entry) })
    expect(info[0]?.state).toBe('reused')
    expect(info[0]?.hashed).toBe(0)
  })

  it('keeps indexed and cold scans deep-equal on a sizable mixed tree', async () => {
    const files: Record<string, string | { content: string; mode?: number } | { symlink: string }> = {
      'package.json': '{}\n',
      'blob.bin': '\u0000\u0001binary',
      'link.txt': { symlink: 'package.json' },
      'exec.sh': { content: '#!/bin/sh\n', mode: 0o755 },
      ...sizedFiles(200, 128),
    }
    const root = await tree(files)
    const cold = await scanTree(root, { useIndex: false })
    await scanTree(root, {})
    const indexed = await scanTree(root, {})
    expect(indexed).toEqual(cold)
    expect(Object.keys(indexed).length).toBe(Object.keys(cold).length)
  })

  it('makes the reserved index path invisible to every walk surface', async () => {
    const root = await tree({ 'a.txt': 'a\n' })
    await writeFile(join(root, SCAN_INDEX_NAME), '{"schema":"dsh-scan-index/1","entries":{}}')
    await writeFile(join(root, `${SCAN_INDEX_NAME}.tmp-1`), 'partial')
    const manifest = await scanTree(root, { useIndex: false })
    const light = await walkTree(root)
    for (const surface of [manifest, light]) {
      expect(Object.keys(surface).some(path => path.startsWith(SCAN_INDEX_NAME))).toBe(false)
      expect(surface[SCAN_INDEX_NAME]).toBeUndefined()
    }
  })

  it('passes verification with the seeded index inside the staging tree', async () => {
    const fixture = await makeUpdateFixture('index-reserved', { 'a.txt': 'one\n', 'keep.txt': 'keep\n' }, { 'a.txt': 'two\n', 'keep.txt': 'keep\n', 'b.txt': 'new\n' })
    roots.push(fixture.root)
    const { plan, result } = await runUpdate(fixture)
    expect(result.status).toBe('applied')
    expect(result.verification?.ok).toBe(true)
    // The apply seeded the index into staging before the rename...
    await lstat(join(fixture.stagingRoot, SCAN_INDEX_NAME))
    // ...and re-verifying that tree with the index present stays clean.
    const again = await verifyStagedTree({
      plan,
      stagingRoot: fixture.stagingRoot,
      localRoot: fixture.localRoot,
      localManifest: fixture.local,
      localScanCompletedAt: Date.now(),
    })
    expect(again.ok).toBe(true)
    expect(again.mismatches).toEqual([])
    expect(again.contentReused).toBeGreaterThan(0)
  })

  it('seeds the staged index so a follow-up scan hashes nothing', async () => {
    const fixture = await makeUpdateFixture('index-seed', { 'a.txt': 'one\n' }, { 'a.txt': 'two\n', 'b.txt': 'new\n' })
    roots.push(fixture.root)
    const { result } = await runUpdate(fixture)
    expect(result.status).toBe('applied')
    const cold = await scanTree(fixture.stagingRoot, { useIndex: false })
    const info: { state: string; trusted: number; hashed: number }[] = []
    const indexed = await scanTree(fixture.stagingRoot, { onIndex: entry => info.push(entry) })
    expect(indexed).toEqual(cold)
    expect(info[0]?.state).toBe('reused')
    expect(info[0]?.hashed).toBe(0)
    expect(info[0]?.trusted).toBeGreaterThan(0)
  })

  it('falls back to copy seeding on a no-hardlink filesystem and disables inode trust', async () => {
    const fixture = await makeUpdateFixture('index-nohardlink', { 'a.txt': 'one\n', 'b.txt': 'two\n' }, { 'a.txt': 'one v2\n', 'b.txt': 'two v2\n' })
    roots.push(fixture.root)
    let linkCalls = 0
    const result = await runUpdate(fixture, {
      linkFile: async (source, destination) => {
        linkCalls += 1
        const error = new Error('link unsupported') as NodeJS.ErrnoException
        error.code = 'ENOTSUP'
        void source
        void destination
        throw error
      },
    })
    expect(linkCalls).toBeGreaterThan(0)
    expect(result.result.status).toBe('applied')
    expect(result.result.verification?.ok).toBe(true)
    // No shared inodes: verification re-read every file instead of reusing.
    expect(result.result.verification?.contentReused).toBe(0)
    expect(result.result.verification?.filesHashed).toBeGreaterThan(0)
    const staged = await lstat(join(fixture.stagingRoot, 'a.txt'))
    expect(staged.nlink).toBe(1)
  })

  it('refreshes ctimes after a hardlink seeding pass so the next scan stays stat-bound', async () => {
    const root = await tree({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'sub/c.txt': 'three\n' })
    await scanTree(root, {})
    // Simulate seeding a staging tree: hardlink every file (nlink+1 bumps ctime).
    const scratch = join(root, '..', `seed-${Date.now()}`)
    roots.push(scratch)
    await mkdir(scratch, { recursive: true })
    for (const rel of ['a.txt', 'b.txt', 'sub/c.txt']) {
      await link(join(root, rel), join(scratch, rel.replace('/', '_')))
    }
    // Let the bumped ctimes settle strictly before the refresh writes the
    // index: the trust rule is strict (`entry.ctime < writtenAt`), and a
    // same-tick collision would make exactly one entry untrusted.
    await new Promise(resolve => setTimeout(resolve, 5))
    const refreshed = await refreshScanIndex(root)
    expect(refreshed).not.toBeNull()
    expect(refreshed?.carried).toBe(3)
    expect(refreshed?.rehashed).toBe(0)
    const info: { state: string; trusted: number; hashed: number }[] = []
    await scanTree(root, { onIndex: entry => info.push(entry) })
    expect(info[0]?.hashed).toBe(0)
    expect(info[0]?.trusted).toBe(3)
  })

  it('budgets: the indexed scan does no content hashing and beats the cold scan', async () => {
    const root = await tree(sizedFiles(1500, 8 * 1024))
    const coldStarted = Date.now()
    const cold = await scanTree(root, { useIndex: false })
    const coldMs = Date.now() - coldStarted
    await scanTree(root, {})
    const indexedStarted = Date.now()
    const info: { hashed: number; trusted: number }[] = []
    const indexed = await scanTree(root, { onIndex: entry => info.push(entry) })
    const indexedMs = Date.now() - indexedStarted
    expect(indexed).toEqual(cold)
    expect(info[0]?.hashed).toBe(0)
    expect(info[0]?.trusted).toBe(1500)
    // Budget-shaped: stat-bound scanning must not cost more than hashing the
    // same tree (measured wall; generous for CI noise).
    expect(indexedMs).toBeLessThanOrEqual(Math.max(50, coldMs))
  })
})

async function hashOf(file: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const { readFile } = await import('node:fs/promises')
  return createHash('sha256').update(await readFile(file)).digest('hex')
}
