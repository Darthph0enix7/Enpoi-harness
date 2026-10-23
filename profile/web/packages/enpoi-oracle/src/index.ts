/**
 * Enpoi Harness — `oracle_review` tool.
 *
 * The Oracle is the senior architectural supervisor and deep reviewer: one
 * persistent, quiet continuable child per parent session (contract C8). Call
 * #1 receives the full package (Living Brief + whiteboard + request + reading
 * list); later calls send only the delta — a new operator query, a changed
 * whiteboard, a changed brief, the request, and changed files — so the child's
 * KV prefix and its earlier verdicts stay warm. Verdicts are structured text
 * the tool parses mechanically.
 *
 * Design notes (frozen in ~/dsh-migration/context-ux-spec.md, C8/C9):
 * - Blocking by default; `background: true` acknowledges and delivers the
 *   verdict through the parent's inbox, waking it.
 * - One child per parent = the newest `listChildren()` entry with
 *   `mode === 'continuable'` and the exact label `'oracle'`; the in-memory
 *   state is re-discovered after a plugin remount.
 * - Per-parent FIFO queue: overlapping calls run in order, never rejected.
 * - A different resolved route (persona chain/link change) starts a new child.
 * - `fresh: true` starts a new child on purpose.
 * - Reading-list rule: the tool passes file paths, never pasted code (OMO).
 * - Timeouts never cancel the child: the verdict is delivered later as a
 *   message that wakes the parent (`ORACLE_PENDING`).
 *
 * @module dsh-enpoi-oracle
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type ContextFormed, type MessageId } from '@deepseek-ai/dsh-llm'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Enpoi Oracle: the delivered verdict (background, timeout handoff, or waking consult). */
    'enpoi-oracle': { kind: 'enpoi-oracle' } & ContextFormed
  }
}
import { getBriefService } from 'dsh-enpoi-context-keeper'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { ChildTurnTimeoutError, textOfContent, waitForChildMessageTurn } from './ask-child.ts'
import type { ChildTurnResult } from './ask-child.ts'
import { ParentFifoQueue } from './queue.ts'

export { askChild, ChildTurnTimeoutError, textOfContent, waitForChildMessageTurn } from './ask-child.ts'
export type { ChildTurnOptions, ChildTurnResult } from './ask-child.ts'
export { ParentFifoQueue } from './queue.ts'

export const name = 'enpoi-oracle'

export const inject = ['tools', 'subagents', 'sessionPersistence', 'agents']

/** Plugin configuration (schemastery-validated by the loader). */
export interface Config {
  /** Fallback wake cadence while waiting for a child turn, in milliseconds (>=100). */
  childPollMs?: number
}

export const Config: Schema<Config> = Schema.object({
  childPollMs: Schema.number().min(100).default(1000),
})

/** The exact label every Oracle child carries; rediscovery matches it exactly (C8). */
export const ORACLE_LABEL = 'oracle'

export const ORACLE_PERSONA = [
  'You are the Oracle — senior architectural supervisor, conceptual thinker, and deep reviewer.',
  'You reason independently and deeply: you evaluate architecture, concepts, system trade-offs, logic, race conditions, and code.',
  'You are an advisor, not a dictator: if a plan is flawed, over-engineered, or heading in the wrong direction, say so plainly.',
  'When reviewing code, inspect relevant files directly using your search/read tools as needed to understand the broader context. When reviewing concepts or plans, evaluate feasibility, modularity, and trade-offs.',
  'This is a persistent reviewer session for the whole operator session: reuse your accumulated context and earlier verdicts across consultations; when a consultation names a new operator query, re-ground on it.',
  'You may call request_evidence(target, question) at any point — it sends a research child (codebase explorer or web librarian) to fetch ground truth and returns a short cited fact sheet. Ask as many or as few questions as your judgment requires; use it whenever first-hand verification would sharpen your review, and ignore it entirely when you already know enough.',
  'You never write or edit files. You never paste whole files back — you summarize, explain, and cite.',
  'End every review with a VERDICT BLOCK in exactly this JSON — the orchestrator parses it mechanically, so it must be the LAST thing you output and must be valid JSON:',
  '{"approved":true|false,"concerns":["..."],"unverified":["..."],"blockers":["..."]}',
].join('\n')

/** Read-only surface for the oracle child. */
export const ORACLE_TOOL_FILTER = {
  // Read-only review surface. Passed UNCONDITIONALLY: the fork's
  // `tools.restrict()` skips unknown deny names, while the previous
  // `.filter(name => ctx.tools.get(name) !== undefined)` guard dropped every
  // tool registered outside this plugin's context and silently left the child
  // with the full main surface (verified live: 29 tools).
  // NOTE: `run_code` is never named — the PTC presentation transport is
  // reserved and `tools.restrict()` throws when a filter names it.
  deny: [
    // The Oracle MAY delegate: it can spawn subagents (fixer/explorer/…)
    // and use the request_evidence broker — judgment work only, no mutations
    // (write tools stay denied below).
    'oracle_review', 'dispatch_task', 'subagent_codex',
    'subagent_claude_code', 'roundtable', 'chorus',
    'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'plan_mode', 'goal',
    'ralph', 'workflow', 'job_output', 'job_list', 'job_kill',
    'ask_user_question',
    'send_message', 'interrupt_agent', 'list_agents',
    // Harness authoring is the creator seat's own surface; the seat guard
    // refuses it to an orchestrator/sysadmin-parented oracle child. `review_run`
    // stays available: the Oracle IS a reviewer seat (REVIEW_ROLES /
    // descriptor persona), and `subagent` stays by design (its own researchers).
    'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query',
  ],
}

