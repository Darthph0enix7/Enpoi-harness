/**
 * dsh-enpoi-tool-groups — group catalog: shipped defaults, operator-document
 * resolution, the presentation deny set, the model-facing menu, and the pure
 * action planner behind the `tool_groups` meta-tool.
 *
 * Groups are data. The defaults below are derived from the live wire registry
 * (`deepseek-harness/scripts/tool-inventory/roster-baseline.json`,
 * 50/50/53 @ 2026-10-02: orchestrator and sysadmin drop the Creator group's
 * three harness-authoring tools) and frozen here; no shipped group
 * pre-attaches, so every on-demand family starts detached on a fresh session.
 * The operator document `enpoi-orchestration.toolGroups` overrides `enabled`
 * per group and `preAttach` per seat. Everything not named by a group is never
 * denied — the presentation filter fails open.
 *
 * @module dsh-enpoi-tool-groups/catalog
 */

/** Whether a group is always presented or attachable on demand. */
export type ToolGroupMode = 'static' | 'on-demand'

/** One group definition (shipped default or operator-overridden). */
export interface ToolGroupDefinition {
  /** Stable group id used by the menu and the meta-tool. */
  readonly id: string
  /** Human-facing label. */
  readonly label: string
  /** One-line purpose rendered in the menu. */
  readonly purpose: string
  /** Exact registry tool names this group owns. */
  readonly members: readonly string[]
  /** `static` groups are always presented; `on-demand` groups attach per session. */
  readonly mode: ToolGroupMode
  /** Seat ids that start with this group attached (group-level default). */
  readonly preAttach: readonly string[]
  /**
   * When present, the group belongs to these seats ALONE: every other seat's
   * prompt menu and meta-tool listing omit it, and an attach that names it is
   * refused. `preAttach` still decides which listed seat starts attached.
   */
  readonly seats?: readonly string[]
  /** Operator switch; `false` means never present and never attachable. */
  readonly enabled: boolean
}

/** One seat's resolved pre-attach list. */
export interface SeatPreAttach {
  readonly seat: string
  readonly groups: readonly string[]
}

/** The resolved catalog: shipped defaults merged with the operator document. */
export interface ResolvedToolGroups {
  readonly groups: readonly ToolGroupDefinition[]
  readonly byId: ReadonlyMap<string, ToolGroupDefinition>
  /** Seat overrides read from `toolGroups.seats.<seat>.preAttach`. */
  readonly seats: ReadonlyMap<string, readonly string[]>
}

