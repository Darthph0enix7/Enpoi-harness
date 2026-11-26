import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PeerConfigError } from '../src/pairings.ts'
import {
  PeerInputReceiptStore,
  PeerReceiptStore,
  createPayloadHash,
  deterministicCreateSessionId,
  inputReceiptKey,
  promptPayloadHash,
  receiptKey,
} from '../src/receipts.ts'
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
      expect(store.isPersisted('a')).toBe(false)
    } finally {
      atomicWrite.fail = false
    }
    // The in-memory entry stays usable; a later write persists the document.
    expect(store.get('a')?.hash).toBe('ha')
    await store.put('b', 'hb', valueOf('b'))
    expect(store.isPersisted('a')).toBe(true)
    expect(store.isPersisted('b')).toBe(true)
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

describe('peer input receipts', () => {
  it('writes 0600 write-ahead prepared receipts, finalizes them, and survives restart', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-input-receipts.json')
    const store = new PeerInputReceiptStore(path, 16, 64 * 1024)
    expect(store.tryOpen().ok).toBe(true)

    const sessionId = deterministicCreateSessionId('alpha', 'req-1')
    expect(sessionId).toMatch(/^peer-[0-9a-f]{32}$/u)
    expect(deterministicCreateSessionId('beta', 'req-1')).not.toBe(sessionId)

    const hash = createPayloadHash('alpha', { alias: 'alpha' as never, participant: { kind: 'peer', name: 'laptop' } })
    await store.prepare({
      kind: 'create',
      alias: 'alpha' as never,
      requestId: 'req-1' as never,
      payloadHash: hash,
      instanceId: 'inst-1',
      sessionId,
      acceptedAt: 100,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(store.get('create', 'alpha', 'req-1')).toMatchObject({
      phase: 'prepared',
      instanceId: 'inst-1',
      sessionId,
      payloadHash: hash,
    })

    await store.finalize({
      kind: 'create',
      alias: 'alpha' as never,
      requestId: 'req-1' as never,
      payloadHash: hash,
      instanceId: 'inst-1',
      sessionId,
      created: true,
      finalizedAt: 200,
    })

    const restarted = new PeerInputReceiptStore(path, 16, 64 * 1024)
    expect(restarted.tryOpen().ok).toBe(true)
    expect(restarted.get('create', 'alpha', 'req-1')).toMatchObject({
      phase: 'finalized',
      created: true,
      instanceId: 'inst-1',
      sessionId,
      payloadHash: hash,
      acceptedAt: 100,
      finalizedAt: 200,
    })
  })

  it('does not leave a phantom in-memory receipt when prepare fails to write', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-input-receipts.json')
    const store = new PeerInputReceiptStore(path, 16, 64 * 1024)
    const hash = promptPayloadHash('s1', [{ type: 'text', text: 'secret body' }])
    atomicWrite.fail = true
    try {
      await expect(store.prepare({
        kind: 'prompt',
        alias: 'alpha' as never,
        requestId: 'req-fail' as never,
        payloadHash: hash,
        instanceId: 'inst-1',
        sessionId: 's1' as never,
        acceptedAt: 100,
      })).rejects.toThrow('disk full')
    } finally {
      atomicWrite.fail = false
    }
    expect(store.get('prompt', 'alpha', 'req-fail')).toBeUndefined()
    // Prompt content is never persisted in the receipt file, only its hash.
    await store.prepare({
      kind: 'prompt',
      alias: 'alpha' as never,
      requestId: 'req-ok' as never,
      payloadHash: hash,
      instanceId: 'inst-1',
      sessionId: 's1' as never,
      acceptedAt: 101,
    })
    const disk = readFileSync(path, 'utf8')
    expect(disk).not.toContain('secret body')
    expect(disk).toContain(hash)
  })

  it('enforces LRU count and complete serialized byte limits including multibyte chars', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-input-receipts.json')
    const store = new PeerInputReceiptStore(path, 3, 64 * 1024)
    for (const id of ['r1', 'r2', 'r3']) {
      await store.prepare({
        kind: 'prompt',
        alias: 'alpha' as never,
        requestId: id as never,
        payloadHash: `h-${id}`,
        instanceId: 'inst-1',
        sessionId: 's1' as never,
        acceptedAt: 1,
      })
    }
    // Reading r1 marks it MRU so r2 is evicted when r4 is inserted.
    expect(store.get('prompt', 'alpha', 'r1')).toBeDefined()
    await store.prepare({
      kind: 'prompt',
      alias: 'alpha' as never,
      requestId: 'r4' as never,
      payloadHash: 'h-r4',
      instanceId: 'inst-1',
      sessionId: 's1' as never,
      acceptedAt: 2,
    })
    expect(store.get('prompt', 'alpha', 'r2')).toBeUndefined()
    expect(store.get('prompt', 'alpha', 'r1')).toBeDefined()

    // Byte bound measures complete serialized UTF-8 output and evicts oldest to fit.
    const singleEntry = {
      kind: 'prompt' as const,
      alias: 'α' as never,
      requestId: 'b1' as never,
      payloadHash: 'h1',
      instanceId: 'inst-1',
      sessionId: 's1' as never,
      acceptedAt: 1,
    }
    const oneByteDoc = `${JSON.stringify({ version: 1, receipts: [{ key: inputReceiptKey('prompt', 'α', 'b1'), phase: 'prepared', ...singleEntry }] })}\n`
    const oneByteLen = Buffer.byteLength(oneByteDoc, 'utf8')
    const byteBounded = new PeerInputReceiptStore(join(root, 'byte-bounded.json'), 100, oneByteLen)
    await byteBounded.prepare(singleEntry)
    await byteBounded.prepare({ ...singleEntry, requestId: 'b2' as never })
    expect(byteBounded.get('prompt', 'α', 'b1')).toBeUndefined()
    expect(byteBounded.get('prompt', 'α', 'b2')).toBeDefined()
    expect(Buffer.byteLength(readFileSync(join(root, 'byte-bounded.json'), 'utf8'), 'utf8')).toBeLessThanOrEqual(oneByteLen)

    // Oversized single entry fails loud without corrupting existing entries.
    const tooTiny = new PeerInputReceiptStore(join(root, 'byte-bounded.json'), 100, 16)
    await expect(tooTiny.prepare({ ...singleEntry, requestId: 'b3' as never })).rejects.toThrow(/maxBytes/u)
  })

  it('reports tryOpen failure on corrupt file or directory path', () => {
    const root = tempRoot()
    expect(new PeerInputReceiptStore(root, 8, 4096).tryOpen().ok).toBe(false)
    const corrupt = join(root, 'corrupt.json')
    writeFileSync(corrupt, '{bad')
    expect(new PeerInputReceiptStore(corrupt, 8, 4096).tryOpen().ok).toBe(false)
  })

  it('aborts prepared receipts and rolls back finalize/abortPrepared write failures', async () => {
    const root = tempRoot()
    const path = join(root, 'peer-input-receipts.json')
    const store = new PeerInputReceiptStore(path, 8, 64 * 1024)
    await store.prepare({
      kind: 'prompt',
      alias: 'alpha' as never,
      requestId: 'r-abort' as never,
      payloadHash: 'h1',
      instanceId: 'i1',
      sessionId: 's1' as never,
      acceptedAt: 10,
    })
    atomicWrite.fail = true
    try {
      await expect(store.finalize({
        kind: 'prompt',
        alias: 'alpha' as never,
        requestId: 'r-abort' as never,
        payloadHash: 'h1',
        instanceId: 'i1',
        sessionId: 's1' as never,
        finalizedAt: 20,
        queued: true,
        hopCount: 1,
      })).rejects.toThrow('disk full')
      expect(store.get('prompt', 'alpha', 'r-abort')?.phase).toBe('prepared')

      await expect(store.abortPrepared('prompt', 'alpha', 'r-abort')).rejects.toThrow('disk full')
      expect(store.get('prompt', 'alpha', 'r-abort')?.phase).toBe('prepared')
    } finally {
      atomicWrite.fail = false
    }
    await store.abortPrepared('prompt', 'alpha', 'r-abort')
    expect(store.get('prompt', 'alpha', 'r-abort')).toBeUndefined()
    // Aborting a non-existent or already-finalized receipt is a safe no-op.
    await store.abortPrepared('prompt', 'alpha', 'missing')
  })

  it.each([
    ['non-object root', '42'],
    ['wrong version', '{"version":2,"receipts":[]}'],
    ['non-array receipts', '{"version":1,"receipts":{}}'],
    ['non-object entry', '{"version":1,"receipts":[null]}'],
    ['missing required entry fields', '{"version":1,"receipts":[{"key":"k"}]}'],
    ['invalid finalizedAt', '{"version":1,"receipts":[{"key":"k","kind":"prompt","alias":"a","requestId":"r","payloadHash":"h","instanceId":"i","sessionId":"s","phase":"finalized","acceptedAt":1,"finalizedAt":"no"}]}'],
    ['invalid created flag', '{"version":1,"receipts":[{"key":"k","kind":"create","alias":"a","requestId":"r","payloadHash":"h","instanceId":"i","sessionId":"s","phase":"finalized","acceptedAt":1,"created":"yes"}]}'],
    ['invalid queued flag', '{"version":1,"receipts":[{"key":"k","kind":"prompt","alias":"a","requestId":"r","payloadHash":"h","instanceId":"i","sessionId":"s","phase":"finalized","acceptedAt":1,"queued":"yes"}]}'],
    ['invalid hopCount', '{"version":1,"receipts":[{"key":"k","kind":"prompt","alias":"a","requestId":"r","payloadHash":"h","instanceId":"i","sessionId":"s","phase":"finalized","acceptedAt":1,"hopCount":1.5}]}'],
  ])('rejects an input receipt document with %s', (_label, content) => {
    const root = tempRoot()
    const path = join(root, 'peer-input-receipts.json')
    writeFileSync(path, content)
    expect(() => new PeerInputReceiptStore(path, 8, 4096).get('prompt', 'a', 'r')).toThrow(PeerConfigError)
  })
})
