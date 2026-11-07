/**
 * Provider locks: ownership is exclusive per provider, release removes only
 * the caller's own record, and a dead owner's generation is bypassed while a
 * live external process keeps the lock.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  acquireProviderLock,
  HeavyProviderLockedError,
  HeavyProviderLockUnreadableError,
  inspectProviderLock,
  type HeavyProviderLock,
} from '../src/provider-lock.js'
import type { ChildProcess } from 'node:child_process'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'provider-lock-'))
  scratch.push(dir)
  return dir
}

function lockDir(dir: string, id: string): string {
  return join(dir, 'locks', encodeURIComponent(id))
}

function writeGeneration(dir: string, id: string, generation: number, content: Record<string, unknown> | string): string {
  const providerDir = lockDir(dir, id)
  mkdirSync(providerDir, { recursive: true })
  const path = join(providerDir, `${String(generation).padStart(12, '0')}.lock`)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return path
}

async function liveChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  return child
}

function withPlatform<T>(platform: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
  }
}

it('holds one generation per provider and releases it for the next acquirer', () => {
  const dir = scratchDir()
  expect(inspectProviderLock(dir, 'antigravity')).toEqual({ kind: 'none' })
  const first = acquireProviderLock(dir, 'antigravity')
  expect(inspectProviderLock(dir, 'antigravity').kind).toBe('held')
  expect(() => acquireProviderLock(dir, 'antigravity')).toThrow(HeavyProviderLockedError)

  // An unrelated provider never waits on this lock.
  const other = acquireProviderLock(dir, 'freellmapi')
  other.release()

  first.release()
  const second = acquireProviderLock(dir, 'antigravity')
  expect(second.owner.token).not.toBe(first.owner.token)
  second.release()
  expect(inspectProviderLock(dir, 'antigravity')).toEqual({ kind: 'none' })
})

it('a duplicate module instance cannot reclaim the current process lock', async () => {
  const dir = scratchDir()
  const lock = acquireProviderLock(dir, 'antigravity')
  // A second module instance starts with an empty token registry; the record
  // is the same pid and start tick, so it must be treated as live, not dead.
  const duplicatePath = '../src/provider-lock.js?duplicate-module'
  const duplicate = await import(/* @vite-ignore */ duplicatePath) as {
    acquireProviderLock: (jobDir: string, id: string) => unknown
    inspectProviderLock: typeof inspectProviderLock
  }
  expect(() => duplicate.acquireProviderLock(dir, 'antigravity')).toThrow(/is held by pid/)
  expect(duplicate.inspectProviderLock(dir, 'antigravity').kind).toBe('held')

  lock.release()
  // The duplicate instance acquires normally once the record is released.
  const duplicateLock = duplicate.acquireProviderLock(dir, 'antigravity') as HeavyProviderLock
  expect(duplicateLock.owner.token).not.toBe(lock.owner.token)
  duplicateLock.release()
})

it.skipIf(process.platform !== 'linux')('a same-pid record is stale only when its kernel start tick differs', () => {
  const dir = scratchDir()
  const current = acquireProviderLock(dir, 'antigravity')
  expect(current.owner.processStart).not.toBeNull()
  current.release()

  // A previous process reused this pid: the start tick cannot be ours.
  writeGeneration(dir, 'antigravity', 1, {
    version: 1,
    id: 'antigravity',
    token: 'reused-pid',
    pid: process.pid,
    startedAt: 1,
    processStart: '0',
  })
  expect(inspectProviderLock(dir, 'antigravity').kind).toBe('dead')

  const reuse = acquireProviderLock(dir, 'antigravity')
  expect(reuse.owner.token).not.toBe('reused-pid')
  expect(readdirSync(lockDir(dir, 'antigravity')).filter(name => name.endsWith('.lock'))).toHaveLength(1)
  reuse.release()
})

