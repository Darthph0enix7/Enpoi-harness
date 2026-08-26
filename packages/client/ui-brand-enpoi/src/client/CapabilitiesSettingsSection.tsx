import React, { useSyncExternalStore } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './CapabilitiesSettingsSection.module.css'

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
  { id: 'ue-mcp-skill', name: 'UE5 Automation Skill', kind: 'skill', category: 'skills', description: 'Unreal Engine 5 MCP workflows', defaultEnabled: true },
  { id: 'tier1-workflow', name: 'Tier 1 Guided Workflow', kind: 'skill', category: 'skills', description: 'Guided planning with Oracle supervision', defaultEnabled: true },
  { id: 'tier2-workflow', name: 'Tier 2 Ideation Workflow', kind: 'skill', category: 'skills', description: 'Ideation and Roundtable debate planning', defaultEnabled: true },
  { id: 'tier3-workflow', name: 'Tier 3 Full Workflow', kind: 'skill', category: 'skills', description: 'Complex implementation with continuous supervision', defaultEnabled: true },

  // Subagents & Debaters (Default ON)
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

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify() {
  for (const fn of listeners) fn()
}

// Initial prime from describe
if (typeof window !== 'undefined') {
  void fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: 'prime-caps-settings',
      payload: {},
    }),
  }).then(async (res) => {
    if (!res.ok) return
    const json = await res.json() as {
      result?: {
        value?: {
          namespaces?: Array<{
            ns?: string
            value?: { capabilities?: Partial<CapabilitiesState> }
          }>
        }
      }
    }
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
  }).catch(() => {})
}

export async function toggleSettingCapability(kind: 'tool' | 'skill' | 'mcp', id: string, enabled: boolean): Promise<boolean> {
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
        rpcId: `settings-toggle-cap-${id}`,
        payload: {
          ns: 'enpoi-orchestration',
          ops: [{ op: 'set', path: ['capabilities', kind === 'tool' ? 'tools' : kind === 'skill' ? 'skills' : 'mcp', id], value: enabled }],
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

export type CapabilitiesSettingsSectionProps = PropsRuntime<'settings.section'>

export function CapabilitiesSettingsSection(_props: CapabilitiesSettingsSectionProps): React.ReactNode {
  const caps = useSyncExternalStore(subscribe, () => globalCapsState)

  const mcpList = KNOWN_CAPABILITIES.filter(c => c.kind === 'mcp')
  const skillList = KNOWN_CAPABILITIES.filter(c => c.kind === 'skill')
  const subagentList = KNOWN_CAPABILITIES.filter(c => c.kind === 'tool' && (c.category === 'supervision' || c.category === 'council' || c.category === 'workers'))
  const coreToolList = KNOWN_CAPABILITIES.filter(c => c.kind === 'tool' && c.category === 'core-tools')

  const renderGroup = (title: string, icon: string, items: readonly CapabilityDescriptor[], kind: 'tool' | 'skill' | 'mcp') => {
    const activeCount = items.filter((item) => {
      if (kind === 'tool') return caps.tools[item.id] !== false
      if (kind === 'skill') return caps.skills[item.id] !== false
      if (kind === 'mcp') return caps.mcp[item.id] === true
      return true
    }).length

    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <div className={css.cardHeadLeft}>
            <span>{icon}</span>
            <span>{title}</span>
          </div>
          <span className={css.countPill}>{activeCount} / {items.length} Active</span>
        </div>
        <div className={css.rowList}>
          {items.map((item) => {
            const isProtected = PROTECTED_CAPABILITIES.has(item.id)
            const isEnabled = isProtected
              ? true
              : kind === 'tool'
                ? (caps.tools[item.id] !== false)
                : kind === 'skill'
                  ? (caps.skills[item.id] !== false)
                  : (caps.mcp[item.id] === true)

            return (
              <div key={item.id} className={css.row}>
                <div className={css.rowLeft}>
                  <div className={css.rowName}>
                    <span className={css.statusDot} data-active={isEnabled} />
                    <span>{item.name}</span>
                    {isProtected && <span className={css.protectedBadge}>Core</span>}
                  </div>
                  <div className={css.rowDesc}>{item.description}</div>
                </div>
                <label className={css.switch}>
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    disabled={isProtected}
                    onChange={(e) => {
                      void toggleSettingCapability(kind, item.id, e.target.checked)
                    }}
                  />
                  <span className={css.slider} />
                </label>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <h2 className={css.heading}>Capabilities & Tools Control Center</h2>
      <p className={css.intro}>
        Configure global availability of MCP Tool Suites, Specialist Skills, Subagents, and Core System Tools across all sessions.
      </p>

      <div className={css.grid}>
        {renderGroup('MCP Tool Suites', '🔌', mcpList, 'mcp')}
        {renderGroup('Specialist Skills', '🧩', skillList, 'skill')}
        {renderGroup('Subagents & Debaters', '🛡️', subagentList, 'tool')}
        {renderGroup('Core System Tools', '⚙️', coreToolList, 'tool')}
      </div>
    </div>
  )
}