/** Research child persona for the evidence broker (model-facing, no internals). */
const EVIDENCE_RESEARCH_PERSONA = [
  'You are a precision research assistant. You answer EXACTLY the question asked, from the codebase (read/glob/grep) or the web (web_search), and nothing else.',
  'Output a FACT SHEET and nothing more:',
  'CITATION: the ACTUAL file path with line number, or the exact URL you read — never a placeholder.',
  'FACTS: the answer, maximum 150 words, only what the question asked.',
  'CONFIDENCE: high | medium | low',
  'Never speculate. If the answer is not findable, its FACTS say "NOT FINDABLE" and the CITATION shows the closest place you looked.',
].join('\n')

/** Parse a fact sheet answer (markdown-tolerant). */
export function parseEvidenceSheet(text: string): { citation: string; facts: string; confidence: string } | null {
  const plain = text.replace(/\*\*/g, '')
  const rawCitation = plain.match(/CITATION\s*[:=]\s*(.+)/i)?.[1]?.trim()
  const facts = plain.match(/FACTS\s*[:=]\s*([\s\S]*?)(?:CONFIDENCE\s*[:=]|$)/i)?.[1]?.trim()
  const confidence = plain.match(/CONFIDENCE\s*[:=]\s*(high|medium|low)/i)?.[1]?.toLowerCase()
  if (!rawCitation || !facts) return null
  const placeholder = /<file:line|url\s*—|— exact>|your citation/i.test(rawCitation)
  return {
    citation: placeholder ? 'unverified (research child echoed the template)' : rawCitation,
    facts,
    confidence: placeholder ? 'low' : (confidence ?? 'medium'),
  }
}

/** External-looking targets route to the librarian, codebase targets to the explorer. */
export function isExternalEvidenceTarget(target: string): boolean {
  return /\b(web|http|npm|docs?|librar|package|registry|external|api)\b/i.test(target)
}

interface Verdict {
  approved: boolean
  concerns: string[]
  unverified: string[]
  blockers: string[]
}

/** Seq of the newest direct human prompt, or `0` when the session has none. */
export function lastHumanUserMessageSeq(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    if (event.data.source?.kind === 'user') return event.seq
  }
  return 0
}

/** Text of the newest direct human prompt, capped at 1000 characters. */
function latestOperatorQuery(events: readonly SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    const text = textOfContent(event.data.content).trim()
    return text.length > 1000 ? text.slice(0, 1000) : text
  }
  return ''
}

/** Read the Living Brief projection snapshot for the caller's session. */
function readLivingBrief(ctx: Context, session: Session): string | null {
  try {
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) return null
    const snapshot = projections.snapshot(session)
    const view = snapshot.values?.livingBrief
    if (view === undefined || view === null) return null
    const prose = typeof view.prose === 'object' && view.prose !== null ? view.prose : null
    const freshness = typeof view.freshness === 'string' ? view.freshness : 'stale'
    const parts = [
      view.goal !== undefined && view.goal !== '' ? `Goal: ${String(view.goal)}` : null,
      Array.isArray(view.decisions) && view.decisions.length > 0
        ? `Decisions: ${view.decisions.map((d: { text: string }) => d.text).join('; ')}` : null,
      Array.isArray(view.openThreads) && view.openThreads.length > 0
        ? `Open threads: ${view.openThreads.map((t: { text: string }) => t.text).join('; ')}` : null,
      prose !== null ? `Keeper synthesis: ${String((prose as { text: string }).text)}` : null,
      `Brief freshness: ${freshness}`,
    ].filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join('\n') : null
  } catch {
    // A missing or malformed projection is optional context, not a failure.
    return null
  }
}

/**
 * Extract a compact markdown list of pinned whiteboard entries from the
 * shared `enpoi-orchestration` document for one session.
 */
