/** Durable V4-to-V5 migration: read-only preparation, exclusive successor publication, and refusal. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generationLogPath, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'

const id = SessionId('v4-to-v5')
const config = { provider: 'mock', model: 'mock' }
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function identity(path: string) {
  const info = await stat(path, { bigint: true })
  return { bytes: await readFile(path), dev: info.dev, ino: info.ino, mtime: info.mtimeNs, ctime: info.ctimeNs }
}

function userMessage(text: string, source: Record<string, unknown>) {
  return {
    id: text, role: 'user', source,
    content: [{ type: 'text', text }],
  }
}

/** One canonical V4 log carrying legacy producers, an old approval outcome, and a V4 delivery marker. */
function v4Rows(): Record<string, unknown>[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', seq: 2, time: 3, surfaceOp: 'append',
      data: userMessage('legacy approval', { kind: 'user-approval', approvalId: 'approval' }),
    },
    { type: 'approval/decided', seq: 3, time: 4, data: { id: 'approval', outcome: 'allowed-always' } },
    {
      type: 'request/header', seq: 4, time: 5,
      data: { header: { config }, reason: 'initial' },
    },
    {
      type: 'assistant/message', seq: 5, time: 6, surfaceOp: 'append',
      data: {
        turn: 1, step: 1,
        message: { id: 'answer', role: 'assistant', source: { kind: 'model', ...config }, content: [{ type: 'text', text: 'ok' }] },
        stream: [],
      },
    },
    { type: 'step/end', seq: 6, time: 7, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
    {
      type: 'session-log-deepseek/delivery-accepted', seq: 8, time: 9,
      data: { sessionId: id, throughSeq: 7, sessionFormatVersion: 4 },
    },
  ]
}

async function fixture(compression: JsonlCompression, mutate?: (rows: readonly Record<string, unknown>[]) => string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v4-to-v5-'))
  roots.push(root)
  const path = generationLogPath(root, undefined, id, 4, compression)
  const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const headerLine = JSON.stringify(header) + '\n'
  const rows = v4Rows()
  const body = mutate === undefined ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : mutate(rows)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, compression === 'none'
    ? Buffer.from(headerLine + body)
    : Buffer.concat([await compressZstdFrame(headerLine), await compressZstdFrame(body)]))
  async function mount() {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression })
    return ctx
  }
  return { compression, root, path, headerLine, rows, mount }
}

async function files(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).filter(name => name !== 'session.lock').sort()
}

