/**
 * The editable workbench body: a file's content as a CodeMirror editor with
 * optimistic saves and no-data-loss external-change handling.
 *
 * The body owns no file state of its own — content, the disk baseline, the
 * dirty buffer, and the view choices live in this type's store, bucketed by tab
 * id, so switching tabs and coming back keeps unsaved edits. I/O goes through
 * the injected {@link EditorFsOps}: one read on first mount, a 1500 ms
 * `fs.stat` poll while the tab is visible and addressed, a save that carries
 * the digest last read from disk, and a reload that never silently clobbers a
 * dirty buffer. The async decisions themselves live in `machine.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CodeBlock,
  IconCheckOutline16,
  IconRefreshOutline16,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { EditorStore } from './store.ts'
import type { EditorFsOps } from './fsops.ts'
import type { EditorLoadOutcome } from './machine.ts'
import { completeSave, loadOnce, pollOnce, saveOnce } from './machine.ts'
import { CodeMirrorEditor } from './CodeMirrorEditor.tsx'
import type { CodeMirrorHandle } from './CodeMirrorEditor.tsx'
import { IconWrap16 } from './icons.tsx'
import { languageIdForPath } from './languages.ts'
import css from './EditorBody.module.css'

/** How often the visible, addressed tab stats its file for external changes. */
export const POLL_INTERVAL_MS = 1500

/** The body's injected business face: the file operations over `/sidebar/fsops`. */
export interface EditorInjected {
  /** Read, write, and stat the addressed file. */
  readonly fs: EditorFsOps
}

/** The body's composed props: the tab, this type's store, the fsops face, and copy. */
export type EditorBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<EditorStore>
  & InjectFace<EditorInjected>
  & PropsLocale<'enpoiEditor'>

/** Reload options: `discard` replaces a dirty buffer instead of preserving it. */
interface ReloadOptions {
  readonly discard?: boolean
}

/**
 * The editor type's body, registered under `sidebar.right.pane.tab` as
 * `enpoi-editor`.
 * @param props - composed slot props.
 * @returns the toolbar, banners, and the editor/preview/missing surface.
 */