export function extractWhiteboardSummary(
  doc: Record<string, unknown> | undefined,
  sessionId?: string,
  cwd?: string,
): string | null {
  try {
    const wb = doc?.whiteboard as {
      docs?: {
        global?: { entries?: Array<{ kind?: string; text?: string; pinned?: boolean }> }
        projects?: Record<string, { entries?: Array<{ kind?: string; text?: string; pinned?: boolean }> }>
        sessions?: Record<string, { entries?: Array<{ kind?: string; text?: string; pinned?: boolean }> }>
      }
    } | undefined
    if (!wb?.docs) return null
    const entries: Array<{ kind: string; text: string; pinned: boolean }> = []
    const seen = new Set<string>()
    const pushEntries = (rawList?: Array<{ kind?: string; text?: string; pinned?: boolean }>) => {
      if (!Array.isArray(rawList)) return
      for (const e of rawList) {
        const text = typeof e?.text === 'string' ? e.text.trim() : ''
        if (text.length === 0 || seen.has(text)) continue
        seen.add(text)
        entries.push({
          kind: typeof e.kind === 'string' ? e.kind : 'fact',
          text,
          pinned: e.pinned === true,
        })
      }
    }
    pushEntries(wb.docs.global?.entries)
    if (cwd && wb.docs.projects?.[cwd]?.entries) pushEntries(wb.docs.projects[cwd].entries)
    if (sessionId && wb.docs.sessions?.[sessionId]?.entries) pushEntries(wb.docs.sessions[sessionId].entries)
    if (entries.length === 0) return null
    entries.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1))
    const lines = entries.map(e => `- ${e.pinned ? '📌 ' : ''}[${e.kind}] ${e.text}`)
    return lines.join('\n')
  } catch {
    // A malformed shared document never blocks a consultation.
    return null
  }
}

/** One consultation's verbatim inputs. */
export interface OracleConsultInput {
  /** What to review or consult on. */
  readonly request: string
  /** Relevant file paths the Oracle should read itself. */
  readonly files?: readonly string[]
  /** Pinned whiteboard entries, when the shared document has any. */
  readonly whiteboard?: string | null
  /** Living Brief prose, when the keeper produced one. */
  readonly brief?: string | null
}

/**
 * Build the FIRST consultation package for one Oracle child.
 * @param input - request, reading list, whiteboard, and brief.
 * @returns the prompt text delivered to a newly spawned Oracle child.
 */
export function buildInitialPackage(input: OracleConsultInput): string {
  const lines: string[] = [
    'You are the Oracle — the senior architectural supervisor and deep reviewer.',
    'This is a persistent consultation session for this operator session; later consultations arrive as deltas.',
  ]
  if (input.whiteboard) lines.push('--- PINNED WHITEBOARD ---', input.whiteboard)
  if (input.brief !== null && input.brief !== undefined) lines.push('--- SESSION BRIEF ---', input.brief)
  lines.push('--- REVIEW REQUEST ---', input.request)
  if (input.files !== undefined && input.files.length > 0) {
    lines.push('--- READING LIST (read these files directly) ---')
    for (const file of input.files) lines.push(`- ${file}`)
  }
  return lines.join('\n')
}

/** One continuing consultation's delta inputs. */
export interface OracleDeltaInput extends OracleConsultInput {
  /** Newest operator prompt, sent only when it changed since the last consult. */
  readonly operatorQuery?: string | null
}

/**
 * Build the DELTA prompt for an existing Oracle child.
 * @param input - request, files, and the changed sections only.
 * @returns the delta prompt text delivered to the persistent child.
 */
export function buildDelta(input: OracleDeltaInput): string {
  const lines: string[] = []
  if (input.operatorQuery) lines.push('--- NEW OPERATOR QUERY ---', input.operatorQuery)
  if (input.whiteboard) lines.push('--- PINNED WHITEBOARD ---', input.whiteboard)
  if (input.brief) lines.push('--- CURRENT SESSION BRIEF ---', input.brief)
  lines.push('--- REVIEW REQUEST ---', input.request)
  if (input.files !== undefined && input.files.length > 0) {
    lines.push('--- CHANGED/NEW FILES TO READ ---')
    for (const file of input.files) lines.push(`- ${file}`)
  }
  return lines.join('\n')
}

/** Route identity of one spawn: provider, model, reasoning effort, and chain. */
export interface OracleRoute {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly chainId?: string
}

/** In-memory state of one parent's persistent Oracle child (C8). */
export interface OracleChildState {
  readonly childId: SessionId
  /** Route identity the child was spawned on. */
  readonly route: string
  /** Parent `user/message` seq of the newest operator query delivered so far. */
  lastHumanSeq: number
  /** Hash of the whiteboard text delivered so far. */
  wbHash: string | null
  /** Hash of the session brief delivered so far. */
  briefHash: string | null
}

/** Stable route identity used to detect a route change across consultations. */
export function routeIdentity(route: OracleRoute): string {
  return [route.provider ?? '', route.model ?? '', route.reasoningEffort ?? '', route.chainId ?? ''].join('/')
}

/** Deterministic short hash for change detection (FNV-1a 32-bit). */
export function hashText(text: string | null): string | null {
  if (text === null || text === '') return null
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Rediscover the newest continuable child labelled exactly `oracle` (C8).
 * @param ctx - context carrying `subagents`.
 * @param parentId - parent whose catalog is read.
 * @returns the newest matching child, or `undefined` when none exists.
 */
export async function discoverOracleChild(ctx: Context, parentId: SessionId): Promise<SessionId | undefined> {
  let entries: SubagentCatalogEntry[]
  try {
    entries = await ctx.subagents.listChildren(parentId)
  } catch {
    // Catalog unavailable (composition without session-query): no rediscovery.
    return undefined
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.mode === 'continuable' && entry.label === ORACLE_LABEL) return entry.id
  }
  return undefined
}

