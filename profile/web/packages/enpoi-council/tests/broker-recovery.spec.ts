import { describe, expect, it, vi } from 'vitest'
import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'

import { runCouncil } from '../src/core/engine.ts'
import { parseFactSheets } from '../src/core/broker.ts'
import { ROUNDTABLE_SPEC } from '../src/profiles/roundtable.ts'
import type { CouncilParams } from '../src/core/spec.ts'

/**
 * Broker recovery specs (2026-09-27 audit): a broker child reply with no
 * parseable sheet must NOT vanish into a `FAILED: missing sheet N` log line.
 * The parser recovers numbered SHEET blocks even without a CITATION line; the
 * engine re-requests a missed sheet at the next epoch and, at the attempt
 * bound, commits a named RETRIEVAL FAILED vault sheet. Witnessed live:
 * epoch-2 broker got a non-sheet reply → EV-1a6feef8 MISSED sheet 1/1 →
 * re-request at epoch 3 → SHEET committed (vaultAdditions 1).
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

const BLIND = 'PROPOSE_CRUX: SQLite write locks will serialize session writes under our concurrency.\nI take the position that durability matters more than latency here.'
const ARGUE = 'I maintain my position on C-1; the write volumes in this deployment are moderate. STEELMAN [skeptic]: The Skeptic is right that lock contention exists — that boundary does not apply at our scale.'
const NEED = 'I accept the framing so far, but I need the real write pattern before conceding.\nNEED_EVIDENCE(target: queue scheduler, question: does claim_next use a database lock or a transactional row update?)'
const SHEET = 'CITATION: src/core/queue.py:142\nFACTS: claim_next acquires a transactional row update with a 5s lease.\nCONFIDENCE: high'
const NON_SHEET = 'I decline to answer from memory; a precise source was not provided in this session.'
const CONCUR = 'CONCUR [C-2] WITH skeptic: the operational-surface argument is sound and I withdraw my preference.'
const CHAIR = [
  '# Decision', '', 'Adopt the transactional lease design (C-1 invariant).', '',
  '## Options Considered', '', '- Transactional row-update lease (adopted).', '',
  '## Evidence', '', 'src/core/queue.py:142 — claim_next acquires a transactional row update.', '',
  '## Established Invariants', '', '- Lease-based claims with bounded staleness.', '',
  '## Binding Dissents', '', 'None.', '',
  '## Action Items', '', '- Ship the lease design.',
].join('\n')

function refereeJson(o: { admissions?: Array<{ kind: string; assertion: string; author: string }>; flips?: Array<{ id: string; to: string; reason: string }> }): string {
  return JSON.stringify({
    admissions: o.admissions ?? [],
    flips: o.flips ?? [],
    directives: { skeptic: '1. Press it.', architect: '1. Quantify it.', pragmatist: '1. Scope it.' },
    floor: { active: ['skeptic', 'architect', 'pragmatist'], standby: [] },
    scopeWarnings: [],
  })
}

/** Scripted ctx (same transport contract as engine-integration.spec.ts). */
function makeCtx(script: string[]) {
  let spawnSeq = 0
  let readSeq = 0
  const appends: Array<{ type: string; data: unknown }> = []
  const spawnedPrompts: string[] = []

  const ctx = {
    get: (ns: string) => {
      if (ns === 'settings') return { get: () => ({ personas: {} }) }
      if (ns === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      if (ns === 'agents') return { get: () => undefined }
      if (ns === 'sessionPersistence') {
        return {
          open: async () => ({
            read: async () => ({
              events: [
                { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: script[readSeq++] ?? 'generic scripted turn' }] } } },
                { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } },
              ],
            }),
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
      startContinuable: async (spec: { label: string; request?: { prompt?: Array<{ text?: string }> } }) => {
        spawnSeq += 1
        spawnedPrompts.push(spec.request?.prompt?.map(p => p.text ?? '').join('') ?? '')
        return { childId: `child-${String(spawnSeq).padStart(4, '0')}-aaaa-bbbb-cccc-dddddddddddd` }
      },
      [deliverSubagentPrompt]: async () => undefined,
    },
    logger: { warn: vi.fn(), info: vi.fn() },
  }
  const parent = {
    session: {
      id: 'broker-recovery-parent',
      seq: 10,
      append: (type: string, data: unknown) => { appends.push({ type, data }) },
    },
    options: { provider: 'p', model: 'm' },
  }
  return { ctx, parent, appends, spawnedPrompts }
}

