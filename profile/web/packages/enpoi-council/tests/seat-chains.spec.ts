import { describe, expect, it, vi } from 'vitest'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

import { runCouncil } from '../src/core/engine.ts'
import { ROUNDTABLE_SPEC } from '../src/profiles/roundtable.ts'
import type { CouncilParams } from '../src/core/spec.ts'

/**
 * Council chain-link specs (doc 60): a seat whose persona is assigned a model
 * chain spawns on link 1 and — when its fiber/turn errors — respawns on the
 * NEXT link from the start-of-seat snapshot. The scripted ctx is the
 * integration harness with `modelChains` + per-spawn agentOptions capture and
 * a first-spawn failure switch.
 */

const BASE_PARAMS: CouncilParams = {
  defaultMaxRounds: 6,
  stagnationLimit: 2,
  challengeRound: true,
  maxDebateTokens: 200000,
  debaterTimeoutMs: 5000,
  quorumFraction: 2 / 3,
  evidenceBroker: true,
  evidenceTimeoutMs: 5000,
  blindEpoch: true,
  preflightInventory: false,
  runDeadlineMs: 1_800_000,
}

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

const BLIND = 'PROPOSE_CRUX: SQLite write locks will serialize session writes under our concurrency.\nI take the position that durability matters more than latency here.'
const ARGUE = 'I maintain my position on C-1; the write volumes in this deployment are moderate. STEELMAN [skeptic]: The Skeptic is right that lock contention exists at extreme concurrency — that boundary just does not apply at our scale.'
const NEED = 'I accept the framing so far, but I need the real write pattern before conceding.\nNEED_EVIDENCE(target: queue scheduler, question: does claim_next use a database lock or a transactional row update?)'
const SHEET = 'CITATION: src/core/queue.py:142\nFACTS: claim_next acquires a transactional row update with a 5s lease.\nCONFIDENCE: high'
const CHAIR = '# Decision\n\nAdopt the transactional lease design.\n\n## Established Invariants\n- Lease-based claims.\n\n## Binding Dissents\nNone.'

function refereeJson(o: { admissions?: Array<{ kind: string; assertion: string; author: string }>; flips?: Array<{ id: string; to: string; reason: string }>; floor?: { active: string[]; standby: string[] } }): string {
  return JSON.stringify({
    admissions: o.admissions ?? [],
    flips: o.flips ?? [],
    directives: { skeptic: '1. Press it.', architect: '1. Quantify it.', pragmatist: '1. Scope it.' },
    floor: o.floor ?? { active: ['skeptic', 'architect', 'pragmatist'], standby: [] },
    scopeWarnings: [],
  })
}

/** The full-debate script (see engine-integration.spec.ts) — one read per seat/referee/chair turn. */
const FULL_SCRIPT = [
  BLIND, BLIND, BLIND,
  refereeJson({ admissions: [
    { kind: 'crux', assertion: 'SQLite write locks will serialize session writes under our concurrency.', author: 'skeptic' },
    { kind: 'crux', assertion: 'Redis adds operational surface we cannot operate at this scale.', author: 'pragmatist' },
  ] }),
  ARGUE, NEED, ARGUE,
  SHEET,
  refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'genuine dispute; evidence pending' }], floor: { active: ['skeptic', 'architect'], standby: ['pragmatist'] } }),
  ARGUE, ARGUE,
  refereeJson({}),
  ARGUE, ARGUE, ARGUE,
  refereeJson({}),
  ARGUE, ARGUE, ARGUE,
  refereeJson({}),
  CHAIR,
]

interface SpawnRecord {
  label: string
  persona?: string
  provider?: string
  model?: string
  chain?: string
}

function makeCtx(script: string[], opts: {
  personas?: Record<string, unknown>
  chain?: unknown
  failFirstSpawnFor?: string
  alwaysFailSpawnFor?: string
} = {}) {
  let spawnSeq = 0
  let readSeq = 0
  const childLabel = new Map<string, string>()
  const failedSpawns = new Set<string>()
  const spawns: SpawnRecord[] = []

  const nextText = (): string => {
    const t = script[readSeq] ?? 'generic scripted turn'
    readSeq += 1
    return t
  }

  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ personas: opts.personas ?? {}, councils: {} }) }
      if (ns === 'modelChains') return { resolve: (id: string) => (id === 'stable' ? opts.chain ?? STABLE_CHAIN : undefined) }
      if (ns === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      if (ns === 'agents') return { get: () => undefined }
      if (ns === 'sessionPersistence') {
        return {
          open: async (childId: string) => ({
            read: async () => {
              const label = childLabel.get(childId) ?? ''
              const shouldFail = (opts.alwaysFailSpawnFor !== undefined && label.includes(opts.alwaysFailSpawnFor))
                || (opts.failFirstSpawnFor !== undefined
                  && label.includes(opts.failFirstSpawnFor)
                  && !failedSpawns.has(label))
              if (shouldFail) failedSpawns.add(label)
              const events = shouldFail
                ? [{ type: 'turn/end', seq: 2, data: { reason: { kind: 'error', error: { message: 'provider exploded' } } } }]
                : [
                    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: nextText() }] } } },
                    { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
                  ]
              return { events }
            },
            close: async () => undefined,
          }),
        }
      }
      if (ns === 'sessions') return { get: () => ({ append: vi.fn() }), delete: async () => undefined }
      return undefined
    },
    tools: { get: () => undefined },
    agents: { get: () => undefined },
    subagents: {
      startContinuable: async (spec: {
        label: string
        request?: { prompt?: Array<{ text?: string }>; persona?: string; agentOptions?: { provider?: string; model?: string; chain?: string } }
      }) => {
        spawnSeq += 1
        const childId = `child-${String(spawnSeq).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`
        childLabel.set(childId, spec.label)
        spawns.push({
          label: spec.label,
          persona: spec.request?.persona,
          provider: spec.request?.agentOptions?.provider,
          model: spec.request?.agentOptions?.model,
          chain: spec.request?.agentOptions?.chain,
        })
        return { childId }
      },
      [deliverSubagentPrompt]: async () => undefined,
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  const parent = {
    session: {
      id: 'parent-session',
      seq: 10,
      append: () => undefined,
    },
    options: { provider: 'p', model: 'm' },
  }
  return { ctx, parent, spawns }
}

