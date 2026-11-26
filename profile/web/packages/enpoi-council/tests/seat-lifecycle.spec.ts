import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, type TestContext } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { boot } from '@deepseek-ai/dsh-app-boot'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Council from '../src/index.ts'
import { runCouncil } from '../src/core/engine.ts'
import { COUNCIL_PARAM_DEFAULTS } from '../src/params.ts'
import { CHORUS_SPEC } from '../src/profiles/chorus.ts'
import { ROUNDTABLE_SPEC } from '../src/profiles/roundtable.ts'

const SEAT_TEXT = 'PROPOSE_CRUX: Keep leases bounded.\nSPROUT: Quiet dashboard | Show the active lease.'

class CouncilAdapter extends LlmAdapter {
  readonly firstStream = Promise.withResolvers<void>()
  readonly started = new Set<SessionId>()
  readonly stopped = new Set<SessionId>()

  constructor(private readonly hang = false) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const { sessionId, signal } = options
    if (sessionId === undefined || signal === undefined) throw new Error('expected a loop model request')
    this.started.add(sessionId)
    this.firstStream.resolve()
    try {
      if (this.hang) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        signal.throwIfAborted()
      }

      const prompt = options.messages.flatMap(message => message.role === 'user'
        ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
        .findLast(text => /(?:^|\n)(?:EPOCH: |QUERY: )/.test(text)) ?? ''
      const chorus = prompt.includes('COUNCIL: Idea Chorus')
      const spec = chorus ? CHORUS_SPEC : ROUNDTABLE_SPEC
      let text = SEAT_TEXT
      if (prompt.includes('FINAL LEDGER:')) {
        text = spec.deliverableSections.map(section => `## ${section}\n\nScripted ${spec.label} synthesis.`).join('\n\n')
      } else if (prompt.includes('SEAT OUTPUTS THIS EPOCH:')) {
        text = JSON.stringify({
          admissions: prompt.startsWith('EPOCH: 1') ? [chorus
            ? { kind: 'idea', assertion: 'Quiet dashboard', author: 'visionary' }
            : { kind: 'crux', assertion: 'Keep leases bounded.', author: 'skeptic' }] : [],
          flips: [], directives: {}, floor: { active: spec.seats.map(seat => seat.id), standby: [] }, scopeWarnings: [],
        })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      this.stopped.add(sessionId)
    }
  }
}

async function compose(test: TestContext, adapter: CouncilAdapter, maxActiveSubagents: number) {
  const root = await mkdtemp(join(tmpdir(), 'council-loader-'))
  const path = join(root, 'cordis.yml')
  let dispose: (() => Promise<void>) | undefined
  test.onTestFinished(async () => {
    try {
      await dispose?.()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  const modules = {
    'agents': AgentRegistry,
    'sessions': SessionStore,
    'session-projections': SessionProjectionRegistry,
    'session-persistence': JsonlSessionPersistence,
    'system-prompt': SystemPrompt,
    'tools': ToolRuntime,
    'llm': LlmRuntime,
    'agent-loop': AgentLoop,
    'subagents': SubagentRuntime,
    'spawn': SubagentSpawn,
    'council': Council,
  }
  const configs: Record<string, object> = {
    'session-persistence': { root: join(root, 'sessions') },
    'agent-loop': { agents: [] },
    'subagents': { maxActiveSubagents },
    'spawn': { providerName: 'spawn' },
  }
  await writeFile(path, Object.keys(modules).map(id =>
    `- id: ${id}\n  name: cordis:${id}\n  config: ${JSON.stringify(configs[id] ?? {})}\n`,
  ).join(''))
  const ctx = await boot('council-test', path, [], host => { Object.assign(host.loader.builtins, modules) })
  dispose = () => ctx.fiber.dispose()
  ctx.llm.registerAdapter(['test-council'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'test-council', model: 'script' })
  const execute = (name: 'roundtable' | 'chorus') => ctx.tools.execute({
    agent: parent, name, callId: ToolCallId(name), arguments: { query: 'How should leases be shown?', maxRounds: 1 },
    signal: new AbortController().signal,
  })
  const readSession = async (id: SessionId): Promise<readonly SessionEvent[]> => {
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      return (await handle.read(0, undefined)).events
    } finally {
      await handle.close()
    }
  }
  return { ctx, parent, execute, readSession }
}

it('releases every slot after a roundtable so chorus can run under the same cap without losing history', async (test) => {
  const adapter = new CouncilAdapter()
  const { ctx, parent, execute, readSession } = await compose(test, adapter, 4)
  const drain = vi.spyOn(ctx.subagents, 'drainContinuableChildren')

  expect(await execute('roundtable')).toMatchObject({
    isError: false, value: { synthesis: expect.stringContaining('Scripted Architecture Roundtable synthesis.') },
  })
  expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
  expect(await execute('chorus')).toMatchObject({
    isError: false, value: { harvest: expect.stringContaining('Scripted Idea Chorus synthesis.') },
  })
  expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])

  await ctx.sessions.flush(parent.session)
  const catalog = (await readSession(parent.id)).filter(event => event.type === 'subagent/catalog')
  const childIds = catalog.map(event => event.data.childId)
  expect(childIds.length).toBeGreaterThan(8)
  expect(new Set(childIds)).toEqual(adapter.started)
  expect(new Set(drain.mock.calls.flatMap(([, ids]) => ids))).toEqual(new Set(childIds))
  for (const childId of childIds) {
    expect(await readSession(childId)).toContainEqual(expect.objectContaining({ type: 'assistant/message' }))
  }
})

it('stops timed-out seat streams before respawning into the same slots and releases the failed retries', async (test) => {
  const adapter = new CouncilAdapter(true)
  const { ctx, parent, readSession } = await compose(test, adapter, 3)
  await expect(runCouncil(ctx, parent, {
    spec: ROUNDTABLE_SPEC, query: 'timeout', params: { ...COUNCIL_PARAM_DEFAULTS, debaterTimeoutMs: 500 },
    signal: new AbortController().signal,
  })).rejects.toThrow(/failed quorum.*timed out/)

  expect(adapter.started.size).toBe(6)
  expect(adapter.stopped).toEqual(adapter.started)
  expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
  for (const childId of adapter.started) {
    expect(await readSession(childId)).toContainEqual(expect.objectContaining({
      type: 'turn/end', data: expect.objectContaining({ reason: expect.objectContaining({ kind: 'aborted' }) }),
    }))
  }
})

it('releases running seats when the caller aborts', async (test) => {
  const adapter = new CouncilAdapter(true)
  const { ctx, parent } = await compose(test, adapter, 3)
  const abort = new AbortController()
  const pending = runCouncil(ctx, parent, {
    spec: CHORUS_SPEC, query: 'abort', params: COUNCIL_PARAM_DEFAULTS, signal: abort.signal,
  })
  await adapter.firstStream.promise
  abort.abort()
  await expect(pending).rejects.toThrow(/aborted/i)

  expect(adapter.started.size).toBeGreaterThan(0)
  expect(adapter.stopped).toEqual(adapter.started)
  expect(ctx.agents.list().map(agent => agent.id)).toEqual([parent.id])
})
