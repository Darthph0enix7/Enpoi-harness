/**
 * Real-composition boot (L2 acceptance): the shipped
 * `@deepseek-ai/dsh-compaction-basic` backend, the real tool runtime, and this
 * plugin mounted in one Cordis composition. A scripted adapter writes one
 * model summary with a `## Durable Facts` section; the run must land committed
 * `origin = 'compaction'` rows and `memory_search` must find them in the
 * session's cwd and not from another workspace.
 *
 * The profile tree does not link `@deepseek-ai/cordis-plugin-loader` (only the
 * harness workspace carries it), so the composition is built with `ctx.plugin`
 * over the same real modules instead of a YAML Loader boot; every service and
 * plugin boundary the runtime crosses is the real one.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyMemory, Config as MemoryConfig } from '../src/index'

const MODEL = 'mock'
const SIGNAL = new AbortController().signal

/** A scripted summarizer: every call returns a framed summary with durable facts. */
class DurableFactsAdapter extends LlmAdapter {
  readonly prompts: RequestMessage[][] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
    })
  }

  override async * stream(options: { messages: readonly RequestMessage[] }): AsyncIterable<StreamChunk> {
    this.prompts.push([...options.messages])
    const text = [
      '## Critical Context',
      '- continuing the loader composition work',
      '',
      '## Durable Facts',
      '- [decision] Loader composition captures compaction durable facts into memory',
      '- [fact] The mock summarizer wrote this checkpoint in the loader test',
    ].join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let context: Context | undefined
let dbRoot: string | undefined
let previousDb: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (dbRoot !== undefined) await rm(dbRoot, { recursive: true, force: true })
  dbRoot = undefined
  if (previousDb === undefined) delete process.env.DSH_MEMORY_DB
  else process.env.DSH_MEMORY_DB = previousDb
  previousDb = undefined
})

/** One closed three-turn conversation with a real (cwd-bearing) header. */
function conversation(ctx: Context, cwd: string): Session {
  // Store-created: its appends dispatch `session/event` on the host context,
  // exactly like a live session, which a detached Session.create cannot do.
  const session = ctx.sessions.create(SessionId(`loader-memory-${Date.now()}`), { meta: { cwd } })
  const text = 'fixture '.repeat(40).trim()
  for (let turn = 1; turn <= 3; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

async function bootComposition(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  // ToolRuntime injects `systemPrompt`; the real service must exist before it.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({
    name: 'enpoi-memory',
    inject: ['tools'],
    Config: MemoryConfig,
    apply: applyMemory,
  })
  await ctx.plugin(BasicCompactionEngine, {
    auto: false,
    summarizationProvider: MODEL,
    summarizationModel: MODEL,
    maxTokens: 8192,
  })
  return ctx
}

/** Let the subscriber's scheduled write run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('real composition: compaction-basic + enpoi-memory', () => {
  it('captures the summary facts and scopes them to the session workspace', async () => {
    dbRoot = await mkdtemp(join(tmpdir(), 'dsh-memory-db-'))
    const dbPath = join(dbRoot, 'memory.db')
    previousDb = process.env.DSH_MEMORY_DB
    process.env.DSH_MEMORY_DB = dbPath

    const loaded = await bootComposition()
    const adapter = new DurableFactsAdapter()
    loaded.llm.registerAdapter([MODEL], adapter)

    const engine = loaded.get('compaction') as BasicCompactionEngine
    expect(engine).toBeInstanceOf(BasicCompactionEngine)

    const session = conversation(loaded, '/work/loader-a')
    const agent = { session, options: { provider: MODEL, model: MODEL } } as unknown as Agent
    const before = [...session.surface.nodes]
    const result = await engine.compactRegion(before[0]!, before[3]!, agent, SIGNAL)
    expect(result.summary.length).toBeGreaterThan(0)
    // The model wrote the Durable Facts section into the summary event.
    const summary = session.snapshotEvents().findLast(event => event.type === 'compaction/summary')
    expect(summary?.type).toBe('compaction/summary')
    if (summary?.type === 'compaction/summary') {
      expect(summary.data.provider).toBe(MODEL)
      expect(summary.data.summary.map(block => block.type === 'text' ? block.text : '').join(''))
        .toContain('## Durable Facts')
    }
    await settle()

    // Rows exist, committed, with compaction provenance.
    const inspect = new DatabaseSync(dbPath)
    try {
      const rows = inspect.prepare(`SELECT fact, category, state, origin, source_trust, provenance FROM claims ORDER BY created_at`).all()
      expect(rows).toHaveLength(2)
      const decision = rows.find(row => String(row.fact).startsWith('Loader composition')) as Record<string, unknown>
      expect(decision).toMatchObject({
        category: 'ARCHITECTURE',
        state: 'committed',
        origin: 'compaction',
        source_trust: 'verified_execution',
      })
      expect(JSON.parse(String(decision.provenance))).toMatchObject({
        source: 'compaction',
        sessionId: session.id,
        cwd: '/work/loader-a',
        summaryRoute: 'mock/mock',
      })
    } finally {
      inspect.close()
    }

    // memory_search finds them in the same workspace…
    const tools = loaded.get('tools') as { get: (name: string) => any }
    const search = tools.get('memory_search')
    const sameScope = await search.execute(
      { query: 'durable facts loader composition' },
      { agent: { session: { id: 'probe-same', header: { cwd: '/work/loader-a' } } }, signal: SIGNAL },
    ) as { facts: Array<{ origin: string; savedAt: string }> }
    expect(sameScope.facts.length).toBeGreaterThan(0)
    expect(sameScope.facts.every(fact => fact.origin === 'compaction')).toBe(true)
    expect(sameScope.facts[0]!.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // …and not from another workspace.
    const otherScope = await search.execute(
      { query: 'durable facts loader composition' },
      { agent: { session: { id: 'probe-other', header: { cwd: '/work/loader-b' } } }, signal: SIGNAL },
    ) as { facts: unknown[] }
    expect(otherScope.facts).toEqual([])
  })
})
