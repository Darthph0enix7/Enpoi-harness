/**
 * dsh-enpoi-tool-groups — base tool surface + attachable on-demand families.
 *
 * The registry stays host-plane; this plugin shapes only what a session SEES:
 * a per-agent `tools.restrict({ deny })` over the presented catalog (the
 * shipped per-scope presentation seam), a prompt menu listing the on-demand
 * families, and the `tool_groups` meta-tool that flips the attached set.
 *
 * Lifecycle: the plugin mounts on a preset's standing scope, so one instance
 * covers every agent joined to that preset. `agent/created` installs the
 * session's filter (base surface, or the projection-restored attached set),
 * `session/event` `turn/end` rebuilds it after an attach/detach committed
 * during the turn, and `agent/disposed` releases it. The durable
 * `tool-groups/change` event keeps the set across resume; the presentation
 * filter fails open whenever the catalog or the projection cannot answer.
 *
 * @module dsh-enpoi-tool-groups
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolExecution, ToolRunContext, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import {
  denyNames, groupVisibleTo, planGroupAction, preAttachFor, renderMenuText, resolveToolGroups, seatOfDescriptorLabel,
  type ResolvedToolGroups,
} from './catalog.js'
import { toolGroupsProjection, type ToolGroupsProjectionState } from './projection.js'

/** Cordis plugin name. */
export const name = 'enpoi-tool-groups'

/** The services this plugin registers through; the rest resolve optionally and fail open. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config: the seat identity used for per-seat pre-attach. */
export interface Config {
  /** Seat id (preset identity) resolved against `toolGroups.seats.<seat>`. */
  seat?: string
}

/** Runtime schema. */
export const Config: Schema<Config> = Schema.object({
  seat: Schema.string().default('default'),
})

/** The meta-tool name (never a member of any group). */
export const TOOL_GROUPS_TOOL = 'tool_groups'

/**
 * Menu section order: after the last tool-guidance section (`TOOL_REPORT`
 * 2900) and before `MCP_SERVERS` (3100). The harness has no named order for
 * this row yet; a named `SECTION_ORDERS` entry is the follow-up.
 */
export const TOOL_GROUPS_MENU_ORDER = 2950

/** Session-event name appended when the attached set changes. */
const CHANGE_EVENT = 'tool-groups/change'

/** Session-event name appended by the preset registry on a seat switch. */
const PRESET_SELECTED_EVENT = 'agent-preset/selected'

/** Narrow structural face of the projection registry this plugin reads. */
export interface ProjectionReader {
  stateOf(session: Session, key: 'toolGroups'): ToolGroupsProjectionState | undefined
}

/** One agent's restriction installer, owned by the plugin instance. */
export interface RestrictionInstaller {
  /**
   * Install one deny restriction for an agent's presented catalog.
   * @param agent - the agent whose session is filtered.
   * @param deny - tool names removed from the inherited surface.
   * @returns the exact disposer that lifts this restriction.
   */
  install(agent: Agent, deny: readonly string[]): () => void
  /** Release every restriction owned for one agent. */
  release(agent: Agent): void
}

/** Injectable seams (tests); production resolves every one from the context. */
export interface ToolGroupsSeams {
  readonly installer?: RestrictionInstaller
  /** `null` forces the fail-open path where no projection registry exists. */
  readonly projections?: ProjectionReader | null
  readonly settings?: SettingsDocumentReader | undefined
  /** Boot witness sink; defaults to stderr. */
  readonly log?: (line: string) => void
}

/** The default installer: one plugin-owned scope per agent, restrictions keyed by the agent. */
function scopeInstaller(ctx: Context): RestrictionInstaller {
  const scopes = new WeakMap<Agent, Scope>()
  return {
    install(agent, deny) {
      let scope = scopes.get(agent)
      if (scope === undefined) {
        // Tagged with the AGENT key: `tools.restrict` then lands on that
        // agent's own layer, so the filter covers this session alone. The
        // scope is owned by this plugin instance, so a preset switch disposes
        // the old filter with the old mount instead of leaving it intersecting.
        scope = createScope(ctx, agent)
        scopes.set(agent, scope)
      }
      return scope.ctx.tools.restrict({ deny: [...deny] })
    },
    release(agent) {
      const scope = scopes.get(agent)
      if (scope === undefined) return
      scopes.delete(agent)
      void scope.dispose()
    },
  }
}

