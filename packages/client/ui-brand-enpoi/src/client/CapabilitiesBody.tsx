/**
 * Capabilities Control Center — the global capabilities tab body
 * (`sidebar.right.pane.tab` key `enpoi-capabilities`, kind `capabilities`).
 *
 * Restored to where the original Enpoi sidebar hosted it: a first-class right
 * Sidebar tab beside Files/Terminal. Raw gateway envelopes are the CURRENT
 * ones: `skills.list` takes `args.request.sessionId` (the addressed session
 * resolves cwd host-side) and `settings.describe` / `settings.mutate` address
 * the `enpoi-orchestration` namespace. MCP rows show the host heartbeat
 * (`enpoi-orchestration.mcpStatus`) instead of the enable dot; the heartbeat
 * and server catalog re-poll every 15s while the tab is visible. Toggles
 * persist to `enpoi-orchestration.capabilities.{tools,skills,mcp}` and are
 * staged — they apply from the next query onward.
 *
 * Skill catalog addressing: the tab's own `sessionId` is the first candidate;
 * when the host refuses to inspect it (legacy v0/v1 session logs), the newest
 * session ids follow, up to five, before the page reports an explicit
 * "skill catalog unavailable" error with a Retry instead of pretending the
 * catalog is empty. The catalog re-reads when the tab becomes visible and
 * after a successful skill toggle.
 *
 * The module-level cache is the page's state channel (same discipline as the
 * persona/params stores): synchronous 0ms snapshot on mount, optimistic local
 * toggles with rollback, background persistence.
 */
import { useState, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AGENT_MODELS_KIND } from './kinds.ts'
import { countPermissionRules, type PermissionsConfig } from './permissions-model.ts'
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

/** Live skill rows discovered host-side via skills.list (OpenCode-parity dynamics). */
export interface DynamicSkillEntry {
  name: string
  description: string
  modelInvocable: boolean
}

let globalSkills: DynamicSkillEntry[] = []
let globalSkillsError: string | null = null
let globalSkillsLoading = false

/** Host-side MCP reachability heartbeat (enpoi-capabilities writes enpoi-orchestration.mcpStatus). */
export interface McpStatusEntry {
  state: 'online' | 'down'
  mounted: boolean
  checkedAt: number
  authError?: boolean
}

/** Server catalog entries (enpoi-orchestration.mcpServers). */
export interface McpServerEntry {
  serverName?: string
  url?: string
}

let globalMcpStatus: Record<string, McpStatusEntry> = {}
let globalMcpServers: Record<string, McpServerEntry> = {}

let snapshotCache: {
  caps: CapabilitiesState
  skills: DynamicSkillEntry[]
  skillsError: string | null
  skillsLoading: boolean
  mcpStatus: Record<string, McpStatusEntry>
  mcpServers: Record<string, McpServerEntry>
} = {
  caps: globalCapsState,
  skills: globalSkills,
  skillsError: globalSkillsError,
  skillsLoading: globalSkillsLoading,
  mcpStatus: globalMcpStatus,
  mcpServers: globalMcpServers,
}

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
  value?: {
    capabilities?: Partial<CapabilitiesState>
    mcpStatus?: Record<string, McpStatusEntry>
    mcpServers?: Record<string, McpServerEntry>
    permissions?: PermissionsConfig
  }
}

