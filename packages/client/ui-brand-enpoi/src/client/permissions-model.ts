/**
 * Doc 55 permission-policy model — wire types, pure helpers, and the
 * settings.describe / settings.mutate RPC wrappers for the
 * `enpoi-orchestration` namespace. Shared by the Capabilities Tier-1 strip
 * and the Permissions Settings section (same package).
 *
 * Writes are atomic per-path leaf ops (one `settings.mutate` call per rule,
 * `ns` + `args` wrapper mandatory). Whole-array keys (bashPatterns,
 * agents[name].available) go through the fenced writers below: every attempt
 * re-reads the live document (through the package's shared coalesced describe),
 * re-applies the operator's change onto that fresh value, and carries the read
 * revision as `expectedRevision`; a `settings/conflict` answer re-reads and
 * retries. The published view follows pushed `settings/document-updated`
 * refreshes plus the reconnect / visibility / stale-mount triggers, and a read
 * answering the published revision notifies nobody.
 */
import type { RoleRegistryMap } from './role-registry.ts'
import {
  OPERATOR_SURFACE,
  SHARED_CHILD_KEEP,
  SHIPPED_SEAT_TOOL_DENY,
  SHIPPED_TOOL_DEFAULTS,
  SHIPPED_TOOL_GROUP_CATALOG,
} from './permissions-defaults.generated.ts'
import { readEnpoiNamespace } from './settings-refresh.ts'

export type PolicyValue = 'allow' | 'ask' | 'deny'

/** One bash command pattern rule; first-match-wins over the tool policy. */
export interface BashPatternRule {
  pattern: string
  policy: PolicyValue
}

/** Per-agent overlay on the global policy. */
export interface AgentPermissions {
  tools?: Record<string, PolicyValue>
  bashPatterns?: BashPatternRule[]
  /** The role's tool allowlist; a sorted string[] is written whole. */
  available?: string[]
}

/** One standing allow-always grant (host-written). */
export interface PermissionGrant {
  id: string
  tool: string
  pattern?: string
  /**
   * The agent the grant is scoped to — or, when {@link PermissionGrant.global}
   * is true, the agent that asked for it (audit only, never a scope).
   */
  agent?: string
  /**
   * Host-written "Always allow" grants are global by design (`true`) and cover
   * all agents; the recorded agent stays on the record for auditability.
   */
  global?: boolean
  createdAt?: string
}

/** Doc 55 permission policy view (settings-backed; shipped defaults live in code). */
export interface PermissionsConfig {
  defaults?: { unknownTools?: PolicyValue }
  tools?: Record<string, PolicyValue>
  bashPatterns?: BashPatternRule[]
  agents?: Record<string, AgentPermissions>
  grants?: Record<string, PermissionGrant>
}

/** Server catalog entry (enpoi-orchestration.mcpServers), structural subset. */
export interface McpServerRef {
  serverName?: string
  url?: string
}

/** One server liveness entry (`enpoi-orchestration.mcpStatus`), structural subset. */
export interface McpStatusRef {
  mounted?: boolean
  state?: string
}

/** The settings.describe view of the enpoi-orchestration namespace the permissions UI reads. */
export interface OrchestrationSettingsView {
  ns?: string
  value?: {
    permissions?: PermissionsConfig
    mcpServers?: Record<string, McpServerRef>
    mcpStatus?: Record<string, McpStatusRef>
  }
}

/**
 * The shipped code defaults (not YAML) live in the GENERATED host mirror
 * (`permissions-defaults.generated.ts`): `SHIPPED_TOOL_DEFAULTS` and the
 * `SHIPPED_TOOL_DEFAULT_EXEMPTIONS` families. Never hand-declare a default
 * here — the parity spec fails when the mirror drifts from the host policy
 * resolver, and the host completeness spec fails until the mirror is
 * regenerated when a default changes.
 */

/**
 * The curated row ORDER and labels of the core tool surface (doc 55). This is
 * a presentation overlay only: PRESENCE comes from the live registry
 * projection (`buildPermissionToolRows` appends every registered tool this
 * list does not name), so a tool added by any plugin or upstream build shows
 * up with no code change here. Names listed here are shown even when the
 * deployment does not register them, so it carries only tools this
 * deployment's registry resolves.
 */
export const CORE_PERMISSION_TOOLS: readonly string[] = [
  'bash', 'read', 'read_image', 'glob', 'grep', 'edit', 'write', 'todo_write',
  'web_search', 'skill',
  'subagent', 'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  'tool_groups', 'present',
  'job_output', 'job_list', 'job_kill', 'oracle_review', 'request_evidence',
  'roundtable', 'chorus', 'memory_save', 'memory_search', 'memory_rescind',
  'memory_confirm', 'ask_user_question',
  'send_message', 'list_agents', 'interrupt_agent',
  'mcp', 'council_register', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager',
]

/**
 * The agents that act, delegate, and configure — the main agents. They lead
 * the Permissions rail under a distinct treatment; every other subject is a
 * sub-agent.
 */
export const MAIN_AGENT_IDS: readonly string[] = ['orchestrator', 'sysadmin', 'creator']

/** The shipped agent roster; agents present in `permissions.agents` merge in. */
export const AGENT_ROSTER: readonly string[] = [
  'orchestrator', 'sysadmin', 'creator', 'fixer', 'explorer', 'librarian', 'designer',
  'oracle', 'keeper', 'referee', 'chair', 'skeptic', 'architect', 'pragmatist',
  'visionary', 'experiencer', 'integrator', 'curator',
]

const POLICY_CYCLE: Record<PolicyValue, PolicyValue | undefined> = {
  allow: 'ask',
  ask: 'deny',
  deny: undefined,
}

/**
 * Advance one click on a policy chip: allow → ask → deny → inherit (undefined),
 * and inherit restarts at allow.
 * @param policy - current override; undefined means the subject inherits.
 * @returns the next override value, or undefined when the cycle wraps to inherit.
 */
