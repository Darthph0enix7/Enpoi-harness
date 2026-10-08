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
 * read directly by the settings page), and `refreshFromServer` through the
 * package's shared coalesced describe (settings-refresh.ts: one request per
 * burst, scheduled by a push, a transport reconnect, the tab becoming visible,
 * or a stale mount). A read answering the revision this store last applied
 * notifies nobody.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { BrandEnpoiKey, BrandT } from './locales.ts'
import { readEnpoiNamespace } from './settings-refresh.ts'

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

/** Dictionary key of the section title per group, in render order. */
export const ROLE_GROUP_LABEL_KEYS: Record<RoleGroup, BrandEnpoiKey> = {
  supervision: 'roleGroupSupervision',
  specialists: 'roleGroupSpecialists',
  council: 'roleGroupCouncil',
  custom: 'roleGroupCustom',
}

/** Fleet group render order. */
export const ROLE_GROUP_ORDER: readonly RoleGroup[] = ['supervision', 'specialists', 'council', 'custom']

/**
 * The keeper's plugin Config route — shown as the "Default" sublabel. The
 * keyless kilo seed (`kilo/kilo-auto/free`, written by first-run) is the route
 * a fresh install can actually reach; the keeper has no parent turn to inherit
 * from, so its own route is always used. Must match
 * `$PROFILE/packages/enpoi-context-keeper/src/index.ts` Config defaults.
 */
export const KEEPER_DEFAULT_ROUTE = 'kilo/kilo-auto/free'

/** One fleet seat resolved for rendering. */
export interface FleetSeat {
  /** Role id; the persona assignment key (`settings.personas[seatId]`). */
  id: string
  /** Display name. */
  name: string
  /** Micro-icon path data. */
  icon: string
  /** The unassigned-state label; `Inherit` when the seat follows the session model. */
  defaultLabel?: string
  defaultHint?: string
  /** Unassigned routing: `inherit` follows the dispatch/session model; `builtin-default` uses the seat's own route. */
  defaultKind?: FleetSeatState
}

/** How one seat routes when it has no explicit assignment. */
export type FleetSeatState = 'inherit' | 'builtin-default'

/**
 * The routing state one fleet row labels: an explicit assignment, or the
 * seat's unassigned fallback — the dispatching/session model (`inherit`) or
 * the seat's own plugin route (`builtin-default`).
 * @param assignment - the live persona assignment (null/undefined = unassigned).
 * @param seat - the resolved fleet seat.
 * @returns the explicit state the row shows.
 */
export function fleetSeatState(assignment: ModelSelection | null | undefined, seat: FleetSeat): 'assigned' | FleetSeatState {
  if (assignment !== null && assignment !== undefined && assignment.model !== '') return 'assigned'
  return seat.defaultKind ?? 'inherit'
}

/** One rendered fleet group. */
export interface FleetCategory {
  /** Stable identity: a fixed group id, `council:<id>`, or `ungrouped`. */
  key: string
  title: string
  seats: FleetSeat[]
}

/** One seat a council registry row declares (`enpoiCouncil.list`). */
export interface FleetCouncilSeat {
  /** Seat id; the persona assignment key. */
  id: string
  /** Council-declared display label, when the registry carries one. */
  label?: string
  /** Council-declared seat family (informational). */
  family?: string
}

/** One registered council as the fleet grouping reads it. */
export interface FleetCouncil {
  id: string
  /** Operator-facing council name; falls back to the title-cased id. */
  label?: string
  /** Seats the council debates with. */
  seats?: readonly FleetCouncilSeat[]
  /** Arbiters serving every council; rendered in the shared group. */
  arbiters?: readonly string[]
}

/** Dictionary key of the title for persona-only seats no registry or council claims. */
export const UNGROUPED_GROUP_KEY: BrandEnpoiKey = 'roleGroupUngrouped'

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
  defaultLabelKey?: BrandEnpoiKey
  /** Template params for {@link LegacySeatMeta.defaultLabelKey}. */
  defaultLabelParams?: Record<string, unknown>
  defaultHintKey?: BrandEnpoiKey
  defaultKind?: FleetSeatState
}

