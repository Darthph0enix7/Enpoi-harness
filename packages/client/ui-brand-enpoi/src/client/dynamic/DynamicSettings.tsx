/**
 * Dynamic settings section: one page for every operator-extensible entity —
 * specialist roles, councils, MCP servers, skills, tools, and the prompts that
 * drive them. Panels write the `enpoi-orchestration` registries (roles,
 * councils, mcpServers, capabilities) and hot-swap without a restart; the
 * Skills & tools panel's CRUD copy is localized through this section's locale
 * namespace.
 */
import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrandEnpoiKey } from '../locales.ts'
import css from './DynamicSettings.module.css'
import { RolesPanel } from './RolesPanel.tsx'
import { PromptsPanel } from './PromptsPanel.tsx'
import { CouncilsPanel } from './CouncilsPanel.tsx'
import { McpPanel } from './McpPanel.tsx'
import { SkillsPanel } from './SkillsPanel.tsx'
import { useStatus } from './status.ts'

type TabId = 'roles' | 'councils' | 'mcp' | 'skills' | 'prompts'

const TABS: ReadonlyArray<{ id: TabId; labelKey: BrandEnpoiKey }> = [
  { id: 'roles', labelKey: 'dynTabRoles' },
  { id: 'councils', labelKey: 'dynTabCouncils' },
  { id: 'mcp', labelKey: 'dynTabMcp' },
  { id: 'skills', labelKey: 'dynTabSkills' },
  { id: 'prompts', labelKey: 'dynTabPrompts' },
]

/** Injected business face of the Dynamic settings section. */
export interface DynamicSettingsInjected {
  /** Translator bound to the Skills & tools panel's own namespace. */
  skillsT: TranslateNS<'settings.dynamicSkills'>
}

/** Props of {@link DynamicSettings}: the settings-section owner share, the package copy seat, and the skills CRUD copy. */
export type DynamicSettingsProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'brandEnpoi'>
  & InjectFace<DynamicSettingsInjected>

/** Render the dynamic-entities page with its panel tabs. */
export function DynamicSettings({ skillsT, t }: DynamicSettingsProps) {
  const [tab, setTab] = useState<TabId>('roles')
  const status = useStatus()
  return (
    <div className={css.container}>
      <p className={css.hint}>
        {t('dynHintLead')} <code>enpoi-orchestration</code> {t('dynHintTail')}
      </p>
      <nav className={css.tabs} aria-label={t('dynAria')}>
        {TABS.map(entry => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? `${css.tab} ${css.tabActive}` : css.tab}
            aria-pressed={tab === entry.id}
            onClick={() => { setTab(entry.id) }}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </nav>
      <section className={css.panel}>
        {status !== null && <p className={css.status} role="alert">{status}</p>}
        {tab === 'roles' && <RolesPanel t={t} />}
        {tab === 'councils' && <CouncilsPanel t={t} />}
        {tab === 'mcp' && <McpPanel t={t} />}
        {tab === 'skills' && <SkillsPanel t={skillsT} />}
        {tab === 'prompts' && <PromptsPanel t={t} />}
      </section>
    </div>
  )
}
