import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { fetchCatalog, parseCatalogDocument, readInstallIdentity, type CatalogEntry } from '../src/catalog.js'

const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'enpoi-update-check-spec-'))
  cleanups.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

function entry(overrides: Partial<Record<keyof CatalogEntry, unknown>> = {}): Record<string, unknown> {
  return {
    version: '0.1.7-enpoi.2.84',
    commit: 'abc1234',
    releasedAt: '2026-10-13T12:00:00.000Z',
    notes: ['fix(update): one'],
    ...overrides,
  }
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    channel: 'stable',
    generatedAt: '2026-10-13T12:00:00.000Z',
    releases: [entry()],
    ...overrides,
  }
}

function fakeFetch(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch
}

describe('parseCatalogDocument', () => {
  it('accepts a well-formed document for the expected channel', () => {
    const entries = parseCatalogDocument(document(), 'stable')
    expect(entries).toHaveLength(1)
    expect(entries?.[0]?.version).toBe('0.1.7-enpoi.2.84')
    expect(entries?.[0]?.notes).toEqual(['fix(update): one'])
  })

  it('rejects a wrong schema version, wrong channel, or missing releases', () => {
    expect(parseCatalogDocument(document({ schemaVersion: 2 }), 'stable')).toBeNull()
    expect(parseCatalogDocument(document({ channel: 'beta' }), 'stable')).toBeNull()
    expect(parseCatalogDocument(document({ releases: 'nope' }), 'stable')).toBeNull()
    expect(parseCatalogDocument('{"schemaVersion":1}', 'stable')).toBeNull()
    expect(parseCatalogDocument(null, 'stable')).toBeNull()
  })

  it('drops invalid entries and rejects a document with none left', () => {
    const mixed = document({ releases: [entry(), { version: '' }, { version: 'x', notes: 'no' }] })
    expect(parseCatalogDocument(mixed, 'stable')).toHaveLength(1)
    expect(parseCatalogDocument(document({ releases: [{ version: 'x', notes: [1] }] }), 'stable')).toBeNull()
    expect(parseCatalogDocument(document({ releases: [] }), 'stable')).toBeNull()
  })
})

describe('fetchCatalog', () => {
  it('passes cache-busting query parameter and headers to bypass CDN caching', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input)
      capturedHeaders = init?.headers as Record<string, string>
      return new Response(JSON.stringify(document({ channel: 'stable' })), { status: 200 })
    }) as typeof fetch

    const entries = await fetchCatalog('stable', mockFetch)
    expect(entries).toHaveLength(1)
    expect(capturedUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.*\/stable\.json\?t=\d+$/)
    expect(capturedHeaders?.['cache-control']).toBe('no-cache, no-store')
  })

  it('returns the validated entries from a 200 response', async () => {
    const entries = await fetchCatalog('beta', fakeFetch(200, JSON.stringify(document({ channel: 'beta' }))))
    expect(entries).toHaveLength(1)
  })

  it('rejects a non-2xx response', async () => {
    await expect(fetchCatalog('stable', fakeFetch(404, 'not found'))).rejects.toThrow(/HTTP 404/)
  })

  it('rejects invalid JSON and malformed documents', async () => {
    await expect(fetchCatalog('stable', fakeFetch(200, '{ broken'))).rejects.toThrow(/invalid JSON/)
    await expect(fetchCatalog('stable', fakeFetch(200, JSON.stringify(document({ channel: 'beta' }))))).rejects.toThrow(/malformed/)
  })

  it('propagates a transport failure (offline)', async () => {
    const offline = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    await expect(fetchCatalog('stable', offline)).rejects.toThrow('fetch failed')
  })
})

describe('readInstallIdentity', () => {
  function writeState(home: string, state: Record<string, unknown>): void {
    mkdirSync(join(home, 'harness'), { recursive: true })
    writeFileSync(join(home, 'harness', 'install-state.json'), JSON.stringify(state))
  }

  it('reads channel, version, and commit from install-state.json', () => {
    const home = scratch()
    writeState(home, { channel: 'beta', version: '0.1.7-enpoi.2.42', commit: 'abc1234' })
    expect(readInstallIdentity(home)).toEqual({ channel: 'beta', version: '0.1.7-enpoi.2.42', commit: 'abc1234' })
  })

  it('defaults an unknown channel to stable', () => {
    const home = scratch()
    writeState(home, { channel: 'gamma', version: '0.1.7-enpoi.2.42', commit: 'abc1234' })
    expect(readInstallIdentity(home).channel).toBe('stable')
  })

  it('falls back to the harness package.json version', () => {
    const home = scratch()
    writeState(home, { channel: 'stable', commit: '' })
    mkdirSync(join(home, 'harness', 'current'), { recursive: true })
    writeFileSync(join(home, 'harness', 'current', 'package.json'), JSON.stringify({ version: '0.1.7-enpoi.2' }))
    expect(readInstallIdentity(home)).toEqual({ channel: 'stable', version: '0.1.7-enpoi.2', commit: '' })
  })

  it('honors the recorded prefix for the package.json fallback', () => {
    const home = scratch()
    const prefix = scratch()
    writeState(home, { channel: 'stable', prefix, version: '', commit: 'abc1234' })
    mkdirSync(join(prefix, 'harness', 'current'), { recursive: true })
    writeFileSync(join(prefix, 'harness', 'current', 'package.json'), JSON.stringify({ version: '0.1.7-enpoi.9' }))
    expect(readInstallIdentity(home).version).toBe('0.1.7-enpoi.9')
  })

  it('returns an empty, stable identity when nothing is readable', () => {
    expect(readInstallIdentity(join(scratch(), 'absent'))).toEqual({ channel: 'stable', version: '', commit: '' })
  })
})
