import React, { useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import type { SidebarStore, SidebarTab } from '../state.ts'
import type { SessionScope } from '../api.ts'

/** Minimal 12px monochrome glyphs (currentColor) matching the Liquid Glass theme. */
function iconPlug(size = 12): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} xmlns="http://www.w3.org/2000/svg">
      <path d="M5.5 1.5v3M10.5 1.5v3M3.5 7h9v1.5a4.5 4.5 0 0 1-9 0V7ZM8 13v1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function iconSparkle(size = 12): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5 9.3 6.7 14.5 8 9.3 9.3 8 14.5 6.7 9.3 1.5 8 6.7 6.7 8 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

function iconCouncil(size = 12): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="3.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="3.5" cy="11.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12.5" cy="11.75" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.6 5.4 4.9 9.9M9.4 5.4l1.7 4.5M5.5 11.75h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

function iconTerminal(size = 12): React.ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} xmlns="http://www.w3.org/2000/svg">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.75 6.5 2 1.75-2 1.75M8.75 10.25h2.75" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export interface CapabilitiesState {
  tools: Record<string, boolean>
  skills: Record<string, boolean>
  mcp: Record<string, boolean>
}

export interface CapabilityDescriptor {
  id: string
  name: string
  kind: 'tool' | 'skill' | 'mcp'
  description: string
  category: 'mcp' | 'skills' | 'supervision' | 'council' | 'workers' | 'core-tools'
  defaultEnabled: boolean
  protected?: boolean
}

export const PROTECTED_CAPABILITIES = new Set<string>([
  'enpoi-contracts',
  'enpoi-context-keeper',
  'enpoi-cascade',
  'enpoi-living-brief',
  'read',
  'glob',
  'grep',
])

export const KNOWN_CAPABILITIES: readonly CapabilityDescriptor[] = [
  // MCP Servers (Default OFF)
  { id: 'plane-mcp', name: 'Plane MCP', kind: 'mcp', category: 'mcp', description: 'Project management and backlog tooling', defaultEnabled: false },
  { id: 'ue-mcp', name: 'Unreal Engine MCP', kind: 'mcp', category: 'mcp', description: 'Unreal Engine editor automation and actor controls', defaultEnabled: false },

  // Skills (Default ON)
  { id: 'project-management', name: 'Project Management', kind: 'skill', category: 'skills', description: 'Plane documentation and progress journaling', defaultEnabled: true },
  { id: 'ue-mcp', name: 'UE5 Automation Skill', kind: 'skill', category: 'skills', description: 'Unreal Engine 5 MCP workflows', defaultEnabled: true },
  { id: 'tier1-workflow', name: 'Tier 1 Guided Workflow', kind: 'skill', category: 'skills', description: 'Guided planning with Oracle supervision', defaultEnabled: true },
  { id: 'tier2-workflow', name: 'Tier 2 Ideation Workflow', kind: 'skill', category: 'skills', description: 'Ideation and Roundtable debate planning', defaultEnabled: true },
  { id: 'tier3-workflow', name: 'Tier 3 Full Workflow', kind: 'skill', category: 'skills', description: 'Complex implementation with continuous supervision', defaultEnabled: true },

  // Subagents & Debaters (Default ON)
  { id: 'keeper', name: 'Context Keeper (Background)', kind: 'tool', category: 'supervision', description: 'Background Living Brief distillation and CBDC memory claims extraction', defaultEnabled: true },
  { id: 'oracle_review', name: 'The Oracle (Supervisor)', kind: 'tool', category: 'supervision', description: 'Senior supervisor for architectural reviews and plan verification', defaultEnabled: true },
  { id: 'roundtable', name: 'Roundtable Debate', kind: 'tool', category: 'council', description: 'Colosseum dialectic 3-way debate across Skeptic, Architect & Pragmatist', defaultEnabled: true },
  { id: 'chorus', name: 'Chorus Brainstorm', kind: 'tool', category: 'council', description: 'Polyphonic brainstorming across Visionary, Experiencer & Integrator', defaultEnabled: true },
  { id: 'fixer', name: 'Fixer Worker', kind: 'tool', category: 'workers', description: 'Bounded code implementation and localized bug detection', defaultEnabled: true },
  { id: 'explorer', name: 'Explorer Worker', kind: 'tool', category: 'workers', description: 'Codebase mapping and structural pattern discovery', defaultEnabled: true },
  { id: 'librarian', name: 'Librarian Worker', kind: 'tool', category: 'workers', description: 'External documentation research and web fetching', defaultEnabled: true },
  { id: 'designer', name: 'Designer Worker', kind: 'tool', category: 'workers', description: 'UI/UX design systems, layout, and visual polish', defaultEnabled: true },

  // Core System Tools (Default ON)
  { id: 'edit', name: 'File Editor', kind: 'tool', category: 'core-tools', description: 'Direct filesystem edits and string replacements', defaultEnabled: true },
  { id: 'write', name: 'File Writer', kind: 'tool', category: 'core-tools', description: 'File creation and overwrite capabilities', defaultEnabled: true },
  { id: 'bash', name: 'Bash Terminal', kind: 'tool', category: 'core-tools', description: 'Terminal command execution in persistent session', defaultEnabled: true },
  { id: 'memory_save', name: 'Memory Save', kind: 'tool', category: 'core-tools', description: 'Store durable facts into CBDC memory.db', defaultEnabled: true },
  { id: 'memory_search', name: 'Memory Search', kind: 'tool', category: 'core-tools', description: 'Semantic recall across SQLite memory.db', defaultEnabled: true },
] as const