/** Doc 38: oracle consultation timeout — resolved fresh per call (hot-swap). */
export function resolveOracleTimeoutMs(ctx: Context): number {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const value = (doc?.parameters as { oracle?: { timeoutMs?: number } } | undefined)?.oracle?.timeoutMs
    if (typeof value === 'number' && !Number.isNaN(value)) return Math.min(300_000, Math.max(30_000, value))
  } catch {
    // settings unavailable — default
  }
  return 120_000
}

/** Bounded wait for the demand-driven Living Brief before an oracle consultation, in ms. */
const ORACLE_BRIEF_WAIT_MS = 4_000

/**
 * Materialize the demand-driven brief without letting a slow keeper call delay
 * the consultation. The generation keeps running single-flight in the keeper,
 * so a later call consumes the fresh prose from cache.
 * @param parent - live parent agent whose session owns the brief.
 * @param signal - caller-owned cancellation.
 */
async function ensureBriefWithin(parent: Agent, signal: AbortSignal): Promise<void> {
  const brief = getBriefService()
  if (brief === null || brief === undefined) return
  const pending = brief.ensureFreshBrief(parent.session, signal).catch(() => {
    // A failed brief is optional context; the deterministic package still goes.
    return null
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ORACLE_BRIEF_WAIT_MS) })
  try {
    await Promise.race([pending.then(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
}

export interface PersonaModelConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

export function resolvePersonaModel(ctx: Context, persona: string): PersonaModelConfig | undefined {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const key = persona.toLowerCase().replace(/^the\s+/, '').trim()
    const entry = (doc?.personas as Record<string, { provider?: string; model?: string; reasoningEffort?: string } | null> | undefined)?.[key]
    if (entry && entry.provider && entry.model) {
      return {
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      }
    }
  } catch {
    // settings unavailable — no persona route
  }
  return undefined
}

/** One resolved chain snapshot as the `modelChains` service answers it (doc 60). */
interface OracleChainSnapshotLink {
  provider: string
  model: string
  effort?: string
}

interface OracleChainSnapshot {
  id: string
  links: OracleChainSnapshotLink[]
  attempts?: number
  onCut?: 'failover' | 'continue'
}

/**
 * Resolve a model-chain snapshot through the `modelChains` service (provided
 * by dsh-enpoi-model-chains). Fail-open: a missing service, an unknown or
 * disabled id, a malformed payload, or any read error answers `undefined`.
 */
function resolveChainSnapshot(ctx: Context, id: unknown): OracleChainSnapshot | undefined {
  if (typeof id !== 'string' || id.trim() === '') return undefined
  try {
    const service = ctx.get('modelChains') as { resolve?: (id: string) => unknown } | undefined
    const snapshot = service?.resolve?.(id.trim())
    if (snapshot === null || typeof snapshot !== 'object') return undefined
    const record = snapshot as { id?: unknown; links?: unknown; attempts?: unknown; onCut?: unknown }
    if (!Array.isArray(record.links)) return undefined
    const links: OracleChainSnapshotLink[] = []
    for (const raw of record.links) {
      if (raw === null || typeof raw !== 'object') continue
      const link = raw as { provider?: unknown; model?: unknown; effort?: unknown }
      const provider = typeof link.provider === 'string' ? link.provider.trim() : ''
      const model = typeof link.model === 'string' ? link.model.trim() : ''
      if (provider === '' || model === '') continue
      const effort = typeof link.effort === 'string' && link.effort.trim() !== '' ? link.effort.trim() : undefined
      links.push({ provider, model, ...(effort !== undefined ? { effort } : {}) })
    }
    if (links.length === 0) return undefined
    const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts) && record.attempts >= 1
      ? Math.floor(record.attempts)
      : undefined
    return {
      id: typeof record.id === 'string' && record.id !== '' ? record.id : id.trim(),
      links,
      ...(attempts !== undefined ? { attempts } : {}),
      onCut: record.onCut === 'continue' ? 'continue' : 'failover',
    }
  } catch {
    // A misbehaving chain service degrades to the persona/default route.
    return undefined
  }
}

/** One ordered oracle child attempt: a chain link, or the persona/default route. */
export interface OracleAttemptModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/**
 * The oracle child's ordered attempt routes, snapshotted at consultation start
 * (doc 60): a persona-assigned chain's links (the persona's provider/model is
 * the ACTIVE link), else exactly the legacy single persona/default route.
 * @param ctx - owning plugin context.
 * @param persona - persona key (`oracle`).
 * @returns the chain id (when assigned) plus the ordered attempts; `carryId`
 *   is true when the active link is the chain head, so the fork's
 *   `AgentOptions.chain` can be carried without re-pointing the first route.
 */
export function resolveOracleChainAttempts(
  ctx: Context,
  persona: string,
): { chainId?: string; carryId: boolean; attempts: OracleAttemptModel[] } {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const key = persona.toLowerCase().replace(/^the\s+/, '').trim()
    const entry = (doc?.personas as Record<string, { provider?: string; model?: string; reasoningEffort?: string; chain?: string } | null> | undefined)?.[key]
    const snapshot = resolveChainSnapshot(ctx, entry?.chain)
    if (snapshot !== undefined) {
      const active: OracleChainSnapshotLink = entry != null && entry.provider && entry.model
        ? {
            provider: entry.provider,
            model: entry.model,
            ...(entry.reasoningEffort ? { effort: entry.reasoningEffort } : {}),
          }
        : { ...snapshot.links[0]! }
      const links = [
        active,
        ...snapshot.links.filter(link => !(link.provider === active.provider && link.model === active.model)),
      ]
      const head = snapshot.links[0]!
      return {
        chainId: snapshot.id,
        carryId: head.provider === active.provider && head.model === active.model,
        attempts: links.map(link => ({
          provider: link.provider,
          model: link.model,
          ...(link.effort !== undefined ? { reasoningEffort: link.effort } : {}),
        })),
      }
    }
  } catch {
    // settings unavailable — fall through to the persona/default route
  }
  const personaModel = resolvePersonaModel(ctx, persona)
  return {
    carryId: false,
    attempts: personaModel !== undefined
      ? [{
          provider: personaModel.provider,
          model: personaModel.model,
          ...(personaModel.reasoningEffort !== undefined ? { reasoningEffort: personaModel.reasoningEffort } : {}),
        }]
      : [{}],
  }
}

