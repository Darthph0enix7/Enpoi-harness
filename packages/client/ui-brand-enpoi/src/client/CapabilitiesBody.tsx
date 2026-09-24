/**
 * Capabilities Control Center — the global capabilities tab body
 * (`sidebar.right.pane.tab` key `enpoi-capabilities`, kind `capabilities`).
 *
 * Every row is derived from a live host source, so the drawer can only show a
 * capability the deployment actually has, and a new entry appears with no code
 * change:
 *
 * - MCP servers: `enpoi-orchestration.mcpServers` (id + serverName/url) with
 *   the host heartbeat in `enpoi-orchestration.mcpStatus`; enabled state is
 *   `capabilities.mcp[id] === true` — the same predicate the mount path uses
 *   (the fiber only spawns on an explicit true).
 * - Skills: the session-addressed `skills.list` catalog; enabled state is
 *   `capabilities.skills[name] !== false` — the same rule the pre-dispatch
 *   guard applies (only an explicit false shadows a skill).
 * - Subagents: the effective role registry (`enpoiRoles.list`) with each
 *   DELEGATABLE role's label, group, and registry ordering. A role marked
 *   `spawnable: false` (the Oracle) is tool-only: it has no spawn affordance
 *   here and appears once under Tool Flags through its own tool id.
 * - Councils: the council registry (`enpoiCouncil.list`) with each council's
 *   label, seats, and retired state.
 * - Tool flags: the stored `capabilities.tools` keys not covered by a role or
 *   council row. The pre-dispatch guard and the tool-schema strip consume
 *   these flags directly, but there is no host registry that enumerates the
 *   core tool names, so only operator-stored flags are listed. Rows stay
 *   dynamic; {@link TOOL_FLAG_COPY} only upgrades the copy of a flag that
 *   already exists (the Oracle reviewer, the background Keeper).
 *
 * Each row carries an enable/disable switch (`ui-primitives` `Switch`) that
 * writes `capabilities.<kind>.<id>` through the shared optimistic
 * {@link toggleCapability} writer: 0ms local flip, rollback on a rejected
 * write. Catalog authoring — add, remove, edit — stays on the Settings →
 * Dynamic page, linked from the header; the shared writers below stay exported
 * for that page (`McpPanel` / `SkillsPanel`). A mount failure reported by the
 * host lands in `mcpStatus[id].error` and renders per row.
 *
 * Skill catalog addressing: the tab's own `sessionId` is the first candidate;
 * when the host refuses to inspect it (legacy v0/v1 session logs), the newest
 * session ids follow, up to five, before the page reports an explicit
 * "skill catalog unavailable" error with a Retry instead of pretending the
 * catalog is empty. The catalog re-reads when the tab becomes visible.
 *
 * The module-level cache is the page's state channel (same discipline as the
 * persona/params stores): synchronous 0ms snapshot on mount, optimistic local
 * toggles with rollback, background persistence.
 */
import { useState, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AGENT_MODELS_KIND } from './kinds.ts'
import {
  countPermissionRules,
  getPermissionsViewState,
  refreshFromServer as refreshPermissionsView,
  subscribePermissionsView,
  type PermissionsConfig,
} from './permissions-model.ts'
import { ensureSettingsFresh, isSettingsCacheFresh, readEnpoiNamespace, SETTINGS_MOUNT_STALE_MS } from './settings-refresh.ts'
import { PROTECTED_CAPABILITIES } from './capability-catalog.ts'
import type { FleetCouncil, FleetCouncilSeat } from './role-registry.ts'
import css from './CapabilitiesBody.module.css'

/** How many session ids the skill catalog tries before reporting unavailable. */
const MAX_SKILL_SESSION_CANDIDATES = 5

/** CSS-module reads are `string | undefined` under noUncheckedIndexedAccess; keys are static. */
function c(name: string): string {
  return css[name] ?? ''
}

/** Monochrome plug glyph shared by the guide capsule and the MCP section header. */
function iconPlug(size: number, strokeWidth = 1.3): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.5 1.5v3M10.5 1.5v3M3.5 7h9v1.5a4.5 4.5 0 0 1-9 0V7ZM8 13v1.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function iconSparkle(size = 12): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5 9.3 6.7 14.5 8 9.3 9.3 8 14.5 6.7 9.3 1.5 8 6.7 6.7 8 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function iconCouncil(size = 12): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="3.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.5" cy="11.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12.5" cy="11.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.6 5.4 4.9 9.9M9.4 5.4l1.7 4.5M5.5 11.75h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function iconTerminal(size = 12): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.75 6.5 2 1.75-2 1.75M8.75 10.25h2.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Monochrome tab glyph for Capabilities (thin stroke, currentColor), also the guide capsule icon. */
export function CapabilitiesIcon({
  size = 16,
  className,
}: {
  size?: number | undefined
  active?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M5.5 1.5v3M10.5 1.5v3M3.5 7h9v1.5a4.5 4.5 0 0 1-9 0V7ZM8 13v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export interface CapabilitiesState {
  tools: Record<string, boolean>
  skills: Record<string, boolean>
  mcp: Record<string, boolean>
}

/**
 * Cross-plugin door into the Settings panel (wired from `apply` through the
 * `settingsUi` service). A module-level slot keeps this pure-presentation
 * component free of ctx; the drawer links to Permissions and Dynamic with it.
 */
let openSettingsHandler: ((id: string) => void) | null = null

/** Install (or clear with `null`) the settings opener used by this drawer. */
export function setOpenSettingsHandler(handler: ((id: string) => void) | null): void {
  openSettingsHandler = handler
}

/** Open Settings on one registered section when the shell is present. */
function openSettings(section: string): void {
  openSettingsHandler?.(section)
}

/** Title-case one capability id for a row with no registry label. */
function titleCaseId(id: string): string {
  return id.split(/[-_]+/).filter(Boolean).map(word => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))).join(' ')
}

