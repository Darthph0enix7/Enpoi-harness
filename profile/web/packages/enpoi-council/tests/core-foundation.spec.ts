import { describe, expect, it } from 'vitest'
import { Ledger } from '../src/core/ledger.ts'
import { afterChallenge, evaluate, initialRuntime, trackFlipRun } from '../src/core/stopping.ts'
import type { CouncilParams, LedgerState } from '../src/core/spec.ts'
import { validateSpec } from '../src/core/spec.ts'

const params = (over: Partial<CouncilParams> = {}): CouncilParams => ({
  defaultMaxRounds: 6,
  stagnationLimit: 2,
  challengeRound: true,
  maxDebateTokens: 200000,
  debaterTimeoutMs: 300000,
  quorumFraction: 2 / 3,
  evidenceBroker: true,
  evidenceTimeoutMs: 120000,
  blindEpoch: true,
  preflightInventory: false,
  ...over,
})

const TERMINAL = new Set(['invariant', 'falsified', 'dissent'])

function seedLedger() {
  const ledger = new Ledger()
  ledger.admit({ kind: 'crux', assertion: 'SQLite write locks serialize all session writes under load', author: 'skeptic', epoch: 1, idPrefix: 'C' })
  ledger.admit({ kind: 'crux', assertion: 'Redis adds operational surface we cannot operate at this scale', author: 'pragmatist', epoch: 1, idPrefix: 'C' })
  return ledger
}

describe('ledger admission', () => {
  it('admits entries verbatim with sequential ids and provenance', () => {
    const l = seedLedger()
    const s = l.state()
    expect(s.entries).toHaveLength(2)
    expect(s.entries[0].id).toBe('C-1')
    expect(s.entries[1].author).toBe('pragmatist')
    expect(s.entries[0].assertion).toContain('serialize')
  })

  it('dedupes high-overlap live entries', () => {
    const l = seedLedger()
    const dup = l.admit({ kind: 'crux', assertion: 'SQLite write locks serialize every session write under heavy load', author: 'architect', epoch: 2, idPrefix: 'C' })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.existingId).toBe('C-1')
  })

  it('allows a genuinely different assertion on the same kind', () => {
    const l = seedLedger()
    const fresh = l.admit({ kind: 'crux', assertion: 'The evidence vault needs per-fact challenge semantics', author: 'skeptic', epoch: 2, idPrefix: 'C' })
    expect(fresh.ok).toBe(true)
  })
})