function initialCaps(): CapabilitiesState {
  const tools: Record<string, boolean> = {}
  const skills: Record<string, boolean> = {}
  const mcp: Record<string, boolean> = {}
  for (const cap of KNOWN_CAPABILITIES) {
    if (cap.kind === 'tool') tools[cap.id] = cap.defaultEnabled
    if (cap.kind === 'skill') skills[cap.id] = cap.defaultEnabled
    if (cap.kind === 'mcp') mcp[cap.id] = cap.defaultEnabled
  }
  for (const p of PROTECTED_CAPABILITIES) tools[p] = true
  return { tools, skills, mcp }
}

let globalCapsState: CapabilitiesState = initialCaps()
const listeners = new Set<() => void>()

/** Live skill rows discovered host-side via skill.list (OpenCode-parity dynamics). */
export interface DynamicSkillEntry {
  name: string
  description: string
  modelInvocable: boolean
}

let globalSkills: DynamicSkillEntry[] = []

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

let globalMcpStatus: Record<string, McpStatusEntry> = {}
let globalMcpServers: Record<string, McpServerEntry> = {}

let snapshotCache: { caps: CapabilitiesState; skills: DynamicSkillEntry[]; mcpStatus: Record<string, McpStatusEntry>; mcpServers: Record<string, McpServerEntry> } = {
  caps: globalCapsState,
  skills: globalSkills,
  mcpStatus: globalMcpStatus,
  mcpServers: globalMcpServers,
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify() {
  snapshotCache = { caps: globalCapsState, skills: globalSkills, mcpStatus: globalMcpStatus, mcpServers: globalMcpServers }
  for (const fn of listeners) fn()
}

/** Fetch the real skill catalog for the session's project root. */
export async function refreshSkills(sessionId: string): Promise<void> {
  if (!sessionId) return
  try {
    const res = await fetch('/api/skills.list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'skills/list',
        rpcId: 'skill-list-caps',
        payload: { args: { request: { sessionId } } },
      }),
    })
    if (!res.ok) return
    const json = await res.json() as { result?: { ok?: boolean; value?: { skills?: DynamicSkillEntry[] }; error?: unknown } }
    // Typert wraps success as {ok:true, value:{skills}}; tolerate both shapes.
    const skills = (json as { result?: { value?: { skills?: DynamicSkillEntry[] } } })?.result?.value?.skills
      ?? (json as { result?: { ok?: boolean; value?: { skills?: DynamicSkillEntry[] } } })?.result?.value?.skills
    if (Array.isArray(skills)) {
      globalSkills = skills
      notify()
    } else if ((json as { result?: { ok?: boolean } })?.result?.ok === false) {
      // keep last known on typed error; do not clear catalog
    }
  } catch {
    // keep last known catalog on transient failures
  }
}