/** Live skill rows discovered host-side via skills.list (OpenCode-parity dynamics). */
export interface DynamicSkillEntry {
  name: string
  description: string
  modelInvocable: boolean
}

/** Host-side MCP reachability heartbeat (enpoi-capabilities writes enpoi-orchestration.mcpStatus). */
export interface McpStatusEntry {
  state: 'online' | 'down'
  mounted: boolean
  checkedAt: number
  authError?: boolean
  /** Last mount failure reported by the host; cleared by a successful mount. */
  error?: string
}

/** Server catalog entries (enpoi-orchestration.mcpServers). */
export interface McpServerEntry {
  serverName?: string
  transport?: string
  url?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

/** One effective role row (`enpoiRoles.list`) rendered by the Subagents section. */
export interface LiveRoleEntry {
  id: string
  label?: string
  group?: string
  /** Whether the generic `subagent` tool may spawn it; `false` = tool-only. */
  spawnable?: boolean
}

/**
 * Operator-facing copy for tool flags whose stored id is not self-describing.
 * Purely presentational: the row itself still exists only because the live
 * `capabilities.tools` map stores the flag, an unknown flag keeps the generic
 * copy, and a row the registries below already cover is never duplicated.
 */
const TOOL_FLAG_COPY: Readonly<Record<string, { name: string; description: string; badge?: string }>> = {
  oracle_review: {
    name: 'The Oracle',
    description: 'Senior reviewer — consulted via oracle_review with source-verified verdicts',
    badge: 'supervision · tool-only',
  },
  keeper: {
    name: 'Background Context Keeper',
    description: "Keeps the session's state checkpoint and durable claims current",
    badge: 'supervision',
  },
}

/**
 * One council row (`enpoiCouncil.list`) rendered by the Councils section and
 * consumed by the Agent Models fleet grouping.
 */
export interface LiveCouncilEntry extends FleetCouncil {
  /** Seat count when the registry reports only a count (a `seats` array wins). */
  seatCount?: number
  /** Whether the council itself is enabled (a retired council stays listed). */
  enabled?: boolean
}

let globalCapsState: CapabilitiesState = { tools: {}, skills: {}, mcp: {} }
let globalSkills: DynamicSkillEntry[] = []
let globalSkillsError: string | null = null
let globalSkillsLoading = false
let globalMcpStatus: Record<string, McpStatusEntry> = {}
let globalMcpServers: Record<string, McpServerEntry> = {}
let globalRoles: LiveRoleEntry[] = []
let globalRolesError: string | null = null
let globalCouncils: LiveCouncilEntry[] = []
let globalCouncilsError: string | null = null

let snapshotCache: {
  caps: CapabilitiesState
  skills: DynamicSkillEntry[]
  skillsError: string | null
  skillsLoading: boolean
  mcpStatus: Record<string, McpStatusEntry>
  mcpServers: Record<string, McpServerEntry>
  roles: LiveRoleEntry[]
  rolesError: string | null
  councils: LiveCouncilEntry[]
  councilsError: string | null
} = {
  caps: globalCapsState,
  skills: globalSkills,
  skillsError: globalSkillsError,
  skillsLoading: globalSkillsLoading,
  mcpStatus: globalMcpStatus,
  mcpServers: globalMcpServers,
  roles: globalRoles,
  rolesError: globalRolesError,
  councils: globalCouncils,
  councilsError: globalCouncilsError,
}

const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  snapshotCache = {
    caps: globalCapsState,
    skills: globalSkills,
    skillsError: globalSkillsError,
    skillsLoading: globalSkillsLoading,
    mcpStatus: globalMcpStatus,
    mcpServers: globalMcpServers,
    roles: globalRoles,
    rolesError: globalRolesError,
    councils: globalCouncils,
    councilsError: globalCouncilsError,
  }
  for (const fn of listeners) fn()
}

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/** The settings.describe view of one enpoi-orchestration namespace. */
interface OrchestrationNamespaceView {
  ns?: string
  /** Monotonic namespace revision; the fence for catalog writes. */
  revision?: number
  value?: {
    capabilities?: Partial<CapabilitiesState>
    mcpStatus?: Record<string, McpStatusEntry>
    mcpServers?: Record<string, McpServerEntry>
    permissions?: PermissionsConfig
  }
}

/** Doc 55 permission policy wire types live in permissions-model.ts. */

/**
 * Read the enpoi-orchestration namespace through the package's shared
 * coalesced read: concurrent callers (the other stores included) share one
 * settings.describe.
 * @returns the namespace view, or undefined on a failed or malformed answer.
 */
async function describeOrchestration(): Promise<OrchestrationNamespaceView | undefined> {
  return await readEnpoiNamespace() as unknown as OrchestrationNamespaceView | undefined
}

/** One skills.list attempt; success carries the catalog, failure the reason to show. */
async function fetchSkillCatalog(sessionId: string): Promise<
  { ok: true; skills: DynamicSkillEntry[] } | { ok: false; reason: string }