/** Extract the VERDICT BLOCK JSON from the oracle's final message. */
function parseVerdict(text: string): Verdict {
  // 1) Strict JSON block first.
  const matches = [...text.matchAll(/\{(?:[^{}]|\{[^{}]*\})*\}/g)]
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i]![0]
    try {
      const parsed = JSON.parse(candidate) as Partial<Verdict>
      if (typeof parsed.approved === 'boolean') {
        return {
          approved: parsed.approved,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
          unverified: Array.isArray(parsed.unverified) ? parsed.unverified.map(String) : [],
          blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : [],
        }
      }
    } catch {
      /* keep scanning older candidates */
    }
  }
  // 2) Heuristic fallback: the oracle reliably states an approval verdict in
  // prose. Approved = an unnegated "approved" statement.
  const approved = /\bapproved\b/i.test(text) && !/not\s+approved|rejected|denied/i.test(text)
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 20)
  const concerns = sentences.filter(s => /concern|risk|warning|must|should|edge case|careful/i.test(s)).slice(0, 6)
  const blockers = sentences.filter(s => /blocker|blocked|prevent|fails? closed|cannot|incompatible/i.test(s)).slice(0, 4)
  return { approved, concerns, unverified: [], blockers }
}

/** Headline of one delivered verdict message. */
function verdictHeadline(turn: ChildTurnResult): string {
  if (turn.stopReason !== 'completed' && turn.stopReason !== 'max-tokens') {
    const detail = turn.error === undefined ? '' : `: ${turn.error}`
    return `📬 Oracle consultation ended (${turn.stopReason})${detail}.`
  }
  const verdict = parseVerdict(turn.text)
  return `📬 Oracle finished — ${verdict.approved ? 'APPROVED' : 'CONCERNS'} (${verdict.concerns.length} concern(s)).`
}

/**
 * Deliver one finished consultation's verdict into the parent session, waking it.
 *
 * The parent is resolved through `ctx.agents`; a disposed parent drops the
 * verdict. A parent that moved to a newer operator query receives the verdict
 * quietly for its next turn; an idle parent is woken by a follow-up; a running
 * parent is steered at its next step.
 * @param ctx - context carrying `agents`.
 * @param parentId - session id of the consulting parent.
 * @param capturedHumanSeq - parent human-query seq when the consultation started.
 * @param turn - the settled child turn.
 * @returns whether a live parent accepted the message.
 */
export function deliverOracleVerdict(
  ctx: Context,
  parentId: SessionId,
  capturedHumanSeq: number,
  turn: ChildTurnResult,
): boolean {
  const agent = ctx.get('agents')?.get(parentId)
  if (agent === undefined) return false
  const message = createUserMessage({
    content: [{ type: 'text', text: `${verdictHeadline(turn)}\n\n${turn.text}` }],
    source: { kind: 'enpoi-oracle' },
  })
  const currentHumanSeq = lastHumanUserMessageSeq(agent.session.snapshotEvents())
  if (currentHumanSeq !== capturedHumanSeq) agent.send(message, 'next-turn', false)
  else if (agent.status === 'idle') agent.followup(message)
  else agent.steer(message)
  return true
}

