/**
 * Evidence Broker — the errand boy's door (doc 54 §6, §13 amendments 2–4).
 *
 * Seats embed NEED_EVIDENCE lines in their turn output (text protocol — no
 * child-scope tool registration needed):
 *     NEED_EVIDENCE(target: <area>, question: <what to verify>)
 * The engine extracts them, dedupes against the queue and the vault, and at
 * the epoch boundary dispatches research children (explorer for codebase
 * targets, librarian for external ones) IN PARALLEL. Fact sheets (≤200 tokens,
 * cited) commit to the vault BEFORE the referee pass runs (amendment #3).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import {
  BROKER_KEPT_TOOLS,
  COUNCIL_DENIED_TOOLS,
  COUNCIL_KEPT_TOOLS,
  councilDiag,
  disposeSeatFibers,
  estimateTokens,
  followupSeatFiber,
  startSeatFiber,
  waitForSeatTurn,
} from './fiber.ts'
import type { EvidenceVault } from './vault.ts'

export interface EvidenceRequest {
  ticket: string
  seatId: string
  target: string
  question: string
  epoch: number
}

/** Extract NEED_EVIDENCE lines from a seat turn. Tolerant to formatting drift. */
/**
 * Remove the stylistic dressing models add around protocol lines — bullets,
 * bold pairs, backticks, trailing prose. The semantic tokens stay verbatim.
 */
