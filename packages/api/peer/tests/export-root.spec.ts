import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ensureSessionExportDir,
  fetchSessionExport,
  listSessionExports,
} from '../src/export-root.ts'

const fsRaceHook = vi.hoisted(() => ({ onReadPath: undefined as string | undefined }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readSync: (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      if (fsRaceHook.onReadPath !== undefined) {
        const target = fsRaceHook.onReadPath
        fsRaceHook.onReadPath = undefined
        actual.appendFileSync(target, 'extra')
      }
      return actual.readSync(fd, buffer, offset, length, position)
    },
  }
})

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'peer-export-root-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('export root containment and bounded fetch', () => {
  it('creates 0700 per-session directory and refuses symlinked roots', () => {
    const root = tempRoot()
    const exportRoot = join(root, 'exports')
    const sessionDir = ensureSessionExportDir(exportRoot, 'peer-abc' as SessionId)
    expect(sessionDir).toBe(join(exportRoot, 'peer-abc'))
    expect(statSync(exportRoot).mode & 0o777).toBe(0o700)
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700)

    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    const linkedRoot = join(root, 'linked-root')
    symlinkSync(outside, linkedRoot)
    expect(() => ensureSessionExportDir(linkedRoot, 'peer-abc' as SessionId)).toThrow(RemoteError)
  })

  it('lists only regular files with relative paths and enforces count and byte limits', () => {
    const root = tempRoot()
    const exportRoot = join(root, 'exports')
    const sessionId = 'peer-list-1' as SessionId
    const sessionDir = ensureSessionExportDir(exportRoot, sessionId)
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')

    mkdirSync(join(sessionDir, 'sub'), { recursive: true })
    writeFileSync(join(sessionDir, 'a.txt'), 'hello')
    writeFileSync(join(sessionDir, 'sub', 'b-ümlaut.txt'), 'world!')
    writeFileSync(join(sessionDir, 'c.txt'), 'more')
    symlinkSync(join(outside, 'secret.txt'), join(sessionDir, 'evil-link.txt'))
    symlinkSync(outside, join(sessionDir, 'evil-dir'))

    const full = listSessionExports(exportRoot, sessionId, { maxFiles: 100, maxBytes: 64 * 1024 })
    expect(full.truncated).toBe(false)
    expect(full.files.map(f => f.path)).toEqual(['a.txt', 'c.txt', 'sub/b-ümlaut.txt'])

    const countBounded = listSessionExports(exportRoot, sessionId, { maxFiles: 2, maxBytes: 64 * 1024 })
    expect(countBounded.truncated).toBe(true)
    expect(countBounded.files).toHaveLength(2)

    const oneEntryBytes = Buffer.byteLength(
      JSON.stringify({ files: [full.files[0]], truncated: true }),
      'utf8',
    )
    const byteBounded = listSessionExports(exportRoot, sessionId, { maxFiles: 100, maxBytes: oneEntryBytes })
    expect(byteBounded.truncated).toBe(true)
    expect(byteBounded.files).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(byteBounded), 'utf8')).toBeLessThanOrEqual(oneEntryBytes)
  })

  it('fetches regular files with sha256 and refuses traversal, symlinks, non-regulars, oversize, and concurrent size changes', () => {
    const root = tempRoot()
    const exportRoot = join(root, 'exports')
    const sessionId = 'peer-fetch-1' as SessionId
    const sessionDir = ensureSessionExportDir(exportRoot, sessionId)
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')

    mkdirSync(join(sessionDir, 'nested'), { recursive: true })
    const payload = Buffer.from('hello export bytes', 'utf8')
    writeFileSync(join(sessionDir, 'nested', 'out.txt'), payload)
    symlinkSync(join(outside, 'secret.txt'), join(sessionDir, 'link.txt'))
    symlinkSync(outside, join(sessionDir, 'dirlink'))

    const fetched = fetchSessionExport(exportRoot, sessionId, 'nested/out.txt', { maxBytes: 1024 })
    expect(fetched).toEqual({
      path: 'nested/out.txt',
      bytes: payload.byteLength,
      sha256: createHash('sha256').update(payload).digest('hex'),
      contentBase64: payload.toString('base64'),
    })

    for (const badPath of ['/etc/passwd', '../outside/secret.txt', 'nested/../out.txt', 'a\u0000b', 'nested\\out.txt', 'nested//out.txt', '.']) {
      expect(() => fetchSessionExport(exportRoot, sessionId, badPath, { maxBytes: 1024 }))
        .toThrow(RemoteError)
    }

    // Symlinks in leaf or intermediate components are refused.
    expect(() => fetchSessionExport(exportRoot, sessionId, 'link.txt', { maxBytes: 1024 }))
      .toThrow(expect.objectContaining({ code: 'peer/forbidden', details: { reason: 'export-symlink' } }))
    expect(() => fetchSessionExport(exportRoot, sessionId, 'dirlink/secret.txt', { maxBytes: 1024 }))
      .toThrow(expect.objectContaining({ code: 'peer/forbidden', details: { reason: 'export-symlink' } }))

    // Directory (non-regular) is refused.
    expect(() => fetchSessionExport(exportRoot, sessionId, 'nested', { maxBytes: 1024 }))
      .toThrow(expect.objectContaining({ code: 'peer/forbidden', details: { reason: 'export-not-regular-file' } }))

    // Oversize against Config or requested maxBytes is refused.
    expect(() => fetchSessionExport(exportRoot, sessionId, 'nested/out.txt', { maxBytes: 4 }))
      .toThrow(expect.objectContaining({ code: 'peer/forbidden', details: { reason: 'export-oversize' } }))
    expect(() => fetchSessionExport(exportRoot, sessionId, 'nested/out.txt', { maxBytes: 1024, requestedMaxBytes: 4 }))
      .toThrow(expect.objectContaining({ code: 'peer/forbidden', details: { reason: 'export-oversize' } }))

    // Missing file is peer/not-found.
    expect(() => fetchSessionExport(exportRoot, sessionId, 'missing.txt', { maxBytes: 1024 }))
      .toThrow(expect.objectContaining({ code: 'peer/not-found' }))

    // Size change between stat and read is rejected.
    const racedPath = join(sessionDir, 'raced.txt')
    writeFileSync(racedPath, 'initial')
    fsRaceHook.onReadPath = racedPath
    try {
      expect(() => fetchSessionExport(exportRoot, sessionId, 'raced.txt', { maxBytes: 1024 }))
        .toThrow(expect.objectContaining({ code: 'peer/conflict', details: { reason: 'export-size-changed' } }))
    } finally {
      fsRaceHook.onReadPath = undefined
    }
  })
})
