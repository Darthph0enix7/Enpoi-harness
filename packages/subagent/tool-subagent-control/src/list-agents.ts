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
import type {
  SubagentCatalogEntry, SubagentDescendantListEntry, SubagentListEntry,
} from '@deepseek-ai/dsh-subagent'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const name = 'tool-subagent-list-agents'
export const inject = ['tools', 'subagents', 'agents']

type ListAgentsScope = 'children' | 'descendants'

/** Rows rendered for a listing when the model names no `limit`. */
export const DEFAULT_LIST_AGENTS_LIMIT = 20

/** Hard ceiling on `limit`; a larger request is clamped down to it. */
export const MAX_LIST_AGENTS_LIMIT = 100

interface ListAgentsRequest {
  readonly scope?: ListAgentsScope
  readonly limit?: number
}

interface ListAgentsSpec {
  readonly scope: ListAgentsScope
  readonly limit: number
}

type ListAgentsEntry =
  | {
    readonly kind: 'child'
    readonly id: SessionId
    readonly label: string
    readonly status: 'running' | 'inactive'
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

/** One projected row with the ordering keys a model-facing listing needs. */
interface OrderedRow {
  readonly entry: ListAgentsEntry
  /** Durable creation time; absent for descendant rows, which have no catalog createdAt. */
  readonly createdAt: number
  readonly running: boolean
}

/** Resolve the optional model request into an internal required spec. */
function resolveListAgentsRequest(request: ListAgentsRequest): ListAgentsSpec {
  const requested = request.limit
  const limit = requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_LIST_AGENTS_LIMIT
    : Math.min(Math.max(Math.trunc(requested), 1), MAX_LIST_AGENTS_LIMIT)
  return { scope: request.scope ?? 'children', limit }
}

/** Report turn activity without exposing whether the child is loaded. */
function statusOf(agents: { get(id: SessionId): Agent | undefined }, id: SessionId): 'running' | 'inactive' {
  return agents.get(id)?.status === 'running' ? 'running' : 'inactive'
}

/** Project one service row into the model-facing entry, or omit a one-shot child. */
function project(
  agents: { get(id: SessionId): Agent | undefined },
  entry: SubagentCatalogEntry | SubagentListEntry,
  position?: Pick<SubagentDescendantListEntry, 'parentId' | 'depth'>,
): OrderedRow | undefined {
  const at = position === undefined ? {} : { parent: position.parentId, depth: position.depth }
  if ('kind' in entry && entry.kind === 'diagnostic') {
    return { entry: { kind: 'diagnostic', id: entry.id, reason: entry.reason, ...at }, createdAt: 0, running: false }
  }
  // One-shot children cannot be continued by send_message, so the model
  // never selects them; discovery still traversed them for descendants.
  if (entry.mode !== 'continuable') return undefined
  const status = statusOf(agents, entry.id)
  return {
    entry: {
      kind: 'child',
      id: entry.id,
      label: entry.label,
      status,
      ...at,
    },
    // Descendant rows are `SubagentListEntry`, which carries no createdAt;
    // they keep their catalog pre-order under a stable sort.
    createdAt: 'createdAt' in entry ? entry.createdAt : 0,
    running: status === 'running',
  }
}

/**
 * Order rows for slot accounting and triage: running children first, then
 * inactive ones by most recent creation. A capped page therefore always shows
 * every running child and the newest history, and the footer carries the
 * totals the page could not.
 */
function orderRows(rows: readonly OrderedRow[]): ListAgentsEntry[] {
  const running = rows.filter(row => row.running)
  const inactive = rows.filter(row => !row.running).sort((left, right) => right.createdAt - left.createdAt)
  return [...running, ...inactive].map(row => row.entry)
}

/**
 * Register the `list_agents` tool.
 * @param ctx - context carrying the tool registry, subagent service, and live Agent registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'list_agents',
    description:
      'List subagents you started, with their ids, labels, and status. '
      + 'running means it is working; inactive means it is not currently working. '
      + 'Running children are listed first, then inactive ones by most recent creation. '
      + `The result shows at most ${String(DEFAULT_LIST_AGENTS_LIMIT)} rows (set \`limit\`, max ${String(MAX_LIST_AGENTS_LIMIT)}) and a footer with the totals when rows are omitted. `
      + 'You will be notified when a subagent finishes; there is no need to keep checking its status. '
      + 'Use send_message to continue the conversation.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children (default) lists direct children, which accept send_message in any status. '
          + 'descendants lists the whole tree below you with each entry\'s parent session id and depth; entries deeper than 1 accept only interrupt_agent.',
      },
      limit: {
        type: 'number',
        description: `Maximum child rows to show (default ${String(DEFAULT_LIST_AGENTS_LIMIT)}, max ${String(MAX_LIST_AGENTS_LIMIT)}). `
          + 'Running children are always shown first; omitted inactive rows are counted in the footer.',
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
                status: { type: 'string', required: true, enum: ['running', 'inactive'] },
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
          ],
        },
      },
      render: (args, entries) => {
        const request = resolveListAgentsRequest(args)
        if (entries.length === 0) return [{ type: 'text', text: '(no subagents)' }]
        const shown = entries.slice(0, request.limit)
        const lines = shown.map((entry) => {
          // A descendants row always carries its position; children rows
          // never render it. String() spans the schema-optional shape
          // without a dead fallback branch.
          const at = request.scope === 'descendants'
            ? ` parent=${String(entry.parent)} depth=${String(entry.depth)}`
            : ''
          return entry.kind === 'child'
            ? `${entry.id} [${entry.status}]${at} — ${entry.label}`
            : `${entry.id} [diagnostic: ${entry.reason}]${at}`
        })
        if (entries.length > shown.length) {
          const running = entries.filter(entry => entry.kind === 'child' && entry.status === 'running').length
          lines.push(
            `… showing ${String(shown.length)} of ${String(entries.length)} children`
            + ` (${String(running)} running, ${String(entries.length - running)} inactive);`,
            'raise `limit` or narrow `scope` to see more.',
          )
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
      switch (request.scope) {
        case 'children': {
          const entries = await ctx.subagents.listChildren(parent.id, exec.signal)
          return orderRows(entries
            .map(entry => project(ctx.agents, entry))
            .filter(entry => entry !== undefined))
        }
        case 'descendants': {
          const entries = await ctx.subagents.listDescendants(parent.id, exec.signal)
          // Descendants keep the service's parent-catalog pre-order: the tree
          // position (`parent`/`depth`) is the listing's point, so a global
          // running-first sort would print a child before its own parent.
          return entries
            .map(entry => project(ctx.agents, entry, entry))
            .filter(entry => entry !== undefined)
            .map(row => row.entry)
        }
        /* v8 ignore next 2 -- the resolver normalizes the schema-validated closed scope before dispatch. */
        default:
          return assertNever(request.scope, 'list_agents scope')
      }
    },
  }))
}