/** Re-read MCP heartbeat + server catalog from settings.describe (cheap, periodic while drawer open). */
export async function refreshMcpStatus(): Promise<void> {
  try {
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'settings/describe', rpcId: 'mcp-status-poll', payload: { args: {} } }),
    })
    if (!res.ok) return
    const json = await res.json() as { result?: { value?: { namespaces?: Array<{ ns?: string; value?: { mcpStatus?: Record<string, McpStatusEntry>; mcpServers?: Record<string, McpServerEntry> } }> } } }
    const namespaces = json?.result?.value?.namespaces
    const orch = Array.isArray(namespaces) ? namespaces.find(n => n.ns === 'enpoi-orchestration') : undefined
    let changed = false
    if (orch?.value?.mcpStatus && typeof orch.value.mcpStatus === 'object') {
      globalMcpStatus = orch.value.mcpStatus
      changed = true
    }
    if (orch?.value?.mcpServers && typeof orch.value.mcpServers === 'object') {
      globalMcpServers = orch.value.mcpServers
      changed = true
    }
    if (changed) notify()
  } catch {
    // keep last known status on transient failures
  }
}

/** One describe view of the enpoi-orchestration namespace with its write fence. */
interface OrchestrationSidebarView {
  revision?: number
  value?: { mcpServers?: Record<string, McpServerEntry> }
}

/** Read the enpoi-orchestration namespace (revision + catalog) through the live gateway. */
async function describeOrchestrationSidebar(): Promise<OrchestrationSidebarView | undefined> {
  try {
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', method: 'settings/describe', rpcId: `mcp-catalog-describe-${Date.now()}`, payload: { args: {} } }),
    })
    if (!res.ok) return undefined
    const json = await res.json() as { result?: { value?: { namespaces?: Array<{ ns?: string; revision?: number; value?: { mcpServers?: Record<string, McpServerEntry> } }> } } }
    const namespaces = json?.result?.value?.namespaces
    return Array.isArray(namespaces) ? namespaces.find(n => n.ns === 'enpoi-orchestration') : undefined
  } catch {
    return undefined
  }
}

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

/** Settings conflict codes the retry loop accepts (service enum + legacy slash spelling). */
const SETTINGS_CONFLICT_CODES = new Set(['SETTINGS_CONFLICT', 'settings/conflict'])

/** Atomic-route availability: undefined = not probed yet, false = host without it. */
let atomicRemoveRoute: boolean | undefined

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
        method: 'settings/mutate',
        rpcId: `mcp-catalog-mutate-${Date.now()}`,
        payload: { args },
      }),
    })
    if (!res.ok) return { ok: false, conflict: false }
    const json = await res.json() as { result?: { ok?: boolean; error?: { code?: string } } }
    if (json?.result?.ok === true) return { ok: true, conflict: false }
    const code = json?.result?.error?.code
    return { ok: false, conflict: code !== undefined && SETTINGS_CONFLICT_CODES.has(code) }
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
 * from describe, and a `settings/conflict` re-reads and retries.
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
    const view = await describeOrchestrationSidebar()
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
 * Call the host's atomic `enpoiCapabilities.removeMcpServer(id)` route: one
 * revision-fenced write that also prunes the policy rows the removed server
 * owned. A 404 means the running host has no such Remote namespace; the route
 * is remembered as absent and `undefined` lets the caller fall back to the
 * catalog-only path. A JSON failure from an existing route is reported as-is.
 * @param id - catalog key to remove.
 * @returns the route's verdict, or undefined when the route is absent.
 */