describe('ledger transitions (engine-enforced DAG)', () => {
  it('follows the DAG: open → contested → invariant', () => {
    const l = new Ledger()
    l.admit({ kind: 'crux', assertion: 'The queue scheduler must hold a lease across crash recovery', author: 'architect', epoch: 1, idPrefix: 'C', evidenceRef: 'vault:F-1' })
    l.setEpoch(1)
    expect(l.flip({ entryId: 'C-1', to: 'contested', reason: 'disputed', epoch: 1 }).ok).toBe(true)
    // birth epoch = 1 → invariant rejected in epoch 1
    const birth = l.flip({ entryId: 'C-1', to: 'invariant', reason: 'survived', epoch: 1 })
    expect(birth.ok).toBe(false)
    if (!birth.ok) expect(birth.code).toBe('birth-epoch')
    expect(l.flip({ entryId: 'C-1', to: 'invariant', reason: 'survived cross-exam', epoch: 2 }).ok).toBe(true)
  })

  it('rejects invariant without an evidence ref', () => {
    const l = seedLedger()
    l.setEpoch(2)
    l.flip({ entryId: 'C-1', to: 'contested', reason: 'challenge', epoch: 2 })
    const res = l.flip({ entryId: 'C-1', to: 'invariant', reason: 'no evidence attached', epoch: 3 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('invariant-needs-evidence')
  })

  it('enforces terminal irreversibility', () => {
    const l = seedLedger()
    l.setEpoch(3)
    l.flip({ entryId: 'C-2', to: 'contested', reason: 'challenge', epoch: 3 })
    l.flip({ entryId: 'C-2', to: 'falsified', reason: 'counter-example produced', epoch: 3 })
    const revive = l.flip({ entryId: 'C-2', to: 'contested', reason: 'trying again', epoch: 4 })
    expect(revive.ok).toBe(false)
    if (!revive.ok) expect(revive.code).toBe('terminal-irreversible')
  })

  it('rejects skipping the DAG (open → invariant directly)', () => {
    const l = seedLedger()
    l.setEpoch(5)
    const res = l.flip({ entryId: 'C-1', to: 'invariant', reason: 'obviously true', epoch: 5 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('illegal-transition')
  })

  it('counts flips per epoch only (CONCUR prose never counts)', () => {
    const l = seedLedger()
    l.setEpoch(2)
    expect(l.flipsInEpoch(2)).toBe(0)
    l.flip({ entryId: 'C-1', to: 'contested', reason: 'ruling', epoch: 2 })
    expect(l.flipsInEpoch(2)).toBe(1)
  })
})

describe('forest edges (chorus)', () => {
  it('is append-only and tracks recency', () => {
    const l = new Ledger()
    l.setEpoch(1)
    l.admit({ kind: 'idea', assertion: 'Ambient dock that summarizes session state', author: 'visionary', epoch: 1, idPrefix: 'I' })
    l.link({ op: 'SPROUT', from: null, to: 'I-1', seat: 'visionary' })
    l.setEpoch(2)
    l.link({ op: 'FUSE', from: 'I-1', to: 'I-2', seat: 'integrator' })
    expect(l.state().edges).toHaveLength(2)
    expect(l.newEdgesSince(2)).toBe(1)
    expect(l.newIdeasSince(2)).toBe(0)
  })
})

describe('stopping predicates', () => {
  const stateWith = (statuses: string[]): LedgerState => ({
    epoch: 1,
    entries: statuses.map((status, i) => ({
      id: `C-${i + 1}`, kind: 'crux', assertion: `a${i}`, evidenceRef: null,
      status: status as never, birthEpoch: 1, author: 'x', history: [],
    })),
    edges: [],
  })

  it('terminates on convergence (all terminal)', () => {
    const rt = initialRuntime()
    const v = evaluate(stateWith(['invariant', 'falsified', 'dissent']), rt, params(), TERMINAL)
    expect(v.action).toBe('terminate')
  })

  it('continues while open cruxes exist and movement happens', () => {
    const rt = initialRuntime()
    trackFlipRun(rt, 1, false)
    const v = evaluate(stateWith(['open', 'contested']), rt, params(), TERMINAL)
    expect(v.action).toBe('continue')
  })

  it('fires the final challenge once at stagnation, then terminates on a silent challenge', () => {
    const rt = initialRuntime()
    trackFlipRun(rt, 0, false)
    trackFlipRun(rt, 0, false)
    const v1 = evaluate(stateWith(['open', 'contested']), rt, params(), TERMINAL)
    expect(v1.action).toBe('final-challenge')
    // challenge ran silently
    const v2 = afterChallenge(0, rt)
    expect(v2.action).toBe('terminate')
  })

  it('grants exactly one consolidation epoch when the challenge flips something', () => {
    const rt = initialRuntime()
    trackFlipRun(rt, 0, false)
    trackFlipRun(rt, 0, false)
    expect(evaluate(stateWith(['open', 'contested']), rt, params(), TERMINAL).action).toBe('final-challenge')
    const v = afterChallenge(1, rt)
    expect(v.action).toBe('continue')
    // consolidation produced no flips → stagnation rule terminates (challenge never resets the run)
    trackFlipRun(rt, 0, true)
    const v2 = evaluate(stateWith(['open', 'contested']), rt, params(), TERMINAL)
    expect(v2.action).toBe('terminate')
  })

  it('terminates on max rounds', () => {
    const rt = initialRuntime()
    trackFlipRun(rt, 3, false)
    const st = stateWith(['open', 'contested'])
    st.epoch = 6
    const v = evaluate(st, rt, params({ defaultMaxRounds: 6 }), TERMINAL)
    expect(v.action).toBe('terminate')
  })

  it('terminates when the ledger never received entries', () => {
    const rt = initialRuntime()
    trackFlipRun(rt, 0, false)
    trackFlipRun(rt, 0, false)
    const v = evaluate(stateWith([]), rt, params(), TERMINAL)
    expect(v.action).toBe('terminate')
  })
})

describe('spec validation', () => {
  const goodSpec = {
    id: 'roundtable',
    label: 'Debate',
    seats: [
      { id: 'skeptic', label: 'Skeptic', persona: 'p', opGates: ['crux'], family: 'adversarial' },
      { id: 'architect', label: 'Architect', persona: 'p', opGates: ['crux'], family: 'systemic' },
    ],
    ledgerKinds: [{ kind: 'crux', idPrefix: 'C', terminalStatuses: ['invariant', 'falsified', 'dissent'] }],
    actions: ['CONCEDE', 'DEFEND', 'REFRAME'],
    steelman: true,
    forestMode: false,
    deliverableSections: ['Decision'],
  }

  it('accepts a valid spec', () => {
    const { spec, validation } = validateSpec(goodSpec)
    expect(validation.ok).toBe(true)
    expect(spec?.seats).toHaveLength(2)
  })

  it('rejects reserved seat ids and duplicate seats', () => {
    const bad = { ...goodSpec, seats: [
      { id: 'referee', label: 'R', persona: 'p', opGates: [], family: 'neutral' },
      { id: 'referee', label: 'R2', persona: 'p', opGates: [], family: 'neutral' },
    ] }
    const { validation } = validateSpec(bad)
    expect(validation.ok).toBe(false)
    expect(validation.errors.join(' ')).toMatch(/reserved/)
    expect(validation.errors.join(' ')).toMatch(/distinct/)
  })

  it('rejects unknown op gates', () => {
    const bad = { ...goodSpec, seats: [
      { id: 'skeptic', label: 'S', persona: 'p', opGates: ['nonexistent'], family: 'adversarial' },
      { id: 'architect', label: 'A', persona: 'p', opGates: [], family: 'systemic' },
    ] }
    const { validation } = validateSpec(bad)
    expect(validation.ok).toBe(false)
    expect(validation.errors.join(' ')).toMatch(/opGate/)
  })

  it('enforces the id pattern', () => {
    const bad = { ...goodSpec, id: 'Bad Id!' }
    const { validation } = validateSpec(bad)
    expect(validation.ok).toBe(false)
  })
})
