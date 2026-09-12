/**
 * The globally named `list_agents` tool: a thin model-facing adapter over
 * the continuable projection of `ctx.subagents.listChildren()` and, for the
 * `descendants` scope, `ctx.subagents.listDescendants()`. It stays separately
 * loadable from the root `send_message` plugin so a deployment can register
 * continuation delivery without exposing discovery.
 * @module @deepseek-ai/dsh-tool-subagent-control/list-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry, SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const name = 'tool-subagent-list-agents'
export const inject = ['tools', 'subagents', 'agents']

type ListAgentsScope = 'children' | 'descendants'

interface ListAgentsRequest {
  readonly scope?: ListAgentsScope
}

interface ListAgentsSpec {
  readonly scope: ListAgentsScope
}

type ListAgentsEntry =
  | {
    readonly kind: 'child'
    readonly id: SessionId
    readonly label: string
    readonly status: 'running' | 'idle' | 'ready'
    readonly parent?: SessionId
    readonly depth?: number
  }
  | {
    readonly kind: 'diagnostic'
    readonly id: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
    readonly parent?: SessionId
    readonly depth?: number
  }
  | {
    readonly kind: 'available'
    readonly name: string
    readonly role: string
    readonly via: string
  }

/**
 * The orchestration fleet — specialist agents the orchestrator can spawn on
 * demand. They do not exist as sessions until called, so `list_agents` lists
 * them as `available` so the model knows they exist and how to reach them.
 */
const FLEET: ReadonlyArray<{ name: string; role: string; via: string }> = [
  { name: 'oracle', role: 'senior architectural reviewer', via: 'oracle_review' },
  { name: 'keeper', role: 'background context summarizer', via: 'automatic (background)' },
  { name: 'fixer', role: 'bounded implementation worker', via: 'subagent' },
  { name: 'explorer', role: 'codebase mapper', via: 'subagent' },
  { name: 'librarian', role: 'external researcher', via: 'subagent' },
  { name: 'designer', role: 'UI/UX specialist', via: 'subagent' },
  { name: 'skeptic', role: 'roundtable debater', via: 'roundtable' },
  { name: 'architect', role: 'roundtable debater', via: 'roundtable' },
  { name: 'pragmatist', role: 'roundtable debater', via: 'roundtable' },
  { name: 'critic', role: 'roundtable adjudicator', via: 'roundtable' },
  { name: 'visionary', role: 'chorus brainstormer', via: 'chorus' },
  { name: 'experiencer', role: 'chorus brainstormer', via: 'chorus' },
  { name: 'integrator', role: 'chorus brainstormer', via: 'chorus' },
  { name: 'curator', role: 'chorus harvest master', via: 'chorus' },
]

/** Resolve the optional model request into an internal required-scope spec. */
function resolveListAgentsRequest(request: ListAgentsRequest): ListAgentsSpec {
  return { scope: request.scope ?? 'children' }
}

/**
 * Refine one candidate's status through the live Agent registry: `running`
 * for an active driver, `idle` for a resident Agent between turns (possibly
 * waiting on agents it started), and `ready` when no live Agent remains.
 * `ready` preserves resumability without presenting an inactive conversation
 * as a terminal result to collect.
 */
function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'idle' | 'ready' {
  const agent = agents.get(id)
  if (agent === undefined) return 'ready'
  return agent.status === 'running' ? 'running' : 'idle'
}

/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(
  agents: { get(id: SessionId): Agent | undefined },
  entry: SubagentListEntry,
  position?: Pick<SubagentDescendantListEntry, 'parentId' | 'depth'>,
): ListAgentsEntry | undefined {
  const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth }
  if (entry.kind === 'diagnostic') {
    return { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at }
  }
  // One-shot children cannot be continued by send_message, so the model
  // never selects them; discovery still traversed them for descendants.
  if (entry.mode !== 'continuable') return undefined
  return {
    kind: 'child',
    id: entry.id,
    label: entry.label,
    status: statusOf(agents, entry.id),
    ...at,
  }
}