export function cyclePolicy(policy: PolicyValue | undefined): PolicyValue | undefined {
  return policy === undefined ? 'allow' : POLICY_CYCLE[policy]
}

/**
 * Merge the shipped roster with user-added agent names (e.g. new council
 * roles). Roster order is preserved; extras are appended sorted; duplicates
 * and empty names are dropped.
 * @param roster - shipped agent names in display order.
 * @param extraNames - names found in `permissions.agents`.
 * @returns the merged rail list.
 */
export function buildAgentList(roster: readonly string[], extraNames: Iterable<string>): string[] {
  const list = [...roster]
  const extras = [...extraNames]
    .filter(name => name !== '' && !list.includes(name))
    .sort((left, right) => left.localeCompare(right))
  return [...list, ...extras]
}

/** One left-rail subject: the policy key plus its display label. */
export interface PermissionSubject {
  id: string
  label: string
  /** True for the main agents (orchestrator/sysadmin/creator) — rail-top group. */
  main?: boolean
}

/**
 * Build the subject rail: the main agents first (fixed order, flagged for the
 * distinct treatment), then registry roles (labelled), then the shipped
 * roster, then names found only in `permissions.agents` — deduped by id.
 * @param registry - the effective role registry.
 * @param roster - shipped agent names in display order.
 * @param extraNames - names found in `permissions.agents`.
 * @returns the merged rail subjects.
 */
export function buildAgentSubjects(
  registry: RoleRegistryMap,
  roster: readonly string[],
  extraNames: Iterable<string>,
): PermissionSubject[] {
  const subjects: PermissionSubject[] = []
  const seen = new Set<string>()
  for (const id of MAIN_AGENT_IDS) {
    if (seen.has(id)) continue
    seen.add(id)
    subjects.push({ id, label: registry[id]?.label ?? id, main: true })
  }
  for (const [id, entry] of Object.entries(registry)) {
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    subjects.push({ id, label: entry.label ?? id })
  }
  for (const id of buildAgentList(roster, extraNames)) {
    if (seen.has(id)) continue
    seen.add(id)
    subjects.push({ id, label: id })
  }
  return subjects
}

/**
 * Count diff-only rules (global + per-agent tool rules) and standing grants.
 * Bash pattern rules are configuration, not counted as rules.
 * @param perms - the permissions section, or undefined when unconfigured.
 * @returns the Tier-1 strip counters.
 */
export function countPermissionRules(perms: PermissionsConfig | undefined): { rules: number; grants: number } {
  // Rules the operator authored: global tool rows, per-agent rows, and bash
  // patterns. The shipped baseline (allow reads, ask on danger commands) is not
  // counted — it is not something the operator wrote.
  let rules = Object.keys(perms?.tools ?? {}).length + (perms?.bashPatterns?.length ?? 0)
  for (const agent of Object.values(perms?.agents ?? {})) {
    rules += Object.keys(agent?.tools ?? {}).length + (agent?.bashPatterns?.length ?? 0)
  }
  return { rules, grants: Object.keys(perms?.grants ?? {}).length }
}

/** Title-case a tool id into a readable label (`todo_write` → "Todo Write"). */
function prettyToolName(id: string): string {
  return id.split(/[_\s]+/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The scope hint for one standing grant. A host-written grant is global even
 * though it records the asking agent (`global: true`): it reads "all agents"
 * with the agent kept as audit ("requested by <agent>"). A grant without
 * `global` is scoped to the agent it names.
 * @param grant - the standing grant.
 * @returns the row hint, e.g. "all agents · allow always · requested by fixer"
 *   or "agent: fixer · allow always".
 */
export function grantScopeHint(grant: PermissionGrant): string {
  const agent = typeof grant.agent === 'string' && grant.agent !== '' ? grant.agent : undefined
  if (grant.global === true) {
    return agent === undefined ? 'all agents · allow always' : `all agents · allow always · requested by ${agent}`
  }
  return agent === undefined ? 'all agents · allow always' : `agent: ${agent} · allow always`
}

/**
 * How one policy row behaves. `tool` is a concrete key. `mcp-group` (a server
 * wildcard), `mcp-master` (`mcp__*`), and `family` (a curated prefix family
 * such as `whiteboard_*`) are DERIVED aggregates: they own no settings key of
 * their own — their chip state is computed from {@link PermissionToolRow.members}
 * and a click fans the policy out to every member.
 */
export type PermissionRowKind = 'tool' | 'mcp-group' | 'mcp-master' | 'family'

/** One policy row: the tools-map key plus a display label. */
export interface PermissionToolRow {
  id: string
  name: string
  kind?: PermissionRowKind
  /**
   * Concrete tool names a derived aggregate row covers. Only set for
   * `mcp-group` (that server's live tools), `mcp-master` (every concrete MCP
   * tool), and `family` (the curated members plus live prefix matches).
   */
  members?: readonly string[]
}

/** The `enpoiCapabilities.mcpTools` answer: the live MCP tool names. */
export interface McpToolsView {
  tools: string[]
}

/** The `enpoiCapabilities.registeredTools` answer: every live tool name. */
export interface RegisteredToolsView {
  tools: string[]
}

/**
 * Curated tool family: a presentation overlay that folds a tool prefix into
 * ONE permanent policy row. Membership is derived from the live registry (any
 * registered name with the prefix) plus {@link PolicyFamilyOverlay.members};
 * the row itself owns no independent settings key — its chip fans out to the
 * concrete member keys.
 */
export interface PolicyFamilyOverlay {
  /** The row id (also the resolver-independent display key), e.g. `whiteboard_*`. */
  id: string
  name: string
  /** Live prefix matches the family folds in; absent when its members share no prefix. */
  prefix?: string
  /** Tools the family always names, so the permanent policy survives an unmounted plugin. */
  members: readonly string[]
  /**
   * Live prefix matches the family deliberately leaves as their own concrete
   * rows. A member whose shipped policy differs (council registration asks
   * while listing allows) must not hide behind one family chip.
   */
  exclude?: readonly string[]
}

/**
 * One family per shipped tool group, derived from the generated catalog. The
 * catalog is the host's allocation unit — the `tool_groups` menu, the per-seat
 * pre-attach table, and this page's aggregate rows all read it — so a group
 * edit in the profile regenerates this list instead of drifting.
 *
 * A group folds only when at least two members share one shipped policy; a
 * member whose policy differs (the asking `council_register` and `job_kill`)
 * stays its own concrete row, so a family chip never hides a mixed decision.
 * `core` is skipped: it is the everyday per-tool surface, and folding it would
 * erase the per-tool decisions this page exists to set.
 * @returns family overlays in catalog order.
 */
function buildPolicyFamilies(): PolicyFamilyOverlay[] {
  const families: PolicyFamilyOverlay[] = []
  for (const group of SHIPPED_TOOL_GROUP_CATALOG) {
    if (!group.enabled || group.id === 'core') continue
    const byPolicy = new Map<PolicyValue, string[]>()
    for (const member of group.members) {
      const policy = shippedPolicyFor(member) ?? 'ask'
      byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), member])
    }
    const modal = [...byPolicy.values()].sort((left, right) => right.length - left.length)[0] ?? []
    if (modal.length < 2) continue
    const excluded = group.members.filter(member => !modal.includes(member))
    const prefix = commonPrefix(modal)
    families.push({
      id: `${group.id}_*`,
      name: group.label,
      ...(prefix === undefined ? {} : { prefix }),
      members: modal,
      ...(excluded.length === 0 ? {} : { exclude: excluded }),
    })
  }
  return families
}

