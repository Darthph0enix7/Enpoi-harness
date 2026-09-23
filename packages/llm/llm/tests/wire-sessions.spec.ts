/** Per-Session wire capture: bounded files, main-call selectivity, and the read path. */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import LlmRuntime, {
  createSystemMessage,
  createUserMessage,
  LlmAdapter,
  readSessionWireCapture,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const SESSION_ID = 'session-wire-1' as Branded<'SessionId'>

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'ok' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

class ScriptedAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* SCRIPT
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // Consume to completion so the capture queue has been fed.
  }
}

async function runtime(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
  return ctx
}

function request(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'mock',
    model: 'mock',
    sessionId: SESSION_ID,
    messages: [
      createSystemMessage('SYSTEM RULES', 'test'),
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: {} }],
    ...over,
  }
}

/** Poll for one fire-and-forget capture file. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw new Error(`capture was not written: ${path}`)
}

/** Poll until `count` timestamped audit captures exist (they precede per-session writes in the queue). */
async function awaitAuditCount(root: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const names = await readdir(root).catch(() => [] as string[])
    if (names.filter(name => /^wire-\d+\.json$/.test(name)).length >= count) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`audit captures did not reach ${count}`)
}

const temps: string[] = []
let previousWireLog: string | undefined

async function useWireLog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wire-sessions-'))
  temps.push(root)
  previousWireLog = process.env.DSH_WIRE_LOG
  process.env.DSH_WIRE_LOG = join(root, 'wire-last.json')
  return root
}

afterEach(async () => {
  if (previousWireLog === undefined) delete process.env.DSH_WIRE_LOG
  else process.env.DSH_WIRE_LOG = previousWireLog
  previousWireLog = undefined
  delete process.env.DSH_WIRE_SESSION_MAX_BYTES
  delete process.env.DSH_WIRE_SESSION_RETAIN
  await Promise.all(temps.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('per-Session wire capture', () => {
  it('writes the session capture and keeps wire-last.json', async () => {
    const root = await useWireLog()
    const ctx = await runtime()
    await collect(ctx.llm.stream(request()))

    const path = join(root, 'wire-sessions', `${SESSION_ID}.json`)
    const record = await readJson(path)
    expect(record.sessionId).toBe(SESSION_ID)
    expect(typeof record.capturedAt).toBe('number')
    expect(record.provider).toBe('mock')
    expect(record.system).toBeNull()
    expect(record.messages).toHaveLength(2)
    expect(record.tools).toEqual([expect.objectContaining({ name: 'read' })])

    const last = JSON.parse(await readFile(join(root, 'wire-last.json'), 'utf8')) as Record<string, unknown>
    expect(last.sessionId).toBe(SESSION_ID)
    await ctx.fiber.dispose()
  })

  it('reads back the summary by default and the bodies from the same file', async () => {
    const root = await useWireLog()
    const ctx = await runtime()
    await collect(ctx.llm.stream(request()))
    await readJson(join(root, 'wire-sessions', `${SESSION_ID}.json`))

    const capture = await readSessionWireCapture(SESSION_ID, { root })
    expect(capture).toBeDefined()
    if (capture === undefined) throw new Error('unreachable')
    expect(capture.truncated).toBe(false)
    expect(capture.summary.provider).toBe('mock')
    expect(capture.summary.system).toEqual({
      chars: 'SYSTEM RULES'.length,
      sha256: createHash('sha256').update('SYSTEM RULES', 'utf8').digest('hex'),
    })
    expect(capture.summary.messages).toEqual([
      { role: 'system', chars: 'SYSTEM RULES'.length },
      { role: 'user', chars: 'hello'.length },
    ])
    expect(capture.summary.tools).toEqual(['read'])
    expect(capture.system).toBe('SYSTEM RULES')
    expect(capture.messages).toHaveLength(2)
    expect(capture.tools[0]).toMatchObject({ name: 'read' })
    await ctx.fiber.dispose()
  })

  it('never overwrites the main capture with an auxiliary call', async () => {
    const root = await useWireLog()
    const ctx = await runtime()
    await collect(ctx.llm.stream(request()))
    await readJson(join(root, 'wire-sessions', `${SESSION_ID}.json`))

    await collect(ctx.llm.stream({
      provider: 'mock',
      model: 'mock',
      sessionId: SESSION_ID,
      purpose: 'session-title',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'title me' }],
        source: { kind: 'user' },
      })],
    }))
    await awaitAuditCount(root, 2)

    const record = await readJson(join(root, 'wire-sessions', `${SESSION_ID}.json`))
    expect(record.purpose).toBeUndefined()
    expect(record.messages).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('writes no capture for a request without a session id', async () => {
    const root = await useWireLog()
    const ctx = await runtime()
    const { sessionId: _omitted, ...withoutSession } = request()
    await collect(ctx.llm.stream(withoutSession))
    await readJson(join(root, 'wire-last.json'))

    await expect(readSessionWireCapture(SESSION_ID, { root })).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('stores only the summary once the byte cap is exceeded', async () => {
    const root = await useWireLog()
    process.env.DSH_WIRE_SESSION_MAX_BYTES = '256'
    const ctx = await runtime()
    await collect(ctx.llm.stream(request()))

    const record = await readJson(join(root, 'wire-sessions', `${SESSION_ID}.json`))
    expect(record.truncated).toBe(true)
    expect(record.messages).toBeUndefined()
    expect(record.summary).toMatchObject({
      tools: ['read'],
      messages: [{ role: 'system', chars: 'SYSTEM RULES'.length }, { role: 'user', chars: 'hello'.length }],
    })

    const capture = await readSessionWireCapture(SESSION_ID, { root })
    expect(capture?.truncated).toBe(true)
    expect(capture?.summary.system?.chars).toBe('SYSTEM RULES'.length)
    expect(capture?.messages).toEqual([])
    await ctx.fiber.dispose()
  })

  it('prunes captures beyond the retention bound', async () => {
    const root = await useWireLog()
    process.env.DSH_WIRE_SESSION_RETAIN = '2'
    const ctx = await runtime()
    for (const id of ['session-wire-a', 'session-wire-b', 'session-wire-c']) {
      await collect(ctx.llm.stream(request({ sessionId: id as Branded<'SessionId'> })))
      await readJson(join(root, 'wire-sessions', `${id}.json`))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const names = await readdir(join(root, 'wire-sessions'))
    expect(names.sort()).toEqual(['session-wire-b.json', 'session-wire-c.json'])
    await ctx.fiber.dispose()
  })
})
