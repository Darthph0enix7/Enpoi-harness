/**
 * enpoi-memory — agent tools: memory_save / memory_search / memory_rescind / memory_confirm.
 *
 * Memory is tool-driven (standing rule #615): nothing is injected; the model
 * calls `memory_search` when it needs earlier decisions. Search scopes
 * compaction-derived rows to the caller's workspace (C3/C4), and results
 * render state and trust so tentative claims are visibly unconfirmed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { resolveMemoryConfig, type MemoryConfig } from './config'
import { CATEGORIES } from './db'
import type { Pipeline } from './pipeline'
import { getMemoryParams, searchMemory } from './retriever'

/** `YYYY-MM-DD` in UTC from one epoch-millisecond stamp. */
function savedAt(claim: { committed_at: number | null; created_at: number }): string {
  const stamp = claim.committed_at ?? claim.created_at
  const date = new Date(stamp)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/** Quote a fact containing a line break so it cannot spoof a second result row. */
function renderFact(fact: string): string {
  return /[\r\n]/.test(fact) ? JSON.stringify(fact) : fact
}

/** Loose JSON value shape accepted by a tool render callback. */
type RenderValue = Record<string, unknown>

/** Result code for a delegated session attempting root-only memory mutation. */
const DELEGATED_SESSION_DENIED = 'delegated_session_denied'
/** Result code when no trusted calling session can authorize a root-only action. */
const ROOT_SESSION_REQUIRED = 'root_session_required'

/**
 * Whether the calling session is a delegated subagent. A seeded root fork also
 * records `parentSession`; the typed subagent origin or positive delegation
 * depth is what distinguishes a child from that fork. A bare `parentSession`
 * without seed lineage is still delegated.
 * @param exec - the tool execution scope.
 * @returns true when root-only memory actions must be denied.
 */
function delegatedSession(exec?: ToolRunContext): boolean {
  const header = exec?.agent?.session.header
  if (header === undefined) return false
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return true
  return header.parentSession !== undefined && header.isSeeded !== true
}

/**
 * Authorize one root-only memory mutation. Missing execution context fails
 * closed even though root `memory_save` keeps its legacy operator behavior.
 * @param exec - the tool execution scope.
 * @param action - the mutation named in the denial.
 * @returns the denial payload, or undefined for a trusted root session.
 */
function rootOnlyDenial(exec: ToolRunContext | undefined, action: 'confirmation' | 'rescission'): { code: string; note: string } | undefined {
  const header = exec?.agent?.session.header
  if (header === undefined) {
    return {
      code: ROOT_SESSION_REQUIRED,
      note: `Memory ${action} requires a trusted root session context; no database write was made.`,
    }
  }
  if (!delegatedSession(exec)) return undefined
  return {
    code: DELEGATED_SESSION_DENIED,
    note: action === 'confirmation'
      ? 'Delegated sessions cannot confirm memory facts; the root session must accept the fact before it gains operator trust.'
      : 'Delegated sessions cannot rescind memory facts; the root session must decide whether to tombstone the fact.',
  }
}

/** Clamp one model-supplied result limit into [1, configured top-K]. */
function memorySearchLimit(value: unknown, max: number): number {
  if (value === undefined) return max
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested < 1) return max
  return Math.min(max, Math.floor(requested))
}

/** Intake authority derived from the calling session, not from the tool name. */
interface MemorySaveAuthority {
  readonly origin: string
  readonly trust: 'operator' | 'untrusted_external'
  readonly provenance: string
}

/**
 * Resolve who is saving: a root session keeps the operator label (the model is
 * acting for the operator), while a subagent child writes a tentative
 * `worker:<role>` claim. Fork lineage alone is not a child: a forked root also
 * records `parentSession`.
 */
