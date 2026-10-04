/**
 * The diff tab: one change opened from the git panel, like VSCode's diff
 * editor. A worktree ref loads the file's unified diff (`git diff`, staged or
 * not; untracked files — which git diff never covers — render as a full-file
 * addition from their content), a commit ref loads the commit's full patch
 * (`git.show`-style). The header carries a refresh button because the tab
 * stays mounted while the git panel's staging/discard operations change the
 * very content it shows.
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionScope } from './api.ts'
import { api } from './api.ts'
import type { SidebarDiffRef } from './state.ts'
import { DiffView } from './DiffView.tsx'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** The loaded diff surface (untracked content rendered as a full addition). */
interface DiffData {
  diff: string
  untracked?: string
}

export function DiffTab(props: { sessionId: string; cwd: string | undefined; diff: SidebarDiffRef }) {
  const { sessionId, cwd, diff } = props
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DiffData | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback((): void => { setTick(value => value + 1) }, [])

  useEffect(() => {
    let cancelled = false
    const scope: SessionScope = { sessionId, cwd }
    setLoading(true)
    setError(null)
    setData(null)
    const load = async (): Promise<void> => {
      try {
        if (diff.kind === 'commit') {
          const result: unknown = await api.gitCommitDiff(scope, diff.hashFull)
          const r = result as { diff?: string } | undefined
          if (!cancelled) setData({ diff: r?.diff ?? '' })
          return
        }
        let result: unknown = await api.gitDiff(scope, diff.path, diff.staged)
        let r = result as { diff?: string } | undefined
        if ((r?.diff ?? '') === '') {
          // The requested side is empty — try the OTHER side once: the ref
          // may predate the staged-flag fix, or the change moved sides (a
          // file staged after its tab opened). Both sides empty means the
          // file genuinely has no text changes.
          const other: unknown = await api.gitDiff(scope, diff.path, !diff.staged)
          const ro = other as { diff?: string } | undefined
          if ((ro?.diff ?? '') !== '') { result = other; r = ro }
        }
        if ((r?.diff ?? '') !== '') {
          if (!cancelled) setData({ diff: r?.diff ?? '' })
          return
        }
        // Empty diff: an untracked file (git diff never lists it) falls back
        // to a full-file addition; anything else is a genuine no-text-change.
        if (diff.untracked === true && !diff.staged) {
          const text: unknown = await api.fsRead(scope, diff.path)
          const r = text as { kind?: string; content?: string; code?: string } | undefined
          if (!cancelled) {
            const content = r?.kind === 'text' ? (r?.content ?? r?.code ?? '') : ''
            setData(r?.kind === 'text' ? { diff: '', untracked: content } : { diff: '' })
          }
          return
        }
        if (!cancelled) setData({ diff: '' })
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [sessionId, cwd, diff, tick])

  return (
    <div className={css.gitDiffTab}>
      <div className={css.gitDiffTabHeader}>
        <span className={css.gitDiffTabTitle} title={diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}>
          {diff.kind === 'worktree' ? diff.path : `${diff.hash} ${diff.subject}`}
        </span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>
      {loading && <div className={css.gitPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && <div className={css.gitError}>{t('diffLoadError')}: {error}</div>}
      {!loading && error === null && data !== null && (
        <>
          {data.untracked !== undefined
            ? <DiffView diff="" untrackedPath={diff.kind === 'worktree' ? diff.path : ''} untrackedContent={data.untracked} />
            : <DiffView diff={data.diff} />}
          {data.diff === '' && data.untracked === undefined && (
            <div className={css.gitEmpty}>{t('diffEmpty')}</div>
          )}
        </>
      )}
    </div>
  )
}
