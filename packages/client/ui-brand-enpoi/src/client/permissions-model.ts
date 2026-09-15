/**
 * Doc 55 permission-policy model — wire types, pure helpers, and the
 * settings.describe / settings.mutate RPC wrappers for the
 * `enpoi-orchestration` namespace. Shared by the Capabilities Tier-1 strip
 * and the Permissions Settings section (same package).
 *
 * Writes are atomic per-path leaf ops (one `settings.mutate` call per rule,
 * `ns` + `args` wrapper mandatory). Whole-array keys (bashPatterns,
 * agents[name].available) re-read the live document immediately before each
 * write so the array is built from fresh state, never a stale snapshot.
 */

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
  agent?: string
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

/** The settings.describe view of the enpoi-orchestration namespace the permissions UI reads. */
export interface OrchestrationSettingsView {
  ns?: string
  value?: {
    permissions?: PermissionsConfig
    mcpServers?: Record<string, McpServerRef>
  }
}

/** Shipped code defaults (not YAML): reads, web, and the subagent family allow. */
const SHIPPED_ALLOW_TOOLS: readonly string[] = [
  'read', 'glob', 'grep', 'web_search', 'web_fetch',
  'subagent', 'task', 'workflow', 'job_output', 'job_list', 'job_kill',
]

/** Shipped code defaults: destructive-but-expected tools ask. */
const SHIPPED_ASK_TOOLS: readonly string[] = ['bash', 'str_replace_editor']

/** The core tool surface one policy row can name (doc 55 static list). */
export const CORE_PERMISSION_TOOLS: readonly string[] = [
  'bash', 'read', 'glob', 'grep', 'edit', 'write', 'str_replace_editor', 'todo_write',
  'web_search', 'web_fetch', 'skill', 'plan_mode', 'subagent', 'task', 'workflow',
  'job_output', 'job_list', 'job_kill', 'oracle_review', 'request_evidence',
  'roundtable', 'chorus', 'memory_save', 'memory_search', 'memory_rescind',
  'memory_confirm', 'ask_user_question',
]

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

/**
 * Count diff-only rules (global + per-agent tool rules) and standing grants.
 * Bash pattern rules are configuration, not counted as rules.
 * @param perms - the permissions section, or undefined when unconfigured.
 * @returns the Tier-1 strip counters.
 */
export function countPermissionRules(perms: PermissionsConfig | undefined): { rules: number; grants: number } {
  let rules = Object.keys(perms?.tools ?? {}).length
  for (const agent of Object.values(perms?.agents ?? {})) {
    rules += Object.keys(agent?.tools ?? {}).length
  }
  return { rules, grants: Object.keys(perms?.grants ?? {}).length }
}

/** Title-case a tool id into a readable label (`todo_write` → "Todo Write"). */
function prettyToolName(id: string): string {
  return id.split(/[_\s]+/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** One policy row: the tools-map key plus a display label. */
export interface PermissionToolRow {
  id: string
  name: string
}

/**
 * Build the tool-row list for one subject: the known capability tools plus the
 * static core list, then one row per mounted MCP server as `mcp__<server>*`,
 * then the generic `mcp__*` row.
 * @param mcpServers - the enpoi-orchestration.mcpServers describe data.
 * @param known - catalog descriptors; tool-kind rows contribute display names.
 * @returns ordered rows, `mcp__*` last.
 */
export function buildPermissionToolRows(
  mcpServers: Record<string, McpServerRef> | undefined,
  known: readonly { id: string; name: string; kind?: 'tool' | 'skill' | 'mcp' }[],
): PermissionToolRow[] {
  const rows = new Map<string, PermissionToolRow>()
  for (const cap of known) {
    if (cap.kind === 'tool' && !rows.has(cap.id)) rows.set(cap.id, { id: cap.id, name: cap.name })
  }
  for (const id of CORE_PERMISSION_TOOLS) {
    if (!rows.has(id)) rows.set(id, { id, name: prettyToolName(id) })
  }
  for (const [id, def] of Object.entries(mcpServers ?? {})) {
    const serverName = typeof def?.serverName === 'string' && def.serverName !== '' ? def.serverName : id
    rows.set(`mcp__${serverName}*`, { id: `mcp__${serverName}*`, name: `${serverName} (MCP)` })
  }
  rows.set('mcp__*', { id: 'mcp__*', name: 'All MCP tools' })
  return [...rows.values()]
}

/** Which layer owns a subject's effective tool policy. */
export type PermissionProvenance = 'agent rule' | 'global rule' | 'inherit (default)'

/**
 * Resolve the provenance shown beside one policy chip: the agent's own rule
 * wins, then the global rule, then the shipped/configured defaults.
 * @param perms - the live permissions section.
 * @param agent - the selected agent, or undefined for the Global subject.
 * @param tool - the tools-map key.
 */
/**
 * The shipped per-role surfaces (mirrors the fork's ROLE_CHILD_DENY table +
 * the shared worker deny list — the tools each role CAN see by default).
 * Drives the availability eye when the role has no `available` override:
 * built-in-visible tools show on, everything else shows crossed-out.
 */
/**
 * The operator-level surface: the acting agents (orchestrator, sysadmin,
 * creator) share one FULL surface — from a permissions perspective they are
 * the same agent: they act, they delegate, they configure. MCP server tools
 * are deliberately absent here: MCP availability is a sidebar capability
 * toggle (per-server, hot-swappable), not a per-role surface decision.
 */
const FULL_OPERATOR_SURFACE: readonly string[] = [
  'bash', 'read', 'glob', 'grep', 'read_image',
  'edit', 'write', 'str_replace_editor',
  'todo_write', 'todo_read', 'skill', 'plan_mode', 'exit_plan_mode',
  'subagent', 'task', 'workflow', 'ralph', 'goal', 'create_goal', 'get_goal', 'update_goal',
  'oracle_review', 'request_evidence', 'roundtable', 'chorus',
  'memory_save', 'memory_search', 'memory_rescind', 'memory_confirm',
  'job_output', 'job_list', 'job_kill', 'ask_user_question',
]

/**
 * The shipped per-role surfaces. Specialists and council seats carry the
 * minimal surface their work needs; delegation is structural (workers never
 * spawn children — the shared anti-leak floor bounds them regardless).
 */
export const BUILT_ROLE_SURFACE: Record<string, readonly string[]> = {
  orchestrator: FULL_OPERATOR_SURFACE,
  sysadmin: FULL_OPERATOR_SURFACE,
  creator: FULL_OPERATOR_SURFACE,
  fixer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'str_replace_editor', 'todo_write', 'run_code'],
  designer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'str_replace_editor', 'todo_write', 'run_code'],
  explorer: ['read', 'glob', 'grep', 'read_image', 'todo_read'],
  librarian: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  oracle: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'request_evidence', 'subagent', 'task'],
  referee: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  chair: ['read', 'glob', 'grep', 'read_image'],
  skeptic: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  architect: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  pragmatist: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  visionary: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  experiencer: ['read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch'],
  integrator: ['read', 'glob', 'grep', 'read_image'],
  curator: ['read', 'glob', 'grep', 'read_image'],
}