/** Shipped defaults, frozen against the live registry roster. */
export const SHIPPED_TOOL_GROUPS: readonly ToolGroupDefinition[] = Object.freeze([
  {
    id: 'core',
    label: 'Core',
    purpose: 'the everyday implementation surface',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: [
      'ask_user_question', 'bash', 'edit', 'glob', 'grep', 'read', 'read_image',
      'skill', 'subagent', 'todo_write', 'web_search', 'write', 'present',
    ],
  },
  {
    id: 'goals',
    label: 'Goals',
    purpose: 'create, read, and update the session goal',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['create_goal', 'get_goal', 'update_goal'],
  },
  {
    id: 'plan',
    label: 'Plan mode',
    purpose: 'submit an implementation plan for approval',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['exit_plan_mode'],
  },
  {
    id: 'councils',
    label: 'Councils',
    purpose: 'oracle review, roundtable debate, and chorus brainstorming',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['chorus', 'council_list', 'council_register', 'oracle_review', 'request_evidence', 'roundtable'],
  },
  {
    id: 'jobs',
    label: 'Jobs',
    purpose: 'list, read, and stop background shell jobs',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['job_kill', 'job_list', 'job_output'],
  },
  {
    id: 'workflow',
    label: 'Workflows',
    purpose: 'run deterministic workflow and ralph programs',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['ralph', 'workflow'],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    purpose: 'fast structured progress reports',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['fast_report'],
  },
  {
    id: 'whiteboard',
    label: 'Whiteboard',
    purpose: 'pin, read, and forget durable board notes',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write'],
  },
  {
    id: 'memory',
    label: 'Memory',
    purpose: 'save, search, confirm, and rescind durable project facts',
    mode: 'static',
    preAttach: [],
    enabled: true,
    members: ['memory_confirm', 'memory_rescind', 'memory_save', 'memory_search'],
  },
  {
    id: 'peer',
    label: 'Peer interconnect',
    purpose: 'cross-device peer sessions: status, ask, answer, cancel',
    mode: 'on-demand',
    preAttach: [],
    enabled: true,
    members: ['peer_status', 'peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel'],
  },
  {
    id: 'debug',
    label: 'Debug & observability',
    purpose: 'session log, event trace, and diagnostics inspection',
    mode: 'on-demand',
    // Nothing pre-attaches by default: a fresh session starts with every
    // on-demand family detached and the menu names it as attachable. The
    // personas advertise self-diagnosis, so a seat attaches the group through
    // the `tool_groups` meta-tool when it needs the diagnostics surface. An
    // operator seat override in the document still wins.
    preAttach: [],
    enabled: true,
    members: [
      'diagnostics_report', 'session_debug', 'session_event_read', 'session_event_search',
      'session_event_trace', 'session_search', 'session_trace',
    ],
  },
  {
    id: 'creator',
    label: 'Creator (harness authoring)',
    purpose: 'inspect and manage the harness plugin composition',
    mode: 'on-demand',
    // Nothing pre-attaches by default; only the Creator seat can see or attach
    // the group at all (`seats`): harness authoring is its specialty, so
    // orchestrator and sysadmin never SEE the tools — the group's deny filter
    // removes them from the advertised surface and their menu carries a
    // seat-only notice instead of an attach state (the meta-tool listing omits
    // it; the seat guard in `enpoi-capabilities` stays as the execution
    // backstop). The per-seat menu line is a deliberate prompt-prefix
    // difference: a cross-agent switch rebuilds the provider's prefix once;
    // turns within one seat keep the prefix.
    preAttach: [],
    seats: ['creator'],
    enabled: true,
    members: ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager'],
  },
])

/** Stable catalog order used for deterministic attached lists. */
const GROUP_ORDER: readonly string[] = SHIPPED_TOOL_GROUPS.map(group => group.id)

/** Read one plain record from an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read one string list, dropping non-strings and duplicates. */
function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry)
  }
  return [...seen]
}

/**
 * Resolve the effective catalog from the operator document. Never throws and
 * never removes a shipped group: a malformed or missing document leaves the
 * shipped defaults in force (fail open).
 * @param document - the `enpoi-orchestration` document, or undefined.
 * @returns groups in stable order plus per-seat pre-attach overrides.
 */
export function resolveToolGroups(document: unknown): ResolvedToolGroups {
  const doc = asRecord(document)
  const toolGroups = asRecord(doc?.['toolGroups'])
  const groupOverrides = asRecord(toolGroups?.['groups'])
  const groups = SHIPPED_TOOL_GROUPS.map((group): ToolGroupDefinition => {
    const override = asRecord(groupOverrides?.[group.id])
    return {
      ...group,
      enabled: typeof override?.['enabled'] === 'boolean' ? override['enabled'] : group.enabled,
    }
  })
  const byId = new Map(groups.map(group => [group.id, group] as const))
  const seats = new Map<string, readonly string[]>()
  const seatOverrides = asRecord(toolGroups?.['seats'])
  if (seatOverrides !== undefined) {
    for (const [seat, value] of Object.entries(seatOverrides)) {
      const preAttach = asStringList(asRecord(value)?.['preAttach'])
      if (preAttach !== undefined) seats.set(seat, preAttach)
    }
  }
  return { groups, byId, seats }
}

/**
 * The group ids a seat starts attached with: the operator's per-seat override
 * when present, else the union of group-level `preAttach` entries for that
 * seat. Unknown ids are ignored (fail open toward the base surface).
 * @param catalog - the resolved catalog.
 * @param seat - the seat id (preset identity).
 * @returns attached group ids in catalog order.
 */
