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
  readonly offset?: number
  readonly status?: 'running' | 'inactive'
  readonly query?: string
}

interface ListAgentsSpec {
  readonly scope: ListAgentsScope
  readonly limit: number
  readonly offset: number
  readonly status?: 'running' | 'inactive'
  readonly query?: string
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

/**
 * Resolve the optional model request into an internal required spec. `limit`
 * and `offset` clamp to their page bounds; `status` accepts the closed enum
 * and `query` normalizes to a case-insensitive substring. The display paging
 * (`limit`/`offset`) never reaches `execute`, so structured output carries
 * every row that survives the filters.
 * @param request - the model-supplied arguments.
 * @returns the normalized listing request.
 */
function resolveListAgentsRequest(request: ListAgentsRequest): ListAgentsSpec {
  const requested = request.limit
  const limit = requested === undefined || !Number.isFinite(requested)
    ? DEFAULT_LIST_AGENTS_LIMIT
    : Math.min(Math.max(Math.trunc(requested), 1), MAX_LIST_AGENTS_LIMIT)
  const requestedOffset = request.offset
  const offset = requestedOffset === undefined || !Number.isFinite(requestedOffset)
    ? 0
    : Math.max(Math.trunc(requestedOffset), 0)
  const status = request.status === 'running' || request.status === 'inactive' ? request.status : undefined
  const trimmedQuery = typeof request.query === 'string' ? request.query.trim().toLowerCase() : ''
  return {
    scope: request.scope ?? 'children',
    limit,
    offset,
    ...status === undefined ? {} : { status },
    ...trimmedQuery === '' ? {} : { query: trimmedQuery },
  }
}

/**
 * Whether one projected row survives the `status` and `query` filters.
 * Diagnostics carry no status or label, so a status filter drops them while a
 * query can still select one by id.
 * @param row - the projected row.
 * @param spec - the normalized request.
 * @returns true when the row matches every active filter.
 */
function matchesFilters(row: OrderedRow, spec: ListAgentsSpec): boolean {
  if (spec.status !== undefined) {
    if (row.entry.kind !== 'child' || row.entry.status !== spec.status) return false
  }
  if (spec.query !== undefined) {
    const label = row.entry.kind === 'child' ? row.entry.label : ''
    if (!row.entry.id.toLowerCase().includes(spec.query) && !label.toLowerCase().includes(spec.query)) return false
  }
  return true
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
      'List the continuable subagents you started, with their ids, labels, and status; one-shot delegations are not listed. '
      + 'running means it is working; inactive means it is not currently working. '
      + 'Running children are listed first, then inactive ones by most recent creation. '
      + 'Optional `status` and `query` filters narrow the matching set: `query` matches the id or label, case-insensitively. '
      + `\`limit\` (default ${String(DEFAULT_LIST_AGENTS_LIMIT)}, max ${String(MAX_LIST_AGENTS_LIMIT)}) and \`offset\` bound only the displayed text; the call returns every matching row to code, so inside run_code filter that array and return only what you need, e.g. \`(await tools.list_agents({ query: "parser" })).filter(child => child.status === "running")\`. `
      + 'A footer gives the displayed range, the running/inactive totals, and the next offset when more rows follow. '
      + 'You will be notified when a subagent finishes; there is no need to keep checking its status. NEVER call this tool repeatedly to poll or wait for running children — the settlement notice will wake you automatically. '
      + 'Use send_message to continue the conversation.',
    parameters: {
      scope: {
        type: 'string',
        enum: ['children', 'descendants'],
        description: 'children (default) lists direct children, which accept send_message in any status. '
          + 'descendants lists the whole tree below you with each entry\'s parent session id and depth; entries deeper than 1 accept only interrupt_agent.',
      },
      status: {
        type: 'string',
        enum: ['running', 'inactive'],
        description: 'Only match children in this state. Diagnostics carry no state and are omitted by a status filter.',
      },
      query: {
        type: 'string',
        description: 'Case-insensitive substring match over the child id and label.',
      },
      limit: {
        type: 'number',
        description: `Maximum child rows to display (default ${String(DEFAULT_LIST_AGENTS_LIMIT)}, max ${String(MAX_LIST_AGENTS_LIMIT)}). `
          + 'Applies only to the rendered text; `offset` selects later pages.',
      },
      offset: {
        type: 'number',
        description: 'Rows to skip before the displayed page (default 0, negative values clamp to 0). '
          + 'Applies only to the rendered text; code receives every matching row.',
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
        const filtered = request.status !== undefined || request.query !== undefined
        if (entries.length === 0) {
          return [{ type: 'text', text: filtered ? '(no matching subagents)' : '(no subagents)' }]
        }
        const total = entries.length
        const shown = entries.slice(request.offset, request.offset + request.limit)
        const running = entries.filter(entry => entry.kind === 'child' && entry.status === 'running').length
        const counts = `(${String(running)} running, ${String(total - running)} inactive)`
        const noun = filtered ? 'matching children' : 'children'
        if (shown.length === 0) {
          // The page window starts past the last row: report the totals and the
          // only useful recovery rather than an empty body.
          return [{
            type: 'text',
            text: `… showing 0 of ${String(total)} ${noun} ${counts}; `
              + `offset ${String(request.offset)} is past the last child. Use offset 0 to return to the first page.`,
          }]
        }
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
        const last = request.offset + shown.length
        if (request.offset > 0 || last < total) {
          const first = request.offset + 1
          const range = first === last ? String(last) : `${String(first)}–${String(last)}`
          lines.push(
            `… showing ${range} of ${String(total)} ${noun} ${counts};`,
          )
          if (last < total) lines.push(`Use offset ${String(last)} for the next page.`)
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
            .filter(entry => entry !== undefined)
            .filter(row => matchesFilters(row, request)))
        }
        case 'descendants': {
          const entries = await ctx.subagents.listDescendants(parent.id, exec.signal)
          // Descendants keep the service's parent-catalog pre-order: the tree
          // position (`parent`/`depth`) is the listing's point, so a global
          // running-first sort would print a child before its own parent.
          return entries
            .map(entry => project(ctx.agents, entry, entry))
            .filter(entry => entry !== undefined)
            .filter(row => matchesFilters(row, request))
            .map(row => row.entry)
        }
        /* v8 ignore next 2 -- the resolver normalizes the schema-validated closed scope before dispatch. */
        default:
          return assertNever(request.scope, 'list_agents scope')
      }
    },
  }))
}
