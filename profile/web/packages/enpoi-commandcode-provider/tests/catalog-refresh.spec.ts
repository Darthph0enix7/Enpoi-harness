/**
 * Snapshot refresh: the owner path re-fetches the keypool catalog, validates
 * it whole, backs the previous snapshot up, and writes the new file plus its
 * version/fetchedAt stamp. A failure leaves both files untouched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  readSnapshotStamp,
  refreshCatalogSnapshot,
  snapshotMetaPath,
  validateCatalogPayload,
} from '../src/catalog-refresh.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-catalog-'))
  scratch.push(dir)
  return dir
}

const PAYLOAD = [
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro [Go+]' },
  { id: 'vision/model', name: 'Vision Model [Max]' },
]

it('validates a payload whole before it may replace the snapshot', () => {
  expect(validateCatalogPayload(PAYLOAD).map(row => row.id)).toEqual(['deepseek/deepseek-v4-pro', 'vision/model'])
  expect(() => validateCatalogPayload(null)).toThrow('non-empty array')
  expect(() => validateCatalogPayload([])).toThrow('non-empty array')
  expect(() => validateCatalogPayload({ a: PAYLOAD[0] })).toThrow('non-empty array')
  expect(() => validateCatalogPayload([{ name: 'no id' }])).toThrow('without an id')
  expect(() => validateCatalogPayload([{ id: 'x' }])).toThrow('has no name')
  expect(() => validateCatalogPayload(['nope'])).toThrow('non-object row')
})

it('refreshes the snapshot: validates, backs up the previous file, and stamps version/fetchedAt', async () => {
  const dir = scratchDir()
  const snapshotPath = join(dir, 'catalog.snapshot.json')
  const original = JSON.stringify([{ id: 'old/model', name: 'Old' }])
  writeFileSync(snapshotPath, original, 'utf8')
  writeFileSync(
    snapshotMetaPath(snapshotPath),
    JSON.stringify({ version: 4, fetchedAt: '2026-01-01T00:00:00.000Z', entryCount: 1 }),
    'utf8',
  )

  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PAYLOAD)))
  const outcome = await refreshCatalogSnapshot({
    baseURL: 'http://127.0.0.1:8899/commandcode/',
    snapshotPath,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  })

  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.stamp).toEqual({
    version: 5,
    fetchedAt: '2026-10-08T12:00:00.000Z',
    entryCount: 2,
    source: 'http://127.0.0.1:8899/commandcode/catalog.json',
  })
  expect(outcome.backupPath).toBe(`${snapshotPath}.bak`)
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8899/commandcode/catalog.json')
  // The previous snapshot is preserved byte-for-byte in the backup.
  expect(readFileSync(outcome.backupPath!, 'utf8')).toBe(original)
  // The new snapshot is the validated payload and its sidecar carries the stamp.
  expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual(PAYLOAD)
  expect(readSnapshotStamp(snapshotPath)).toEqual(outcome.stamp)
})

it('leaves the previous snapshot and stamp untouched when the fetch or payload is invalid', async () => {
  const dir = scratchDir()
  const snapshotPath = join(dir, 'catalog.snapshot.json')
  const original = JSON.stringify([{ id: 'old/model', name: 'Old' }])
  writeFileSync(snapshotPath, original, 'utf8')
  writeFileSync(
    snapshotMetaPath(snapshotPath),
    JSON.stringify({ version: 4, fetchedAt: '2026-01-01T00:00:00.000Z', entryCount: 1 }),
    'utf8',
  )

  const refused = await refreshCatalogSnapshot({
    baseURL: 'http://127.0.0.1:8899/commandcode',
    snapshotPath,
    fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
  })
  expect(refused.ok).toBe(false)

  const malformed = await refreshCatalogSnapshot({
    baseURL: 'http://127.0.0.1:8899/commandcode',
    snapshotPath,
    fetchImpl: (async () => new Response(JSON.stringify([{ name: 'no id' }]))) as unknown as typeof fetch,
  })
  expect(malformed.ok).toBe(false)
  if (!malformed.ok) expect(malformed.error).toContain('without an id')

  const failedHttp = await refreshCatalogSnapshot({
    baseURL: 'http://127.0.0.1:8899/commandcode',
    snapshotPath,
    fetchImpl: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch,
  })
  expect(failedHttp.ok).toBe(false)

  expect(readFileSync(snapshotPath, 'utf8')).toBe(original)
  expect(readSnapshotStamp(snapshotPath)?.version).toBe(4)
})

it('reads a missing or malformed stamp as unstamped', () => {
  const dir = scratchDir()
  const snapshotPath = join(dir, 'catalog.snapshot.json')
  expect(readSnapshotStamp(snapshotPath)).toBeUndefined()
  writeFileSync(snapshotMetaPath(snapshotPath), '{ not json', 'utf8')
  expect(readSnapshotStamp(snapshotPath)).toBeUndefined()
  writeFileSync(snapshotMetaPath(snapshotPath), JSON.stringify({ version: 0, fetchedAt: '', entryCount: -1 }), 'utf8')
  expect(readSnapshotStamp(snapshotPath)).toBeUndefined()
})

it('starts a fresh version counter and skips the backup when no snapshot exists', async () => {
  const dir = scratchDir()
  const snapshotPath = join(dir, 'catalog.snapshot.json')
  const outcome = await refreshCatalogSnapshot({
    baseURL: 'http://127.0.0.1:8899/commandcode',
    snapshotPath,
    fetchImpl: (async () => new Response(JSON.stringify(PAYLOAD))) as unknown as typeof fetch,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.stamp.version).toBe(1)
  expect(outcome.backupPath).toBeUndefined()
})
