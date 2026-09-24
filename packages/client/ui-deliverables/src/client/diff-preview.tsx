/**
 * The served comparison as a document renderer: one changed file's turn-start
 * and turn-end text, read through the same `ChangesDiffStore` call the review
 * pane makes (`GET /api/changes.diff`, keyed by the summary's sequence and the
 * file's index), drawn in the pane with hunk headers, line numbers, word-level
 * intra-line marks, and a side-by-side toggle. The pane selects this renderer
 * whenever a file resource is opened with `{ params: { diff } }`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiffBlockLabels, DiffHunk, DiffServedFile } from '@deepseek-ai/dsh-client-ui-primitives'
import { DiffBlock, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { DocumentPreviewDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { changesDiffUrl } from '../changes.ts'
import type { ChangesDiffStore } from './changes-diff.ts'
import type { NS } from './locales.ts'
import css from './DiffPreview.module.css'

/** Implementation identity within the document registry, and the key its body registers under. */
export const CHANGES_DIFF_ID = '@deepseek-ai/dsh-client-ui-deliverables/diff'

/** The primitive's local-patch input is unused by the served comparison; one shared empty array keeps the identity stable. */
const NO_DIFFS: readonly DiffHunk[] = []

/**
 * Describe the comparison renderer: a renderer-owned view selected only by the
 * `diff` navigation request, never by filename.
 * @param title - locale-owned implementation name.
 * @returns the comparison registration metadata.
 */
export function changesDiffPreviewDefinition(title: () => string): DocumentPreviewDefinition {
  return {
    id: CHANGES_DIFF_ID,
    extensions: [],
    priority: 'editor',
    title,
    loading: 'renderer',
    capabilities: { diff: true },
  }
}

/** Summary and comparison reads supplied by the plugin. */
export interface DiffPreviewInjected {
  hooks: {
    changesDiff: ObservableSnapshot<ReturnType<ChangesDiffStore['state']['getSnapshot']>>
  }
  loadChangesDiff: ChangesDiffStore['load']
}

/** The body's composed props: the document owner share, the comparison, and copy. */
export type DiffPreviewProps = PropsRuntime<'sidebar.right.tab.document'> & InjectFace<DiffPreviewInjected>
  & PropsLocale<typeof NS>

/** The one-line fact about a comparison worth stating above its hunks, if any. */
function noteOf(diff: Extract<WorkspaceFileDiff, { kind: 'text' }>): 'diff.created' | 'diff.deleted' | 'diff.unchanged' | undefined {
  if (!diff.before) return 'diff.created'
  if (!diff.after) return 'diff.deleted'
  if (diff.hunks.length === 0) return 'diff.unchanged'
  return undefined
}

/**
 * The complete turn-end text of a comparison, reassembled from the served
 * hunks: every context and added line, in order.
 * @param diff - the served comparison.
 * @returns the new side's text, or undefined when it has no lines to copy.
 */
export function newSideText(diff: Extract<WorkspaceFileDiff, { kind: 'text' }>): string | undefined {
  if (!diff.after || diff.hunks.length === 0) return undefined
  return diff.hunks
    .flatMap(hunk => hunk.lines.filter(line => !line.startsWith('-')).map(line => line.slice(1)))
    .join('\n')
}

/**
 * The comparison's hunks in the primitive's served form: the Host's own line
 * alignment, with the file's display name as the header.
 * @param diff - the served comparison.
 * @returns the served files the block draws.
 */
function servedOf(diff: Extract<WorkspaceFileDiff, { kind: 'text' }>): readonly DiffServedFile[] {
  return [{
    path: diff.display,
    hunks: diff.hunks.map(hunk => ({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines: hunk.lines })),
  }]
}

/**
 * The comparison type's body, registered under `sidebar.right.tab.document`
 * as {@link CHANGES_DIFF_ID}.
 * @param props - composed slot props.
 * @returns the comparison with its actions, or the state that stands in for it.
 */
