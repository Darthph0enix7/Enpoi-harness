/**
 * The editable workbench surface: a file's content as a CodeMirror editor with
 * auto-save, optimistic saves, and no-data-loss external-change handling.
 *
 * The surface is the in-pane document renderer (`sidebar.right.tab.document`,
 * keyed `enpoi-editor`): the document owner supplies the content channel, wrap
 * preference, scrollport, and command bridge. Content, the disk baseline, the
 * dirty buffer, and the reader's place live in this type's store bucketed by
 * the canonical file address, so switching tabs or display types and coming
 * back keeps unsaved edits, and two tabs of one file share one buffer instead
 * of racing each other's writes. I/O goes through the injected
 * {@link EditorFsOps}: one read on first mount, a 1500 ms `fs.stat` poll while
 * the tab is visible and addressed (suppressed while a save is in flight), a
 * debounced auto-save (default on, one I/O retry, halted by a conflict), and a
 * conflict flow whose three actions — Overwrite disk, Discard mine, Save mine
 * beside — never silently overwrite either side. The async decisions live in
 * `machine.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { EditorStore, EditorViewState } from './store.ts'
import type { EditorFsOps } from './fsops.ts'
import type { EditorLoadOutcome } from './machine.ts'
import { completeSave, loadOnce, pollOnce, saveBesideOnce, saveOnce } from './machine.ts'
import { CodeMirrorEditor } from './CodeMirrorEditor.tsx'
import type { CodeMirrorHandle } from './CodeMirrorEditor.tsx'
import { readAutosavePref } from './prefs.ts'
import { EditorFindBar } from './EditorFindBar.tsx'
import css from './EditorBody.module.css'

/** How often the visible, addressed tab stats its file for external changes. */
export const POLL_INTERVAL_MS = 1500

/** How long after the last keystroke an auto-save writes. */
export const AUTOSAVE_DEBOUNCE_MS = 800

/** How long an auto-save waits before its single I/O retry. */
export const AUTOSAVE_RETRY_MS = 3000

/** The body's injected business face: the file operations over `/sidebar/fsops`. */
export interface EditorInjected {
  /** Read, write, and stat the addressed file. */
  readonly fs: EditorFsOps
}

/** The body's composed props: the document owner's shares, the store, face, and copy. */
export type EditorBodyProps =
  & DocumentPreviewProps
  & PropsStore<EditorStore>
  & InjectFace<EditorInjected>
  & PropsLocale<'enpoiEditor'>

/** Reload options: `discard` replaces a dirty buffer instead of preserving it. */
interface ReloadOptions {
  readonly discard?: boolean
}

/** Which confirmation row is open above the editor. */
type Confirm = 'overwrite' | 'discard' | 'reload' | null

/**
 * The editor's body for the keyed document slot, registered as `enpoi-editor`.
 * @param props - composed document-body props.
 * @returns the shared editable surface.
 */
