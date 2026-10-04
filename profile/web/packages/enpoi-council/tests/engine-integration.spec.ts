import { describe, expect, it, vi } from 'vitest'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

import { runCouncil, CouncilHandoffError } from '../src/core/engine.ts'
import { ROUNDTABLE_SPEC } from '../src/profiles/roundtable.ts'
import { CHORUS_SPEC } from '../src/profiles/chorus.ts'
import type { CouncilParams } from '../src/core/spec.ts'

/**
 * Council engine integration tests — the REAL engine loop runs against a
 * scripted ctx: fake subagents spawn unique children per call, and the fake
 * persistence serves a scripted sequence of turn texts (blind positions →
 * referee JSON → arguments → fact sheets → challenge → chair deliverable).
 * No real LLM calls; the full doc-54 mechanics are exercised.
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

/**
 * Build a scripted ctx. `script` is a list of turn texts consumed in order —
 * one entry per waitForSeatTurn read (seats, referees, brokers, chair).
 */
function makeCtx(script: string[], opts: { failSeats?: boolean; failSeatIds?: string[]; truncSeats?: string[] } = {}) {
  let spawnSeq = 0
  let readSeq = 0
  const childLabel = new Map<string, string>()
  const truncCounter = new Set<string>()
  const appends: Array<{ type: string; data: unknown }> = []
  const spawnedLabels: string[] = []
  const spawnedPrompts: Array<{ label: string; persona?: string; prompt: string }> = []

  const nextText = (): string => {
    const t = script[readSeq] ?? 'generic scripted turn'
    readSeq += 1
    return t
  }

  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ personas: {} }) }
      if (ns === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      if (ns === 'agents') return { get: () => undefined } // children always parked
      if (ns === 'sessionPersistence') {
        return {
          open: async (childId: string) => ({
            read: async () => {
              const label = childLabel.get(childId) ?? ''
              const seatFailed = opts.failSeatIds?.some(id => label.includes(id)) ?? false
              const failing = opts.failSeats === true || seatFailed
              // Truncation simulation: the FIRST read for a trunc seat returns
              // text + a max-tokens turn/end; the SECOND read (after the
              // auto-continue followup) returns the completion + a clean end.
              const seatTruncated = opts.truncSeats?.some(id => label.includes(id)) ?? false
              const truncKey = `trunc:${childId}`
              const firstTrunc = seatTruncated && !truncCounter.has(truncKey)
              if (firstTrunc) truncCounter.add(truncKey)
              const text = firstTrunc ? 'TRUNCATED-PART' : (failing ? 'irrelevant' : nextText())
              const events = failing
                ? [
                    { type: 'turn/end', seq: 2, data: { reason: { kind: 'error', error: { message: 'provider exploded' } } } },
                  ]
                : firstTrunc
                  ? [
                      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text }] } } },
                      { type: 'turn/end', seq: 2, data: { reason: { kind: 'max-tokens' } } },
                    ]
                  : [
                      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text }] } } },
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
      startContinuable: async (spec: { label: string; request?: { prompt?: Array<{ text?: string }>; persona?: string } }) => {
        spawnSeq += 1
        spawnedLabels.push(spec.label)
        spawnedPrompts.push({
          label: spec.label,
          persona: spec.request?.persona,
          prompt: spec.request?.prompt?.map(part => part.text ?? '').join('') ?? '',
        })
        const childId = `child-${String(spawnSeq).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd`
        childLabel.set(childId, spec.label)
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
      append: (type: string, data: unknown) => { appends.push({ type, data }) },
    },
    options: { provider: 'p', model: 'm' },
  }
  return { ctx, parent, appends, spawnedLabels, spawnedPrompts, reads: () => readSeq }
}

// ── Script helpers ──────────────────────────────────────────────────────────

const BLIND = 'PROPOSE_CRUX: SQLite write locks will serialize session writes under our concurrency.\nI take the position that durability matters more than latency here.'
const ARGUE = 'I maintain my position on C-1; the write volumes in this deployment are moderate (see the load docs). STEELMAN [skeptic]: The Skeptic is right that lock contention exists at extreme concurrency — that boundary just does not apply at our scale.'
const NEED = 'I accept the framing so far, but I need the real write pattern before conceding.\nNEED_EVIDENCE(target: queue scheduler, question: does claim_next use a database lock or a transactional row update?)'
const CONCUR = 'CONCUR [C-2] WITH skeptic: the operational-surface argument is sound and I withdraw my preference.'
const SHEET = 'CITATION: src/core/queue.py:142\nFACTS: claim_next acquires a transactional row update with a 5s lease; no separate lock file.\nCONFIDENCE: high'
const CHAIR = [
  '# Decision', '', 'Adopt the transactional lease design (C-1 invariant). C-2 dissolved by operational analysis.', '',
  '## Options Considered', '', '- Transactional row-update lease (adopted).', '- Redis coordination (rejected: operational surface).', '',
  '## Evidence', '', 'src/core/queue.py:142 — claim_next acquires a transactional row update with a 5s lease.', '',
  '## Established Invariants', '', '- Lease-based claims with bounded staleness.', '',
  '## Binding Dissents', '', 'None.', '',
  '## Action Items', '', '- Ship the lease design.',
].join('\n')

