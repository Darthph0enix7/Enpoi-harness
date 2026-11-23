/**
 * Wire diagnostics: default no-history capture, the bounded opt-in archive,
 * retention and byte/age/name limits, permissions, and failure isolation.
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  readSessionWireCapture,
  ToolCallId,
  WIRE_SESSION_DIR,
  writeSessionWireCapture,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { captureWireRequest } from '../src/wire-sessions.ts'
import { createIsolatedTestEnvironment, type IsolatedTestEnvironment } from './test-env.ts'

const SESSION_ID = 'session-wire-capture-1' as Branded<'SessionId'>

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const HISTORY_NAME = /^wire-\d+(?:-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.json$/i

class ScriptedAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* SCRIPT
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const contexts: Context[] = []
let testEnv: IsolatedTestEnvironment

async function runtime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  contexts.push(ctx)
  return ctx
}

function request(text: string, over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'mock',
    model: 'mock',
    sessionId: SESSION_ID,
    messages: [createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })],
    ...over,
  }
}

/** Owned Harness home and wire root under the per-test temp tree. */
async function useRoot(): Promise<{ root: string; logs: string }> {
  testEnv.clearWireEnvironment()
  const root = await mkdtemp(join(testEnv.tmp, 'run-'))
  process.env.HOME = join(root, 'home')
  process.env.USERPROFILE = join(root, 'home')
  process.env.DSH_HOME = join(root, 'home')
  process.env.DSH_WIRE_LOG = join(root, 'logs', 'wire-last.json')
  return { root, logs: join(root, 'logs') }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Poll for one fire-and-forget capture file. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      await sleep(10)
    }
  }
  throw new Error(`capture was not written: ${path}`)
}

async function listHistory(logs: string): Promise<string[]> {
  const names = await readdir(logs).catch(() => [] as string[])
  return names.filter(name => HISTORY_NAME.test(name)).sort()
}

