import { describe, expect, it, vi } from 'vitest'
import { apply, resolveOracleChainAttempts } from '../src/index.ts'

/**
 * Oracle chain-link specs (doc 60): the oracle consultation child is spawned
 * on link 1 and — when its turn fails (error/timeout/cut) — respawned on the
 * NEXT link from the start-of-call snapshot. Dependency-light: the ctx seam is
 * a small fake and the keeper brief anchor is stubbed.
 */

const STABLE_CHAIN = {
  id: 'stable',
  label: 'Stable',
  links: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p2', model: 'm2' },
  ],
  attempts: 2,
  onCut: 'failover',
}

const VERDICT = 'Reviewed thoroughly.\n{"approved":true,"concerns":["minor"],"unverified":[],"blockers":[]}'

function makeOracleCtx(opts: {
  personas?: Record<string, unknown>
  chain?: unknown
  failFirstChild?: boolean
}) {
  const spawns: Array<{ provider?: string; model?: string; chain?: string }> = []
  let spawnSeq = 0
  const failed = new Set<number>()

  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ personas: opts.personas ?? {} }) }
      if (ns === 'modelChains') return { resolve: (id: string) => (id === 'stable' ? opts.chain ?? STABLE_CHAIN : undefined) }
      if (ns === 'sessions') return { get: () => undefined, delete: async () => undefined }
      if (ns === 'agents') return { get: () => undefined }
      if (ns === 'sessionPersistence') {
        return {
          open: async (childId: string) => ({
            read: async () => {
              const seq = Number(childId.split('-')[1] ?? '0')
              const shouldFail = opts.failFirstChild === true && seq === 1 && !failed.has(seq)
              if (shouldFail) failed.add(seq)
              const events = shouldFail
                ? [{ type: 'turn/end', seq: 2, data: { reason: { kind: 'error', error: { message: 'provider exploded' } } } }]
                : [
                    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: VERDICT }] } } },
                    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
                  ]
              return { events }
            },
            close: async () => undefined,
          }),
        }
      }
      return undefined
    },
    agents: { get: () => undefined },
    inject: (_names: unknown, callback: (c: unknown) => void) => { callback(ctx); return () => undefined },
    on: () => () => undefined,
    tools: {
      register: (def: { name: string }) => { if (def.name === 'oracle_review') registered = def },
    },
    subagents: {
      startContinuable: async (spec: { request?: { agentOptions?: { provider?: string; model?: string; chain?: string } } }) => {
        spawnSeq += 1
        spawns.push(spec.request?.agentOptions ?? {})
        return { childId: `child-${spawnSeq}-aaaa-bbbb-cccc-dddddddddddd` }
      },
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  let registered: { name: string } | undefined
  const parent = {
    session: {
      id: 'oracle-parent',
      seq: 1,
      snapshotEvents: () => [],
      append: () => undefined,
    },
  }
  return { ctx, parent, spawns, registeredTool: () => registered }
}

/** Stub the keeper's global brief anchor so the oracle's brief wait is a no-op. */
function stubKeeperBrief(): void {
  ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for('enpoi.context-keeper.brief-service')] = {
    ensureFreshBrief: async () => ({ ok: false, prose: null, reason: 'failed' }),
  }
}

describe('oracle chain attempt resolution', () => {
  it('resolves a chain assignment into the ordered attempts (active link first)', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ personas: { oracle: { chain: 'stable' } } }) }
        : ns === 'modelChains'
          ? { resolve: () => STABLE_CHAIN }
          : undefined,
    }
    const resolved = resolveOracleChainAttempts(ctx as never, 'oracle')
    expect(resolved.chainId).toBe('stable')
    expect(resolved.carryId).toBe(true)
    expect(resolved.attempts).toEqual([
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ])
  })

  it('fails open to the legacy persona/default route without a chain', () => {
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? { get: () => ({ personas: { oracle: { provider: 'solo', model: 'only' } } }) }
        : undefined,
    }
    const resolved = resolveOracleChainAttempts(ctx as never, 'oracle')
    expect(resolved.chainId).toBeUndefined()
    expect(resolved.carryId).toBe(false)
    expect(resolved.attempts).toEqual([{ provider: 'solo', model: 'only' }])
    const none = resolveOracleChainAttempts({ get: () => undefined } as never, 'oracle')
    expect(none.attempts).toEqual([{}])
  })
})

describe('oracle child link advance (oracle_review execute)', () => {
  it('advances to link 2 when the first child turn fails', async () => {
    stubKeeperBrief()
    const { ctx, parent, spawns, registeredTool } = makeOracleCtx({
      personas: { oracle: { chain: 'stable' } },
      failFirstChild: true,
    })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })
    apply(ctx as never)
    const tool = registeredTool()
    expect(tool).toBeDefined()
    expect(tool!.name).toBe('oracle_review')

    const result = await (tool as unknown as {
      execute: (args: { request: string }, exec: { agent: unknown; signal: AbortSignal }) => Promise<{ approved: boolean; rejected?: boolean }>
    }).execute({ request: 'review this plan' }, { agent: parent, signal: new AbortController().signal })

    expect(spawns).toEqual([
      { provider: 'p1', model: 'm1', chain: 'stable' },
      { provider: 'p2', model: 'm2', chain: 'stable' },
    ])
    expect(result.approved).toBe(true)
    expect(written.some(line => line.includes('[model-chain] stable: link 1 (p1/m1)'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('keeps the legacy single-route behaviour without a chain', async () => {
    stubKeeperBrief()
    const { ctx, parent, spawns, registeredTool } = makeOracleCtx({
      personas: { oracle: { provider: 'solo', model: 'only' } },
      failFirstChild: true,
    })
    apply(ctx as never)
    const result = await (registeredTool() as unknown as {
      execute: (args: { request: string }, exec: { agent: unknown; signal: AbortSignal }) => Promise<{ approved: boolean; rejected?: boolean; blockers: string[] }>
    }).execute({ request: 'review this plan' }, { agent: parent, signal: new AbortController().signal })

    expect(spawns).toEqual([{ provider: 'solo', model: 'only' }])
    expect(result.rejected).toBe(true)
    expect(result.blockers[0]).toContain('ORACLE_MODEL_ERROR')
  })
})