function undecorate(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

export function extractEvidenceRequests(seatId: string, epoch: number, turnText: string): EvidenceRequest[] {
  const out: EvidenceRequest[] = []
  const seen = new Set<string>()
  const push = (target: string, question: string) => {
    target = target.trim()
    question = question.trim()
    if (target.length === 0 || question.length === 0) return
    const ticket = fpTicket(target, question)
    if (seen.has(ticket)) return
    seen.add(ticket)
    out.push({ ticket, seatId, target, question, epoch })
  }
  const strip = (v: string) => v.trim().replace(/^[`"'(\s]+/, '').replace(/[`"')\s.,;]+$/, '').trim()
  const lines = turnText.split(/\n/).map(undecorate)

  // Form 1 — inline: NEED_EVIDENCE(target: X, question: Y)
  for (const line of lines) {
    const m = line.match(/NEED_EVIDENCE\s*\(?\s*target\s*[:=]\s*(.+?)\s*,\s*question\s*[:=]\s*(.+)$/i)
    if (m === null) continue
    push(strip(m[1]), strip(m[2]))
  }

  // Form 2 — block: NEED_EVIDENCE (own line) with Target:/Question: lines
  // following within a few lines (models split the fields across lines).
  for (let i = 0; i < lines.length; i++) {
    if (!/^NEED_EVIDENCE\b/i.test(lines[i]) || /target\s*[:=]/i.test(lines[i])) continue
    let target: string | undefined
    let question: string | undefined
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const t = lines[j].match(/^target\s*[:=]\s*(.+)$/i)
      const q = lines[j].match(/^question\s*[:=]\s*(.+)$/i)
      if (t !== null && target === undefined) target = strip(t[1])
      if (q !== null && question === undefined) question = strip(q[1])
      if (target !== undefined && question !== undefined) break
    }
    if (target !== undefined && question !== undefined) push(target, question)
  }
  return out
}

function fpTicket(target: string, question: string): string {
  return 'EV-' + createHash('sha256').update(`${target}::${question}`.toLowerCase()).digest('hex').slice(0, 8)
}

/** Queue with per-run dedupe (same target+question from any seat = one dispatch). */
export class EvidenceQueue {
  private readonly pending = new Map<string, EvidenceRequest>()

  push(reqs: EvidenceRequest[], vault: EvidenceVault): EvidenceRequest[] {
    const added: EvidenceRequest[] = []
    for (const req of reqs) {
      if (this.pending.has(req.ticket)) continue
      // Vault already answered this exact question earlier in the run.
      if (vault.all().some(e => e.question.toLowerCase() === req.question.toLowerCase() && e.supersededBy === null)) continue
      this.pending.set(req.ticket, req)
      added.push(req)
    }
    return added
  }

  drain(): EvidenceRequest[] {
    const all = [...this.pending.values()]
    this.pending.clear()
    return all
  }

  get size(): number {
    return this.pending.size
  }
}

const BROKER_PERSONA = [
  'You are the Council Evidence Broker — a precision research assistant serving a high-stakes deliberation.',
  'You answer EXACTLY the questions asked, from the codebase (read/glob/grep) or the web (web_search), and nothing else.',
  'You may receive MULTIPLE questions. Answer each in order, one FACT SHEET per question, in this exact format:',
  'SHEET 1',
  'CITATION: the ACTUAL file path with line number, or the exact URL you read. Never a placeholder, never a template — a real path you personally opened.',
  'FACTS: the answer, maximum 150 words, only what the question asked.',
  'CONFIDENCE: high | medium | low — one word',
  'SHEET 2',
  '...',
  'Never speculate. If an answer is not findable, its FACTS say "NOT FINDABLE" and the CITATION shows the closest place you looked.',
  'The run_code tool is non-functional in this deployment — never call it.',
].join('\n')

function isExternalTarget(target: string): boolean {
  return /\b(web|http|npm|docs?|library|libraries|package|registry|external|api)\b/i.test(target)
}

/** One evidence request the broker child failed to answer with a parseable sheet. */
export interface BrokerMiss {
  req: EvidenceRequest
  /** Named cause + received excerpt (the caller turns this into the next action). */
  reason: string
}

/** A fact sheet the broker produced beyond the requested queue length. */
export interface BrokerExcess {
  /** 1-based SHEET number the broker used in its reply. */
  sheet: number
  /** Named reason + content excerpt — a discard is never silent. */
  reason: string
}

export interface BrokerResult {
  sheets: number
  errors: string[]
  /**
   * Requests that produced no parseable sheet. The caller MUST NOT drop these:
   * it re-queues them (bounded) and, at the bound, commits a named
   * RETRIEVAL FAILED vault sheet — evidence is never silently absent.
   */
  missed: BrokerMiss[]
  /**
   * Sheets the broker emitted beyond the requested batch (queue length). They
   * have no matching request; each one is named (sheet number + content
   * excerpt) so the caller can surface the drop instead of swallowing it.
   */
  excess: BrokerExcess[]
  /** Which role served the batch (used by the caller for failure placeholders). */
  retrievedBy: 'explorer' | 'librarian'
}

/**
 * Service the queue: one research child PER REQUEST, in parallel (they are
 * independent), fact sheets into the vault. Runs at the epoch boundary,
 * before the referee (amendment #3).
 */
export async function serviceEvidenceQueue(
  ctx: Context,
  parent: Agent,
  queue: EvidenceRequest[],
  vault: EvidenceVault,
  epoch: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<BrokerResult> {
  if (queue.length === 0) return { sheets: 0, errors: [], missed: [], excess: [], retrievedBy: 'explorer' }
  const errors: string[] = []
  const missed: BrokerMiss[] = []
  // Per-question budget: a batched child runs one research pass per question,
  // so the wait scales with the queue (a fixed timeout cut off 10-question
  // batches mid-flight — the operator-observed "we continued without the
  // broker"). Quality-first: generous, not stingy.
  const waitMs = Math.max(timeoutMs, queue.length * 90_000)
  councilDiag(`[broker] servicing ${queue.length} evidence request(s) at epoch ${epoch} (batched: one child, wait ${Math.round(waitMs / 1000)}s)`)

  // Batch mode: ONE research child answers the whole queue (one session per
  // epoch instead of one per question — shared research context, fewer spawns).
  const hasExternal = queue.some(req => isExternalTarget(req.target))
  const retrievedBy = hasExternal ? 'librarian' as const : 'explorer' as const
  const prompt = [
    `Answer ${queue.length} question${queue.length > 1 ? 's' : ''}. One FACT SHEET per question, numbered in order (SHEET 1 … SHEET ${queue.length}).`,
    ...queue.map((req, i) => `SHEET ${i + 1} — TARGET: ${req.target} — QUESTION: ${req.question}`),
    'Produce the fact sheets now.',
  ].join('\n\n')

  let fiber: { childId: string } | undefined
  try {
    fiber = await startSeatFiber(ctx, parent, {
      seatId: retrievedBy,
      label: queue.length === 1 ? `council broker: ${queue[0].ticket}` : `council broker: ${queue.length} questions (epoch ${epoch})`,
      persona: BROKER_PERSONA,
      initialPrompt: prompt,
      // Broker keeps the research surface; everything else stays denied, and
      // the shared whiteboard survives every tier (COUNCIL_KEPT_TOOLS).
      denyTools: COUNCIL_DENIED_TOOLS
        .filter(t => !(BROKER_KEPT_TOOLS as readonly string[]).includes(t))
        .filter(t => !(COUNCIL_KEPT_TOOLS as readonly string[]).includes(t)),
    }, signal)
    const text = await waitForSeatTurn(ctx, fiber.childId, signal, timeoutMs)
    const parsed = parseFactSheets(text)
    const excerpt = clip(text.replace(/\s+/g, ' ').trim(), 140)
    let committed = 0
    for (let i = 0; i < queue.length; i++) {
      const sheet = parsed[i]
      if (sheet === undefined) {
        const req = queue[i]
        const reason = `broker returned no parseable fact sheet ${i + 1}/${queue.length} for "${clip(req.question, 90)}"`
          + ` (reply carried no SHEET block: ${text.length} chars, "${excerpt}")`
        errors.push(`${req.ticket}: ${reason}`)
        missed.push({ req, reason })
        // Name the failure loudly; the caller re-requests or commits a
        // RETRIEVAL FAILED sheet — this is never a silent drop.
        councilDiag(`[broker] ${req.ticket} MISSED sheet ${i + 1}/${queue.length}: ${reason}`)
        continue
      }
      vault.add({
        citation: sheet.citation,
        question: queue[i].question,
        factSheet: `${sheet.facts}\nCONFIDENCE: ${sheet.confidence}`,
        addedEpoch: epoch,
        retrievedBy,
      })
      committed += 1
      councilDiag(`[broker] ${queue[i].ticket} satisfied via ${retrievedBy} (${sheet.citation})`)
    }
    // Sheets beyond the requested batch have no matching request. Name each
    // one (sheet number + excerpt) instead of dropping it without a word.
    const excess: BrokerExcess[] = []
    for (let i = queue.length; i < parsed.length; i++) {
      const sheet = parsed[i]
      if (sheet === undefined) continue
      const reason = `SHEET ${i + 1} exceeds the requested batch of ${queue.length} — no matching evidence request, so the sheet is dropped: "${clip(sheet.facts, 90)}"`
      errors.push(`excess sheet ${i + 1}/${queue.length}: ${reason}`)
      excess.push({ sheet: i + 1, reason })
      councilDiag(`[broker] ${reason}`)
    }
    return { sheets: committed, errors, missed, excess, retrievedBy }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    for (const req of queue) {
      errors.push(`${req.ticket}: broker batch failed: ${msg}`)
      missed.push({ req, reason: `broker batch failed: ${msg}` })
    }
    councilDiag(`[broker] batch FAILED: ${msg}`)
    return { sheets: 0, errors, missed, excess: [], retrievedBy }
  } finally {
    if (fiber !== undefined) {
      try { await disposeSeatFibers(ctx, [fiber]) } catch { /* best effort */ }
    }
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/** Parse ONE fact sheet (single-question responses). */
export function parseFactSheet(text: string): { citation: string; facts: string; confidence: string } | null {
  return parseFactSheets(text)[0] ?? null
}

/**
 * Split a broker reply at its numbered `SHEET n` headers, keeping the header
 * with its block. Returns [] when no numbered header exists.
 */
function splitBySheetMarkers(plain: string): Array<{ index: number; block: string }> {
  const marker = /^[^\S\n]*(?:[>#*+_-]+[^\S\n]*)*SHEET[^\S\n]+(\d+)\b[^\n]*$/gim
  const found: Array<{ index: number; start: number }> = []
  for (let m = marker.exec(plain); m !== null; m = marker.exec(plain)) {
    found.push({ index: Number(m[1]), start: m.index })
  }
  return found.map((entry, i) => ({
    index: entry.index,
    block: plain.slice(entry.start, found[i + 1]?.start ?? plain.length),
  }))
}

/**
 * Parse a (possibly multi-sheet) broker response into ordered fact sheets.
 *
 * Primary shape: numbered `SHEET n` blocks — a sheet the child numbered is
 * never lost just because its CITATION line drifted. Sheets are placed by
 * their own number, so a missing sheet leaves an explicit hole (undefined)
 * the caller reports by name instead of silently shifting answers.
 * Fallback shape (no markers): split at CITATION lines, in order.
 */
export function parseFactSheets(text: string): Array<{ citation: string; facts: string; confidence: string } | undefined> {
  // Tolerate markdown bolding (**CITATION:** etc.) before matching.
  const plain = text.replace(/\*\*/g, '')
  const marked = splitBySheetMarkers(plain)
  const results: Array<{ citation: string; facts: string; confidence: string } | undefined> = []
  if (marked.length > 0) {
    for (const { index, block } of marked) {
      const sheet = parseOneSheet(block)
      if (sheet !== null) results[index - 1] = sheet
    }
    return results
  }
  const parts = plain.split(/(?=CITATION\s*[:=])/i).filter(p => /CITATION\s*[:=]/i.test(p))
  for (const part of parts) {
    const sheet = parseOneSheet(part)
    if (sheet !== null) results.push(sheet)
  }
  return results
}

function parseOneSheet(text: string): { citation: string; facts: string; confidence: string } | null {
  const plain = text.replace(/\*\*/g, '')
  const rawCitation = plain.match(/CITATION\s*[:=]\s*(.+)/i)?.[1]?.trim()
  const facts = plain.match(/FACTS\s*[:=]\s*([\s\S]*?)(?:CONFIDENCE\s*[:=]|$)/i)?.[1]?.trim()
  const confidence = plain.match(/CONFIDENCE\s*[:=]\s*(high|medium|low)/i)?.[1]?.toLowerCase()
  // FACTS is the only irreducible part of a sheet. A missing CITATION is
  // degraded to explicit unverified (the question still gets an answer), but
  // a block with no FACTS is not a sheet at all.
  if (!facts) return null
  if (!rawCitation) return { citation: 'unverified (broker omitted citation)', facts, confidence: confidence ?? 'low' }
  // Placeholder citations (the model echoed the template) degrade to explicit
  // unverified instead of poisoning the vault with fake precision.
  const placeholder = /<file:line|url\s*—|— exact>|your citation/i.test(rawCitation)
  const citation = placeholder ? 'unverified (broker echoed template)' : rawCitation
  return { citation, facts, confidence: placeholder ? 'low' : (confidence ?? 'medium') }
}

/** Unused import guard: followupSeatFiber is reserved for broker re-queries (v2). */
void followupSeatFiber
