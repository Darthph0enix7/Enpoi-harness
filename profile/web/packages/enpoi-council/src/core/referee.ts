/**
 * Referee pass — the arbiter (doc 54 §7, §13 amendments 6–8).
 *
 * One flagship fiber per pass. Its structured output is the ONLY input to
 * ledger mutations, and the Ledger + engine enforce every rule (DAG, birth
 * epoch, terminal irreversibility, evidence-gated invariants) — the referee
 * cannot hallucinate a illegal transition into existence.
 *
 * Three outputs, never prose authorship:
 *   1. admissions   — procedural acceptance of contender PROPOSE_* blocks
 *   2. flips        — status transitions with one-line reasons
 *   3. directives   — numbered public imperatives per seat + floor allocation
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  COUNCIL_DENIED_TOOLS,
  DEBATER_DENIED_TOOLS,
  disposeSeatFibers,
  startSeatFiber,
  waitForSeatTurn,
} from './fiber.ts'
import type { Ledger, LedgerStatus } from './ledger.ts'
import type { CouncilSpec } from './spec.ts'

export interface RefereeFlip {
  id: string
  to: LedgerStatus
  reason: string
}

export interface RefereeAdmission {
  kind: string
  assertion: string
  author: string
  evidenceRef?: string | null
}

export interface RefereeOutput {
  admissions: RefereeAdmission[]
  flips: RefereeFlip[]
  directives: Record<string, string>   // seatId → imperative text
  floor: { active: string[]; standby: string[] }
  scopeWarnings: string[]
}

/**
 * Extract structured proposal blocks from a seat turn:
 *   PROPOSE_CRUX: <assertion>            (debate family)
 *   PROPOSE_RISK: <assertion>
 *   SPROUT: <title> | <rationale>        (forest family)
 * Returns raw proposals for the referee's admission decision.
 */
export function extractProposals(turnText: string): Array<{ kind: string; assertion: string }> {
  const out: Array<{ kind: string; assertion: string }> = []
  // Models dress protocol lines in bullets, bold, or backticks; strip the
  // dressing first so the semantic tokens always match.
  const cleaned = turnText
    .split(/\n/)
    .map(line => line
      .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)*/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, ''))
    .join('\n')
  const block = /PROPOSE_(CRUX|RISK)\s*[:\-–]\s*(.+)/gi
  for (const m of cleaned.matchAll(block)) {
    const assertion = m[2].trim()
    if (assertion.length > 0) out.push({ kind: m[1].toLowerCase(), assertion })
  }
  const sprout = /SPROUT\s*[:\-–]\s*(.+)/gi
  for (const m of cleaned.matchAll(sprout)) {
    const assertion = m[1].trim()
    if (assertion.length > 0) out.push({ kind: 'idea', assertion })
  }
  return out
}

const REFEREE_SYSTEM_BASE = [
  'You are the Referee of a high-stakes multi-agent council. You are not a debater.',
  'You manage the dispute ledger procedurally: you ADMIT proposed entries, you TOGGLE entry statuses, you issue numbered directives, you allocate the floor.',
  'You NEVER write assertions, arguments, or synthesis prose. You never introduce claims of your own.',
  'Do not call any tools and never attempt shell commands, code execution, or file reads — you have no tools and no shell. Your ONLY output channel is your reply text.',
  'Rules you must enforce:',
  '- A state flip away from `contested` requires the argument to have survived scrutiny; deny flips that rest on unverified assertions (STATUS_CHANGE_DENIED: <reason>).',
  '- An attack on another seat\'s crux without a `STEELMAN [<seat>]:` block is denied (STATUS_CHANGE_DENIED: missing mandatory steelman).',
  '- Out-of-scope argumentation gets a scope warning and no ledger effect.',
  '- Admission kinds must be EXACTLY the ledger kinds this council declares in the prompt (the CURRENT LEDGER line and the council name define them). Never invent kinds; an unknown kind is rejected and the entry is lost.',
  'Output STRICTLY one JSON object as your reply text, no prose around it, never inside a tool call:',
  '{"admissions":[{"kind":"<declared ledger kind>","assertion":"...","author":"<seat>","evidenceRef":null}],',
  ' "flips":[{"id":"I-1","to":"contested","reason":"..."}],',
  ' "directives":{"<seat>":"1. ..."},',
  ' "floor":{"active":["<seat>"],"standby":["<seat>"]},',
  ' "scopeWarnings":["..."]}',
].join('\n')

export interface RefereePassInput {
  spec: CouncilSpec
  ledgerText: string
  roundTranscript: string      // this epoch's seat outputs (the referee is the only full reader)
  vaultDeltaText: string
  epoch: number
  previousDirectives: Record<string, string>
  /** Seats retired this run (dead routes) — excluded from floor and directives. */
  offlineSeats?: string[]
}

/**
 * Run one referee pass: spawn a one-shot flagship fiber, wait, parse, and
 * APPLY admissions + flips through the Ledger (engine-enforced). Returns the
 * validated output plus the application audit.
 */
