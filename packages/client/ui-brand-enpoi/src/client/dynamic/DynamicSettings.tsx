/**
 * Dynamic settings section: one page for every operator-extensible entity —
 * specialist roles, councils, MCP servers, skills, tools, and the prompts that
 * drive them. Panels write the `enpoi-orchestration` registries (roles,
 * councils, mcpServers, capabilities) and hot-swap without a restart.
 */
import { useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DynamicSettings.module.css'
import { RolesPanel } from './RolesPanel.tsx'
import { PromptsPanel } from './PromptsPanel.tsx'
import { CouncilsPanel } from './CouncilsPanel.tsx'
import { McpPanel } from './McpPanel.tsx'
import { SkillsPanel } from './SkillsPanel.tsx'
import { useStatus } from './status.ts'

type TabId = 'roles' | 'councils' | 'mcp' | 'skills' | 'prompts'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'roles', label: 'Roles' },
  { id: 'councils', label: 'Councils' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'skills', label: 'Skills & tools' },
  { id: 'prompts', label: 'Prompts' },
]

/** Props of {@link DynamicSettings}: the settings-section owner share. */
export type DynamicSettingsProps = PropsRuntime<'settings.section'>

/** Render the dynamic-entities page with its panel tabs. */
export function DynamicSettings(_props: DynamicSettingsProps) {
  const [tab, setTab] = useState<TabId>('roles')
  const status = useStatus()
  return (
    <div className={css.container}>
      <p className={css.hint}>
        Everything here is data in <code>enpoi-orchestration</code> — edits apply on the next spawn,
        turn, or mount, with no restart.
      </p>
      <nav className={css.tabs} aria-label="Dynamic entity panels">
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? `${css.tab} ${css.tabActive}` : css.tab}
            aria-pressed={tab === entry.id}
            onClick={() => { setTab(entry.id) }}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <section className={css.panel}>
        {status !== null && <p className={css.status} role="alert">{status}</p>}
        {tab === 'roles' && <RolesPanel />}
        {tab === 'councils' && <CouncilsPanel />}
        {tab === 'mcp' && <McpPanel />}
        {tab === 'skills' && <SkillsPanel />}
        {tab === 'prompts' && <PromptsPanel />}
      </section>
    </div>
  )
}
