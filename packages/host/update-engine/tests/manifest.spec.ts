/**
 * Manifest utility pins: scan hashing rules (files, symlinks by target,
 * directories, binary probe), mode recording, deterministic serialization,
 * schema validation, and ignore globs.
 */

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hashBytes,
  parseManifest,
  readManifest,
  scanTree,
  serializeManifest,
  writeManifest,
} from '../src/manifest.ts'
import { matchGlob } from '../src/glob.ts'
import { entry, tempRoot, writeTree } from './fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<string> {
  const root = await tempRoot('manifest')
  roots.push(root)
  return root
}

describe('scanTree', () => {
  it('records hashes, modes, symlink targets, directories, and binary flags', async () => {
    const root = await fixtureRoot()
    await writeTree(root, {
      'core/app.js': { content: 'export const x = 1\n', mode: 0o640 },
      'bin/tool.sh': { content: '#!/bin/sh\n', mode: 0o755 },
      'blob.bin': Buffer.from([0x00, 0x01, 0x02]),
      'link': { symlink: 'core/app.js' },
      'empty': { dir: true },
    })
    const manifest = await scanTree(root)

    expect(entry(manifest, 'core/app.js').sha256).toBe(hashBytes('export const x = 1\n'))
    expect(entry(manifest, 'core/app.js').mode).toBe(0o640)
    expect(entry(manifest, 'core/app.js').binary).toBe(false)
    expect(entry(manifest, 'bin/tool.sh').mode).toBe(0o755)
    expect(entry(manifest, 'blob.bin').binary).toBe(true)
    expect(entry(manifest, 'link').type).toBe('symlink')
    expect(entry(manifest, 'link').target).toBe('core/app.js')
    expect(entry(manifest, 'link').sha256).toBe(hashBytes('core/app.js'))
    expect(entry(manifest, 'empty').type).toBe('dir')
    expect(entry(manifest, 'empty').sha256).toBeNull()
  })

  it('is deterministic regardless of directory entry order', async () => {
    const root = await fixtureRoot()
    await writeTree(root, { 'b.txt': 'b', 'a.txt': 'a', 'dir/c.txt': 'c' })
    const first = await scanTree(root)
    const second = await scanTree(root)
    expect(serializeManifest(first)).toBe(serializeManifest(second))
    expect(Object.keys(first)).toEqual(['a.txt', 'b.txt', 'dir', 'dir/c.txt'])
  })

  it('skips ignored subtrees', async () => {
    const root = await fixtureRoot()
    await writeTree(root, { 'keep.txt': 'keep', 'node_modules/dep/index.js': 'dep', 'cache/x': 'x' })
    const manifest = await scanTree(root, { ignore: ['node_modules', 'cache'] })
    expect(Object.keys(manifest)).toEqual(['keep.txt'])
    const childrenOnly = await scanTree(root, { ignore: ['node_modules/**'] })
    expect(Object.keys(childrenOnly)).toEqual(['cache', 'cache/x', 'keep.txt', 'node_modules'])
  })
})

describe('manifest serialization', () => {
  it('round-trips through write and read byte-identically', async () => {
    const root = await fixtureRoot()
    await writeTree(root, { 'a.txt': 'a', 'b.txt': 'b' })
    const manifest = await scanTree(root)
    const manifestPath = `${root}/manifest.json`
    await writeManifest(manifestPath, manifest)
    const reloaded = await readManifest(manifestPath)
    expect(serializeManifest(reloaded)).toBe(serializeManifest(manifest))
    expect(serializeManifest(reloaded).endsWith('\n')).toBe(true)
  })

  it('rejects unsafe paths and malformed entries', () => {
    expect(() => parseManifest(JSON.stringify({ '../evil': {} }), 'test')).toThrow(/unsafe manifest path/u)
    expect(() => parseManifest(JSON.stringify({ a: { sha256: 1, size: 0, type: 'file', mode: 0 } }), 'test')).toThrow(/sha256/u)
    expect(() => parseManifest(JSON.stringify({ a: { sha256: null, size: 0, type: 'socket', mode: 0 } }), 'test')).toThrow(/unknown type/u)
    expect(() => parseManifest('{not json', 'test')).toThrow(/invalid JSON/u)
  })

  it('accepts octal mode strings from external manifests', () => {
    const manifest = parseManifest(JSON.stringify({
      a: { sha256: hashBytes('x'), size: 1, type: 'file', mode: '0644', target: null },
    }), 'test')
    expect(entry(manifest, 'a').mode).toBe(0o644)
  })
})

describe('matchGlob', () => {
  it('matches segment and recursive wildcards', () => {
    expect(matchGlob('core/*.js', 'core/app.js')).toBe(true)
    expect(matchGlob('core/*.js', 'core/nested/app.js')).toBe(false)
    expect(matchGlob('**/*.js', 'core/nested/app.js')).toBe(true)
    expect(matchGlob('core/**', 'core/nested/app.js')).toBe(true)
    expect(matchGlob('core/app.js', 'core/app.js')).toBe(true)
    expect(matchGlob('core/app.js', 'core/other.js')).toBe(false)
    expect(matchGlob('profile?', 'profiles')).toBe(true)
  })
})
