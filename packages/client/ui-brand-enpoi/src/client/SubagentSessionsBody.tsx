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
 *
 * Rows lead with the agent identity, never the query: the persona is parsed
 * from the host's subagent identity projection (`council debater: Critic` →
 * `Critic`), then from a role the title names — a `<role>:` prefix resolved
 * through the settings-backed role registry, else a registry role mentioned in
 * the title — with the registry label or the title-cased role id as the label;
 * the session title stays as the secondary line and the hover tooltip. A
 * pending list snapshot (reconnect, first load) keeps the last rendered tree
 * on screen instead of flashing the empty state.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { registryRoleLabel, type RoleRegistryMap } from './role-registry.ts'
import type { BrandT } from './locales.ts'
import css from './SubagentSessionsBody.module.css'

/** One session derived from the list projection. */
interface LineageNode {
  id: SessionId
  title: string
  /** Durable subagent identity label from the list projection, e.g. `council debater: Critic`. */
  subagentLabel: string | undefined
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
  /** The settings-backed role registry as a bound `useRoleRegistry` hook. */
  hooks: { roleRegistry: HostObservable<RoleRegistryMap> }
  /**
   * Select a listed subagent session as current.
   * @param id - session identity from the list projection.
   */
  openSession: (id: SessionId) => void
  /**
   * Open one subagent child through its durable direct-parent address. The host
   * refuses history for a subagent-origin Session addressed as an ordinary
   * session ("subagent Sessions require their durable parent address"), so the
   * catalog-derived address is the only usable path for a child.
   * @param address - parent, child, and delegation mode from the catalog.
   */
  openChild: (address: SubagentAddress) => void
  /** Re-pull the host session-list baseline. */
  refreshSessions: () => Promise<void>
}

/** How long a deferred child open waits for the parent catalog before giving up, in ms. */
const CATALOG_WAIT_MS = 2_500

export type SubagentSessionsBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'brandEnpoi'>
  & InjectFace<SubagentSessionsInjected>

/** Compact relative age (`2m`, `3h`, `5d`). */
function ageLabel(updatedAt: number, now: number, t: BrandT): string {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000)
  if (minutes < 1) return t('subagentAgeJustNow')
  if (minutes < 60) return t('subagentAgeMinutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('subagentAgeHours', { count: hours })
  return t('subagentAgeDays', { count: Math.floor(hours / 24) })
}

/** Generic role prefixes the host puts before a persona name in an identity label. */
const LABEL_PREFIX = /^\s*(?:council\s+debater|subagent|agent|child|persona|worker)\s*:\s*/i

/** Title-case an all-lowercase persona name; a name already carrying case stays verbatim. */
function titleCasePersona(name: string): string {
  return name === name.toLowerCase()
    ? name.replace(/(^|[\s-])([a-z])/g, (_all, prefix: string, letter: string) => prefix + letter.toUpperCase())
    : name
}

/**
 * Persona name carried by a subagent identity label, or `undefined` when the
 * label holds nothing after its generic prefix.
 * @param label - projection label such as `council debater: Critic`.
 * @returns the title-cased persona, e.g. `Critic`.
 */
function personaFromLabel(label: string): string | undefined {
  const name = label.replace(LABEL_PREFIX, '').trim()
  return name === '' ? undefined : titleCasePersona(name)
}

/** A role prefix carried by a session title (`fixer: fix the bug`). */
function rolePrefixFromTitle(title: string): { role: string; rest: string } | undefined {
  const match = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+)$/i.exec(title)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const role = match[1].toLowerCase().replace(/^the\s+/, '')
  return { role, rest: match[2].trim() }
}

/**
 * First registry role id named as a whole word in a title (the light fallback
 * for titles the host did not label with a role prefix).
 * @param registry - the effective role registry.
 * @param title - the session display title.
 * @returns the matched role id, or undefined.
 */
function mentionedRole(registry: RoleRegistryMap, title: string): string | undefined {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean))
  for (const id of Object.keys(registry)) {
    if (words.has(id)) return id
  }
  return undefined
}

/**
 * Primary identity label and secondary session title for one row. The host's
 * subagent identity projection wins, then a registry role named by the title
 * (the registry label, else the title-cased role id), then the row metadata.
 * @param node - the rendered tree row.
 * @param registry - the effective role registry.
 * @returns the leading label and the remaining session title.
 */
