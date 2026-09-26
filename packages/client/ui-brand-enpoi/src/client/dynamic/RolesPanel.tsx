/**
 * Roles tab of the Dynamic settings page (doc 59).
 *
 * Lists every role the registry knows: the five shipped code defaults merged
 * with the `enpoi-orchestration.roles` settings map. Retired entries stay
 * listed (greyed, tagged) so the operator can restore them; every other row
 * edits label, group, persona, the `tools.available` allowlist, the Fleet
 * `seat` toggle, and the `disabled` retire toggle inline. Edits publish at 0ms
 * and persist as one revision-fenced whole-entry `settings.mutate` op; a
 * rejected write rolls the optimistic entry back and shows one compact error
 * line. `roles.<id>` unset restores a built-in default (or removes a user
 * role). Seat models are assigned in Agent Models — not here.
 *
 * The module also owns the raw settings snapshot (retired entries included)
 * that the Prompts tab reads through {@link subscribeRoleSettings}, plus the
 * shared optimistic writer {@link editRole}.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  BUILT_IN_ROLES,
  ROLE_GROUP_LABELS,
  ROLE_GROUP_ORDER,
  coerceRoleRegistry,
  normalizeRoleId,
  refreshFromServer as refreshRoleRegistry,
  subscribeRoleRegistry,
  getOrchestrationConfigFingerprint,
  titleCaseRoleId,
  type RoleEntry,
  type RoleGroup,
  type RoleRegistryMap,
} from '../role-registry.ts'
import {
  buildPermissionToolRows,
  BUILT_ROLE_SURFACE,
  fetchRegisteredToolNames,
  KEPT_BY_EVERY_ROLE,
  roleRowChecked,
  rowTargets,
  type McpServerRef,
  type PermissionToolRow,
} from '../permissions-model.ts'
import {
  effectiveRolesUnavailable,
  getEffectiveRoles,
  subscribeEffectiveRoles,
  type EffectiveRoleMap,
} from '../role-effective.ts'
import { openSettingsSection } from '../settings-nav.ts'
import css from './RolesPanel.module.css'
import { setStatus } from './status.ts'
import { withWriteTimeout } from './write-timeout.ts'

/** CSS-module reads are `string | undefined` under noUncheckedIndexedAccess; keys are static. */
function c(name: string): string {
  return css[name] ?? ''
}

