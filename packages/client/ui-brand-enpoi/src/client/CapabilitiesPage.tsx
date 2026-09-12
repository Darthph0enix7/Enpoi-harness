/**
 * Capabilities Control Center — the global capabilities page (main key
 * `capabilities`, ordered 55 in the sidebar rail).
 *
 * Ported from the retired better-sidebar Liquid Glass drawer to the merged
 * client's native `main` page API. Raw gateway envelopes are the CURRENT
 * ones: `skills.list` takes `args.request.sessionId` (the addressed session
 * resolves cwd host-side) and `settings.describe` / `settings.mutate` address
 * the `enpoi-orchestration` namespace. MCP rows show the host heartbeat
 * (`enpoi-orchestration.mcpStatus`) instead of the enable dot; the heartbeat
 * and server catalog re-poll every 15s while the page is mounted. Toggles
 * persist to `enpoi-orchestration.capabilities.{tools,skills,mcp}` and are
 * staged — they apply from the next query onward.
 *
 * The module-level cache is the page's state channel (same discipline as the
 * persona/params stores): synchronous 0ms snapshot on mount, optimistic local
 * toggles with rollback, background persistence.
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './CapabilitiesPage.module.css'

/** CSS-module reads are `string | undefined` under noUncheckedIndexedAccess; keys are static. */
function c(name: string): string {
  return css[name] ?? ''
}

/** Monochrome plug glyph shared by the rail icon and the MCP section header. */
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

/** Monochrome rail icon for the Capabilities page (thin stroke, currentColor). */
export function CapabilitiesIcon({ size = 18 }: { size?: number; active?: boolean }) {
  return iconPlug(size, 1.3)
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
  mcpStatus: Record<string, McpStatusEntry>
  mcpServers: Record<string, McpServerEntry>
} = {
  caps: globalCapsState,
  skills: globalSkills,
  mcpStatus: globalMcpStatus,
  mcpServers: globalMcpServers,
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify(): void {
  snapshotCache = { caps: globalCapsState, skills: globalSkills, mcpStatus: globalMcpStatus, mcpServers: globalMcpServers }
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
  }
}

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

/** Fetch the real skill catalog for the session's project root. */
export async function refreshSkills(sessionId: string): Promise<void> {
  if (sessionId === '') return
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
    if (!res.ok) return
    const json = await res.json() as { result?: { ok?: boolean; value?: { skills?: Array<{ name?: unknown; description?: unknown; modelInvocable?: unknown }> } } }
    if (json?.result?.ok !== true) return
    const rows = json.result.value?.skills
    if (!Array.isArray(rows)) return
    const skills: DynamicSkillEntry[] = []
    for (const row of rows) {
      if (typeof row.name !== 'string' || row.name === '') continue
      skills.push({
        name: row.name,
        description: typeof row.description === 'string' ? row.description : '',
        modelInvocable: row.modelInvocable === true,
      })
    }
    globalSkills = skills
    notify()
  } catch {
    // keep last known catalog on transient failures
  }
}

/** Re-read MCP heartbeat + server catalog from settings.describe (cheap, periodic while mounted). */
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

/** Prime the capability map + MCP state once when the page mounts. */
export async function primeCapabilities(): Promise<void> {
  try {
    const orch = await describeOrchestration()
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
    return true
  } catch {
    globalCapsState = previous
    notify()
    return false
  }
}

export type CapabilitiesPageProps = PropsRuntime<'main'>

export function CapabilitiesPage({ useSessions }: CapabilitiesPageProps) {
  const view = useSyncExternalStore(subscribe, () => snapshotCache)
  const caps = view.caps
  const sessionId = useSessions(state => state.current ?? state.ids[0])

  // Prime the persisted capability map once; refresh the live skill catalog
  // whenever the addressed (most recent) session changes.
  useEffect(() => {
    void primeCapabilities()
  }, [])
  useEffect(() => {
    if (typeof sessionId === 'string' && sessionId !== '') void refreshSkills(sessionId)
  }, [sessionId])
  // MCP heartbeat + server catalog re-poll every 15s while the page is mounted.
  useEffect(() => {
    void refreshMcpStatus()
    const iv = window.setInterval(() => { void refreshMcpStatus() }, 15_000)
    return () => { window.clearInterval(iv) }
  }, [])

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

  const renderGroup = (title: string, icon: ReactNode, items: readonly CapabilityDescriptor[], kind: 'tool' | 'skill' | 'mcp') => {
    const activeCount = items.filter(item => {
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
        <div className={c('list')}>
          {items.map(item => {
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
                    onChange={(e) => { void toggleCapability(kind, item.id, e.target.checked) }}
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

  return (
    <div className={c('container')}>
      <header className={c('head')}>
        <h3 className={c('headTitle')}>Capabilities Control Center</h3>
        <p className={c('headSub')}>Toggle MCPs, Skills &amp; Subagents in real time</p>
      </header>

      <div className={c('groups')}>
        {renderGroup('MCP Tool Suites', iconPlug(12, 1.3), mcpList, 'mcp')}
        {skillList.length > 0
          ? renderGroup('Specialist Skills', iconSparkle(), skillList, 'skill')
          : (
            <section className={c('group')} key="skills-empty">
              <div className={c('groupHead')}>
                <div className={c('groupHeadLeft')}>
                  <span className={c('groupIcon')}>{iconSparkle()}</span>
                  <span className={c('groupTitle')}>Specialist Skills</span>
                </div>
                <span className={c('countBadge')}>0 / 0</span>
              </div>
              <div className={c('empty')}>
                No skills discovered yet — open a session to load the live catalog. Drop a folder with a SKILL.md into ~/.dsh/skills/ to add one.
              </div>
            </section>
          )}
        {renderGroup('Subagents & Debaters', iconCouncil(), subagentList, 'tool')}
        {renderGroup('Core System Tools', iconTerminal(), coreToolList, 'tool')}
      </div>

      <footer className={c('foot')}>
        Toggles persist to <code>enpoi-orchestration</code> settings and are staged until the next query.
      </footer>
    </div>
  )
}