function nodeDisplay(node: TreeRow, registry: RoleRegistryMap, t: BrandT): { label: string; cleanTitle: string } {
  const persona = node.subagentLabel === undefined ? undefined : personaFromLabel(node.subagentLabel)
  const prefix = rolePrefixFromTitle(node.title)
  if (prefix !== undefined && registry[prefix.role] !== undefined) {
    return { label: persona ?? registryRoleLabel(registry, prefix.role), cleanTitle: prefix.rest }
  }
  if (persona !== undefined) {
    return { label: persona, cleanTitle: node.title }
  }
  const role = mentionedRole(registry, node.title)
  if (role !== undefined) {
    return { label: registryRoleLabel(registry, role), cleanTitle: node.title }
  }
  return {
    label: node.depth === 0 ? t('subagentRowMain') : (node.origin === 'subagent' ? t('subagentRowSubagent') : t('subagentRowSession')),
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

export function SubagentSessionsBody({
  sessionId, useSessions, useRoleRegistry, openSession, openChild, refreshSessions, t,
}: SubagentSessionsBodyProps) {
  const byId = useSessions(state => state.byId)
  const phase = useSessions(state => state.phase)
  const projections = useSessions(state => state.projectionsBySession)
  const registry = useRoleRegistry(snapshot => snapshot)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Ages stay honest without depending on list churn.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { window.clearInterval(timer) }
  }, [])

  // Catalog-derived child addresses: the host accepts a subagent child only
  // through its durable direct-parent address, so every open resolves the
  // address first and falls back to the ordinary path for real sessions.
  const addresses = useMemo(() => {
    const map = new Map<SessionId, SubagentAddress>()
    for (const [parentSessionId, projection] of Object.entries(projections)) {
      for (const entry of projection.values.subagentCatalog ?? []) {
        map.set(entry.id, { parentSessionId: parentSessionId as SessionId, childSessionId: entry.id, mode: entry.mode })
      }
    }
    return map
  }, [projections])

  /** A child whose parent catalog is still loading: select the parent, then open the child. */
  const [deferred, setDeferred] = useState<{ childId: SessionId; parentId: SessionId; deadline: number } | null>(null)

  const openRow = (id: SessionId, parentId?: SessionId): void => {
    const address = addresses.get(id)
    if (address !== undefined) { openChild(address); return }
    if (parentId !== undefined && parentId !== id) {
      // Selecting the parent loads its subagent catalog; the effect below opens
      // the child the moment its address appears.
      openSession(parentId)
      setDeferred({ childId: id, parentId, deadline: Date.now() + CATALOG_WAIT_MS })
      return
    }
    openSession(id)
  }

  useEffect(() => {
    if (deferred === null) return
    const address = addresses.get(deferred.childId)
    if (address !== undefined) {
      openChild(address)
      setDeferred(null)
      return
    }
    // The parent is already selected; if the catalog never answers, stay there
    // rather than triggering the host's plain-session refusal for a child.
    const timer = window.setTimeout(() => { setDeferred(null) }, Math.max(0, deferred.deadline - Date.now()))
    return () => { window.clearTimeout(timer) }
  }, [deferred, addresses, openChild])

  const currentId = sessionId === '' ? undefined : sessionId
  const lineage = useMemo(() => {
    const nodes: LineageNode[] = []
    for (const summary of Object.values(byId)) {
      nodes.push({
        id: summary.id,
        title: summary.displayTitle,
        subagentLabel: summary.projectionValues?.subagent?.label,
        parentId: summary.parentId,
        origin: summary.origin,
        running: summary.running,
        // The merged SessionSummary carries `running` (upstream dropped the
        // durable `completed` bit): a no-longer-running child reads as done.
        completed: !summary.running,
        updatedAt: summary.updatedAt,
      })
    }
    return buildLineage(nodes, currentId)
  }, [byId, currentId])

  // A pending list snapshot (reconnect, the first pull after a switch) can
  // arrive with no rows for a moment. The last non-empty tree stays drawn
  // until the snapshot lands, so the panel never flashes its empty state.
  const retained = useRef<readonly TreeRow[] | undefined>(undefined)
  useEffect(() => {
    if (lineage.rows.length > 0) retained.current = lineage.rows
  }, [lineage])
  const rows = lineage.rows.length > 0 || phase !== 'pending'
    ? lineage.rows
    : retained.current ?? lineage.rows

  const visibleRows = rows.slice(0, MAX_ROWS)

  const onRefresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void refreshSessions().finally(() => { setRefreshing(false) })
  }

  return (
    <div className={css.container}>
      <header className={css.head}>
        <span className={css.headTitle}>{t('subagentTitle')}</span>
        <span className={css.headCount}>
          {t('subagentCountOne', { count: rows.length })}
        </span>
        <button
          type="button"
          className={`${css.refreshBtn}${refreshing ? ` ${css.refreshing}` : ''}`}
          onClick={onRefresh}
          title={t('subagentRefresh')}
          aria-label={t('subagentRefresh')}
        >
          <MicroIcon d="M13 8a5 5 0 11-1.5-3.5M13 2.5V6h-3.5" size={11} />
        </button>
      </header>

      {rows.length === 0 ? (
        <div className={css.empty}>
          <span className={css.emptyIcon}><SubagentSessionsIcon size={18} /></span>
          <span>{t('subagentEmpty')}</span>
        </div>
      ) : (
        <div className={css.list} aria-label={t('subagentLineageAria')}>
          {visibleRows.map((row) => {
            const state = statusOf(row)
            const { label, cleanTitle } = nodeDisplay(row, registry, t)
            return (
              <button
                key={row.id}
                type="button"
                className={css.row}
                data-current={row.current ? 'true' : undefined}
                style={row.depth > 0 ? { paddingLeft: 9 + row.depth * INDENT_STEP } : undefined}
                onClick={() => { openRow(row.id, row.parentId) }}
                title={t('subagentOpenTitle', { title: row.title })}
                aria-current={row.current ? 'true' : undefined}
              >
                {row.depth > 0 && <span className={css.branch} aria-hidden="true" />}
                <span className={css.dot} data-state={state} />
                <span className={css.rowMain}>
                  <span className={css.rowTitle}>{label}</span>
                  {cleanTitle !== label && <span className={css.rowSub}>{cleanTitle}</span>}
                </span>
                <span className={css.status} data-state={state}>
                  {state}
                  <span className={css.age}>{ageLabel(row.updatedAt, now, t)}</span>
                </span>
              </button>
            )
          })}
          {rows.length > visibleRows.length && (
            <div className={css.more}>
              {t('subagentShowing', { shown: visibleRows.length, total: rows.length })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