export function preAttachFor(catalog: ResolvedToolGroups, seat: string): string[] {
  const override = catalog.seats.get(seat)
  const candidates = override ?? catalog.groups
    .filter(group => group.preAttach.includes(seat))
    .map(group => group.id)
  return sortGroupIds(candidates.filter((id) => {
    const group = catalog.byId.get(id)
    return group !== undefined && group.enabled && groupVisibleTo(group, seat)
  }))
}

/**
 * Whether one group belongs to one seat. A group without `seats` is shared;
 * a group with `seats` is invisible and unattachable everywhere else.
 * @param group - one catalog group.
 * @param seat - the asking seat id, or undefined for no known seat.
 * @returns true when the seat may see and attach the group.
 */
export function groupVisibleTo(group: ToolGroupDefinition, seat: string | undefined): boolean {
  if (group.seats === undefined) return true
  return seat !== undefined && group.seats.includes(seat)
}

/** Sort group ids by the stable catalog order (unknown ids last, lexical). */
function sortGroupIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((left, right) => {
    const leftIndex = GROUP_ORDER.indexOf(left)
    const rightIndex = GROUP_ORDER.indexOf(right)
    if (leftIndex !== -1 && rightIndex !== -1) return leftIndex - rightIndex
    if (leftIndex !== -1) return -1
    if (rightIndex !== -1) return 1
    return left.localeCompare(right)
  })
}

/**
 * Council seat label prefixes that do not follow the `<seat> seat:` shape.
 * The spawning engine authors every one of these server-side (never model
 * input), so the mapping is the honest seat identity of the child.
 */
const COUNCIL_LABEL_SEATS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^council chair:/i, 'chair'],
  [/^council referee:/i, 'referee'],
  [/^council broker:/i, 'broker'],
])

/**
 * The seat id a delegated child's `subagent/descriptor` label carries, when it
 * names one. `roundtable seat: pragmatist` → `pragmatist`; the council's
 * chair/referee/broker labels map to their seat ids. An unrecognized label
 * (generic delegation) answers undefined so the caller keeps the mount seat.
 * @param label - the descriptor label authored by the spawning tool.
 * @returns the lowercase seat id, or undefined when the label names none.
 */
export function seatOfDescriptorLabel(label: string | undefined): string | undefined {
  if (typeof label !== 'string') return undefined
  const trimmed = label.trim()
  if (trimmed === '') return undefined
  // The spawning engine labels debater seats `<council id> seat: <seat id>`.
  const seat = /^[a-z0-9][a-z0-9-]*\s+seat:\s*([a-z0-9][a-z0-9-]*)$/i.exec(trimmed)
  if (seat !== null && seat[1] !== undefined) return seat[1].toLowerCase()
  for (const [pattern, seatId] of COUNCIL_LABEL_SEATS) {
    if (pattern.test(trimmed)) return seatId
  }
  return undefined
}

/**
 * Tool names the presentation transport owns. `tools.restrict()` refuses a
 * filter that names one, and the transport is inserted outside capability
 * filtering, so a group definition can never remove it.
 */
const RESERVED_PRESENTATION_NAMES: ReadonlySet<string> = new Set(['run_code'])

/**
 * The exact tool names the presentation filter must deny for one applied
 * attached set.
 *
 * The rule is deny-only and membership-driven: a name is denied ONLY when it
 * is a member of a disabled group, or of an enabled `on-demand` group that is
 * not attached. A tool belonging to no group — and the reserved presentation
 * transport — is never named here, so it stays present (fail open); only
 * explicit `on-demand` membership (or an operator disable) can remove a tool.
 * @param catalog - the resolved catalog.
 * @param attached - applied attached group ids.
 * @returns deny names in catalog order.
 */