describe('council seat chain link advance', () => {
  it('spawns a chained seat on link 1 and advances to link 2 when its turn errors', async () => {
    const { ctx, parent, spawns } = makeCtx(FULL_SCRIPT, {
      personas: { skeptic: { chain: 'stable' } },
      failFirstSpawnFor: 'table seat: skeptic',
    })
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true })

    const result = await runCouncil(ctx as never, parent as never, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })

    expect(result.deliverable).toContain('Decision')
    const skepticSpawns = spawns.filter(s => s.label.includes('seat: skeptic'))
    expect(skepticSpawns).toHaveLength(2)
    // Link 1 carries the group id (the fork's step loop escalates from it);
    // the advanced link carries it too (its own named link is in the chain).
    expect(skepticSpawns[0]).toMatchObject({ provider: 'p1', model: 'm1', chain: 'stable' })
    expect(skepticSpawns[1]).toMatchObject({ provider: 'p2', model: 'm2', chain: 'stable' })
    // The seat's chain never leaks onto other seats (no chain assignment).
    const otherSeats = spawns.filter(s => s.label.includes('seat:') && !s.label.includes('seat: skeptic'))
    expect(otherSeats.every(s => s.provider === undefined)).toBe(true)
    const audit = written.find(line => line.includes('[model-chain] stable:'))
    expect(audit).toBeDefined()
    expect(audit).toContain('(p1/m1)')
    expect(audit).toContain('(p2/m2)')
    vi.restoreAllMocks()
  }, 20_000)

  it('does not advance past the last link — the seat retires as before', async () => {
    const { ctx, parent, spawns } = makeCtx(FULL_SCRIPT, {
      personas: { skeptic: { chain: 'stable' } },
      failFirstSpawnFor: 'table seat: skeptic',
      // Keep failing: the second (last) link must NOT produce a third spawn.
      alwaysFailSpawnFor: 'table seat: skeptic',
    })
    const result = await runCouncil(ctx as never, parent as never, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: { ...BASE_PARAMS, quorumFraction: 0 },
      signal: new AbortController().signal,
    })
    // Two links → exactly two skeptic spawns; the other seats carry quorum.
    expect(spawns.filter(s => s.label.includes('seat: skeptic'))).toHaveLength(2)
    expect(result.deliverable.length).toBeGreaterThan(0)
  }, 20_000)
})

describe('council persona chain resolution + explicit link spawn', () => {
  it('resolves personas[seat].chain into a frozen link list with the active link first', async () => {
    const { resolvePersonaChain } = await import('../src/core/fiber.ts')
    const ctx = {
      get: (ns: string) => ns === 'settings'
        ? {
            get: () => ({
              personas: { skeptic: { chain: 'stable', provider: 'p1', model: 'm1', reasoningEffort: 'low' } },
            }),
          }
        : ns === 'modelChains'
          ? { resolve: () => STABLE_CHAIN }
          : undefined,
    }
    const chain = resolvePersonaChain(ctx as never, 'skeptic')
    expect(chain).toBeDefined()
    expect(chain!.id).toBe('stable')
    expect(chain!.onCut).toBe('failover')
    expect(chain!.carryId).toBe(true)
    // The persona's provider/model is the active link; p1/m1 is not repeated.
    expect(chain!.links).toEqual([
      { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
      { provider: 'p2', model: 'm2' },
    ])
    // Dangling/disabled ids fail open to undefined.
    const dangling = { ...ctx, get: (ns: string) => ns === 'settings' ? { get: () => ({ personas: { skeptic: { chain: 'ghost' } } }) } : undefined }
    expect(resolvePersonaChain(dangling as never, 'skeptic')).toBeUndefined()
  })

  it('spawns on an explicit link when startSeatFiber is given one, carrying the chain id', async () => {
    const { startSeatFiber } = await import('../src/core/fiber.ts')
    const captured: Array<{ provider?: string; model?: string; chain?: string }> = []
    const ctx = {
      get: (ns: string) => ns === 'settings' ? { get: () => ({ personas: {} }) } : undefined,
      subagents: {
        startContinuable: async (spec: { request?: { agentOptions?: { provider?: string; model?: string; chain?: string } } }) => {
          captured.push(spec.request?.agentOptions ?? {})
          return { childId: 'child-0001-aaaa-bbbb-cccc-dddddddddddd' }
        },
      },
    }
    const parent = { session: { id: 'p', seq: 1, append: () => undefined } }
    await startSeatFiber(ctx as never, parent as never, {
      seatId: 'skeptic',
      label: 'seat: skeptic',
      persona: 'persona',
      initialPrompt: 'prompt',
      denyTools: [],
      model: { provider: 'p2', model: 'm2' },
      chainId: 'stable',
    }, new AbortController().signal)
    expect(captured).toEqual([{ provider: 'p2', model: 'm2', chain: 'stable' }])
  })
})