/** The longest `snake_case` prefix (ending `_`) every name shares, if any. */
function commonPrefix(names: readonly string[]): string | undefined {
  const first = names[0]
  if (first === undefined) return undefined
  let end = first.length
  for (const name of names) {
    let index = 0
    while (index < end && index < name.length && name[index] === first[index]) index += 1
    end = index
  }
  const prefix = first.slice(0, end)
  return prefix.endsWith('_') ? prefix : undefined
}

/**
 * The tool-policy families, derived from the shipped tool-group catalog at
 * module load. Add or move a tool in the profile catalog, regenerate the
 * mirror, and this list follows — it is never hand-maintained here.
 */
export const POLICY_FAMILIES: readonly PolicyFamilyOverlay[] = Object.freeze(buildPolicyFamilies())

/** Curated label overrides where the mechanical humanizer reads wrong. */
export const TOOL_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  mcp: 'MCP servers (mount / unmount)',
}

/** One MCP server group: the server wildcard key plus its live public tools. */
export interface McpToolGroup {
  server: string
  /** The exact key the host policy ladder matches: `mcp__<server>__*`. */
  wildcard: string
  tools: string[]
}

/** The server name a catalog entry mounts under (mirrors the host mount). */
function serverNameOf(id: string, def: McpServerRef | undefined): string {
  return typeof def?.serverName === 'string' && def.serverName !== '' ? def.serverName : id.replace(/-mcp$/, '')
}

/**
 * Group live `mcp__<server>__<tool>` names under their server. Catalog servers
 * keep a header even with no live tools, so the server policy can be set
 * before the first mount; a name whose server left the catalog falls back to
 * the `__`-segment the host resolver's wildcard ladder reads.
 * @param mcpServers - the enpoi-orchestration.mcpServers describe data.
 * @param mcpToolNames - the live names from `enpoiCapabilities.mcpTools`.
 * @returns one group per server, catalog order first.
 */
export function groupMcpToolNames(
  mcpServers: Record<string, McpServerRef> | undefined,
  mcpToolNames: readonly string[],
): McpToolGroup[] {
  const known = Object.entries(mcpServers ?? {}).map(([id, def]) => serverNameOf(id, def))
  const groups = new Map<string, string[]>()
  for (const server of known) {
    if (!groups.has(server)) groups.set(server, [])
  }
  for (const name of mcpToolNames) {
    if (!name.startsWith('mcp__')) continue
    const server = known
      .filter(candidate => name.startsWith(`mcp__${candidate}__`))
      .sort((left, right) => right.length - left.length)[0]
      ?? name.split('__')[1]
      ?? ''
    if (server === '') continue
    const tools = groups.get(server)
    if (tools === undefined) groups.set(server, [name])
    else tools.push(name)
  }
  return [...groups.entries()].map(([server, tools]) => ({
    server,
    wildcard: `mcp__${server}__*`,
    tools: [...tools].sort((left, right) => left.localeCompare(right)),
  }))
}

/**
 * Build the tool-row list for one subject from the LIVE tool registry:
 * the curated core rows (order/labels only), then one curated family row per
 * {@link POLICY_FAMILIES} overlay, then every other registered tool this list
 * does not name, then one derived server row + one row per REAL tool per
 * mounted MCP server, and finally the derived `mcp__*` master row. Presence is
 * never gated by the curated list: a tool registered by any plugin, a future
 * MCP server, or an upstream addition appears automatically. The aggregate
 * rows own no settings key — their chips derive from and fan out to their
 * `members`.
 * @param mcpServers - the enpoi-orchestration.mcpServers describe data.
 * @param mcpToolNames - live MCP names from `enpoiCapabilities.mcpTools` (empty when unavailable).
 * @param liveToolNames - every live name from `enpoiCapabilities.registeredTools`.
 * @returns ordered rows, the `mcp__*` master last.
 */