function refereeJson(o: { admissions?: Array<{ kind: string; assertion: string; author: string }>; flips?: Array<{ id: string; to: string; reason: string }>; floor?: { active: string[]; standby: string[] }; directives?: Record<string, string> }): string {
  return JSON.stringify({
    admissions: o.admissions ?? [],
    flips: o.flips ?? [],
    directives: o.directives ?? { skeptic: '1. Press the failure-mode claim.', architect: '1. Quantify the latency cost.', pragmatist: '1. Scope the operational burden.' },
    floor: o.floor ?? { active: ['skeptic', 'architect', 'pragmatist'], standby: [] },
    scopeWarnings: [],
  })
}

// ── The full debate run ─────────────────────────────────────────────────────

describe('council engine — scripted full runs', () => {
  it('runs a full debate: blind → admissions → flip → stagnation → challenge → terminate → chair', async () => {
    // Read order: 3 blind seats, referee#1, 3 seats, referee#2 (flip), 2 seats (standby), referee#3,
    // 2 seats, referee#4 (stagnation reached) → challenge: 3 seats, referee#5 (silent) → terminate → chair.
    const script = [
      BLIND, BLIND, BLIND,                                   // blind epoch 0
      refereeJson({ admissions: [
        { kind: 'crux', assertion: 'SQLite write locks will serialize session writes under our concurrency.', author: 'skeptic' },
        { kind: 'crux', assertion: 'Redis adds operational surface we cannot operate at this scale.', author: 'pragmatist' },
      ] }),                                                  // referee epoch 1
      ARGUE, NEED, ARGUE,                                    // epoch 1 seats (one evidence request)
      SHEET,                                                 // broker
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'genuine dispute; evidence pending' }], floor: { active: ['skeptic', 'architect'], standby: ['pragmatist'] } }),
      ARGUE, ARGUE,                                          // epoch 2 (2 seats — pragmatist standby)
      refereeJson({}),                                       // referee epoch 3 (no flips; floor resets to all)
      ARGUE, ARGUE, ARGUE,                                   // epoch 4 (3 seats — floor was reset)
      refereeJson({}),                                       // referee epoch 4 (no flips → run=2 → challenge)
      CONCUR, CONCUR, CONCUR,                                // epoch 5: FINAL CHALLENGE (3 seats)
      refereeJson({}),                                       // referee challenge (silent → terminate)
      CHAIR,                                                 // chair
    ]
    const { ctx, parent, appends } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })

    expect(result.deliverable).toContain('Decision')
    expect(result.stopReason).toBe('final challenge produced no state changes')
    expect(result.roundsRun).toBeGreaterThanOrEqual(4)
    expect(result.ledgerState.entries.length).toBe(2)
    expect(result.ledgerState.entries[0].status).toBe('contested')   // C-1 flipped once
    expect(result.vaultAdditions).toBe(1)

    // Quality proxies from the ledger. This script ends via the challenge
    // (not convergence), so nothing reached a terminal status: ratio 0.
    expect(result.quality.cruxResolutionRatio).toBe(0)
    expect(result.quality.invariantDensity).toBe(0)

    // council/round events carried the ledger + floor payload (doc 54 §13 #5).
    const rounds = appends.filter(a => a.type === 'council/round')
    expect(rounds.length).toBeGreaterThanOrEqual(4)
    const withFlip = rounds.find(r => (r.data as { flips?: number }).flips === 1)
    expect(withFlip).toBeDefined()
    expect((withFlip!.data as { ledgerDiff?: unknown }).ledgerDiff).toBeDefined()
    expect((withFlip!.data as { floor?: unknown }).floor).toBeDefined()
  })

  it('broker fact sheets land in the vault and dedupe (one dispatch per unique question)', async () => {
    const script = [
      BLIND, BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'C-1 style claim about locks', author: 'skeptic' }] }),
      NEED, NEED, ARGUE,           // TWO seats request the SAME fact → one dispatch
      SHEET,                       // broker (single)
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'open dispute' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, spawnedLabels } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.vaultAdditions).toBe(1)
    const brokerSpawns = spawnedLabels.filter(l => l.startsWith('council broker:'))
    expect(brokerSpawns).toHaveLength(1)
  })

  it('quorum failure fails loud with per-seat errors', async () => {
    const { ctx, parent } = makeCtx([], { failSeats: true })
    await expect(runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'anything',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })).rejects.toThrow(/failed quorum/i)
  })

  it('maxRoundsOverride bounds the run as a safety net', async () => {
    // Referee never flips → stagnation would fire, but maxRounds=2 bounds first.
    const script: string[] = []
    script.push(BLIND, BLIND, BLIND)
    script.push(refereeJson({ admissions: [{ kind: 'crux', assertion: 'a claim', author: 'skeptic' }] }))
    for (let i = 0; i < 6; i++) {
      script.push(ARGUE, ARGUE, ARGUE)
      script.push(refereeJson({}))
    }
    script.push(CHAIR)
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
      maxRoundsOverride: 2,
    })
    expect(result.roundsRun).toBeLessThanOrEqual(3)
    expect(result.stopReason).toMatch(/max rounds/)
  })

  it('opening-phase evidence requests are brokered BEFORE the ingest referee pass', async () => {
    const blindWithNeed = 'PROPOSE_CRUX: The claim format needs a lease TTL.\nNEED_EVIDENCE(target: queue scheduler, question: does claim_next use a lock or a row update?)'
    const script = [
      BLIND, BLIND, blindWithNeed,                     // blind epoch 0 (one seat requests evidence)
      SHEET,                                           // broker flush BEFORE ingest
      refereeJson({ admissions: [
        { kind: 'crux', assertion: 'The claim format needs a lease TTL.', author: 'skeptic' },
      ], evidenceNote: 'vault has F-1' }),
      ARGUE, ARGUE, ARGUE,                             // epoch 2
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'open dispute' }] }),
      ARGUE, ARGUE, ARGUE,                             // epoch 3
      refereeJson({}),                                 // run=1
      ARGUE, ARGUE, ARGUE,                             // epoch 4
      refereeJson({}),                                 // run=2 → challenge
      CONCUR, CONCUR, CONCUR,                          // epoch 5 challenge
      refereeJson({}),                                 // silent → terminate
      CHAIR,
    ]
    const { ctx, parent, spawnedLabels } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    // The broker child spawned BEFORE the ingest referee child (vault commit precedes ingest).
    const brokerIdx = spawnedLabels.findIndex(l => l.startsWith('council broker:'))
    const ingestIdx = spawnedLabels.findIndex(l => l.includes('referee: epoch 1'))
    expect(brokerIdx).toBeGreaterThanOrEqual(0)
    expect(ingestIdx).toBeGreaterThan(brokerIdx)
    expect(result.vaultAdditions).toBe(1)
  })

  it("opening: 'open' runs formulation + ingest and never aborts on an empty ledger", async () => {
    const openSpec = { ...ROUNDTABLE_SPEC, opening: 'open' as const }
    const script = [
      ARGUE + ' PROPOSE_CRUX: Open-mode positions land as ledger entries.',   // epoch-1 formulation (open, 3 seats)
      ARGUE, ARGUE,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'Open-mode positions land as ledger entries.', author: 'skeptic' }] }),
      ARGUE, ARGUE, ARGUE,                             // epoch 2
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'disputed' }] }),
      ARGUE, ARGUE, ARGUE,                             // epoch 3
      refereeJson({}),                                 // run=1
      ARGUE, ARGUE, ARGUE,                             // epoch 4
      refereeJson({}),                                 // run=2 → challenge
      CONCUR, CONCUR, CONCUR,                          // epoch 5 challenge
      refereeJson({}),                                 // silent → terminate
      CHAIR,
    ]
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: openSpec,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.stopReason).not.toBe('no ledger entries were ever admitted')
    expect(result.ledgerState.entries.length).toBeGreaterThanOrEqual(1)
    expect(result.deliverable).toContain('Decision')
  })

  it('chorus runs in forest mode and terminates on saturation', async () => {
    const sprout = 'SPROUT: Ambient dock | A glanceable strip summarizing fleet state.'
    const script = [
      sprout, sprout, sprout,                                  // blind
      refereeJson({ admissions: [
        { kind: 'idea', assertion: 'Ambient dock', author: 'visionary' },
        { kind: 'idea', assertion: 'Fleet glance strip', author: 'experiencer' },
        { kind: 'idea', assertion: 'Task pulse header', author: 'integrator' },
      ] }),
      sprout, sprout, sprout,                                  // epoch 1 (admissions → material)
      refereeJson({ admissions: [{ kind: 'idea', assertion: 'Follow-up sprout', author: 'visionary' }] }),
      sprout, sprout, sprout,                                  // epoch 2 (admissions → material)
      refereeJson({}),                                         // no admissions → run=1
      sprout, sprout, sprout,                                  // epoch 3
      refereeJson({}),                                         // no admissions → run=2 → challenge
      'SPROUT: One last radical direction | because the challenge asked.', 'SPROUT: wild card | divergence.', 'SPROUT: another angle | divergence.',
      refereeJson({ admissions: [{ kind: 'idea', assertion: 'One last radical direction', author: 'visionary' }] }),
      'SPROUT: consolidation | fusing the harvest threads.', 'SPROUT: c2 | thread.', 'SPROUT: c3 | thread.',
      refereeJson({}),                                         // consolidation referee → terminate unconditionally
      [
        '# Harvest', '',
        '## Spotlight Gems (with lineage)', '', '• GEM: Ambient dock — lineage: I-1.', '',
        '## Thematic Clusters', '', '- Ambient surfaces (I-1, I-2).', '',
        '## Concept Catalog', '', '- I-1 Ambient dock; I-2 Fleet glance strip.', '',
        '## Buildable Now vs Moonshots', '', '- Buildable now: task pulse header. Moonshot: ambient dock.', '',
        '## Open Questions', '', '- Where does the fleet state live?',
      ].join('\n'),
    ]
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: CHORUS_SPEC,
      query: 'Reimagine the harness sidebar',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.deliverable).toContain('Harvest')
    expect(result.ledgerState.entries.length).toBeGreaterThanOrEqual(5)
    expect(result.ledgerState.edges.length).toBe(0) // edges come from parsed ops in v2; entries carry the ideas
  })
})