/**
 * Register the `list_agents` tool.
 * @param ctx - context carrying the tool registry, subagent service, and live Agent registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      'List your continuable background subagents by durable id and label, plus the orchestration fleet '
      + 'available to spawn on demand. Use it to recall which ones '
      + 'you started, not to poll for completion — you are told when one finishes. Status comes from the live '
      + 'registry: running means the agent is working right now, idle means it is loaded but between turns '
      + '(it may be waiting on agents it started), and ready means it exists only in storage — resumable, not '
      + 'terminal, and not a result waiting to be collected; a `send_message` steers a running child at its nearest '
      + 'step boundary or starts a turn for an idle or ready child, and a direct child remains a `send_message` '
      + 'candidate in every status. The snapshot is not a delivery '
      + 'promise — `send_message` performs the authoritative check and may still fail. Children that could '
      + 'not be read are reported as diagnostics instead of being silently dropped. Scope `descendants` '
      + 'walks the whole tree below you in stable pre-order, annotating each entry with its durable direct-parent '
      + 'session id and depth. You may use `send_message` only for depth-1 entries; deeper entries are '
      + 'candidates for `interrupt_agent` only. `available` entries are the orchestration fleet — specialist '
      + 'agents that do not exist as sessions until spawned (via oracle_review, subagent, roundtable, or chorus).',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children (default) lists direct children only; descendants walks the complete tree below you.',
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['child'] },
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['running', 'idle', 'ready'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['diagnostic'] },
                id: { type: 'string', required: true },
                reason: { type: 'string', required: true, enum: ['corrupt', 'unsupported', 'unavailable'] },
                parent: { type: 'string' },
                depth: { type: 'number' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['available'] },
                name: { type: 'string', required: true },
                role: { type: 'string', required: true },
                via: { type: 'string', required: true },
              },
            },
          ],
        },
      },
      render: (args, entries) => {
        const request = resolveListAgentsRequest(args)
        const available = entries.filter((entry): entry is Extract<ListAgentsEntry, { kind: 'available' }> => entry.kind === 'available')
        const running = entries.filter((entry): entry is Exclude<ListAgentsEntry, { kind: 'available' }> => entry.kind !== 'available')
        const lines: string[] = []
        if (available.length > 0) {
          lines.push('Available orchestration fleet (spawn on demand):')
          lines.push(...available.map(entry => `- ${entry.name} — ${entry.role} (via ${entry.via})`))
        }
        if (running.length === 0) {
          lines.push('(no running subagents)')
        } else {
          lines.push('Running subagents:')
          lines.push(...running.map((entry) => {
            const at = request.scope === 'descendants'
              ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
              : ''
            return entry.kind === 'child'
              ? `${entry.id} [${entry.status}]${at} — ${entry.label}`
              : `${entry.id} [diagnostic: ${entry.reason}]${at}`
          }))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Non-agent callers have no session whose children could be listed.
        throw new Error('list_agents requires a calling agent (exec.agent was undefined)')
      }
      const request = resolveListAgentsRequest(args)
      // The registry drains started tool bodies, so the scan must observe the
      // call's signal rather than finish a slow catalog after cancellation.
      const fleet: ListAgentsEntry[] = FLEET.map(entry => ({ kind: 'available', ...entry }))
      switch (request.scope) {
        case 'children': {
          const entries = await ctx.subagents.listChildren(parent.id, exec.signal)
          return [
            ...fleet,
            ...entries
              .map(entry => project(ctx.agents, entry))
              .filter(entry => entry !== undefined),
          ]
        }
        case 'descendants': {
          const entries = await ctx.subagents.listDescendants(parent.id, exec.signal)
          return [
            ...fleet,
            ...entries
              .map(entry => project(ctx.agents, entry, entry))
              .filter(entry => entry !== undefined),
          ]
        }
        /* v8 ignore next 2 -- the resolver normalizes the schema-validated closed scope before dispatch. */
        default:
          return assertNever(request.scope, 'list_agents scope')
      }
    },
  }))
}
