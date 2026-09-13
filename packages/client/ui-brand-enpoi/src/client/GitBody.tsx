/**
 * Git — the right Sidebar tab body (`sidebar.right.pane.tab` key `enpoi-git`,
 * kind `git`).
 *
 * The old sidebar's git panel, re-homed on the first-party right sidebar:
 * current branch, ahead/behind, working-tree counts, local branches
 * (display only — this tab never checks out), recent commits, the changed-file
 * list, and the selected file's unified diff in a scrollable monospace block.
 * A cwd that is not a repository shows the "Not a git repository" state, never
 * an error: the host `enpoiGit.*` remotes answer `repo: false` / empty values.
 *
 * cwd resolution: the tab's own session id addresses the client list
 * projection (`useSessions(s => s.byId[sessionId]?.cwd)`), the same source the
 * Files tab reads. Reads and the manual refresh go over the raw gateway
 * envelope (`/api/enpoiGit.*`), matching the Capabilities tab's RPC pattern.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './GitBody.module.css'

/** `enpoiGit.status` value. */
interface GitStatus {
  repo: boolean
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

/** `enpoiGit.branches` value. */
interface GitBranches {
  current: string
  names: string[]
}

/** `enpoiGit.log` entry. */
interface GitLogEntry {
  sha: string
  subject: string
  author: string
  date: string
}

/** `enpoiGit.changes` entry. */
interface GitChange {
  path: string
  code: string
  staged: boolean
  untracked: boolean
}

/** `enpoiGit.diff` value. */
interface GitDiff {
  text: string
  truncated: boolean
}

/** What the tab currently draws. */
type GitLoad =
  | { phase: 'loading' }
  | { phase: 'no-cwd' }
  | { phase: 'non-repo' }
  | { phase: 'error'; message: string }
  | {
    phase: 'ready'
    status: GitStatus
    branches: GitBranches
    entries: GitLogEntry[]
    changes: GitChange[]
  }

type GitRpcResult<T> = { ok: true; value: T } | { ok: false; message: string }

let rpcSeq = 0

/** Unique wire rpcId per request (the gateway echoes it; duplicates race). */
function nextRpcId(prefix: string): string {
  rpcSeq += 1
  return `${prefix}-${rpcSeq}`
}

/**
 * One `enpoiGit.*` call over the shared client-request envelope.
 * @param method - Remote endpoint name (`enpoiGit.status`, ...).
 * @param args - exact named wire arguments.
 * @returns the business value or a displayable failure message.
 */
async function gitRpc<T>(method: string, args: Record<string, unknown>): Promise<GitRpcResult<T>> {
  try {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: nextRpcId('enpoi-git'),
        payload: { args },
      }),
    })
    if (!response.ok) return { ok: false, message: `gateway responded ${response.status}` }
    const json = await response.json() as {
      result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } }
    }
    const result = json?.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'git request was rejected' }
    }
    return { ok: true, value: result.value as T }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Compact relative age (`2m`, `3h`, `5d`). */
function ageLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** Monochrome micro icon (stroke currentColor). */
function MicroIcon({ d, size = 11 }: { d: string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

/** Monochrome tab glyph for Git (thin stroke, currentColor), also the guide capsule icon. */
export function GitIcon({ size = 16, className }: { size?: number | undefined; active?: boolean | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="4.6" cy="3.6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.6" cy="12.4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.4" cy="7.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.6 5.3v5.4M4.6 8.4h3.4a1.7 1.7 0 001.7-1.7V7.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export type GitBodyProps = PropsRuntime<'sidebar.right.pane.tab'>

export function GitBody({ sessionId, useSessions, useTabInfo }: GitBodyProps) {
  const { tab } = useTabInfo()
  const visible = tab.visible
  const cwd = useSessions(state => (typeof sessionId === 'string' ? state.byId[sessionId]?.cwd : undefined))

  const [load, setLoad] = useState<GitLoad>({ phase: 'loading' })
  const [reloadSeq, setReloadSeq] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Commit ages stay honest while the tab is open.
  useEffect(() => {
    if (!visible) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => { window.clearInterval(timer) }
  }, [visible])

  // A cwd switch invalidates the selected file and its diff.
  useEffect(() => {
    setSelected(null)
    setDiff(null)
  }, [cwd])

  // Status + branches + log + changes, in one pass per visible/cwd/refresh step.
  useEffect(() => {
    if (!visible) return undefined
    if (cwd === undefined || cwd === '') {
      setLoad({ phase: 'no-cwd' })
      return undefined
    }
    let cancelled = false
    setLoad(current => (current.phase === 'ready' ? current : { phase: 'loading' }))
    void (async () => {
      const [statusResult, branchesResult, logResult, changesResult] = await Promise.all([
        gitRpc<GitStatus>('enpoiGit.status', { cwd }),
        gitRpc<GitBranches>('enpoiGit.branches', { cwd }),
        gitRpc<{ entries: GitLogEntry[] }>('enpoiGit.log', { cwd, limit: 20 }),
        gitRpc<{ files: GitChange[] }>('enpoiGit.changes', { cwd }),
      ])
      if (cancelled) return
      if (!statusResult.ok) {
        setLoad({ phase: 'error', message: statusResult.message })
        return
      }
      if (!statusResult.value.repo) {
        setLoad({ phase: 'non-repo' })
        return
      }
      setLoad({
        phase: 'ready',
        status: statusResult.value,
        branches: branchesResult.ok ? branchesResult.value : { current: statusResult.value.branch, names: [] },
        entries: logResult.ok ? logResult.value.entries : [],
        changes: changesResult.ok ? changesResult.value.files : [],
      })
    })()
    return () => { cancelled = true }
  }, [visible, cwd, reloadSeq])

  // The selected file's diff (re-read on refresh and cwd switch).
  useEffect(() => {
    if (!visible || selected === null || cwd === undefined || cwd === '') return undefined
    let cancelled = false
    setDiffLoading(true)
    void gitRpc<GitDiff>('enpoiGit.diff', { cwd, path: selected }).then((result) => {
      if (cancelled) return
      setDiffLoading(false)
      setDiff(result.ok ? result.value : { text: `diff unavailable: ${result.message}`, truncated: false })
    })
    return () => { cancelled = true }
  }, [visible, cwd, selected, reloadSeq])

  const refresh = (): void => { setReloadSeq(seq => seq + 1) }

  const dirtyCount = load.phase === 'ready'
    ? load.status.staged + load.status.unstaged + load.status.untracked
    : 0

  const body = useMemo((): ReactNode => {
    if (load.phase === 'loading') {
      return <div className={css.state}><span className={css.stateDim}>Reading repository…</span></div>
    }
    if (load.phase === 'no-cwd') {
      return <div className={css.state}><span className={css.stateTitle}>No workspace</span><span className={css.stateDim}>This session has no working directory.</span></div>
    }
    if (load.phase === 'non-repo') {
      return (
        <div className={css.state}>
          <span className={css.stateTitle}>Not a git repository</span>
          <code className={css.statePath}>{cwd ?? ''}</code>
        </div>
      )
    }
    if (load.phase === 'error') {
      return (
        <div className={css.state}>
          <span className={css.stateTitle}>Git unavailable</span>
          <span className={css.stateDim}>{load.message}</span>
          <button type="button" className={css.retryBtn} onClick={refresh}>Retry</button>
        </div>
      )
    }

    const { status, branches, entries, changes } = load
    return (
      <div className={css.scroll}>
        <section className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>Branches</span>
            <span className={css.sectionCount}>{branches.names.length}</span>
          </div>
          <div className={css.rows}>
            {branches.names.length === 0 && <div className={css.none}>No local branches</div>}
            {branches.names.map(name => (
              <div key={name} className={css.branchRow} data-current={name === branches.current || name === status.branch ? '' : undefined}>
                <span className={css.branchDot} />
                <span className={css.branchName}>{name}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>Changes</span>
            <span className={css.sectionCount}>{changes.length}</span>
          </div>
          <div className={css.rows}>
            {changes.length === 0 && <div className={css.none}>Working tree clean</div>}
            {changes.map(change => (
              <button
                key={`${change.code}:${change.path}`}
                type="button"
                className={css.changeRow}
                data-selected={selected === change.path ? '' : undefined}
                onClick={() => { setSelected(change.path) }}
                title={change.path}
              >
                <span
                  className={css.changeCode}
                  data-kind={change.untracked ? 'untracked' : change.staged ? 'staged' : 'unstaged'}
                >
                  {change.untracked ? '?' : change.staged ? change.code[0] : change.code[1] ?? 'M'}
                </span>
                <span className={css.changePath}>{change.path}</span>
              </button>
            ))}
          </div>
          {selected !== null && (
            <div className={css.diffBlock}>
              <div className={css.diffHead}>
                <span className={css.diffPath} title={selected}>{selected}</span>
                {diff !== null && diff.truncated && <span className={css.truncBadge}>truncated</span>}
                <button
                  type="button"
                  className={css.wrapBtn}
                  data-on={wrap ? '' : undefined}
                  onClick={() => { setWrap(value => !value) }}
                  title={wrap ? 'Disable line wrap' : 'Wrap long lines'}
                >
                  {wrap ? 'No wrap' : 'Wrap'}
                </button>
              </div>
              <pre className={wrap ? css.diffWrap : css.diffNowrap}>
                {diffLoading ? 'Loading diff…' : diff !== null && diff.text !== '' ? diff.text : 'No changes to show'}
              </pre>
            </div>
          )}
        </section>

        <section className={css.section}>
          <div className={css.sectionHead}>
            <span className={css.sectionTitle}>Commits</span>
            <span className={css.sectionCount}>{entries.length}</span>
          </div>
          <div className={css.rows}>
            {entries.length === 0 && <div className={css.none}>No commits yet</div>}
            {entries.map(entry => (
              <div key={entry.sha} className={css.commitRow} title={`${entry.sha}\n${entry.subject}\n${entry.author}`}>
                <span className={css.commitSha}>{entry.sha.slice(0, 7)}</span>
                <span className={css.commitMain}>
                  <span className={css.commitSubject}>{entry.subject}</span>
                  <span className={css.commitMeta}>{entry.author} · {ageLabel(Date.parse(entry.date) || 0, now)}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    )
  }, [load, cwd, selected, diff, diffLoading, wrap, now])

  return (
    <div className={css.container}>
      <header className={css.head}>
        <div className={css.headTop}>
          <span className={css.branchGlyph}><MicroIcon d="M4.6 5.3v5.4M4.6 8.4h3.4a1.7 1.7 0 001.7-1.7V7.2" size={12} /></span>
          <span className={css.branchNameText} title={load.phase === 'ready' ? load.status.branch : ''}>
            {load.phase === 'ready' && load.status.branch !== '' ? load.status.branch : '—'}
          </span>
          {load.phase === 'ready' && (
            <span className={css.aheadBehind}>
              <span className={load.status.ahead > 0 ? css.aheadOn : css.ahead}>↑{load.status.ahead}</span>
              <span className={load.status.behind > 0 ? css.behindOn : css.behind}>↓{load.status.behind}</span>
            </span>
          )}
          <button
            type="button"
            className={css.refreshBtn}
            onClick={refresh}
            title="Refresh git status"
            aria-label="Refresh git status"
          >
            <MicroIcon d="M13 8a5 5 0 11-1.5-3.5M13 2.5V6h-3.5" size={11} />
          </button>
        </div>
        {load.phase === 'ready' && (
          <div className={css.counts}>
            <span className={css.countChip} data-kind="staged">{load.status.staged} staged</span>
            <span className={css.countChip} data-kind="unstaged">{load.status.unstaged} unstaged</span>
            <span className={css.countChip} data-kind="untracked">{load.status.untracked} untracked</span>
            {dirtyCount === 0 && <span className={css.cleanChip}>clean</span>}
          </div>
        )}
      </header>
      {body}
    </div>
  )
}
