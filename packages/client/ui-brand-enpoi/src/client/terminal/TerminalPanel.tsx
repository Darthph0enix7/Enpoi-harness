/**
 * enpoi: the right sidebar's terminal page. Terminals are the only surface
 * with tabs, exactly as the operator remembers: this body owns a small tab
 * strip (new / close / switch) independent of the sidebar's rail navigation.
 */
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { IconCloseFillRegular, IconPlusOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { BrandT } from '../locales.ts'
import type { TerminalInjected } from './contract.ts'
import type { TerminalPlace, TerminalTabState } from './registry.ts'
import { TerminalIcon } from './icons.tsx'
import { TerminalView } from './TerminalView.tsx'
import css from './TerminalPanel.module.css'

/** One surface's tab strip: the terminals of that surface and their controls. */
export interface TerminalTabStripProps {
  readonly sessionId: string
  readonly place: TerminalPlace
  readonly tabs: readonly TerminalTabState[]
  readonly activeId: string | undefined
  readonly onOpen: () => void
  readonly onClose: (id: string) => void
  readonly onActivate: (id: string) => void
  /** Package copy translate. */
  readonly t: BrandT
  /** Surface-specific controls after the add button. */
  readonly extra?: ReactNode
}

/** The tab row every terminal surface draws above its emulator. */
export function TerminalTabStrip({
  place, tabs, activeId, onOpen, onClose, onActivate, t, extra,
}: TerminalTabStripProps): ReactNode {
  return (
    <div className={css.tabBar} data-enpoi-terminal-tabbar={place}>
      <div className={css.tabList}>
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <div key={tab.id} className={active ? `${css.tab} ${css.tabActive}` : css.tab} data-enpoi-terminal-tab-row={tab.id}>
              <button
                type="button"
                className={css.tabPick}
                data-enpoi-terminal-tab={tab.id}
                aria-pressed={active}
                onClick={() => { onActivate(tab.id) }}
              >
                <span className={css.dot} data-status={tab.status} aria-hidden="true" />
                <span className={css.tabTitle}>{tab.title}</span>
              </button>
              <button
                type="button"
                className={css.tabClose}
                aria-label={t('terminalCloseTab', { title: tab.title })}
                data-enpoi-terminal-close={tab.id}
                onClick={() => { onClose(tab.id) }}
              >
                <IconCloseFillRegular size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <Tooltip label={t('terminalNew')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('terminalNew')}
          data-enpoi-terminal-new={place}
          onClick={onOpen}
        >
          <IconPlusOutlineMedium size={14} />
        </button>
      </Tooltip>
      {extra}
    </div>
  )
}

/** The status line an exited or failed terminal shows above its output. */
export function TerminalStatusBanner({ tab, t }: { readonly tab: TerminalTabState; readonly t: BrandT }): ReactNode {
  if (tab.status === 'exited') {
    const code = tab.exitCode === null ? t('terminalExitSignal') : t('terminalExitCode', { code: tab.exitCode })
    return <div className={css.banner} data-enpoi-terminal-banner="exited">{t('terminalProcessExited', { code })}</div>
  }
  if (tab.status === 'error') {
    return <div className={css.banner} data-enpoi-terminal-banner="error">{tab.error ?? t('terminalFailed')}</div>
  }
  return null
}

/** Composed props of the right sidebar's terminal page. */
export type TerminalPanelProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'brandEnpoi'>
  & InjectFace<TerminalInjected>

/**
 * The terminal page body: the tab strip and the active terminal.
 * @param props - framework shares and the terminal inject face.
 * @returns the panel.
 */
export function TerminalPanel({
  sessionId, useSessions, useTerminals, openTerminal, closeTerminal, activateTerminal,
  writeTerminal, resizeTerminal, subscribeTerminal, readTerminal, toggleTerminalDock, t,
}: TerminalPanelProps): ReactNode {
  const session = useTerminals(state => state.bySession[sessionId])
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const tabs = useMemo(
    () => session?.tabs.filter(tab => tab.place === 'panel') ?? [],
    [session],
  )
  const active = tabs.find(tab => tab.id === session?.active.panel) ?? tabs[0]

  // Opening the page spawns its first shell when the conversation has none;
  // the guard keeps React's double-invoked mount effect from opening two.
  const spawned = useRef(false)
  useEffect(() => {
    if (spawned.current) return
    if (tabs.length > 0) return
    spawned.current = true
    openTerminal(sessionId, 'panel', cwd)
  }, [cwd, openTerminal, sessionId, tabs.length])

  return (
    <div className={css.root} data-enpoi-terminal-panel>
      <TerminalTabStrip
        sessionId={sessionId}
        place="panel"
        tabs={tabs}
        activeId={active?.id}
        t={t}
        onOpen={() => { openTerminal(sessionId, 'panel', cwd) }}
        onClose={(id) => { closeTerminal(sessionId, id) }}
        onActivate={(id) => { activateTerminal(sessionId, 'panel', id) }}
        extra={(
          <Tooltip label={t('terminalTogglePanel')} side="bottom" delayMs={400}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('terminalTogglePanel')}
              data-enpoi-terminal-dock-toggle
              onClick={toggleTerminalDock}
            >
              <TerminalIcon size={15} />
            </button>
          </Tooltip>
        )}
      />
      <div className={css.body}>
        {active === undefined ? (
          <div className={css.empty} data-enpoi-terminal-empty>
            <TerminalIcon size={22} />
            <p>{t('terminalNoOpen')}</p>
            <button type="button" className={css.newButton} onClick={() => { openTerminal(sessionId, 'panel', cwd) }}>
              {t('terminalNew')}
            </button>
          </div>
        ) : (
          <>
            <TerminalStatusBanner tab={active} t={t} />
            <TerminalView
              sessionId={sessionId}
              tab={active}
              active
              write={writeTerminal}
              resize={resizeTerminal}
              subscribe={subscribeTerminal}
              read={readTerminal}
            />
          </>
        )}
      </div>
    </div>
  )
}