export function EditorBody({
  content, wrap, scrollportRef, commandsRef, useTabInfo, useStore, actions, fs, t,
}: EditorBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const file = useMemo(() => parseFileAddress(tab.contentId), [tab.contentId])
  const sessionId = file?.scope === 'session' ? file.sessionId : ''
  const path = file?.path ?? ''
  // One bucket per canonical file address, held by every tab record of the
  // file: the buffer, baseline, and conflict state are the file's, not the tab's.
  const key = tab.contentId
  const state = useStore(s => s.byAddress[key])
  const stateRef = useRef(state)
  stateRef.current = state
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const editorRef = useRef<CodeMirrorHandle | null>(null)
  // The surface's own box: the file opens in the column's editor pane, where the
  // framework's tab-visibility flag reads false (that flag tracks the panel's
  // active page), so on-screen state is decided from the element itself.
  const hostRef = useRef<HTMLDivElement | null>(null)
  const saveRef = useRef<(force: boolean, auto: boolean) => void>(() => {})
  const contentRef = useRef(content)
  contentRef.current = content
  // The reader's live place, streamed by the editor and persisted to the store
  // when the body unmounts, so a display-type switch restores it.
  const viewRef = useRef<EditorViewState | null>(null)
  if (viewRef.current === null) viewRef.current = state?.view ?? { anchor: 0, head: 0, scrollTop: 0 }
  const retryTimerRef = useRef<number | undefined>(undefined)
  /** The last `saveRequests` value this body already honoured. */
  const handledSaveRequestsRef = useRef<number | null>(null)
  if (handledSaveRequestsRef.current === null) handledSaveRequestsRef.current = state?.saveRequests ?? 0
  // The auto-save I/O retry budget, one per editing stretch. Kept in a ref and
  // spent at the failure site, so the decision never reads a render-stale count.
  const retryBudgetRef = useRef(1)
  /** The confirmation row currently open, if any. */
  const [confirm, setConfirm] = useState<Confirm>(null)
  /** Whether the themed find bar is open over the editing surface. */
  const [findOpen, setFindOpen] = useState(false)
  // Reading the signal through a call keeps later awaits from being narrowed
  // away by the compiler: `aborted` really can flip while a request is in flight.
  const aborted = (): boolean => tab.signal.aborted
  const bindRoot = useCallback((node: HTMLDivElement | null): void => {
    hostRef.current = node
    scrollportRef?.(node)
  }, [scrollportRef])
  const handleViewState = useCallback((view: EditorViewState): void => {
    viewRef.current = view
  }, [])

  // Hold the bucket for this tab record and release it when the record ends.
  // Detaching rides the abort signal alone — a body unmount (a display-type
  // switch, a hidden tab) must keep the bucket or it would drop unsaved edits.
  useEffect(() => {
    actions.attach(key, tab.id)
    const { signal } = tab
    const detach = (): void => { actions.detach(key, tab.id) }
    if (signal.aborted) {
      detach()
      return undefined
    }
    signal.addEventListener('abort', detach, { once: true })
    return () => { signal.removeEventListener('abort', detach) }
  }, [actions, key, tab.id, tab.signal])

  // Persist the reader's place when this body goes away; the editor has long
  // since streamed every move into `viewRef`, so the store takes its last value.
  useEffect(() => () => {
    if (stateRef.current?.status === 'ready') {
      actionsRef.current.viewChanged(key, viewRef.current ?? { anchor: 0, head: 0, scrollTop: 0 })
    }
  }, [key])

  // A pending I/O retry must not fire into a gone tab.
  useEffect(() => () => { window.clearTimeout(retryTimerRef.current) }, [])

  /**
   * Fold one read outcome into the store: a dirty buffer is adopted around, not
   * overwritten, unless the caller asked to discard it.
   */
  const applyLoad = useCallback((outcome: EditorLoadOutcome, options?: ReloadOptions): void => {
    if (outcome.kind === 'loaded') {
      const current = stateRef.current
      const keep = options?.discard !== true && current !== undefined
        && (current.dirty || current.draft !== null)
      if (keep) actions.adopted(key, outcome.snapshot)
      else actions.synced(key, outcome.snapshot)
      const channel = contentRef.current
      if (channel?.kind === 'renderer') channel.loaded(outcome.snapshot.sha256)
      return
    }
    if (outcome.kind === 'missing') {
      actions.missing(key)
      return
    }
    actions.failed(key, outcome.message)
  }, [actions, key])

  /** Re-read the file from disk. */
  const reload = useCallback((options?: ReloadOptions): void => {
    if (sessionId === '' || path === '') return
    actions.loading(key)
    void loadOnce(fs, sessionId, path, tab.signal).then((outcome) => {
      if (aborted()) return
      applyLoad(outcome, options)
    })
  }, [actions, applyLoad, fs, key, path, sessionId, tab.signal])

  // First mount reads; a remount with stored state (tab switched away and back,
  // or display type switched away and back) keeps that state instead of re-reading.
  useEffect(() => {
    const current = stateRef.current
    if (current !== undefined && current.status !== 'idle') return
    reload()
  }, [reload])

  const status = state?.status ?? 'idle'
  const ready = status === 'ready'
  const missing = status === 'missing'

  // The owner's reload channel: a bumped revision means the document owner asked
  // for a fresh read, so a dirty buffer confirms first and a clean one reloads.
  const revisionRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (content?.kind !== 'renderer') return
    const previous = revisionRef.current
    revisionRef.current = content.revision
    if (previous === undefined || previous === content.revision) return
    if (stateRef.current?.dirty ?? false) setConfirm('reload')
    else reload()
  }, [content, reload])

  // The external-change watcher: 1500 ms while the tab is visible and addressed.
  // Suppressed while a save is in flight — the poll would otherwise raise a
  // conflict against the reader's own write. A missing file is probed for
  // reappearance; a dirty or truncated buffer only ever raises the conflict.
  useEffect(() => {
    if ((status !== 'ready' && status !== 'missing') || sessionId === '' || path === '') return undefined
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return
      const host = hostRef.current
      if (host === null) return
      const rect = host.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const current = stateRef.current
      if (current === undefined || current.saveState === 'saving') return
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
            actions.missing(key)
            return
          case 'banner':
            actions.conflicted(key)
            return
          case 'swap':
            // The poll already proved the buffer clean and unchanged since the
            // read began; apply the swap to the view before recording it. The
            // editor maps the cursor through the replacement, so it stays put.
            editorRef.current?.setDoc(outcome.snapshot.content)
            actions.synced(key, outcome.snapshot)
            return
        }
      })
    }
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [actions, applyLoad, fs, key, path, sessionId, status, tab.id, tab.signal])

  /**
   * Save the buffer. `force` writes past the digest check (the conflict flow's
   * Overwrite disk). `auto` marks the debounced auto-save: it keeps the retry
   * budget, retries one I/O failure after a pause, and never retries a 409.
   */
  const save = useCallback((force: boolean, auto: boolean): void => {
    const current = stateRef.current
    if (current === undefined || current.status !== 'ready' || current.truncated) return
    if (sessionId === '' || path === '') return
    const written = editorRef.current?.getDoc() ?? current.draft ?? current.content
    if (!current.dirty && written === current.content) return
    if (!auto) retryBudgetRef.current = 1
    actions.saving(key)
    void (async (): Promise<void> => {
      const outcome = await saveOnce({
        fs,
        sessionId,
        path,
        content: written,
        // The digest of what was last READ from disk — never the edited buffer.
        expectedSha: current.sha256 ?? undefined,
        force,
        signal: tab.signal,
      })
      if (aborted()) return
      if (outcome.kind === 'saved') {
        const baseline = await completeSave(fs, sessionId, path, written, outcome, tab.signal)
        if (aborted()) return
        // Text typed during the round-trip stays dirty; clearing the draft here
        // would silently drop the keystrokes the write did not carry.
        const liveDoc = editorRef.current !== null ? editorRef.current.getDoc() : stateRef.current?.draft ?? undefined
        retryBudgetRef.current = 1
        actions.saved(key, written, baseline, liveDoc)
        const channel = contentRef.current
        if (channel?.kind === 'renderer') channel.loaded(baseline.sha256 ?? '')
        return
      }
      if (outcome.kind === 'conflict') {
        // Halt auto-save: the conflict flow takes over, with no retry.
        actions.conflicted(key)
        return
      }
      actions.saveFailed(key, outcome.message)
      if (auto && retryBudgetRef.current > 0) {
        retryBudgetRef.current -= 1
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = window.setTimeout(() => { saveRef.current(false, true) }, AUTOSAVE_RETRY_MS)
      }
    })()
  }, [actions, fs, key, path, sessionId, tab.signal])
  saveRef.current = save

  /**
   * Write the dirty buffer to `<file>.mine-<timestamp>` (create-only), then
   * load the disk version: "Save mine beside", and the safe exit of a discard.
   */
  const saveBesideThenReload = useCallback((): void => {
    const current = stateRef.current
    if (current === undefined || current.status !== 'ready') return
    const buffer = editorRef.current?.getDoc() ?? current.draft ?? current.content
    actions.saving(key)
    void saveBesideOnce({ fs, sessionId, path, content: buffer, signal: tab.signal }).then((outcome) => {
      if (aborted()) return
      if (outcome.kind === 'saved') {
        const channel = contentRef.current
        if (channel?.kind === 'renderer') channel.loaded(outcome.sha256 ?? '')
        reload({ discard: true })
        return
      }
      actions.saveFailed(key, outcome.kind === 'exists' ? t('besideTaken') : outcome.message)
    })
  }, [actions, fs, key, path, sessionId, t, tab.signal, reload])

  /** The conflict flow's Overwrite disk: force the buffer through, then resume. */
  const overwriteDisk = useCallback((): void => {
    setConfirm(null)
    saveRef.current(true, false)
  }, [])

  /** Discard the dirty buffer, optionally keeping a beside-copy first. */
  const discardMine = useCallback((saveCopy: boolean): void => {
    setConfirm(null)
    if (saveCopy) saveBesideThenReload()
    else reload({ discard: true })
  }, [reload, saveBesideThenReload])


  // Auto-save: debounce from the last keystroke while the tab is editable,
  // clean of conflicts, and not already saving or within its retry pause. A
  // save that completes with newer keystrokes in the buffer keeps it dirty, so
  // this effect re-arms and the next round carries them.
  const dirty = state?.dirty ?? false
  const truncated = state?.truncated ?? false
  const banner = state?.banner ?? null
  const saveState = state?.saveState ?? 'idle'
  const autoSave = state?.autoSave ?? true

  // Seed the persisted auto-save choice once the bucket exists; the shared
  // toolbar toggle reads and writes the same field.
  useEffect(() => {
    if (state?.autoSave !== null && state?.autoSave !== undefined) return
    actions.autoSaveSet(key, readAutosavePref())
  }, [actions, key, state?.autoSave])

  // The toolbar's save icon has no editor handle of its own; it raises a
  // request the body consumes exactly once.
  useEffect(() => {
    const requests = state?.saveRequests ?? 0
    if (requests === handledSaveRequestsRef.current) return
    handledSaveRequestsRef.current = requests
    saveRef.current(false, false)
  }, [state?.saveRequests])
  useEffect(() => {
    if (!autoSave || !ready || truncated || !dirty || banner !== null) return
    if (saveState !== 'idle' && saveState !== 'saved') return
    const timer = window.setTimeout(() => { saveRef.current(false, true) }, AUTOSAVE_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [autoSave, ready, truncated, dirty, banner, saveState])

  // The command bridge: the toolbar's Find in file and Go to line drive the
  // editor while this surface owns the content; `null` withdraws them.
  useEffect(() => {
    commandsRef?.({
      find: () => { setFindOpen(true) },
      gotoLine: (line) => { editorRef.current?.gotoLine(line) },
    })
    return () => { commandsRef?.(null) }
  }, [commandsRef])

  // The view follows the store: an external swap, a reload, or a restored
  // draft replaces the document in place; a keystroke already matches.
  const docText = ready ? (state?.draft ?? state?.content ?? '') : null
  useEffect(() => {
    if (docText !== null) editorRef.current?.setDoc(docText)
  }, [docText])

  useEffect(() => { editorRef.current?.setWrap(wrap ?? true) }, [wrap])
  useEffect(() => { editorRef.current?.setReadOnly(truncated) }, [truncated])
  useEffect(() => { setConfirm(null) }, [banner])

  // parseFileAddress refuses anything but a session-scoped file address; this is
  // the wiring-error backstop, not a user state.
  if (file === undefined || file.scope !== 'session') return null

  return (
    <div ref={bindRoot} className={css.root} data-enpoi-editor data-enpoi-editor-tab={tab.id}>
      {confirm === 'overwrite' && (
        <div className={css.banner} role="alert" data-enpoi-editor-confirm="overwrite">
          <span className={css.bannerText}>{t('overwriteConfirm')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-overwrite
              onClick={overwriteDisk}
            >
              {t('overwrite')}
            </button>
            <button type="button" className={css.bannerButton} onClick={() => { setConfirm(null) }}>
              {t('cancel')}
            </button>
          </span>
        </div>
      )}
      {(confirm === 'discard' || confirm === 'reload') && (
        <div className={css.banner} role="alert" data-enpoi-editor-confirm="discard">
          <span className={css.bannerText}>{t('discardConfirm')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.primary}
              data-enpoi-editor-save-copy-beside
              onClick={() => { discardMine(true) }}
            >
              {t('saveCopyBeside')}
            </button>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-discard
              onClick={() => { discardMine(false) }}
            >
              {t('discardReload')}
            </button>
            <button type="button" className={css.bannerButton} onClick={() => { setConfirm(null) }}>
              {t('keepEditing')}
            </button>
          </span>
        </div>
      )}
      {banner === 'conflict' && confirm === null && (
        <div className={css.banner} role="alert" data-enpoi-editor-banner="conflict">
          <span className={css.bannerText}>{t('conflict')}</span>
          <span className={css.bannerActions}>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-overwrite-ask
              onClick={() => { setConfirm('overwrite') }}
            >
              {t('overwrite')}
            </button>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-discard-ask
              onClick={() => { setConfirm('discard') }}
            >
              {t('discardMine')}
            </button>
            <button
              type="button"
              className={css.bannerButton}
              data-enpoi-editor-beside
              onClick={() => { setConfirm(null); saveBesideThenReload() }}
            >
              {t('saveBeside')}
            </button>
          </span>
        </div>
      )}
      {ready && truncated && <div className={css.notice} data-enpoi-editor-truncated>{t('truncated')}</div>}
      {ready && findOpen && (
        <EditorFindBar
          t={t}
          onQuery={(text, options) => editorRef.current?.setSearch(text, options) ?? { matches: 0, index: 0 }}
          onStep={delta => (delta === 1 ? editorRef.current?.searchNext() : editorRef.current?.searchPrevious())
            ?? { matches: 0, index: 0 }}
          onSave={() => { saveRef.current(false, false) }}
          onClose={() => {
            setFindOpen(false)
            editorRef.current?.clearSearch()
            editorRef.current?.focusEditor()
          }}
        />
      )}
      {ready && (
        <CodeMirrorEditor
          ref={editorRef}
          path={path}
          initialDoc={docText ?? ''}
          initialSelection={viewRef.current ?? undefined}
          initialScrollTop={viewRef.current?.scrollTop}
          wrap={wrap ?? true}
          readOnly={truncated}
          onViewState={handleViewState}
          onChange={(text) => {
            retryBudgetRef.current = 1
            actions.edited(key, text)
          }}
          onSave={() => { saveRef.current(false, false) }}
        />
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
          <button type="button" className={css.primary} onClick={() => {
            if (stateRef.current?.dirty ?? false) setConfirm('reload')
            else reload()
          }}>{t('reload')}</button>
        </div>
      )}
      {status === 'error' && (
        <div className={css.center} data-enpoi-editor-error>
          <p className={css.centerDetail}>{t('loadFailed', { message: state?.error ?? '' })}</p>
          <button type="button" className={css.primary} onClick={() => { reload() }}>{t('retry')}</button>
        </div>
      )}
    </div>
  )
}