describe('broker sheet parsing — seed/init path', () => {
  it('recovers numbered SHEET blocks even when the CITATION line is missing', () => {
    const text = [
      'SHEET 1',
      'FACTS: claim_next uses a transactional row update.',
      'CONFIDENCE: medium',
      'SHEET 2',
      'CITATION: src/b.py:7',
      'FACTS: the lease is 5 seconds.',
      'CONFIDENCE: high',
    ].join('\n')
    const sheets = parseFactSheets(text)
    expect(sheets).toHaveLength(2)
    expect(sheets[0]?.citation).toBe('unverified (broker omitted citation)')
    expect(sheets[0]?.facts).toBe('claim_next uses a transactional row update.')
    expect(sheets[0]?.confidence).toBe('medium')
    expect(sheets[1]?.citation).toBe('src/b.py:7')
  })

  it('keeps a numbered sheet hole explicit when one sheet is truly absent', () => {
    const text = ['SHEET 2', 'CITATION: src/c.py:3', 'FACTS: second only.', 'CONFIDENCE: low'].join('\n')
    const sheets = parseFactSheets(text)
    expect(sheets[0]).toBeUndefined()          // sheet 1 was never returned
    expect(sheets[1]?.facts).toBe('second only.')
  })

  it('still parses the citation-only single-sheet shape, and sheetless prose yields nothing', () => {
    expect(parseFactSheets('CITATION: src/x.ts:1\nFACTS: row update.\nCONFIDENCE: high')[0]?.facts).toBe('row update.')
    expect(parseFactSheets(NON_SHEET)).toHaveLength(0)
  })
})

