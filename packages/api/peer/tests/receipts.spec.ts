import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerConfigError } from '../src/pairings.ts'
import { PeerReceiptStore, receiptKey } from '../src/receipts.ts'
import type { PeerSelectModelValue } from '../src/types.ts'

const atomicWrite = vi.hoisted(() => ({ fail: false }))

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return {
    ...actual,
    writeFileAtomic: async (
      path: string,
      content: string,
      options: Parameters<typeof actual.writeFileAtomic>[2],
    ) => {
      if (atomicWrite.fail) throw new Error('disk full')
      return actual.writeFileAtomic(path, content, options)
    },
  }
})

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'peer-receipts-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function valueOf(model: string): PeerSelectModelValue {
  return {
    accepted: true,
    selected: { provider: 'scripted', model },
    previous: { provider: 'scripted', model: 'mock' },
    replayed: false,
  }
}

describe('peer selectModel receipts', () => {
  it('stores, replays, and reloads one receipt from a private document', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-receipts.json')
    const store = new PeerReceiptStore(path, 8)
    expect(store.get(receiptKey('sess-1', 'req-1'))).toBeUndefined()
    await store.put(receiptKey('sess-1', 'req-1'), 'hash-1', valueOf('switched'))
    const receipt = store.get(receiptKey('sess-1', 'req-1'))
    expect(receipt).toMatchObject({ key: receiptKey('sess-1', 'req-1'), hash: 'hash-1', value: valueOf('switched') })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    // A fresh store over the same document keeps the receipt: a host restart
    // does not turn a caller retry into a second selection.
    const restarted = new PeerReceiptStore(path, 8)
    expect(restarted.get(receiptKey('sess-1', 'req-1'))?.value.selected).toEqual({
      provider: 'scripted',
      model: 'switched',
    })
    // An absent file is a fresh host, not an error.
    expect(new PeerReceiptStore(join(root, 'missing.json'), 8).get('nope')).toBeUndefined()
  })

  it('evicts the least recently used receipt beyond the limit', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-receipts.json')
    const store = new PeerReceiptStore(path, 2)
    await store.put('a', 'ha', valueOf('a'))
    await store.put('b', 'hb', valueOf('b'))
    // Reading `a` makes it newer than `b`.
    expect(store.get('a')).toBeDefined()
    await store.put('c', 'hc', valueOf('c'))
    expect(store.get('b')).toBeUndefined()
    expect(store.get('a')).toBeDefined()
    expect(store.get('c')).toBeDefined()
    const document = JSON.parse(readFileSync(path, 'utf8')) as { receipts: { key: string }[] }
    expect(document.receipts.map(receipt => receipt.key)).toEqual(['a', 'c'])
  })

  it('trims a document written under a higher limit to the configured bound', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-receipts.json')
    writeFileSync(path, JSON.stringify({
      version: 1,
      receipts: [
        { key: 'a', hash: 'ha', value: valueOf('a'), at: 1 },
        { key: 'b', hash: 'hb', value: valueOf('b'), at: 2 },
        { key: 'c', hash: 'hc', value: valueOf('c'), at: 3 },
      ],
    }))
    const store = new PeerReceiptStore(path, 1)
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBeDefined()
  })

  it('surfaces a write failure to the caller and keeps the chain usable', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-receipts.json')
    const store = new PeerReceiptStore(path, 8)
    atomicWrite.fail = true
    try {
      await expect(store.put('a', 'ha', valueOf('a'))).rejects.toThrow('disk full')
    } finally {
      atomicWrite.fail = false
    }
    // The in-memory entry stays usable; a later write persists the document.
    expect(store.get('a')?.hash).toBe('ha')
    await store.put('b', 'hb', valueOf('b'))
    expect(new PeerReceiptStore(path, 8).get('b')?.hash).toBe('hb')
  })

  it('rethrows a read failure that is not an absent document', () => {
    const root = tempRoot()
    // A directory at the document path fails the read with EISDIR, not ENOENT.
    expect(() => new PeerReceiptStore(root, 8).get('a')).toThrow(expect.objectContaining({ code: 'EISDIR' }))
  })

  it.each([
    ['invalid JSON', 'not json'],
    ['a wrong version', '{"version": 2, "receipts": []}'],
    ['a non-list receipts member', '{"version": 1, "receipts": {}}'],
    ['a non-object entry', '{"version": 1, "receipts": [42]}'],
    ['an entry missing fields', '{"version": 1, "receipts": [{"key": "a"}]}'],
    ['a non-object value', '{"version": 1, "receipts": [{"key": "a", "hash": "h", "at": 1, "value": 7}]}'],
    ['a value without a selection', '{"version": 1, "receipts": [{"key": "a", "hash": "h", "at": 1, "value": {}}]}'],
  ])('rejects a receipt document with %s', (_label, content) => {
    const root = tempRoot()
    const path = join(root, 'peer-receipts.json')
    writeFileSync(path, content)
    expect(() => new PeerReceiptStore(path, 8).get('a')).toThrow(PeerConfigError)
  })
})