function memorySaveAuthority(exec?: ToolRunContext): MemorySaveAuthority {
  const session = exec?.agent?.session
  const header = session?.header
  const child = delegatedSession(exec)
  const role = header?.agentPreset?.trim()
  const provenance: Record<string, unknown> = {
    source: 'memory_save',
    sessionId: session?.id ?? '',
    cwd: header?.cwd ?? '',
  }
  if (!child) {
    return { origin: 'orchestrator', trust: 'operator', provenance: JSON.stringify(provenance) }
  }
  provenance.parentSessionId = header?.parentSession ?? ''
  const agentRole = role !== undefined && role !== '' ? role : 'worker'
  provenance.agentRole = agentRole
  provenance.settled = true
  const callId = exec?.callId
  if (typeof callId === 'string' && callId !== '') provenance.callId = callId
  return {
    origin: agentRole === 'worker' ? 'worker' : `worker:${agentRole}`,
    trust: 'untrusted_external',
    provenance: JSON.stringify(provenance),
  }
}

/** One `memory_search` fact row (C4). */
interface MemoryFactRow {
  readonly id: string
  readonly category: string
  readonly origin: string
  readonly savedAt: string
  readonly state: string
  readonly trust: string
  readonly fact: string
}

export function registerMemoryTools(
  ctx: Context,
  db: DatabaseSync,
  pipeline: Pipeline,
  config: MemoryConfig = resolveMemoryConfig(undefined),
): void {
  ctx.tools.register({
    name: 'memory_save',
    description: [
      'Save one durable project fact to cross-session memory. A root session saves with operator trust (authoritative);',
      'a subagent child saves as tentative worker:<role> until a root session confirms it.',
      'Call it when the session settles something a FUTURE session must know and would otherwise re-derive:',
      'a project rule, an architecture decision with its reason, a constraint, a config value, a naming convention,',
      'or an exact path/command/identifier. Compaction already saves the checkpoint\'s durable facts automatically;',
      'save what it cannot see — a decision you just made, a correction from the operator, a verified command.',
      'One self-contained sentence, ≤400 chars, no secrets or personal data.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The durable fact (≤400 chars, self-contained, no fluff)' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'RULES | ARCHITECTURE | CONSTRAINTS | CONFIG_VALUES | NAMING | PROJECT' },
        tags: { type: 'string', description: 'Optional space-separated keywords' },
      },
      required: ['fact', 'category'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { saved: { type: 'boolean' }, id: { type: 'string' }, state: { type: 'string' }, note: { type: 'string' } },
        required: ['saved'],
      },
      render: (_a, raw) => {
        const v = raw as { saved?: boolean; id?: string; state?: string; note?: string }
        return [{ type: 'text', text: v.saved ? `Memory saved: ${String(v.id)} (${String(v.state)})` : `Memory NOT saved — ${String(v.note ?? '')}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec?: ToolRunContext) {
      // The source record scopes child saves and ranks same-project hits; a
      // root save stays authoritative operator memory.
      const authority = memorySaveAuthority(exec)
      const inserted = await pipeline.intake(
        [{ fact: String(args.fact ?? ''), category: String(args.category ?? 'PROJECT'), tags: String(args.tags ?? '') }],
        { origin: authority.origin, trust: authority.trust, provenance: authority.provenance },
      )
      if (inserted.length === 0) return { saved: false, note: 'Duplicate or invalid fact (already known / empty / >400 chars)' }
      const c = inserted[0]!
      return { saved: true, id: c.id, state: c.state, note: `Saved as ${c.id} (${c.category})` }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description: [
      'Search cross-session memory. Call it when starting a task, returning to a subsystem,',
      'or before re-deriving a decision: it returns saved facts plus the durable facts each compaction extracted,',
      'each with id, category, origin (memory_save | compaction | keeper | worker:<role>), save date, state, and trust so you can weigh them.',
      'Hits are coverage-ranked: facts matching more query terms come first, exact phrases break ties, and the caller\'s',
      'project cwd plus recency provide bounded tie-breaks. Tentative claims are unconfirmed; verify before relying on them.',
      'Nothing is injected — this is the only way memory reaches you. Compaction facts are scoped to the caller\'s workspace.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for — natural language or keywords' },
        limit: { type: 'integer', description: 'Max results (clamped to the configured top-K)' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' },
                category: { type: 'string' },
                origin: { type: 'string' },
                savedAt: { type: 'string' },
                state: { type: 'string' },
                trust: { type: 'string' },
                fact: { type: 'string' },
              },
              required: ['id', 'fact'],
            },
          },
          note: { type: 'string' },
        },
        required: ['facts'],
      },
      // C4: `• <id> <category> [<origin> <savedAt>] state=<state> trust=<trust> — <fact>`.
      render: (_a, raw) => {
        const v = raw as { facts?: MemoryFactRow[] }
        return [{
          type: 'text',
          text: (Array.isArray(v.facts) ? v.facts.map(f => `• ${f.id} ${f.category} [${f.origin} ${f.savedAt}] state=${f.state} trust=${f.trust} — ${renderFact(f.fact)}`) : []).join('\n')
            || 'No matching memory.',
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec?: ToolRunContext) {
      // Doc 38: retriever top-K resolved fresh per call (hot-swap). The parser
      // rejects non-integers; a direct caller gets the same clamp here.
      const params = getMemoryParams(ctx)
      const limit = memorySearchLimit(args.limit, params.retrieverTopK)
      // L2: compaction-derived facts are workspace-scoped to the caller's cwd.
      const scope = { cwd: exec?.agent?.session.header.cwd, scopeCompaction: config.scopeCompactionFactsToWorkspace }
      const hits = searchMemory(db, String(args.query ?? ''), limit, scope)
      if (hits.length === 0) return { facts: [], note: 'No matching memory.' }
      return {
        facts: hits.map(h => ({
          id: h.id,
          category: h.category,
          origin: h.origin,
          savedAt: savedAt(h),
          state: h.state,
          trust: h.source_trust,
          fact: h.fact,
        })),
        note: `${hits.length} fact(s)`,
      }
    },
  })

  ctx.tools.register({
    name: 'memory_rescind',
    description: 'Retract a saved memory fact (tombstone — it will never be injected into future turns). Root sessions only; a delegated subagent must report the fact to its parent instead.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The fact id (e.g. claim-a1b2...) from memory_search or memory_save' },
        reason: { type: 'string', description: 'Optional reason for the record' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { rescinded: { type: 'boolean' }, code: { type: 'string' }, note: { type: 'string' } },
        required: ['rescinded'],
      },
      render: (_a, raw) => {
        const v = raw as { rescinded?: boolean; note?: string }
        return [{ type: 'text', text: v.rescinded ? 'Memory fact rescinded (tombstoned).' : String(v.note ?? 'Not rescinded.') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec?: ToolRunContext) {
      const denial = rootOnlyDenial(exec, 'rescission')
      if (denial !== undefined) return { rescinded: false, ...denial }
      const ok = await pipeline.rescind(String(args.id ?? ''), String(args.reason ?? ''))
      return ok ? { rescinded: true } : { rescinded: false, note: `No active fact with id ${String(args.id)}` }
    },
  })

  ctx.tools.register({
    name: 'memory_confirm',
    description: 'Explicitly confirm a tentative (untrusted) memory fact. Commits it with the operator trust label and a fresh commit time; use only after verifying the fact. Root sessions only: a delegated subagent must report the fact to its parent, which decides whether to confirm. Facts saved with memory_save in a root session are already committed; confirmation applies to tentative claims.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The tentative fact id' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { confirmed: { type: 'boolean' }, id: { type: 'string' }, state: { type: 'string' }, code: { type: 'string' }, note: { type: 'string' } },
        required: ['confirmed'],
      },
      render: (_a, raw) => {
        const v = raw as { confirmed?: boolean; id?: string; state?: string; note?: string }
        return [{ type: 'text', text: v.confirmed ? `Memory confirmed: ${String(v.id)} → ${String(v.state)}` : String(v.note ?? 'Not confirmed.') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec?: ToolRunContext) {
      const denial = rootOnlyDenial(exec, 'confirmation')
      if (denial !== undefined) return { confirmed: false, ...denial }
      const id = String(args.id ?? '')
      const row = await pipeline.confirm(id)
      if (row !== null) return { confirmed: true, id: row.id, state: row.state }
      // Distinguish the two no-op cases: an id that exists but is not
      // tentative (memory_save lands committed) is not "unknown".
      const existing = pipeline.get(id)
      if (existing !== undefined) {
        return {
          confirmed: false,
          id: existing.id,
          state: existing.state,
          note: `Already ${existing.state}; confirmation applies only to tentative facts.`,
        }
      }
      return { confirmed: false, note: `Unknown fact id "${id}".` }
    },
  })
}