export function EditorBody({ useTabInfo, useStore, actions, fs, t }: EditorBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const file = useMemo(() => parseFileAddress(tab.contentId), [tab.contentId])
  const sessionId = file?.scope === 'session' ? file.sessionId : ''
  const path = file?.path ?? ''
  const state = useStore(s => s.byTab[tab.id])
  const stateRef = useRef(state)
  stateRef.current = state
  const editorRef = useRef<CodeMirrorHandle | null>(null)
  // The body's own box: the file opens in the column's editor pane, where the
  // framework's tab-visibility flag reads false (that flag tracks the panel's
  // active page), so on-screen state is decided from the element itself.
  const hostRef = useRef<HTMLDivElement | null>(null)
  const saveRef = useRef<(force: boolean) => void>(() => {})
  /** A reload waiting for the discard confirmation. */
  const [confirming, setConfirming] = useState(false)
  // Reading the signal through a call keeps later awaits from being narrowed
  // away by the compiler: `aborted` really can flip while a request is in flight.
  const aborted = (): boolean => tab.signal.aborted

  // The bucket lives as long as its tab record: the owner aborts the signal
  // when the record disappears, and nothing of a dead tab stays behind.
  useEffect(() => {
    const { signal } = tab
    const forget = (): void => { actions.forget(tab.id) }
    signal.addEventListener('abort', forget)
    return () => { signal.removeEventListener('abort', forget) }
  }, [actions, tab.id, tab.signal])

  /**
   * Fold one read outcome into the store: a dirty buffer is adopted around, not
   * overwritten, unless the caller asked to discard it.
   */
  const applyLoad = useCallback((outcome: EditorLoadOutcome, options?: ReloadOptions): void => {
    if (outcome.kind === 'loaded') {
      const current = stateRef.current
      const keep = options?.discard !== true && current !== undefined
        && (current.dirty || current.draft !== null)
      if (keep) actions.adopted(tab.id, outcome.snapshot)
      else actions.synced(tab.id, outcome.snapshot)
      return
    }
    if (outcome.kind === 'missing') {
      actions.missing(tab.id)
      return
    }
    actions.failed(tab.id, outcome.message)
  }, [actions, tab.id])

  /** Re-read the file from disk. */
  const reload = useCallback((options?: ReloadOptions): void => {
    if (sessionId === '' || path === '') return
    actions.loading(tab.id)
    void loadOnce(fs, sessionId, path, tab.signal).then((outcome) => {
      if (aborted()) return
      applyLoad(outcome, options)
    })
  }, [actions, applyLoad, fs, path, sessionId, tab.id, tab.signal])

  // First mount reads; a remount with stored state (tab switched away and back)
  // keeps that state instead of re-reading.
  useEffect(() => {
    const current = stateRef.current
    if (current !== undefined && current.status !== 'idle') return
    reload()
  }, [reload])

  const status = state?.status ?? 'idle'
  const ready = status === 'ready'
  const missing = status === 'missing'

  // The external-change watcher: 1500 ms while the tab is visible and addressed.
  // A missing file is probed for reappearance; a dirty or truncated buffer only
  // ever raises the banner.
  useEffect(() => {
    if ((status !== 'ready' && status !== 'missing') || sessionId === '' || path === '') return undefined
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return
      const host = hostRef.current
      if (host === null) return
      const rect = host.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const current = stateRef.current
      if (current === undefined) return
      if (current.status === 'missing') {
        void loadOnce(fs, sessionId, path, tab.signal).then((outcome) => {
          if (aborted() || outcome.kind !== 'loaded') return
          applyLoad(outcome)
        })
        return
      }
      void pollOnce({
        fs,
        sessionId,
        path,
        baseline: current.sha256 === null ? undefined : { mtimeMs: current.mtimeMs, size: current.size },
        dirty: current.dirty,
        truncated: current.truncated,
        revision: current.revision,
        currentRevision: () => stateRef.current?.revision ?? current.revision,
        signal: tab.signal,
      }).then((outcome) => {
        if (aborted()) return
        switch (outcome.kind) {
          case 'unchanged':
          case 'failed':
            return
          case 'missing':
            actions.missing(tab.id)
            return
          case 'banner':
            actions.changed(tab.id)
            return
          case 'swap':
            // The poll already proved the buffer clean and unchanged since the
            // read began; apply the swap to the view before recording it.
            editorRef.current?.setDoc(outcome.snapshot.content)
            actions.synced(tab.id, outcome.snapshot)
            return
        }
      })
    }
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [actions, applyLoad, fs, path, sessionId, status, tab.id, tab.signal])

  /** Save the buffer; `force` retries past the digest check (Overwrite). */
  const save = useCallback((force: boolean): void => {
    const current = stateRef.current
    if (current === undefined || current.status !== 'ready' || current.truncated) return
    if (sessionId === '' || path === '') return
    const content = editorRef.current?.getDoc() ?? current.draft ?? current.content
    if (!current.dirty && content === current.content) return
    actions.saving(tab.id)
    void (async (): Promise<void> => {
      const outcome = await saveOnce({
        fs,
        sessionId,
        path,
        content,
        // The digest of what was last READ from disk — never the edited buffer.
        expectedSha: current.sha256 ?? undefined,
        force,
        signal: tab.signal,
      })
      if (aborted()) return
      if (outcome.kind === 'saved') {
        const baseline = await completeSave(fs, sessionId, path, content, outcome, tab.signal)
        if (aborted()) return
        actions.saved(tab.id, content, baseline)
        return
      }
      if (outcome.kind === 'conflict') {
        actions.conflicted(tab.id)
        return
      }
      actions.saveFailed(tab.id, outcome.message)
    })()
  }, [actions, fs, path, sessionId, tab.id, tab.signal])
  saveRef.current = save

  // The view follows the store: an external swap, a reload, or a restored
  // draft replaces the document in place; a keystroke already matches.
  const docText = status === 'ready' ? (state?.draft ?? state?.content ?? '') : null
  useEffect(() => {
    if (docText !== null) editorRef.current?.setDoc(docText)
  }, [docText])

  const wrap = state?.wrap ?? true
  const truncated = state?.truncated ?? false
  const dirty = state?.dirty ?? false
  const banner = state?.banner ?? null
  const saveState = state?.saveState ?? 'idle'
  const mode = state?.mode ?? 'edit'
  useEffect(() => { editorRef.current?.setWrap(wrap) }, [wrap])
  useEffect(() => { editorRef.current?.setReadOnly(truncated) }, [truncated])
  useEffect(() => { setConfirming(false) }, [banner])

  // canOpen refuses anything but a session-scoped file address; this is the
  // wiring-error backstop, not a user state.
  if (file === undefined || file.scope !== 'session') return null

  const previewText = state?.draft ?? state?.content ?? ''
  const languageId = languageIdForPath(path)
  const reloadWithConfirm = (): void => {
    if (dirty) setConfirming(true)
    else reload()
  }

  return (
    <div ref={hostRef} className={css.root} data-enpoi-editor data-enpoi-editor-tab={tab.id}>
      <div className={css.toolbar} data-enpoi-editor-toolbar>
        {ready && !truncated && (
          <div className={css.modeToggle} role="group">
            <button
              type="button"
              className={clsx(css.modeButton, mode === 'edit' && css.modeActive)}
              aria-pressed={mode === 'edit'}
              data-enpoi-editor-mode="edit"
              onClick={() => { actions.setMode(tab.id, 'edit') }}
            >
              {t('edit')}
            </button>
            <button
              type="button"
              className={clsx(css.modeButton, mode === 'preview' && css.modeActive)}
              aria-pressed={mode === 'preview'}
              data-enpoi-editor-mode="preview"
              onClick={() => { actions.setMode(tab.id, 'preview') }}
            >
              {t('preview')}
            </button>
          </div>
        )}
        {dirty && <span className={css.dirtyDot} title={t('dirty')} data-enpoi-editor-dirty />}
        {ready && !truncated && (
          <button
            type="button"
            className={css.tool}
            disabled={!dirty || saveState === 'saving'}
            aria-label={t('save')}
            title={t('save')}
            data-enpoi-editor-save
            onClick={() => { saveRef.current(false) }}
          >
            <IconCheckOutline16 size={14} />
          </button>
        )}
        {(ready || missing || status === 'error') && (
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            title={t('reload')}
            data-enpoi-editor-reload
            onClick={reloadWithConfirm}
          >
            <IconRefreshOutline16 size={14} />
          </button>
        )}
        {ready && (
          <button
            type="button"
            className={clsx(css.tool, wrap && css.toolActive)}
            aria-pressed={wrap}
            aria-label={t('wrapAria')}
            title={wrap ? t('wrapDisable') : t('wrapEnable')}
            data-enpoi-editor-wrap
            onClick={() => { actions.toggledWrap(tab.id) }}
          >
            <IconWrap16 wrapped={wrap} />
          </button>
        )}
        {saveState === 'saving' && <span className={css.status}>{t('saving')}</span>}
        {saveState === 'saved' && <span className={css.status} data-enpoi-editor-saved>{t('saved')}</span>}
        {saveState === 'failed' && (
          <span className={clsx(css.status, css.statusError)} data-enpoi-editor-save-failed>{t('saveFailed')}</span>
        )}
      </div>
      {confirming && (
        <div className={css.banner} role="alert" data-enpoi-editor-banner="confirm">
          <span className={css.bannerText}>{t('externalConfirm')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-discard
              onClick={() => { setConfirming(false); reload({ discard: true }) }}
            >
              {t('discardReload')}
            </button>
            <button type="button" className={css.bannerButton} onClick={() => { setConfirming(false) }}>
              {t('keepEditing')}
            </button>
          </span>
        </div>
      )}
      {banner === 'external-change' && (
        <div className={css.banner} role="status" data-enpoi-editor-banner="external-change">
          <span className={css.bannerText}>{t('externalChanged')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-reload-now
              onClick={() => { setConfirming(true) }}
            >
              {t('reload')}
            </button>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-dismiss
              onClick={() => { setConfirming(false); actions.dismissed(tab.id) }}
            >
              {t('dismiss')}
            </button>
          </span>
        </div>
      )}
      {banner === 'conflict' && (
        <div className={css.banner} role="alert" data-enpoi-editor-banner="conflict">
          <span className={css.bannerText}>{t('conflict')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-overwrite
              onClick={() => { saveRef.current(true) }}
            >
              {t('overwrite')}
            </button>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-reload-now
              onClick={() => { setConfirming(true) }}
            >
              {t('reload')}
            </button>
          </span>
        </div>
      )}
      {ready && truncated && <div className={css.notice} data-enpoi-editor-truncated>{t('truncated')}</div>}
      {ready && mode === 'edit' && (
        <CodeMirrorEditor
          ref={editorRef}
          path={path}
          initialDoc={docText ?? ''}
          wrap={wrap}
          readOnly={truncated}
          onChange={(text) => { actions.edited(tab.id, text) }}
          onSave={() => { saveRef.current(false) }}
        />
      )}
      {ready && mode === 'preview' && (
        <div className={css.preview} data-enpoi-editor-preview>
          {languageId === 'markdown'
            ? (
              <MarkdownText
                text={previewText}
                labels={{
                  code: { copyLabel: t('copy'), copiedLabel: t('copied') },
                  footnotes: t('markdown.footnotes'),
                }}
              />
            )
            : <CodeBlock code={previewText} lang={languageId} copyLabel={t('copy')} copiedLabel={t('copied')} />}
        </div>
      )}
      {(status === 'idle' || status === 'loading') && (
        <div className={css.center} data-enpoi-editor-loading>{t('loading')}</div>
      )}
      {missing && (
        <div className={css.center} data-enpoi-editor-missing>
          <p className={css.centerTitle}>{t('notFound')}</p>
          <p className={css.centerDetail}>{t('notFoundDetail')}</p>
          <p className={css.centerPath}>{file.path}</p>
          {(state?.draft ?? null) !== null && (
            <p className={css.centerBuffer} data-enpoi-editor-buffer-kept>{t('bufferKept')}</p>
          )}
          <button type="button" className={css.primary} onClick={reloadWithConfirm}>{t('reload')}</button>
        </div>
      )}
      {status === 'error' && (
        <div className={css.center} data-enpoi-editor-error>
          <p className={css.centerDetail}>{t('loadFailed', { message: state?.error ?? '' })}</p>
          <button type="button" className={css.primary} onClick={reloadWithConfirm}>{t('retry')}</button>
        </div>
      )}
    </div>
  )
}
