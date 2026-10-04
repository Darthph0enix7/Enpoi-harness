import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MESSAGE_CHARS } from '../src/store.js'
import { IncidentStore } from '../src/store.js'

let root: string
let store: IncidentStore | undefined

function open(options: { maxIncidents?: number; maxPatterns?: number; cooldownMs?: number; now?: () => number } = {}): IncidentStore {
  store = new IncidentStore(join(root, 'diagnostics', 'incidents.sqlite'), options)
  return store
}

function incident(overrides: Partial<Parameters<IncidentStore['record']>[0]> = {}): Parameters<IncidentStore['record']>[0] {
  return {
    severity: 'error',
    source: 'session',
    kind: 'tool-error',
    code: 'ENOENT',
    fingerprint: 'aaaaaaaaaaaaaaaa',
    message: 'ENOENT: no such file /tmp/a.txt',
    ...overrides,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diag-store-'))
})

afterEach(() => {
  store?.close()
  store = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('IncidentStore', () => {
  it('creates the sqlite file and both tables', () => {
    const s = open()
    const path = join(root, 'diagnostics', 'incidents.sqlite')
    expect(s.path).toBe(path)
    expect(existsSync(path)).toBe(true)
    expect(s.stats()).toMatchObject({ incidents: 0, patterns: 0 })
  })

  it('writes one incident and one pattern on first sighting', () => {
    const s = open()
    s.record(incident())
    const incidents = s.incidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({ severity: 'error', count: 1, fingerprint: 'aaaaaaaaaaaaaaaa' })
    const patterns = s.patterns()
    expect(patterns).toHaveLength(1)
    expect(patterns[0]).toMatchObject({ count: 1, firstSeen: incidents[0].at, lastSeen: incidents[0].at, upgradedAt: null })
  })

  it('aggregates a repeat inside the cooldown bucket instead of flooding rows', () => {
    const s = open({ cooldownMs: 60_000 })
    s.record(incident({ at: 1_000 }))
    s.record(incident({ at: 2_000 }))
    s.record(incident({ at: 3_000 }))
    const incidents = s.incidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0].count).toBe(3)
    const patterns = s.patterns()
    expect(patterns[0].count).toBe(3)
    expect(patterns[0].sources).toEqual(['session'])
  })

  it('opens a new row when the cooldown bucket expires', () => {
    const s = open({ cooldownMs: 1_000 })
    s.record(incident({ at: 0 }))
    s.record(incident({ at: 500 }))
    s.record(incident({ at: 1_500 }))
    const incidents = s.incidents()
    expect(incidents).toHaveLength(2)
    expect(incidents.map(row => row.count).sort()).toEqual([1, 2])
    expect(s.patterns()[0].count).toBe(3)
  })

  it('computes sliding windows at query time', () => {
    const now = 10_000_000
    const s = open({ cooldownMs: 0, now: () => now })
    s.record(incident({ at: now - 30 * 60_000, fingerprint: 'bbbbbbbbbbbbbbbb' })) // 30 min ago
    s.record(incident({ at: now - 3 * 3_600_000, fingerprint: 'bbbbbbbbbbbbbbbb' })) // 3 h ago
    s.record(incident({ at: now - 3 * 86_400_000, fingerprint: 'bbbbbbbbbbbbbbbb' })) // 3 d ago
    const [pattern] = s.patterns({ window: '1h' })
    expect(pattern.count).toBe(3)
    expect(pattern.windowCount).toBe(1)
    expect(s.patterns({ window: '24h' })[0].windowCount).toBe(2)
    expect(s.patterns({ window: '7d' })[0].windowCount).toBe(3)
    expect(s.patterns({ window: 'all' })[0].windowCount).toBe(3)
  })

  it('upgrades severity_max and records upgraded_at', () => {
    const s = open({ cooldownMs: 0 })
    s.record(incident({ at: 10, severity: 'warn' }))
    const before = s.patterns()[0]
    expect(before.severityMax).toBe('warn')
    expect(before.upgradedAt).toBeNull()
    s.record(incident({ at: 20, severity: 'fatal' }))
    const after = s.patterns()[0]
    expect(after.severityMax).toBe('fatal')
    expect(after.upgradedAt).toBe(20)
  })

  it('truncates messages to the documented cap', () => {
    const s = open()
    s.record(incident({ message: 'x'.repeat(2000) }))
    expect(s.incidents()[0].message).toHaveLength(MAX_MESSAGE_CHARS)
    expect(s.patterns()[0].sampleMessage).toHaveLength(MAX_MESSAGE_CHARS)
  })

  it('mutes by fingerprint without dropping data', () => {
    const s = open()
    s.record(incident())
    expect(s.patterns()).toHaveLength(1)
    const muted = s.mute('aaaaaaaaaaaaaaaa', true)
    expect(muted).toEqual({ ok: true, muted: true })
    expect(s.patterns()).toHaveLength(0)
    expect(s.patterns({ includeMuted: true })).toHaveLength(1)
    expect(s.incidents()).toHaveLength(0)
    expect(s.incidents({ includeMuted: true })).toHaveLength(1)
    expect(s.mute('aaaaaaaaaaaaaaaa', false)).toEqual({ ok: true, muted: false })
    expect(s.patterns()).toHaveLength(1)
    expect(s.mute('does-not-exist')).toEqual({ ok: false, muted: false, note: 'unknown fingerprint' })
    expect(s.stats().muted).toBe(0)
  })

  it('caps incident rows and evicts the oldest first', () => {
    const s = open({ maxIncidents: 5, cooldownMs: 0 })
    for (let index = 0; index < 20; index += 1) {
      s.record(incident({ at: index, fingerprint: `fp${String(index).padStart(14, '0')}`, message: `failure ${String(index)}` }))
    }
    expect(s.stats().incidents).toBe(5)
    const rows = s.incidents({ limit: 10 })
    expect(rows).toHaveLength(5)
    // The newest five survive; the oldest fifteen were evicted.
    expect(rows[0].message).toBe('failure 19')
    expect(rows[4].message).toBe('failure 15')
  })

  it('caps pattern rows and evicts the least recently seen', () => {
    const s = open({ maxPatterns: 3, cooldownMs: 0 })
    for (let index = 0; index < 10; index += 1) {
      s.record(incident({ at: index, fingerprint: `fp${String(index).padStart(14, '0')}` }))
    }
    expect(s.stats().patterns).toBe(3)
    const patterns = s.patterns({ limit: 10 })
    expect(patterns.map(row => row.fingerprint)).toEqual([
      'fp00000000000009',
      'fp00000000000008',
      'fp00000000000007',
    ])
  })

  it('does not store prompt content: only bounded formatted text columns', () => {
    const s = open()
    s.record(incident({ context: { note: 'structured only' } }))
    const row = s.incidents()[0]
    expect(Object.keys(row).sort()).toEqual([
      'at', 'code', 'context', 'count', 'fingerprint', 'id', 'kind', 'message', 'model', 'provider', 'sessionId', 'severity', 'source',
    ])
    expect(row.context).toEqual({ note: 'structured only' })
  })

  it('stops accepting writes after close', () => {
    const s = open()
    s.close()
    expect(s.isOpen).toBe(false)
    expect(() => s.record(incident())).toThrow()
    expect(s.patterns()).toEqual([])
  })
})