it('rejects a non-representable timestamp as unreadable, not a RangeError', () => {
  const dir = scratchDir()
  const path = writeGeneration(dir, 'antigravity', 1, {
    version: 1,
    id: 'antigravity',
    token: 'bad-timestamp',
    pid: process.pid,
    startedAt: 8_640_000_000_000_001,
    processStart: null,
  })
  let thrown: unknown
  try {
    acquireProviderLock(dir, 'antigravity')
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(HeavyProviderLockUnreadableError)
  expect(thrown).not.toBeInstanceOf(RangeError)
  expect((thrown as Error).message).toContain(path)
  expect((thrown as Error).message).toContain('malformed')
})

it('refuses a live external owner and reclaims it after its process exits', async () => {
  const dir = scratchDir()
  const child = await liveChild()
  try {
    writeGeneration(dir, 'antigravity', 1, {
      version: 1,
      id: 'antigravity',
      token: 'external-owner',
      pid: child.pid,
      startedAt: 1,
      processStart: null,
    })
    expect(() => acquireProviderLock(dir, 'antigravity')).toThrow(HeavyProviderLockedError)
    expect(inspectProviderLock(dir, 'antigravity').kind).toBe('held')
  } finally {
    child.kill()
    await once(child, 'exit')
  }

  const reclaim = acquireProviderLock(dir, 'antigravity')
  expect(reclaim.owner.pid).toBe(process.pid)
  // The dead generation is cleaned up once the next generation is owned.
  expect(readdirSync(lockDir(dir, 'antigravity')).filter(name => name.endsWith('.lock'))).toHaveLength(1)
  reclaim.release()
})

it('release never removes a record another owner replaced', () => {
  const dir = scratchDir()
  const lock = acquireProviderLock(dir, 'antigravity')
  const replacement = JSON.stringify({
    version: 1,
    id: 'antigravity',
    token: 'replacement-token',
    pid: process.pid,
    startedAt: 1,
    processStart: null,
  })
  writeFileSync(lock.path, replacement, 'utf8')
  lock.release()
  expect(readFileSync(lock.path, 'utf8')).toBe(replacement)
})

it('an unreadable record fails closed instead of being reclaimed', () => {
  const dir = scratchDir()
  writeGeneration(dir, 'antigravity', 1, '{"version":1')
  expect(() => acquireProviderLock(dir, 'antigravity')).toThrow(HeavyProviderLockUnreadableError)
  expect(() => acquireProviderLock(dir, 'antigravity')).toThrow(/refusing to reclaim/)
  expect(inspectProviderLock(dir, 'antigravity').kind).toBe('unverifiable')
})

it('publishes one complete lock generation and leaves no temporary record', () => {
  const dir = scratchDir()
  const lock = acquireProviderLock(dir, 'antigravity')
  const names = readdirSync(lockDir(dir, 'antigravity'))
  expect(names).toEqual(['000000000001.lock'])
  const record = JSON.parse(readFileSync(lock.path, 'utf8')) as Record<string, unknown>
  expect(record).toMatchObject({ version: 1, id: 'antigravity', pid: process.pid })
  expect(typeof record.token).toBe('string')
  lock.release()
})

it('refuses a generation naming a non-positive pid', () => {
  const dir = scratchDir()
  const path = writeGeneration(dir, 'antigravity', 1, {
    version: 1,
    id: 'antigravity',
    token: 'non-positive-pid',
    pid: 0,
    startedAt: 1,
    processStart: null,
  })
  let thrown: unknown
  try {
    acquireProviderLock(dir, 'antigravity')
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(HeavyProviderLockUnreadableError)
  expect((thrown as Error).message).toContain(path)
  expect((thrown as Error).message).toContain('malformed')
})

it('records a portable start identity on darwin and reclaims a reused pid', () => {
  const dir = scratchDir()
  withPlatform('darwin', () => {
    const lock = acquireProviderLock(dir, 'antigravity')
    expect(lock.owner.processStart).toMatch(/^ps:/u)
    lock.release()

    // The same pid now belongs to a process with a different start stamp.
    writeGeneration(dir, 'antigravity', 1, {
      version: 1,
      id: 'antigravity',
      token: 'reused-darwin-pid',
      pid: process.pid,
      startedAt: 1,
      processStart: 'ps:Mon Jan  1 00:00:00 2001',
    })
    expect(inspectProviderLock(dir, 'antigravity').kind).toBe('dead')
    const reuse = acquireProviderLock(dir, 'antigravity')
    expect(reuse.owner.token).not.toBe('reused-darwin-pid')
    expect(readdirSync(lockDir(dir, 'antigravity')).filter(name => name.endsWith('.lock'))).toHaveLength(1)
    reuse.release()
  })
})

it.skipIf(process.platform !== 'linux')(
  'keeps a legacy darwin record with no start identity live rather than stealing it',
  () => {
    const dir = scratchDir()
    withPlatform('darwin', () => {
      writeGeneration(dir, 'antigravity', 1, {
        version: 1,
        id: 'antigravity',
        token: 'legacy-darwin-record',
        pid: process.pid,
        startedAt: 1,
        processStart: null,
      })
      expect(inspectProviderLock(dir, 'antigravity').kind).toBe('held')
      expect(() => acquireProviderLock(dir, 'antigravity')).toThrow(HeavyProviderLockedError)
    })
  },
)