> {
  try {
    const res = await fetch('/api/skills.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'skills.list',
        rpcId: nextRpcId('caps-skills'),
        payload: { args: { request: { sessionId } } },
      }),
    })
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as {
      result?: {
        ok?: boolean
        value?: { skills?: Array<{ name?: unknown; description?: unknown; modelInvocable?: unknown }> }
        error?: { message?: unknown }
      }
    }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, reason: typeof message === 'string' && message !== '' ? message : 'skill catalog request was rejected' }
    }
    const rows = result.value?.skills
    if (!Array.isArray(rows)) return { ok: false, reason: 'skill catalog response was malformed' }
    const skills: DynamicSkillEntry[] = []
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name === '') continue
      skills.push({
        name: row.name,
        description: typeof row.description === 'string' ? row.description : '',
        modelInvocable: row.modelInvocable === true,
      })
    }
    return { ok: true, skills }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Read the skill catalog, trying the tab's session first and then the newest
 * session ids (newest first, up to {@link MAX_SKILL_SESSION_CANDIDATES}) until
 * one resolves. Failure publishes an explicit reason instead of an empty list.
 * @param sessionIds - candidate session ids, most relevant first.
 */
export async function refreshSkills(sessionIds: readonly string[]): Promise<void> {
  const candidates: string[] = []
  for (const id of sessionIds) {
    if (id === '' || candidates.includes(id)) continue
    candidates.push(id)
    if (candidates.length >= MAX_SKILL_SESSION_CANDIDATES) break
  }
  if (candidates.length === 0) {
    globalSkillsError = 'no session available to resolve the skill catalog'
    globalSkillsLoading = false
    notify()
    return
  }
  globalSkillsLoading = true
  globalSkillsError = null
  notify()
  let reason = 'skill catalog request failed'
  for (const sessionId of candidates) {
    const attempt = await fetchSkillCatalog(sessionId)
    if (attempt.ok) {
      globalSkills = attempt.skills
      globalSkillsError = null
      globalSkillsLoading = false
      notify()
      return
    }
    reason = attempt.reason
  }
  globalSkillsError = reason
  globalSkillsLoading = false
  notify()
}

/** Re-read MCP heartbeat + server catalog from settings.describe (cheap, periodic while visible). */
export async function refreshMcpStatus(): Promise<void> {
  try {
    const orch = await describeOrchestration()
    let changed = false
    if (orch?.value?.mcpStatus !== undefined && typeof orch.value.mcpStatus === 'object') {
      globalMcpStatus = orch.value.mcpStatus
      changed = true
    }
    if (orch?.value?.mcpServers !== undefined && typeof orch.value.mcpServers === 'object') {
      globalMcpServers = orch.value.mcpServers
      changed = true
    }
    if (changed) notify()
  } catch {
    // keep last known status on transient failures
  }
}

/** Read the effective role registry (`enpoiRoles.list`). */
export async function refreshRoles(): Promise<void> {
  try {
    const res = await fetch('/api/enpoiRoles.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiRoles.list',
        rpcId: nextRpcId('caps-roles'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) {
      globalRolesError = `gateway responded ${res.status}`
      notify()
      return
    }
    const json = await res.json() as { result?: { ok?: boolean; value?: { roles?: unknown }; error?: { message?: unknown } } }
    const result = json?.result
    if (result?.ok !== true || !Array.isArray(result.value?.roles)) {
      const message = result?.error?.message
      globalRolesError = typeof message === 'string' && message !== '' ? message : 'role registry unavailable'
      notify()
      return
    }
    const roles: LiveRoleEntry[] = []
    for (const raw of result.value.roles) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      if (typeof row.id !== 'string' || row.id === '') continue
      roles.push({
        id: row.id,
        ...(typeof row.label === 'string' && row.label !== '' ? { label: row.label } : {}),
        ...(typeof row.group === 'string' && row.group !== '' ? { group: row.group } : {}),
        ...(typeof row.spawnable === 'boolean' ? { spawnable: row.spawnable } : {}),
      })
    }
    globalRoles = roles
    globalRolesError = null
    notify()
  } catch (err: unknown) {
    globalRolesError = err instanceof Error ? err.message : String(err)
    notify()
  }
}

/** Parse one council seat out of the registry answer, dropping rows without an id. */
function parseCouncilSeat(raw: unknown): FleetCouncilSeat | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== 'string' || rec.id === '') return undefined
  const seat: FleetCouncilSeat = { id: rec.id }
  if (typeof rec.label === 'string' && rec.label !== '') seat.label = rec.label
  if (typeof rec.family === 'string' && rec.family !== '') seat.family = rec.family
  return seat
}

/** One in-flight council read; concurrent callers share it. */
let councilsInFlight: Promise<void> | undefined

/** A call that arrived during the in-flight read, so it gets a trailing read. */
let councilsQueued = false

/** When the last council read succeeded (0 = never); a mount inside the window reuses it. */
let councilsLoadedAt = 0

/**
 * Read the council registry (`enpoiCouncil.list`). Concurrent callers share one
 * request; a caller that arrives during a read gets a trailing read, so a
 * trigger is never swallowed.
 * @returns a promise settled when this call's read (or the trailing one) finishes.
 */
export function refreshCouncils(): Promise<void> {
  if (councilsInFlight !== undefined) {
    councilsQueued = true
    return councilsInFlight
  }
  const run = async (): Promise<void> => {
    do {
      councilsQueued = false
      await readCouncils()
    } while (councilsQueued)
    councilsInFlight = undefined
  }
  councilsInFlight = run()
  return councilsInFlight
}