/** Per-agent applied state: what the current request's filter enforces. */
interface AgentState {
  readonly agent: Agent
  /** Applied attached group ids, or `null` when the filter is failing open. */
  applied: readonly string[] | null
  /** The one live deny restriction, when installed. */
  restriction: (() => void) | undefined
}

/** Read one scope key's agent identity defensively (the scope is the Agent object). */
function agentIdOfScope(scope: unknown): string | undefined {
  if (scope === null || typeof scope !== 'object') return undefined
  const candidate = scope as { id?: unknown }
  return typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : undefined
}

/**
 * Report one coded diagnostics incident. Best-effort by contract: a missing
 * diagnostics service or a throwing report never changes the caller's path.
 * @param ctx - owning context (resolves the optional `diagnostics` service).
 * @param kind - failure class, prefixed `tool-groups/`.
 * @param message - human-readable detail, truncated by the incident store.
 */
function reportIncident(ctx: Context, kind: string, message: string): void {
  try {
    const diagnostics = ctx.get('diagnostics') as
      | { report?: (request: { kind?: string; message?: string }) => unknown }
      | undefined
    if (typeof diagnostics?.report !== 'function') return
    diagnostics.report({ kind, message })
  } catch {
    // The incident channel is observability only; it never gates the mount.
  }
}

/** Parse the meta-tool arguments without trusting the model. */
function parseAction(args: unknown): { action: 'list' | 'attach' | 'detach'; group?: string } | { error: string } {
  const record = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {}
  const action = record['action']
  if (action !== 'list' && action !== 'attach' && action !== 'detach') {
    return { error: `action must be one of "list", "attach", "detach" (got ${JSON.stringify(action)})` }
  }
  const group = record['group']
  if (group !== undefined && (typeof group !== 'string' || group.length === 0)) {
    return { error: 'group must be a non-empty string when provided' }
  }
  return group === undefined ? { action } : { action, group }
}

/** One group row in the meta-tool output. */
interface GroupRow {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly mode: string
  readonly enabled: boolean
  readonly attached: boolean
  readonly members: readonly string[]
}

/** The meta-tool value. */
interface ToolGroupsValue {
  readonly ok: boolean
  readonly action: string
  readonly group: string
  readonly attached: readonly string[]
  readonly groups: readonly GroupRow[]
  readonly reason: string
}