/** Minimalistic monochrome stroke icons (currentColor, 1.25 stroke). */
function Icon({ d, size = 11 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  right: 'M6 3.5L10.5 8 6 12.5',
  down: 'M3.5 6L8 10.5 12.5 6',
  trash: 'M4 4.5h8M6.5 4.5v-1h3v1M5 4.5l.5 8h5l.5-8',
}

// --- live settings snapshot -------------------------------------------------

/** One `settings.describe` namespace view, structural subset. */
interface DynamicSettingsView {
  ns?: string
  revision?: number
  value?: { roles?: unknown; councils?: unknown; mcpServers?: unknown }
  user?: { roles?: unknown; councils?: unknown; mcpServers?: unknown }
}

/** The roles tab's live snapshot: raw role entries plus their read-only neighbours. */
export interface RoleSettingsSnapshot {
  /** `enpoi-orchestration.roles` as written, retired entries included. */
  roles: RoleRegistryMap
  /** `enpoi-orchestration.councils`, rendered read-only by the Prompts tab. */
  councils: unknown
  /** `enpoi-orchestration.mcpServers`, the dynamic tool-row source. */
  mcpServers: Record<string, McpServerRef>
}

let current: RoleSettingsSnapshot = { roles: {}, councils: undefined, mcpServers: {} }
let primed = false
const listeners = new Set<() => void>()
/** Role ids with a local write in flight; their optimistic entry wins over a refresh. */
const pendingRoleIds = new Set<string>()
/** Per-role write sequence, so an older rejection never rolls back a newer edit. */
const writeGeneration = new Map<string, number>()
/** Per-role write tail: rapid edits to one role persist in click order, never raced. */
const writeChains = new Map<string, Promise<void>>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Synchronous snapshot reader for the panels (0ms latency). */
export function getRoleSettings(): RoleSettingsSnapshot {
  return current
}

/**
 * Subscribe to snapshot changes (boot priming and pushed refreshes).
 * @param listener - called after each snapshot change.
 * @returns unsubscribe function.
 */
export function subscribeRoleSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

/** Monotonic write rpcIds for the same reason. */
let writeSeq = 0

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeDynamicSettings(): Promise<DynamicSettingsView | undefined> {
  const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  if (typeof shared === 'function') {
    const namespaces = (await (shared as () => Promise<{ namespaces?: readonly unknown[] } | undefined>)())?.namespaces
    return Array.isArray(namespaces)
      ? (namespaces as DynamicSettingsView[]).find(view => view.ns === 'enpoi-orchestration')
      : undefined
  }
  describeSeq += 1
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `dynamic-describe-${describeSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json: unknown = await res.json()
  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
  return Array.isArray(namespaces)
    ? (namespaces as DynamicSettingsView[]).find(view => view.ns === 'enpoi-orchestration')
    : undefined
}

/**
 * Fingerprint of the config slices this panel renders. It covers roles AND the
 * councils/mcpServers slices the panel and the Prompts tab read, so a change to
 * any of them still refreshes across clients; only status-only pushes (the 15s
 * mcpStatus heartbeat) are skipped.
 */
function roleSliceFingerprint(): string {
  return getOrchestrationConfigFingerprint()
}

/** Fingerprint applied by the last describe; a push that matches it skips the describe. */
let lastRoleSliceFingerprint: string | undefined

/** Whether the unconditional first load has landed, so push dedupe has a baseline. */
let roleSlicePrimed = false

/** One server read applied to the snapshot; roles with a write in flight keep their optimistic entry. */
function applyServerView(view: DynamicSettingsView): void {
  const serverRoles: RoleRegistryMap = coerceRoleRegistry(view.value?.roles ?? view.user?.roles)
  // Rebuild instead of deleting: a pending local unset drops the server key, a
  // pending local edit keeps the optimistic entry.
  const roles: RoleRegistryMap = {}
  for (const [id, entry] of Object.entries(serverRoles)) {
    if (!pendingRoleIds.has(id)) {
      roles[id] = entry
      continue
    }
    const local = current.roles[id]
    if (local !== undefined) roles[id] = local
  }
  const mcpServers = view.value?.mcpServers ?? view.user?.mcpServers
  current = {
    roles,
    councils: view.value?.councils ?? view.user?.councils,
    mcpServers: mcpServers !== null && typeof mcpServers === 'object' && !Array.isArray(mcpServers)
      ? mcpServers as Record<string, McpServerRef>
      : {},
  }
  notify()
  lastRoleSliceFingerprint = roleSliceFingerprint()
  roleSlicePrimed = true
}

/** Re-read the namespace and publish the fresh snapshot (boot priming and pushed changes). */
export async function refreshRoleSettings(): Promise<void> {
  try {
    const view = await describeDynamicSettings()
    if (view !== undefined) applyServerView(view)
  } catch {
    // Offline or malformed answer: the last snapshot stays until the next push.
  }
}

/** Eagerly prime the snapshot from host settings on boot. */
export function primeRoleSettings(): void {
  if (primed) return
  primed = true
  void refreshRoleSettings()
}

// Auto-prime on module import so the tab renders instantly, and follow the
// shared role registry's pushed refreshes for cross-client live sync. The
// first load is unconditional; later pushes describe only when the role slice
// actually changed, so the 15s mcpStatus heartbeat writes do not re-describe.
if (typeof window !== 'undefined') {
  primeRoleSettings()
  subscribeRoleRegistry(() => {
    if (!roleSlicePrimed) return
    const fingerprint = roleSliceFingerprint()
    if (fingerprint === lastRoleSliceFingerprint) return
    lastRoleSliceFingerprint = fingerprint
    void refreshRoleSettings()
  })
}

// --- role entries and writes ------------------------------------------------

/** How many times a fenced role write re-reads and retries on conflict. */
const MAX_ROLE_WRITE_RETRIES = 3

/** One `settings.mutate` op inside the roles registry. */
interface RoleSettingsOp {
  op: 'set' | 'unset'
  path: (string | number)[]
  value?: unknown
}

/** Post one op fenced by the revision read from describe. */
async function postRoleMutation(op: RoleSettingsOp, expectedRevision: number | undefined): Promise<{ ok: boolean; conflict: boolean }> {
  writeSeq += 1
  const args: Record<string, unknown> = { ns: 'enpoi-orchestration', ops: [op] }
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision
  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: `role-mutate-${String(writeSeq)}`,
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

/** The settings-over-code-defaults entry one role row edits and writes. */
export function effectiveRoleEntry(roles: RoleRegistryMap, id: string): RoleEntry {
  return { ...(BUILT_IN_ROLES[id] ?? {}), ...(roles[id] ?? {}) }
}

/** The operator-facing label for a role id: settings label, code-default label, then the title-cased id. */
export function roleLabel(roles: RoleRegistryMap, id: string): string {
  const label = effectiveRoleEntry(roles, id).label
  return label !== undefined && label !== '' ? label : titleCaseRoleId(id)
}

/** Copy an entry without one optional key (`undefined` must not survive into the written JSON). */
export function withoutRoleKey(entry: RoleEntry, key: keyof RoleEntry): RoleEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([candidate]) => candidate !== String(key)),
  ) as RoleEntry
}

/** Apply one edited raw entry to the local snapshot (0ms optimistic update). */
function applyLocalRole(id: string, entry: RoleEntry | null): void {
  const roles: RoleRegistryMap = {}
  for (const [key, value] of Object.entries(current.roles)) {
    if (key !== id) roles[key] = value
  }
  if (entry !== null) roles[id] = entry
  current = { ...current, roles }
  notify()
}

/**
 * Persist one fenced whole-entry role write. Every attempt re-reads the live
 * registry and re-applies `build` onto the freshest settings-over-defaults
 * entry, so a concurrent write by another client is merged rather than
 * clobbered; a `settings/conflict` answer re-reads and retries. The entry the
 * server ended up storing is published back to the snapshot.
 * @param id - the role id to write.
 * @param build - derives the next entry from the freshest one; `undefined` unsets the entry.
 * @returns whether the write persisted.
 */
export function persistRoleWrite(id: string, build: (fresh: RoleEntry) => RoleEntry | undefined): Promise<boolean> {
  return withWriteTimeout((async () => {
    try {
      for (let attempt = 0; attempt <= MAX_ROLE_WRITE_RETRIES; attempt++) {
        const view = await describeDynamicSettings()
        if (view === undefined) return false
        const serverRoles = coerceRoleRegistry(view.value?.roles ?? view.user?.roles)
        const next = build(effectiveRoleEntry(serverRoles, id))
        const op: RoleSettingsOp = next === undefined
          ? { op: 'unset', path: ['roles', id] }
          : { op: 'set', path: ['roles', id], value: next }
        const outcome = await postRoleMutation(op, view.revision)
        if (outcome.ok) {
          applyLocalRole(id, next ?? null)
          return true
        }
        if (!outcome.conflict) return false
      }
      return false
    } catch {
      // A thrown transport read behaves like a failed write: the caller rolls back.
      return false
    }
  })(), false)
}

/**
 * One operator edit: publish the optimistic entry at 0ms, persist it through
 * {@link persistRoleWrite}, and roll just this role back (with one compact
 * error line) when the write does not persist.
 * @param id - the role being edited.
 * @param build - derives the next entry from the freshest one; `undefined` removes the override.
 * @param onError - receives the operator-facing failure line.
 */
export function editRole(
  id: string,
  build: (fresh: RoleEntry) => RoleEntry | undefined,
  onError?: (message: string) => void,
): void {
  const previous = current.roles[id] ?? null
  const label = roleLabel(current.roles, id)
  const generation = (writeGeneration.get(id) ?? 0) + 1
  writeGeneration.set(id, generation)
  applyLocalRole(id, build(effectiveRoleEntry(current.roles, id)) ?? null)
  pendingRoleIds.add(id)
  const previousTail = writeChains.get(id) ?? Promise.resolve()
  const task: Promise<void> = previousTail.then(async () => {
    const ok = await persistRoleWrite(id, build)
    if (ok) {
      // Hot-sync the shared registry so Fleet and Permissions follow instantly.
      void refreshRoleRegistry()
      return
    }
    if (writeGeneration.get(id) === generation) applyLocalRole(id, previous)
    onError?.(`Could not save ${label} — the change was reverted.`)
  }).finally(() => {
    if (writeChains.get(id) === task) {
      pendingRoleIds.delete(id)
      writeChains.delete(id)
    }
  })
  writeChains.set(id, task)
}

// --- rows -------------------------------------------------------------------

/** One rendered role row. */
export interface RoleRow {
  id: string
  entry: RoleEntry
  /** The raw settings override as written (`{}` for an untouched built-in). */
  override: RoleEntry
  /** Effective baseline: host role-table values over the client code defaults. */
  baseline: RoleBaseline
  builtIn: boolean
  retired: boolean
}

/** The effective values one role shows when its settings entry leaves a field unset. */
export interface RoleBaseline {
  label?: string
  persona?: string
  group?: RoleGroup
  /** The role's effective tool surface: settings override, host allowlist, then the shipped surface. */
  available?: string[]
}

/**
 * The baseline for one row: the host's effective registry (label, persona,
 * group, capability allowlist) over the client code defaults. Persona text is
 * never duplicated here — it comes from the host role tables through the
 * `enpoiRoles.list` RPC.
 * @param id - the role id.
 * @param entry - the code-default-over-settings effective entry.
 * @param override - the raw settings entry.
 * @param effective - the host's effective registry map (empty when unavailable).
 * @returns baseline values with only the fields that have one.
 */
export function buildRoleBaseline(
  id: string,
  entry: RoleEntry,
  override: RoleEntry,
  effective: EffectiveRoleMap,
): RoleBaseline {
  const host = effective[id]
  const baseline: RoleBaseline = {}
  const label = entry.label ?? host?.label
  if (label !== undefined && label !== '') baseline.label = label
  const persona = entry.persona ?? host?.persona
  if (persona !== undefined && persona !== '') baseline.persona = persona
  const hostGroup = host?.group
  const group = entry.group
    ?? (hostGroup === 'supervision' || hostGroup === 'specialists' || hostGroup === 'council' || hostGroup === 'custom'
      ? hostGroup
      : undefined)
  if (group !== undefined) baseline.group = group
  if (override.tools?.available !== undefined) baseline.available = override.tools.available
  else if (host?.available !== undefined) baseline.available = host.available
  else if (BUILT_ROLE_SURFACE[id] !== undefined) {
    // The child-keep floor (whiteboard) is unioned into every role surface, so
    // the built-in baseline shows it checked for the same reason the runtime keeps it.
    baseline.available = [...new Set([...BUILT_ROLE_SURFACE[id], ...KEPT_BY_EVERY_ROLE])]
  }
  return baseline
}

/**
 * Every role the tab lists: code defaults plus settings-only ids, retired
 * entries included so they can be restored.
 * @param roles - the raw settings role map.
 * @param effective - the host's effective registry map (empty when the RPC is unavailable).
 * @returns rows in fleet group order, built-ins first.
 */
export function buildRoleRows(roles: RoleRegistryMap, effective: EffectiveRoleMap = {}): RoleRow[] {
  const ids = [...Object.keys(BUILT_IN_ROLES)]
  for (const id of Object.keys(roles)) {
    if (!ids.includes(id)) ids.push(id)
  }
  const rows = ids.map((id): RoleRow => {
    const entry = effectiveRoleEntry(roles, id)
    const override = roles[id] ?? {}
    return {
      id,
      entry,
      override,
      baseline: buildRoleBaseline(id, entry, override, effective),
      builtIn: Object.hasOwn(BUILT_IN_ROLES, id),
      retired: entry.disabled === true,
    }
  })
  rows.sort((left, right) => {
    const byGroup = ROLE_GROUP_ORDER.indexOf(left.entry.group ?? 'custom')
      - ROLE_GROUP_ORDER.indexOf(right.entry.group ?? 'custom')
    if (byGroup !== 0) return byGroup
    if (left.builtIn !== right.builtIn) return left.builtIn ? -1 : 1
    return left.id.localeCompare(right.id)
  })
  return rows
}

/** The tool checkboxes one role shows: the permission rows plus allowlist ids outside them. */
function buildRoleToolRows(rows: PermissionToolRow[], entry: RoleEntry, baseline: readonly string[] = []): PermissionToolRow[] {
  const available = [...new Set([...(entry.tools?.available ?? []), ...baseline])]
  // Covered ids include every aggregate's concrete members, so a family row
  // does not leave duplicate per-tool checkboxes beside it.
  const known = new Set(rows.flatMap(row => [row.id, ...rowTargets(row)]))
  const extras = available.filter(id => !known.has(id)).map(id => ({ id, name: id }))
  return [...rows, ...extras]
}

// --- controls ---------------------------------------------------------------

/**
 * Local draft state that survives a store refresh while the operator types.
 * A pushed value is adopted unless the field is focused AND its text diverged
 * from the value the panel last committed; commit or blur-with-no-change
 * clears that guard so the store wins again.
 */
function useDraft(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const dirty = useRef(false)

  useEffect(() => {
    if (focused.current && dirty.current) return
    setDraft(value)
    dirty.current = false
  }, [value])

  const onChange = (next: string): void => {
    setDraft(next)
    dirty.current = next !== value
  }
  const onFocus = (): void => { focused.current = true }
  const onBlur = (): void => {
    focused.current = false
    if (dirty.current) onCommit(draft)
    dirty.current = false
  }
  return { draft, onChange, onFocus, onBlur }
}

/** Text input that keeps a local draft and commits on blur (Enter also commits). */
export function DraftInput({ value, label, placeholder, onCommit }: {
  value: string
  label: string
  placeholder?: string
  onCommit: (next: string) => void
}) {
  const draft = useDraft(value, onCommit)
  return (
    <input
      type="text"
      className={c('input')}
      aria-label={label}
      placeholder={placeholder}
      value={draft.draft}
      onChange={(event) => { draft.onChange(event.target.value) }}
      onFocus={draft.onFocus}
      onBlur={draft.onBlur}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    />
  )
}

/** Textarea twin of {@link DraftInput}: draft locally, commit on blur. */
export function DraftTextarea({ value, label, placeholder, onCommit }: {
  value: string
  label: string
  placeholder?: string
  onCommit: (next: string) => void
}) {
  const draft = useDraft(value, onCommit)
  return (
    <textarea
      className={c('textarea')}
      aria-label={label}
      placeholder={placeholder}
      rows={2}
      value={draft.draft}
      onChange={(event) => { draft.onChange(event.target.value) }}
      onFocus={draft.onFocus}
      onBlur={draft.onBlur}
    />
  )
}

/** One role switch (fleet-seat visibility / retirement) with its visible caption. */
function RoleSwitch({ checked, caption, ariaLabel, title, onToggle }: {
  checked: boolean
  caption: string
  ariaLabel: string
  title: string
  onToggle: () => void
}) {
  return (
    <span className={c('switchField')} title={title}>
      <span className={c('switchLabel')}>{caption}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        className={checked ? `${c('switch')} ${c('switchOn')}` : c('switch')}
        onClick={onToggle}
      >
        <span className={c('knob')} />
      </button>
    </span>
  )
}

/** One role row: compact head plus the inline editor when expanded. */
function RoleRowView({ row, toolRows, effectiveUnavailable, expanded, onToggleExpanded, onEditLabel, onEditPersona,
  onEditGroup, onToggleSeat, onToggleRetired, onToggleTool, onDelete }: {
  row: RoleRow
  toolRows: PermissionToolRow[]
  /** True when the effective-registry RPC is unavailable (settings-layer display only). */
  effectiveUnavailable: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onEditLabel: (next: string) => void
  onEditPersona: (next: string) => void
  onEditGroup: (next: RoleGroup) => void
  onToggleSeat: () => void
  onToggleRetired: () => void
  /** Toggles the row: an aggregate flips every concrete member at once. */
  onToggleTool: (row: PermissionToolRow) => void
  onDelete: () => void
}) {
  const label = row.entry.label ?? row.baseline.label ?? titleCaseRoleId(row.id)
  const available = row.entry.tools?.available ?? row.baseline.available ?? []
  const seatOff = row.entry.seat === false
  const hasOverride = (key: keyof RoleEntry): boolean => row.override[key] !== undefined
  return (
    <div className={row.retired ? `${c('row')} ${c('rowRetired')}` : c('row')}>
      <div className={c('rowHead')}>
        <button
          type="button"
          className={c('expandBtn')}
          aria-label={`Edit ${label}`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          <Icon d={expanded ? ICONS.down : ICONS.right} />
        </button>
        <span className={c('rowName')}>{label}</span>
        <span className={c('rowId')}>{row.id}</span>
        {row.builtIn && <span className={c('tag')}>built-in</span>}
        {row.retired && <span className={`${c('tag')} ${c('tagRetired')}`}>retired</span>}
        {seatOff && !row.retired && <span className={c('tag')}>no seat</span>}
        <span className={c('spacer')} />
        <RoleSwitch
          checked={!seatOff}
          caption="Fleet seat"
          ariaLabel={`Fleet seat for ${label}`}
          title={seatOff
            ? 'Fleet seat off — hidden from Fleet Routing and Agent Models. The role still spawns and its permissions stay editable.'
            : 'Fleet seat on — offerable for model assignment in Fleet Routing and Agent Models. Never removes the role.'}
          onToggle={onToggleSeat}
        />
        <RoleSwitch
          checked={row.retired}
          caption="Retired"
          ariaLabel={row.retired ? `Restore ${label}` : `Retire ${label}`}
          title={row.retired
            ? 'Retired on — removed from the effective registry everywhere (no spawn, no seat, no permissions row). Turn off to restore.'
            : 'Retired off — the role is live everywhere. Turn on to remove it from the effective registry; delete restores the code default.'}
          onToggle={onToggleRetired}
        />
        <button
          type="button"
          className={c('iconBtn')}
          aria-label={`Delete ${label}`}
          title={row.builtIn
            ? 'Deletes the settings entry so the code default returns; Retire removes the role everywhere'
            : 'Deletes this role'}
          onClick={onDelete}
        >
          <Icon d={ICONS.trash} />
        </button>
      </div>
      {expanded && (
        <div className={c('editor')}>
          {effectiveUnavailable && (
            <p className={c('fieldHint')}>
              Effective values are unavailable — showing the settings layer only.
            </p>
          )}
          <div className={c('editGrid')}>
            <label className={c('field')}>
              <span className={c('fieldLabel')}>
                Label{!hasOverride('label') && <span className={c('fieldTag')}>built-in</span>}
              </span>
              <DraftInput value={row.entry.label ?? row.baseline.label ?? ''} label={`Label for ${label}`} onCommit={onEditLabel} />
            </label>
            <label className={c('field')}>
              <span className={c('fieldLabel')}>
                Group{!hasOverride('group') && <span className={c('fieldTag')}>built-in</span>}
              </span>
              <select
                className={c('select')}
                aria-label={`Group for ${label}`}
                value={row.entry.group ?? row.baseline.group ?? 'custom'}
                onChange={(event) => { onEditGroup(event.target.value as RoleGroup) }}
              >
                {ROLE_GROUP_ORDER.map(group => (
                  <option key={group} value={group}>{ROLE_GROUP_LABELS[group]}</option>
                ))}
              </select>
            </label>
          </div>
          <label className={c('field')}>
            <span className={c('fieldLabel')}>
              Persona{!hasOverride('persona') && <span className={c('fieldTag')}>built-in</span>}
            </span>
            <DraftTextarea
              value={row.entry.persona ?? row.baseline.persona ?? ''}
              label={`Persona for ${label}`}
              {...(row.baseline.persona === undefined ? { placeholder: 'Code default' } : {})}
              onCommit={onEditPersona}
            />
          </label>
          <div className={c('field')}>
            <span className={c('fieldLabel')}>
              Tools — this role's surface; empty keeps the effective default
              {!hasOverride('tools') && <span className={c('fieldTag')}>built-in</span>}
            </span>
            <div className={c('toolGrid')}>
              {buildRoleToolRows(toolRows, row.entry, row.baseline.available ?? []).map(tool => (
                <label key={tool.id} className={c('toolItem')}>
                  <input
                    type="checkbox"
                    checked={roleRowChecked(tool, available)}
                    aria-label={`${tool.name} for ${label}`}
                    onChange={() => { onToggleTool(tool) }}
                  />
                  <span>{tool.name}</span>
                </label>
              ))}
            </div>
          </div>
          <p className={c('fieldHint')}>
            This list is the role's fallback surface: the Permissions allowlist wins when it names tools; both are bounded
            by the built-in deny floor.
          </p>
          <p className={c('fieldHint')}>
            {row.builtIn
              ? 'Delete restores the code default; Retire removes the role everywhere.'
              : 'Delete removes this role from the registry.'}
          </p>
        </div>
      )}
    </div>
  )
}

// --- panel ------------------------------------------------------------------

/** Roles tab: registry list with inline editing of every operator-owned field. */
export function RolesPanel() {
  const snapshot = useSyncExternalStore(subscribeRoleSettings, getRoleSettings)
  const effectiveRoles = useSyncExternalStore(subscribeEffectiveRoles, getEffectiveRoles)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [draftId, setDraftId] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftPersona, setDraftPersona] = useState('')
  const [draftGroup, setDraftGroup] = useState<RoleGroup>('custom')

  const rows = useMemo(() => buildRoleRows(snapshot.roles, effectiveRoles), [snapshot.roles, effectiveRoles])
  const groups = useMemo(() => ROLE_GROUP_ORDER
    .map(group => ({
      group,
      title: ROLE_GROUP_LABELS[group],
      rows: rows.filter(row => (row.entry.group ?? 'custom') === group),
    }))
    .filter(entry => entry.rows.length > 0), [rows])
  // The tool grid follows the LIVE registry projection (whiteboard, MCP, any
  // future plugin tool), refetched when the catalog slice moves.
  const [liveToolNames, setLiveToolNames] = useState<readonly string[]>([])
  useEffect(() => {
    let cancelled = false
    void fetchRegisteredToolNames().then((names) => {
      if (!cancelled && names !== undefined) setLiveToolNames(names)
    })
    return () => { cancelled = true }
  }, [snapshot.mcpServers])
  const toolRows = useMemo(
    () => buildPermissionToolRows(snapshot.mcpServers, [], liveToolNames),
    [snapshot.mcpServers, liveToolNames],
  )

  /** Commit one field edit through the shared optimistic/fenced writer. */
  const commit = (id: string, build: (fresh: RoleEntry) => RoleEntry | undefined): void => {
    setStatus(null)
    editRole(id, build, setStatus)
  }

  const setRoleLabel = (id: string, next: string): void => {
    const label = next.trim()
    commit(id, fresh => label === '' ? withoutRoleKey(fresh, 'label') : { ...fresh, label })
  }

  const setRolePersona = (id: string, next: string): void => {
    commit(id, fresh => next.trim() === '' ? withoutRoleKey(fresh, 'persona') : { ...fresh, persona: next })
  }

  const setRoleGroup = (id: string, group: RoleGroup): void => {
    commit(id, fresh => ({ ...fresh, group }))
  }

  const toggleRoleSeat = (id: string): void => {
    commit(id, fresh => ({ ...fresh, seat: fresh.seat === false }))
  }

  const toggleRoleRetired = (id: string): void => {
    commit(id, fresh => fresh.disabled === true ? withoutRoleKey(fresh, 'disabled') : { ...fresh, disabled: true })
  }

  const toggleRoleTool = (id: string, row: PermissionToolRow, baseline: readonly string[]): void => {
    const targets = rowTargets(row)
    if (targets.length === 0) return
    commit(id, (fresh) => {
      const members = new Set(fresh.tools?.available ?? baseline)
      const present = targets.every(target => members.has(target))
      for (const target of targets) {
        if (present) members.delete(target)
        else members.add(target)
      }
      const available = [...members].sort((left, right) => left.localeCompare(right))
      return available.length === 0 ? withoutRoleKey(fresh, 'tools') : { ...fresh, tools: { available } }
    })
  }

  const deleteRole = (id: string): void => {
    commit(id, () => undefined)
  }

  /** Create one role: `roles.<id>` set fenced, published at 0ms. */
  const addRole = (): void => {
    const id = normalizeRoleId(draftId)
    if (id === '') {
      setStatus('Enter a role id.')
      return
    }
    if (Object.hasOwn(snapshot.roles, id) || Object.hasOwn(BUILT_IN_ROLES, id)) {
      setStatus(`Role "${id}" already exists.`)
      return
    }
    const label = draftLabel.trim()
    const persona = draftPersona.trim()
    const entry: RoleEntry = {
      group: draftGroup,
      ...(label !== '' ? { label } : {}),
      ...(persona !== '' ? { persona } : {}),
    }
    setStatus(null)
    editRole(id, () => entry, setStatus)
    setDraftId('')
    setDraftLabel('')
    setDraftPersona('')
    setDraftGroup('custom')
    setExpanded(id)
  }

  return (
    <div className={c('wrap')}>
      <p className={c('hint')}>
        Edits write <code>enpoi-orchestration.roles</code> and apply from the next spawn — no restart.
        Seat models are assigned in Agent Models. Unset fields show their effective built-in value.
      </p>
      <p className={c('hint')}>
        Tool boxes here are the role's surface layer: used when Permissions sets no allowlist for the role.
        {' '}
        <button
          type="button"
          className={c('crossLink')}
          onClick={() => { openSettingsSection('permissions') }}
        >
          Open Permissions
        </button>
      </p>
      {groups.map(group => (
        <section key={group.group} className={c('group')}>
          <header className={c('groupHead')}>{group.title}</header>
          <div className={c('rows')}>
            {group.rows.map(row => (
              <RoleRowView
                key={row.id}
                row={row}
                toolRows={toolRows}
                effectiveUnavailable={effectiveRolesUnavailable()}
                expanded={expanded === row.id}
                onToggleExpanded={() => { setExpanded(expanded === row.id ? null : row.id) }}
                onEditLabel={(next) => { setRoleLabel(row.id, next) }}
                onEditPersona={(next) => { setRolePersona(row.id, next) }}
                onEditGroup={(next) => { setRoleGroup(row.id, next) }}
                onToggleSeat={() => { toggleRoleSeat(row.id) }}
                onToggleRetired={() => { toggleRoleRetired(row.id) }}
                onToggleTool={(toolRow) => { toggleRoleTool(row.id, toolRow, row.baseline.available ?? []) }}
                onDelete={() => { deleteRole(row.id) }}
              />
            ))}
          </div>
        </section>
      ))}
      <section className={c('group')}>
        <header className={c('groupHead')}>ADD ROLE</header>
        <div className={c('addForm')}>
          <label className={c('field')}>
            <span className={c('fieldLabel')}>Id</span>
            <input
              type="text"
              className={c('input')}
              aria-label="New role id"
              placeholder="my-role"
              value={draftId}
              onChange={(event) => { setDraftId(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') addRole() }}
            />
          </label>
          <label className={c('field')}>
            <span className={c('fieldLabel')}>Label</span>
            <input
              type="text"
              className={c('input')}
              aria-label="New role label"
              value={draftLabel}
              onChange={(event) => { setDraftLabel(event.target.value) }}
            />
          </label>
          <label className={c('field')}>
            <span className={c('fieldLabel')}>Group</span>
            <select
              className={c('select')}
              aria-label="New role group"
              value={draftGroup}
              onChange={(event) => { setDraftGroup(event.target.value as RoleGroup) }}
            >
              {ROLE_GROUP_ORDER.map(group => (
                <option key={group} value={group}>{ROLE_GROUP_LABELS[group]}</option>
              ))}
            </select>
          </label>
          <label className={`${c('field')} ${c('fieldWide')}`}>
            <span className={c('fieldLabel')}>Persona (optional)</span>
            <textarea
              className={c('textarea')}
              aria-label="New role persona"
              rows={2}
              value={draftPersona}
              onChange={(event) => { setDraftPersona(event.target.value) }}
            />
          </label>
          <button type="button" className={c('btnPrimary')} onClick={addRole}>Add role</button>
        </div>
      </section>
    </div>
  )
}
