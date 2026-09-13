/**
 * Subagent Sessions — the right Sidebar tab body
 * (`sidebar.right.pane.tab` key `enpoi-subagent-sessions`, kind
 * `subagent-sessions`).
 *
 * The dispatch lineage as a tree: the current session's top-most `parentId`
 * ancestor (the main session) is the root, every descendant hangs below it
 * with depth indentation, and clicking any row opens its session through the
 * injected `openSession` (the apply-world `ctx.sessions.open`) — the main
 * session stays one click away without the left session list. A compact
 * ancestor strip repeats the root → current path for jumping up one level.
 * Lineage is read from the list projection (`parentId` / `origin:
 * 'subagent'`), so no session-log scan is needed. Sibling order and the
 * 50-row cap keep the branch nearest the current session visible; refresh
 * re-pulls the host list baseline through `ctx.sessions.refresh`, and the
 * store remains the live data channel.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SubagentSessionsBody.module.css'

/** One session derived from the list projection. */
interface LineageNode {
  id: SessionId
  title: string
  parentId: SessionId | undefined
  origin: 'subagent' | undefined
  running: boolean
  completed: boolean
  updatedAt: number
}

/** One pre-order tree row: a lineage node plus its indent depth. */
interface TreeRow extends LineageNode {
  depth: number
  current: boolean
}

/** The built lineage: visible rows, pre-cap total, root → current path, and titles by id. */
interface Lineage {
  rows: TreeRow[]
  total: number
  path: SessionId[]
  titles: ReadonlyMap<SessionId, string>
}

/** Rows drawn at once; nodes nearest the current session rank first. */
const MAX_ROWS = 50

/** Extra left padding per tree depth, in pixels. */
const INDENT_STEP = 14

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

/** Role/origin label and display title parsed from title or metadata. */
function nodeDisplay(node: TreeRow): { cleanTitle: string; role: string } {
  const rolePattern =
    /^(fixer|explorer|librarian|designer|oracle|critic|visionary|curator|skeptic|architect|pragmatist|experiencer|integrator)\s*:\s*(.+)$/i
  const match = rolePattern.exec(node.title)
  if (match && match[1] && match[2]) {
    return {
      role: match[1].toLowerCase(),
      cleanTitle: match[2].trim(),
    }
  }
  for (const r of ['fixer', 'explorer', 'librarian', 'designer', 'oracle']) {
    if (new RegExp(`\\b${r}\\b`, 'i').test(node.title)) {
      return { role: r, cleanTitle: node.title }
    }
  }
  return {
    role: node.depth === 0 ? 'main' : (node.origin === 'subagent' ? 'subagent' : 'session'),
    cleanTitle: node.title,
  }
}

/** Running/idle/done discriminant shared by the dot and the status column. */
function statusOf(node: LineageNode): 'running' | 'idle' | 'done' {
  if (node.running) return 'running'
  return node.completed ? 'done' : 'idle'
}

/**
 * Build the lineage tree rooted at the current session's top-most listed
 * ancestor. Sibling order keeps the current session, its direct children, and
 * the branches nearest it ahead of the rest (the cap then keeps them). Without
 * a listed current row the forest of top-level sessions is shown, newest first.
 * @param nodes - every summary in the list projection.
 * @param currentId - the session the tab is rendered for, when listed.
 * @returns pre-order rows, pre-cap total, ancestor path, and id → title map.
 */
