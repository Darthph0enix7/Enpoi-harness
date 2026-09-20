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
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  BUILT_IN_ROLES,
  ROLE_GROUP_LABELS,
  ROLE_GROUP_ORDER,
  coerceRoleRegistry,
  normalizeRoleId,
  refreshFromServer as refreshRoleRegistry,
  subscribeRoleRegistry,
  titleCaseRoleId,
  type RoleEntry,
  type RoleGroup,
  type RoleRegistryMap,
} from '../role-registry.ts'
import {
  buildPermissionToolRows,
  type McpServerRef,
  type PermissionToolRow,
} from '../permissions-model.ts'
import css from './RolesPanel.module.css'

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
// shared role registry's pushed refreshes for cross-client live sync.
if (typeof window !== 'undefined') {
  primeRoleSettings()
  subscribeRoleRegistry(() => { void refreshRoleSettings() })
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
  return (async () => {
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
  })()
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
  builtIn: boolean
  retired: boolean
}

/**
 * Every role the tab lists: code defaults plus settings-only ids, retired
 * entries included so they can be restored.
 * @param roles - the raw settings role map.
 * @returns rows in fleet group order, built-ins first.
 */
export function buildRoleRows(roles: RoleRegistryMap): RoleRow[] {
  const ids = [...Object.keys(BUILT_IN_ROLES)]
  for (const id of Object.keys(roles)) {
    if (!ids.includes(id)) ids.push(id)
  }
  const rows = ids.map((id): RoleRow => {
    const entry = effectiveRoleEntry(roles, id)
    return { id, entry, builtIn: Object.hasOwn(BUILT_IN_ROLES, id), retired: entry.disabled === true }
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
function buildRoleToolRows(rows: PermissionToolRow[], entry: RoleEntry): PermissionToolRow[] {
  const available = entry.tools?.available ?? []
  const known = new Set(rows.map(row => row.id))
  const extras = available.filter(id => !known.has(id)).map(id => ({ id, name: id }))
  return [...rows, ...extras]
}

// --- controls ---------------------------------------------------------------

/** Text input that keeps a local draft and commits on blur (Enter also commits). */
export function DraftInput({ value, label, placeholder, onCommit }: {
  value: string
  label: string
  placeholder?: string
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <input
      type="text"
      className={c('input')}
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={() => { if (draft !== value) onCommit(draft) }}
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
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <textarea
      className={c('textarea')}
      aria-label={label}
      placeholder={placeholder}
      rows={2}
      value={draft}
      onChange={(event) => { setDraft(event.target.value) }}
      onBlur={() => { if (draft !== value) onCommit(draft) }}
    />
  )
}

/** One role switch (seat visibility / retirement). */
function RoleSwitch({ checked, label, title, onToggle }: {
  checked: boolean
  label: string
  title: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className={checked ? `${c('switch')} ${c('switchOn')}` : c('switch')}
      onClick={onToggle}
    >
      <span className={c('knob')} />
    </button>
  )
}

/** One role row: compact head plus the inline editor when expanded. */
function RoleRowView({ row, toolRows, expanded, onToggleExpanded, onEditLabel, onEditPersona,
  onEditGroup, onToggleSeat, onToggleRetired, onToggleTool, onDelete }: {
  row: RoleRow
  toolRows: PermissionToolRow[]
  expanded: boolean
  onToggleExpanded: () => void
  onEditLabel: (next: string) => void
  onEditPersona: (next: string) => void
  onEditGroup: (next: RoleGroup) => void
  onToggleSeat: () => void
  onToggleRetired: () => void
  onToggleTool: (tool: string) => void
  onDelete: () => void
}) {
  const label = row.entry.label !== undefined && row.entry.label !== '' ? row.entry.label : titleCaseRoleId(row.id)
  const available = row.entry.tools?.available ?? []
  const seatOff = row.entry.seat === false
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
          label={`Seat for ${label}`}
          title={seatOff ? 'Show this role in Fleet Routing' : 'Hide this role from Fleet Routing'}
          onToggle={onToggleSeat}
        />
        <RoleSwitch
          checked={row.retired}
          label={row.retired ? `Restore ${label}` : `Retire ${label}`}
          title={row.retired ? 'Restore this role everywhere' : 'Retire this role everywhere'}
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
          <div className={c('editGrid')}>
            <label className={c('field')}>
              <span className={c('fieldLabel')}>Label</span>
              <DraftInput value={row.entry.label ?? ''} label={`Label for ${label}`} onCommit={onEditLabel} />
            </label>
            <label className={c('field')}>
              <span className={c('fieldLabel')}>Group</span>
              <select
                className={c('select')}
                aria-label={`Group for ${label}`}
                value={row.entry.group ?? 'custom'}
                onChange={(event) => { onEditGroup(event.target.value as RoleGroup) }}
              >
                {ROLE_GROUP_ORDER.map(group => (
                  <option key={group} value={group}>{ROLE_GROUP_LABELS[group]}</option>
                ))}
              </select>
            </label>
          </div>
          <label className={c('field')}>
            <span className={c('fieldLabel')}>Persona</span>
            <DraftTextarea
              value={row.entry.persona ?? ''}
              label={`Persona for ${label}`}
              placeholder="Code default"
              onCommit={onEditPersona}
            />
          </label>
          <div className={c('field')}>
            <span className={c('fieldLabel')}>Tools — empty keeps this role's default surface</span>
            <div className={c('toolGrid')}>
              {buildRoleToolRows(toolRows, row.entry).map(tool => (
                <label key={tool.id} className={c('toolItem')}>
                  <input
                    type="checkbox"
                    checked={available.includes(tool.id)}
                    aria-label={`${tool.name} for ${label}`}
                    onChange={() => { onToggleTool(tool.id) }}
                  />
                  <span>{tool.name}</span>
                </label>
              ))}
            </div>
          </div>
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
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [draftId, setDraftId] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftPersona, setDraftPersona] = useState('')
  const [draftGroup, setDraftGroup] = useState<RoleGroup>('custom')

  const rows = useMemo(() => buildRoleRows(snapshot.roles), [snapshot.roles])
  const groups = useMemo(() => ROLE_GROUP_ORDER
    .map(group => ({
      group,
      title: ROLE_GROUP_LABELS[group],
      rows: rows.filter(row => (row.entry.group ?? 'custom') === group),
    }))
    .filter(entry => entry.rows.length > 0), [rows])
  const toolRows = useMemo(() => buildPermissionToolRows(snapshot.mcpServers), [snapshot.mcpServers])

  /** Commit one field edit through the shared optimistic/fenced writer. */
  const commit = (id: string, build: (fresh: RoleEntry) => RoleEntry | undefined): void => {
    setError(null)
    editRole(id, build, setError)
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

  const toggleRoleTool = (id: string, tool: string): void => {
    commit(id, (fresh) => {
      const members = new Set(fresh.tools?.available ?? [])
      if (members.has(tool)) members.delete(tool)
      else members.add(tool)
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
      setError('Enter a role id.')
      return
    }
    if (Object.hasOwn(snapshot.roles, id) || Object.hasOwn(BUILT_IN_ROLES, id)) {
      setError(`Role "${id}" already exists.`)
      return
    }
    const label = draftLabel.trim()
    const persona = draftPersona.trim()
    const entry: RoleEntry = {
      group: draftGroup,
      ...(label !== '' ? { label } : {}),
      ...(persona !== '' ? { persona } : {}),
    }
    setError(null)
    editRole(id, () => entry, setError)
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
        Seat models are assigned in Agent Models.
      </p>
      {error !== null && <p className={c('error')} role="alert">{error}</p>}
      {groups.map(group => (
        <section key={group.group} className={c('group')}>
          <header className={c('groupHead')}>{group.title}</header>
          <div className={c('rows')}>
            {group.rows.map(row => (
              <RoleRowView
                key={row.id}
                row={row}
                toolRows={toolRows}
                expanded={expanded === row.id}
                onToggleExpanded={() => { setExpanded(expanded === row.id ? null : row.id) }}
                onEditLabel={(next) => { setRoleLabel(row.id, next) }}
                onEditPersona={(next) => { setRolePersona(row.id, next) }}
                onEditGroup={(next) => { setRoleGroup(row.id, next) }}
                onToggleSeat={() => { toggleRoleSeat(row.id) }}
                onToggleRetired={() => { toggleRoleRetired(row.id) }}
                onToggleTool={(tool) => { toggleRoleTool(row.id, tool) }}
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