export async function runRefereePass(
  ctx: Context,
  parent: Agent,
  input: RefereePassInput,
  ledger: Ledger,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ output: RefereeOutput; applied: { admissions: string[]; flips: string[]; rejected: string[] } }> {
  const prompt = [
    `EPOCH: ${input.epoch}`,
    `COUNCIL: ${input.spec.label}`,
    `LEDGER KINDS (admission "kind" must be exactly one of these): ${input.spec.ledgerKinds.map(k => k.kind).join(', ')}`,
    input.spec.scopeContract ? `SCOPE CONTRACT:\n${input.spec.scopeContract}` : '',
    `CURRENT LEDGER:\n${input.ledgerText}`,
    input.vaultDeltaText ? `NEW EVIDENCE THIS EPOCH:\n${input.vaultDeltaText}` : '',
    // Delivered memory (stateless-judge principle): the prior pass's own
    // directives, so a fresh referee stays coherent across epochs — it can
    // acknowledge compliance and avoid repeating or contradicting itself.
    input.previousDirectives !== undefined && Object.keys(input.previousDirectives).length > 0
      ? `YOUR DIRECTIVES FROM THE PREVIOUS EPOCH (you are a fresh pass of the same referee — keep them coherent; drop what was addressed, follow through on what was not):\n${Object.entries(input.previousDirectives).map(([seat, text]) => `${seat}: ${text}`).join('\n')}`
      : '',
    input.offlineSeats !== undefined && input.offlineSeats.length > 0
      ? `OFFLINE SEATS (their routes failed — they produce nothing; exclude them from floor.active and issue them no directives): ${input.offlineSeats.join(', ')}`
      : '',
    `SEAT OUTPUTS THIS EPOCH:\n${input.roundTranscript}`,
    'Produce the referee JSON now as your reply text — never through a tool call. Admit proposed entries verbatim (dedupe against the ledger); flip statuses only where the burden of proof was met; issue at most 3 numbered directives per active seat; allocate the floor for the next epoch.',
  ].filter(Boolean).join('\n\n')

  let fiber: { childId: string } | undefined
  try {
    fiber = await startSeatFiber(ctx, parent, {
      seatId: 'referee',
      label: `council referee: epoch ${input.epoch}`,
      persona: REFEREE_SYSTEM_BASE,
      initialPrompt: prompt,
      denyTools: DEBATER_DENIED_TOOLS,   // referee sees no retrieval tools — ledger + transcript only
    }, signal)
    const text = await waitForSeatTurn(ctx, fiber.childId, signal, timeoutMs)
    const output = parseRefereeOutput(text, input.spec)
    const applied = applyRefereeOutput(output, ledger, input, input.spec, input.roundTranscript)
    return { output, applied }
  } finally {
    if (fiber !== undefined) {
      try { await disposeSeatFibers(ctx, [fiber]) } catch { /* best effort */ }
    }
  }
}

/** Parse the referee's JSON tolerantly (find the outermost object).
 *
 * A pass with NO JSON object at all is a HARD handoff failure: the referee's
 * structured output is the only input to ledger mutations, so silently
 * treating it as a no-op drops the epoch's adjudication on the floor and
 * sends the chair a stale ledger. The caller retries once and then reports
 * the failure with this reason (2026-09-27: an epoch-2 referee emitted its
 * JSON inside a bash heredoc, the fiber capture read only assistant text,
 * and the run proceeded to a chair that compiled an empty ledger).
 * @param text - the referee turn's extracted assistant text.
 * @param spec - the council spec (seat ids, ledger kinds).
 * @returns the sanitized referee output.
 * @throws {RefereeOutputError} when the turn contains no JSON object.
 */
export function parseRefereeOutput(text: string, spec: CouncilSpec): RefereeOutput {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) {
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 240)
    throw new RefereeOutputError(
      `referee pass returned no JSON object (got ${text.trim().length} chars${excerpt ? `: "${excerpt}"` : ''})`,
    )
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<RefereeOutput>
    const seatIds = new Set(spec.seats.map(s => s.id))
    return {
      // Unknown kinds are KEPT here so applyRefereeOutput can report each
      // rejection; filtering them silently was the 2026-09-27 data-loss bug
      // (a referee admitted 5 entries as "fact"/"idea"/"observation" and the
      // roundtable ledger dropped every one without a trace).
      admissions: (Array.isArray(parsed.admissions) ? parsed.admissions : [])
        .filter(a => a && typeof a.kind === 'string' && a.kind.trim() !== '' && typeof a.assertion === 'string')
        .map(a => ({ kind: a.kind, assertion: a.assertion, author: typeof a.author === 'string' ? a.author : 'unknown', evidenceRef: a.evidenceRef ?? null })),
      flips: (Array.isArray(parsed.flips) ? parsed.flips : [])
        .filter(f => f && typeof f.id === 'string' && typeof f.to === 'string')
        .map(f => ({ id: f.id, to: f.to as LedgerStatus, reason: typeof f.reason === 'string' ? f.reason : '' })),
      directives: sanitizeDirectives(parsed.directives, seatIds),
      floor: sanitizeFloor(parsed.floor, spec),
      scopeWarnings: (Array.isArray(parsed.scopeWarnings) ? parsed.scopeWarnings : []).filter(w => typeof w === 'string'),
    }
  } catch (err) {
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 240)
    throw new RefereeOutputError(`referee JSON parse failed (${err instanceof Error ? err.message : String(err)}) on "${excerpt}"`)
  }
}

