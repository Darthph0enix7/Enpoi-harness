/**
 * Council Engine — the task-agnostic epoch loop (doc 54 §3).
 *
 *   preflight? → blind epoch 0 → epochs [ context assembly → parallel seats →
 *   evidence extraction → broker flush → referee pass → engine diff →
 *   stopping ] → chair synthesis.
 *
 * Everything the profiles vary lives in the CouncilSpec; everything the five
 * invariants demand lives here. Blocking by contract; cancellation via the
 * caller's AbortSignal (park semantics handled by the cascade plugin).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  COUNCIL_DENIED_TOOLS,
  councilDiag,
  disposeSeatFibers,
  ensureBriefWithin,
  estimateTokens,
  followupSeatFiber,
  getLivingBriefText,
  resolvePersonaChain,
  startSeatFiber,
  waitForSeatTurnDetailed,
  type SeatFiber,
  type SeatTurn,
} from './fiber.ts'
import { EvidenceQueue, extractEvidenceRequests, serviceEvidenceQueue } from './broker.ts'
import type { BrokerResult, EvidenceRequest } from './broker.ts'
import { councilDenyList } from './fiber.ts'
import { ChairOutputError, validateChairDeliverable } from './chair.ts'
import { loadCouncilRegistry } from '../registry.ts'
import { Ledger } from './ledger.ts'
import { afterChallenge, evaluate, initialRuntime, trackFlipRun, type StoppingRuntime } from './stopping.ts'
import { RefereeOutputError, extractProposals, runRefereePass } from './referee.ts'
import type { CouncilParams } from './spec.ts'
import type { CouncilSpec, DeclarativeCouncilSpec } from './spec.ts'
import { EvidenceVault } from './vault.ts'

export interface CouncilRuntimeResult {
  deliverable: string
  roundsRun: number
  stopReason: string
  ledgerState: ReturnType<Ledger['state']>
  vaultAdditions: number
  quality: {
    cruxResolutionRatio: number | null
    adversarialSurvivability: number | null
    invariantDensity: number
    newClusters: number | null
  }
  totalTokens: number
  audit: string[]
}

export interface RunCouncilOptions {
  spec: CouncilSpec
  query: string
  params: CouncilParams
  signal: AbortSignal
  /** Round-cap override from the tool call (safety net only). */
  maxRoundsOverride?: number
  /**
   * Chair prompt override for settings-defined councils. `systemPrompt`
   * replaces the Chair persona; `userPromptTemplate` replaces the compiled
   * synthesis prompt with the documented placeholders substituted. Omitted for
   * the built-in councils — their chair prompts stay byte-identical.
   */
  chairTemplate?: DeclarativeCouncilSpec['chairTemplate']
  onRound?: (info: { epoch: number; audit: Record<string, unknown> }) => void
}

const MAX_SEAT_OUTPUT_CHARS = 6000
const MAX_REFEREE_NOTES = 12
const MAX_REFEREE_NOTE_CHARS = 320
const MAX_REFEREE_RECORD_CHARS = 2400

/**
 * A required council input is missing at a handoff point: the run stops with
 * this reason instead of proceeding to synthesize from nothing or flailing
 * (2026-09-27: a 2-round roundtable with a lost referee output forwarded a
 * six-section document whose every body said "no data").
 */
export class CouncilHandoffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CouncilHandoffError'
  }
}