/** Poll for a capture whose parsed content satisfies the predicate. */
async function readJsonWhen(
  path: string,
  predicate: (record: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      if (predicate(record)) return record
    } catch {
      // The atomic replace may not have landed yet.
    }
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}: ${path}`)
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let queued diagnostics finish before the temp tree is removed. */
async function settle(ms = 150): Promise<void> {
  await sleep(ms)
}

/** Spawn one isolated child writer sharing only the supplied wire root. */
function runChildWriter(shared: string, label: string): Promise<void> {
  const fixture = fileURLToPath(new URL('./fixtures/wire-capture-child.ts', import.meta.url))
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_WIRE_')) continue
    if (['HOME', 'USERPROFILE', 'DSH_HOME', 'TMPDIR', 'TEMP', 'TMP'].includes(key)) continue
    env[key] = value
  }
  const home = join(shared, 'children', label)
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_WIRE_LOG: join(shared, 'logs', 'wire-last.json'),
    DSH_WIRE_HISTORY: '1',
    DSH_WIRE_HISTORY_MAX_FILES: '3',
    DSH_WIRE_HISTORY_MAX_BYTES: '1000000',
    DSH_WIRE_HISTORY_MAX_AGE_MS: '3600000',
    DSH_WIRE_LAST_MAX_BYTES: '1000000',
    DSH_WIRE_SESSION_MAX_BYTES: '1000000',
    DSH_WIRE_SESSION_RETAIN: '3',
    WIRE_CHILD_LABEL: label,
    WIRE_CHILD_COUNT: '4',
  })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`wire child ${label} exited ${String(code)}: ${stderr}`))
    })
  })
}

function captureText(record: Record<string, unknown>): string {
  const messages = record.messages as { content?: { text?: string }[] }[] | undefined
  return messages?.[0]?.content?.[0]?.text ?? ''
}

beforeEach(async () => {
  testEnv = await createIsolatedTestEnvironment('dsh-wire-capture-')
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  // Drain before restoring ambient env: a queued write must never observe an
  // operator path that replaced the owned one.
  await settle(250)
  await testEnv.restore()
  vi.restoreAllMocks()
})

describe('default wire diagnostics', () => {
  it('writes only the last main request and its bounded Session inspector', async () => {
    const { logs } = await useRoot()
    const ctx = await runtime()
    for (let index = 0; index < 5; index += 1) {
      await expect(collect(ctx.llm.stream(request(`hello ${index}`)))).resolves.toEqual(SCRIPT)
    }

    const last = await readJsonWhen(
      join(logs, 'wire-last.json'),
      record => captureText(record) === 'hello 4',
      'last hello 4',
    )
    expect(last).toMatchObject({ provider: 'mock', model: 'mock', sessionId: SESSION_ID })

    const record = await readJsonWhen(
      join(logs, WIRE_SESSION_DIR, `${SESSION_ID}.json`),
      captured => captureText(captured) === 'hello 4',
      'session hello 4',
    )
    expect(captureText(record)).toBe('hello 4')
    const capture = await readSessionWireCapture(SESSION_ID, { root: logs })
    expect(capture?.truncated).toBe(false)
    expect(capture?.summary.provider).toBe('mock')

    await settle()
    expect(await listHistory(logs)).toEqual([])
    expect((await readdir(logs)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('skips the auxiliary body and keeps the last main capture', async () => {
    const { logs } = await useRoot()
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('main body')))
    const lastPath = join(logs, 'wire-last.json')
    await readJson(lastPath)
    await readJson(join(logs, WIRE_SESSION_DIR, `${SESSION_ID}.json`))

    await expect(collect(ctx.llm.stream(request('title me', { purpose: 'session-title' })))).resolves.toEqual(SCRIPT)
    await settle()

    const last = await readJson(lastPath)
    expect(captureText(last)).toBe('main body')
    const capture = await readSessionWireCapture(SESSION_ID, { root: logs })
    expect(capture?.messages).toHaveLength(1)
    expect(await listHistory(logs)).toEqual([])
  })

  it('clears and restores every ambient DSH_WIRE_* value including unknown keys', async () => {
    const sentinel = join(testEnv.tmp, 'sentinel-wire-last.json')
    process.env.DSH_WIRE_LOG = sentinel
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_FUTURE_OPTION = 'keep'

    const isolated = await createIsolatedTestEnvironment('dsh-wire-env-')
    try {
      expect(process.env.DSH_WIRE_LOG).toBeUndefined()
      expect(process.env.DSH_WIRE_HISTORY).toBeUndefined()
      expect(process.env.DSH_WIRE_FUTURE_OPTION).toBeUndefined()
      expect(process.env.HOME).toBe(isolated.home)
      expect(process.env.USERPROFILE).toBe(isolated.home)
      expect(process.env.DSH_HOME).toBe(isolated.home)
      expect(process.env.DSH_MEMORY_DB).toBe(join(isolated.root, 'memory.sqlite'))
      expect(process.env.XDG_CONFIG_HOME).toBe(join(isolated.root, 'xdg', 'config'))
      expect(process.env.TMPDIR).toBe(isolated.tmp)
    } finally {
      await isolated.restore()
    }

    expect(process.env.DSH_WIRE_LOG).toBe(sentinel)
    expect(process.env.DSH_WIRE_HISTORY).toBe('1')
    expect(process.env.DSH_WIRE_FUTURE_OPTION).toBe('keep')
  })

  it('ignores adversarial ambient wire settings in favor of the owned root', async () => {
    const sentinel = join(testEnv.tmp, 'sentinel-wire-last.json')
    process.env.DSH_WIRE_LOG = sentinel
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '1'
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1'
    const { logs } = await useRoot()
    expect(process.env.DSH_WIRE_LOG).toBe(join(logs, 'wire-last.json'))
    expect(process.env.DSH_WIRE_HISTORY).toBeUndefined()

    const ctx = await runtime()
    await collect(ctx.llm.stream(request('owned root')))
    await readJson(join(logs, 'wire-last.json'))
    await readJson(join(logs, WIRE_SESSION_DIR, `${SESSION_ID}.json`))
    await settle(150)
    expect(await exists(sentinel)).toBe(false)
    expect(await listHistory(logs)).toEqual([])
  })

  it('snapshots Session caps at dispatch for queued writes', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1000000'
    captureWireRequest(request('dispatch snapshot'))
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1'

    const record = await readJson(join(logs, WIRE_SESSION_DIR, `${SESSION_ID}.json`))
    expect(record.truncated).toBeUndefined()
    expect(record.messages).toHaveLength(1)
  })

  it('keeps the model output unchanged when the diagnostic destination is unwritable', async () => {
    const { root } = await useRoot()
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a directory')
    process.env.DSH_WIRE_LOG = join(blocked, 'wire-last.json')
    process.env.DSH_HOME = join(blocked, 'home')
    process.env.DSH_WIRE_HISTORY = '1'
    const ctx = await runtime()

    await expect(collect(ctx.llm.stream(request('still answers')))).resolves.toEqual(SCRIPT)
    await settle()
    expect(await readFile(blocked, 'utf8')).toBe('not a directory')
  })

  it('leaves no temp file when an atomic replace fails', async () => {
    const { logs } = await useRoot()
    await mkdir(join(logs, 'wire-last.json'), { recursive: true })
    const ctx = await runtime()

    await expect(collect(ctx.llm.stream(request('hello')))).resolves.toEqual(SCRIPT)
    await settle()
    expect((await readdir(logs)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect((await stat(join(logs, 'wire-last.json'))).isDirectory()).toBe(true)
  })

  it('writes no capture for a request that cannot be serialized', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    const wrong = request('unserializable')
    // JSON.stringify refuses a BigInt; the capture must disappear quietly.
    Object.defineProperty(wrong, 'maxTokens', { value: 1n, enumerable: true })
    captureWireRequest(wrong)
    await settle()
    expect(await exists(join(logs, 'wire-last.json'))).toBe(false)
    expect(await listHistory(logs)).toEqual([])
  })

  it('contains a throwing request getter and a failed direct inspector write', async () => {
    const { root, logs } = await useRoot()
    const throwing = request('throwing')
    Object.defineProperty(throwing, 'provider', {
      get() {
        throw new Error('broken request')
      },
      enumerable: true,
    })
    captureWireRequest(throwing)

    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a directory')
    await expect(writeSessionWireCapture(blocked, request('blocked'))).resolves.toBeUndefined()
    await expect(readSessionWireCapture('../escape')).resolves.toBeUndefined()
    await settle()
    expect(await exists(join(logs, 'wire-last.json'))).toBe(false)
  })

  it('expands a tilde DSH_HOME before appending the log directory', async () => {
    const { root } = await useRoot()
    delete process.env.DSH_WIRE_LOG
    const ctx = await runtime()
    const cases: [string, string][] = [
      ['~', join(root, 'home', 'logs')],
      ['~/nested', join(root, 'home', 'nested', 'logs')],
      ['~\\nested', join(root, 'home', 'nested', 'logs')],
    ]
    for (const [index, [home, target]] of cases.entries()) {
      process.env.DSH_HOME = home
      await collect(ctx.llm.stream(request(`home ${index}`, {
        sessionId: `session-home-${index}` as Branded<'SessionId'>,
      })))
      await readJson(join(target, 'wire-last.json'))
    }
  })

  it('treats explicit false switches as off', async () => {
    const { logs } = await useRoot()
    const ctx = await runtime()
    for (const value of ['', '0', 'false']) {
      process.env.DSH_WIRE_HISTORY = value
      await collect(ctx.llm.stream(request(`disabled ${value}`)))
      await settle(60)
    }
    expect(await listHistory(logs)).toEqual([])
  })

  it('honors DSH_HOME for the default root and the read path', async () => {
    const { root } = await useRoot()
    delete process.env.DSH_WIRE_LOG
    process.env.DSH_HOME = join(root, 'harness')
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('home root')))
    const target = join(root, 'harness', 'logs', 'wire-last.json')
    await readJson(target)
    await readJson(join(root, 'harness', 'logs', WIRE_SESSION_DIR, `${SESSION_ID}.json`))
    expect(await exists(join(root, 'home', '.dsh', 'logs', 'wire-last.json'))).toBe(false)
    await expect(readSessionWireCapture(SESSION_ID)).resolves.toMatchObject({
      summary: { provider: 'mock' },
    })
  })

  it('falls back to the home directory when DSH_HOME is empty', async () => {
    const { root } = await useRoot()
    delete process.env.DSH_WIRE_LOG
    process.env.DSH_HOME = ''
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('fallback home')))
    await readJson(join(root, 'home', '.dsh', 'logs', 'wire-last.json'))
  })

  it('reports invalid settings and keeps the finite defaults in force', async () => {
    const { logs } = await useRoot()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env.DSH_WIRE_HISTORY = 'yes'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('invalid history switch')))
    await collect(ctx.llm.stream(request('invalid history switch again')))
    await settle(150)
    expect(await listHistory(logs)).toEqual([])

    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = 'many'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '-1'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = 'forever'
    await collect(ctx.llm.stream(request('invalid limits')))
    await waitFor(async () => (await listHistory(logs)).length === 1, 'default-bounded archive')

    const output = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(output.match(/DSH_WIRE_HISTORY=.*invalid/g)).toHaveLength(1)
    expect(output).toContain('DSH_WIRE_HISTORY_MAX_FILES')
    expect(output).toContain('DSH_WIRE_HISTORY_MAX_BYTES')
    expect(output).toContain('DSH_WIRE_HISTORY_MAX_AGE_MS')
  })
})

describe('bounded historical archive', () => {
  it('retains only the configured number of newest captures', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '3'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()

    for (let index = 0; index < 6; index += 1) {
      await collect(ctx.llm.stream(request(`hello ${index}`)))
      await sleep(10)
    }
    await waitFor(async () => (await listHistory(logs)).length === 3, 'three retained archives')
    await settle(250)

    const names = await listHistory(logs)
    expect(names).toHaveLength(3)
    const texts: string[] = []
    for (const name of names) {
      texts.push(captureText(await readJson(join(logs, name))))
    }
    expect(texts.sort()).toEqual(['hello 3', 'hello 4', 'hello 5'])
  })

  it('enforces the total byte budget with exact UTF-8 sizes', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '100'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '2500'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()

    for (let index = 0; index < 10; index += 1) {
      await collect(ctx.llm.stream(request(`${'x'.repeat(200)} ${index}`)))
      await sleep(5)
    }
    await waitFor(async () => (await listHistory(logs)).length >= 2, 'two byte-bounded archives')
    await settle(250)

    const names = await listHistory(logs)
    const sizes = await Promise.all(names.map(name => stat(join(logs, name)).then(info => info.size)))
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(2500)
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThan(10)
  })

  it('rejects an oversized single capture and measures multibyte text as bytes', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '100'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '700'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('🌍'.repeat(500))))
    await settle(200)
    expect(await listHistory(logs)).toEqual([])

    await collect(ctx.llm.stream(request('a'.repeat(40))))
    await waitFor(async () => (await listHistory(logs)).length === 1, 'one accepted archive')
    await settle(150)

    const [name] = await listHistory(logs)
    if (name === undefined) throw new Error('unreachable')
    const text = await readFile(join(logs, name), 'utf8')
    expect(text).toContain('a'.repeat(40))
    expect(Buffer.byteLength(text, 'utf8')).toBe((await stat(join(logs, name))).size)
    expect((await stat(join(logs, name))).size).toBeLessThanOrEqual(700)
  })

  it('prunes expired owned archives but never unrelated JSON or symlinks', async () => {
    const { logs } = await useRoot()
    await mkdir(logs, { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const seed = async (name: string, contents: string): Promise<string> => {
      const target = join(logs, name)
      await writeFile(target, contents)
      await utimes(target, old, old)
      return target
    }
    const legacy = await seed('wire-1700000000000.json', '{"legacy":true}')
    const modern = await seed(
      'wire-1700000000001-123-11111111-1111-4111-8111-111111111111.json',
      '{"modern":true}',
    )
    await seed('wire-last.json', '{"sentinel":"last"}')
    await seed('wire-notes.json', '{"unrelated":true}')
    await seed('notes.json', '{"unrelated":true}')
    const sentinel = join(logs, 'sentinel.json')
    await writeFile(sentinel, '{"sentinel":true}')
    const link = join(logs, 'wire-1700000000002.json')
    await symlink('sentinel.json', link)

    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '1000'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '10000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('fresh')))

    await waitFor(
      async () => (await listHistory(logs)).some(name => !name.includes('1700000000')),
      'one fresh archive',
    )
    await settle(200)

    expect(await exists(legacy)).toBe(false)
    expect(await exists(modern)).toBe(false)
    expect(await exists(join(logs, 'wire-notes.json'))).toBe(true)
    expect(await exists(join(logs, 'notes.json'))).toBe(true)
    expect(await exists(join(logs, 'wire-last.json'))).toBe(true)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(sentinel, 'utf8')).toBe('{"sentinel":true}')
    expect(await readFile(join(logs, 'wire-last.json'), 'utf8')).toContain('"provider":"mock"')
  })

  it('counts a retired numeric archive against the retention limit', async () => {
    const { logs } = await useRoot()
    await mkdir(logs, { recursive: true })
    const legacy = join(logs, 'wire-1700000000000.json')
    await writeFile(legacy, '{"legacy":true}')

    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '1'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '86400000'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('fresh')))

    await waitFor(async () => (await listHistory(logs)).length === 1, 'one retained archive')
    await settle(150)
    expect(await exists(legacy)).toBe(false)
    expect((await listHistory(logs))[0]).not.toBe('wire-1700000000000.json')
  })

  it('reserves the new archive before newer-mtime survivors', async () => {
    const { logs } = await useRoot()
    await mkdir(logs, { recursive: true })
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const seeds = [
      'wire-1700000000010.json',
      'wire-1700000000011-123-11111111-1111-4111-8111-111111111111.json',
    ]
    for (const name of seeds) {
      const target = join(logs, name)
      await writeFile(target, '{"future":true}')
      await utimes(target, future, future)
    }
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '1'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('fresh')))

    await waitFor(
      async () => (await listHistory(logs)).some(name => !seeds.includes(name)),
      'one fresh archive',
    )
    await settle(200)

    const names = await listHistory(logs)
    expect(names).toHaveLength(1)
    expect(seeds).not.toContain(names[0])
  })

  it('reserves the new archive bytes before newer-mtime survivors', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '100'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('bytes')))

    await waitFor(async () => (await listHistory(logs)).length === 1, 'probe archive')
    const [probe] = await listHistory(logs)
    if (probe === undefined) throw new Error('unreachable')
    const keepBytes = (await stat(join(logs, probe))).size
    for (const name of await listHistory(logs)) await unlink(join(logs, name))

    const future = new Date(Date.now() + 60 * 60 * 1000)
    const seeds = ['wire-1700000000020.json', 'wire-1700000000021.json']
    for (const name of seeds) {
      const target = join(logs, name)
      await writeFile(target, 'x'.repeat(100))
      await utimes(target, future, future)
    }
    const maxBytes = keepBytes + 150
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = String(maxBytes)
    await collect(ctx.llm.stream(request('bytes')))

    await waitFor(
      async () => (await listHistory(logs)).some(name => !seeds.includes(name)),
      'one fresh byte-bounded archive',
    )
    await settle(200)

    const names = await listHistory(logs)
    const sizes = await Promise.all(names.map(name => stat(join(logs, name)).then(info => info.size)))
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(maxBytes)
    expect(names.length).toBeLessThanOrEqual(2)
    expect(names.some(name => !seeds.includes(name))).toBe(true)
  })

  it('converges shared-root retention bounds across writer processes after settling', async () => {
    const { root } = await useRoot()
    const logs = join(root, 'logs')
    await mkdir(join(root, 'children'), { recursive: true })

    await Promise.all([runChildWriter(root, 'writer-a'), runChildWriter(root, 'writer-b')])
    await waitFor(async () => (await listHistory(logs)).length > 0, 'child archives')
    await settle(400)

    const names = await listHistory(logs)
    const sizes = await Promise.all(names.map(name => stat(join(logs, name)).then(info => info.size)))
    expect(names.length).toBeGreaterThan(0)
    expect(names.length).toBeLessThanOrEqual(3)
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1000000)
    await readJson(join(logs, 'wire-last.json'))
  }, 20_000)

  it('archives auxiliary calls only when history is enabled', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '10'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('main body')))
    await collect(ctx.llm.stream(request('title body', { purpose: 'session-title' })))
    await waitFor(async () => (await listHistory(logs)).length === 2, 'two archived calls')
    await settle(150)

    const records = await Promise.all((await listHistory(logs)).map(name => readJson(join(logs, name))))
    expect(records.map(record => record.purpose).sort()).toEqual(['session-title', undefined])
  })

  it('drops a bounded backlog instead of retaining every request context', async () => {
    const { logs } = await useRoot()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '100'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '10000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'

    for (let index = 0; index < 20; index += 1) {
      captureWireRequest(request(`burst ${index}`, {
        sessionId: `session-burst-${index}` as Branded<'SessionId'>,
      }))
    }
    await waitFor(async () => (await listHistory(logs)).length === 16, 'bounded backlog archives')
    await settle(250)

    expect(await listHistory(logs)).toHaveLength(16)
    expect((await readdir(join(logs, WIRE_SESSION_DIR))).filter(name => name.endsWith('.json'))).toHaveLength(16)
    expect(stderr.mock.calls.map(call => String(call[0])).join('')).toContain('backlog is full')
  })
})

describe('last-request byte bound', () => {
  it('stores only a summary when the last capture exceeds its cap', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_LAST_MAX_BYTES = '400'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('x'.repeat(500))))
    const target = join(logs, 'wire-last.json')
    await readJson(target)
    const text = await readFile(target, 'utf8')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(400)
    const record = JSON.parse(text) as Record<string, unknown>
    expect(record.truncated).toBe(true)
    expect(record.provider).toBe('mock')
    expect(record.summary).toBeDefined()

    const capture = await readSessionWireCapture(SESSION_ID, { root: logs })
    expect(capture?.truncated).toBe(false)
  })

  it('does not write a last capture when even the summary exceeds the cap', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_LAST_MAX_BYTES = '1'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('hello')))
    await settle(250)
    expect(await exists(join(logs, 'wire-last.json'))).toBe(false)
  })
})

describe('Session capture validation', () => {
  it('rejects malformed captures and reads a valid truncated summary', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    await mkdir(dir, { recursive: true })
    const malformed: [string, string][] = [
      ['broken-json', '{'],
      ['missing-session', '{}'],
      ['missing-time', JSON.stringify({ sessionId: 'missing-time', provider: 'p', model: 'm' })],
      ['bad-truncated', JSON.stringify({
        sessionId: 'bad-truncated', capturedAt: 1, provider: 'p', model: 'm', truncated: true, summary: {},
      })],
      ['bad-summary-message', JSON.stringify({
        sessionId: 'bad-summary-message',
        capturedAt: 1,
        provider: 'p',
        model: 'm',
        truncated: true,
        summary: { system: null, messages: [{}], tools: [] },
      })],
      ['bad-summary-tool', JSON.stringify({
        sessionId: 'bad-summary-tool',
        capturedAt: 1,
        provider: 'p',
        model: 'm',
        truncated: true,
        summary: { system: null, messages: [], tools: [3] },
      })],
      ['bad-summary-system', JSON.stringify({
        sessionId: 'bad-summary-system',
        capturedAt: 1,
        provider: 'p',
        model: 'm',
        truncated: true,
        summary: { system: { chars: 'many', sha256: 'x' }, messages: [], tools: [] },
      })],
      ['missing-arrays', JSON.stringify({ sessionId: 'missing-arrays', capturedAt: 1, provider: 'p', model: 'm' })],
      ['bad-message', JSON.stringify({
        sessionId: 'bad-message', capturedAt: 1, provider: 'p', model: 'm', messages: [{}], tools: [],
      })],
      ['bad-tool', JSON.stringify({
        sessionId: 'bad-tool', capturedAt: 1, provider: 'p', model: 'm', messages: [], tools: [{}],
      })],
      ['bad-system', JSON.stringify({
        sessionId: 'bad-system', capturedAt: 1, provider: 'p', model: 'm', messages: [], tools: [], system: 5,
      })],
      ['bad-summary-value', JSON.stringify({
        sessionId: 'bad-summary-value',
        capturedAt: 1,
        provider: 'p',
        model: 'm',
        truncated: true,
        summary: 5,
      })],
      ['missing-summary-arrays', JSON.stringify({
        sessionId: 'missing-summary-arrays',
        capturedAt: 1,
        provider: 'p',
        model: 'm',
        truncated: true,
        summary: { system: null },
      })],
    ]
    for (const [id, contents] of malformed) {
      await writeFile(join(dir, `${id}.json`), contents)
      await expect(readSessionWireCapture(id, { root: logs })).resolves.toBeUndefined()
    }

    const legacy = {
      sessionId: 'legacy-time',
      time: 5,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'text', text: 'S' }] }, { role: 'user', content: [] }],
      tools: [],
    }
    await writeFile(join(dir, 'legacy-time.json'), JSON.stringify(legacy))
    await expect(readSessionWireCapture('legacy-time', { root: logs })).resolves.toMatchObject({
      truncated: false,
      summary: { capturedAt: 5, system: { chars: 1 } },
    })

    const emptySystem = {
      sessionId: 'empty-system',
      capturedAt: 1,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'system', content: [] }],
      tools: [],
    }
    await writeFile(join(dir, 'empty-system.json'), JSON.stringify(emptySystem))
    await expect(readSessionWireCapture('empty-system', { root: logs })).resolves.toMatchObject({
      summary: { system: null },
    })

    const truncated = {
      sessionId: 'truncated-null',
      capturedAt: 1,
      provider: 'p',
      model: 'm',
      truncated: true,
      summary: { system: null, messages: [{ role: 'user', chars: 3 }], tools: ['read'] },
    }
    await writeFile(join(dir, 'truncated-null.json'), JSON.stringify(truncated))
    await expect(readSessionWireCapture('truncated-null', { root: logs })).resolves.toMatchObject({
      truncated: true,
      summary: { capturedAt: 1, system: null, tools: ['read'], messages: [{ role: 'user', chars: 3 }] },
    })

    const nonTextSystem = {
      sessionId: 'nontext-system',
      capturedAt: 1,
      provider: 'p',
      model: 'm',
      messages: [{ role: 'system', content: [{ type: 'tool-removal', toolName: 'old' }] }],
      tools: [],
    }
    await writeFile(join(dir, 'nontext-system.json'), JSON.stringify(nonTextSystem))
    await expect(readSessionWireCapture('nontext-system', { root: logs })).resolves.toMatchObject({
      summary: { system: null },
    })
  })

  it('measures tool-call and merge-extensible blocks in the summary', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1024'
    const prefix = 'p'.repeat(2000)
    await writeSessionWireCapture(logs, {
      ...request('blocks'),
      messages: [createUserMessage({
        content: [
          { type: 'text', text: prefix },
          { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{"path":"x"}' },
          { type: 'tool-removal', toolName: 'old' },
        ],
        source: { kind: 'user' },
      })],
    })

    const capture = await readSessionWireCapture(SESSION_ID, { root: logs })
    expect(capture?.truncated).toBe(true)
    expect(capture?.summary.messages).toEqual([{
      role: 'user',
      chars: prefix.length
        + '{"path":"x"}'.length
        + JSON.stringify({ type: 'tool-removal', toolName: 'old' }).length,
    }])
  })

  it('summarizes an explicit system field when the Session cap is exceeded', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1024'
    await writeSessionWireCapture(logs, {
      ...request('x'.repeat(2000)),
      system: 'EXPLICIT RULES',
    })

    const capture = await readSessionWireCapture(SESSION_ID, { root: logs })
    expect(capture?.truncated).toBe(true)
    expect(capture?.summary.system?.chars).toBe('EXPLICIT RULES'.length)
  })
})

describe('capture ownership', () => {
  it('ignores auxiliary, sessionless, and unaddressable Session writes', async () => {
    const { logs } = await useRoot()
    await writeSessionWireCapture(logs, request('aux', { purpose: 'session-title' }))
    const { sessionId: _omitted, ...sessionless } = request('none')
    await writeSessionWireCapture(logs, sessionless)
    await writeSessionWireCapture(logs, {
      ...request('bad'),
      sessionId: '../escape' as Branded<'SessionId'>,
    })
    await settle(100)
    expect(await exists(join(logs, WIRE_SESSION_DIR))).toBe(false)
  })

  it('reserves the new Session capture before future-mtime survivors', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    await mkdir(dir, { recursive: true })
    const future = new Date(Date.now() + 60 * 60 * 1000)
    for (const name of ['session-old-a.json', 'session-old-b.json']) {
      const target = join(dir, name)
      await writeFile(target, '{"future":true}')
      await utimes(target, future, future)
    }
    process.env.DSH_WIRE_SESSION_RETAIN = '1'
    await writeSessionWireCapture(logs, request('fresh'))

    const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
    expect(names).toEqual([`${SESSION_ID}.json`])
  })

  it('enforces the complete Session file cap, including the summary', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    const target = join(dir, `${SESSION_ID}.json`)

    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1'
    await writeSessionWireCapture(logs, request('tiny cap'))
    expect(await exists(target)).toBe(false)

    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1000000'
    await writeSessionWireCapture(logs, request('probe exact'))
    const exact = (await stat(target)).size
    await unlink(target)
    process.env.DSH_WIRE_SESSION_MAX_BYTES = String(exact)
    await writeSessionWireCapture(logs, request('probe exact'))
    expect((await stat(target)).size).toBe(exact)
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toMatchObject({
      truncated: false,
    })
  })

  it('measures the Session cap in UTF-8 bytes for multibyte bodies', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    const target = join(dir, `${SESSION_ID}.json`)
    const text = '🌍'.repeat(200)

    process.env.DSH_WIRE_SESSION_MAX_BYTES = '1000000'
    await writeSessionWireCapture(logs, request(text))
    const fullBytes = (await stat(target)).size
    await unlink(target)

    process.env.DSH_WIRE_SESSION_MAX_BYTES = String(fullBytes)
    await writeSessionWireCapture(logs, request(text))
    expect((await stat(target)).size).toBe(fullBytes)
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toMatchObject({
      truncated: false,
    })

    process.env.DSH_WIRE_SESSION_MAX_BYTES = String(fullBytes - 1)
    await writeSessionWireCapture(logs, request(text))
    const summaryBytes = (await stat(target)).size
    expect(summaryBytes).toBeLessThanOrEqual(fullBytes - 1)
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toMatchObject({
      truncated: true,
    })
  })

  it('skips a Session summary that cannot fit and leaves the prior snapshot stale', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    const target = join(dir, `${SESSION_ID}.json`)

    await writeSessionWireCapture(logs, request('prior snapshot'))
    const prior = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '512'

    const messages = Array.from({ length: 80 }, (_, index) => createUserMessage({
      content: [{ type: 'text', text: `message ${index}` }],
      source: { kind: 'user' },
    }))
    const tools = Array.from({ length: 80 }, (_, index) => ({
      name: `tool-${index}-${'x'.repeat(24)}`,
      description: 'summary growth',
      parameters: {},
    }))
    await writeSessionWireCapture(logs, { ...request('summary growth'), messages, tools })

    const after = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>
    expect(after.capturedAt).toBe(prior.capturedAt)
    expect(after.truncated).toBeUndefined()
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toMatchObject({
      summary: { capturedAt: prior.capturedAt },
    })
  })

  it('rejects a symlink or oversized Session file on read', async () => {
    const { logs } = await useRoot()
    const dir = join(logs, WIRE_SESSION_DIR)
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${SESSION_ID}.json`)
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '100'
    await writeFile(target, 'x'.repeat(200))
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toBeUndefined()

    await unlink(target)
    const sentinel = join(logs, 'sentinel-target.json')
    await writeFile(sentinel, '{"sentinel":true}')
    await symlink('../sentinel-target.json', target)
    await expect(readSessionWireCapture(SESSION_ID, { root: logs })).resolves.toBeUndefined()
    expect(await readFile(sentinel, 'utf8')).toBe('{"sentinel":true}')
  })

  it('prunes only owned Session captures and skips symlinks', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_SESSION_RETAIN = '1'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request('first')))
    const dir = join(logs, WIRE_SESSION_DIR)
    await readJson(join(dir, `${SESSION_ID}.json`))

    await writeFile(join(dir, 'ignore.txt'), 'not a capture')
    await writeFile(join(dir, 'bad name.json'), '{"unrelated":true}')
    await writeFile(join(dir, 'link-target.txt'), '{"sentinel":true}')
    await symlink('link-target.txt', join(dir, 'link.json'))

    await collect(ctx.llm.stream(request('second', {
      sessionId: 'session-wire-capture-2' as Branded<'SessionId'>,
    })))
    await readJson(join(dir, 'session-wire-capture-2.json'))
    await settle(150)

    expect(await exists(join(dir, 'ignore.txt'))).toBe(true)
    expect(await exists(join(dir, 'bad name.json'))).toBe(true)
    expect((await lstat(join(dir, 'link.json'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(dir, 'link-target.txt'), 'utf8')).toBe('{"sentinel":true}')
    expect(await exists(join(dir, `${SESSION_ID}.json`))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('creates private directories and files', async () => {
    const { logs } = await useRoot()
    process.env.DSH_WIRE_HISTORY = '1'
    process.env.DSH_WIRE_HISTORY_MAX_FILES = '10'
    process.env.DSH_WIRE_HISTORY_MAX_BYTES = '1000000'
    process.env.DSH_WIRE_HISTORY_MAX_AGE_MS = '3600000'
    const ctx = await runtime()

    await collect(ctx.llm.stream(request('private')))
    await waitFor(async () => (await listHistory(logs)).length === 1, 'one private archive')
    await settle(100)

    expect(((await stat(logs)).mode & 0o777)).toBe(0o700)
    expect(((await stat(join(logs, WIRE_SESSION_DIR))).mode & 0o777)).toBe(0o700)
    expect(((await stat(join(logs, 'wire-last.json'))).mode & 0o777)).toBe(0o600)
    expect(((await stat(join(logs, WIRE_SESSION_DIR, `${SESSION_ID}.json`))).mode & 0o777)).toBe(0o600)
    const [archive] = await listHistory(logs)
    if (archive === undefined) throw new Error('unreachable')
    expect(((await stat(join(logs, archive))).mode & 0o777)).toBe(0o600)
  })
})