export function buildPermissionToolRows(
  mcpServers: Record<string, McpServerRef> | undefined,
  mcpToolNames: readonly string[] = [],
  liveToolNames: readonly string[] = [],
): PermissionToolRow[] {
  // The matrix rows are REAL tools (doc 55 P2 redesign). Specialist names
  // (fixer/explorer/…) are ROLE SUBJECTS in the left rail, not tool rows;
  // the context keeper is a background service, not an agent-dispatchable
  // tool. The old `mcp__<server>*` key never matched the host resolver's
  // ladder (`mcp__<server>__*`); the group-header key now does.
  const live = [...new Set(liveToolNames.filter(name => typeof name === 'string' && name !== ''))]
  const mcpNames = [...new Set([...mcpToolNames, ...live])]
    .filter(name => name.startsWith('mcp__'))
    .sort((left, right) => left.localeCompare(right))
  const nonMcp = live.filter(name => !name.startsWith('mcp__'))

  const rows = new Map<string, PermissionToolRow>()
  const families = POLICY_FAMILIES.map((family) => {
    const prefix = family.prefix
    const liveMembers = prefix === undefined ? [] : nonMcp.filter(name =>
      name.startsWith(prefix) && !(family.exclude ?? []).includes(name))
    const members = [...new Set([...family.members, ...liveMembers])]
      .sort((left, right) => left.localeCompare(right))
    return { family, members }
  })
  const folded = new Set(families.flatMap(entry => entry.members))

  for (const id of CORE_PERMISSION_TOOLS) {
    if (folded.has(id)) continue
    rows.set(id, { id, name: TOOL_LABEL_OVERRIDES[id] ?? prettyToolName(id), kind: 'tool' })
  }
  for (const { family, members } of families) {
    rows.set(family.id, { id: family.id, name: family.name, kind: 'family', members })
  }
  for (const id of nonMcp) {
    if (rows.has(id) || folded.has(id)) continue
    rows.set(id, { id, name: TOOL_LABEL_OVERRIDES[id] ?? prettyToolName(id), kind: 'tool' })
  }

  const groups = groupMcpToolNames(mcpServers, mcpNames).filter(group => group.tools.length > 0)
  const concreteMcp: string[] = []
  for (const group of groups) {
    rows.set(group.wildcard, {
      id: group.wildcard,
      name: `${group.server} (MCP)`,
      kind: 'mcp-group',
      members: group.tools,
    })
    for (const tool of group.tools) {
      rows.set(tool, { id: tool, name: tool, kind: 'tool' })
      concreteMcp.push(tool)
    }
  }
  concreteMcp.sort((left, right) => left.localeCompare(right))
  // Derived master: never an independently persisted key. Its members are the
  // concrete MCP tool names; the server rows above pre-cover a server's future
  // tools only through their own derived chips.
  rows.set('mcp__*', { id: 'mcp__*', name: 'All MCP tools', kind: 'mcp-master', members: concreteMcp })
  return [...rows.values()]
}

/**
 * Read EVERY live tool name from the host registry
 * (`enpoiCapabilities.registeredTools`). The host projects
 * `ctx.tools.schemas()` on every call, so the answer follows mounts and new
 * plugins; a failed read is `undefined` and the caller keeps the previous rows.
 * @returns sorted tool names, or undefined when the RPC fails.
 */