async function removeMcpServerAtomic(id: string): Promise<McpWriteResult | undefined> {
  if (atomicRemoveRoute === false) return undefined
  try {
    const res = await fetch('/api/enpoiCapabilities.removeMcpServer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'enpoiCapabilities.removeMcpServer',
        rpcId: `mcp-atomic-remove-${Date.now()}`,
        payload: { args: { id } },
      }),
    })
    if (res.status === 404) {
      atomicRemoveRoute = false
      return undefined
    }
    if (!res.ok) return { ok: false, reason: `gateway responded ${res.status}` }
    const json = await res.json() as { result?: { ok?: boolean; value?: { removed?: boolean; rows?: number }; error?: { message?: unknown } } }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, reason: typeof message === 'string' && message !== '' ? message : 'atomic remove was rejected' }
    }
    atomicRemoveRoute = true
    // `removed: false` means the entry was already gone (concurrent removal) or
    // the host had no writable settings service; the 15s heartbeat re-describes
    // the catalog and restores the row if it still exists.
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Remove one MCP server. Delegates to the atomic host route when the running
 * host exposes it (that write also prunes the server's policy rows), falling
 * back to the catalog-only `unset` of
 * `enpoi-orchestration.mcpServers.<id>` fenced by the namespace revision with
 * the same conflict retry. The row disappears optimistically and returns when
 * the write does not persist.
 * @param id - catalog key to remove.
 * @returns whether the removal persisted, or the reason it did not.
 */
export async function removeMcpServer(id: string): Promise<McpWriteResult> {
  const previous = globalMcpServers
  if (previous[id] === undefined) return { ok: true }
  const next = { ...previous }
  delete next[id]
  globalMcpServers = next
  notify()
  const atomic = await removeMcpServerAtomic(id)
  if (atomic !== undefined) {
    if (!atomic.ok) {
      globalMcpServers = previous
      notify()
    }
    return atomic
  }
  return await removeMcpServerLegacy(id, previous)
}

/** Catalog-only removal (hosts without the atomic route), revision-fenced + retried. */
async function removeMcpServerLegacy(id: string, previous: Record<string, McpServerEntry>): Promise<McpWriteResult> {
  for (let attempt = 0; attempt <= MAX_MCP_WRITE_RETRIES; attempt++) {
    const view = await describeOrchestrationSidebar()
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

// Initial prime from describe
if (typeof window !== 'undefined') {
  void fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings/describe',
      rpcId: 'prime-caps-sidebar',
      payload: { args: {} },
    }),
  }).then(async (res) => {
    if (!res.ok) return
    const json = await res.json() as { result?: { value?: { namespaces?: Array<{ ns?: string; value?: { capabilities?: Partial<CapabilitiesState>; mcpStatus?: Record<string, McpStatusEntry>; mcpServers?: Record<string, McpServerEntry> } }> } } }
    const namespaces = json?.result?.value?.namespaces
    const orch = Array.isArray(namespaces) ? namespaces.find(n => n.ns === 'enpoi-orchestration') : undefined
    const serverCaps = orch?.value?.capabilities
    if (serverCaps) {
      const next = initialCaps()
      if (serverCaps.tools) Object.assign(next.tools, serverCaps.tools)
      if (serverCaps.skills) Object.assign(next.skills, serverCaps.skills)
      if (serverCaps.mcp) Object.assign(next.mcp, serverCaps.mcp)
      for (const p of PROTECTED_CAPABILITIES) next.tools[p] = true
      globalCapsState = next
      notify()
    }
    if (orch?.value?.mcpStatus && typeof orch.value.mcpStatus === 'object') {
      globalMcpStatus = orch.value.mcpStatus
      notify()
    }
    if (orch?.value?.mcpServers && typeof orch.value.mcpServers === 'object') {
      globalMcpServers = orch.value.mcpServers
      notify()
    }
  }).catch(() => {})
}

export async function toggleCapability(kind: 'tool' | 'skill' | 'mcp', id: string, enabled: boolean): Promise<boolean> {
  if (PROTECTED_CAPABILITIES.has(id) && !enabled) return false

  const previous = { ...globalCapsState }
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

  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings/mutate',
        rpcId: `toggle-cap-${id}`,
        payload: { args: {
          ns: 'enpoi-orchestration',
          ops: [{ op: 'set', path: ['capabilities', kind === 'tool' ? 'tools' : kind === 'skill' ? 'skills' : 'mcp', id], value: enabled }],
        } },
      }),
    })
    if (!res.ok) {
      globalCapsState = previous
      notify()
      return false
    }
    return true
  } catch {
    globalCapsState = previous
    notify()
    return false
  }
}

export interface CapabilitiesViewProps {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  visible: boolean
}