/** One read of the council registry into the module snapshot. */
async function readCouncils(): Promise<void> {
  try {
    const res = await fetch('/api/enpoiCouncil.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCouncil.list',
        rpcId: nextRpcId('caps-councils'),
        payload: { args: {} },
      }),
    })
    if (!res.ok) {
      globalCouncilsError = `gateway responded ${res.status}`
      notify()
      return
    }
    const json = await res.json() as { result?: { ok?: boolean; value?: { councils?: unknown }; error?: { message?: unknown } } }
    const result = json.result
    if (result?.ok !== true || !Array.isArray(result.value?.councils)) {
      const message = result?.error?.message
      globalCouncilsError = typeof message === 'string' && message !== '' ? message : 'council registry unavailable'
      notify()
      return
    }
    const councils: LiveCouncilEntry[] = []
    for (const raw of result.value.councils) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      if (typeof row.id !== 'string' || row.id === '') continue
      const entry: LiveCouncilEntry = { id: row.id }
      if (typeof row.label === 'string' && row.label !== '') entry.label = row.label
      if (Array.isArray(row.seats)) {
        entry.seats = row.seats.map(parseCouncilSeat).filter((seat): seat is FleetCouncilSeat => seat !== undefined)
      } else if (typeof row.seatCount === 'number') {
        entry.seatCount = row.seatCount
      }
      if (Array.isArray(row.arbiters)) {
        entry.arbiters = row.arbiters.filter((id): id is string => typeof id === 'string' && id !== '')
      }
      if (typeof row.enabled === 'boolean') entry.enabled = row.enabled
      councils.push(entry)
    }
    globalCouncils = councils
    globalCouncilsError = null
    councilsLoadedAt = Date.now()
    notify()
  } catch (err: unknown) {
    globalCouncilsError = err instanceof Error ? err.message : String(err)
    notify()
  }
}

/**
 * View-mount path: a council read within `maxAgeMs` paints without a request;
 * an older or missing one starts the shared re-read.
 * @param maxAgeMs - the freshness window in milliseconds.
 */
export function ensureCouncilsFresh(maxAgeMs: number): void {
  if (councilsLoadedAt !== 0 && Date.now() - councilsLoadedAt < maxAgeMs) return
  void refreshCouncils()
}

/** Synchronous council-registry snapshot reader for the fleet grouping (stable between notifies). */
export function getCouncilRegistry(): readonly LiveCouncilEntry[] {
  return snapshotCache.councils
}

/**
 * Subscribe to council-registry changes (boot reads, pushes, reconnects).
 * @param listener - called after each council snapshot change.
 * @returns unsubscribe function.
 */
export function subscribeCouncilRegistry(listener: () => void): () => void {
  return subscribe(listener)
}

let capabilitiesPrimed = false

/**
 * Revision last applied to the capability snapshot. A read answering the same
 * revision carries the document this snapshot already holds, so it is skipped
 * without a notify.
 */
let appliedOrchestrationRevision: number | undefined

/** Prime the capability map + MCP state once when the first tab mounts. */
function applyOrchestration(orch: Awaited<ReturnType<typeof describeOrchestration>>): void {
  if (orch === undefined) return
  if (orch.revision !== undefined && orch.revision === appliedOrchestrationRevision) return
  appliedOrchestrationRevision = orch.revision
  const serverCaps = orch?.value?.capabilities
  if (serverCaps !== undefined) {
    const next: CapabilitiesState = { tools: {}, skills: {}, mcp: {} }
    if (serverCaps.tools !== undefined) Object.assign(next.tools, serverCaps.tools)
    if (serverCaps.skills !== undefined) Object.assign(next.skills, serverCaps.skills)
    if (serverCaps.mcp !== undefined) Object.assign(next.mcp, serverCaps.mcp)
    globalCapsState = next
    notify()
  }
  if (orch?.value?.mcpStatus !== undefined && typeof orch.value.mcpStatus === 'object') {
    globalMcpStatus = orch.value.mcpStatus
    notify()
  }
  if (orch?.value?.mcpServers !== undefined && typeof orch.value.mcpServers === 'object') {
    globalMcpServers = orch.value.mcpServers
    notify()
  }
}

/**
 * Re-read this namespace and repaint: the cross-client settings subscription
 * calls it when another client changes capabilities (skills, tools, MCPs).
 */
export async function refreshCapabilities(): Promise<void> {
  try {
    applyOrchestration(await describeOrchestration())
  } catch {
    // keep last known state on transient failures
  }
}

export async function primeCapabilities(): Promise<void> {
  if (capabilitiesPrimed) return
  capabilitiesPrimed = true
  try {
    applyOrchestration(await describeOrchestration())
  } catch {
    // keep last known state on transient failures
  }
}

/** Per-key toggle generations: a stale failure never rolls back a newer write. */
const toggleGenerations = new Map<string, number>()

/**
 * Restore one capability's previous value after a failed write. A newer toggle
 * for the same key (already optimistically applied) is left untouched, and a
 * key that did not exist before is removed without a dynamic delete.
 * @param kind - capability family.
 * @param id - capability id.
 * @param generation - the toggle generation that attempted the write.
 * @param had - whether the key existed before that attempt.
 * @param previousValue - the value before that attempt.
 */
