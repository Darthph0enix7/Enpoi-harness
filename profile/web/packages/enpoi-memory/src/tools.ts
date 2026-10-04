/**
 * enpoi-memory — agent tools: memory_save / memory_search / memory_rescind / memory_confirm.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { CATEGORIES } from './db'
import { makePipeline, type Pipeline } from './pipeline'
import { getMemoryParams, searchMemory } from './retriever'

export function registerMemoryTools(ctx: Context, db: DatabaseSync, pipeline: Pipeline): void {
  ctx.tools.register({
    name: 'memory_save',
    description: [
      'Save a durable project fact to cross-session memory.',
      'Use for: project rules, architecture decisions, constraints, config values, naming conventions,',
      'facts a FUTURE session must know. The fact is stored with operator trust (authoritative).',
      'Keep it short (≤400 chars) and self-contained.',
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
      render: (_a, v) => [{ type: 'text', text: v.saved ? `Memory saved: ${String(v.id)} (${String(v.state)})` : `Memory NOT saved — ${String(v.note ?? '')}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const inserted = await pipeline.intake(
        [{ fact: String(args.fact ?? ''), category: String(args.category ?? 'PROJECT'), tags: String(args.tags ?? '') }],
        { origin: 'orchestrator', trust: 'operator' },
      )
      if (inserted.length === 0) return { saved: false, note: 'Duplicate or invalid fact (already known / empty / >400 chars)' }
      const c = inserted[0]!
      return { saved: true, id: c.id, state: c.state, note: `Saved as ${c.id} (${c.category})` }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description: 'Search cross-session memory for facts relevant to a query. Returns matching facts (never injects).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for — natural language or keywords' },
        limit: { type: 'number', description: 'Max results (default 8, max 10)' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          facts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, category: { type: 'string' }, state: { type: 'string' }, trust: { type: 'string' }, fact: { type: 'string' } }, required: ['id', 'fact'] } },
          note: { type: 'string' },
        },
        required: ['facts'],
      },
      render: (_a, v) => [{ type: 'text', text: (Array.isArray(v.facts) ? v.facts.map((f: { id: string; category: string; fact: string }) => `• ${f.id} ${f.category} — ${f.fact}`) : []).join('\n') || 'No matching memory.' }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      // Doc 38: retriever top-K resolved fresh per call (hot-swap).
      const params = getMemoryParams(ctx)
      const hits = searchMemory(db, String(args.query ?? ''), Math.min(Number(args.limit ?? params.retrieverTopK) || params.retrieverTopK, params.retrieverTopK))
      if (hits.length === 0) return { facts: [], note: 'No matching memory.' }
      return {
        facts: hits.map(h => ({ id: h.id, category: h.category, state: h.state, trust: h.source_trust, fact: h.fact })),
        note: `${hits.length} fact(s)`,
      }
    },
  })

  ctx.tools.register({
    name: 'memory_rescind',
    description: 'Retract a saved memory fact (tombstone — it will never be injected into future turns).',
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
        properties: { rescinded: { type: 'boolean' }, note: { type: 'string' } },
        required: ['rescinded'],
      },
      render: (_a, v) => [{ type: 'text', text: v.rescinded ? 'Memory fact rescinded (tombstoned).' : String(v.note ?? 'Not rescinded.') }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const ok = await pipeline.rescind(String(args.id ?? ''), String(args.reason ?? ''))
      return ok ? { rescinded: true } : { rescinded: false, note: `No active fact with id ${String(args.id)}` }
    },
  })

  ctx.tools.register({
    name: 'memory_confirm',
    description: 'Explicitly confirm/graduate a tentative (untrusted) memory fact after verifying it. Operator action — use only on facts you or the operator verified. Facts saved with memory_save are already committed; confirmation applies to tentative chat-sourced claims.',
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
        properties: { confirmed: { type: 'boolean' }, id: { type: 'string' }, state: { type: 'string' }, note: { type: 'string' } },
        required: ['confirmed'],
      },
      render: (_a, v) => [{ type: 'text', text: v.confirmed ? `Memory confirmed: ${String(v.id)} → ${String(v.state)}` : String(v.note ?? 'Not confirmed.') }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
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