describe('declarative chair template (settings-defined councils)', () => {
  it('uses the registered chair persona and substitutes the documented placeholders', async () => {
    const customSpec = {
      ...ROUNDTABLE_SPEC,
      id: 'myreview',
      label: 'My Review',
      seats: ROUNDTABLE_SPEC.seats.slice(0, 2),
      deliverableSections: ['Decision'],
    }
    const script = [
      BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A real dispute about leases.', author: 'skeptic' }] }),
      ARGUE, ARGUE,
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'genuine' }] }),
      ARGUE, ARGUE,
      refereeJson({}),
      ARGUE, ARGUE,
      refereeJson({}),
      CONCUR, CONCUR,
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, spawnedPrompts } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: customSpec,
      query: 'which database?',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
      chairTemplate: {
        systemPrompt: 'CHAIR-PERSONA',
        userPromptTemplate: 'TPL {{label}} :: {{query}} :: sections={{sections}} :: note={{note}} :: unknown={{nope}}',
      },
    })
    expect(result.deliverable).toContain('Decision')
    const chair = spawnedPrompts.find(entry => entry.label.includes('council chair'))
    expect(chair).toBeDefined()
    expect(chair!.persona).toBe('CHAIR-PERSONA')
    expect(chair!.prompt).toContain('TPL My Review :: which database? :: sections=Decision')
    expect(chair!.prompt).toContain('unknown={{nope}}')
  })
})