export async function fetchRegisteredToolNames(): Promise<string[] | undefined> {
  try {
    const res = await fetch('/api/enpoiCapabilities.registeredTools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCapabilities.registeredTools',
        rpcId: nextRpcId('registered-tools'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { ok?: boolean; value?: { tools?: unknown } } }
    if (json.result?.ok !== true) return undefined
    const tools = json.result.value?.tools
    if (!Array.isArray(tools)) return undefined
    return tools
      .filter((name): name is string => typeof name === 'string' && name !== '')
      .sort((left, right) => left.localeCompare(right))
  } catch {
    // Transport failure: the matrix keeps the curated core rows.
    return undefined
  }
}

/**
 * Read the live MCP tool names from the host registry
 * (`enpoiCapabilities.mcpTools`). The host projects `ctx.tools.schemas()` on
 * every call, so the answer follows mounts; a failed read is `undefined` and
 * the caller keeps the previous rows.
 * @returns sorted `mcp__<server>__<tool>` names, or undefined when the RPC fails.
 */
export async function fetchMcpToolNames(): Promise<string[] | undefined> {
  try {
    const res = await fetch('/api/enpoiCapabilities.mcpTools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCapabilities.mcpTools',
        rpcId: nextRpcId('mcp-tools'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { ok?: boolean; value?: { tools?: unknown } } }
    if (json.result?.ok !== true) return undefined
    const tools = json.result.value?.tools
    if (!Array.isArray(tools)) return undefined
    return tools
      .filter((name): name is string => typeof name === 'string' && name.startsWith('mcp__'))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    // Transport failure: the matrix falls back to header-only server rows.
    return undefined
  }
}

/** Which layer owns a subject's effective tool policy. */
export type PermissionProvenance = 'agent rule' | 'global rule' | 'standing grant' | 'inherit (default)'

/**
 * Tools every child keeps regardless of role surface: the pinned whiteboard
 * keep list of the subagent runtime (`SHARED_CHILD_KEEP` in tool-subagent).
 * Generated from that host table, so the availability eye tells the truth for
 * roles whose shipped surface predates the keep list.
 */
export const KEPT_BY_EVERY_ROLE: readonly string[] = SHARED_CHILD_KEEP

/**
 * Whether a tool-level standing grant absorbs an ask for this tool under this
 * subject — the same test the host resolver's `grantsShortCircuit` uses for
 * tier 'tool': no pattern, and either global or scoped to the asking agent.
 * @param perms - the live permissions section.
 * @param agent - the selected agent, or undefined for the Global subject.
 * @param tool - the tools-map key.
 * @returns true when an allow-always grant covers this tool.
 */
export function toolGrantApplies(perms: PermissionsConfig, agent: string | undefined, tool: string): boolean {
  for (const grant of Object.values(perms.grants ?? {})) {
    if (grant.tool !== tool) continue
    if (grant.pattern !== undefined) continue
    if (grant.global === true || grant.agent === undefined || grant.agent === agent) return true
  }
  return false
}

/**
 * Resolve the provenance shown beside one policy chip: the agent's own rule
 * wins, then the global rule, then the shipped/configured defaults.
 * @param perms - the live permissions section.
 * @param agent - the selected agent, or undefined for the Global subject.
 * @param tool - the tools-map key.
 */
/**
 * The operator-level shipped surface. The generated `OPERATOR_SURFACE` is the
 * host's advertised inventory — the shared main-agent surface WITHOUT the
 * creator tool group, because that group pre-attaches to the creator seat
 * alone (orchestrator and sysadmin never see its three tools; the host's seat
 * guard is the execution backstop). MCP server tools are deliberately absent
 * from the inventory: MCP availability is a sidebar capability toggle
 * (per-server, hot-swappable), not a per-role surface decision.
 */
const SHARED_OPERATOR_SURFACE: readonly string[] = OPERATOR_SURFACE

/**
 * The shipped advertised surface for one operator seat: the shared inventory
 * plus the members of every enabled catalog group the seat pre-attaches that
 * the shared inventory does not already name, minus the seat's execution deny
 * backstop. The creator seat therefore holds the shared surface plus the
 * creator tool group; orchestrator and sysadmin hold the shared surface alone.
 * @param seat - the operator seat id (preset identity).
 * @returns the seat's shipped surface, in shared-inventory order.
 */
export function operatorSurfaceFor(seat: string): readonly string[] {
  const extra: string[] = []
  for (const group of SHIPPED_TOOL_GROUP_CATALOG) {
    if (!group.enabled || !group.preAttach.includes(seat)) continue
    // A group the shared inventory already reflects (debug) adds nothing.
    if (group.preAttach.includes('orchestrator')) continue
    for (const member of group.members) {
      if (!extra.includes(member)) extra.push(member)
    }
  }
  const denied = new Set(SHIPPED_SEAT_TOOL_DENY[seat] ?? [])
  return [...new Set([...SHARED_OPERATOR_SURFACE, ...extra])].filter(name => !denied.has(name))
}

/**
 * The shipped per-role surfaces (mirrors the fork's ROLE_CHILD_DENY table +
 * the shared worker deny list — the tools each role CAN see by default).
 * Drives the availability eye when the role has no `available` override:
 * built-in-visible tools show on, everything else shows crossed-out. The
 * operator rows are the host's advertised main-agent surfaces, derived per
 * seat from the catalog's pre-attach table (see {@link operatorSurfaceFor});
 * the specialist/council rows are the client's conservative fallback surface,
 * parity-guarded against the host's shared/role child deny tables (the spec
 * fails if a surface ever names a tool the host hard-denies for that role).
 * MCP rows are deliberately absent — MCP availability is a sidebar capability
 * toggle, not a per-role surface decision. Every name must resolve in the
 * deployment's live registry: a role's `available` list is applied as a strict
 * `tools.restrict({allow})` at spawn, so a stale name would abort the child.
 */
export const BUILT_ROLE_SURFACE: Record<string, readonly string[]> = {
  orchestrator: operatorSurfaceFor('orchestrator'),
  sysadmin: operatorSurfaceFor('sysadmin'),
  creator: operatorSurfaceFor('creator'),
  fixer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'todo_write', 'skill', 'memory_search', 'memory_save', 'web_search'],
  designer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'todo_write', 'skill', 'memory_search', 'memory_save', 'web_search'],
  explorer: ['bash', 'read', 'glob', 'grep', 'read_image', 'todo_write', 'skill', 'memory_search', 'memory_save'],
  librarian: ['bash', 'read', 'glob', 'grep', 'read_image', 'todo_write', 'skill', 'memory_search', 'memory_save', 'web_search'],
  oracle: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'todo_write', 'skill', 'memory_search', 'memory_save', 'memory_rescind', 'memory_confirm', 'web_search', 'request_evidence', 'subagent'],
  referee: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  chair: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  skeptic: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  architect: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  pragmatist: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  visionary: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  experiencer: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  integrator: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
  curator: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'memory_search', 'todo_write'],
}

/**
 * The effective fallback surface for one role when the Permissions page has no
 * explicit `agents[role].available`: the registry role's `tools.available`
 * (Dynamic → Roles) wins, then the shipped role table. The caller reads the
 * permissions allowlist first — it is the operator's hard gate.
 * @param agent - the subject role id, or undefined.
 * @param registry - the effective role registry.
 * @returns the fallback allowlist, or undefined when the role has no surface.
 */
export function roleSurfaceFor(agent: string | undefined, registry?: RoleRegistryMap): readonly string[] | undefined {
  if (agent === undefined) return undefined
  const available = registry?.[agent]?.tools?.available
  const surface = Array.isArray(available) ? available : BUILT_ROLE_SURFACE[agent]
  if (surface === undefined) return undefined
  return [...new Set([...surface, ...KEPT_BY_EVERY_ROLE])]
}

/**
 * Whether the shipped seat guard structurally denies one tool to one seat.
 * The Permissions eye must not write an allowlist entry for such a tool: the
 * seat's presentation filter and its pre-execute guard both ignore the entry,
 * so a toggle would only paint a false available state.
 * @param agent - the subject role id, or undefined.
 * @param tool - the tool name.
 * @returns true when `SHIPPED_SEAT_TOOL_DENY` names the tool for this seat.
 */
export function seatDeniesTool(agent: string | undefined, tool: string): boolean {
  if (agent === undefined) return false
  return (SHIPPED_SEAT_TOOL_DENY[agent] ?? []).includes(tool)
}

/**
 * Fallback availability for one role×tool when the Permissions page has no
 * explicit allowlist entry: the registry role's surface (Dynamic → Roles)
 * decides, then the shipped role table; undefined = no known surface.
 * @param agent - the subject role id, or undefined.
 * @param tool - the tools-map key.
 * @param registry - the effective role registry.
 * @returns true/false when a surface names the tool, otherwise undefined.
 */
export function builtRoleAvailability(agent: string | undefined, tool: string, registry?: RoleRegistryMap): boolean | undefined {
  const surface = roleSurfaceFor(agent, registry)
  if (surface === undefined) return undefined
  return surface.includes(tool)
}

