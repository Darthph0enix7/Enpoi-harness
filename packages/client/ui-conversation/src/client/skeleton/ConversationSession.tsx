/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useRef, useState, useTransition } from 'react'
import clsx from 'clsx'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { hitTargetClass } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import { resolveActiveView } from '../view-selection.ts'
import { DefaultConversationViews } from './DefaultConversationViews.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

interface Breadcrumb {
  readonly id: SessionId
  readonly displayTitle: string
  readonly subagent: boolean
}

function deriveAncestry(list: SessionListState, id: SessionId): readonly Breadcrumb[] {
  const chain: Breadcrumb[] = []
  const seen = new Set<SessionId>()
  let cursor: SessionId | undefined = id
  while (cursor !== undefined) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const summary: SessionSummary | undefined = list.byId[cursor]
    if (summary === undefined) break
    chain.unshift({
      id: summary.id,
      displayTitle: summary.displayTitle,
      subagent: summary.origin === 'subagent',
    })
    if (summary.origin !== 'subagent') break
    cursor = summary.parentId
  }
  return chain
}

function equalBreadcrumbs(left: readonly Breadcrumb[], right: readonly Breadcrumb[]): boolean {
  return left.length === right.length
    && left.every((item, index) => {
      const other = right.at(index)
      return other !== undefined && item.id === other.id && item.displayTitle === other.displayTitle
    })
}

/**
 * Renders Session header chrome above the resident conversation scrollport.
 * @param props - Strict Session store, view ledger, navigation, render, and locale shares.
 * @returns Session navigation controls, with title and tabs after conversation starts.
 */
export function ConversationSessionHeader({
  sessionId, hideChrome, useSessions, useConversationViews, useStore,
  renderSlot, open, selectView, t,
}: ConversationSessionHeaderProps) {
  const tabs = useConversationViews(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  // The tapped View is highlighted on this tap, then mounted after the paint
  // that follows it. A View's first mount can be expensive (the Trajectory
  // ledger builds its window synchronously); without the split, the tab's
  // selected state and the whole view commit land in one long task, so the tap
  // looks ignored until the next frame.
  const [pendingView, setPendingView] = useState<string | null>(null)
  const [, startViewSwitch] = useTransition()
  const activeId = pendingView ?? active?.id
  const deferredSwitch = useRef<number | null>(null)
  useEffect(() => {
    if (pendingView === null) return
    // Adopt the real selection once it commits, or clear the highlight if the
    // View disappeared from the roster between the tap and the deferred mount.
    if (pendingView === active?.id || !tabs.some(tab => tab.id === pendingView)) setPendingView(null)
  }, [pendingView, active?.id, tabs])
  useEffect(() => () => {
    if (deferredSwitch.current !== null) cancelAnimationFrame(deferredSwitch.current)
  }, [])
  const chooseView = (id: string): void => {
    if (id === activeId) return
    // First tap: select the tab now (a cheap, urgent render the next paint
    // shows), then mount the View after that paint. The store update is an
    // external-store notification — React 18 renders those synchronously even
    // inside a transition — so a transition alone would still run the whole
    // ledger mount inside the tap's task. Two frames guarantee the selected
    // state reaches the screen before the heavy work starts; the transition
    // then keeps the mount interruptible.
    setPendingView(id)
    if (deferredSwitch.current !== null) cancelAnimationFrame(deferredSwitch.current)
    deferredSwitch.current = requestAnimationFrame(() => {
      deferredSwitch.current = requestAnimationFrame(() => {
        deferredSwitch.current = null
        startViewSwitch(() => { selectView(id) })
      })
    })
  }
  const ancestry = useSessions(s => deriveAncestry(s, sessionId), equalBreadcrumbs)
  const showTabs = !hideChrome && tabs.length > 1
  return (
    <>
      <div className={css.titleRow}>
        {!hideChrome && (
          <>
            <div className={css.titleCluster}>
              <nav className={css.crumbs} aria-label={t('session.hierarchy')}>
                {ancestry.map((summary, index) => {
                  const last = index === ancestry.length - 1
                  // The current crumb has no navigation, so it is plain text
                  // rather than a disabled button: on darwin desktop a button
                  // would subtract itself from the header's drag row (ui-web
                  // base.css) and leave the title inert for dragging too.
                  const title = last
                    ? (
                      <span className={clsx(css.crumb, summary.subagent && css.crumbSubagent, css.crumbCurrent)}>
                        {summary.displayTitle}
                      </span>
                    )
                    : (
                      <button
                        type="button"
                        className={clsx(css.crumb, hitTargetClass, summary.subagent && css.crumbSubagent)}
                        onClick={() => { open(summary.id) }}
                      >
                        {summary.displayTitle}
                      </button>
                    )
                  const lineage = last || summary.subagent
                  const lineageOwner = {
                    lineageSessionId: summary.id,
                    displayTitle: summary.displayTitle,
                    ...last ? {} : { openTitle: () => { open(summary.id) } },
                  }
                  return (
                    <span key={summary.id} className={css.crumbSeg}>
                      {index > 0 && <span className={css.crumbSep}>/</span>}
                      {lineage
                        ? summary.subagent
                          ? renderSlot(
                            'conversation.session.header.lineage',
                            lineageOwner,
                            { fallback: title },
                          )
                          : (
                            <>
                              {title}
                              {renderSlot(
                                'conversation.session.header.lineage',
                                lineageOwner,
                                { fallback: null },
                              )}
                            </>
                          )
                        : title}
                    </span>
                  )
                })}
                {ancestry.length === 0 && <span className={css.crumbCurrent}>{sessionId}</span>}
              </nav>
              <div className={css.headerActions}>
                {renderSlot('conversation.session.header.actions', {})}
              </div>
            </div>
            <div className={css.headerUtilities}>
              {renderSlot('conversation.session.header.utilities', {})}
            </div>
          </>
        )}
        <div className={css.headerCorner} data-conversation-header-corner="">
          {renderSlot('conversation.session.header.corner', {})}
        </div>
      </div>
      {showTabs && (
        // data-conversation-tabs: marks the tab strip, which the window-chrome
        // geometry and the browser coverage lane anchor on.
        <div className={css.tabs} role="tablist" data-conversation-tabs="">
          {tabs.map(viewTab => (
            <button
              key={viewTab.id}
              type="button"
              role="tab"
              aria-selected={viewTab.id === activeId}
              className={clsx(css.tab, viewTab.id === activeId && css.tabActive)}
              onClick={() => { chooseView(viewTab.id) }}
            >
              {viewTab.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession(props: ConversationSessionProps) {
  return <DefaultConversationViews {...props} />
}