describe('dead-seat retirement (no per-epoch respawn churn)', () => {
  it('retires a seat whose fresh fiber also fails, and never respawns it again', async () => {
    const script = [
      // Blind: only architect + pragmatist consume reads (the skeptic's failed
      // turns never consume script items — its turns are error events).
      BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A real dispute about leases.', author: 'architect' }] }),
      ARGUE, ARGUE,                                          // epoch 2: skeptic retired — only 2 seats
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'genuine' }] }),
      ARGUE, ARGUE,                                          // epoch 3
      refereeJson({}),
      ARGUE, ARGUE,                                          // epoch 4
      refereeJson({}),
      CONCUR, CONCUR,                                        // epoch 5 challenge (2 seats)
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, spawnedLabels } = makeCtx(script, { failSeatIds: ['skeptic'] })
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    const skepticSpawns = spawnedLabels.filter(l => l.includes('seat: skeptic')).length
    // initial spawn + one respawn (attempt 2) — then retired, never again.
    expect(skepticSpawns).toBe(2)
    expect(result.deliverable).toContain('Decision')
    expect(result.ledgerState.entries.length).toBeGreaterThanOrEqual(1)
  })
})

describe('auto-continue on output-token truncation', () => {
  it('resumes a seat whose turn ended at the cap and concatenates the continuation', async () => {
    const script = [
      BLIND, BLIND, BLIND,                                   // blind; the skeptic truncates then continues
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A dispute about lease TTLs.', author: 'skeptic' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'open' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent } = makeCtx(script, { truncSeats: ['skeptic'] })
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.deliverable).toContain('Decision')
    // The skeptic's fiber got one followup (the auto-continue) — nothing else to assert directly;
    // the run completing without quorum errors IS the behavior check (the first read returned
    // TRUNCATED-PART with a max-tokens end, the second the scripted completion).
  })
})