/** A referee pass whose structured output could not be captured or parsed. */
export class RefereeOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefereeOutputError'
  }
}

function sanitizeDirectives(raw: unknown, seatIds: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [seat, text] of Object.entries(raw as Record<string, unknown>)) {
      if (seatIds.has(seat) && typeof text === 'string' && text.trim().length > 0) {
        out[seat] = text.trim().slice(0, 1200)
      }
    }
  }
  return out
}

function sanitizeFloor(raw: unknown, spec: CouncilSpec): { active: string[]; standby: string[] } {
  const seatIds = spec.seats.map(s => s.id)
  let active = seatIds
  let standby: string[] = []
  if (raw !== null && typeof raw === 'object') {
    const r = raw as { active?: unknown; standby?: unknown }
    if (Array.isArray(r.active)) {
      const filtered = r.active.filter((s): s is string => typeof s === 'string' && seatIds.includes(s))
      if (filtered.length > 0) active = filtered
    }
    if (Array.isArray(r.standby)) {
      standby = r.standby.filter((s): s is string => typeof s === 'string' && seatIds.includes(s) && !active.includes(s))
    }
  }
  // Guarantee: never zero active seats.
  if (active.length === 0) active = seatIds
  return { active, standby: standby.filter(s => !active.includes(s)) }
}

/**
 * Procedural steelman gate (amendment #8): when the spec mandates steelman,
 * an ATTACK flip (→ contested | falsified) is rejected unless the round
 * transcript contains an explicit `STEELMAN [<seat>]:` block. The referee's
 * own judgment is not enough — the engine checks the transcript.
 */
export function enforceSteelman(
  flips: RefereeFlip[],
  spec: CouncilSpec,
  roundTranscript: string,
): { allowed: RefereeFlip[]; rejected: string[] } {
  if (!spec.steelman) return { allowed: flips, rejected: [] }
  const hasSteelman = /STEELMAN\s*\[/i.test(roundTranscript)
  if (hasSteelman) return { allowed: flips, rejected: [] }
  const allowed: RefereeFlip[] = []
  const rejected: string[] = []
  for (const flip of flips) {
    if (flip.to === 'contested' || flip.to === 'falsified') {
      rejected.push(`${flip.id} → ${flip.to}: STATUS_CHANGE_DENIED: missing mandatory steelman`)
    } else {
      allowed.push(flip)
    }
  }
  return { allowed, rejected }
}

/** Apply the referee's decisions through the Ledger (engine is the enforcer). */
export function applyRefereeOutput(
  output: RefereeOutput,
  ledger: Ledger,
  input: RefereePassInput,
  spec?: CouncilSpec,
  roundTranscript?: string,
): { admissions: string[]; flips: string[]; rejected: string[] } {
  const audit = { admissions: [] as string[], flips: [] as string[], rejected: [] as string[] }

  let flips = output.flips
  if (spec !== undefined && roundTranscript !== undefined) {
    const gate = enforceSteelman(flips, spec, roundTranscript)
    flips = gate.allowed
    audit.rejected.push(...gate.rejected)
  }

  for (const adm of output.admissions) {
    const kindSpec = input.spec.ledgerKinds.find(k => k.kind === adm.kind)
    if (kindSpec === undefined) {
      // Reported, never silent: an admission in a kind this council's ledger
      // does not define is a referee protocol error, and the chair prompt
      // carries the rejection through the REFEREE RECORD.
      audit.rejected.push(`${adm.kind} admission by ${adm.author} rejected: unknown ledger kind for this council (allowed: ${input.spec.ledgerKinds.map(k => k.kind).join(', ')})`)
      continue
    }
    const res = ledger.admit({
      kind: adm.kind,
      assertion: adm.assertion,       // verbatim — procedural admission
      author: adm.author,
      epoch: input.epoch,
      evidenceRef: adm.evidenceRef ?? null,
      idPrefix: kindSpec.idPrefix,
    })
    if (res.ok) audit.admissions.push(`${res.entry.id} (${adm.kind}) by ${adm.author}`)
    else if (!res.ok && res.code === 'duplicate') audit.rejected.push(`duplicate of ${res.existingId}`)
  }

  for (const flip of flips) {
    const res = ledger.flip({ entryId: flip.id, to: flip.to, reason: flip.reason, epoch: input.epoch })
    if (res.ok) audit.flips.push(`${flip.id} → ${flip.to}`)
    else if (!res.ok) audit.rejected.push(`${flip.id} → ${flip.to}: ${res.code} (${res.detail})`)
  }

  return audit
}