export function provenanceFor(perms: PermissionsConfig, agent: string | undefined, tool: string): PermissionProvenance {
  if (agent !== undefined && perms.agents?.[agent]?.tools?.[tool] !== undefined) return 'agent rule'
  if (perms.tools?.[tool] !== undefined) return 'global rule'
  // A standing grant only matters where the shipped/configured answer asks.
  if (effectivePolicy(perms, agent, tool) === 'allow' && toolGrantApplies(perms, agent, tool)) return 'standing grant'
  return 'inherit (default)'
}

/**
 * The shipped code-default policy for one tool, or undefined when the tool
 * falls back to `defaults.unknownTools`.
 * @param tool - the tools-map key.
 * @returns the shipped policy from the generated host mirror, when the host
 *   policy resolver defines one for this key.
 */
export function shippedPolicyFor(tool: string): PolicyValue | undefined {
  return SHIPPED_TOOL_DEFAULTS[tool]
}

/**
 * The effective policy a subject receives for one tool: agent rule, then
 * global rule, then the shipped default, then `defaults.unknownTools`, then
 * the shipped unknown-tools answer (ask). An answer of `ask` is absorbed by a
 * matching tool-level standing grant — exactly what the host resolver does —
 * so a granted tool reads `allow · standing grant` instead of a bare ask.
 * @param perms - the live permissions section.
 * @param agent - the selected agent, or undefined for the Global subject.
 * @param tool - the tools-map key.
 */
export function effectivePolicy(perms: PermissionsConfig, agent: string | undefined, tool: string): PolicyValue {
  if (agent !== undefined) {
    const agentPolicy = perms.agents?.[agent]?.tools?.[tool]
    if (agentPolicy !== undefined) return agentPolicy
  }
  const globalPolicy = perms.tools?.[tool]
  if (globalPolicy !== undefined) return globalPolicy
  const fallback = shippedPolicyFor(tool) ?? perms.defaults?.unknownTools ?? 'ask'
  if (fallback === 'ask' && toolGrantApplies(perms, agent, tool)) return 'allow'
  return fallback
}

/** One subject's own override for a key (agent tier when the subject is an agent). */
function ownOverrideOf(perms: PermissionsConfig, agent: string | undefined, tool: string): PolicyValue | undefined {
  if (agent !== undefined) return perms.agents?.[agent]?.tools?.[tool]
  return perms.tools?.[tool]
}

/**
 * Whether a row is a DERIVED aggregate: it owns no settings key of its own,
 * its chip state comes from its members, and a click fans out to them.
 * @param row - the policy row.
 * @returns true for `mcp-group`, `mcp-master`, and `family` rows.
 */
export function isAggregateRow(row: PermissionToolRow): boolean {
  return row.kind === 'mcp-group' || row.kind === 'mcp-master' || row.kind === 'family'
}

/**
 * The concrete keys a row's toggle writes: the members for aggregate rows,
 * the row id itself for a plain tool row.
 * @param row - the policy row.
 * @returns the concrete tools-map keys.
 */
export function rowTargets(row: PermissionToolRow): string[] {
  if (isAggregateRow(row)) return [...(row.members ?? [])]
  return [row.id]
}

/** What one row's chips show. */
export interface RowPolicyState {
  /** The subject's own rule shown as the filled chip (undefined = inherit). */
  ownOverride: PolicyValue | undefined
  /** The effective policy (dashed chip when ownOverride is undefined). */
  effective: PolicyValue
  /** True when an aggregate's members disagree — no chip is highlighted. */
  mixed: boolean
  provenance: PermissionProvenance | 'derived' | 'legacy aggregate' | 'mixed'
}

/**
 * The display state of one row for one subject. A plain row resolves exactly
 * as before. An aggregate resolves uniformly when every member carries the
 * same own rule (or none does), and is `mixed` otherwise; a legacy persisted
 * aggregate key (the row's own id) is surfaced as `legacy aggregate` until the
 * operator's next click folds it into the concrete member keys.
 * @param perms - the live permissions section.
 * @param agent - the selected agent, or undefined for the Global subject.
 * @param row - the policy row.
 * @returns the row's chip state.
 */
export function rowPolicyState(perms: PermissionsConfig, agent: string | undefined, row: PermissionToolRow): RowPolicyState {
  if (!isAggregateRow(row)) {
    return {
      ownOverride: ownOverrideOf(perms, agent, row.id),
      effective: effectivePolicy(perms, agent, row.id),
      mixed: false,
      provenance: provenanceFor(perms, agent, row.id),
    }
  }
  const targets = rowTargets(row)
  const legacy = ownOverrideOf(perms, agent, row.id)
  if (targets.length === 0) {
    return {
      ownOverride: legacy,
      effective: legacy ?? effectivePolicy(perms, agent, row.id),
      mixed: false,
      provenance: legacy === undefined ? 'inherit (default)' : 'legacy aggregate',
    }
  }
  const overrides = targets.map(target => ownOverrideOf(perms, agent, target))
  const defined = [...new Set(overrides.filter((value): value is PolicyValue => value !== undefined))]
  const uniform = defined.length <= 1 && (defined.length === 0 || overrides.every(value => value !== undefined))
  const only = defined[0]
  if (!uniform) {
    return { ownOverride: undefined, effective: commonEffectivePolicy(perms, agent, targets) ?? legacy ?? 'ask', mixed: true, provenance: 'mixed' }
  }
  if (only !== undefined) {
    return { ownOverride: only, effective: only, mixed: false, provenance: 'derived' }
  }
  if (legacy !== undefined) {
    return { ownOverride: legacy, effective: legacy, mixed: false, provenance: 'legacy aggregate' }
  }
  const common = commonEffectivePolicy(perms, agent, targets)
  return {
    ownOverride: undefined,
    effective: common ?? 'ask',
    mixed: common === undefined,
    provenance: common === undefined ? 'mixed' : 'derived',
  }
}

/** The one effective policy every target shares, or undefined when they differ. */
function commonEffectivePolicy(perms: PermissionsConfig, agent: string | undefined, targets: readonly string[]): PolicyValue | undefined {
  const values = [...new Set(targets.map(target => effectivePolicy(perms, agent, target)))]
  return values.length === 1 ? values[0] : undefined
}