export async function runCouncil(
  ctx: Context,
  parent: Agent,
  opts: RunCouncilOptions,
): Promise<CouncilRuntimeResult> {
  const { spec, query, params, signal } = opts
  const maxRounds = opts.maxRoundsOverride !== undefined
    ? Math.min(12, Math.max(1, opts.maxRoundsOverride))
    : params.defaultMaxRounds
  const effectiveParams: CouncilParams = { ...params, defaultMaxRounds: maxRounds }

  const audit: string[] = []
  const ledger = new Ledger()
  const vault = new EvidenceVault()
  const queue = new EvidenceQueue()
  const runtime: StoppingRuntime = initialRuntime()
  const fibers = new Map<string, SeatFiber>()
  /** Seats whose FRESH fiber also failed — retired for the rest of the run
   * (no per-epoch respawn churn; quorum rules decide whether the run continues). */
  const deadSeats = new Set<string>()
  /** Per-seat last participation epoch — drives cumulative vault catch-up (amendment #4). */
  const lastActive = new Map<string, number>()
  let totalTokens = 0
  let directives: Record<string, string> = {}
  let floor = { active: spec.seats.map(s => s.id), standby: [] as string[] }
  let briefStall = ''
  /** Bounded referee record: rejections/parse failures the ledger cannot show.
   * It rides into the chair prompt so lost adjudication is VISIBLE at synthesis. */
  const refereeNotes: string[] = []
  const noteReferee = (note: string): void => {
    const clipped = note.replace(/\s+/g, ' ').trim().slice(0, MAX_REFEREE_NOTE_CHARS)
    if (clipped.length === 0) return
    refereeNotes.push(clipped)
    if (refereeNotes.length > MAX_REFEREE_NOTES) refereeNotes.shift()
  }

  /**
   * Broker flush with the honesty contract: a request the broker child did not
   * answer with a parseable sheet is NEVER dropped. It is re-queued for the
   * next boundary (bounded), and after BROKER_MAX_ATTEMPTS the vault receives
   * a named RETRIEVAL FAILED sheet so no verdict, referee note, or chair
   * sentence can silently argue around a fact nobody retrieved.
   */
  const BROKER_MAX_ATTEMPTS = 3
  const brokerAttempts = new Map<string, number>()
  const runBroker = async (reqs: EvidenceRequest[], epoch: number): Promise<BrokerResult> => {
    const served = await serviceEvidenceQueue(ctx, parent, reqs, vault, epoch, signal, params.evidenceTimeoutMs)
    const retry: EvidenceRequest[] = []
    for (const miss of served.missed) {
      const attempt = (brokerAttempts.get(miss.req.ticket) ?? 0) + 1
      brokerAttempts.set(miss.req.ticket, attempt)
      const named = `${miss.req.ticket}: ${miss.reason}`
      if (attempt < BROKER_MAX_ATTEMPTS) {
        retry.push(miss.req)
        const line = `${named} — next action: re-request at epoch ${epoch + 1} (attempt ${attempt + 1}/${BROKER_MAX_ATTEMPTS})`
        audit.push(`epoch ${epoch}: broker miss — ${line}`)
        councilDiag(`[broker] ${line}`)
        if (briefStall === '') briefStall = line
      } else {
        const line = `${named} — retrieval abandoned after ${attempt} attempts; the vault carries a RETRIEVAL FAILED sheet for the chair`
        audit.push(`epoch ${epoch}: broker miss — ${line}`)
        councilDiag(`[broker] ${line}`)
        if (briefStall === '') briefStall = line
        vault.add({
          citation: `unretrieved (broker: ${miss.reason})`,
          question: miss.req.question,
          factSheet: `RETRIEVAL FAILED after ${attempt} attempts: evidence was requested but the broker child never returned a parseable fact sheet. Treat this as OPEN — do not assert it either way.\nCONFIDENCE: low`,
          addedEpoch: epoch,
          retrievedBy: served.retrievedBy,
        })
      }
    }
    if (retry.length > 0) queue.push(retry, vault)
    return served
  }

  /**
   * Round-event broker payload. `excess` counts sheets the broker returned
   * beyond the requested batch and `excessReasons` names each drop — a
   * misnumbered batch is visible on the event stream, never swallowed.
   */
  const brokerEvent = (b: BrokerResult) => ({
    sheets: b.sheets,
    missed: b.missed.length,
    errors: b.errors.slice(0, 3),
    excess: b.excess.length,
    excessReasons: b.excess.map(e => e.reason).slice(0, 3),
  })

  const emitRound = (epoch: number, extra: Record<string, unknown>) => {
    try {
      opts.onRound?.({ epoch, audit: extra })
      parent.session.append('council/round', {
        epoch,
        council: spec.id,
        ledgerDiff: {
          entries: ledger.state().entries.map(e => ({ id: e.id, kind: e.kind, status: e.status, author: e.author })),
          edges: ledger.state().edges.length,
        },
        floor,
        offline: [...deadSeats],
        vault: vault.since(epoch).length,
        ...extra,
      })
    } catch (err) {
      councilDiag(`council/round append failed: ${String(err)}`)
    }
  }

  try {
    // Observability: started/finished bracket the run (free-form payloads).
    try {
      parent.session.append('council/started', { council: spec.id, query: query.slice(0, 160), seats: spec.seats.map(s => s.id), blindEpoch: spec.opening === 'blind' })
    } catch (err) { councilDiag(`council/started append failed: ${String(err)}`) }

    // ── Shared grounding ────────────────────────────────────────────────
    await ensureBriefWithin(parent, signal)
    const briefText = getLivingBriefText(ctx, parent)

    // ── Optional preflight: INVENTORY ONLY (never interpretation) ───────
    if (params.evidenceBroker && spec.preflightInventory) {
      try {
        const res = await runBroker(
          [{ ticket: 'EV-preflight', seatId: 'preflight', target: 'this repository', question: `Map the top-level modules, key entry points, and existing docs relevant to: ${query}` }],
          0,
        )
        audit.push(`preflight inventory: ${res.sheets} sheet(s)${res.missed.length > 0 ? ` — ${res.missed.length} missed (named; re-requested at epoch 2)` : ''}${res.excess.length > 0 ? ` — ${res.excess.length} excess sheet(s) beyond the batch (named)` : ''}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        audit.push(`preflight inventory unavailable: ${msg} — proceeding without it`)
        councilDiag(`preflight failed (non-fatal): ${msg}`)
      }
    }

    // ── Opening: blind epoch 0 (independent formulation) or straight in ──
    // After blind formulation, a REFEREE ADMISSION PASS seeds the ledger
    // (procedural admission of PROPOSE_* blocks) before any deliberation
    // epoch — the "Dispute Ledger Ingest" step. Seats never argue over an
    // empty ledger.
    const openingPrompt = (seatPersonaGate: string) => [
      seatPersonaGate,
      `COUNCIL: ${spec.label}`,
      `QUERY: ${query}`,
      briefText ? `LIVING BRIEF (session context):\n${briefText}` : '',
      spec.scopeContract ? `SCOPE CONTRACT (violations are ruled out of order):\n${spec.scopeContract}` : '',
      spec.opening === 'blind'
        ? 'BLIND FORMULATION: You are formulating INDEPENDENTLY — you cannot see the other seats. State your position in your own voice.'
        : '',
      spec.forestMode
        ? 'Propose ideas as SPROUT: <title> | <rationale> lines (one per idea).'
        : (spec.ledgerKinds.some(k => k.kind === 'crux') ? 'Where you identify a decisive point of disagreement, add a PROPOSE_CRUX: <assertion> line.' : ''),
      'If you need ground truth from the codebase or the web, add NEED_EVIDENCE(target: <area>, question: <what to verify>) lines. Evidence arrives at the next epoch boundary — conclude your arguments conditionally.',
      'IMPORTANT: this council provides NO shell and NO file tools (run_code is non-functional; bash/read/grep/glob are denied). Never attempt commands or file reads — argue directly, or request facts with NEED_EVIDENCE.',
      'PROTOCOL LINE FORMATS (the council parses these mechanically — always exactly these, one line each, no markdown, no headings around them):',
      '  NEED_EVIDENCE(target: <area>, question: <what to verify>)',
      '  PROPOSE_CRUX: <assertion>',
      'Never reformat these lines (no "NEED_EVIDENCE" alone on a line with Target/Question below, no bold, no bullets) — variants are silently dropped.',
    ].filter(Boolean).join('\n\n')

    {
      councilDiag(`[council ${spec.id}] ${spec.opening} epoch 0: ${spec.seats.length} seats formulating`)
      const blindTurns = await generateParallel(ctx, parent, spec, {
        promptBuilder: seat => openingPrompt(seatPersona(spec, seat)),
        fibers, deny: true, epoch: 0, signal, params, deadSeats,
      })
      totalTokens += blindTurns.tokens
      runtime.tokens = totalTokens
      for (const t of blindTurns.turns) {
        audit.push(`opening: ${t.seatId} ${t.tokens}t`)
        lastActive.set(t.seatId, 0)
      }

      // Evidence requested during formulation is brokered BEFORE the ingest
      // pass (Oracle gate: blind-epoch requests were silently dropped).
      let openingBroker: BrokerResult | null = null
      if (params.evidenceBroker) {
        for (const t of blindTurns.turns) queue.push(extractEvidenceRequests(t.seatId, 1, t.text), vault)
        if (queue.size > 0) {
          openingBroker = await runBroker(queue.drain(), 1)
          audit.push(`opening broker: ${openingBroker.sheets} sheet(s)${openingBroker.missed.length > 0 ? ` — ${openingBroker.missed.length} missed (named; re-requested)` : ''}${openingBroker.excess.length > 0 ? ` — ${openingBroker.excess.length} excess sheet(s) beyond the batch (named on the round event)` : ''}`)
        }
      }

      // Dispute Ledger Ingest: the referee admits opening proposals (epoch 1).
      // Runs for BOTH opening modes — a 'open' spec must never reach the
      // deliberation loop over an empty ledger. Resilient: one retry, then a
      // no-op ingest (an empty ledger reaching epoch 2 terminates fast and
      // loud via the empty-ledger guard — never a hung run).
      ledger.setEpoch(1)
      const ingestInput = {
        spec,
        ledgerText: renderLedger(ledger, spec),
        roundTranscript: blindTurns.turns.map(t => `── ${t.seatId} ──\n${t.text.slice(0, MAX_SEAT_OUTPUT_CHARS)}`).join('\n\n'),
        vaultDeltaText: vault.all().length > 0 ? vault.render() : '',
        epoch: 1,
        previousDirectives: {},
        offlineSeats: [...deadSeats],
      }
      let ingest
      try {
        ingest = await runRefereePass(ctx, parent, ingestInput, ledger, signal, params.debaterTimeoutMs)
      } catch (firstErr) {
        if (signal.aborted) throw firstErr
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        councilDiag(`ingest referee pass failed (${firstMsg}) — retrying once`)
        try {
          ingest = await runRefereePass(ctx, parent, ingestInput, ledger, signal, params.debaterTimeoutMs)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          councilDiag(`ingest referee unavailable: ${msg} — no-op ingest`)
          audit.push(`ingest: referee unavailable (${msg}) — proceeding without admission`)
          noteReferee(`ingest: referee unavailable (${msg})`)
          ingest = {
            output: { admissions: [], flips: [], directives: {}, floor: { active: spec.seats.map(s => s.id), standby: [] }, scopeWarnings: [] },
            applied: { admissions: [], flips: [], rejected: [`ingest unavailable: ${msg}`] },
          }
        }
      }
      directives = ingest.output.directives
      floor = ingest.output.floor
      if (ingest.applied.rejected.length > 0) {
        noteReferee(`ingest rejected ${ingest.applied.rejected.length} ruling(s): ${ingest.applied.rejected.slice(0, 4).join('; ')}`)
      }
      trackFlipRun(runtime, ledger.flipsInEpoch(1) + ingest.applied.admissions.length, false)
      emitRound(1, {
        flips: ledger.flipsInEpoch(1),
        admissions: ingest.applied.admissions.length,
        applied: ingest.applied,
        phase: 'ingest',
        ...(openingBroker !== null ? { broker: brokerEvent(openingBroker) } : {}),
      })
      audit.push(`ingest: ${ingest.applied.admissions.length} admission(s)`)
    }

    // ── Epoch loop (deliberation epochs start at 2) ─────────────────────
    let epoch = 1
    let stopReason = 'max rounds reached'
    let challengeEpoch = -1
    let consolidationEpoch = -1

    const runStarted = Date.now()
    for (epoch = 2; epoch <= effectiveParams.defaultMaxRounds + 2; epoch++) {
      if (signal.aborted) throw new Error('council deliberation aborted')
      if (Date.now() - runStarted >= effectiveParams.runDeadlineMs) {
        stopReason = 'run deadline reached'
        audit.push(`run deadline (${Math.round(effectiveParams.runDeadlineMs / 60000)} min) reached at epoch ${epoch} — skipping to synthesis`)
        break
      }

      const isChallenge = challengeEpoch === epoch

      // Progress visibility during the silent generation window (reused seats
      // create no new catalog rows — without this marker the council looks
      // dead between rounds).
      try {
        parent.session.append('council/round', { epoch, council: spec.id, phase: 'generating', floor })
      } catch (err) { councilDiag(`epoch-start append failed: ${String(err)}`) }

      // 1. Context assembly + parallel seat generation (floor-gated).
      const ledgerText = renderLedger(ledger, spec)
      const round = await generateParallel(ctx, parent, spec, {
        // Cumulative epistemic package per seat (amendment #4): a standby
        // re-entrant receives EVERY vault fact added since it was last active.
        promptBuilder: (seat) => {
          const seatVault = vault.since(lastActive.get(seat.id) ?? 0)
          return [
          seatPersona(spec, seat),
          `EPOCH ${epoch}${isChallenge ? ' — FINAL CHALLENGE' : ''}`,
          `QUERY: ${query}`,
          briefText ? `LIVING BRIEF:\n${briefText}` : '',
          spec.scopeContract ? `SCOPE CONTRACT:\n${spec.scopeContract}` : '',
          `DISPUTE LEDGER:\n${ledgerText}`,
          seatVault.length > 0 ? `EVIDENCE (new since you last sat):\n${vault.render(seatVault)}` : '',
          directives[seat.id] ? `REFEREE DIRECTIVE TO YOU:\n${directives[seat.id]}` : '',
          isChallenge
            ? 'The deliberation has stabilized. State your strongest UNADDRESSED fatal flaw — with evidence — or emit CONCUR [entry-id] WITH <seat> to concede. Nothing else.'
            : buildEpochInstructions(spec),
          'NEED_EVIDENCE(target: <area>, question: <what to verify>) lines request facts for the next epoch boundary. This council has no shell and no file tools (run_code, bash, read/grep/glob are all denied here) — never attempt them.',
          'PROTOCOL LINE FORMATS (mechanically parsed — one line each, exactly): NEED_EVIDENCE(target: <area>, question: <what>) and PROPOSE_CRUX: <assertion>. Never reformat or decorate them — variants are dropped.',
        ].filter(Boolean).join('\n\n')
        },
        fibers,
        deny: false,
        epoch,
        signal,
        params,
        only: floor.active,
        deadSeats,
      })
      for (const t of round.turns) {
        if (t.error === undefined) lastActive.set(t.seatId, epoch)
      }
      totalTokens += round.tokens
      runtime.tokens = totalTokens

      // 2. Evidence extraction + broker flush (BEFORE the referee — amendment #3).
      let epochBroker: BrokerResult | null = null
      if (params.evidenceBroker) {
        for (const turn of round.turns) {
          queue.push(extractEvidenceRequests(turn.seatId, epoch, turn.text), vault)
        }
        if (queue.size > 0) {
          epochBroker = await runBroker(queue.drain(), epoch)
          audit.push(`epoch ${epoch}: broker served ${epochBroker.sheets} sheet(s)${epochBroker.missed.length > 0 ? ` (${epochBroker.missed.length} missed — named, re-request pending)` : ''}${epochBroker.excess.length > 0 ? ` (${epochBroker.excess.length} excess sheet(s) beyond the batch — named on the round event)` : ''}`)
        }
      }

      // 3. Referee pass (admission + flips + directives + next floor).
      // Resilient: one retry; a persistently dead referee makes the epoch
      // non-material instead of killing the debate (the ledger is unchanged,
      // so stagnation naturally steers the run to its end).
      ledger.setEpoch(epoch)
      const transcript = round.turns
        .map(t => `── ${t.seatId} ──\n${t.text.slice(0, MAX_SEAT_OUTPUT_CHARS)}`)
        .join('\n\n')
      const refereeInput = {
        spec,
        ledgerText: renderLedger(ledger, spec),
        roundTranscript: transcript,
        vaultDeltaText: (() => { const ev = vault.since(epoch); return ev.length > 0 ? vault.render(ev) : '' })(),
        epoch,
        previousDirectives: directives,
        offlineSeats: [...deadSeats],
      }
      let referee
      try {
        referee = await runRefereePass(ctx, parent, refereeInput, ledger, signal, params.debaterTimeoutMs)
      } catch (firstErr) {
        if (signal.aborted) throw firstErr
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        councilDiag(`[epoch ${epoch}] referee pass failed (${firstMsg}) — retrying once`)
        try {
          referee = await runRefereePass(ctx, parent, refereeInput, ledger, signal, params.debaterTimeoutMs)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          councilDiag(`[epoch ${epoch}] referee unavailable: ${msg}`)
          audit.push(`epoch ${epoch}: referee unavailable (${msg}) — epoch treated as non-material`)
          noteReferee(`epoch ${epoch}: referee pass failed twice (${msg})`)
          // A LOST referee output is a handoff failure, not a degraded epoch:
          // continuing would deliberate against a stale ledger with the epoch's
          // adjudication silently dropped. Stop the loop with the reason; the
          // chair prompt carries it in the REFEREE RECORD, and an empty ledger
          // fails loud at synthesis instead of producing an empty deliverable.
          if (err instanceof RefereeOutputError) {
            stopReason = `referee handoff failed at epoch ${epoch}: ${msg}`
            emitRound(epoch, { phase: 'referee-handoff-failed', error: msg, flips: 0, admissions: 0, offline: [...deadSeats] })
            break
          }
          directives = {}
          floor = { active: spec.seats.map(s => s.id).filter(id => !deadSeats.has(id)), standby: [] }
          trackFlipRun(runtime, 0, isChallenge)
          emitRound(epoch, { phase: 'referee-unavailable', error: msg, flips: 0, admissions: 0, offline: [...deadSeats] })
          if (isChallenge) {
            stopReason = 'referee unavailable during final challenge'
            break
          }
          // Fall through to the stopping evaluation with an unchanged ledger:
          // the empty-ledger and stagnation guards still steer the run to its
          // end (a dead referee must not burn every remaining epoch).
          const degradedVerdict = evaluate(ledger.state(), runtime, effectiveParams, terminalSet(spec))
          if (degradedVerdict.action === 'terminate') {
            stopReason = degradedVerdict.reason
            break
          }
          if (degradedVerdict.action === 'final-challenge') {
            challengeEpoch = epoch + 1
            audit.push(`epoch ${epoch}: stagnation → final challenge at epoch ${epoch + 1}`)
          }
          continue
        }
      }
      directives = referee.output.directives
      floor = referee.output.floor
      if (referee.applied.rejected.length > 0) {
        noteReferee(`epoch ${epoch} rejected ${referee.applied.rejected.length} ruling(s): ${referee.applied.rejected.slice(0, 4).join('; ')}`)
      }
      if (referee.output.scopeWarnings.length > 0) {
        noteReferee(`epoch ${epoch} scope warnings: ${referee.output.scopeWarnings.slice(0, 3).join('; ')}`)
      }

      // 4. Engine diff — materiality is ENGINE-computed (referee cannot lie).
      // Debate materiality = status flips; ideation materiality = admissions
      // (new ideas). Both are engine-counted from the ledger.
      const flips = ledger.flipsInEpoch(epoch)
      const admissions = referee.applied.admissions.length
      const material = flips + admissions
      trackFlipRun(runtime, material, isChallenge)

      emitRound(epoch, {
        flips,
        admissions,
        zeroFlipRun: runtime.zeroFlipRun,
        applied: referee.applied,
        scopeWarnings: referee.output.scopeWarnings,
        tokens: round.tokens,
        ...(epochBroker !== null ? { broker: brokerEvent(epochBroker) } : {}),
      })

      // 5. Stopping.
      if (epoch === consolidationEpoch) {
        stopReason = 'post-challenge consolidation complete'
        break
      }
      if (isChallenge) {
        const v = afterChallenge(material, runtime)
        if (v.action === 'terminate') {
          stopReason = v.reason
          break
        }
        // Exactly ONE consolidation epoch, then unconditional termination.
        // Skip evaluate() here: the stagnation counter is still ≥ the limit
        // (a challenge never resets it) and would kill the consolidation.
        consolidationEpoch = epoch + 1
        stopReason = 'post-challenge consolidation pending'
        continue
      }
      const verdict = evaluate(ledger.state(), runtime, effectiveParams, terminalSet(spec))
      if (verdict.action === 'terminate') {
        stopReason = verdict.reason
        break
      }
      if (verdict.action === 'final-challenge') {
        challengeEpoch = epoch + 1
        audit.push(`epoch ${epoch}: stagnation → final challenge at epoch ${epoch + 1}`)
      }
    }

    // ── Chair synthesis ─────────────────────────────────────────────────
    // Fail-loud handoff check FIRST: the chair's required inputs are the
    // dispute ledger and the evidence vault. With both empty there is nothing
    // to compile — a synthesized document would be a vacuous success
    // (2026-09-27: a lost referee output produced exactly that, forwarded as a
    // clean result). Stop with the reason instead.
    if (signal.aborted) throw new Error('council deliberation aborted')
    if (ledger.state().entries.length === 0 && vault.all().length === 0) {
      const record = refereeNotes.length > 0 ? ` Referee record: ${refereeNotes.slice(-4).join(' | ')}` : ''
      throw new CouncilHandoffError(
        `council produced no material for synthesis: the dispute ledger is empty and no evidence was collected`
        + ` (stop: ${stopReason}).${record}`,
      )
    }

    // Visible, bounded synthesis budget: the chair gets one event + one
    // timeout; a flail ends with this reason instead of a silent respawn.
    const chairBudgetMs = params.debaterTimeoutMs
    try {
      parent.session.append('council/round', {
        epoch, council: spec.id, phase: 'synthesis', budgetMs: chairBudgetMs, refereeNotes: refereeNotes.length,
      })
    } catch (err) { councilDiag(`synthesis append failed: ${String(err)}`) }
    audit.push(`synthesis: chair budget ${Math.round(chairBudgetMs / 1000)}s, ${refereeNotes.length} referee note(s)`)

    const refereeRecord = refereeNotes.join('\n').slice(0, MAX_REFEREE_RECORD_CHARS)
    // Resilient: one retry; a persistently dead OR invalid chair falls back to
    // a deterministic mechanical compilation of the ledger — the run NEVER
    // dies after the deliberation already happened, and the fallback reports
    // the failure instead of forwarding an unvalidated answer.
    let deliverable
    try {
      deliverable = await runChair(ctx, parent, spec, {
        query, ledger, vault, transcriptNote: briefStall, refereeRecord, signal, timeoutMs: chairBudgetMs,
        chairTemplate: opts.chairTemplate,
      })
    } catch (firstErr) {
      if (signal.aborted) throw firstErr
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      councilDiag(`chair pass failed (${firstMsg}) — retrying once`)
      audit.push(`chair attempt 1 failed (${firstMsg})`)
      try {
        deliverable = await runChair(ctx, parent, spec, {
          query, ledger, vault, transcriptNote: briefStall, refereeRecord, signal, timeoutMs: chairBudgetMs,
          chairTemplate: opts.chairTemplate,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        councilDiag(`chair unavailable: ${msg} — mechanical fallback`)
        audit.push(`chair unavailable (${msg}) — mechanical compilation`)
        deliverable = { text: mechanicalDeliverable(spec, ledger, vault, query, stopReason, msg), tokens: 0 }
      }
    }
    totalTokens += deliverable.tokens

    const quality = computeQuality(ledger, spec)
    try {
      parent.session.append('council/finished', { council: spec.id, stopReason, roundsRun: epoch, quality })
    } catch (err) { councilDiag(`council/finished append failed: ${String(err)}`) }

    return {
      deliverable: deliverable.text,
      roundsRun: epoch,
      stopReason,
      ledgerState: ledger.state(),
      vaultAdditions: vault.all().length,
      quality,
      totalTokens,
      audit,
    }
  } finally {
    // Fibers park (cascade interrupt handles user stops); explicit dispose is
    // best-effort for clean runs.
    try { await disposeSeatFibers(ctx, [...fibers.values()]) } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function seatPersona(spec: CouncilSpec, seatId: string): string {
  const seat = spec.seats.find(s => s.id === seatId)
  return seat?.persona ?? `You are the ${seatId} seat of the ${spec.label} council.`
}

function terminalSet(spec: CouncilSpec): Set<string> {
  return new Set(spec.ledgerKinds.flatMap(k => k.terminalStatuses))
}

function buildEpochInstructions(spec: CouncilSpec): string {
  if (spec.forestMode) {
    return [
      'Extend the idea forest: SPROUT new directions, BRANCH variants, FUSE existing ideas, mark TENSION where reality bites an idea.',
      'Nothing is ever deleted; divergence is the goal. One idea per line: SPROUT: <title> | <rationale>.',
    ].join(' ')
  }
  return [
    `Argue your assigned crux. Allowed actions: ${spec.actions.join(', ')}.`,
    spec.steelman
      ? 'MANDATORY STEELMAN: before attacking an opponent\'s position, include `STEELMAN [<seat>]:` reconstructing it at its strongest and naming the boundary where it is correct. Attacks without steelman are ruled invalid.'
      : '',
    'Reference ledger entries by id. Propose new decisive points with PROPOSE_CRUX: <assertion>.',
  ].filter(Boolean).join(' ')
}

function renderLedger(ledger: Ledger, spec: CouncilSpec): string {
  const s = ledger.state()
  if (s.entries.length === 0 && s.edges.length === 0) return '(empty — no entries admitted yet)'
  const terminal = new Set(spec.ledgerKinds.flatMap(k => k.terminalStatuses))
  const lines = s.entries.map(e => {
    const mark = terminal.has(e.status) ? '✔' : '○'
    const ev = e.evidenceRef ? ` [${e.evidenceRef}]` : ''
    return `${mark} ${e.id} (${e.kind}, ${e.status}${e.birthEpoch === s.epoch ? ', NEW' : ''})${ev}: ${e.assertion}`
  })
  const edgeLines = s.edges.map(e => `${e.op} ${e.from ?? '∅'} → ${e.to} (epoch ${e.epoch}, ${e.seat})`)
  return [...lines, ...edgeLines].join('\n')
}

interface GenerateArgs {
  promptBuilder: (seatId: string) => string
  fibers: Map<string, SeatFiber>
  deny: boolean
  epoch: number
  signal: AbortSignal
  params: CouncilParams
  only?: string[]
  deadSeats: Set<string>
}

/** Parallel seat generation over the current floor (spawn epoch 0+1, followup after). */
/**
 * The seat deny list for one run: the static base plus every enabled council's
 * tool id, so a seat can never invoke another council (settings-registered
 * councils included). A registry read failure must never fail a debate — the
 * static list stands.
 */
function seatDenyList(ctx: Context): string[] {
  try {
    return councilDenyList(
      loadCouncilRegistry(ctx).entries.filter(entry => entry.enabled).map(entry => String(entry.id)),
    )
  } catch {
    return councilDenyList([])
  }
}

async function generateParallel(
  ctx: Context,
  parent: Agent,
  spec: CouncilSpec,
  args: GenerateArgs,
): Promise<{ turns: SeatTurn[]; tokens: number }> {
  const denyTools = seatDenyList(ctx)
  const seats = (args.only ?? spec.seats.map(s => s.id))
    .filter(id => !args.deadSeats.has(id))
    .map(id => spec.seats.find(s => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)

  const tasks = seats.map(async (seat): Promise<SeatTurn> => {
    const prompt = args.promptBuilder(seat.id)
    const existing = args.fibers.get(seat.id)
    let fiber: SeatFiber
    let attempt = 0
    let lastError: Error | null = null
    // Chain snapshot at seat start (doc 60): the persona's link list is frozen
    // for this generation — never re-read between attempts — and a chain
    // assigned mid-run applies on the next spawn (like personas).
    const seatChain = resolvePersonaChain(ctx, seat.id)
    let linkIndex = 0
    const maxAttempts = seatChain !== undefined ? Math.max(2, seatChain.links.length) : 1 + Math.min(2, 1)
    while (attempt < maxAttempts) {
      attempt++
      try {
        // A known-offline fiber is replaced immediately (Oracle gate #3):
        // following up on a dead child burns a 30s activation-lock wait.
        if (existing !== undefined && existing.isOffline && args.fibers.get(seat.id) === existing) {
          args.fibers.delete(seat.id)
        }
        const current = args.fibers.get(seat.id)
        if (current === undefined || attempt > 1) {
          // fresh fiber (first turn, retry after a dead fiber, or chain advance)
          const link = seatChain === undefined
            ? undefined
            : seatChain.links[Math.min(linkIndex, seatChain.links.length - 1)]
          fiber = await startSeatFiber(ctx, parent, {
            seatId: seat.id,
            label: `${spec.id} seat: ${seat.id}`,
            persona: seat.persona,
            initialPrompt: prompt,
            denyTools,
            ...(link !== undefined ? { model: link } : {}),
            // Carry the group id whenever the spawned link is one of the
            // chain's own (the fork starts at the request's named link, then
            // escalates internally). Skipped only for the exotic case of a
            // persona active link that the chain does not declare.
            ...(seatChain !== undefined && (linkIndex > 0 || seatChain.carryId) ? { chainId: seatChain.id } : {}),
          }, args.signal)
          args.fibers.set(seat.id, fiber)
        } else {
          fiber = current
          await followupSeatFiber(ctx, parent, fiber, prompt, args.signal)
        }
        let turn = await waitForSeatTurnDetailed(ctx, fiber.childId, args.signal, args.params.debaterTimeoutMs)
        // Auto-continue a turn the provider cut at the output-token cap: a
        // truncated seat position silently degrades the referee's reading.
        // Bounded resumes on the SAME link; a chain whose policy is `failover`
        // (the default) advances to the NEXT link instead — restart, not resume.
        let resumes = 0
        while (turn.truncated && resumes < 2 && !args.signal.aborted) {
          if (seatChain !== undefined && seatChain.onCut === 'failover' && linkIndex + 1 < seatChain.links.length) {
            throw new Error(`seat output cut at the output-token cap — advancing to chain link ${linkIndex + 2}`)
          }
          resumes += 1
          councilDiag(`[epoch ${args.epoch}] seat ${seat.id} hit the output-token cap — resuming (${resumes}/2)`)
          await followupSeatFiber(ctx, parent, fiber, 'Your reply was cut at the output-token limit. Continue EXACTLY where you stopped — do not repeat or restate anything. Complete your turn.', args.signal)
          const next = await waitForSeatTurnDetailed(ctx, fiber.childId, args.signal, args.params.debaterTimeoutMs)
          turn = { text: `${turn.text}\n\n${next.text}`, truncated: next.truncated }
        }
        const text = turn.text
        const tokens = estimateTokens(text)
        fiber.totalTokens += tokens
        return { seatId: seat.id, text, tokens }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        councilDiag(`[epoch ${args.epoch}] seat ${seat.id} attempt ${attempt} failed: ${lastError.message}`)
        if (args.signal.aborted) throw lastError
        // Chain failover: this failure (timeout/error/cut) advances the seat to
        // the NEXT link from the start-of-seat snapshot. The dead fiber is
        // dropped so the next attempt spawns fresh on that link.
        const nextLink = seatChain?.links[linkIndex + 1]
        if (seatChain !== undefined && nextLink !== undefined) {
          const failed = seatChain.links[Math.min(linkIndex, seatChain.links.length - 1)]!
          process.stderr.write(`[model-chain] ${seatChain.id}: link ${linkIndex + 1} (${failed.provider}/${failed.model}) FAILED → link ${linkIndex + 2} (${nextLink.provider}/${nextLink.model}): ${lastError.message}\n`)
          linkIndex += 1
          args.fibers.delete(seat.id)
          if (attempt >= maxAttempts) break
          await new Promise(r => setTimeout(r, 500))
          continue
        }
        if (attempt >= maxAttempts) break
        await new Promise(r => setTimeout(r, 500))
      }
    }
    const fiberState = args.fibers.get(seat.id)
    if (fiberState !== undefined) fiberState.isOffline = true
    // Retire the seat for the rest of the run: even the fresh respawn died,
    // so re-spawning every epoch would only churn sessions (the operator-
    // observed 6× skeptic). Quorum rules decide whether the run continues.
    args.deadSeats.add(seat.id)
    return {
      seatId: seat.id,
      text: `[SEAT ERROR: ${seat.id} failed: ${lastError?.message ?? 'deliberation failed'}]`,
      tokens: 0,
      error: lastError?.message ?? 'deliberation failed',
    }
  })

  const settled = await Promise.allSettled(tasks)
  const turns: SeatTurn[] = []
  let tokens = 0
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      turns.push(r.value)
      tokens += r.value.tokens
    } else {
      turns.push({ seatId: 'unknown', text: `[SEAT ERROR: ${String(r.reason)}]`, tokens: 0, error: String(r.reason) })
    }
  }

  // Quorum (doc 38): < quorumFraction responding → fail loud with per-seat detail.
  const online = turns.filter(t => t.error === undefined).length
  // Quorum (Oracle gate #4): zero responders ALWAYS fails; the fraction is
  // computed against the actual floor size (no >=3 bypass — a 2-seat floor
  // still enforces quorum).
  if (seats.length === 0 || online === 0 || online / seats.length < params2Quorum(args.params)) {
    const details = turns.filter(t => t.error !== undefined).map(t => `${t.seatId}: ${t.error}`).join('; ')
    throw new Error(`Council failed quorum: only ${online}/${seats.length} seats responded (required ${(args.params.quorumFraction * 100).toFixed(0)}%). Errors: ${details}`)
  }
  return { turns, tokens }
}

function params2Quorum(p: CouncilParams): number {
  return p.quorumFraction
}

async function runChair(
  ctx: Context,
  parent: Agent,
  spec: CouncilSpec,
  input: {
    query: string
    ledger: Ledger
    vault: EvidenceVault
    transcriptNote: string
    /** Bounded record of referee rejections/failures the ledger cannot show. */
    refereeRecord?: string
    signal: AbortSignal
    timeoutMs: number
    chairTemplate?: DeclarativeCouncilSpec['chairTemplate']
  },
): Promise<{ text: string; tokens: number }> {
  const sections = spec.deliverableSections.join(', ')
  const ledgerText = renderLedger(input.ledger, spec)
  const evidenceText = input.vault.render()
  const defaultPrompt = [
    `COUNCIL: ${spec.label}`,
    `QUERY: ${input.query}`,
    `FINAL LEDGER:\n${ledgerText}`,
    `EVIDENCE VAULT:\n${evidenceText}`,
    input.refereeRecord ? `REFEREE RECORD (rejections/failures the ledger cannot show — report them, do not invent around them):\n${input.refereeRecord}` : '',
    input.transcriptNote ? `NOTE: some evidence requests failed (${input.transcriptNote}) — reflect uncertainty where it matters.` : '',
    `Compile the final ${spec.label} deliverable with EXACTLY these sections: ${sections}.`,
    'Zero data loss: every ledger entry and its disposition must be reflected. Falsified paths appear with their refutations. Dissents are preserved verbatim in spirit.',
    'Every required section must carry real content from the ledger, the vault, or the referee record. If a section has nothing to report, say exactly why — never pad with an empty template.',
    'Output the deliverable document only — no meta commentary.',
  ].filter(Boolean).join('\n\n')
  const persona = input.chairTemplate?.systemPrompt
    ?? `You are the Chair of the ${spec.label} council. You compile the final deliverable from the dispute ledger with zero data loss. You write only the deliverable document. Do not call any tools: you have no shell and no file access, and searching the filesystem for missing data is forbidden — report what the ledger and vault contain.`
  const prompt = input.chairTemplate === undefined
    ? defaultPrompt
    : fillChairTemplate(input.chairTemplate.userPromptTemplate, {
      label: spec.label,
      query: input.query,
      ledger: ledgerText,
      evidence: evidenceText,
      sections,
      note: input.transcriptNote,
      referee: input.refereeRecord ?? '',
    })

  const denyTools = seatDenyList(ctx)
  let fiber: { childId: string } | undefined
  try {
    fiber = await startSeatFiber(ctx, parent, {
      seatId: 'chair',
      label: `council chair: ${spec.id}`,
      persona,
      initialPrompt: prompt,
      denyTools,
    }, input.signal)
    const chairTurn = await waitForSeatTurnDetailed(ctx, fiber.childId, input.signal, input.timeoutMs)
    // Structured output validation: a chair answer missing a required section
    // (or carrying an empty one) is a REPORTED failure — retried by the engine,
    // then replaced by the mechanical compilation. It is never forwarded as-is.
    const validation = validateChairDeliverable(chairTurn.text, spec.deliverableSections)
    if (!validation.ok) {
      const excerpt = chairTurn.text.replace(/\s+/g, ' ').trim().slice(0, 160)
      throw new ChairOutputError(validation.missing, excerpt)
    }
    return { text: chairTurn.text, tokens: estimateTokens(chairTurn.text) }
  } finally {
    if (fiber !== undefined) {
      try { await disposeSeatFibers(ctx, [fiber]) } catch { /* best effort */ }
    }
  }
}

/**
 * Substitute the documented chair-template placeholders (`{{label}}`,
 * `{{query}}`, `{{ledger}}`, `{{evidence}}`, `{{sections}}`, `{{note}}`,
 * `{{referee}}`).
 * Unknown placeholders stay verbatim; a template without placeholders is used
 * as-is.
 * @param template - the registered `chairTemplate.userPromptTemplate`.
 * @param vars - placeholder values.
 * @returns the synthesis prompt sent to the chair.
 */
function fillChairTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, name: string) => vars[name] ?? match)
}

/**
 * Deterministic zero-LLM compilation used when the Chair is unavailable:
 * every ledger entry with its disposition and evidence reference, the vault
 * summary, and the stopping reason. Worse prose than the Chair, but NOTHING
 * is lost — the run always returns a deliverable.
 */
function mechanicalDeliverable(spec: CouncilSpec, ledger: Ledger, vault: EvidenceVault, query: string, stopReason: string, failure?: string): string {
  const s = ledger.state()
  const sections = spec.deliverableSections
  const lines: string[] = [
    `# ${spec.label} Deliverable (mechanical compilation — chair unavailable)`,
    '',
    `Query: ${query}`,
    `Stop: ${stopReason}`,
    ...(failure !== undefined && failure.trim() !== '' ? [`Compilation note: chair failure reported — ${failure.replace(/\s+/g, ' ').trim()}`] : []),
    '',
    '## Ledger Dispositions',
    ...s.entries.map(e => `- **${e.id}** (${e.kind}, ${e.status}) — ${e.assertion}${e.evidenceRef ? ` [evidence: ${e.evidenceRef}]` : ''}`),
    '',
  ]
  if (sections.length > 0) {
    lines.push(`_Intended sections: ${sections.join(', ')}._`)
    lines.push('')
  }
  const facts = vault.all()
  lines.push('## Evidence Vault', ...(facts.length > 0
    ? facts.map(f => `- [${f.id}] (${f.retrievedBy}, ${f.citation}): ${f.factSheet.split('\n')[0]}`)
    : ['- (no evidence collected)']))
  return lines.join('\n')
}

function computeQuality(ledger: Ledger, spec: CouncilSpec): CouncilRuntimeResult['quality'] {
  const s = ledger.state()
  const terminal = new Set(spec.ledgerKinds.flatMap(k => k.terminalStatuses))
  const cruxLike = s.entries
  const resolved = cruxLike.filter(e => terminal.has(e.status)).length
  const invariants = cruxLike.filter(e => e.status === 'invariant' && e.evidenceRef !== null).length
  const contested = cruxLike.filter(e => e.status === 'contested')
  const flippedFromOpen = cruxLike.filter(e => e.history.some(h => h.from === 'open' && h.to === 'contested')).length
  return {
    cruxResolutionRatio: cruxLike.length > 0 ? resolved / cruxLike.length : null,
    adversarialSurvivability: cruxLike.length > 0 ? flippedFromOpen / cruxLike.length : null,
    invariantDensity: invariants,
    // Forest mode: idea count is the volume signal (the edge graph is v2).
    newClusters: spec.forestMode ? cruxLike.filter(e => e.kind === 'idea').length : null,
  }
}