export function apply(ctx: Context, config: Config = {}): void {
  const pollMs = Math.max(100, Math.trunc(typeof config.childPollMs === 'number' ? config.childPollMs : 1000))
  ctx.inject(['tools', 'subagents', 'sessionPersistence', 'agents'], (injected) => {
    registerOracleTools(injected, ctx, pollMs)
  })
}

function registerOracleTools(ctx: Context, root: Context, pollMs: number): void {
  ctx = root
  /** Persistent child state per parent session (C8). */
  const children = new Map<string, OracleChildState>()
  /** One FIFO lane per parent session. */
  const queue = new ParentFifoQueue()

  ctx.on('session/disposed', (session: Session) => {
    children.delete(session.id)
  })

  ctx.tools.register({
    name: 'oracle_review',
    description: [
      'Consult the Oracle (senior reviewer for architecture, conceptual design, planning, trade-offs, code reviews, and debugging).',
      'One persistent Oracle per session remembers every earlier consultation; first call: self-contained context and relevant file paths; later calls: concise deltas.',
      'Calls made while it is busy queue in order.',
      'Blocking by default; background:true delivers the verdict as a message that wakes this session.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        request: {
          type: 'string',
          description: 'What to review or consult on. First call: self-contained context (concepts, problem, approach, state). Later calls: a concise delta.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of relevant file paths if reviewing concrete code. Omit for purely conceptual, architectural, or strategic reviews.',
        },
        background: {
          type: 'boolean',
          description: 'Run in the background — returns immediately; the verdict arrives as a delivered message. Omit for blocking.',
        },
        fresh: {
          type: 'boolean',
          description: 'Start a brand-new Oracle child instead of continuing the persistent one. Use only when the earlier consultation history would mislead.',
        },
      },
      required: ['request'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          approved: { type: 'boolean' },
          concerns: { type: 'array', items: { type: 'string' } },
          unverified: { type: 'array', items: { type: 'string' } },
          blockers: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          background: { type: 'boolean' },
          rejected: { type: 'boolean' },
        },
        required: ['approved', 'concerns', 'unverified', 'blockers', 'summary'],
      },
      render: (_args, value) => {
        if (value.background === true || value.rejected === true) {
          return [{ type: 'text', text: value.summary }]
        }
        return [{
          type: 'text',
          text: value.approved
            ? `Oracle verdict: APPROVED${value.concerns.length > 0 ? ` (concerns: ${value.concerns.join('; ')})` : ''}`
            : `Oracle verdict: CONCERNS${value.concerns.length > 0 ? ` — ${value.concerns.join('; ')}` : ''}${value.blockers.length > 0 ? ` | blockers: ${value.blockers.join('; ')}` : ''}`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: {
      request: string
      files?: string[]
      background?: boolean
      fresh?: boolean
    }, exec) {
      const parent: Agent | undefined = exec.agent
      if (parent === undefined) throw new Error('oracle_review requires a calling agent')
      const parentId = parent.session.id
      // Queue time counts against the consultation budget (spec L5.6).
      const deadline = Date.now() + resolveOracleTimeoutMs(ctx)
      return queue.run(parentId, () => consult(parent, args, exec.signal, deadline, pollMs, children, ctx))
    },
  })

  // ── request_evidence: the oracle's errand boy ────────────────────────────
  // A free-form research primitive. Any agent that can see it may call it any
  // number of times (or never); it spawns one research child — codebase
  // explorer or web librarian, chosen by the target — waits for a cited fact
  // sheet, returns it as the tool result, and releases the child. The caller
  // keeps its own context pure: one distilled answer instead of raw files.
  ctx.tools.register({
    name: 'request_evidence',
    description: [
      'Fetch ground truth for one specific question: a research child inspects the codebase (or the web for external targets) and returns a short, cited fact sheet.',
      'Use it whenever first-hand verification would sharpen your work — ask as many or as few questions as you need, one per call.',
      'The answer carries an exact citation and a confidence level; "NOT FINDABLE" means the research child could not verify it.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Where to look: a module/file/area of the codebase, or a web topic (npm, docs, library, API).' },
        question: { type: 'string', description: 'The exact factual question to verify.' },
      },
      required: ['target', 'question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          citation: { type: 'string' },
          facts: { type: 'string' },
          confidence: { type: 'string' },
        },
        required: ['found', 'citation', 'facts', 'confidence'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.found
          ? `FACT SHEET (${value.confidence})\nCITATION: ${value.citation}\nFACTS: ${value.facts}`
          : `NOT FINDABLE — ${value.facts}`,
      }],
    },
    async execute(args: { target: string; question: string }, exec) {
      const requester: Agent | undefined = exec.agent
      if (requester === undefined) throw new Error('request_evidence requires a calling agent')
      const target = String(args.target ?? '').trim()
      const question = String(args.question ?? '').trim()
      if (target.length === 0 || question.length === 0) {
        return { found: false, citation: 'n/a', facts: 'request_evidence requires both target and question.', confidence: 'low' }
      }
      const retrievedBy = isExternalEvidenceTarget(target) ? 'librarian' : 'explorer'
      const personaModel = resolvePersonaModel(ctx, retrievedBy)
      let childId: SessionId | null = null
      let messageId: MessageId | null = null
      try {
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label: `evidence request: ${question.slice(0, 50)}`,
          quiet: true,
          request: {
            prompt: [{ type: 'text', text: `TARGET: ${target}\nQUESTION: ${question}\n\nProduce the FACT SHEET now.` }],
            parent: requester,
            persona: EVIDENCE_RESEARCH_PERSONA,
            quiet: true,
            toolFilter: { deny: EVIDENCE_CHILD_DENY },
            ...(personaModel !== undefined ? {
              agentOptions: { provider: personaModel.provider, model: personaModel.model },
            } : {}),
          },
          signal: exec.signal,
        })
        childId = started.childId
        messageId = started.messageId
        const turn = await waitForChildMessageTurn(ctx, childId, messageId, {
          signal: exec.signal,
          deadline: Number.POSITIVE_INFINITY,
          pollMs,
        })
        const sheet = parseEvidenceSheet(turn.text)
        if (sheet === null) {
          return { found: false, citation: 'n/a', facts: `the research child returned no parseable fact sheet; raw tail: ${turn.text.slice(-300)}`, confidence: 'low' }
        }
        const notFindable = /NOT FINDABLE/i.test(sheet.facts)
        return { found: !notFindable, citation: sheet.citation, facts: sheet.facts, confidence: sheet.confidence }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { found: false, citation: 'n/a', facts: `evidence retrieval failed: ${message}`, confidence: 'low' }
      } finally {
        if (childId !== null) {
          try {
            await ctx.subagents.drainContinuableChildren(requester, [childId])
          } catch {
            // Release is best-effort; parent teardown owns anything left resident.
          }
        }
      }
    },
  })
}