describe.each(['none', 'zstd'] as const)('V4-to-V5 persistence (%s)', (compression) => {
  it('read open returns V5 without publishing a successor', async () => {
    const f = await fixture(compression)
    const original = await identity(f.path)
    const before = await files(f.path)
    const ctx = await f.mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      expect(reader.header.version).toBe(5)
      const result = await reader.read()
      expect(result.events).toEqual(f.rows)
      expect(result.events[2]).toMatchObject({ data: { source: { kind: 'user-approval' } } })
      expect(result.events[3]).toMatchObject({ data: { outcome: 'allowed-always' } })
      expect(result.events[8]).toMatchObject({ data: { sessionFormatVersion: 4 } })
    } finally {
      await reader.close()
    }
    expect(await files(f.path)).toEqual(before)
    expect(await identity(f.path)).toEqual(original)
  })

  it('write open publishes exactly one V5 successor beside the unchanged V4 source', async () => {
    const f = await fixture(compression)
    const original = await identity(f.path)
    const ctx = await f.mount()
    const writer = await ctx.sessionPersistence.open(id, 'write')
    const migrated = await writer.read()
    await writer.flush()
    await writer.close()

    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`, `session.v5${suffix}`])
    expect(await identity(f.path)).toEqual(original)
    const successor = generationLogPath(f.root, undefined, id, 5, compression)
    const successorBytes = await readFile(successor)
    let headerBytes: Buffer = successorBytes
    if (compression !== 'none') {
      const firstFrame = scanZstdFrames(successorBytes).frames[0]
      if (firstFrame === undefined) throw new Error('successor lacks a complete Zstandard frame')
      headerBytes = await decompressZstdFrame(successorBytes.subarray(firstFrame.start, firstFrame.end))
    }
    expect(JSON.parse(headerBytes.toString('utf8').split('\n')[0] as string)).toMatchObject({ version: 5 })
    expect(migrated.events).toEqual(f.rows)
  })

  it('second write open and a fresh context reuse the published successor without rewriting it', async () => {
    const f = await fixture(compression)
    const ctx = await f.mount()
    const first = await ctx.sessionPersistence.open(id, 'write')
    const events = (await first.read()).events
    await first.flush()
    await first.close()
    const successor = generationLogPath(f.root, undefined, id, 5, compression)
    const published = await identity(successor)

    const second = await ctx.sessionPersistence.open(id, 'write')
    try { expect((await second.read()).events).toEqual(events) } finally { await second.close() }
    expect(await identity(successor)).toEqual(published)

    const independent = await f.mount()
    const reopen = await independent.sessionPersistence.open(id, 'read')
    try {
      expect(reopen.header.version).toBe(5)
      expect((await reopen.read()).events).toEqual(events)
    } finally {
      await reopen.close()
    }
    expect(await identity(successor)).toEqual(published)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`, `session.v5${suffix}`])
  })

  it('refuses a corrupt V4 predecessor without publishing', async () => {
    const f = await fixture(compression, rows => `${rows.slice(0, 8).map(row => JSON.stringify(row)).join('\n')}\n{"type":"turn/start"\n${JSON.stringify({
      type: 'turn/end', seq: 8, time: 9, data: { turn: 1, reason: { kind: 'completed' } },
    })}\n`)
    const original = await identity(f.path)
    const ctx = await f.mount()
    await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow()
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toThrow()
    expect(await identity(f.path)).toEqual(original)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`])
  })

  it('refuses a corrupt V4 row followed by valid rows and a turn/end', async () => {
    // Historical-V4 counterpart of the native corrupt-prefix refusal: the V4
    // reader rejects this log when the later turn/end surfaces its first issue.
    const f = await fixture(compression, rows => [
      rows[0], rows[1], rows[2],
      '{invalid json}',
      rows[3], rows[4], rows[5], rows[6], rows[7],
    ].map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
    const original = await identity(f.path)
    const ctx = await f.mount()
    for (const access of ['read', 'write'] as const) {
      await expect(ctx.sessionPersistence.open(id, access)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
      await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow(/row 4 is not valid JSON/)
    }
    expect(await identity(f.path)).toEqual(original)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`])
  })

  it('serves the V4 prefix but refuses a truncated successor for a corrupt row with an untrusted tail', async () => {
    const f = await fixture(compression, rows => [
      rows[0], rows[1], rows[2], rows[3], rows[4],
      '{invalid json}',
      rows[5], rows[6],
    ].map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
    const original = await identity(f.path)
    const ctx = await f.mount()

    // Read open presents exactly the prefix the V4 reader admits, without publishing.
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      expect(reader.header.version).toBe(5)
      expect((await reader.read()).events).toEqual(f.rows.slice(0, 5))
    } finally {
      await reader.close()
    }
    expect(await identity(f.path)).toEqual(original)

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
      await expect(ctx.sessionPersistence.open(id, 'write'))
        .rejects.toThrow(/refusing to publish a v5 successor from a v4 source that needed recovery/)
      expect(await identity(f.path)).toEqual(original)
      const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
      expect(await files(f.path)).toEqual([`session.v4${suffix}`])
      const afterFailure = await ctx.sessionPersistence.open(id, 'read')
      try { expect((await afterFailure.read()).events).toEqual(f.rows.slice(0, 5)) } finally { await afterFailure.close() }
    }

    // A later write open retries after an external repair made the source clean.
    const repairedBytes = compression === 'none'
      ? Buffer.from(`${f.headerLine}${f.rows.map(row => JSON.stringify(row)).join('\n')}\n`)
      : Buffer.concat([
        await compressZstdFrame(f.headerLine),
        await compressZstdFrame(`${f.rows.map(row => JSON.stringify(row)).join('\n')}\n`),
      ])
    await writeFile(f.path, repairedBytes)
    const repaired = await identity(f.path)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try { expect((await writer.read()).events).toEqual(f.rows) } finally { await writer.close() }
    expect(await identity(f.path)).toEqual(repaired)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`, `session.v5${suffix}`])
    const reopen = await f.mount()
    const readerAfterRepair = await reopen.sessionPersistence.open(id, 'read')
    try { expect((await readerAfterRepair.read()).events).toEqual(f.rows) } finally { await readerAfterRepair.close() }
  })

  it('refuses a structurally invalid committed V4 row instead of publishing a recovered prefix', async () => {
    const f = await fixture(compression, rows => `${[
      rows[0], rows[1], rows[2], rows[3], rows[4],
      { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 }, extra: true },
      rows[6],
    ].map(row => JSON.stringify(row)).join('\n')}\n`)
    const original = await identity(f.path)
    const ctx = await f.mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try { expect((await reader.read()).events).toEqual(f.rows.slice(0, 5)) } finally { await reader.close() }
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toThrow(/invalid committed event at row 6/)
    expect(await identity(f.path)).toEqual(original)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`])
  })

  it('refuses a structurally invalid committed V4 turn/end as the first issue', async () => {
    const f = await fixture(compression, rows => `${[
      rows[0], rows[1], rows[2],
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } }, extra: true },
    ].map(row => JSON.stringify(row)).join('\n')}\n`)
    const original = await identity(f.path)
    const ctx = await f.mount()
    for (const access of ['read', 'write'] as const) {
      await expect(ctx.sessionPersistence.open(id, access)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
      await expect(ctx.sessionPersistence.open(id, access)).rejects.toThrow(/invalid committed event at row 4/)
    }
    expect(await identity(f.path)).toEqual(original)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`])
  })

  it(`migrates the documented torn final ${compression === 'none' ? 'line' : 'frame'} repair`, async () => {
    if (compression === 'none') {
      const f = await fixture(compression, rows => `${rows.slice(0, -1).map(row => JSON.stringify(row)).join('\n')}\n${JSON.stringify(rows.at(-1)).slice(0, -4)}`)
      const expected = f.rows.slice(0, -1)
      const ctx = await f.mount()
      const writer = await ctx.sessionPersistence.open(id, 'write')
      try { expect((await writer.read()).events).toEqual(expected) } finally { await writer.close() }
      expect(await files(f.path)).toEqual(['session.v4.jsonl', 'session.v5.jsonl'])
      const successor = generationLogPath(f.root, undefined, id, 5, compression)
      expect((await identity(successor)).bytes.length).toBeGreaterThan(0)
      return
    }
    const f = await fixture(compression)
    const complete = await readFile(f.path)
    const frames = scanZstdFrames(complete).frames
    const last = frames.at(-1)
    if (last === undefined) throw new Error('fixture lacks a body frame')
    await writeFile(f.path, complete.subarray(0, last.end - 3))
    const torn = await identity(f.path)
    const ctx = await f.mount()
    const writer = await ctx.sessionPersistence.open(id, 'write')
    try { expect((await writer.read()).events).toEqual(f.rows) } finally { await writer.close() }
    expect(await identity(f.path)).toEqual(torn)
    expect(await files(f.path)).toEqual(['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd'])
  })

  it('refuses an unknown required event without publishing', async () => {
    const f = await fixture(compression, rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n${JSON.stringify({
      type: 'ordinary/not-installed', seq: 9, time: 10, data: null,
    })}\n`)
    const original = await identity(f.path)
    const ctx = await f.mount()
    await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(/unknown event type/)
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toThrow(/unknown event type/)
    expect(await identity(f.path)).toEqual(original)
    const suffix = compression === 'none' ? '.jsonl' : '.jsonl.zstd'
    expect(await files(f.path)).toEqual([`session.v4${suffix}`])
  })
})

describe('future generation refusal', () => {
  it('refuses a V6 file without falling back to the V4 predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-v6-refusal-'))
    roots.push(root)
    const v4 = generationLogPath(root, undefined, id, 4, 'none')
    await mkdir(dirname(v4), { recursive: true })
    await writeFile(v4, `${JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n${JSON.stringify(v4Rows()[0])}\n`)
    const v6 = generationLogPath(root, undefined, id, 6, 'none')
    await writeFile(v6, `${JSON.stringify({ type: 'session', version: 6, id, createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n`)
    const v6Before = await identity(v6)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(/log format v6/)
    await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toThrow(/log format v6/)
    expect(await identity(v6)).toEqual(v6Before)
    expect(await files(v4)).toEqual(['session.v4.jsonl', 'session.v6.jsonl'])
  })
})
