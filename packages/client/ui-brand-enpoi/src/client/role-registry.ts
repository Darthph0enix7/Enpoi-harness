/**
 * Settings-backed fleet role registry (`enpoi-orchestration.roles`).
 *
 * The effective registry is the shipped code defaults overlaid by the settings
 * map (`{ ...BUILT_IN_ROLES, ...serverRoles }`): a server entry overrides a
 * built-in role, a server-only role is a new fleet role, a `null` server entry
 * or `disabled: true` deletes the role, and `seat: false` hides a role's seat
 * while keeping the role itself (its permissions surface stays editable).
 *
 * Same store discipline as persona-store: eager boot priming, synchronous
 * snapshots (bound into components through the inject `hooks` compartment and
 * read directly by the settings page), and `refreshFromServer` for cross-client
 * live sync driven by `settings/document-updated`.
 */

/** Fleet group a registry role belongs to. */
export type RoleGroup = 'supervision' | 'specialists' | 'council' | 'custom'

/** Role-scoped capability metadata the permissions page reads. */
export interface RoleToolsConfig {
  /** The role's default tool allowlist when no explicit override is set. */
  available?: string[]
}

/** One registry role's operator-owned metadata (settings `roles[roleId]`). */
export interface RoleEntry {
  /** Display label; falls back to the shipped name, then the title-cased id. */
  label?: string
  /** Persona prose for the role (informational; the registry writer owns it). */
  persona?: string
  /** Fleet group; falls back to the shipped group, then `custom`. */
  group?: RoleGroup
  /** `false` hides the role's seat from Fleet Routing while keeping the role. */
  seat?: boolean
  /** `true` retires the role: not spawnable and absent from every operator surface. */
  disabled?: boolean
  /** Role-scoped capability metadata. */
  tools?: RoleToolsConfig
}

/** Role id → registry entry. */
export type RoleRegistryMap = Record<string, RoleEntry>

/** Section title per group, in render order. */
export const ROLE_GROUP_LABELS: Record<RoleGroup, string> = {
  supervision: 'BACKGROUND & SUPERVISION',
  specialists: 'SPECIALIST WORKERS',
  council: 'COUNCIL',
  custom: 'CUSTOM ROLES',
}

/** Fleet group render order. */
export const ROLE_GROUP_ORDER: readonly RoleGroup[] = ['supervision', 'specialists', 'council', 'custom']

/** The keeper's plugin Config route — shown as the "Default" sublabel. */
export const KEEPER_DEFAULT_ROUTE = 'freellmapi/auto'

/** One fleet seat resolved for rendering. */
export interface FleetSeat {
  /** Role id; the persona assignment key (`settings.personas[seatId]`). */
  id: string
  /** Display name. */
  name: string
  /** Micro-icon path data. */
  icon: string
  /** Seats without a parent turn show "Default" instead of "Inherit". */
  defaultLabel?: string
  defaultHint?: string
}

/** One rendered fleet group. */
export interface FleetCategory {
  group: RoleGroup
  title: string
  seats: FleetSeat[]
}

/**
 * Shipped code-default roles: overridden per id by the settings registry.
 * The remaining fleet roles (keeper, arbiters, debaters, chorus) have no code
 * default; their rows persist through persona assignments.
 */
export const BUILT_IN_ROLES: Readonly<RoleRegistryMap> = {
  oracle: { label: 'The Oracle', group: 'supervision', seat: true },
  fixer: { label: 'Fixer', group: 'specialists', seat: true },
  explorer: { label: 'Explorer', group: 'specialists', seat: true },
  librarian: { label: 'Librarian', group: 'specialists', seat: true },
  designer: { label: 'Designer', group: 'specialists', seat: true },
}

/** Generic seat glyph for roles without a shipped icon. */
const DEFAULT_SEAT_ICON = 'M8 3.25a4.75 4.75 0 100 9.5 4.75 4.75 0 000-9.5z'

/** Shipped seat metadata (name, icon, group) for the roles predating the registry. */
interface LegacySeatMeta {
  name: string
  icon: string
  group: RoleGroup
  defaultLabel?: string
  defaultHint?: string
}

