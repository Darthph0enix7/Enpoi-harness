/**
 * Ledger — the typed, append-only deliberation state (doc 54 §4, §13 amendments 6–7).
 *
 * The referee NEVER writes prose here. It proposes status flips with one-line
 * reasons; this module enforces the transition DAG, the birth-epoch rule, and
 * terminal irreversibility. Contenders propose entries (PROPOSE_CRUX/SPROUT
 * blocks); the referee admits them verbatim (procedural admission).
 *
 * Every mutation returns a structured result so the engine can audit the
 * referee: illegal flips are REJECTED, not coerced.
 */
import type { ForestEdge, LedgerEntry, LedgerState, LedgerStatus } from './spec.ts'
import { isTransitionAllowed } from './spec.ts'

export interface FlipRequest {
  entryId: string
  to: LedgerStatus
  reason: string
  epoch: number
}

export type FlipResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: 'unknown-entry' | 'illegal-transition' | 'terminal-irreversible' | 'birth-epoch' | 'invariant-needs-evidence'; detail: string }

export interface AdmissionRequest {
  kind: string
  assertion: string
  author: string
  epoch: number
  evidenceRef?: string | null
  idPrefix: string
}

export type AdmissionResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: 'duplicate'; detail: string; existingId: string }

/** Rough normalized-token overlap used for procedural dedup at admission. */
function assertionOverlap(a: string, b: string): number {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9äöüß\s]/gi, ' ').split(/\s+/).filter(t => t.length > 3))
  const ta = tokens(a); const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  return inter / Math.min(ta.size, tb.size)
}

export class Ledger {
  private readonly entries = new Map<string, LedgerEntry>()
  private readonly edges: ForestEdge[] = []
  private epoch = 0
  private seq = 0

  constructor(
    private readonly opts: { dedupeThreshold?: number } = {},
  ) {}

  state(): LedgerState {
    return {
      epoch: this.epoch,
      entries: [...this.entries.values()].map(e => ({ ...e, history: [...e.history] })),
      edges: this.edges.map(e => ({ ...e })),
    }
  }

  /** Advance the ledger's clock (called by the engine at each epoch boundary). */
  setEpoch(epoch: number): void {
    this.epoch = epoch
  }

  entry(id: string): LedgerEntry | undefined {
    return this.entries.get(id)
  }

  entriesByKind(kind: string): LedgerEntry[] {
    return [...this.entries.values()].filter(e => e.kind === kind)
  }

  /** Terminal statuses across the ledger (profile-defined per kind live in the spec). */
  openCount(terminal: ReadonlySet<LedgerStatus>): number {
    return [...this.entries.values()].filter(e => !terminal.has(e.status)).length
  }

  /**
   * Procedural admission (amendment #7): the entry text is stored VERBATIM —
   * the referee admits or dedupes, never rewrites. Duplicate = same kind +
   * high token overlap with a live (non-terminal) entry.
   */
  admit(req: AdmissionRequest): AdmissionResult {
    const threshold = this.opts.dedupeThreshold ?? 0.72
    for (const existing of this.entries.values()) {
      if (existing.kind !== req.kind) continue
      const terminalish = existing.status === 'falsified' || existing.status === 'dissent'
      if (terminalish) continue
      if (assertionOverlap(existing.assertion, req.assertion) >= threshold) {
        return { ok: false, code: 'duplicate', detail: `overlaps ${existing.id}`, existingId: existing.id }
      }
    }
    this.seq += 1
    const entry: LedgerEntry = {
      id: `${req.idPrefix}-${this.seq}`,
      kind: req.kind,
      assertion: req.assertion,
      evidenceRef: req.evidenceRef ?? null,
      status: 'open',
      birthEpoch: req.epoch,
      author: req.author,
      history: [],
    }
    this.entries.set(entry.id, entry)
    return { ok: true, entry: { ...entry, history: [...entry.history] } }
  }

  /**
   * Referee status flip — engine-enforced (amendment #6):
   *  - strict DAG, no self-loops
   *  - terminal states irreversible
   *  - `invariant` unreachable in the entry's birth epoch
   *  - `invariant` requires an evidenceRef on the entry
   */
  flip(req: FlipRequest): FlipResult {
    const entry = this.entries.get(req.entryId)
    if (!entry) return { ok: false, code: 'unknown-entry', detail: req.entryId }
    if (entry.status === req.to) {
      return { ok: false, code: 'illegal-transition', detail: `${entry.id} already ${req.to}` }
    }
    if (!isTransitionAllowed(entry.status, req.to)) {
      if (TRANSITION_TERMINAL.has(entry.status)) {
        return { ok: false, code: 'terminal-irreversible', detail: `${entry.id} is ${entry.status}` }
      }
      return { ok: false, code: 'illegal-transition', detail: `${entry.status} → ${req.to} violates the DAG` }
    }
    if (req.to === 'invariant' && entry.birthEpoch === req.epoch) {
      return { ok: false, code: 'birth-epoch', detail: `${entry.id} introduced this epoch — must survive one cross-examination` }
    }
    if (req.to === 'invariant' && !entry.evidenceRef) {
      return { ok: false, code: 'invariant-needs-evidence', detail: `${entry.id} has no evidenceRef in the vault` }
    }
    const from = entry.status
    entry.status = req.to
    entry.history.push({ epoch: req.epoch, from, to: req.to, reason: req.reason })
    return { ok: true, entry: { ...entry, history: [...entry.history] } }
  }

  /** Forest edge (chorus). Append-only: no delete, no reject. */
  link(edge: Omit<ForestEdge, 'epoch'>): ForestEdge {
    const full: ForestEdge = { ...edge, epoch: this.epoch }
    this.edges.push(full)
    return full
  }

  /** Ideas created since the given epoch (chorus saturation detection). */
  newIdeasSince(epoch: number): number {
    return [...this.entries.values()].filter(e => e.birthEpoch >= epoch).length
  }

  newEdgesSince(epoch: number): number {
    return this.edges.filter(e => e.epoch >= epoch).length
  }

  /**
   * The engine's materiality diff: how many entry STATUSES flipped in the
   * given epoch. CONCUR/PASS lines and prose never count (amendment #6).
   */
  flipsInEpoch(epoch: number): number {
    let flips = 0
    for (const e of this.entries.values()) {
      flips += e.history.filter(h => h.epoch === epoch).length
    }
    return flips
  }

  /** Entries ADMITTED in the given epoch (chorus materiality: new ideas). */
  admissionsInEpoch(epoch: number): number {
    return [...this.entries.values()].filter(e => e.birthEpoch === epoch).length
  }
}

const TRANSITION_TERMINAL: ReadonlySet<LedgerStatus> = new Set(['invariant', 'falsified', 'dissent'])