export function DiffPreview({
  content, useTabInfo, useChangesDiff, loadChangesDiff, t,
}: DiffPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const address = useMemo(() => parseFileAddress(tab.contentId), [tab.contentId])
  const params = tab.navigation.params
  const requested = params !== undefined && 'diff' in params ? params.diff : undefined
  const sessionId = address?.scope === 'session' ? address.sessionId as SessionId : undefined
  const state = useChangesDiff(value => sessionId === undefined || requested === undefined
    ? undefined
    : value[changesDiffUrl(sessionId, requested.seq, requested.index)])
  // The split view is an opt-in that needs room for two columns: the pane
  // measures itself and only offers the switch above 720px, falling back to
  // the unified view when a resize takes that room away.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [wide, setWide] = useState(false)
  const [splitRequested, setSplitRequested] = useState(false)
  const split = wide && splitRequested
  const [flash, setFlash] = useState<'copied' | 'failed' | null>(null)
  useEffect(() => {
    const node = rootRef.current
    if (node === null) return undefined
    const measure = (): void => { setWide(node.clientWidth > 720) }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [])
  useEffect(() => {
    if (flash === null) return undefined
    const timer = window.setTimeout(() => { setFlash(null) }, 2000)
    return () => { window.clearTimeout(timer) }
  }, [flash])
  useEffect(() => {
    if (sessionId === undefined || requested === undefined) return
    if (state !== undefined && state !== 'error') return
    void loadChangesDiff(sessionId, requested.seq, requested.index)
  }, [state, sessionId, requested?.seq, requested?.index, loadChangesDiff])
  // The pane draws this body only while its content channel exists; reporting
  // the settled read is what ends the pane's loading state. The revision is
  // tracked so a reload through the shared toolbar reports once per attempt.
  const revision = content.kind === 'renderer' ? content.revision : undefined
  const settled = state !== undefined && state !== 'loading'
  const reportedRef = useRef<number | null>(null)
  useEffect(() => {
    if (content.kind !== 'renderer' || revision === undefined || !settled || reportedRef.current === revision) return
    reportedRef.current = revision
    content.loaded(String(revision))
  }, [content, revision, settled])
  const textDiff = state !== undefined && typeof state === 'object' && state.kind === 'text' ? state : undefined
  const newText = useMemo(() => textDiff === undefined ? undefined : newSideText(textDiff), [textDiff])
  const copyNew = useCallback(() => {
    if (newText === undefined) return
    void writeClipboard(newText).then(
      (ok) => { setFlash(ok ? 'copied' : 'failed') },
      () => { setFlash('failed') },
    )
  }, [newText])
  const showPlain = useCallback(() => {
    // Clearing the navigation parameters is the whole exit: the pane falls
    // back to the display type the file remembers.
    tab.actions.openResource(tab.contentId, { params: {} })
  }, [tab.actions, tab.contentId])
  const labels = useMemo((): DiffBlockLabels => ({
    copy: t('diffView.copyDiff'),
    copied: t('diffView.copied'),
    collapseAria: t('diffView.collapseAria'),
    expandAria: hidden => t('diffView.expandAria', { count: String(hidden) }),
    collapse: t('diffView.collapse'),
    expand: hidden => t('diffView.expand', { count: String(hidden) }),
    files: count => t('diffView.files', { count: String(count) }),
  }), [t])

  if (sessionId === undefined || requested === undefined) {
    return <p className={css.status} data-document-diff="unaddressed">{t('diffView.noRequest')}</p>
  }
  const note = textDiff === undefined ? undefined : noteOf(textDiff)
  return (
    <div ref={rootRef} className={css.root} data-document-diff="" data-document-diff-view={split ? 'split' : 'unified'}>
      <div className={css.actions} data-diff-actions>
        {wide && (
          <button type="button" className={css.action} aria-pressed={split}
            data-diff-action="view" onClick={() => { setSplitRequested(value => !value) }}>
            {t(split ? 'review.unified' : 'review.split')}
          </button>
        )}
        {newText !== undefined && (
          <button type="button" className={css.action} data-diff-action="copy-new" onClick={copyNew}>
            {t(flash === 'copied' ? 'diffView.copied' : flash === 'failed' ? 'diffView.copyFailed' : 'diffView.copyNew')}
          </button>
        )}
        <button type="button" className={css.action} data-diff-action="plain" onClick={showPlain}>
          {t('diffView.plain')}
        </button>
      </div>
      <div className={css.scroll} data-document-diff-scroll>
        {!settled && <p className={css.status} role="status">{t('diff.loading')}</p>}
        {state === 'missing' && <p className={css.status}>{t('diff.missing')}</p>}
        {state === 'error' && (
          <div className={css.status}>
            <span>{t('diff.error')}</span>
            <button type="button" className={css.action} data-diff-action="retry"
              onClick={() => { void loadChangesDiff(sessionId, requested.seq, requested.index) }}>
              {t('presented.retry')}
            </button>
          </div>
        )}
        {textDiff !== undefined && (
          <>
            {note !== undefined && <p className={css.note} data-diff-note={note}>{t(note)}</p>}
            {textDiff.coarse && <p className={css.note} data-diff-coarse>{t('diff.coarse')}</p>}
            <DiffBlock diffs={NO_DIFFS} served={servedOf(textDiff)} wordLevel
              view={split ? 'split' : 'unified'} maxLines={Infinity} labels={labels} className={css.block} />
          </>
        )}
        {typeof state === 'object' && state.kind === 'binary' && <p className={css.status}>{t('diff.binary')}</p>}
        {typeof state === 'object' && state.kind === 'oversized' && <p className={css.status}>{t('diff.oversized')}</p>}
      </div>
    </div>
  )
}
