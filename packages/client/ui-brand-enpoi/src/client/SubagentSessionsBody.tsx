/**
 * Subagent Sessions — the right Sidebar tab body
 * (`sidebar.right.pane.tab` key `enpoi-subagent-sessions`, kind
 * `subagent-sessions`).
 *
 * The old Tasks panel, re-homed on the first-party right sidebar: every
 * subagent session the client list knows about, newest first, with the parent
 * it was dispatched from, its running/idle/done status and age, and a click
 * that opens the session through the injected `openSession` (the apply-world
 * `ctx.sessions.open`). Lineage is read from the list projection — the host
 * summary carries `parentSessionId` / `origin: 'subagent'`, so no session-log
 * scan is needed for the broad list.
 *
 * Refresh re-pulls the host list baseline through `ctx.sessions.refresh`;
 * the store remains the data channel, so the tab follows live updates on its
 * own between refreshes.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SubagentSessionsBody.module.css'

/** One row derived from the list projection. */
interface SubagentRow {
  id: SessionId
  title: string
  parentId: SessionId | undefined
  parentTitle: string | undefined
  running: boolean
  completed: boolean
  updatedAt: number
}

/** Rows drawn at once; the current session's children rank first. */
const MAX_ROWS = 50

/** Injected business face of the Subagent Sessions tab (built in apply from ctx). */
export interface SubagentSessionsInjected {
  /**
   * Select a listed subagent session as current.
   * @param id - session identity from the list projection.
   */
  openSession: (id: SessionId) => void
  /** Re-pull the host session-list baseline. */
  refreshSessions: () => Promise<void>
}

export type SubagentSessionsBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & InjectFace<SubagentSessionsInjected>

/** Compact relative age (`2m`, `3h`, `5d`). */
function ageLabel(updatedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Monochrome micro icon (stroke currentColor). */
function MicroIcon({ d, size = 11 }: { d: string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Monochrome tab glyph for Subagent Sessions (thin stroke, currentColor), also the guide capsule icon. */
export function SubagentSessionsIcon({ size = 16, className }: { size?: number | undefined; active?: boolean | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="8" cy="3.6" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="3.6" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.4" cy="12.4" r="1.9" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5.6v2.2M8 7.8 4.6 10.7M8 7.8l3.4 2.9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  )
}

export function SubagentSessionsBody({ sessionId, useSessions, openSession, refreshSessions }: SubagentSessionsBodyProps) {
  const byId = useSessions(state => state.byId)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Ages stay honest without depending on list churn.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => { window.clearInterval(timer) }
  }, [])

  const rows = useMemo(() => {
    const own = typeof sessionId === 'string' ? sessionId : undefined
    const list: SubagentRow[] = []
    for (const summary of Object.values(byId)) {
      if (summary.origin !== 'subagent') continue
      const parent = summary.parentId !== undefined ? byId[summary.parentId] : undefined
      list.push({
        id: summary.id,
        title: summary.displayTitle,
        parentId: summary.parentId,
        parentTitle: parent?.displayTitle,
        running: summary.running,
        completed: summary.completed === true,
        updatedAt: summary.updatedAt,
      })
    }
    // This session's own children first, then newest activity.
    list.sort((left, right) => {
      const leftOwn = own !== undefined && left.parentId === own ? 1 : 0
      const rightOwn = own !== undefined && right.parentId === own ? 1 : 0
      return rightOwn - leftOwn || right.updatedAt - left.updatedAt
    })
    return list
  }, [byId, sessionId])

  const visibleRows = rows.slice(0, MAX_ROWS)

  const onRefresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refreshSessions().finally(() => { setRefreshing(false) })
  }

  return (
    <div className={css.container}>
      <header className={css.head}>
        <span className={css.headTitle}>Subagent Sessions</span>
        <span className={css.headCount}>{rows.length} {rows.length === 1 ? 'session' : 'sessions'}</span>
        <button
          type="button"
          className={`${css.refreshBtn}${refreshing ? ` ${css.refreshing}` : ''}`}
          onClick={onRefresh}
          title="Refresh session list"
          aria-label="Refresh session list"
        >
          <MicroIcon d="M13 8a5 5 0 11-1.5-3.5M13 2.5V6h-3.5" size={11} />
        </button>
      </header>

      {rows.length === 0 ? (
        <div className={css.empty}>
          <span className={css.emptyIcon}><SubagentSessionsIcon size={18} /></span>
          <span>No subagent sessions yet</span>
        </div>
      ) : (
        <div className={css.list}>
          {visibleRows.map(row => (
            <button
              key={row.id}
              type="button"
              className={css.row}
              onClick={() => { openSession(row.id) }}
              title={`Open ${row.title}`}
            >
              <span
                className={css.dot}
                data-state={row.running ? 'running' : row.completed ? 'done' : 'idle'}
              />
              <span className={css.rowMain}>
                <span className={css.rowTitle}>{row.title}</span>
                <span className={css.rowSub}>
                  {row.parentTitle !== undefined ? <>from {row.parentTitle}</> : <>{row.id}</>}
                </span>
              </span>
              <span className={css.status} data-state={row.running ? 'running' : row.completed ? 'done' : 'idle'}>
                {row.running ? 'running' : row.completed ? 'done' : 'idle'}
                <span className={css.age}>{ageLabel(row.updatedAt, now)}</span>
              </span>
            </button>
          ))}
          {rows.length > visibleRows.length && (
            <div className={css.more}>
              Showing {visibleRows.length} of {rows.length} — newest first
            </div>
          )}
        </div>
      )}
    </div>
  )
}