/** Doc 55 permission policy wire types live in permissions-model.ts. */

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationNamespaceView | undefined> {
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: nextRpcId('caps-describe'),
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json = await res.json() as { result?: { ok?: boolean; value?: { namespaces?: OrchestrationNamespaceView[] } } }
  const namespaces = json?.result?.value?.namespaces
  return Array.isArray(namespaces) ? namespaces.find(n => n.ns === 'enpoi-orchestration') : undefined
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

let capabilitiesPrimed = false

/** Prime the capability map + MCP state once when the first tab mounts. */
function applyOrchestration(orch: Awaited<ReturnType<typeof describeOrchestration>>): void {
  const serverCaps = orch?.value?.capabilities
  if (serverCaps !== undefined) {
    const next = initialCaps()
    if (serverCaps.tools !== undefined) Object.assign(next.tools, serverCaps.tools)
    if (serverCaps.skills !== undefined) Object.assign(next.skills, serverCaps.skills)
    if (serverCaps.mcp !== undefined) Object.assign(next.mcp, serverCaps.mcp)
    for (const p of PROTECTED_CAPABILITIES) next.tools[p] = true
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
    if (!res.ok) {
      globalCapsState = previous
      notify()
      return false
    }
    // The gateway answers HTTP 200 for business failures too; only an explicit
    // `ok: true` result counts as persisted.
    const json = await res.json() as { result?: { ok?: boolean } }
    if (json?.result?.ok !== true) {
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

export type CapabilitiesBodyProps = PropsRuntime<'sidebar.right.pane.tab'>

/**
 * Doc 55 permissions Tier-1 strip: a read-only counts row over the live
 * policy (global + per-agent tool rules, standing grants). Full editing
 * lives in the Settings page's Permissions section; no cross-surface
 * settings-open action is exposed to tab components, so no link is offered.
 */
function PermissionsSection() {
  const [counts, setCounts] = useState<{ rules: number; grants: number } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void (async () => {
      const ns = await describeOrchestration()
      if (ns === undefined) {
        setFailed(true)
        return
      }
      setFailed(false)
      setCounts(countPermissionRules(ns.value?.permissions))
    })()
  }, [])

  return (
    <section className={c('group')} key="permissions">
      <div className={c('groupHead')}>
        <div className={c('groupHeadLeft')}>
          <span className={c('groupIcon')}>{iconTerminal()}</span>
          <span className={c('groupTitle')}>Permissions</span>
        </div>
        {counts !== null && (
          <span className={c('countBadge')}>{counts.rules} rules · {counts.grants} grants</span>
        )}
      </div>
      {counts === null ? (
        <div className={c('empty')}>{failed ? 'Permission policy unavailable.' : 'Loading policy…'}</div>
      ) : (
        <div className={c('permHint')}>
          Unconfigured tools default to <b>ask</b>. Bash commands match patterns first, then the tool policy.
          Edit rules in Settings under Permissions.
        </div>
      )}
    </section>
  )
}

export function CapabilitiesBody({ sessionId, useSessions, useTabInfo }: CapabilitiesBodyProps) {
  const { tab } = useTabInfo()
  const view = useSyncExternalStore(subscribe, () => snapshotCache)
  const caps = view.caps
  const visible = tab.visible
  const sessionIds = useSessions(state => state.ids)

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

  // Prime the persisted capability map once.
  useEffect(() => {
    void primeCapabilities()
  }, [])
  // Catalog refreshes when the tab becomes visible and when its address chain changes.
  useEffect(() => {
    if (!visible || candidates.length === 0) return
    void refreshSkills(candidates)
  }, [visible, candidates])
  // MCP heartbeat + server catalog re-poll every 15s while the tab is visible.
  useEffect(() => {
    if (!visible) return
    void refreshMcpStatus()
    const iv = window.setInterval(() => { void refreshMcpStatus() }, 15_000)
    return () => { window.clearInterval(iv) }
  }, [visible])

  const mcpList: CapabilityDescriptor[] = (() => {
    const rows = new Map<string, CapabilityDescriptor>()
    for (const cap of KNOWN_CAPABILITIES.filter(k => k.kind === 'mcp')) rows.set(cap.id, { ...cap })
    for (const [id, def] of Object.entries(view.mcpServers)) {
      if (!rows.has(id)) {
        const friendly = def.serverName !== undefined && def.serverName !== ''
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
  const subagentList = KNOWN_CAPABILITIES.filter(k => k.kind === 'tool' && (k.category === 'supervision' || k.category === 'council' || k.category === 'workers'))
  const coreToolList = KNOWN_CAPABILITIES.filter(k => k.kind === 'tool' && k.category === 'core-tools')

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

  const renderGroup = (title: string, icon: ReactNode, items: readonly CapabilityDescriptor[], kind: 'tool' | 'skill' | 'mcp', banner?: ReactNode) => {
    const activeCount = items.filter((item) => {
      if (kind === 'tool') return caps.tools[item.id] !== false
      if (kind === 'skill') return caps.skills[item.id] !== false
      if (kind === 'mcp') return caps.mcp[item.id] === true
      return true
    }).length

    return (
      <section className={c('group')} key={title}>
        <div className={c('groupHead')}>
          <div className={c('groupHeadLeft')}>
            <span className={c('groupIcon')}>{icon}</span>
            <span className={c('groupTitle')}>{title}</span>
          </div>
          <span className={c('countBadge')}>{activeCount} / {items.length}</span>
        </div>
        {banner}
        <div className={c('list')}>
          {items.map((item) => {
            const isProtected = PROTECTED_CAPABILITIES.has(item.id)
            const isEnabled = isProtected
              ? true
              : kind === 'tool'
                ? (caps.tools[item.id] !== false)
                : kind === 'skill'
                  ? (caps.skills[item.id] !== false)
                  : (caps.mcp[item.id] === true)

            // MCP rows: connection heartbeat instead of enable-dot.
            let dotColor = isEnabled ? '#34d399' : '#64748b'
            let dotGlow = isEnabled ? '0 0 5px rgba(52, 211, 153, 0.6)' : 'none'
            let connTitle = ''
            if (kind === 'mcp') {
              const st = view.mcpStatus[item.id]
              const stale = st === undefined || Date.now() - st.checkedAt > 45_000
              if (stale) {
                dotColor = '#475569'; dotGlow = 'none'
                connTitle = 'Checking availability…'
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
              <div className={c('row')} key={`${kind}:${item.id}`}>
                <div className={c('rowInfo')}>
                  <div className={c('rowName')}>
                    <span
                      className={c('dot')}
                      title={kind === 'mcp' ? connTitle : undefined}
                      style={{
                        background: dotColor,
                        boxShadow: dotGlow,
                        cursor: kind === 'mcp' ? 'help' : undefined,
                      }}
                    />
                    <span>{item.name}</span>
                    {isProtected && <span className={c('coreBadge')}>Core</span>}
                  </div>
                  <div className={c('rowDesc')}>{item.description}</div>
                </div>
                <label
                  className={c('switch')}
                  style={{ cursor: isProtected ? 'not-allowed' : 'pointer', opacity: isProtected ? 0.5 : 1 }}
                >
                  <input
                    className={c('switchInput')}
                    type="checkbox"
                    checked={isEnabled}
                    disabled={isProtected}
                    onChange={(e) => {
                      const nextEnabled = e.target.checked
                      void toggleCapability(kind, item.id, nextEnabled).then((accepted) => {
                        // Re-read the host catalog after a persisted skill change.
                        if (accepted && kind === 'skill') void refreshSkills(candidates)
                      })
                    }}
                  />
                  <span className={`${c('switchTrack')}${isEnabled ? ` ${c('switchOn')}` : ''}`}>
                    <span className={`${c('switchKnob')}${isEnabled ? ` ${c('switchKnobOn')}` : ''}`} />
                  </span>
                </label>
              </div>
            )
          })}
        </div>
      </section>
    )
  }

  const skillsSection = skillList.length > 0
    ? renderGroup('Specialist Skills', iconSparkle(), skillList, 'skill', errorBanner)
    : (
      <section className={c('group')} key="skills-fallback">
        <div className={c('groupHead')}>
          <div className={c('groupHeadLeft')}>
            <span className={c('groupIcon')}>{iconSparkle()}</span>
            <span className={c('groupTitle')}>Specialist Skills</span>
          </div>
          <span className={c('countBadge')}>0 / 0</span>
        </div>
        {view.skillsLoading
          ? <div className={c('empty')}>Loading skill catalog…</div>
          : errorBanner ?? (
            <div className={c('empty')}>
              No skills discovered yet. Drop a folder with a SKILL.md into ~/.dsh/skills/ to add one.
            </div>
          )}
      </section>
    )

  return (
    <div className={c('container')}>
      <header className={c('head')}>
        <h3 className={c('headTitle')}>Capabilities Control Center</h3>
        <p className={c('headSub')}>Toggle MCPs, Skills &amp; Subagents in real time</p>
      </header>

      <div className={c('groups')}>
        <PermissionsSection />
        {renderGroup('MCP Tool Suites', iconPlug(12, 1.3), mcpList, 'mcp')}
        {skillsSection}
        {renderGroup('Subagents & Debaters', iconCouncil(), subagentList, 'tool')}
        {renderGroup('Core System Tools', iconTerminal(), coreToolList, 'tool')}
      </div>

      <footer className={c('foot')}>
        <span>Toggles persist to <code>enpoi-orchestration</code> settings and are staged until the next query.</span>
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