function buildLineage(nodes: readonly LineageNode[], currentId: SessionId | undefined): Lineage {
  const byId = new Map<SessionId, LineageNode>()
  const titles = new Map<SessionId, string>()
  for (const node of nodes) {
    byId.set(node.id, node)
    titles.set(node.id, node.title)
  }

  // Children adjacency for listed parents; everything else is a top-level row.
  const children = new Map<SessionId, LineageNode[]>()
  const roots: LineageNode[] = []
  for (const node of nodes) {
    const parentId = node.parentId
    if (parentId !== undefined && parentId !== node.id && byId.has(parentId)) {
      const siblings = children.get(parentId)
      if (siblings === undefined) children.set(parentId, [node])
      else siblings.push(node)
    } else {
      roots.push(node)
    }
  }

  // Distances from the current session along parent/child edges; the cap keeps
  // the nodes closest to the operator's current position.
  const distance = new Map<SessionId, number>()
  if (currentId !== undefined && byId.has(currentId)) {
    distance.set(currentId, 0)
    const queue: SessionId[] = [currentId]
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) break
      const next = (distance.get(id) ?? 0) + 1
      const neighbours: SessionId[] = []
      const parentId = byId.get(id)?.parentId
      if (parentId !== undefined && byId.has(parentId)) neighbours.push(parentId)
      for (const child of children.get(id) ?? []) neighbours.push(child.id)
      for (const neighbour of neighbours) {
        if (distance.has(neighbour)) continue
        distance.set(neighbour, next)
        queue.push(neighbour)
      }
    }
  }

  // Minimum distance inside one subtree: the branch holding the current
  // session always outranks its siblings.
  const subtreeDistance = new Map<SessionId, number>()
  const measure = (id: SessionId, visiting: Set<SessionId>): number => {
    if (visiting.has(id)) return Number.POSITIVE_INFINITY
    visiting.add(id)
    let best = distance.get(id) ?? Number.POSITIVE_INFINITY
    for (const child of children.get(id) ?? []) best = Math.min(best, measure(child.id, visiting))
    visiting.delete(id)
    return best
  }
  for (const node of nodes) subtreeDistance.set(node.id, measure(node.id, new Set()))

  /** Sibling order: stable chronological order; never jump the active row to the top! */
  const order = (siblings: readonly LineageNode[]): LineageNode[] =>
    [...siblings].sort((left, right) => left.updatedAt - right.updatedAt)

  // Walk the current session's parent chain to the top-most listed ancestor.
  let rootId: SessionId | undefined
  const path: SessionId[] = []
  if (currentId !== undefined && byId.has(currentId)) {
    const seen = new Set<SessionId>([currentId])
    let id = currentId
    for (;;) {
      path.push(id)
      const parentId = byId.get(id)?.parentId
      if (parentId === undefined || seen.has(parentId) || !byId.has(parentId)) {
        rootId = id
        break
      }
      seen.add(parentId)
      id = parentId
    }
    path.reverse()
  }

  // Pre-order walk from the root; a cycle degrades to one visit per node.
  const rows: TreeRow[] = []
  const visited = new Set<SessionId>()
  const walk = (node: LineageNode, depth: number): void => {
    if (visited.has(node.id)) return
    visited.add(node.id)
    rows.push({ ...node, depth, current: node.id === currentId })
    for (const child of order(children.get(node.id) ?? [])) walk(child, depth + 1)
  }
  if (rootId !== undefined) {
    const root = byId.get(rootId)
    if (root !== undefined) walk(root, 0)
  } else {
    for (const root of [...roots].sort((left, right) => right.updatedAt - left.updatedAt)) walk(root, 0)
  }

  return { rows, total: rows.length, path, titles }
}

/** Monochrome micro icon (stroke currentColor). */
function MicroIcon({ d, size = 11 }: { d: string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Props of the Subagent Sessions tab glyph. */
interface SubagentSessionsIconProps {
  size?: number | undefined
  active?: boolean | undefined
  className?: string | undefined
}

/** Monochrome tab glyph for Subagent Sessions (thin stroke, currentColor), also the guide capsule icon. */
export function SubagentSessionsIcon({ size = 16, className }: SubagentSessionsIconProps) {
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
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [])

  const currentId = sessionId === '' ? undefined : sessionId
  const lineage = useMemo(() => {
    const nodes: LineageNode[] = []
    for (const summary of Object.values(byId)) {
      nodes.push({
        id: summary.id,
        title: summary.displayTitle,
        parentId: summary.parentId,
        origin: summary.origin,
        running: summary.running,
        completed: summary.completed === true,
        updatedAt: summary.updatedAt,
      })
    }
    return buildLineage(nodes, currentId)
  }, [byId, currentId])

  const visibleRows = lineage.rows.slice(0, MAX_ROWS)

  const onRefresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refreshSessions().finally(() => { setRefreshing(false) })
  }

  return (
    <div className={css.container}>
      <header className={css.head}>
        <span className={css.headTitle}>Subagent Sessions</span>
        <span className={css.headCount}>{lineage.total} {lineage.total === 1 ? 'session' : 'sessions'}</span>
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

      {lineage.rows.length === 0 ? (
        <div className={css.empty}>
          <span className={css.emptyIcon}><SubagentSessionsIcon size={18} /></span>
          <span>No subagent sessions yet</span>
        </div>
      ) : (
        <div className={css.list} aria-label="Session lineage">
          {visibleRows.map((row) => {
            const state = statusOf(row)
            const { cleanTitle, role } = nodeDisplay(row)
            return (
              <button
                key={row.id}
                type="button"
                className={css.row}
                data-current={row.current ? 'true' : undefined}
                style={row.depth > 0 ? { paddingLeft: 9 + row.depth * INDENT_STEP } : undefined}
                onClick={() => { openSession(row.id) }}
                title={`Open ${row.title}`}
                aria-current={row.current ? 'true' : undefined}
              >
                {row.depth > 0 && <span className={css.branch} aria-hidden="true" />}
                <span className={css.dot} data-state={state} />
                <span className={css.rowMain}>
                  <span className={css.rowTitle}>{cleanTitle}</span>
                  <span className={css.rowSub}>{role}</span>
                </span>
                <span className={css.status} data-state={state}>
                  {state}
                  <span className={css.age}>{ageLabel(row.updatedAt, now)}</span>
                </span>
              </button>
            )
          })}
          {lineage.rows.length > visibleRows.length && (
            <div className={css.more}>
              Showing {visibleRows.length} of {lineage.rows.length} — nearest first
            </div>
          )}
        </div>
      )}
    </div>
  )
}