/** One consultation pass, already ordered behind the parent's FIFO lane. */
async function consult(
  parent: Agent,
  args: { request: string; files?: string[]; background?: boolean; fresh?: boolean },
  signal: AbortSignal,
  deadline: number,
  pollMs: number,
  children: Map<string, OracleChildState>,
  ctx: Context,
): Promise<{
  approved: boolean
  concerns: string[]
  unverified: string[]
  blockers: string[]
  summary: string
  background?: boolean
  rejected?: boolean
}> {
  const parentId = parent.session.id
  const events = parent.session.snapshotEvents()
  const lastHumanSeq = lastHumanUserMessageSeq(events)
  const operatorQuery = latestOperatorQuery(events)

  const { chainId, carryId, attempts } = resolveOracleChainAttempts(ctx, 'oracle')
  const active = attempts[0] ?? {}
  const route: OracleRoute = {
    ...(active.provider !== undefined ? { provider: active.provider } : {}),
    ...(active.model !== undefined ? { model: active.model } : {}),
    ...(active.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(active.reasoningEffort) } : {}),
    ...(carryId && chainId !== undefined ? { chainId } : {}),
  }
  const identity = routeIdentity(route)

  let state = children.get(parentId)
  const routeChanged = state !== undefined && state.route !== identity
  if (args.fresh === true) {
    children.delete(parentId)
    state = undefined
  } else if (routeChanged) {
    // A different resolved route owns a different child; the old one is left
    // to its parent-scoped teardown rather than deleted out from under it.
    children.delete(parentId)
    state = undefined
  } else if (state === undefined) {
    const rediscovered = await discoverOracleChild(ctx, parentId)
    if (rediscovered !== undefined) {
      state = { childId: rediscovered, route: identity, lastHumanSeq: 0, wbHash: null, briefHash: null }
    }
  }

  const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
  const whiteboard = extractWhiteboardSummary(doc, parent.session?.id, parent.session?.header?.cwd)
  const whiteboardHash = hashText(whiteboard)
  const spawn = state === undefined
  const brief = spawn
    // Demand-driven cognition: materialize the prose brief for the first
    // consultation (Oracle amendment 3). Bounded: a hanging keeper route
    // degrades to the deterministic brief.
    ? await ensureBriefWithin(parent, signal).then(() => readLivingBrief(ctx, parent.session))
    : readLivingBrief(ctx, parent.session)
  const briefHash = hashText(brief)
  const files = Array.isArray(args.files) ? args.files : undefined

  const newQuery = state !== undefined && lastHumanSeq !== state.lastHumanSeq
  const whiteboardChanged = state !== undefined && whiteboardHash !== state.wbHash
  const briefChanged = state !== undefined && newQuery && brief !== null && briefHash !== state.briefHash

  let content: ContentBlock[]
  if (spawn || state === undefined) {
    content = [{
      type: 'text',
      text: buildInitialPackage({ request: args.request, ...(files !== undefined ? { files } : {}), whiteboard, brief }),
    }]
  } else {
    content = [{
      type: 'text',
      text: buildDelta({
        request: args.request,
        ...(files !== undefined ? { files } : {}),
        operatorQuery: newQuery ? operatorQuery : '',
        whiteboard: whiteboardChanged ? whiteboard : null,
        brief: briefChanged ? brief : null,
      }),
    }]
  }

  let childId: SessionId
  let messageId: MessageId
  if (spawn || state === undefined) {
    const agentOptions = active.provider !== undefined
      ? {
          provider: active.provider,
          ...(active.model !== undefined ? { model: active.model } : {}),
          ...(active.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(active.reasoningEffort) } : {}),
          ...(carryId && chainId !== undefined ? { chain: chainId } : {}),
        }
      : undefined
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: ORACLE_LABEL,
      quiet: true,
      request: {
        prompt: content,
        parent,
        persona: ORACLE_PERSONA,
        quiet: true,
        toolFilter: { deny: ORACLE_TOOL_FILTER.deny },
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      },
      signal,
    })
    childId = started.childId
    messageId = started.messageId
    children.set(parentId, { childId, route: identity, lastHumanSeq, wbHash: whiteboardHash, briefHash })
  } else {
    const current = state
    childId = current.childId
    messageId = await queueHostSubagentPrompt(ctx.subagents, parent, childId, content, { kind: 'user' }, signal)
    children.set(parentId, {
      ...current,
      lastHumanSeq,
      wbHash: whiteboardChanged ? whiteboardHash : current.wbHash,
      briefHash: briefChanged ? briefHash : current.briefHash,
    })
  }

  if (args.background === true) {
    void (async () => {
      try {
        const turn = await waitForChildMessageTurn(ctx, childId, messageId, {
          signal: new AbortController().signal,
          deadline: Number.POSITIVE_INFINITY,
          pollMs,
        })
        deliverOracleVerdict(ctx, parentId, lastHumanSeq, turn)
      } catch {
        // The child was disposed or its turn never settled: nothing to deliver.
      }
    })()
    return {
      approved: false,
      concerns: [],
      unverified: [],
      blockers: [],
      summary: `Background consultation started (${childId}) — the verdict will be delivered as a message when the oracle finishes.`,
      background: true,
    }
  }

  try {
    const turn = await waitForChildMessageTurn(ctx, childId, messageId, { signal, deadline, pollMs })
    if (turn.stopReason === 'error' || turn.stopReason === 'aborted' || turn.stopReason === 'refusal') {
      const detail = turn.error ?? `turn ended ${turn.stopReason}`
      return {
        approved: false,
        concerns: [`Oracle consultation failed: ${detail}`],
        unverified: [],
        blockers: [`ORACLE_MODEL_ERROR: ${detail}`],
        summary: `Oracle consultation failed: ${detail}`,
        rejected: true,
      }
    }
    const verdict = parseVerdict(turn.text)
    return {
      approved: verdict.approved,
      concerns: verdict.concerns,
      unverified: verdict.unverified,
      blockers: verdict.blockers,
      summary: turn.text,
    }
  } catch (error) {
    if (error instanceof ChildTurnTimeoutError) {
      // No silent orphan: the child keeps running and its verdict is delivered
      // as a message that wakes the parent. The FIFO lane is released here.
      void (async () => {
        try {
          const turn = await waitForChildMessageTurn(ctx, error.childId, error.messageId, {
            signal: new AbortController().signal,
            deadline: Number.POSITIVE_INFINITY,
            pollMs,
          })
          deliverOracleVerdict(ctx, parentId, lastHumanSeq, turn)
        } catch {
          // Nothing left to deliver.
        }
      })()
      return {
        approved: false,
        concerns: [],
        unverified: [],
        blockers: ['ORACLE_PENDING'],
        summary: `ORACLE_PENDING: the Oracle is still working on ${error.childId}; the verdict will be delivered as a message.`,
        rejected: true,
      }
    }
    if (signal.aborted) {
      // The caller cancelled: stop the child's live turn, release the lane,
      // and deliver nothing.
      ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      approved: false,
      concerns: [`Oracle consultation failed: ${message}`],
      unverified: [],
      blockers: [`ORACLE_MODEL_ERROR: ${message}`],
      summary: `Oracle consultation failed: ${message}`,
      rejected: true,
    }
  }
}

/** Anti-leak fence for evidence research children (never relay to the parent inbox). */
export const EVIDENCE_CHILD_DENY = [
  'send_message', 'oracle_review', 'request_evidence', 'dispatch_task', 'subagent', 'subagent_fork',
  'subagent_codex', 'subagent_claude_code', 'roundtable', 'chorus', 'council_register',
  'bash', 'edit', 'write', 'str_replace_editor', 'todo_write', 'plan_mode', 'goal',
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'workflow', 'ralph',
  'job_output', 'job_list', 'job_kill', 'skill', 'ask_user_question', 'memory_save',
  'memory_search', 'memory_rescind', 'memory_confirm', 'interrupt_agent', 'list_agents',
  // Harness authoring (seat guard) and reviewer-exec (the research child is not
  // a reviewer seat): refused at execution, so absent from the catalog.
  'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query', 'review_run',
]