const LEGACY_SEAT_META: Readonly<Record<string, LegacySeatMeta>> = {
  keeper: {
    name: 'Context Keeper',
    icon: 'M8 2l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z',
    group: 'supervision',
    defaultLabelKey: 'seatKeeperDefaultLabel',
    defaultLabelParams: { route: KEEPER_DEFAULT_ROUTE },
    defaultHintKey: 'seatKeeperDefaultHint',
    defaultKind: 'builtin-default',
  },
  compaction: {
    name: 'CTX Summarizer',
    icon: 'M3 3h10v10H3zM3 6h10M3 10h4m2 2v3m0 0l-1.5-1.5M9 15l1.5-1.5',
    group: 'supervision',
    defaultLabelKey: 'seatCompactionDefaultLabel',
    defaultHintKey: 'seatCompactionDefaultHint',
    defaultKind: 'inherit',
  },
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
 * Legacy seats the harness designates itself rather than the profile document:
 * they must render before any persona assignment exists so the operator can
 * assign them. Unassigned, each keeps its default route (today's behaviour).
 */
export const DESIGNATED_SEATS: ReadonlySet<string> = new Set(['compaction'])

/**
 * Build the Fleet Routing groups: registry roles with `seat !== false` in
 * registry order, one group per registered council titled by the council's own
 * label, the shared arbiter group, then persona-only seats no registry or
 * council claims, plus the harness-designated seats that must always render.
 * Every arbiter a council declares renders in the shared group with no persona
 * assignment, because the declaration itself is the row's source. Council
 * seats are claimed by normalized id — the first council that lists an id owns
 * its row, so a duplicate appears once; a council with zero seats renders no
 * group; a role hidden with `seat: false` stays hidden even when a council
 * lists it. The shipped pre-registry seat metadata (keeper, compaction,
 * arbiters, legacy debaters) counts as a registry claim.
 * @param registry - the effective role registry.
 * @param personaKeys - keys of the persona assignment map.
 * @param councils - the live council registry (`enpoiCouncil.list`).
 * @param t - the package dictionary translate for group and seat-fallback copy.
 * @returns non-empty groups in render order.
 */
export function buildFleetCategories(
  registry: RoleRegistryMap,
  personaKeys: Iterable<string>,
  councils: readonly FleetCouncil[],
  t: BrandT,
): FleetCategory[] {
  const byGroup = new Map<RoleGroup, FleetSeat[]>()
  const ungrouped: FleetSeat[] = []
  const seen = new Set<string>()
  const emitted = new Set<string>()
  const councilRows = new Map<number, FleetSeat[]>()
  const rowFor = (index: number): FleetSeat[] => {
    let row = councilRows.get(index)
    if (row === undefined) {
      row = []
      councilRows.set(index, row)
    }
    return row
  }

  // Council ownership: normalized seat id → first council index that lists it.
  const ownership = new Map<string, number>()
  const declaredSeats = new Map<string, FleetCouncilSeat>()
  councils.forEach((council, index) => {
    for (const raw of council.seats ?? []) {
      const id = normalizeRoleId(raw.id)
      if (id === '') continue
      if (!declaredSeats.has(id)) declaredSeats.set(id, raw)
      if (!ownership.has(id)) ownership.set(id, index)
    }
  })
  const arbiters = new Set<string>()
  for (const council of councils) {
    for (const raw of council.arbiters ?? []) {
      const id = normalizeRoleId(raw)
      if (id !== '') arbiters.add(id)
    }
  }

  const push = (group: RoleGroup, seat: FleetSeat): void => {
    const seats = byGroup.get(group)
    if (seats === undefined) byGroup.set(group, [seat])
    else seats.push(seat)
  }

  /** Resolve one row: registry label, then the council's seat label, then shipped metadata. */
  const resolveSeat = (id: string, registryLabel: string | undefined): FleetSeat => {
    const legacy = LEGACY_SEAT_META[id]
    const seat: FleetSeat = {
      id,
      name: registryLabel ?? declaredSeats.get(id)?.label ?? legacy?.name ?? titleCaseRoleId(id),
      icon: legacy?.icon ?? DEFAULT_SEAT_ICON,
    }
    if (legacy?.defaultLabelKey !== undefined) seat.defaultLabel = t(legacy.defaultLabelKey, legacy.defaultLabelParams)
    if (legacy?.defaultHintKey !== undefined) seat.defaultHint = t(legacy.defaultHintKey)
    if (legacy?.defaultKind !== undefined) seat.defaultKind = legacy.defaultKind
    return seat
  }

  // Council rows first: every listed seat renders even with no persona
  // assignment, in the council's own seat order. A registry role the operator
  // hid with `seat: false` stays hidden; the first listing council owns the row.
  councils.forEach((council, index) => {
    for (const raw of council.seats ?? []) {
      const id = normalizeRoleId(raw.id)
      if (id === '' || ownership.get(id) !== index || emitted.has(id)) continue
      if (registry[id]?.seat === false) continue
      emitted.add(id)
      seen.add(id)
      rowFor(index).push(resolveSeat(id, registry[id]?.label))
    }
  })

  for (const [id, entry] of Object.entries(registry)) {
    seen.add(id)
    if (entry.seat === false || emitted.has(id)) continue
    if (arbiters.has(id) || (entry.group ?? LEGACY_SEAT_META[id]?.group ?? 'custom') === 'council') {
      push('council', resolveSeat(id, entry.label))
      continue
    }
    push(entry.group ?? LEGACY_SEAT_META[id]?.group ?? 'custom', resolveSeat(id, entry.label))
  }

  // Declared arbiters (`referee`, `chair`) render in the shared council group
  // from the council registry itself, with no persona row at all: their seat
  // is registry data, so an unassigned or cleared seat never loses its row.
  for (const id of arbiters) {
    if (seen.has(id)) continue
    seen.add(id)
    push('council', resolveSeat(id, undefined))
  }

  const extras = [...new Set(personaKeys)]
    .map(key => normalizeRoleId(key))
    .filter(key => key !== '' && !seen.has(key))
    .sort((left, right) => left.localeCompare(right))
  for (const id of extras) {
    seen.add(id)
    const legacy = LEGACY_SEAT_META[id]
    if ((legacy?.group ?? 'custom') === 'council') {
      push('council', resolveSeat(id, undefined))
      continue
    }
    if (legacy?.group !== undefined) {
      push(legacy.group, resolveSeat(id, undefined))
      continue
    }
    ungrouped.push(resolveSeat(id, undefined))
  }

  // Harness-designated seats render without a persona assignment so the
  // operator can assign them; a registry row of the same id already rendered.
  for (const id of DESIGNATED_SEATS) {
    if (seen.has(id)) continue
    seen.add(id)
    push(LEGACY_SEAT_META[id]?.group ?? 'custom', resolveSeat(id, undefined))
  }

  const categories: FleetCategory[] = []
  for (const group of ROLE_GROUP_ORDER) {
    if (group === 'council') continue
    const seats = byGroup.get(group)
    if (seats !== undefined && seats.length > 0) categories.push({ key: group, title: t(ROLE_GROUP_LABEL_KEYS[group]), seats })
  }
  councils.forEach((council, index) => {
    const seats = councilRows.get(index)
    if (seats === undefined || seats.length === 0) return
    categories.push({
      key: `council:${council.id}`,
      title: council.label !== undefined && council.label !== '' ? council.label : titleCaseRoleId(council.id),
      seats,
    })
  })
  const shared = byGroup.get('council')
  if (shared !== undefined && shared.length > 0) {
    categories.push({ key: 'council', title: t(ROLE_GROUP_LABEL_KEYS.council), seats: shared })
  }
  if (ungrouped.length > 0) {
    categories.push({ key: 'ungrouped', title: t(UNGROUPED_GROUP_KEY), seats: ungrouped })
  }
  return categories
}

// --- cross-client live view -------------------------------------------------

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface OrchestrationRolesView {
  ns?: string
  /** Monotonic revision the namespace was read at. */
  revision?: number
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

/**
 * Revision this store last applied. A later read that answers the same
 * revision carries the document this snapshot already holds, so it is skipped
 * without a notify.
 */
let lastAppliedRevision: number | undefined

/** Re-read the namespace and merge it into the snapshot (cross-client live sync). */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await readEnpoiNamespace() as OrchestrationRolesView | undefined
    if (view === undefined) return
    if (view.revision !== undefined && view.revision === lastAppliedRevision) return
    const roles = view.value?.roles ?? view.user?.roles
    if (roles === undefined) return
    lastAppliedRevision = view.revision
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