/**
 * Effective availability for one role×tool: an explicit `available` allowlist
 * wins; otherwise the built-in role surface decides (undefined role = the
 * orchestrator-like full surface).
 */
export function builtRoleAvailability(agent: string | undefined, tool: string): boolean | undefined {
  const surface = agent !== undefined ? BUILT_ROLE_SURFACE[agent] : undefined
  if (surface === undefined) return undefined
  return surface.includes(tool)
}

export function provenanceFor(perms: PermissionsConfig, agent: string | undefined, tool: string): PermissionProvenance {
  if (agent !== undefined && perms.agents?.[agent]?.tools?.[tool] !== undefined) return 'agent rule'
  if (perms.tools?.[tool] !== undefined) return 'global rule'
  return 'inherit (default)'
}

/**
 * The shipped code-default policy for one tool, or undefined when the tool
 * falls back to `defaults.unknownTools`.
 * @param tool - the tools-map key.
 * @returns the shipped policy when doc 55 defines one for this key.
 */
export function shippedPolicyFor(tool: string): PolicyValue | undefined {
  if (SHIPPED_ALLOW_TOOLS.includes(tool)) return 'allow'
  if (SHIPPED_ASK_TOOLS.includes(tool)) return 'ask'
  return undefined
}

/**
 * The effective policy a subject receives for one tool: agent rule, then
 * global rule, then the shipped default, then `defaults.unknownTools`, then
 * the shipped unknown-tools answer (ask).
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
  return shippedPolicyFor(tool) ?? perms.defaults?.unknownTools ?? 'ask'
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** Read the enpoi-orchestration namespace through the live gateway. */
export async function describePermissionsView(): Promise<OrchestrationSettingsView | undefined> {
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: nextRpcId('perm-describe'),
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json = await res.json() as { result?: { value?: { namespaces?: OrchestrationSettingsView[] } } }
  const namespaces = json?.result?.value?.namespaces
  return Array.isArray(namespaces) ? namespaces.find(n => n.ns === 'enpoi-orchestration') : undefined
}

/**
 * Atomic leaf write — one policy cell or whole-array key under
 * `enpoi-orchestration.permissions`, no whole-doc read-modify-write races.
 * The gateway answers HTTP 200 for business failures too, so only an
 * explicit `ok: true` result counts as persisted.
 * @param path - path inside the permissions section (['tools', tool], …).
 * @param value - JSON value to write.
 * @returns whether the mutation was persisted.
 */
export async function setPermissionPath(path: readonly (string | number)[], value: unknown): Promise<boolean> {
  const res = await fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: nextRpcId('perm-set'),
      payload: {
        args: { ns: 'enpoi-orchestration', ops: [{ op: 'set', path: ['permissions', ...path], value }] },
      },
    }),
  })
  if (!res.ok) return false
  const json = await res.json() as { result?: { ok?: boolean } }
  return json?.result?.ok === true
}

/**
 * Atomic removal (inherit = the operator deletes the rule).
 * @param path - path inside the permissions section.
 * @returns whether the mutation was persisted.
 */
export async function unsetPermissionPath(path: readonly (string | number)[]): Promise<boolean> {
  const res = await fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: nextRpcId('perm-unset'),
      payload: {
        args: { ns: 'enpoi-orchestration', ops: [{ op: 'unset', path: ['permissions', ...path] }] },
      },
    }),
  })
  if (!res.ok) return false
  const json = await res.json() as { result?: { ok?: boolean } }
  return json?.result?.ok === true
}