/** Output schema of the `tool_groups` tool. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    group: { type: 'string', description: 'The group the action named; empty for list.' },
    attached: {
      type: 'array',
      items: { type: 'string' },
      description: 'The complete attached group-id set after the action (durable; applied at the next turn boundary).',
    },
    groups: {
      type: 'array',
      description: 'Every enabled on-demand group with its purpose, members, and current attach state.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          purpose: { type: 'string' },
          mode: { type: 'string' },
          enabled: { type: 'boolean' },
          attached: { type: 'boolean' },
          members: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'label', 'purpose', 'mode', 'enabled', 'attached', 'members'],
      },
    },
    reason: { type: 'string', description: 'Refusal reason; empty on success.' },
  },
  required: ['ok', 'action', 'group', 'attached', 'groups', 'reason'],
} as const

/** Render the meta-tool value as model-facing text. */
function renderValue(value: ToolGroupsValue): string {
  const lines: string[] = []
  if (!value.ok) {
    lines.push(`tool_groups ${value.action} refused: ${value.reason}`)
  } else if (value.action === 'list') {
    lines.push(`tool_groups: attached [${value.attached.join(', ')}]`)
  } else if (value.action === 'attach') {
    lines.push(`tool_groups attach ${value.group}: ATTACHED. Its tools are NOT in your tool list yet, and calling them now fails. END YOUR TURN NOW — they become callable from the next turn; do not retry them in this turn.`)
  } else {
    lines.push(`tool_groups detach ${value.group}: DETACHED. Its tools leave your tool list from the next turn; calls already running still finish.`)
  }
  for (const group of value.groups) {
    lines.push(`- ${group.id} (${group.mode}${group.enabled ? '' : ', disabled'}${group.attached ? ', attached' : ''}): ${group.purpose} — ${group.members.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Mount the plugin on one preset's standing scope. A wiring failure is a
 * MOUNT failure, not a runtime restriction gap: it is logged, recorded as a
 * coded diagnostics incident, and rethrown so the preset audit reports the row
 * instead of leaving a silently inert composition.
 * @param ctx - agent-plane mount context (the preset's standing scope).
 * @param config - seat identity for per-seat pre-attach.
 * @param seams - injectable test seams; production resolves from `ctx`.
 */
export function apply(ctx: Context, config: Config = {}, seams: ToolGroupsSeams = {}): void {
  try {
    mount(ctx, config, seams)
  } catch (error: unknown) {
    const message = `enpoi-tool-groups mount failed: ${error instanceof Error ? error.message : String(error)}`
    ctx.logger?.error?.(message)
    reportIncident(ctx, 'tool-groups/mount-failed', message)
    throw error
  }
}

/** Wire the plugin; every failure propagates to {@link apply}'s loud mount boundary. */
function mount(ctx: Context, config: Config, seams: ToolGroupsSeams): void {
  const seat = config.seat ?? 'default'
  const installer = seams.installer ?? scopeInstaller(ctx)
  let projections: ProjectionReader | null = seams.projections === undefined
    ? (ctx.get('sessionProjections') as ProjectionReader | undefined) ?? null
    : seams.projections
  const settings = seams.settings ?? (ctx.get('settings') as SettingsDocumentReader | undefined)
  const states = new Map<string, AgentState>()
  /** Session ids whose fail-open restriction failure was already reported. */
  const reportedInert = new Set<string>()
  /** Membership warnings already logged (one line per distinct drop). */
  const warnedMembers = new Set<string>()
  /** Cached live tool roster; `null` means "rebuild on the next resolve". */
  let toolRoster: ReadonlySet<string> | undefined | null = null

  /**
   * The live registry roster used to validate operator-provided member names.
   * Built from this preset scope's view (global plus scoped registrations) and
   * rebuilt on `tools/change`, so a tool registered later is known to the next
   * resolve. Undefined (no roster, or an empty registry view) disables
   * validation entirely — fail open.
   */
  const knownToolNames = (): ReadonlySet<string> | undefined => {
    if (toolRoster !== null) return toolRoster
    try {
      const names = ctx.tools.schemas(scopeOf(ctx)).map(tool => tool.name)
      toolRoster = names.length === 0 ? undefined : new Set(names)
    } catch {
      toolRoster = undefined
    }
    return toolRoster
  }
  ctx.on('tools/change', () => { toolRoster = null })

  /** Resolve the catalog hot: operator edits apply to the next ensure. */
  const catalog = (): ResolvedToolGroups => resolveToolGroups(readOrchestrationDocument(settings), {
    roster: knownToolNames(),
    warn: (message) => {
      if (warnedMembers.has(message)) return
      warnedMembers.add(message)
      ctx.logger?.warn(`enpoi-tool-groups: ${message}`)
    },
  })

  /**
   * The seat identity that governs one agent. A delegated child inherits the
   * PARENT's preset, so the mount config's seat only describes the standing
   * scope; the child's own `subagent/descriptor` label (authored server-side by
   * the spawning tool) names its real seat (`roundtable seat: pragmatist`,
   * `council broker: …`). An unrecognized label falls back to the mount seat.
   */
  const seatOfAgent = (agent: Agent): string => {
    try {
      const events = (agent.session as {
        ownEvents?: () => readonly { type?: string; data?: { label?: unknown } }[]
      }).ownEvents?.() ?? []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'subagent/descriptor') continue
        const label = typeof event.data?.label === 'string' ? event.data.label : undefined
        return seatOfDescriptorLabel(label) ?? seat
      }
    } catch {
      // An unreadable log is no evidence; the mount seat stays the honest default.
    }
    return seat
  }

  /** The durable attached set (projection), or the seat default before any change. */
  const plannedAttached = (agent: Agent, groups: ResolvedToolGroups): readonly string[] | null => {
    if (projections === null) return null
    try {
      const state = projections.stateOf(agent.session, 'toolGroups')
      return state?.attached ?? preAttachFor(groups, seatOfAgent(agent))
    } catch {
      return null
    }
  }

  /** Swap the agent's restriction to the given effective set; empty = unrestricted. */
  const applyEffective = (state: AgentState, groups: ResolvedToolGroups, effective: readonly string[] | null): void => {
    if (state.restriction !== undefined) {
      state.restriction()
      state.restriction = undefined
    }
    if (effective === null) {
      state.applied = null
      return
    }
    const deny = denyNames(groups, new Set(effective))
    if (deny.length === 0) {
      state.applied = effective
      return
    }
    try {
      state.restriction = installer.install(state.agent, deny)
      state.applied = effective
    } catch (error: unknown) {
      // Fail open (a filter that cannot be installed hides nothing) — but
      // never silently: the first failure per session reaches the ledger.
      state.applied = null
      const id = state.agent.session.id
      const detail = `enpoi-tool-groups: restriction install failed for ${id}: ${String(error)}`
      ctx.logger?.warn(detail)
      if (!reportedInert.has(id)) {
        reportedInert.add(id)
        reportIncident(ctx, 'tool-groups/inert', `${detail}; the presentation filter is failing open for this session`)
      }
    }
  }

  /** Ensure one agent has a filter matching the durable state. */
  const ensure = (agent: Agent): AgentState | undefined => {
    const id = agent.session?.id
    if (typeof id !== 'string' || id.length === 0) return undefined
    let state = states.get(id)
    if (state === undefined) {
      state = { agent, applied: null, restriction: undefined }
      states.set(id, state)
    }
    const groups = catalog()
    applyEffective(state, groups, plannedAttached(agent, groups))
    return state
  }

  /** Ensure without letting a filter failure break agent creation or a turn. */
  const safeEnsure = (agent: Agent): void => {
    try {
      ensure(agent)
    } catch (error: unknown) {
      ctx.logger?.warn(`enpoi-tool-groups: ensure failed for ${String(agent.session?.id)}: ${String(error)}`)
    }
  }

  // The durable attached set (projection) drives replay across resume. A
  // registration failure fails open (no projection means no filtering) but is
  // recorded: durable attach is unavailable, and silence would read as a
  // healthy base surface.
  if (projections !== null) {
    try {
      ctx.get('sessionProjections')?.register(toolGroupsProjection)
    } catch (error: unknown) {
      const detail = `enpoi-tool-groups: projection registration failed; durable attach unavailable and the presentation filter fails open: ${String(error)}`
      ctx.logger?.error?.(detail)
      reportIncident(ctx, 'tool-groups/inert', detail)
      projections = null
    }
  }

  // The menu: on-demand families as ids + purposes + attach state.
  ctx.systemPrompt.section({
    name: 'tool-groups:menu',
    order: TOOL_GROUPS_MENU_ORDER,
    text: (context) => {
      const id = agentIdOfScope(context.scope)
      if (id === undefined) return ''
      let state = states.get(id)
      if (state === undefined) {
        // Self-heal for an agent the creation listener never saw: the filter
        // installs now (too late for this assembly's tool block, in time for
        // the next), and the menu still renders the current applied set.
        safeEnsure(context.scope as Agent)
        state = states.get(id)
      }
      const groups = catalog()
      const appliedSet = new Set(state?.applied ?? [])
      // A change committed during the current turn is durable but not yet in
      // this request's tool block; the menu names it as pending so the model
      // never has to reconcile the tool result with the catalog.
      const durable = state === undefined ? null : plannedAttached(state.agent, groups)
      const pending = durable?.filter(groupId => !appliedSet.has(groupId)) ?? []
      // The seat filter keeps a seat-restricted group (the creator's authoring
      // tools) out of every other seat's surface: the menu still names the
      // family in a seat-only notice, without an attach state or affordance.
      return renderMenuText(groups, appliedSet, pending, seatOfAgent(context.scope as Agent))
    },
  })

  // The meta-tool: visible to every agent of this preset, never group-filtered.
  ctx.tools.register({
    name: TOOL_GROUPS_TOOL,
    description: 'List, attach, or detach on-demand tool groups. On-demand groups (shipped families and operator-defined custom groups) stay out of the tool list until attached; after `attach` the group\'s tools become callable only FROM THE NEXT TURN, so end the turn after attaching before calling them. Static groups are always on and cannot be attached or detached.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'attach', 'detach'], description: 'list shows every group and its state; attach adds an on-demand group; detach removes it.' },
        group: { type: 'string', description: 'Group id; required for attach and detach, ignored for list.' },
      },
      required: ['action'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    // Mutates the session's attached set: never overlap with sibling calls.
    isConcurrencySafe: () => false,
    async execute(args: unknown, exec?: ToolRunContext): Promise<ToolGroupsValue> {
      const parsed = parseAction(args)
      const agent = exec?.agent
      const empty = (action: string, group: string, reason: string): ToolGroupsValue =>
        ({ ok: false, action, group, attached: [], groups: [], reason })
      if ('error' in parsed) return empty('invalid', '', parsed.error)
      const { action } = parsed
      const groupId = parsed.group ?? ''
      if (agent === undefined) return empty(action, groupId, 'tool_groups requires a live session scope')
      const state = states.get(agent.session.id) ?? ensure(agent)
      if (state === undefined) return empty(action, groupId, 'tool_groups requires a live session scope')
      const groups = catalog()
      const applied = state.applied ?? []
      // Planning reads the DURABLE set (the projection updates synchronously on
      // append), so two attaches in one turn compose instead of overwriting.
      const durable = plannedAttached(agent, groups)
      const attached = durable ?? applied
      const seat = seatOfAgent(agent)
      const rows: GroupRow[] = groups.groups
        .filter(group => group.mode === 'on-demand' && group.enabled && groupVisibleTo(group, seat))
        .map(group => ({
          id: group.id,
          label: group.label,
          purpose: group.purpose,
          mode: group.mode,
          enabled: group.enabled,
          attached: attached.includes(group.id),
          members: [...group.members],
        }))
      if (action === 'list') {
        return { ok: true, action, group: '', attached: [...attached], groups: rows, reason: '' }
      }
      if (groupId.length === 0) return empty(action, groupId, `action "${action}" requires a group id`)
      if (durable === null) {
        return empty(action, groupId, 'tool groups are unavailable in this session (the presentation filter is failing open)')
      }
      const planned = planGroupAction(groups, new Set(durable), action, groupId, seat)
      if (!planned.ok) return empty(action, groupId, planned.reason)
      agent.session.append(CHANGE_EVENT, { attached: [...planned.attached] }, { ignorable: true })
      return { ok: true, action, group: groupId, attached: [...planned.attached], groups: rows, reason: '' }
    },
  })

  // Mount verification: a registration that resolved to nothing would leave a
  // preset that looks healthy while the meta-tool is unreachable. Fail loud.
  if (typeof ctx.tools.get === 'function' && ctx.tools.get(TOOL_GROUPS_TOOL, scopeOf(ctx)) === undefined) {
    throw new Error(`tool "${TOOL_GROUPS_TOOL}" did not register into this preset scope`)
  }

  // Boot witness lines: the preset row is otherwise silent on success; the
  // membership line carries the EFFECTIVE (post-override) members, so an
  // operator edit is verifiable from the boot log alone.
  const resolved = catalog()
  const onDemand = resolved.groups.filter(group => group.mode === 'on-demand' && group.enabled).map(group => group.id)
  const log = seams.log ?? ((line: string) => { process.stderr.write(line) })
  log(`[enpoi-tool-groups] mounted (seat=${seat}, ${String(resolved.groups.length)} groups, on-demand: ${onDemand.join(', ') || 'none'})\n`)
  const membership = resolved.groups
    .map(group => `${group.id}${group.enabled ? '' : '(disabled)'}=${group.members.join('|') || '(none)'}`)
    .join(' ')
  log(`[enpoi-tool-groups] effective membership (seat=${seat}): ${membership}\n`)

  // Lifecycle: base surface at creation, turn-boundary commit, release on disposal.
  ctx.on('agent/created', ({ agent }) => { safeEnsure(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent.session.id)
    if (state === undefined) return
    state.restriction?.()
    state.restriction = undefined
    installer.release(agent)
    states.delete(agent.session.id)
  })

  /**
   * Per-action policy for the meta-tool: `list` is read-only and never asks;
   * `attach`/`detach` are state changes that defer to the normal policy (an ask
   * forwards to the nearest live root) UNLESS the target group is inside the
   * caller seat's declared pre-attach set — attaching what the seat already
   * declares is the seat's own behaviour, not new authority. Registered
   * `prepend` so the allow short-circuits the capability policy's unknown-tool
   * ask; the operator's capability disable still wins (defer to downstream).
   */
  const metaDisabled = (): boolean => {
    try {
      const document = readOrchestrationDocument(settings)
      const capabilities = document?.['capabilities'] as { tools?: Record<string, unknown> } | undefined
      return capabilities?.tools?.[TOOL_GROUPS_TOOL] === false
    } catch {
      return false
    }
  }

  const actionPolicy = (exec: ToolExecution): PreToolDecision | undefined => {
    if (exec.name !== TOOL_GROUPS_TOOL || metaDisabled()) return undefined
    const parsed = parseAction(exec.arguments)
    if ('error' in parsed) return undefined
    if (parsed.action === 'list') return { kind: 'allow' }
    const agent = exec.agent
    const groupId = parsed.group
    if (agent === undefined || groupId === undefined || groupId.length === 0) return undefined
    const declared = preAttachFor(catalog(), seatOfAgent(agent))
    return declared.includes(groupId) ? { kind: 'allow' } : undefined
  }

  /**
   * The hint a call to a not-currently-callable group tool carries instead of a
   * bare `UNKNOWN_TOOL`: pending (attached this turn), never attached, or
   * operator-disabled. Ungrouped, static, and callable names return undefined
   * so the call proceeds untouched.
   */
  const groupCallHint = (exec: ToolExecution): string | undefined => {
    const agent = exec.agent
    if (agent === undefined) return undefined
    const state = states.get(agent.session.id)
    if (state === undefined) return undefined
    const groups = catalog()
    const callable = new Set(state.applied ?? [])
    const durable = new Set(plannedAttached(agent, groups) ?? callable)
    for (const group of groups.groups) {
      if (group.mode !== 'on-demand' || !group.members.includes(exec.name)) continue
      if (!group.enabled) {
        return `tool "${exec.name}" belongs to tool group "${group.id}", which is disabled by the operator and can never be attached.`
      }
      if (durable.has(group.id) && !callable.has(group.id)) {
        return `tool "${exec.name}" belongs to tool group "${group.id}", which was attached this turn and is NOT callable yet. End your turn now — it becomes available from the next turn; do not retry it in this turn.`
      }
      if (!durable.has(group.id)) {
        return `tool "${exec.name}" belongs to tool group "${group.id}", which is not attached. Call tool_groups with action "attach" and group "${group.id}" first; its tools become callable from the next turn.`
      }
      return undefined
    }
    return undefined
  }

  // Replace the bare UNKNOWN_TOOL for a group tool that is not callable yet
  // with the reason and the next action. The waterfall only short-circuits for
  // that case; every other call delegates unchanged.
  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const hint = groupCallHint(exec)
    return hint === undefined ? next() : Promise.resolve({ kind: 'deny' as const, reason: hint })
  })

  // Per-action meta-tool policy: registered `prepend` so an allow here runs
  // BEFORE the capability policy's ask layer (a later listener never runs once
  // a closer one short-circuits without calling `next`).
  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
    const decision = actionPolicy(exec)
    return decision === undefined ? next() : Promise.resolve(decision)
  }, { prepend: true })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'turn/end') {
      const state = states.get(session.id)
      if (state !== undefined) safeEnsure(state.agent)
      return
    }
    // A preset switch mounts a fresh plugin instance; re-ensure through it.
    if ((event.type as string) === PRESET_SELECTED_EVENT) {
      const state = states.get(session.id)
      if (state !== undefined) safeEnsure(state.agent)
    }
  })
}

export { resolveToolGroups, denyNames, groupVisibleTo, planGroupAction, preAttachFor, renderMenuText, seatOfDescriptorLabel, SHIPPED_TOOL_GROUPS } from './catalog.js'
export { toolGroupsProjection, applyToolGroupsProjection } from './projection.js'
export type { ResolvedToolGroups, ResolveToolGroupsOptions, ToolGroupDefinition, ToolGroupMode } from './catalog.js'
