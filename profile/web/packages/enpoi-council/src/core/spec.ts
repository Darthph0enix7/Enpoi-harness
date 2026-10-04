/**
 * CouncilSpec — the declarative heart of the council engine (doc 54).
 *
 * A council is DATA: seats (any number), a typed ledger, a deterministic
 * stopping predicate, and a deliverable. roundtable and chorus are two
 * built-in specs; user councils are registered specs. The five fixed
 * invariants (doc 54 §1) are enforced structurally here and in the engine —
 * a spec cannot override them.
 *
 * Two spec shapes exist (Oracle amendment #1):
 *  - CouncilSpec        — internal TypeScript; full predicates allowed.
 *  - DeclarativeCouncilSpec — JSON-safe; stoppingPolicy enums + chair
 *    templates. council_register (v2) accepts only this shape.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export const SeatSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  label: z.string().min(1).max(64),
  /** Persona text injected as the seat's system context. */
  persona: z.string().min(1),
  /**
   * Ledger operations this seat may propose (engine-enforced mechanically —
   * not prompt-only). Empty array = may propose nothing (pure analyst).
   * Referenced kinds must exist in the ledger schema.
   */
  opGates: z.array(z.string()).default([]),
  /**
   * Model-family hint for the default routing policy (doc 54 §2.2):
   * 'adversarial' | 'systemic' | 'practical' | 'divergent' | 'empirical'.
   * Advisory only — actual routes come from enpoi-orchestration.personas.
   */
  family: z.enum(['adversarial', 'systemic', 'practical', 'divergent', 'empirical', 'neutral']).default('neutral'),
})
export type SeatSpec = z.infer<typeof SeatSpecSchema>

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Status transition DAG (Oracle amendment #6). Terminal states are
 * irreversible in standard epochs; `invariant` is unreachable in the
 * entry's birth epoch. The engine enforces this — the referee cannot
 * hallucinate reverse transitions.
 */
export const LedgerStatusSchema = z.enum(['open', 'contested', 'invariant', 'falsified', 'dissent'])
export type LedgerStatus = z.infer<typeof LedgerStatusSchema>

export const TRANSITION_DAG: Readonly<Record<LedgerStatus, readonly LedgerStatus[]>> = Object.freeze({
  open: Object.freeze(['contested']),
  contested: Object.freeze(['invariant', 'falsified', 'dissent']),
  invariant: Object.freeze([]),
  falsified: Object.freeze([]),
  dissent: Object.freeze([]),
})

export function isTransitionAllowed(from: LedgerStatus, to: LedgerStatus): boolean {
  return from !== to && TRANSITION_DAG[from].includes(to)
}

export const LedgerEntrySchema = z.object({
  id: z.string(),                      // 'C-1', 'R-2', 'I-1' …
  kind: z.string(),                    // profile-defined: 'crux' | 'risk' | 'fact' | 'idea' …
  assertion: z.string(),               // the referee admits proposed assertions verbatim — never rewrites
  evidenceRef: z.string().nullable().default(null),  // vault citation (required for invariant)
  status: LedgerStatusSchema.default('open'),
  /** Epoch in which the entry was admitted (engine-set; drives the birth-epoch rule). */
  birthEpoch: z.number().int().nonnegative().default(0),
  /** Seat that proposed the entry (provenance). */
  author: z.string(),
  /** Append-only ruling history: {epoch, from, to, reason}. */
  history: z.array(z.object({
    epoch: z.number().int().nonnegative(),
    from: LedgerStatusSchema,
    to: LedgerStatusSchema,
    reason: z.string(),
  })).default([]),
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

/** Forest edge for ideation profiles (chorus): append-only, never deleted. */
export const ForestEdgeSchema = z.object({
  op: z.enum(['SPROUT', 'BRANCH', 'FUSE', 'TENSION']),
  from: z.string().nullable(),         // parent idea id (null for SPROUT roots)
  to: z.string(),                      // child idea id
  epoch: z.number().int().nonnegative(),
  seat: z.string(),
})
export type ForestEdge = z.infer<typeof ForestEdgeSchema>

export interface LedgerState {
  epoch: number
  entries: LedgerEntry[]
  edges: ForestEdge[]
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

export type StopVerdict =
  | { action: 'continue' }
  | { action: 'final-challenge'; reason: string }
  | { action: 'terminate'; reason: string }

export interface CouncilParams {
  defaultMaxRounds: number
  stagnationLimit: number
  challengeRound: boolean
  maxDebateTokens: number
  debaterTimeoutMs: number
  quorumFraction: number
  evidenceBroker: boolean
  evidenceTimeoutMs: number
  blindEpoch: boolean
  preflightInventory: boolean
  /** Wall-clock ceiling for one council run; on breach the run skips to the chair. */
  runDeadlineMs: number
}

/**
 * Pure stopping predicate. Given the ledger state and params, decide whether
 * to continue, fire the final-challenge epoch, or terminate. NEVER consults
 * an LLM. Engine-computed ledger diffs are the only input that matters.
 */
export type StoppingPredicate = (state: LedgerState, params: CouncilParams) => StopVerdict

// ---------------------------------------------------------------------------
// Council spec
// ---------------------------------------------------------------------------

export const CouncilSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  label: z.string().min(1).max(64),
  description: z.string().default(''),
  seats: z.array(SeatSpecSchema).min(2).max(8),
  ledgerKinds: z.array(z.object({
    kind: z.string(),
    idPrefix: z.string().min(1).max(4),
    /** Which statuses are meaningful for this kind (subset ordering follows the DAG). */
    terminalStatuses: z.array(LedgerStatusSchema).min(1),
  })).min(1),
  /** Ops a contender turn may propose (profile vocabulary, e.g. CONCEDE/DEFEND/…). */
  actions: z.array(z.string()).min(1),
  steelman: z.boolean().default(false),
  scopeContract: z.string().default(''),
  /** 'blind' = epoch 0 independent formulation; 'open' = straight to rounds. */
  opening: z.enum(['blind', 'open']).default('blind'),
  preflightInventory: z.boolean().default(false),
  /** Forest mode (chorus): entries are idea nodes; edges carry the structure; nothing is ever deleted. */
  forestMode: z.boolean().default(false),
  deliverableSections: z.array(z.string()).min(1),
})
export type CouncilSpec = z.infer<typeof CouncilSpecSchema>

/** JSON-safe spec shape accepted by `council_register` (v2, Oracle amendment #1). */
export const DeclarativeStoppingPolicySchema = z.object({
  type: z.enum(['ledger_convergence', 'topological_saturation', 'fixed_epochs']),
  stagnationLimit: z.number().int().min(1).max(6).optional(),
  maxEpochs: z.number().int().min(1).max(12).optional(),
})
export type DeclarativeStoppingPolicy = z.infer<typeof DeclarativeStoppingPolicySchema>

/**
 * Full JSON-safe council definition for `council_register` (v2). Stopping and
 * chair prompts are declarative (enums + templates) because tool arguments
 * cannot carry closures across the JSON-RPC boundary.
 */
export interface DeclarativeCouncilSpec {
  id: string
  label: string
  description?: string
  seats: Array<{ id: string; label: string; persona: string; opGates?: string[]; family?: SeatSpec['family'] }>
  ledgerKinds: Array<{ kind: string; idPrefix: string; terminalStatuses: LedgerStatus[] }>
  actions: string[]
  steelman?: boolean
  scopeContract?: string
  opening?: 'blind' | 'open'
  forestMode?: boolean
  deliverableSections: string[]
  stoppingPolicy: DeclarativeStoppingPolicy
  chairTemplate: { systemPrompt: string; userPromptTemplate: string }
}

// ---------------------------------------------------------------------------
// Validation (Oracle amendment #12)
// ---------------------------------------------------------------------------

const RESERVED_IDS = new Set(['referee', 'chair'])

export interface SpecValidation {
  ok: boolean
  errors: string[]
}

/** Structural validation for a CouncilSpec. The five invariants are non-overridable. */
export function validateSpec(spec: unknown): { spec?: CouncilSpec; validation: SpecValidation } {
  const parsed = CouncilSpecSchema.safeParse(spec)
  if (!parsed.success) {
    return { validation: { ok: false, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) } }
  }
  const s = parsed.data
  const errors: string[] = []
  const ids = new Set(s.seats.map(seat => seat.id))
  if (ids.size !== s.seats.length) errors.push('seat ids must be distinct')
  for (const reserved of RESERVED_IDS) {
    if (ids.has(reserved)) errors.push(`seat id "${reserved}" is reserved for the arbiter roles`)
  }
  if (s.seats.length < 2) errors.push('a council needs at least 2 contender seats')
  const kinds = new Set(s.ledgerKinds.map(k => k.kind))
  for (const seat of s.seats) {
    for (const op of seat.opGates) {
      if (!kinds.has(op) && !s.actions.includes(op)) errors.push(`seat "${seat.id}" opGate "${op}" is neither a ledger kind nor an action`)
    }
  }
  if (s.forestMode && !s.actions.some(a => ['SPROUT', 'BRANCH', 'FUSE', 'TENSION'].includes(a))) {
    errors.push('forestMode requires at least one forest operation in actions')
  }
  return { spec: errors.length === 0 ? s : undefined, validation: { ok: errors.length === 0, errors } }
}