describe('degraded-mode fallbacks (never lose a finished debate)', () => {
  it('referee unavailable for the whole run: the empty ledger fails loud with the referee record', async () => {
    // Referee failures never consume script reads. Flow: blind(3) → ingest fails
    // → epoch2(3) → fails → empty-ledger guard terminates → handoff check.
    const script = [
      BLIND, BLIND, BLIND,
      ARGUE, ARGUE, ARGUE,   // epoch 2: the only deliberation epoch (guard fires)
      CHAIR,                 // never consumed — synthesis is refused before the chair
    ]
    const { ctx, parent } = makeCtx(script, { failSeatIds: ['referee'] })
    const err = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)
    // 2026-09-27 contract: a run with no material NEVER forwards an empty
    // deliverable. It stops with the reason and the lost-referee record.
    expect(err).toBeInstanceOf(CouncilHandoffError)
    expect((err as Error).message).toMatch(/produced no material for synthesis/)
    expect((err as Error).message).toMatch(/referee unavailable/)
  })

  it('a referee pass with prose instead of JSON stops the loop and fails loud', async () => {
    const PROSE = 'Referee JSON produced for EPOCH 2. Summary of rulings: admitted 5 entries, no flips.'
    const script = [
      BLIND, BLIND, BLIND,
      PROSE, PROSE,          // ingest referee: throws twice (no JSON) → no-op ingest
      ARGUE, ARGUE, ARGUE,   // epoch 2 seats
      PROSE, PROSE,          // epoch-2 referee: throws twice → handoff failure
    ]
    const { ctx, parent, appends } = makeCtx(script)
    const err = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CouncilHandoffError)
    expect((err as Error).message).toMatch(/referee handoff failed at epoch 2/)
    expect((err as Error).message).toMatch(/no JSON object/)
    // The failure is visible on the event stream, not just in the log.
    const handoff = appends.find(a => a.type === 'council/round' && (a.data as { phase?: string }).phase === 'referee-handoff-failed')
    expect(handoff).toBeDefined()
  })

  it('an unshaped chair answer is retried, then replaced by a reported mechanical compilation', async () => {
    const script = [
      BLIND, BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A dispute about lease TTLs.', author: 'skeptic' }] }),
      'A stub answer with no required sections at all.',
      'Another stub answer, still unshaped.',
    ]
    const { ctx, parent, appends } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: { ...BASE_PARAMS, runDeadlineMs: 0 },
      signal: new AbortController().signal,
    })
    expect(result.deliverable).toContain('mechanical compilation')
    expect(result.deliverable).toContain('chair failure reported')
    expect(result.deliverable).toContain('C-1')
    expect(result.audit.join(' ')).toMatch(/chair attempt 1 failed .*missing or empty required section/)
    // Visible bounded budget: the synthesis event carries the chair timeout.
    const synthesis = appends.find(a => a.type === 'council/round' && (a.data as { phase?: string }).phase === 'synthesis')
    expect(synthesis).toBeDefined()
    expect((synthesis!.data as { budgetMs?: number }).budgetMs).toBe(BASE_PARAMS.debaterTimeoutMs)
  })

  it('chair unavailable: mechanical compilation preserves every ledger entry', async () => {
    const script = [
      BLIND, BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A dispute about lease TTLs.', author: 'skeptic' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'open' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent } = makeCtx(script, { failSeatIds: ['chair'] })
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.stopReason).toBe('final challenge produced no state changes')
    expect(result.deliverable).toContain('mechanical compilation')
    expect(result.deliverable).toContain('C-1')
    expect(result.deliverable).toContain('Ledger Dispositions')
  })

  it('run deadline: skips to synthesis instead of overrunning', async () => {
    const script = [
      BLIND, BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'a claim', author: 'skeptic' }] }),
      CHAIR,
    ]
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: { ...BASE_PARAMS, runDeadlineMs: 0 },
      signal: new AbortController().signal,
    })
    expect(result.stopReason).toBe('run deadline reached')
    expect(result.deliverable).toContain('Decision')
    expect(result.ledgerState.entries.length).toBe(1)
  })
})