describe('broker miss is named and recoverable', () => {
  it('re-requests a missed sheet next epoch and commits the recovered sheet', async () => {
    const script = [
      BLIND, BLIND, BLIND,                                   // blind epoch 0
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'SQLite locks serialize writes.', author: 'skeptic' }] }),
      ARGUE, NEED, ARGUE,                                    // epoch 2 seats (one evidence request)
      NON_SHEET,                                             // broker attempt 1 — no sheet
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'evidence pending' }] }),
      ARGUE, ARGUE, ARGUE,                                   // epoch 3 seats
      SHEET,                                                 // broker attempt 2 — recovered
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,                                   // epoch 4
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,                                // challenge
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, appends } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })

    // The missed sheet was re-requested and recovered into the vault.
    expect(result.vaultAdditions).toBe(1)
    expect(result.deliverable).toContain('Decision')
    const audit = result.audit.join(' ')
    expect(audit).toMatch(/EV-[0-9a-f]{8}.*re-request at epoch 3 \(attempt 2\/3\)/)
    // The failure is on the event stream, not only in the log file.
    const withBroker = appends.filter(a => a.type === 'council/round' && (a.data as { broker?: unknown }).broker !== undefined)
    const missedEvent = withBroker.find(a => ((a.data as { broker: { missed: number } }).broker.missed ?? 0) > 0)
    expect(missedEvent).toBeDefined()
    expect(JSON.stringify(missedEvent!.data)).toMatch(/EV-[0-9a-f]{8}/)
    const recoveredEvent = withBroker.find(a => (a.data as { broker: { sheets: number } }).broker.sheets === 1)
    expect(recoveredEvent).toBeDefined()
  })

  it('opening-phase miss is re-requested at epoch 2 and recovered (previously dropped)', async () => {
    const blindWithNeed = 'PROPOSE_CRUX: The claim format needs a lease TTL.\nNEED_EVIDENCE(target: queue scheduler, question: does claim_next use a lock or a row update?)'
    const script = [
      BLIND, BLIND, blindWithNeed,                           // blind epoch 0 (one NEED)
      NON_SHEET,                                             // opening broker attempt 1 — miss
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'The claim format needs a lease TTL.', author: 'skeptic' }] }),
      ARGUE, ARGUE, ARGUE,                                   // epoch 2 seats
      SHEET,                                                 // broker attempt 2 — recovered
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'open dispute' }] }),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.vaultAdditions).toBe(1)
    expect(result.audit.join(' ')).toMatch(/EV-98e2489a.*re-request at epoch 2 \(attempt 2\/3\)/)
  })

  it('preflight miss is re-requested at the opening boundary and recovered', async () => {
    const script = [
      NON_SHEET,                                             // preflight broker (epoch 0) — miss
      BLIND, BLIND, BLIND,
      SHEET,                                                 // opening broker — preflight retry recovered
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'A real dispute.', author: 'skeptic' }] }),
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
    const { ctx, parent } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: { ...ROUNDTABLE_SPEC, preflightInventory: true },
      query: 'q',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })
    expect(result.vaultAdditions).toBe(1)
    const audit = result.audit.join(' ')
    expect(audit).toMatch(/preflight inventory: 0 sheet\(s\) — 1 missed/)
    expect(audit).toMatch(/EV-preflight.*re-request at epoch 1 \(attempt 2\/3\)/)
    // Recovered at the opening boundary — the preflight fact is in the vault
    // before the ingest referee pass reads it.
    expect(audit).toMatch(/opening broker: 1 sheet\(s\)/)
  })

  it('after the attempt bound, the vault carries a named RETRIEVAL FAILED sheet', async () => {
    const script = [
      BLIND, BLIND, BLIND,
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'SQLite locks serialize writes.', author: 'skeptic' }] }),
      ARGUE, NEED, ARGUE,                                    // epoch 2 — miss 1
      NON_SHEET,
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'evidence pending' }] }),
      ARGUE, ARGUE, ARGUE,                                   // epoch 3 — miss 2
      NON_SHEET,
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,                                   // epoch 4 — miss 3 → bound
      NON_SHEET,
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,                                // challenge
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, appends, spawnedPrompts } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })

    // The loss is explicit: a vault sheet exists so the chair can name the gap.
    expect(result.vaultAdditions).toBe(1)
    const audit = result.audit.join(' ')
    expect(audit).toMatch(/retrieval abandoned after 3 attempts/)
    expect(audit).toMatch(/RETRIEVAL FAILED/)
    // The chair prompt carried the named failure (honesty rule), not silence.
    const chairPrompt = spawnedPrompts.find(p => p.includes('EVIDENCE VAULT') || p.includes('RETRIEVAL FAILED'))
    expect(chairPrompt).toContain('RETRIEVAL FAILED')
    // Three miss events total: two re-requests, one bound.
    const misses = appends.filter(a => ((a.data as { broker?: { missed?: number } }).broker?.missed ?? 0) > 0)
    expect(misses).toHaveLength(3)
  })

  it('names sheets returned beyond the requested batch on the round event (no silent drop)', async () => {
    // A misnumbered batch (SHEET 2 for a 1-question queue) used to be dropped
    // without a word. It is now recorded with a named reason and surfaced.
    const EXCESS_SHEET = [
      'SHEET 1',
      SHEET,
      '',
      'SHEET 2',
      'CITATION: src/extra.py:9',
      'FACTS: an unsolicited second sheet nobody requested.',
      'CONFIDENCE: low',
    ].join('\n')
    const script = [
      BLIND, BLIND, BLIND,                                   // blind epoch 0
      refereeJson({ admissions: [{ kind: 'crux', assertion: 'SQLite locks serialize writes.', author: 'skeptic' }] }),
      ARGUE, NEED, ARGUE,                                    // epoch 2 seats (one evidence request)
      NON_SHEET,                                             // broker attempt 1 — no sheet
      refereeJson({ flips: [{ id: 'C-1', to: 'contested', reason: 'evidence pending' }] }),
      ARGUE, ARGUE, ARGUE,                                   // epoch 3 seats
      EXCESS_SHEET,                                          // broker attempt 2 — 1 requested + 1 excess
      refereeJson({}),
      ARGUE, ARGUE, ARGUE,                                   // epoch 4
      refereeJson({}),
      CONCUR, CONCUR, CONCUR,                                // challenge
      refereeJson({}),
      CHAIR,
    ]
    const { ctx, parent, appends } = makeCtx(script)
    const result = await runCouncil(ctx, parent, {
      spec: ROUNDTABLE_SPEC,
      query: 'Session-state storage: SQLite vs Redis',
      params: BASE_PARAMS,
      signal: new AbortController().signal,
    })

    // The requested sheet landed; the extra one did not vanish silently.
    expect(result.vaultAdditions).toBe(1)
    const roundEvents = appends
      .filter(a => a.type === 'council/round')
      .map(a => a.data as { broker?: { sheets?: number; excess?: number; excessReasons?: string[] } })
    const excessEvent = roundEvents.find(b => (b.broker?.excess ?? 0) > 0)
    expect(excessEvent).toBeDefined()
    expect(excessEvent!.broker!.sheets).toBe(1)
    expect(excessEvent!.broker!.excess).toBe(1)
    expect(excessEvent!.broker!.excessReasons?.[0]).toMatch(/SHEET 2 exceeds the requested batch of 1/)
    expect(excessEvent!.broker!.excessReasons?.[0]).toContain('unsolicited second sheet')
    expect(result.audit.join(' ')).toMatch(/1 excess sheet\(s\) beyond the batch/)
  })
})
