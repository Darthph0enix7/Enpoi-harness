import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/list-agents.ts'
import { parkParent } from './park-parent.ts'
import { TestSessionQuery } from './test-session-query.ts'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
const contexts = new Set<Context>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setupWith(adapter: MockAdapter | GatedAdapter) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-list-agents-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent, adapter }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a continuable child released its current Activation. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('dsh-tool-subagent-control/list-agents', () => {
  it('registers list_agents once, globally, with optional scope, filters, and paging parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'list_agents')
    expect(schemas).toHaveLength(1)
    const parameters = schemas[0]!.parameters as {
      properties?: Record<string, { enum?: string[]; description?: string }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties ?? {})).toEqual(['scope', 'status', 'query', 'limit', 'offset'])
    expect(parameters.properties?.scope?.enum).toEqual(['children', 'descendants'])
    expect(parameters.properties?.status?.enum).toEqual(['running', 'inactive'])
    expect(parameters.required ?? []).toEqual([])
    expect(parameters.properties?.scope?.description).toContain('accept send_message in any status')
    expect(parameters.properties?.scope?.description).toContain('accept only interrupt_agent')
    expect(parameters.properties?.query?.description).toContain('Case-insensitive substring match')
    expect(parameters.properties?.limit?.description).toContain('default 20')
    expect(parameters.properties?.limit?.description).toContain('max 100')
    expect(parameters.properties?.offset?.description).toContain('default 0')
    expect(schemas[0]!.description).toContain('bound only the displayed text')
    expect(schemas[0]!.description).toContain('returns every matching row to code')
  })

  it('renders the empty result as (no subagents)', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('(no subagents)')
  })

  it('renders running children first, then inactive ones by most recent creation', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'real child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    // Pin the render deterministically past the service: the tool is a thin
    // adapter, so its fixed text forms are what this test pins. Status comes
    // from the live Agent registry, stubbed per candidate id.
    const entries: SubagentCatalogEntry[] = [
      {
        id: SessionId('one-shot-child'),
        createdAt: 1,
        seq: SessionSeq(1),
        label: 'finished once',
        mode: 'one-shot',
      },
      {
        id: started.childId,
        createdAt: 2,
        seq: SessionSeq(2),
        label: 'real child',
        mode: 'continuable',
      },
      {
        id: SessionId('running-child'),
        createdAt: 3,
        seq: SessionSeq(3),
        label: 'still working',
        mode: 'continuable',
      },
      {
        id: SessionId('waiting-child'),
        createdAt: 4,
        seq: SessionSeq(4),
        label: 'waiting on descendants',
        mode: 'continuable',
      },
    ]
    ctx.subagents.listChildren = () => Promise.resolve(entries)
    const agents = new Map<string, {
      status: 'running' | 'idle'
    }>([
      ['running-child', { status: 'running' }],
      ['waiting-child', { status: 'idle' }],
    ])
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => agents.get(id) as never)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'running-child [running] — still working\n'
      + 'waiting-child [inactive] — waiting on descendants\n'
      + `${started.childId} [inactive] — real child`,
    )
  })

  it('caps the page at limit, always showing running rows and a range footer with the next offset', async () => {
    const { ctx, parent } = await setup([])
    // 30 historical children; the newest is running. The cap must keep the
    // running row visible and summarize the 29 inactive ones.
    const entries: SubagentCatalogEntry[] = Array.from({ length: 30 }, (_, index) => ({
      id: SessionId(`child-${String(index)}`),
      createdAt: index,
      seq: SessionSeq(index + 1),
      label: `child ${String(index)}`,
      mode: 'continuable',
    }))
    ctx.subagents.listChildren = () => Promise.resolve(entries)
    vi.spyOn(ctx.agents, 'get').mockImplementation(id =>
      id === SessionId('child-29') ? { status: 'running' } as never : undefined)

    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    const lines = text(result).split('\n')
    expect(lines[0]).toBe('child-29 [running] — child 29')
    // 19 most recent inactive rows fill the page.
    expect(lines[1]).toBe('child-28 [inactive] — child 28')
    expect(lines[19]).toBe('child-10 [inactive] — child 10')
    expect(lines[20]).toBe('… showing 1–20 of 30 children (1 running, 29 inactive);')
    expect(lines[21]).toBe('Use offset 20 for the next page.')

    const narrowed = await callTool(ctx, 'list_agents', { limit: 2 }, parent)
    expect(text(narrowed)).toBe(
      'child-29 [running] — child 29\n'
      + 'child-28 [inactive] — child 28\n'
      + '… showing 1–2 of 30 children (1 running, 29 inactive);\n'
      + 'Use offset 2 for the next page.',
    )
  })

  it('applies status and query filters in execute so structured output is the filtered set', async () => {
    const { ctx, parent } = await setup([])
    const entries: SubagentCatalogEntry[] = [
      { id: SessionId('parser-host'), createdAt: 1, seq: SessionSeq(1), label: 'Host runtime', mode: 'continuable' },
      { id: SessionId('child-parser'), createdAt: 2, seq: SessionSeq(2), label: 'Parser fix', mode: 'continuable' },
      { id: SessionId('child-docs'), createdAt: 3, seq: SessionSeq(3), label: 'Docs pass', mode: 'continuable' },
      { id: SessionId('child-review'), createdAt: 4, seq: SessionSeq(4), label: 'PARSER review', mode: 'continuable' },
    ]
    ctx.subagents.listChildren = () => Promise.resolve(entries)
    vi.spyOn(ctx.agents, 'get').mockImplementation(id =>
      id === SessionId('child-review') ? { status: 'running' } as never : undefined)

    // `query` matches the id and the label, case-insensitively, and keeps the
    // running-first order over the matching rows only.
    const byQuery = await callTool(ctx, 'list_agents', { query: 'PARSER' }, parent)
    expect(byQuery.isError).toBe(false)
    expect(byQuery.value).toMatchObject([
      { kind: 'child', id: 'child-review', status: 'running', label: 'PARSER review' },
      { kind: 'child', id: 'child-parser', status: 'inactive', label: 'Parser fix' },
      { kind: 'child', id: 'parser-host', status: 'inactive', label: 'Host runtime' },
    ])
    expect(text(byQuery)).toBe(
      'child-review [running] — PARSER review\n'
      + 'child-parser [inactive] — Parser fix\n'
      + 'parser-host [inactive] — Host runtime',
    )

    const byStatus = await callTool(ctx, 'list_agents', { status: 'inactive' }, parent)
    expect(byStatus.value).toHaveLength(3)
    expect(byStatus.value).toMatchObject([
      { id: 'child-docs' },
      { id: 'child-parser' },
      { id: 'parser-host' },
    ])

    const combined = await callTool(ctx, 'list_agents', { status: 'running', query: 'parser' }, parent)
    expect(combined.value).toHaveLength(1)
    expect(combined.value).toMatchObject([{ id: 'child-review' }])
    expect(text(combined)).toBe('child-review [running] — PARSER review')

    // `limit` pages only the text; the structured value keeps every match.
    const paged = await callTool(ctx, 'list_agents', { query: 'parser', limit: 1 }, parent)
    expect(paged.value).toHaveLength(3)
    expect(text(paged)).toBe(
      'child-review [running] — PARSER review\n'
      + '… showing 1 of 3 matching children (1 running, 2 inactive);\n'
      + 'Use offset 1 for the next page.',
    )
  })

  it('reports no matching subagents when a filter excludes every row', async () => {
    const { ctx, parent } = await setup([])
    ctx.subagents.listChildren = () => Promise.resolve([
      { id: SessionId('only-child'), createdAt: 1, seq: SessionSeq(1), label: 'Docs pass', mode: 'continuable' },
    ])
    const byQuery = await callTool(ctx, 'list_agents', { query: 'parser' }, parent)
    expect(byQuery.isError).toBe(false)
    expect(byQuery.value).toEqual([])
    expect(text(byQuery)).toBe('(no matching subagents)')
    const byStatus = await callTool(ctx, 'list_agents', { status: 'running' }, parent)
    expect(byStatus.value).toEqual([])
    expect(text(byStatus)).toBe('(no matching subagents)')
  })

  it('pages 150 historical children while the structured result keeps all 150 rows', async () => {
    const { ctx, parent } = await setup([])
    ctx.subagents.listChildren = () => Promise.resolve(Array.from({ length: 150 }, (_, index) => ({
      id: SessionId(`child-${String(index)}`),
      createdAt: index,
      seq: SessionSeq(index + 1),
      label: `child ${String(index)}`,
      mode: 'continuable' as const,
    })))

    const first = await callTool(ctx, 'list_agents', {}, parent)
    expect(first.value).toHaveLength(150)
    const firstLines = text(first).split('\n')
    expect(firstLines).toHaveLength(22)
    expect(firstLines[0]).toBe('child-149 [inactive] — child 149')
    expect(firstLines[19]).toBe('child-130 [inactive] — child 130')
    expect(firstLines[20]).toBe('… showing 1–20 of 150 children (0 running, 150 inactive);')
    expect(firstLines[21]).toBe('Use offset 20 for the next page.')

    const middle = await callTool(ctx, 'list_agents', { offset: 20 }, parent)
    expect(middle.value).toHaveLength(150)
    const middleLines = text(middle).split('\n')
    expect(middleLines[0]).toBe('child-129 [inactive] — child 129')
    expect(middleLines[19]).toBe('child-110 [inactive] — child 110')
    expect(middleLines[20]).toBe('… showing 21–40 of 150 children (0 running, 150 inactive);')
    expect(middleLines[21]).toBe('Use offset 40 for the next page.')

    const maxPage = await callTool(ctx, 'list_agents', { limit: 100 }, parent)
    expect(maxPage.value).toHaveLength(150)
    const maxLines = text(maxPage).split('\n')
    expect(maxLines).toHaveLength(102)
    expect(maxLines[100]).toBe('… showing 1–100 of 150 children (0 running, 150 inactive);')
    expect(maxLines[101]).toBe('Use offset 100 for the next page.')

    // A final partial page reports its range and stops paging.
    const tail = await callTool(ctx, 'list_agents', { offset: 140 }, parent)
    const tailLines = text(tail).split('\n')
    expect(tail.value).toHaveLength(150)
    expect(tailLines).toHaveLength(11)
    expect(tailLines[0]).toBe('child-9 [inactive] — child 9')
    expect(tailLines[9]).toBe('child-0 [inactive] — child 0')
    expect(tailLines[10]).toBe('… showing 141–150 of 150 children (0 running, 150 inactive);')

    const lastRow = await callTool(ctx, 'list_agents', { offset: 149 }, parent)
    expect(text(lastRow)).toBe(
      'child-0 [inactive] — child 0\n'
      + '… showing 150 of 150 children (0 running, 150 inactive);',
    )

    const beyond = await callTool(ctx, 'list_agents', { offset: 200 }, parent)
    expect(beyond.value).toHaveLength(150)
    expect(text(beyond)).toBe(
      '… showing 0 of 150 children (0 running, 150 inactive); '
      + 'offset 200 is past the last child. Use offset 0 to return to the first page.',
    )
  })

  it('omits the footer at exact page boundaries and clamps page bounds', async () => {
    const { ctx, parent } = await setup([])
    ctx.subagents.listChildren = () => Promise.resolve(Array.from({ length: 20 }, (_, index) => ({
      id: SessionId(`child-${String(index)}`),
      createdAt: index,
      seq: SessionSeq(index + 1),
      label: `child ${String(index)}`,
      mode: 'continuable' as const,
    })))
    const exact = await callTool(ctx, 'list_agents', {}, parent)
    expect(text(exact).split('\n')).toHaveLength(20)
    expect(text(exact)).not.toContain('… showing')

    const clamped = await callTool(ctx, 'list_agents', { offset: -5, query: '   ' }, parent)
    expect(text(clamped)).toBe(text(exact))

    const tiny = await callTool(ctx, 'list_agents', { limit: 1, offset: 0 }, parent)
    expect(text(tiny)).toBe(
      'child-19 [inactive] — child 19\n'
      + '… showing 1 of 20 children (0 running, 20 inactive);\n'
      + 'Use offset 1 for the next page.',
    )
    // `limit` below 1 clamps up to one row rather than rendering nothing.
    const zeroLimit = await callTool(ctx, 'list_agents', { limit: 0 }, parent)
    expect(text(zeroLimit)).toBe(text(tiny))
  })

  it('keeps duplicate creation times in catalog order and pages them deterministically', async () => {
    const { ctx, parent } = await setup([])
    ctx.subagents.listChildren = () => Promise.resolve([
      { id: SessionId('first'), createdAt: 7, seq: SessionSeq(1), label: 'first', mode: 'continuable' },
      { id: SessionId('second'), createdAt: 7, seq: SessionSeq(2), label: 'second', mode: 'continuable' },
      { id: SessionId('third'), createdAt: 7, seq: SessionSeq(3), label: 'third', mode: 'continuable' },
    ])
    const page = { limit: 1, offset: 1 }
    const once = await callTool(ctx, 'list_agents', page, parent)
    const twice = await callTool(ctx, 'list_agents', page, parent)
    expect(text(once)).toBe(
      'second [inactive] — second\n'
      + '… showing 2 of 3 children (0 running, 3 inactive);\n'
      + 'Use offset 2 for the next page.',
    )
    expect(text(twice)).toBe(text(once))
  })

  it('resolves omitted scope to children and passes the parent id and cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listChildren = vi.spyOn(ctx.subagents, 'listChildren').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', {}, parent, signal)

    expect(result.isError).toBe(false)
    expect(listChildren).toHaveBeenCalledWith(parent.id, signal)
  })

  it('lists a real settled continuable child and omits a real one-shot sibling', async () => {
    const { ctx, parent } = await setup([textResponse('once'), textResponse('done')])
    const oneShot = await ctx.subagents.start('spawn', {
      label: 'finished once',
      prompt: [{ type: 'text', text: 'one-shot task' }],
      parent,
      signal: new AbortController().signal,
    })
    await oneShot.result
    await oneShot.dispose()
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'summarize the doc',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const result = await callTool(ctx, 'list_agents', {}, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`${started.childId} [inactive] — summarize the doc`)
  })

  it('describes inactive as turn availability and pins the status vocabulary', async () => {
    const { ctx } = await setup([])
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'list_agents')
    // Completion reaches the parent through its notice; listing is discovery,
    // so its inactive status must not send the model looking for a result.
    expect(schema?.description).toContain('You will be notified when a subagent finishes')
    expect(schema?.description).toContain('inactive means it is not currently working')
    // One-shot children never appear as rows, so the description must not let
    // the model read the empty result as "no child ran".
    expect(schema?.description).toContain('one-shot delegations are not listed')
    // The enum is the closed vocabulary the model renders, so pin it rather than
    // scanning prose that legitimately reads "not to poll for completion".
    const variants = ctx.tools.get('list_agents')?.output.schema.items?.oneOf ?? []
    const child = variants.find(variant => variant.properties?.kind?.enum?.includes('child'))
    expect(child?.properties?.status?.enum).toEqual(['running', 'inactive'])
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'list_agents', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'list_agents')).toBe(false)
  })

  it('has the namespace-plugin export shape', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-list-agents')
    expect(tool.inject).toEqual(['tools', 'subagents', 'agents'])
    expect(typeof tool.apply).toBe('function')
  })

  it('walks the complete descendant tree in pre-order with parent and depth annotations', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'waiting branch',
      request: { prompt: [{ type: 'text', text: 'branch work' }], parent },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'nested leaf',
      request: { prompt: [{ type: 'text', text: 'leaf work' }], parent: child },
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    // The branch finishes its own turn but stays resident waiting on the
    // grandchild it owns: the live-registry `idle` status.
    releaseChild.resolve(undefined)
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)?.status).toBe('idle')
    }, { timeout: 5_000 })

    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      `${started.childId} [inactive] parent=${parent.id} depth=1 — waiting branch\n`
      + `${grandchild.childId} [running] parent=${started.childId} depth=2 — nested leaf`,
    )

    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('omits one-shot intermediates from descendants output while surfacing what they own', async () => {
    const { ctx, parent } = await setup([])
    // Deterministic service rows: a one-shot intermediate owning a continuable
    // leaf, plus a positioned diagnostic. The tool filters only the one-shot.
    ctx.subagents.listDescendants = () => Promise.resolve([
      {
        kind: 'child',
        id: SessionId('one-shot-mid'),
        label: 'one-shot intermediate',
        mode: 'one-shot',
        seq: SessionSeq(1),
        activity: 'inactive',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: SessionId('deep-leaf'),
        label: 'deep leaf',
        mode: 'continuable',
        seq: SessionSeq(2),
        activity: 'inactive',
        hasChildren: false,
        parentId: SessionId('one-shot-mid'),
        depth: 2,
      },
      {
        kind: 'diagnostic',
        id: SessionId('broken-node'),
        reason: 'unavailable',
        parentId: parent.id,
        depth: 1,
      },
    ])
    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'deep-leaf [inactive] parent=one-shot-mid depth=2 — deep leaf\n'
      + `broken-node [diagnostic: unavailable] parent=${parent.id} depth=1`,
    )
  })

  it('filters descendants in tree pre-order and omits diagnostics under a status filter', async () => {
    const { ctx, parent } = await setup([])
    ctx.subagents.listDescendants = () => Promise.resolve([
      {
        kind: 'child',
        id: SessionId('branch-node'),
        label: 'branch node',
        mode: 'continuable',
        seq: SessionSeq(1),
        activity: 'running',
        hasChildren: true,
        parentId: parent.id,
        depth: 1,
      },
      {
        kind: 'child',
        id: SessionId('leaf-node'),
        label: 'deep leaf',
        mode: 'continuable',
        seq: SessionSeq(2),
        activity: 'inactive',
        hasChildren: false,
        parentId: SessionId('branch-node'),
        depth: 2,
      },
      {
        kind: 'diagnostic',
        id: SessionId('leaf-broken'),
        reason: 'corrupt',
        parentId: SessionId('branch-node'),
        depth: 2,
      },
    ])
    vi.spyOn(ctx.agents, 'get').mockImplementation(id =>
      id === SessionId('branch-node') ? { status: 'running' } as never : undefined)

    const running = await callTool(ctx, 'list_agents', { scope: 'descendants', status: 'running' }, parent)
    expect(running.value).toMatchObject([{ kind: 'child', id: 'branch-node', status: 'running' }])
    expect(text(running)).toBe(`branch-node [running] parent=${parent.id} depth=1 — branch node`)

    // A query still selects a diagnostic by id, and matching rows keep the
    // service's tree pre-order.
    const byQuery = await callTool(ctx, 'list_agents', { scope: 'descendants', query: 'LEAF' }, parent)
    expect(byQuery.value).toMatchObject([
      { kind: 'child', id: 'leaf-node', status: 'inactive' },
      { kind: 'diagnostic', id: 'leaf-broken', reason: 'corrupt' },
    ])
    expect(text(byQuery)).toBe(
      'leaf-node [inactive] parent=branch-node depth=2 — deep leaf\n'
      + 'leaf-broken [diagnostic: corrupt] parent=branch-node depth=2',
    )

    const inactive = await callTool(ctx, 'list_agents', { scope: 'descendants', status: 'inactive' }, parent)
    expect(inactive.value).toHaveLength(1)
    expect(inactive.value).toMatchObject([{ kind: 'child', id: 'leaf-node' }])
  })

  it('preserves explicit descendants scope and forwards the tool cancellation signal', async () => {
    const { ctx, parent } = await setup([])
    const signal = new AbortController().signal
    const listDescendants = vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])

    const result = await callTool(ctx, 'list_agents', { scope: 'descendants' }, parent, signal)

    expect(result.isError).toBe(false)
    expect(listDescendants).toHaveBeenCalledWith(parent.id, signal)
  })
})