/** One path op a row toggle persists (inside the permissions section). */
export interface RowPolicyOp {
  op: 'set' | 'unset'
  path: (string | number)[]
  value?: PolicyValue
}

/**
 * The persistence ops for one row toggle: set/unset every concrete member key
 * (or the row's own key for a plain row) and, for an aggregate, unset the
 * legacy aggregate key when it exists — the aggregate is never an independent
 * second key. Existing standing grants are untouched.
 * @param row - the policy row.
 * @param basePath - `['tools']` (Global) or `['agents', agent, 'tools']`.
 * @param next - the chosen policy, or undefined for inherit.
 * @returns the ops to persist.
 */
export function rowPolicyOps(row: PermissionToolRow, basePath: readonly (string | number)[], next: PolicyValue | undefined): RowPolicyOp[] {
  const targets = rowTargets(row)
  const ops: RowPolicyOp[] = targets.map(target => (
    next === undefined
      ? { op: 'unset', path: [...basePath, target] }
      : { op: 'set', path: [...basePath, target], value: next }
  ))
  if (isAggregateRow(row) && !targets.includes(row.id)) {
    ops.push({ op: 'unset', path: [...basePath, row.id] })
  }
  return ops
}

/**
 * Whether a role's tool checkbox for one row reads checked: every concrete
 * member of an aggregate (or the row itself) is in the allowlist.
 * @param row - the policy row.
 * @param available - the role's effective allowlist.
 * @returns true when all members are present.
 */
export function roleRowChecked(row: PermissionToolRow, available: readonly string[]): boolean {
  const targets = rowTargets(row)
  return targets.length > 0 && targets.every(target => available.includes(target))
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** One describe view of the enpoi-orchestration namespace the permissions UI reads. */
export interface OrchestrationSettingsView {
  ns?: string
  /** Monotonic revision the namespace was read at; the whole-array write fence. */
  revision?: number
  value?: {
    permissions?: PermissionsConfig
    mcpServers?: Record<string, McpServerRef>
    mcpStatus?: Record<string, McpStatusRef>
  }
}

/**
 * Read the enpoi-orchestration namespace through the shared coalesced read:
 * concurrent callers (the other stores included) share one settings.describe.
 * @returns the namespace view, or undefined on a failed or malformed answer.
 */
export async function describePermissionsView(): Promise<OrchestrationSettingsView | undefined> {
  return await readEnpoiNamespace() as unknown as OrchestrationSettingsView | undefined
}

// --- cross-client live view -------------------------------------------------

/** The latest describe answer, or undefined before the first successful read. */
let latestView: OrchestrationSettingsView | undefined
/** True when no read has succeeded yet and the gateway is unreachable. */
let latestFailed = false
/**
 * Revision last published. A read answering the same revision carries the
 * document this view already holds, so it is skipped without a notify.
 */
let lastAppliedRevision: number | undefined
const viewListeners = new Set<() => void>()
/**
 * Paths (relative to the permissions section) with a local write in flight.
 * A pending path's optimistic local value wins over a refresh until it settles.
 */
const pendingPaths = new Set<string>()

/** Snapshot of the live permissions view for the settings section. */
export interface PermissionsViewState {
  view: OrchestrationSettingsView | undefined
  failed: boolean
}

function notifyView(): void {
  for (const listener of viewListeners) {
    listener()
  }
}

/** Synchronous snapshot reader for the settings section. */
export function getPermissionsViewState(): PermissionsViewState {
  return { view: latestView, failed: latestFailed }
}

/**
 * Subscribe to permissions-view changes pushed by `refreshFromServer`.
 * @param listener - called after each successful or failed refresh.
 * @returns unsubscribe function.
 */
export function subscribePermissionsView(listener: () => void): () => void {
  viewListeners.add(listener)
  return () => viewListeners.delete(listener)
}

/**
 * Re-read the namespace and publish the fresh view (cross-client live sync).
 * A failed read keeps the previous view so an offline blip never blanks the
 * settings page.
 */
export async function refreshFromServer(): Promise<void> {
  let view: OrchestrationSettingsView | undefined
  try {
    view = await describePermissionsView()
  } catch {
    // Transport failure: treated like an unreachable gateway below.
    view = undefined
  }
  if (view === undefined) {
    if (latestView === undefined) {
      latestFailed = true
      notifyView()
    }
    return
  }
  if (view.revision !== undefined && view.revision === lastAppliedRevision) return
  lastAppliedRevision = view.revision
  latestView = view
  latestFailed = false
  notifyView()
}

// --- path helpers for the pending-overlay merge -----------------------------

/** Read a JSON path out of a plain document (undefined when it is absent). */
function readPathAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string | number, unknown>)[segment]
  }
  return node
}

/** Write a JSON path into a freshly cloned plain document. */
function writePathAt(root: Record<string | number, unknown>, path: readonly (string | number)[], value: unknown): void {
  let node: Record<string | number, unknown> = root
  for (let index = 0; index < path.length - 1; index++) {
    const child = node[path[index] as string | number]
    if (child === null || typeof child !== 'object') {
      const next: Record<string | number, unknown> = {}
      node[path[index] as string | number] = next
      node = next
    } else {
      node = child as Record<string | number, unknown>
    }
  }
  node[path[path.length - 1] as string | number] = value
}

/** Delete a JSON path from a freshly cloned plain document. */
function deletePathAt(root: Record<string | number, unknown>, path: readonly (string | number)[]): void {
  let node: Record<string | number, unknown> = root
  for (let index = 0; index < path.length - 1; index++) {
    const child = node[path[index] as string | number]
    if (child === null || typeof child !== 'object') return
    node = child as Record<string | number, unknown>
  }
  Reflect.deleteProperty(node, path[path.length - 1] as string | number)
}

/**
 * Merge one server permissions section with the local optimistic state: every
 * path without an in-flight write follows the server; a pending path keeps the
 * local value (or its local absence) until the write settles.
 * @param server - the fresh `permissions` section from a describe.
 * @param local - the page's optimistic section.
 * @returns the section the page should render.
 */
