/**
 * Doc 55 permission-policy model — wire types, pure helpers, and the
 * settings.describe / settings.mutate RPC wrappers for the
 * `enpoi-orchestration` namespace. Shared by the Capabilities Tier-1 strip
 * and the Permissions Settings section (same package).
 *
 * Writes are atomic per-path leaf ops (one `settings.mutate` call per rule,
 * `ns` + `args` wrapper mandatory). Whole-array keys (bashPatterns,
 * agents[name].available) go through the fenced writers below: every attempt
 * re-reads the live document, re-applies the operator's change onto that fresh
 * value, and carries the read revision as `expectedRevision`; a
 * `settings/conflict` answer re-reads and retries.
 */
import type { RoleRegistryMap } from './role-registry.ts'

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

/** One left-rail subject: the policy key plus its display label. */
export interface PermissionSubject {
  id: string
  label: string
}

/**
 * Build the subject rail: registry roles (labelled) first, then the shipped
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
  _known: readonly { id: string; name: string; kind?: 'tool' | 'skill' | 'mcp' }[] = [],
): PermissionToolRow[] {
  // The matrix rows are REAL tools (doc 55 P2 redesign). Specialist names
  // (fixer/explorer/…) are ROLE SUBJECTS in the left rail, not tool rows;
  // the context keeper is a background service, not an agent-dispatchable
  // tool; MCP servers are dynamic rows from the catalog + one family row.
  const rows = new Map<string, PermissionToolRow>()
  for (const id of CORE_PERMISSION_TOOLS) {
    rows.set(id, { id, name: prettyToolName(id) })
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
  'web_search', 'web_fetch',
  'todo_write', 'todo_read', 'skill', 'plan_mode', 'exit_plan_mode',
  'subagent', 'task', 'workflow', 'ralph', 'goal', 'create_goal', 'get_goal', 'update_goal',
  'oracle_review', 'request_evidence', 'roundtable', 'chorus',
  'memory_save', 'memory_search', 'memory_rescind', 'memory_confirm',
  'job_output', 'job_list', 'job_kill', 'ask_user_question',
]

/**
 * The shipped per-role surfaces (mirrors the fork's role tables). Operator
 * defaults: every sub-agent may run bash (reading, analysis, tests), use
 * skills, search/write memory, and keep its own todo list; readers keep only
 * the mutation veto. MCP rows are deliberately absent — MCP availability is a
 * sidebar capability toggle, not a per-role surface decision.
 */
export const BUILT_ROLE_SURFACE: Record<string, readonly string[]> = {
  orchestrator: FULL_OPERATOR_SURFACE,
  sysadmin: FULL_OPERATOR_SURFACE,
  creator: FULL_OPERATOR_SURFACE,
  fixer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'str_replace_editor', 'todo_write', 'todo_read', 'skill', 'memory_search', 'memory_save', 'web_search', 'web_fetch'],
  designer: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'str_replace_editor', 'todo_write', 'todo_read', 'skill', 'memory_search', 'memory_save', 'web_search', 'web_fetch'],
  explorer: ['bash', 'read', 'glob', 'grep', 'read_image', 'todo_write', 'todo_read', 'skill', 'memory_search', 'memory_save'],
  librarian: ['bash', 'read', 'glob', 'grep', 'read_image', 'todo_write', 'todo_read', 'skill', 'memory_search', 'memory_save', 'web_search', 'web_fetch'],
  oracle: ['bash', 'read', 'glob', 'grep', 'read_image', 'edit', 'write', 'str_replace_editor', 'todo_write', 'todo_read', 'skill', 'memory_search', 'memory_save', 'memory_rescind', 'memory_confirm', 'web_search', 'web_fetch', 'request_evidence', 'subagent', 'task'],
  referee: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  chair: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  skeptic: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  architect: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  pragmatist: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  visionary: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  experiencer: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  integrator: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
  curator: ['bash', 'read', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'memory_search', 'todo_write', 'todo_read'],
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
  if (Array.isArray(available)) return available
  return BUILT_ROLE_SURFACE[agent]
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

/** One describe view of the enpoi-orchestration namespace the permissions UI reads. */
export interface OrchestrationSettingsView {
  ns?: string
  /** Monotonic revision the namespace was read at; the whole-array write fence. */
  revision?: number
  value?: {
    permissions?: PermissionsConfig
    mcpServers?: Record<string, McpServerRef>
  }
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

// --- cross-client live view -------------------------------------------------

/** The latest describe answer, or undefined before the first successful read. */
let latestView: OrchestrationSettingsView | undefined
/** True when no read has succeeded yet and the gateway is unreachable. */
let latestFailed = false
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