const LEGACY_SEAT_META: Readonly<Record<string, LegacySeatMeta>> = {
  keeper: { name: 'Context Keeper', icon: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z', group: 'supervision', defaultLabel: 'Default', defaultHint: KEEPER_DEFAULT_ROUTE },
  oracle: { name: 'The Oracle', icon: 'M8 3a5 5 0 100 10A5 5 0 008 3zm0 2v2m0 3v2', group: 'supervision' },
  fixer: { name: 'Fixer', icon: 'M10.5 2.5l3 3L6 13H3v-3z', group: 'specialists' },
  explorer: { name: 'Explorer', icon: 'M3 3h4v4H3zM9 9h4v4H9zM9 3h4M11 3v4M3 9h4M5 9v4', group: 'specialists' },
  librarian: { name: 'Librarian', icon: 'M3 4h4v9H3zM8 4h5v9H8zM3 13h10', group: 'specialists' },
  designer: { name: 'Designer', icon: 'M8 3l1.8 3.6L13.5 8l-3.7 1.4L8 13l-1.8-3.6L2.5 8l3.7-1.4z', group: 'specialists' },
  referee: { name: 'Referee', icon: 'M3 5h10M3 8h10M3 11h6M11 11l2 2 3-3', group: 'council' },
  chair: { name: 'Chair', icon: 'M4 3v6h8V3M3 9v4m10-4v4M5 13v0m6 0h0M6 13h4l1 0v0', group: 'council' },
  skeptic: { name: 'Skeptic', icon: 'M12 4l-8 8m0-8l8 8', group: 'council' },
  architect: { name: 'Architect', icon: 'M3 13V8m3 5V5m3 8V3m3 10V7', group: 'council' },
  pragmatist: { name: 'Pragmatist', icon: 'M3 8h10M10 4l3 4-3 4', group: 'council' },
  visionary: { name: 'Visionary', icon: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z', group: 'council' },
  experiencer: { name: 'Experiencer', icon: 'M3 8a5 5 0 0110 0c0 3-5 6-5 6s-5-3-5-6z', group: 'council' },
  integrator: { name: 'Integrator', icon: 'M4 4h4v4H4zM8 8h4v4H8z', group: 'council' },
  curator: { name: 'Curator', icon: DEFAULT_SEAT_ICON, group: 'council' },
}

/**
 * Whether a persona id is a fleet seat the operator is expected to see — a
 * registry role (built-in or server) OR one of the legacy persona-only seats
 * the councils and the keeper use. Clearing an assignment on such a seat keeps
 * its fleet row (the key stays as an explicit `null`); clearing an id that is
 * neither removes the stray key entirely.
 * @param id - persona id as typed or stored.
 * @returns true when the seat should survive a cleared assignment.
 */
export function isKnownFleetSeat(id: string): boolean {
  const key = normalizeRoleId(id)
  return Object.hasOwn(BUILT_IN_ROLES, key) || Object.hasOwn(LEGACY_SEAT_META, key)
}

/** Normalize an operator-typed role id (lowercase, no leading article). */
export function normalizeRoleId(id: string): string {
  return id.trim().toLowerCase().replace(/^the\s+/, '')
}

/** Title-case a role id into a readable label (`my_role` → "My Role"). */
export function titleCaseRoleId(id: string): string {
  return id.split(/[-_\s]+/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** The display label for one role id: registry label, then title-cased id. */
export function registryRoleLabel(registry: RoleRegistryMap, id: string): string {
  const label = registry[id]?.label
  return label !== undefined && label !== '' ? label : titleCaseRoleId(id)
}

/**
 * Overlay the settings role map over the shipped code defaults. A `null` server
 * value deletes the role; every other value replaces the whole entry for that id.
 * @param serverRoles - the `enpoi-orchestration.roles` map, when configured.
 * @returns the effective registry (code defaults included).
 */
export function mergeRoleRegistry(serverRoles: RoleRegistryMap | undefined): RoleRegistryMap {
  // Rebuild instead of deleting: a server entry that is null/malformed/retired
  // drops its role from the merged map.
  const merged: RoleRegistryMap = {}
  const server = serverRoles ?? {}
  for (const [id, entry] of Object.entries(BUILT_IN_ROLES)) {
    if (!(id in server)) merged[id] = entry
  }
  for (const [id, entry] of Object.entries(server)) {
    if (entry === null || typeof entry !== 'object' || entry.disabled === true) continue
    merged[id] = entry
  }
  return merged
}

/**
 * Validate one raw `settings.describe` roles payload into a registry map.
 * Unknown fields are dropped; malformed entries are ignored.
 * @param raw - the raw `value.roles` / `user.roles` JSON value.
 * @returns the coerced registry map.
 */
export function coerceRoleRegistry(raw: unknown): RoleRegistryMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const registry: RoleRegistryMap = {}
  for (const [rawId, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = normalizeRoleId(rawId)
    if (id === '') continue
    if (value === null) {
      // A null entry deletes the role: rebuild the map without that key.
      for (const candidate of Object.keys(registry)) {
        if (candidate === id) Reflect.deleteProperty(registry, candidate)
      }
      continue
    }
    if (typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const entry: RoleEntry = {}
    if (typeof record.label === 'string' && record.label !== '') entry.label = record.label
    if (typeof record.persona === 'string') entry.persona = record.persona
    if (record.group === 'supervision' || record.group === 'specialists' || record.group === 'council' || record.group === 'custom') {
      entry.group = record.group
    }
    if (typeof record.seat === 'boolean') entry.seat = record.seat
    if (record.disabled === true) entry.disabled = true
    const tools = record.tools
    if (tools !== null && typeof tools === 'object') {
      const available = (tools as Record<string, unknown>).available
      if (Array.isArray(available)) entry.tools = { available: available.map(String) }
    }
    registry[id] = entry
  }
  return registry
}

/**
 * Build the Fleet Routing groups: registry roles with `seat !== false` in
 * registry order, then persona-assigned ids with no registry entry (sorted) so
 * existing arbiters/keeper/debaters keep their rows.
 * @param registry - the effective role registry.
 * @param personaKeys - keys of the persona assignment map.
 * @returns non-empty groups in render order.
 */
export function buildFleetCategories(registry: RoleRegistryMap, personaKeys: Iterable<string>): FleetCategory[] {
  const byGroup = new Map<RoleGroup, FleetSeat[]>()
  const seen = new Set<string>()
  const push = (group: RoleGroup, seat: FleetSeat): void => {
    const seats = byGroup.get(group)
    if (seats === undefined) byGroup.set(group, [seat])
    else seats.push(seat)
  }

  for (const [id, entry] of Object.entries(registry)) {
    seen.add(id)
    if (entry.seat === false) continue
    const legacy = LEGACY_SEAT_META[id]
    const seat: FleetSeat = {
      id,
      name: entry.label ?? legacy?.name ?? titleCaseRoleId(id),
      icon: legacy?.icon ?? DEFAULT_SEAT_ICON,
    }
    if (legacy?.defaultLabel !== undefined) seat.defaultLabel = legacy.defaultLabel
    if (legacy?.defaultHint !== undefined) seat.defaultHint = legacy.defaultHint
    push(entry.group ?? legacy?.group ?? 'custom', seat)
  }

  const extras = [...new Set(personaKeys)]
    .map(key => normalizeRoleId(key))
    .filter(key => key !== '' && !seen.has(key))
    .sort((left, right) => left.localeCompare(right))
  for (const id of extras) {
    seen.add(id)
    const legacy = LEGACY_SEAT_META[id]
    const seat: FleetSeat = {
      id,
      name: legacy?.name ?? titleCaseRoleId(id),
      icon: legacy?.icon ?? DEFAULT_SEAT_ICON,
    }
    if (legacy?.defaultLabel !== undefined) seat.defaultLabel = legacy.defaultLabel
    if (legacy?.defaultHint !== undefined) seat.defaultHint = legacy.defaultHint
    push(legacy?.group ?? 'custom', seat)
  }

  return ROLE_GROUP_ORDER
    .map(group => ({ group, title: ROLE_GROUP_LABELS[group], seats: byGroup.get(group) ?? [] }))
    .filter(category => category.seats.length > 0)
}

// --- cross-client live view -------------------------------------------------

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface OrchestrationRolesView {
  ns?: string
  value?: { roles?: unknown; councils?: unknown; mcpServers?: unknown }
  user?: { roles?: unknown; councils?: unknown; mcpServers?: unknown }
}

/**
 * Fingerprint over the CONFIG slices every Dynamic panel renders (roles,
 * councils, mcpServers). Volatile status writes — the 15s `mcpStatus`
 * heartbeat in particular — are deliberately excluded, so a push that only
 * carries status does not make the panels re-describe.
 */
let orchestrationConfigFingerprint = ''

/** Fingerprint of the config slices the Dynamic panels derive their rows from. */
export function getOrchestrationConfigFingerprint(): string {
  return orchestrationConfigFingerprint
}

let currentRegistry: RoleRegistryMap = mergeRoleRegistry(undefined)
let primed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationRolesView | undefined> {
  describeSeq += 1
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `role-describe-${describeSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json: unknown = await res.json()
  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
  return Array.isArray(namespaces)
    ? (namespaces as OrchestrationRolesView[]).find(n => n.ns === 'enpoi-orchestration')
    : undefined
}

/** Re-read the namespace and merge it into the snapshot (cross-client live sync). */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await describeOrchestration()
    if (view === undefined) return
    const roles = view.value?.roles ?? view.user?.roles
    if (roles === undefined) return
    // The panels' change gate: config slices only, so status heartbeats are inert.
    orchestrationConfigFingerprint = JSON.stringify({
      roles: roles ?? null,
      councils: view.value?.councils ?? view.user?.councils ?? null,
      mcpServers: view.value?.mcpServers ?? view.user?.mcpServers ?? null,
    })
    currentRegistry = mergeRoleRegistry(coerceRoleRegistry(roles))
    notify()
  } catch {
    // Offline or malformed answer: the last snapshot stays until the next push.
  }
}

/** Eagerly prime the in-memory registry from host settings on boot. */
export function primeRoleRegistry(): void {
  if (primed) return
  primed = true
  void refreshFromServer()
}

// Auto-prime on module import so the fleet and permissions pages are ready.
if (typeof window !== 'undefined') {
  primeRoleRegistry()
}

/** Synchronous snapshot reader for useSyncExternalStore (0ms latency). */
export function getRoleRegistry(): RoleRegistryMap {
  return currentRegistry
}

/**
 * Subscribe to registry changes (boot priming and pushed refreshes).
 * @param listener - called after each registry snapshot change.
 * @returns unsubscribe function.
 */
export function subscribeRoleRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