function rollbackCapability(
  kind: 'tool' | 'skill' | 'mcp',
  id: string,
  generation: number,
  had: boolean,
  previousValue: boolean | undefined,
): void {
  if (toggleGenerations.get(`${kind}:${id}`) !== generation) return
  const next: CapabilitiesState = {
    tools: { ...globalCapsState.tools },
    skills: { ...globalCapsState.skills },
    mcp: { ...globalCapsState.mcp },
  }
  const family = kind === 'tool' ? next.tools : kind === 'skill' ? next.skills : next.mcp
  const repaired: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(family)) {
    if (key !== id) repaired[key] = value
  }
  if (had) repaired[id] = previousValue === true
  if (kind === 'tool') next.tools = repaired
  else if (kind === 'skill') next.skills = repaired
  else next.mcp = repaired
  globalCapsState = next
  notify()
}

export async function toggleCapability(kind: 'tool' | 'skill' | 'mcp', id: string, enabled: boolean): Promise<boolean> {
  if (PROTECTED_CAPABILITIES.has(id) && !enabled) return false

  const generation = (toggleGenerations.get(`${kind}:${id}`) ?? 0) + 1
  toggleGenerations.set(`${kind}:${id}`, generation)
  const source = kind === 'tool' ? globalCapsState.tools : kind === 'skill' ? globalCapsState.skills : globalCapsState.mcp
  const had = Object.hasOwn(source, id)
  const previousValue = source[id]
  const next: CapabilitiesState = {
    tools: { ...globalCapsState.tools },
    skills: { ...globalCapsState.skills },
    mcp: { ...globalCapsState.mcp },
  }

  if (kind === 'tool') next.tools[id] = enabled
  if (kind === 'skill') next.skills[id] = enabled
  if (kind === 'mcp') next.mcp[id] = enabled

  globalCapsState = next
  notify()
  const failed = (): false => {
    rollbackCapability(kind, id, generation, had, previousValue)
    return false
  }

  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: nextRpcId('caps-toggle'),
        payload: {
          args: {
            ns: 'enpoi-orchestration',
            ops: [{ op: 'set', path: ['capabilities', kind === 'tool' ? 'tools' : kind === 'skill' ? 'skills' : 'mcp', id], value: enabled }],
          },
        },
      }),
    })
    if (!res.ok) return failed()
    // The gateway answers HTTP 200 for business failures too; only an explicit
    // `ok: true` result counts as persisted.
    const json = await res.json() as { result?: { ok?: boolean } }
    if (json?.result?.ok !== true) return failed()
    return true
  } catch {
    return failed()
  }
}

export type CapabilitiesBodyProps = PropsRuntime<'sidebar.right.pane.tab'>

/** Outcome of one MCP catalog write: persisted, or the reason to show the operator. */
export type McpWriteResult = { ok: true } | { ok: false; reason: string }

/** One path op inside the enpoi-orchestration namespace. */
interface McpSettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

/** How many times a fenced catalog write re-reads and retries on conflict. */
const MAX_MCP_WRITE_RETRIES = 3