export function denyNames(catalog: ResolvedToolGroups, attached: ReadonlySet<string>): string[] {
  const denied: string[] = []
  const seen = new Set<string>()
  for (const group of catalog.groups) {
    const hidden = !group.enabled || (group.mode === 'on-demand' && !attached.has(group.id))
    if (!hidden) continue
    for (const member of group.members) {
      if (seen.has(member) || RESERVED_PRESENTATION_NAMES.has(member)) continue
      seen.add(member)
      denied.push(member)
    }
  }
  return denied
}

/** One attach/detach decision. */
export type GroupActionPlan =
  | { readonly ok: true; readonly attached: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Decide one attach/detach against the current applied set without mutating
 * anything. Every refusal carries the reason the model reads.
 * @param catalog - the resolved catalog.
 * @param attached - applied attached group ids.
 * @param action - `attach` or `detach`.
 * @param groupId - the group the action names.
 * @param seat - the asking seat id; a seat-restricted group refuses other seats.
 * @returns the post-action attached set, or a refusal reason.
 */
export function planGroupAction(
  catalog: ResolvedToolGroups,
  attached: ReadonlySet<string>,
  action: 'attach' | 'detach',
  groupId: string,
  seat?: string,
): GroupActionPlan {
  const group = catalog.byId.get(groupId)
  if (group === undefined) {
    const known = catalog.groups.map(candidate => candidate.id).join(', ')
    return { ok: false, reason: `unknown tool group "${groupId}" (known: ${known})` }
  }
  if (!groupVisibleTo(group, seat)) {
    return { ok: false, reason: `tool group "${groupId}" is reserved for the ${(group.seats ?? []).join('/')} seat` }
  }
  if (!group.enabled) {
    return { ok: false, reason: `tool group "${groupId}" is disabled by the operator` }
  }
  if (group.mode === 'static') {
    return { ok: false, reason: `tool group "${groupId}" is always on; there is nothing to ${action}` }
  }
  if (action === 'attach') {
    if (attached.has(groupId)) return { ok: false, reason: `tool group "${groupId}" is already attached` }
    return { ok: true, attached: sortGroupIds([...attached, groupId]) }
  }
  if (!attached.has(groupId)) return { ok: false, reason: `tool group "${groupId}" is not attached` }
  return { ok: true, attached: sortGroupIds([...attached].filter(id => id !== groupId)) }
}

/**
 * Render the model-facing menu for the enabled on-demand groups. Static groups
 * are always present and need no menu entry; disabled groups are not offered.
 * A seat-restricted group the seat cannot attach still gets one notice line
 * naming the family and its owning seat, with no attach state and no attach
 * affordance, so the model is aware of every family it cannot use.
 * @param catalog - the resolved catalog.
 * @param attached - the attached group ids the current tool block reflects.
 * @param pending - attached group ids whose change lands at the next turn.
 * @param seat - the seat the menu renders for; omitted means an unknown seat,
 *   which sees only unrestricted groups plus the notices.
 * @returns the menu section text (empty when no on-demand group is available).
 */
export function renderMenuText(
  catalog: ResolvedToolGroups,
  attached: ReadonlySet<string>,
  pending: readonly string[] = [],
  seat?: string,
): string {
  const pendingSet = new Set(pending)
  const lines: string[] = []
  for (const group of catalog.groups) {
    if (group.mode !== 'on-demand' || !group.enabled) continue
    if (!groupVisibleTo(group, seat)) {
      const owner = (group.seats ?? [])
        .map(seatId => seatId.charAt(0).toUpperCase() + seatId.slice(1))
        .join('/')
      lines.push(`- ${group.id} — ${owner}-seat-only family (${String(group.members.length)} tools)`)
      continue
    }
    const state = pendingSet.has(group.id)
      ? 'attached — applies from the next turn'
      : attached.has(group.id) ? 'attached' : 'not attached'
    lines.push(`- ${group.id} — ${group.purpose} (${String(group.members.length)} tools, ${state})`)
  }
  if (lines.length === 0) return ''
  return [
    'Tool groups — extra tool families stay off until attached. Call tool_groups with action "attach" and the group id to add one; its tools appear in your tool list from the next turn. Detach the same way when a family is no longer needed.',
    ...lines,
  ].join('\n')
}
