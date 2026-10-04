import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/core/engine.ts', () => ({
  runCouncil: vi.fn(async () => ({
    deliverable: '# Report\n\nSynthetic council output.',
    roundsRun: 2,
    stopReason: 'all ledger entries reached terminal states',
    ledgerState: { epoch: 2, entries: [], edges: [] },
    vaultAdditions: 0,
    quality: { cruxResolutionRatio: 1, adversarialSurvivability: 0, invariantDensity: 0, newClusters: null },
    totalTokens: 0,
    audit: [],
  })),
}))

import { runCouncil } from '../src/core/engine.ts'
import { councilListView, loadCouncilRegistry } from '../src/registry.ts'
import { registerCouncilTools } from '../src/tools.ts'

/**
 * Host-side council registry tests: settings-defined councils, the management
 * tools, per-council tools, hot-swap, and the `enpoiCouncil` RPC projection.
 * The engine is mocked — its spec-driven behaviour is covered by
 * engine-integration.spec.ts; here the assertions are about the wiring.
 */

interface ToolLike {
  name: string
  description: string
  parameters: { properties: Record<string, unknown>; required?: string[] }
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function makeHost(councils?: Record<string, unknown>, opts: { writable?: boolean } = {}) {
  const tools = new Map<string, ToolLike>()
  const writes: Array<{ path: string[]; value: unknown }> = []
  const listeners: Array<(ns: unknown) => void> = []
  const doc: Record<string, unknown> = councils === undefined ? {} : { councils }
  const settingsScope = {
    get: (ns: string) => (ns === 'enpoi-orchestration' ? { personas: {}, ...doc } : undefined),
    describe: () => [{ ns: 'enpoi-orchestration', revision: 1 }],
    ...(opts.writable === false ? {} : {
      mutate: async (_ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>) => {
        for (const op of ops) {
          if (op.op !== 'set' || op.value === undefined) continue
          writes.push({ path: [...op.path], value: op.value })
          if (op.path.length === 2 && op.path[0] === 'councils') {
            doc.councils = { ...(doc.councils ?? {}), [op.path[1] as string]: op.value }
          }
        }
      },
    }),
  }
  const ctx = {
    get: (ns: string) => (ns === 'settings' ? settingsScope : undefined),
    tools: {
      register: (definition: ToolLike) => {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    on: (event: string, callback: (ns: unknown) => void) => {
      if (event === 'settings/updated') listeners.push(callback)
      return () => {
        const index = listeners.indexOf(callback)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  return {
    ctx: ctx as never,
    tools,
    writes,
    doc,
    fireSettingsUpdated: (ns: string) => { for (const listener of listeners) listener(ns) },
  }
}

function declarativeCouncil(id = 'myreview'): Record<string, unknown> {
  return {
    id,
    label: 'My Code Review',
    description: 'Two-seat code review council.',
    seats: [
      { id: 'generalist', label: 'Generalist', persona: 'You review for correctness.', opGates: ['finding'], family: 'systemic' },
      { id: 'critic', label: 'Critic', persona: 'You attack every assumption.', opGates: ['finding'], family: 'adversarial' },
    ],
    ledgerKinds: [{ kind: 'finding', idPrefix: 'F', terminalStatuses: ['invariant', 'falsified'] }],
    actions: ['CONCEDE', 'DEFEND'],
    steelman: true,
    scopeContract: 'Stay on the code under review.',
    opening: 'blind',
    forestMode: false,
    deliverableSections: ['Decision', 'Findings', 'Evidence'],
    stoppingPolicy: { type: 'ledger_convergence', stagnationLimit: 3 },
    chairTemplate: {
      systemPrompt: 'You are the review chair.',
      userPromptTemplate: 'Compile {{label}} for {{query}} from {{ledger}} with sections {{sections}}.',
    },
  }
}

function fakeExec() {
  return { agent: { session: { id: 'parent-session', append: vi.fn() } }, signal: new AbortController().signal }
}

beforeEach(() => {
  vi.mocked(runCouncil).mockClear()
  vi.restoreAllMocks()
})

describe('council registry + tools', () => {
  it('council_list shows the built-ins and their seats', async () => {
    const host = makeHost()
    registerCouncilTools(host.ctx, host.ctx)
    expect([...host.tools.keys()].sort()).toEqual(['chorus', 'council_list', 'council_register', 'roundtable'])

    const listed = await host.tools.get('council_list')!.execute({}) as { councils: Array<{ id: string; label: string; enabled: boolean; builtin: boolean; seats: Array<{ id: string }> }> }
    expect(listed.councils.map(entry => entry.id)).toEqual(['roundtable', 'chorus'])
    expect(listed.councils[0]).toMatchObject({ id: 'roundtable', label: 'Architecture Roundtable', enabled: true, builtin: true })
    expect(listed.councils[0].seats.map(seat => seat.id)).toEqual(['skeptic', 'architect', 'pragmatist'])
    expect(listed.councils[1].seats.map(seat => seat.id)).toEqual(['visionary', 'experiencer', 'integrator'])
  })

  it('registers a settings-defined council and runs the engine with that spec', async () => {
    const host = makeHost({ myreview: declarativeCouncil() })
    registerCouncilTools(host.ctx, host.ctx)

    const tool = host.tools.get('myreview')
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.parameters.properties).sort()).toEqual(['context', 'task'])

    const result = await tool!.execute(
      { task: 'Review the upload retry logic', context: 'src/upload.ts' },
      fakeExec(),
    ) as { report: string; roundsRun: number; stopReason: string }
    expect(result.roundsRun).toBe(2)
    expect(result.report).toContain('Synthetic council output')

    expect(runCouncil).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(runCouncil).mock.calls[0][2]
    expect(opts.spec.id).toBe('myreview')
    expect(opts.spec.seats.map(seat => seat.id)).toEqual(['generalist', 'critic'])
    expect(opts.query).toContain('Review the upload retry logic')
    expect(opts.query).toContain('src/upload.ts')
    expect(opts.params.stagnationLimit).toBe(3)
    expect(opts.chairTemplate?.systemPrompt).toBe('You are the review chair.')
  })

  it('rejects an invalid settings spec loudly and disables the entry', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const broken = {
      ...declarativeCouncil('broken'),
      seats: [
        { id: 'referee', label: 'R', persona: 'p' },
        { id: 'referee', label: 'R2', persona: 'p' },
      ],
    }
    const host = makeHost({ broken })
    const registry = loadCouncilRegistry(host.ctx)
    const entry = registry.entries.find(candidate => candidate.id === 'broken')!
    expect(entry.enabled).toBe(false)
    expect(entry.error).toMatch(/reserved/)
    expect(registry.errors).toContainEqual({ id: 'broken', problem: expect.stringMatching(/reserved/) })

    registerCouncilTools(host.ctx, host.ctx)
    expect(host.tools.has('broken')).toBe(false)

    const output = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(output).toContain('invalid council "broken"')
    expect(output).toMatch(/reserved/)

    await expect(host.tools.get('council_register')!.execute({ id: 'bad', label: 'x' }, {}))
      .rejects.toThrow(/rejected the definition/)
  })

  it('disabling a built-in removes its tool (and hot-swap disposes it live)', () => {
    const disabled = makeHost({ roundtable: { disabled: true } })
    registerCouncilTools(disabled.ctx, disabled.ctx)
    expect(disabled.tools.has('roundtable')).toBe(false)
    expect(disabled.tools.has('chorus')).toBe(true)
    const entry = loadCouncilRegistry(disabled.ctx).entries.find(candidate => candidate.id === 'roundtable')!
    expect(entry.enabled).toBe(false)
    // Seats survive the retirement so the UI can still render the council.
    expect(entry.seats.map(seat => seat.id)).toEqual(['skeptic', 'architect', 'pragmatist'])

    const live = makeHost()
    registerCouncilTools(live.ctx, live.ctx)
    expect(live.tools.has('chorus')).toBe(true)
    live.doc.councils = { chorus: { disabled: true } }
    live.fireSettingsUpdated('enpoi-orchestration')
    expect(live.tools.has('chorus')).toBe(false)
    expect(live.tools.has('roundtable')).toBe(true)
  })

  it('keeps the rich built-in signature when settings rewrites the built-in spec', async () => {
    const host = makeHost({ roundtable: declarativeCouncil('roundtable') })
    registerCouncilTools(host.ctx, host.ctx)
    const tool = host.tools.get('roundtable')!
    expect(Object.keys(tool.parameters.properties)).toEqual(['query', 'maxRounds', 'hideLimit'])
    expect(tool.parameters.required).toEqual(['query'])

    await tool.execute({ query: 'Which queue?' }, fakeExec())
    const opts = vi.mocked(runCouncil).mock.calls[0][2]
    expect(opts.spec.seats.map(seat => seat.id)).toEqual(['generalist', 'critic'])
    // Declarative extras survive the built-in override (never silently dropped).
    expect(opts.params.stagnationLimit).toBe(3)
    expect(opts.chairTemplate?.systemPrompt).toBe('You are the review chair.')
  })

  it('council_register persists through settings and hot-swaps the tool in', async () => {
    const host = makeHost()
    registerCouncilTools(host.ctx, host.ctx)
    const result = await host.tools.get('council_register')!.execute(declarativeCouncil('myreview'), {})
    expect(result).toEqual({ id: 'myreview', enabled: true })
    expect(host.tools.has('myreview')).toBe(true)
    expect(host.writes.at(-1)?.path).toEqual(['councils', 'myreview'])

    const listed = await host.tools.get('council_list')!.execute({}) as { councils: Array<{ id: string; enabled: boolean }> }
    expect(listed.councils.find(council => council.id === 'myreview')).toMatchObject({ enabled: true })
  })

  it('council_register fails loud without a writable settings service', async () => {
    const host = makeHost(undefined, { writable: false })
    registerCouncilTools(host.ctx, host.ctx)
    await expect(host.tools.get('council_register')!.execute(declarativeCouncil('myreview'), {}))
      .rejects.toThrow(/writable settings service/)
  })

  it('enpoiCouncil.list projects ids, labels, seats, arbiters, and enabled state', () => {
    const host = makeHost({ myreview: declarativeCouncil() })
    const view = councilListView(host.ctx)
    expect(view.councils.map(council => council.id)).toEqual(['roundtable', 'chorus', 'myreview'])
    expect(view.councils[2]).toEqual({
      id: 'myreview',
      label: 'My Code Review',
      seats: [
        { id: 'generalist', label: 'Generalist', family: 'systemic' },
        { id: 'critic', label: 'Critic', family: 'adversarial' },
      ],
      arbiters: ['referee', 'chair'],
      enabled: true,
    })
    const disabled = makeHost({ roundtable: { disabled: true } })
    expect(councilListView(disabled.ctx).councils[0]).toMatchObject({ id: 'roundtable', enabled: false })
  })
})