/** Whether a string is an http(s) URL the mount machinery can dial. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Post one catalog write fenced by the revision read from describe. */
async function postMcpMutation(ops: McpSettingsOp[], expectedRevision: number | undefined): Promise<{ ok: boolean; conflict: boolean }> {
  const args: Record<string, unknown> = { ns: 'enpoi-orchestration', ops }
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision
  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: nextRpcId('caps-mcp-write'),
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

/** One add-server form submission. */
export interface McpServerInput {
  serverName: string
  url: string
  apiKeyEnv?: string
  headers?: Record<string, string>
}

/**
 * Add one MCP server at `enpoi-orchestration.mcpServers.<id>`. Validation
 * rejects an empty id, a non-http(s) url, and an id already in the live
 * catalog. The row is published optimistically at 0ms and rolls back when the
 * write does not persist; the write is fenced by the namespace revision read
 * from describe, and a `settings/conflict` re-reads and retries
 * {@link MAX_MCP_WRITE_RETRIES} times.
 * @param input - the form's values.
 * @returns whether the entry persisted, or the reason it did not.
 */
export async function addMcpServer(input: McpServerInput): Promise<McpWriteResult> {
  const id = input.serverName.trim()
  if (id === '') return { ok: false, reason: 'server id is required' }
  const url = input.url.trim()
  if (!isHttpUrl(url)) return { ok: false, reason: 'url must be an http(s) address' }
  if (globalMcpServers[id] !== undefined) return { ok: false, reason: `server id "${id}" already exists` }
  const entry: McpServerEntry = {
    serverName: id,
    transport: 'streamable-http',
    url,
    ...(input.apiKeyEnv !== undefined && input.apiKeyEnv.trim() !== '' ? { apiKeyEnv: input.apiKeyEnv.trim() } : {}),
    ...(input.headers !== undefined && Object.keys(input.headers).length > 0 ? { headers: { ...input.headers } } : {}),
  }
  const previous = globalMcpServers
  globalMcpServers = { ...globalMcpServers, [id]: entry }
  notify()
  for (let attempt = 0; attempt <= MAX_MCP_WRITE_RETRIES; attempt++) {
    const view = await describeOrchestration()
    if (view === undefined) {
      globalMcpServers = previous
      notify()
      return { ok: false, reason: 'settings service is unavailable' }
    }
    if (view.value?.mcpServers?.[id] !== undefined) {
      // Another client added the id first: keep the server's catalog, drop ours.
      globalMcpServers = view.value.mcpServers
      notify()
      return { ok: false, reason: `server id "${id}" already exists` }
    }
    const outcome = await postMcpMutation([{ op: 'set', path: ['mcpServers', id], value: entry }], view.revision)
    if (outcome.ok) return { ok: true }
    if (!outcome.conflict) {
      globalMcpServers = previous
      notify()
      return { ok: false, reason: 'settings write was rejected' }
    }
  }
  globalMcpServers = previous
  notify()
  return { ok: false, reason: 'settings write conflicted repeatedly' }
}

/**
 * Remove one MCP server from the catalog (`unset` of its
 * `enpoi-orchestration.mcpServers.<id>` key), fenced by the namespace revision
 * read from describe with the same conflict retry as {@link addMcpServer}.
 * The row disappears optimistically and returns when the write does not persist.
 * A cache miss — the id has no stored record in the local catalog view — is
 * reported instead of answering ok, so a caller never treats a no-op as a
 * removal.
 * @param id - catalog key to remove.
 * @returns whether the removal persisted, or the reason it did not.
 */
export async function removeMcpServer(id: string): Promise<McpWriteResult> {
  const previous = globalMcpServers
  if (previous[id] === undefined) return { ok: false, reason: `no stored mcpServers.${id} record to remove` }
  const next = Object.fromEntries(
    Object.entries(previous).filter(([key]) => key !== id),
  ) as typeof previous
  globalMcpServers = next
  notify()
  for (let attempt = 0; attempt <= MAX_MCP_WRITE_RETRIES; attempt++) {
    const view = await describeOrchestration()
    if (view === undefined) {
      globalMcpServers = previous
      notify()
      return { ok: false, reason: 'settings service is unavailable' }
    }
    const outcome = await postMcpMutation([{ op: 'unset', path: ['mcpServers', id] }], view.revision)
    if (outcome.ok) return { ok: true }
    if (!outcome.conflict) {
      globalMcpServers = previous
      notify()
      return { ok: false, reason: 'settings write was rejected' }
    }
  }
  globalMcpServers = previous
  notify()
  return { ok: false, reason: 'settings write conflicted repeatedly' }
}

/**
 * Doc 55 permissions Tier-1 strip: a read-only counts row over the live
 * policy (global + per-agent tool rules, standing grants). Full editing
 * lives in the Settings page's Permissions section; no cross-surface
 * settings-open action is exposed to tab components, so no link is offered.
 */
function PermissionsSection() {
  const [counts, setCounts] = useState<{ rules: number; grants: number } | null>(null)
  const [failed, setFailed] = useState(false)

  // Counts come from the permissions store, not a private fetch: the strip
  // paints the shared 0ms cache, follows every pushed refresh, and a mount
  // that finds the cache cold or stale re-reads through the same coalescing.
  useEffect(() => {
    const paint = (): void => {
      const state = getPermissionsViewState()
      if (state.view === undefined) {
        setFailed(true)
        return
      }
      setFailed(false)
      setCounts(countPermissionRules(state.view.value?.permissions))
    }
    paint()
    if (getPermissionsViewState().view === undefined || !isSettingsCacheFresh(SETTINGS_MOUNT_STALE_MS)) {
      void refreshPermissionsView().then(paint)
    }
    return subscribePermissionsView(paint)
  }, [])

  return (
    <section className={c('group')} key="permissions">
      <div className={c('groupHead')}>
        <div className={c('groupHeadLeft')}>
          <span className={c('groupIcon')}>{iconTerminal()}</span>
          <span className={c('groupTitle')}>Permissions</span>
        </div>
        {counts !== null && (
          <span className={c('countBadge')}>
            {counts.rules} {counts.rules === 1 ? 'rule' : 'rules'} · {counts.grants} {counts.grants === 1 ? 'grant' : 'grants'}
          </span>
        )}
      </div>
      {counts === null ? (
        <div className={c('empty')}>{failed ? 'Permission policy unavailable.' : 'Loading policy…'}</div>
      ) : (
        <div className={c('permHint')}>
          Unconfigured tools default to <b>ask</b>; bash commands match patterns first, then the tool policy.
          {' '}
          <button type="button" className={c('footLink')} onClick={() => { openSettings('permissions') }}>
            Edit rules
          </button>
        </div>
      )}
    </section>
  )
}

/** One drawer row: a live capability with the kind whose state key it writes. */
interface LiveRow {
  id: string
  name: string
  description: string
  kind: 'tool' | 'skill' | 'mcp'
  /** Small trailing tag: registry group, 'retired', 'user-only', … */
  badge?: string
}

/** Whether one row reads as enabled under the same rule the enforcement applies. */
function rowEnabled(row: LiveRow, caps: CapabilitiesState): boolean {
  if (row.kind === 'mcp') return caps.mcp[row.id] === true
  if (row.kind === 'skill') return caps.skills[row.id] !== false
  return caps.tools[row.id] !== false
}

export function CapabilitiesBody({ sessionId, useSessions, useTabInfo }: CapabilitiesBodyProps) {
  const { tab } = useTabInfo()
  const view = useSyncExternalStore(subscribe, () => snapshotCache)
  const caps = view.caps
  const visible = tab.visible
  const sessionIds = useSessions(state => state.ids)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [writeError, setWriteError] = useState<string | null>(null)

  // Candidate chain: the tab's own session first, then the newest sessions the
  // list carries. Bounded so an old session never costs a long retry walk.
  const candidates = useMemo(() => {
    const list: string[] = []
    if (typeof sessionId === 'string' && sessionId !== '') list.push(sessionId)
    for (const id of sessionIds) {
      if (list.length >= MAX_SKILL_SESSION_CANDIDATES) break
      const value = String(id)
      if (!list.includes(value)) list.push(value)
    }
    return list
  }, [sessionId, sessionIds])

  // Prime the persisted capability map on the first mount; a tab reopened
  // later re-reads only when the shared cache aged past the mount window.
  useEffect(() => {
    if (capabilitiesPrimed) ensureSettingsFresh(SETTINGS_MOUNT_STALE_MS)
    else void primeCapabilities()
  }, [])
  // Every live source refreshes when the tab becomes visible and when its
  // address chain changes, so a settings write or a new skill/server shows up
  // without a reload.
  useEffect(() => {
    if (!visible) return
    if (candidates.length > 0) void refreshSkills(candidates)
    void refreshRoles()
    void refreshCouncils()
  }, [visible, candidates])
  // MCP heartbeat + server catalog re-poll every 15s while the tab is visible.
  useEffect(() => {
    if (!visible) return
    void refreshMcpStatus()
    const iv = window.setInterval(() => { void refreshMcpStatus() }, 15_000)
    return () => { window.clearInterval(iv) }
  }, [visible])

  // Live rows, in each registry's own order. No entry is listed that the host
  // does not report, and a new entry needs no code change.
  const mcpRows: LiveRow[] = Object.entries(view.mcpServers).map(([id, def]) => {
    const friendly = def.serverName !== undefined && def.serverName !== ''
      ? def.serverName.charAt(0).toUpperCase() + def.serverName.slice(1)
      : titleCaseId(id.replace(/-mcp$/, ''))
    let desc = def.transport !== undefined && def.transport !== ''
      ? def.transport
      : 'MCP server'
    if (def.url !== undefined) {
      try { desc = new URL(def.url).host } catch { /* keep transport label */ }
    }
    return { id, name: `${friendly} MCP`, description: desc, kind: 'mcp' as const }
  })
  const skillRows: LiveRow[] = view.skills.map(s => ({
    id: s.name,
    name: titleCaseId(s.name),
    description: s.description,
    kind: 'skill' as const,
    ...(s.modelInvocable ? {} : { badge: 'user-only' }),
  }))
  // Delegatable roles only: a tool-only role (the Oracle) has no spawn
  // affordance here — its switch lives on its tool flag below, under the tool's
  // own enforcement key. Dynamic by data, no id list.
  const roleRows: LiveRow[] = view.roles
    .filter(r => r.spawnable !== false)
    .map(r => ({
      id: r.id,
      name: r.label ?? titleCaseId(r.id),
      description: 'Delegated subagent role',
      kind: 'tool' as const,
      ...(r.group !== undefined ? { badge: r.group } : {}),
    }))
  const councilRows: LiveRow[] = view.councils.map((council) => {
    const seatCount = council.seats?.length ?? council.seatCount
    return {
      id: council.id,
      name: council.label ?? titleCaseId(council.id),
      description: seatCount !== undefined ? `${seatCount} seats` : 'Debate council',
      kind: 'tool' as const,
      badge: council.enabled === false ? 'retired' : 'council',
    }
  })
  // Stored tool flags the registries above do not already cover: the guard's
  // direct tool vocabulary has no enumeration RPC, so the operator's stored
  // keys are the live source.
  const registryIds = new Set([...roleRows, ...councilRows].map(row => row.id))
  const toolFlagRows: LiveRow[] = Object.keys(caps.tools)
    .filter(id => !registryIds.has(id))
    .map((id) => {
      const copy = TOOL_FLAG_COPY[id]
      return {
        id,
        name: copy?.name ?? titleCaseId(id),
        description: copy?.description ?? 'Stored tool flag — blocks this tool at the execution guard',
        kind: 'tool' as const,
        ...(copy?.badge !== undefined ? { badge: copy.badge } : {}),
      }
    })

  const onToggle = (kind: LiveRow['kind'], id: string, next: boolean): void => {
    setWriteError(null)
    const key = `${kind}:${id}`
    setPending(current => ({ ...current, [key]: true }))
    void toggleCapability(kind, id, next).then((accepted) => {
      setPending(current => ({ ...current, [key]: false }))
      if (!accepted) setWriteError(`Could not persist ${id} — the toggle was rolled back.`)
    })
  }

  const errorBanner = view.skillsError !== null
    ? (
      <div className={c('skillError')}>
        <span className={c('errorLine')} title={view.skillsError}>
          skill catalog unavailable: {view.skillsError}
        </span>
        <button type="button" className={c('retryBtn')} onClick={() => { void refreshSkills(candidates) }}>
          Retry
        </button>
      </div>
    )
    : undefined

  const registryError = (reason: string | null, retry: () => void) => reason !== null
    ? (
      <div className={c('skillError')}>
        <span className={c('errorLine')} title={reason}>{reason}</span>
        <button type="button" className={c('retryBtn')} onClick={retry}>Retry</button>
      </div>
    )
    : undefined

  const renderGroup = (title: string, icon: ReactNode, rows: readonly LiveRow[], banner?: ReactNode) => {
    const activeCount = rows.filter(row => rowEnabled(row, caps)).length

    return (
      <section className={c('group')} key={title}>
        <div className={c('groupHead')}>
          <div className={c('groupHeadLeft')}>
            <span className={c('groupIcon')}>{icon}</span>
            <span className={c('groupTitle')}>{title}</span>
          </div>
          <span className={c('countBadge')}>{activeCount} / {rows.length}</span>
        </div>
        {banner}
        <div className={c('list')}>
          {rows.map((row) => {
            const isProtected = PROTECTED_CAPABILITIES.has(row.id)
            const enabled = isProtected ? true : rowEnabled(row, caps)
            const key = `${row.kind}:${row.id}`

            // MCP rows: connection heartbeat beside the switch. The host's
            // last mount failure outranks online/down while it is fresh.
            const st = row.kind === 'mcp' ? view.mcpStatus[row.id] : undefined
            const stFresh = st !== undefined && Date.now() - st.checkedAt <= 45_000
            let dotColor = enabled ? '#34d399' : '#64748b'
            let dotGlow = enabled ? '0 0 5px rgba(52, 211, 153, 0.6)' : 'none'
            let connTitle = ''
            if (row.kind === 'mcp' && st !== undefined) {
              if (!stFresh) {
                dotColor = '#475569'; dotGlow = 'none'
                connTitle = 'Checking availability…'
              } else if (st.error !== undefined) {
                dotColor = '#e5716f'; dotGlow = '0 0 4px rgba(229, 113, 111, 0.35)'
                connTitle = `Mount failed — ${st.error}`
              } else if (st.state === 'down') {
                dotColor = '#e5716f'; dotGlow = '0 0 4px rgba(229, 113, 111, 0.35)'
                connTitle = 'Not reachable — server not running'
              } else if (st.mounted) {
                dotColor = '#34d399'; dotGlow = '0 0 5px rgba(52, 211, 153, 0.6)'
                connTitle = 'Connected & mounted — tools active'
              } else {
                dotColor = '#67dce7'; dotGlow = '0 0 5px rgba(103, 220, 231, 0.45)'
                connTitle = st.authError === true ? 'Server running · auth rejected' : 'Server running · toggled off'
              }
            }

            return (
              <div className={c('row')} key={key}>
                <div className={c('rowInfo')}>
                  <div className={c('rowName')}>
                    <span
                      className={c('dot')}
                      title={row.kind === 'mcp' ? connTitle : undefined}
                      style={{
                        background: dotColor,
                        boxShadow: dotGlow,
                        cursor: row.kind === 'mcp' ? 'help' : undefined,
                      }}
                    />
                    <span>{row.name}</span>
                    {isProtected && <span className={c('coreBadge')}>Core</span>}
                    {row.badge !== undefined && <span className={c('coreBadge')}>{row.badge}</span>}
                  </div>
                  <div className={c('rowDesc')}>{row.description}</div>
                  {row.kind === 'mcp' && stFresh && st.error !== undefined && (
                    <div className={c('rowError')} title={st.error}>mount failed: {st.error}</div>
                  )}
                </div>
                <Switch
                  checked={enabled}
                  onChange={(next) => { onToggle(row.kind, row.id, next) }}
                  label={`${enabled ? 'Disable' : 'Enable'} ${row.name}`}
                  disabled={isProtected || pending[key] === true}
                  title={isProtected ? 'Protected infrastructure capability' : undefined}
                />
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  const skillsSection = renderGroup(
    'Specialist Skills',
    iconSparkle(),
    skillRows,
    view.skillsError !== null
      ? errorBanner
      : view.skillsLoading && skillRows.length === 0
        ? <div className={c('empty')}>Loading skill catalog…</div>
        : skillRows.length === 0
          ? (
            <div className={c('empty')}>
              No skills discovered yet. Drop a folder with a SKILL.md into ~/.dsh/skills/ to add one.
            </div>
          )
          : undefined,
  )

  return (
    <div className={c('container')}>
      <header className={c('head')}>
        <h3 className={c('headTitle')}>Capabilities Control Center</h3>
        <p className={c('headSub')}>
          Live toggles for MCP servers, Skills, Subagents &amp; Councils
          {' · '}
          <button type="button" className={c('footLink')} onClick={() => { openSettings('dynamic') }}>
            Manage in Settings
          </button>
        </p>
      </header>

      {writeError !== null && (
        <div className={c('skillError')}>
          <span className={c('errorLine')} title={writeError}>{writeError}</span>
        </div>
      )}

      <div className={c('groups')}>
        <PermissionsSection />
        {renderGroup('MCP Tool Suites', iconPlug(12, 1.3), mcpRows,
          mcpRows.length === 0
            ? <div className={c('empty')}>No MCP servers configured. Add one in Settings → Dynamic.</div>
            : undefined)}
        {skillsSection}
        {renderGroup('Subagents', iconCouncil(), roleRows,
          registryError(view.rolesError, () => { void refreshRoles() }))}
        {renderGroup('Councils', iconCouncil(), councilRows,
          registryError(view.councilsError, () => { void refreshCouncils() }))}
        {renderGroup('Tool Flags', iconTerminal(), toolFlagRows)}
      </div>

      <footer className={c('foot')}>
        <span>Switches write capabilities.* and apply from the next query. Add, remove, and edit live in Settings → Dynamic.</span>
        <button
          type="button"
          className={c('footLink')}
          onClick={() => { tab.actions.openTab(AGENT_MODELS_KIND) }}
        >
          Agent Models
        </button>
      </footer>
    </div>
  )
}
