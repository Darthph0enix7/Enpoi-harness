import { describe, it, expect } from 'vitest'
import { fingerprintMessage, normalizeMessage, MAX_NORMALIZED_CHARS } from '../src/fingerprint.js'

describe('normalizeMessage', () => {
  it('strips uuids, numbers, paths, durations, and timestamps', () => {
    const normalized = normalizeMessage(
      'session 3f9a2c1e-8b7d-4a5f-9c3e-2d1b0a9f8e7d failed after 42ms at /home/user/.dsh/profiles/web/package.json on 2026-09-22T19:41:03.123Z with 17 retries',
    )
    expect(normalized).toContain('<uuid>')
    expect(normalized).toContain('<dur>')
    expect(normalized).toContain('<path>')
    expect(normalized).toContain('<ts>')
    expect(normalized).toContain('<n>')
    expect(normalized).not.toContain('3f9a2c1e')
    expect(normalized).not.toContain('42ms')
  })

  it('collapses whitespace and caps length', () => {
    expect(normalizeMessage('a\n\n   b\t\tc')).toBe('a b c')
    expect(normalizeMessage('x'.repeat(1000))).toHaveLength(MAX_NORMALIZED_CHARS)
  })

  it('is deterministic for equivalent messages', () => {
    const a = normalizeMessage('write /sessions/aaa.jsonl failed with code 5')
    const b = normalizeMessage('write /sessions/bbb.jsonl failed with code 9')
    expect(a).toBe(b)
  })
})

describe('fingerprintMessage', () => {
  it('is stable across occurrences with different ids and numbers', () => {
    const first = fingerprintMessage('tool-error:fs_read', 'ENOENT: no such file /tmp/x/1.txt (errno 2)')
    const second = fingerprintMessage('tool-error:fs_read', 'ENOENT: no such file /tmp/y/2.txt (errno 44)')
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.code).toBe(second.code)
  })

  it('separates subjects and messages', () => {
    const a = fingerprintMessage('tool-error:fs_read', 'boom')
    const b = fingerprintMessage('tool-error:fs_write', 'boom')
    const c = fingerprintMessage('tool-error:fs_read', 'other boom')
    expect(a.fingerprint).not.toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
  })

  it('formats the fingerprint and code predictably', () => {
    const value = fingerprintMessage('log:dsh-mcp', 'mcp mount failed')
    expect(value.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(value.code).toMatch(/^D[0-9A-F]{6}$/)
    expect(value.normalized).toBe('mcp mount failed')
  })
})
