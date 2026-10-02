/**
 * Discovery resilience: one unlistable or duplicated artifact must not hide the
 * rest of the root, and every hidden artifact is reported through the logger.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { generationLogPath } from '../src/format.ts'
import { compressZstdFrame } from '../src/zstd.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

describe('JsonlSessionPersistence: listing resilience', () => {
  let ctx: Context
  let root: string
  let warn: MockInstance

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-listing-resilience-'))
    ctx = new Context()
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists current and historical generations without reporting anything', async () => {
    const current = meta('listing-current', '/work')
    const historicalV3 = meta('listing-v3', '/work')
    const historicalV0 = meta('listing-v0', '/work')
    await writeCompressed(generationLogPath(root, current.cwd, current.id, 4, 'zstd'), `${JSON.stringify(currentHeader(current))}\n`)
    await writeCompressed(generationLogPath(root, historicalV3.cwd, historicalV3.id, 3, 'zstd'), `${JSON.stringify(v3Header(historicalV3))}\n`)
    await writeCompressed(generationLogPath(root, historicalV0.cwd, historicalV0.id, 0, 'zstd'), `${JSON.stringify(v0Header(historicalV0))}\n`)

    const ids = (await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id).sort()
    expect(ids).toEqual([current.id, historicalV0.id, historicalV3.id].sort())
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['an unsupported future version', (id: string) => JSON.stringify({ ...currentHeader(meta(id, '/work')), version: 5 }) + '\n', 5, 'stays hidden from the session list'],
    ['a header that is not JSON', () => 'not-json\n', 4, 'has no readable header and stays hidden'],
    ['a malformed compressed header frame', () => Buffer.from('not a Zstandard frame'), 4, 'stays hidden from the session list'],
  ])('keeps listing valid sessions when another artifact has %s', async (_name, broken, version, expectedReport) => {
    const healthy = meta('listing-healthy', '/work')
    const brokenId = SessionId('listing-broken')
    const brokenPath = generationLogPath(root, '/work', brokenId, version, 'zstd')
    await writeCompressed(generationLogPath(root, healthy.cwd, healthy.id, 4, 'zstd'), `${JSON.stringify(currentHeader(healthy))}\n`)
    const payload = broken(String(brokenId))
    await writeBytes(brokenPath, typeof payload === 'string' ? await compressZstdFrame(Buffer.from(payload)) : payload)

    const listed = await ctx.sessionPersistence.list()
    expect(listed.map(snapshot => snapshot.header.id)).toEqual([healthy.id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(brokenPath))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(expectedReport))
  })

  it('lists one artifact per duplicated id and reports the ignored duplicate', async () => {
    const id = SessionId('listing-duplicate')
    const oldPath = generationLogPath(root, '/project-a', id, 3, 'zstd')
    const newPath = generationLogPath(root, '/project-b', id, 4, 'zstd')
    await writeCompressed(oldPath, `${JSON.stringify(v3Header(meta(id, '/project-a')))}\n`)
    await writeCompressed(newPath, `${JSON.stringify(currentHeader(meta(id, '/project-b')))}\n`)

    const listed = await ctx.sessionPersistence.list()
    expect(listed.map(snapshot => snapshot.header.id)).toEqual([id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`duplicate JSONL session id "${id}"`))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`listing (raw log: ${newPath}), ignoring (raw log: ${oldPath})`))
  })

  it('breaks an equal-version duplicate tie by path so listings stay deterministic', async () => {
    const id = SessionId('listing-tie')
    const firstPath = generationLogPath(root, '/project-a', id, 4, 'zstd')
    const secondPath = generationLogPath(root, '/project-b', id, 4, 'zstd')
    await writeCompressed(secondPath, `${JSON.stringify(currentHeader(meta(id, '/project-b')))}\n`)
    await writeCompressed(firstPath, `${JSON.stringify(currentHeader(meta(id, '/project-a')))}\n`)

    await ctx.sessionPersistence.list()
    const expectedListing = firstPath <= secondPath ? firstPath : secondPath
    const expectedIgnored = firstPath <= secondPath ? secondPath : firstPath
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`listing (raw log: ${expectedListing}), ignoring (raw log: ${expectedIgnored})`))
  })
})

function currentHeader(header: SessionHeader): Record<string, unknown> {
  return {
    type: 'session',
    version: 4,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    isSeeded: header.isSeeded,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

function v3Header(header: SessionHeader): Record<string, unknown> {
  return { ...currentHeader(header), version: 3 }
}

function v0Header(header: SessionHeader): Record<string, unknown> {
  return {
    type: 'session',
    version: 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header.isSeeded ? { seedLength: 0 } : {}),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    delegationDepth: header.delegationDepth ?? 0,
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

async function writeCompressed(path: string, content: string): Promise<void> {
  await writeBytes(path, await compressZstdFrame(Buffer.from(content)))
}

async function writeBytes(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