export function CapabilitiesView(props: CapabilitiesViewProps): React.ReactNode {
  const view = useSyncExternalStore(subscribe, () => snapshotCache)
  const caps = view.caps

  // Add-server form + per-row remove confirmation (MCP catalog edits).
  const [addOpen, setAddOpen] = React.useState(false)
  const [addName, setAddName] = React.useState('')
  const [addUrl, setAddUrl] = React.useState('')
  const [addApiKeyEnv, setAddApiKeyEnv] = React.useState('')
  const [addHeaders, setAddHeaders] = React.useState('')
  const [addError, setAddError] = React.useState<string | null>(null)
  const [addBusy, setAddBusy] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null)
  const [mcpActionError, setMcpActionError] = React.useState<string | null>(null)

  // Refresh the live skill catalog every time the drawer opens (and on mount),
  // so newly created/removed skill folders are reflected immediately.
  // MCP heartbeat + server catalog re-poll every 15s while visible.
  const sessionId = props.scope?.sessionId ?? ''
  React.useEffect(() => {
    if (props.visible && sessionId) void refreshSkills(sessionId)
    if (props.visible) void refreshMcpStatus()
  }, [props.visible, sessionId])
  React.useEffect(() => {
    if (!props.visible) return
    const iv = window.setInterval(() => { void refreshMcpStatus() }, 15_000)
    return () => { window.clearInterval(iv) }
  }, [props.visible])

  /** Parse the optional headers textarea into a flat string map (undefined when blank). */
  const parseHeadersField = (text: string): Record<string, string> | undefined => {
    const trimmed = text.trim()
    if (trimmed === '') return undefined
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('headers must be a JSON object')
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`header "${key}" must be a string`)
      headers[key] = value
    }
    return headers
  }

  /** Submit the add-server form; failures render inline, never as a silent no-op. */
  const submitAddServer = async (): Promise<void> => {
    setAddError(null)
    let headers: Record<string, string> | undefined
    try {
      headers = parseHeadersField(addHeaders)
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err))
      return
    }
    setAddBusy(true)
    const result = await addMcpServer({
      serverName: addName,
      url: addUrl,
      apiKeyEnv: addApiKeyEnv,
      ...(headers !== undefined ? { headers } : {}),
    })
    setAddBusy(false)
    if (!result.ok) {
      setAddError(result.reason)
      return
    }
    setAddName('')
    setAddUrl('')
    setAddApiKeyEnv('')
    setAddHeaders('')
    setAddOpen(false)
  }

  /** Confirm-and-remove one catalog server. */
  const submitRemoveServer = async (id: string): Promise<void> => {
    setMcpActionError(null)
    const result = await removeMcpServer(id)
    setConfirmRemove(null)
    if (!result.ok) setMcpActionError(result.reason)
  }

  const mcpList: CapabilityDescriptor[] = (() => {
    const rows = new Map<string, CapabilityDescriptor>()
    for (const c of KNOWN_CAPABILITIES.filter(k => k.kind === 'mcp')) rows.set(c.id, { ...c })
    for (const [id, def] of Object.entries(view.mcpServers)) {
      if (!rows.has(id)) {
        const friendly = def.serverName
          ? def.serverName.charAt(0).toUpperCase() + def.serverName.slice(1)
          : id.replace(/-mcp$/, '').split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        let desc = 'MCP server'
        try { desc = new URL(def.url ?? '').host } catch { /* keep default */ }
        rows.set(id, { id, name: `${friendly} MCP`, kind: 'mcp', category: 'mcp', description: desc, defaultEnabled: false })
      }
    }
    return [...rows.values()]
  })()
  const skillList: CapabilityDescriptor[] = view.skills.map(s => ({
    id: s.name,
    name: s.name.split('-').map(w => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' '),
    kind: 'skill',
    category: 'skills',
    description: s.description,
    defaultEnabled: true,
  }))
  const subagentList = KNOWN_CAPABILITIES.filter(c => c.kind === 'tool' && (c.category === 'supervision' || c.category === 'council' || c.category === 'workers'))
  const coreToolList = KNOWN_CAPABILITIES.filter(c => c.kind === 'tool' && c.category === 'core-tools')

  const renderGroup = (title: string, icon: React.ReactNode, items: readonly CapabilityDescriptor[], kind: 'tool' | 'skill' | 'mcp', footer?: React.ReactNode) => {
    const activeCount = items.filter(item => {
      if (kind === 'tool') return caps.tools[item.id] !== false
      if (kind === 'skill') return caps.skills[item.id] !== false
      if (kind === 'mcp') return caps.mcp[item.id] === true
      return true
    }).length

    return (
      <div style={{
        background: 'rgba(13, 20, 35, 0.65)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
        borderRadius: '8px',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: '#94a3b8',
          paddingBottom: '4px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#8b9bb4' }}>
            {icon}
            <span>{title}</span>
          </div>
          <span style={{
            fontSize: '9.5px',
            padding: '1px 6px',
            borderRadius: '8px',
            background: 'rgba(255, 255, 255, 0.05)',
            color: '#cbd5e1',
          }}>{activeCount} / {items.length}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {items.map(item => {
            const isProtected = PROTECTED_CAPABILITIES.has(item.id)
            const isEnabled = isProtected
              ? true
              : kind === 'tool'
                ? (caps.tools[item.id] !== false)
                : kind === 'skill'
                  ? (caps.skills[item.id] !== false)
                  : (caps.mcp[item.id] === true)

            // MCP rows: connection heartbeat instead of enable-dot. The host's
            // last mount failure outranks online/down while it is fresh.
            const st = kind === 'mcp' ? view.mcpStatus[item.id] : undefined
            const stFresh = st !== undefined && Date.now() - st.checkedAt <= 45_000
            let dotColor = isEnabled ? '#34d399' : '#64748b'
            let dotGlow = isEnabled ? '0 0 5px rgba(52, 211, 153, 0.6)' : 'none'
            let connTitle = ''
            if (kind === 'mcp' && st !== undefined) {
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
                connTitle = st.authError ? 'Server running · auth rejected' : 'Server running · toggled off'
              }
            }
            const removable = kind === 'mcp' && view.mcpServers[item.id] !== undefined

            return (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  borderRadius: '5px',
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid transparent',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: '11.5px',
                    fontWeight: 500,
                    color: '#f1f5f9',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}>
                    <span
                      title={kind === 'mcp' ? connTitle : undefined}
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: dotColor,
                        boxShadow: dotGlow,
                        cursor: kind === 'mcp' ? 'help' : undefined,
                      }} />
                    <span>{item.name}</span>
                    {isProtected && (
                      <span style={{
                        fontSize: '8.5px',
                        padding: '1px 3px',
                        borderRadius: '3px',
                        background: 'rgba(103, 220, 231, 0.1)',
                        color: '#67dce7',
                        border: '1px solid rgba(103, 220, 231, 0.2)',
                      }}>Core</span>
                    )}
                  </div>
                  <div style={{
                    fontSize: '10px',
                    color: '#94a3b8',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>{item.description}</div>
                  {kind === 'mcp' && stFresh && st?.error !== undefined && (
                    <div title={st.error} style={{ fontSize: '9.5px', color: '#e5716f', overflowWrap: 'anywhere' }}>
                      mount failed: {st.error}
                    </div>
                  )}
                </div>
                {confirmRemove === item.id ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <span style={{ fontSize: '10px', color: '#e5716f', whiteSpace: 'nowrap' }}>Remove?</span>
                    <button
                      type="button"
                      style={{
                        minHeight: '24px',
                        padding: '0 8px',
                        borderRadius: '6px',
                        background: 'rgba(229, 113, 111, 0.12)',
                        border: '1px solid rgba(229, 113, 111, 0.35)',
                        color: '#e5716f',
                        fontSize: '10px',
                        cursor: 'pointer',
                      }}
                      onClick={() => { void submitRemoveServer(item.id) }}
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      style={{
                        minHeight: '24px',
                        padding: '0 8px',
                        borderRadius: '6px',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        color: '#94a3b8',
                        fontSize: '10px',
                        cursor: 'pointer',
                      }}
                      onClick={() => { setConfirmRemove(null) }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <label style={{
                      position: 'relative',
                      width: '28px',
                      height: '16px',
                      flexShrink: 0,
                      marginLeft: '8px',
                      cursor: isProtected ? 'not-allowed' : 'pointer',
                      opacity: isProtected ? 0.5 : 1,
                    }}>
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        disabled={isProtected}
                        style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
                        onChange={(e) => {
                          void toggleCapability(kind, item.id, e.target.checked)
                        }}
                      />
                      <span style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: '16px',
                        background: isEnabled ? 'rgba(52, 211, 153, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                        border: `1px solid ${isEnabled ? 'rgba(52, 211, 153, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
                        transition: 'all 0.15s ease',
                      }}>
                        <span style={{
                          position: 'absolute',
                          height: '10px',
                          width: '10px',
                          left: isEnabled ? '13px' : '2px',
                          top: '2px',
                          borderRadius: '50%',
                          background: isEnabled ? '#34d399' : '#94a3b8',
                          boxShadow: isEnabled ? '0 0 6px rgba(52, 211, 153, 0.8)' : 'none',
                          transition: 'all 0.15s ease',
                        }} />
                      </span>
                    </label>
                    {removable && (
                      <button
                        type="button"
                        aria-label={`Remove ${item.name}`}
                        title={`Remove ${item.name}`}
                        style={{
                          width: '20px',
                          height: '20px',
                          padding: 0,
                          borderRadius: '5px',
                          background: 'rgba(229, 113, 111, 0.08)',
                          border: '1px solid rgba(229, 113, 111, 0.22)',
                          color: '#e5716f',
                          fontSize: '12px',
                          lineHeight: 1,
                          cursor: 'pointer',
                        }}
                        onClick={() => { setMcpActionError(null); setConfirmRemove(item.id) }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {footer}
      </div>
    )
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '24px',
    padding: '3px 6px',
    borderRadius: '5px',
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    color: '#e2e8f0',
    fontSize: '10.5px',
    fontFamily: 'inherit',
  }

  /** Catalog editor: add-server form (collapsed by default) + action failures. */
  const mcpFooter = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' }}>
      {mcpActionError !== null && (
        <div style={{ fontSize: '9.5px', color: '#e5716f', overflowWrap: 'anywhere' }}>{mcpActionError}</div>
      )}
      {addOpen ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <input
            aria-label="MCP server id"
            placeholder="server-id"
            value={addName}
            onChange={(e) => { setAddName(e.target.value) }}
            style={inputStyle}
          />
          <input
            aria-label="MCP server URL"
            placeholder="https://host/mcp"
            value={addUrl}
            onChange={(e) => { setAddUrl(e.target.value) }}
            style={inputStyle}
          />
          <input
            aria-label="MCP server API key env"
            placeholder="API key env (optional)"
            value={addApiKeyEnv}
            onChange={(e) => { setAddApiKeyEnv(e.target.value) }}
            style={inputStyle}
          />
          <textarea
            aria-label="MCP server headers JSON"
            placeholder='Headers JSON (optional), e.g. {"x-workspace-slug":"main"}'
            rows={2}
            value={addHeaders}
            onChange={(e) => { setAddHeaders(e.target.value) }}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
          {addError !== null && (
            <div style={{ fontSize: '9.5px', color: '#e5716f', overflowWrap: 'anywhere' }}>{addError}</div>
          )}
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              disabled={addBusy}
              style={{
                alignSelf: 'flex-start',
                minHeight: '26px',
                padding: '0 10px',
                borderRadius: '6px',
                background: 'rgba(103, 220, 231, 0.08)',
                border: '1px solid rgba(103, 220, 231, 0.25)',
                color: '#67dce7',
                fontSize: '10.5px',
                cursor: addBusy ? 'default' : 'pointer',
                opacity: addBusy ? 0.6 : 1,
              }}
              onClick={() => { void submitAddServer() }}
            >
              {addBusy ? 'Adding…' : 'Add server'}
            </button>
            <button
              type="button"
              style={{
                minHeight: '26px',
                padding: '0 10px',
                borderRadius: '6px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#94a3b8',
                fontSize: '10.5px',
                cursor: 'pointer',
              }}
              onClick={() => { setAddOpen(false); setAddError(null) }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          style={{
            alignSelf: 'flex-start',
            minHeight: '26px',
            padding: '0 10px',
            borderRadius: '6px',
            background: 'rgba(103, 220, 231, 0.08)',
            border: '1px solid rgba(103, 220, 231, 0.25)',
            color: '#67dce7',
            fontSize: '10.5px',
            cursor: 'pointer',
          }}
          onClick={() => { setAddOpen(true); setAddError(null) }}
        >
          + Add MCP server
        </button>
      )}
    </div>
  )

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      padding: '12px',
      overflowY: 'auto',
      gap: '10px',
      color: '#e2e8f0',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: '4px' }}>
        <h3 style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc', margin: 0 }}>Capabilities Control Center</h3>
        <p style={{ fontSize: '10.5px', color: '#94a3b8', margin: 0 }}>Toggle MCPs, Skills & Subagents in real time</p>
      </div>

      {renderGroup('MCP Tool Suites', iconPlug(), mcpList, 'mcp', mcpFooter)}
      {skillList.length > 0
        ? renderGroup('Specialist Skills', iconSparkle(), skillList, 'skill')
        : (
          <div style={{
            background: 'rgba(13, 20, 35, 0.65)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: '8px',
            padding: '10px',
            fontSize: '10.5px',
            color: '#94a3b8',
          }}>
            No skills discovered yet — open a session to load the live catalog. Drop a folder with a SKILL.md into ~/.dsh/skills/ to add one.
          </div>
        )}
      {renderGroup('Subagents & Debaters', iconCouncil(), subagentList, 'tool')}
      {renderGroup('Core System Tools', iconTerminal(), coreToolList, 'tool')}
    </div>
  )
}