export function mergeServerPermissionsWithPending(
  server: PermissionsConfig | undefined,
  local: PermissionsConfig,
): PermissionsConfig {
  const merged = structuredClone(server ?? {}) as Record<string | number, unknown>
  for (const key of pendingPaths) {
    const path = JSON.parse(key) as (string | number)[]
    const value = readPathAt(local, path)
    if (value === undefined) deletePathAt(merged, path)
    else writePathAt(merged, path, structuredClone(value))
  }
  return merged as PermissionsConfig
}

// --- writes -----------------------------------------------------------------

/** One mutate answer: whether it persisted, and whether it failed on the revision fence. */
interface MutationOutcome {
  ok: boolean
  conflict: boolean
}

/** One raw `settings.mutate` op inside the permissions section. */
interface PermissionPathOp {
  op: 'set' | 'unset'
  path: (string | number)[]
  value?: unknown
}

/** Post one mutation op; only an explicit `ok: true` result counts as persisted. */
async function postMutation(op: PermissionPathOp, expectedRevision: number | undefined): Promise<MutationOutcome> {
  const args: Record<string, unknown> = { ns: 'enpoi-orchestration', ops: [op] }
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision
  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: nextRpcId('perm-mutate'),
        payload: { args },
      }),
    })
    if (!res.ok) return { ok: false, conflict: false }
    const json = await res.json() as { result?: { ok?: boolean; error?: { code?: string } } }
    if (json?.result?.ok === true) return { ok: true, conflict: false }
    return { ok: false, conflict: json?.result?.error?.code === 'settings/conflict' }
  } catch {
    // Transport failure: not a revision conflict, so the caller stops retrying.
    return { ok: false, conflict: false }
  }
}

/** Run one path's pending marker for the lifetime of its write. */
async function withPendingPath<T>(path: readonly (string | number)[], run: () => Promise<T>): Promise<T> {
  const key = JSON.stringify(path)
  pendingPaths.add(key)
  try {
    return await run()
  } finally {
    pendingPaths.delete(key)
  }
}

/**
 * Atomic leaf write — one policy cell under `enpoi-orchestration.permissions`,
 * no whole-doc read-modify-write races. The gateway answers HTTP 200 for
 * business failures too, so only an explicit `ok: true` result counts as
 * persisted.
 * @param path - path inside the permissions section (['tools', tool], …).
 * @param value - JSON value to write.
 * @returns whether the mutation was persisted.
 */
export function setPermissionPath(path: readonly (string | number)[], value: unknown): Promise<boolean> {
  return withPendingPath(path, async () => {
    const outcome = await postMutation({ op: 'set', path: ['permissions', ...path], value }, undefined)
    return outcome.ok
  })
}

/**
 * Atomic removal (inherit = the operator deletes the rule).
 * @param path - path inside the permissions section.
 * @returns whether the mutation was persisted.
 */
export function unsetPermissionPath(path: readonly (string | number)[]): Promise<boolean> {
  return withPendingPath(path, async () => {
    const outcome = await postMutation({ op: 'unset', path: ['permissions', ...path] }, undefined)
    return outcome.ok
  })
}

/**
 * Persist one row toggle's fan-out ops (aggregate rows write several concrete
 * keys plus the legacy-key removal). Every op is an atomic leaf write; the
 * caller rolls its optimistic state back when any op reports failure.
 * @param ops - the ops from {@link rowPolicyOps}.
 * @returns whether every op was persisted.
 */
export async function persistRowPolicyOps(ops: readonly RowPolicyOp[]): Promise<boolean> {
  const outcomes = await Promise.all(ops.map(op => (
    op.op === 'set' ? setPermissionPath(op.path, op.value) : unsetPermissionPath(op.path)
  )))
  return outcomes.every(Boolean)
}

/** How many times a fenced whole-array write re-reads and retries on conflict. */
const MAX_WRITE_RETRIES = 3

/**
 * Replace `permissions.bashPatterns` (whole-array write) with the operator's
 * change applied to the freshest server array, fenced by revision. Each attempt
 * re-reads the live document, so a concurrent write by another client is merged
 * rather than clobbered; a conflict re-reads and retries.
 * @param build - derives the next rule list from the fresh server list.
 * @returns whether the change was persisted.
 */
export function persistBashPatterns(
  build: (fresh: readonly BashPatternRule[]) => BashPatternRule[],
): Promise<boolean> {
  return withPendingPath(['bashPatterns'], async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describePermissionsView()
      if (view === undefined) return false
      const next = build(view.value?.permissions?.bashPatterns ?? [])
      const op: PermissionPathOp = next.length === 0
        ? { op: 'unset', path: ['permissions', 'bashPatterns'] }
        : { op: 'set', path: ['permissions', 'bashPatterns'], value: next }
      const outcome = await postMutation(op, view.revision)
      if (outcome.ok) return true
      if (!outcome.conflict) return false
    }
    return false
  })
}

/**
 * Replace `permissions.agents[agent].available` (whole-array write) with the
 * operator's change applied to the freshest server array, fenced by revision.
 * `undefined` means the role has no explicit override yet.
 * @param agent - the role whose allowlist is written.
 * @param build - derives the next allowlist from the fresh server allowlist.
 * @returns whether the change was persisted.
 */
export function persistAgentAvailable(
  agent: string,
  build: (fresh: readonly string[] | undefined) => string[],
): Promise<boolean> {
  return withPendingPath(['agents', agent, 'available'], async () => {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describePermissionsView()
      if (view === undefined) return false
      const next = build(view.value?.permissions?.agents?.[agent]?.available)
      const op: PermissionPathOp = next.length === 0
        ? { op: 'unset', path: ['permissions', 'agents', agent, 'available'] }
        : { op: 'set', path: ['permissions', 'agents', agent, 'available'], value: next }
      const outcome = await postMutation(op, view.revision)
      if (outcome.ok) return true
      if (!outcome.conflict) return false
    }
    return false
  })
}
