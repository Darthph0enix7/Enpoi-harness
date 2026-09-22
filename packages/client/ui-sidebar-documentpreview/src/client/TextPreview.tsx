/**
 * The text preview's body: a file's content, or the reason it is not showing.
 *
 * Two sources meet here. The standard `useResource` hook gives the file's
 * metadata — its version — and this type's
 * own store holds the content it read through its face. A Host-reported change is
 * announced, not applied: reloading under a reader would lose their place, so
 * the bar waits for a click. A failed metadata frame — the file gone, its
 * workspace unknown — takes the same bar's place over the pages already loaded,
 * with the same reload. The type's controls sit at the end of
 * the path row: the display-type menu, the in-place Edit switch into the
 * editing renderer, the quick actions (download, copy path, copy content, go
 * to line, find in file), wrap and reload; the Sidebar's strip carries none of them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconCopyOutline16, IconDownloadOutline16, IconEditOutline16, IconLinkOutline16,
  IconListPenOutline16, IconRefreshOutline16, IconSearchOutline16, Menu, Tooltip, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { TextInjected } from './face.ts'
import { failureLine } from './failure-line.ts'
import { IconNowrapFill16, IconWrapFill16 } from './icons.tsx'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import { hostFileOf } from './rpc.ts'
import type { TextStore } from './store.ts'
import type { DocumentContent, DocumentRendererCommands } from './document/contract.ts'
import { binaryDocumentPath, matchingDocumentPreviews } from './document/registry.ts'
import type { DocumentPreviewDefinition } from './document/registry.ts'
import { unviewableBinaryPath } from './document/unviewable.ts'
import {
  extensionOf, readViewerPrefs, rememberViewerByExtension,
} from './document/viewer-prefs.ts'
import { PLAIN_BODY_ID } from './text/index.ts'
import { findLineOf, loadedPages, lastLineLoaded, scrollToLine, visibleTopLine } from './text/lines.ts'
import { copyPlainText, downloadSessionFile } from './quick-actions.ts'
import css from './TextPreview.module.css'

export { linesOf, loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
export type { LoadedPage } from './text/lines.ts'

/** Keep the path fade in sync with whether its full text fits the header row. */
function usePathClipped(
  box: RefObject<HTMLDivElement | null>,
  text: RefObject<HTMLSpanElement | null>,
  path: string,
  shown: boolean,
): void {
  useLayoutEffect(() => {
    const outer = box.current
    const inner = text.current
    if (outer === null || inner === null) return undefined
    const apply = (): void => {
      if (inner.offsetWidth > outer.clientWidth) outer.dataset.textpreviewPathClipped = ''
      else delete outer.dataset.textpreviewPathClipped
    }
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply)
    observer?.observe(outer)
    observer?.observe(inner)
    return () => { observer?.disconnect() }
  }, [box, text, path, shown])
}

/** The header's path: directories greyed, the final segment in full ink, faded when clipped. */
function HeaderPath({ pathRef, pathTextRef, path }: {
  pathRef: RefObject<HTMLDivElement>
  pathTextRef: RefObject<HTMLSpanElement>
  path: string
}): ReactNode {
  const { directory, name } = pathPartsOf(path)
  return (
    <div ref={pathRef} className={css.path} title={path} data-textpreview-path>
      <span ref={pathTextRef} className={css.pathText}>
        {directory !== '' && <span className={css.pathDirectory}>{directory}</span>}
        <span className={css.pathName}>{name}</span>
      </span>
    </div>
  )
}

/** Private registration inputs; the framework binds the registry source to useDocumentPreviews. */
export interface TextPreviewInjected extends TextInjected {
  readonly hooks: { readonly documentPreviews: ObservableSnapshot<readonly DocumentPreviewDefinition[]> }
  /**
   * Read one file's complete text through the Host endpoint, for the copy
   * action on a renderer-owned view whose bytes the toolbar never holds.
   * @param file - the session and workspace path the tab's address names.
   * @returns the file's UTF-8 text.
   * @throws when the read fails; the toolbar shows the copy failure.
   */
  readonly readAllText: (file: { readonly sessionId: string; readonly path: string }) => Promise<string>
}

/** The body's composed props: the tab, its navigation, the shared store and face, and copy. */
export type TextPreviewProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.document'>
  & PropsStore<TextStore>
  & InjectFace<TextPreviewInjected>
  & PropsLocale<'sidebarDocumentPreview'>

/**
 * The text type's body, registered under `sidebar.right.pane.tab` as `text`.
 * @param props - composed slot props.
 * @returns the content read so far with its controls, or a progress line.
 */
export function TextPreview({
  useTabInfo, useResource, useStore, actions, loadPage, reloadPages,
  loadAll, reloadAll, prepareRenderer, useDocumentPreviews, renderSlot, readAllText, t,
}: TextPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const { navigation, signal } = tab
  const meta = useResource<'file'>(tab.contentId)
  const canRead = meta.status !== 'none'
  const file = useMemo(() => hostFileOf(tab.contentId), [tab.contentId])
  const state = useStore(s => s.byTab[tab.id])
  const definitions = useDocumentPreviews(value => value)
  const unviewable = useMemo(() => unviewableBinaryPath(file.path), [file.path])
  const candidates = useMemo(() => {
    const matched = matchingDocumentPreviews(definitions, file.path)
    if (matched.length > 0 && binaryDocumentPath(definitions, file.path)) return matched
    if (matched.length === 0 && unviewable) return matched
    const fallback = definitions.find(definition => definition.id === PLAIN_BODY_ID)
    return fallback === undefined ? matched : [...matched, fallback]
  }, [definitions, file.path, unviewable])
  // Persisted display choice, resolved in-memory tab pick first, then by exact
  // path, then by suffix, then the automatic candidate.
  const prefs = useMemo(() => readViewerPrefs(), [])
  const extension = extensionOf(file.path)
  const selected = candidates.find(candidate => candidate.id === state?.rendererId)
    ?? candidates.find(candidate => candidate.id === prefs.byPath[file.path])
    ?? candidates.find(candidate => candidate.id === prefs.byExtension[extension])
    ?? candidates[0]
  const editorCandidate = candidates.find(candidate => candidate.priority === 'editor')
  const mode = selected?.loading
  const contentRendererId = mode === 'renderer' ? selected?.id : undefined
  const current = (state?.mode ?? 'text-pages') === mode && state?.contentRendererId === contentRendererId ? state : undefined
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const storedScrollTopRef = useRef(0)
  // The selected renderer's toolbar commands (find, go to line), filled by the
  // body when it mounts and withdrawn when it unmounts.
  const commandsRef = useRef<DocumentRendererCommands | null>(null)
  const bindCommands = useCallback((value: DocumentRendererCommands | null): void => {
    commandsRef.current = value
  }, [])
  const pathRef = useRef<HTMLDivElement | null>(null)
  const pathTextRef = useRef<HTMLSpanElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /** The quick actions' last outcome, flashed beside the toolbar. */
  const [flash, setFlash] = useState<'copied' | 'copiedPath' | 'downloadFailed' | 'copyFailed' | 'findNotFound' | null>(null)
  useEffect(() => {
    if (flash === null) return undefined
    const timer = window.setTimeout(() => { setFlash(null) }, 2500)
    return () => { window.clearTimeout(timer) }
  }, [flash])
  const displayPath = meta.value?.absolutePath ?? current?.complete?.absolutePath ?? file.path
  usePathClipped(pathRef, pathTextRef, displayPath, state !== undefined)
  // Every tab of this type is a `file` resource address, so its params are the
  // `file` type's; the union is narrowed on the one field read, not validated.
  const line = navigation.params !== undefined && 'line' in navigation.params ? navigation.params.line : undefined
  const pages = current?.pages
  const loaded = useMemo(() => loadedPages(pages ?? {}), [pages])
  const loadedThrough = lastLineLoaded(loaded)
  const hasContent = mode === 'renderer' ? current?.version !== undefined : loaded.length > 0 || current?.complete !== undefined
  storedScrollTopRef.current = state?.scrollTop ?? 0
  const bindBody = useCallback((body: HTMLDivElement | null): void => {
    const previous = bodyRef.current
    bodyRef.current = body
    if (scrollportRef.current === null || scrollportRef.current === previous) scrollportRef.current = body
  }, [])
  const bindScrollport = useCallback((scrollport: HTMLElement | null): void => {
    const next = scrollport ?? bodyRef.current
    scrollportRef.current = next
    if (next !== null) next.scrollTop = storedScrollTopRef.current
  }, [])

  // First mount reads the first page; a body coming back to a tab with content
  // reads nothing, because the store outlives the body.
  const started = current !== undefined
  useEffect(() => {
    if (started || !canRead || mode === undefined || selected === undefined) return
    if (mode === 'text-pages') loadPage(tab.id, file, 1, signal, meta.value?.version)
    else if (mode === 'bytes-complete') loadAll(tab.id, file, signal, meta.value?.version)
    else prepareRenderer(tab.id, signal, selected.id, meta.value?.version)
  }, [started, tab.id, file, signal, loadPage, loadAll, prepareRenderer, canRead, mode, selected, meta.value?.version])

  // Come back where the reader was once there is content to scroll: on a remount,
  // after a reload rebuilt the content, or after the selected renderer changed.
  // Scroll writes preserve both identities, so they never re-land.
  useEffect(() => {
    const body = scrollportRef.current
    if (hasContent && body !== null && state !== undefined) body.scrollTop = state.scrollTop
  }, [hasContent, selected?.id])

  // Answer a navigation once: a line the pages do not reach yet loads the next
  // page (again, until the pages cover it or the file ends); a line they hold
  // is scrolled to and marked. The store remembers the answer, so a remount
  // restores the reader's place instead.
  useEffect(() => {
    const body = scrollportRef.current
    if (current === undefined || body === null || current.revision === navigation.revision) return
    if (line === undefined || mode !== 'text-pages') {
      actions.navigated(tab.id, navigation.revision)
      return
    }
    if (line > loadedThrough && !current.eof) {
      if (!current.loading && current.failure === undefined && canRead) {
        loadPage(tab.id, file, loadedThrough + 1, signal, meta.value?.version)
      }
      return
    }
    const landed = scrollToLine(body, line)
    if (!landed && line <= loadedThrough) return
    actions.navigated(tab.id, navigation.revision)
    // Recorded here as well as by the scroll event, so the store holds the
    // landing before any later navigation reads it.
    actions.scrolled(tab.id, body.scrollTop)
  }, [
    navigation.revision, line, loadedThrough, current?.eof, current?.loading, current?.failure, started,
    selected?.id, mode, file, canRead, meta.value?.version,
  ])

  const rendererReload = useCallback((): void => {
    if (canRead && selected !== undefined) prepareRenderer(tab.id, signal, selected.id, meta.value?.version, true)
  }, [canRead, prepareRenderer, tab.id, signal, selected?.id, meta.value?.version])
  const content = useMemo((): DocumentContent | undefined => {
    if (mode === 'renderer') {
      if (current === undefined) return undefined
      const revision = current.loadRevision
      return { kind: 'renderer', revision, reload: rendererReload,
        loaded: (version) => { actions.rendered(tab.id, revision, version) } }
    }
    if (mode === 'bytes-complete') {
      return current?.complete === undefined ? undefined : {
        kind: 'bytes', data: current.complete.data,
      }
    }
    if (current === undefined || loaded.length === 0) return undefined
    return { kind: 'text', pages: loaded, text: loaded.filter(page => page.lines > 0).map(page => page.text).join('\n'), eof: current.eof }
  }, [mode, loaded, current?.complete, current?.eof, current?.loadRevision, rendererReload, actions, tab.id])

  // The quick actions. Go to line and find prefer the selected renderer's own
  // commands (the editing surface's search panel and line jump); a host-owned
  // source view is navigated directly, by line navigation and a scrolled match.
  const gotoLine = useCallback((): void => {
    const viaRenderer = commandsRef.current?.gotoLine
    if (viaRenderer !== undefined) {
      viaRenderer()
      return
    }
    const raw = window.prompt(t('gotoPrompt'), '1')
    if (raw === null) return
    const line = Number.parseInt(raw, 10)
    if (!Number.isInteger(line) || line < 1) return
    // Re-navigating the same address reveals this tab again with a line
    // parameter, which the body's navigation effect answers — loading pages
    // the target needs on the way.
    tab.actions.openResource(tab.contentId, { params: { line } })
  }, [tab.actions, tab.contentId, t])
  const findInFile = useCallback((): void => {
    const viaRenderer = commandsRef.current?.find
    if (viaRenderer !== undefined) {
      viaRenderer()
      return
    }
    const term = window.prompt(t('findPrompt'))
    if (term === null || term === '') return
    const body = scrollportRef.current
    if (body === null) return
    const line = findLineOf(loaded, term, visibleTopLine(body) + 1)
    if (line === undefined) {
      setFlash('findNotFound')
      return
    }
    if (scrollToLine(body, line)) actions.scrolled(tab.id, body.scrollTop)
  }, [actions, loaded, tab.id, t])
  const quickDownload = useCallback((): void => {
    void downloadSessionFile(file).catch(() => { setFlash('downloadFailed') })
  }, [file])
  const quickCopyPath = useCallback((): void => {
    void copyPlainText(meta.value?.absolutePath ?? file.path)
      .then(() => { setFlash('copiedPath') }, () => { setFlash('copyFailed') })
  }, [meta.value?.absolutePath, file.path])
  const quickCopyContent = useCallback((): void => {
    // A host-owned text view copies what it holds; a renderer-owned view copies
    // the file's text read fresh from disk.
    const text = content?.kind === 'text' ? content.text : undefined
    if (text !== undefined) {
      void copyPlainText(text).then(() => { setFlash('copied') }, () => { setFlash('copyFailed') })
      return
    }
    void readAllText(file).then(
      disk => void copyPlainText(disk).then(() => { setFlash('copied') }, () => { setFlash('copyFailed') }),
      () => { setFlash('copyFailed') },
    )
  }, [content, file, readAllText])

  // A known binary suffix with no matching renderer never reads: no plain-text
  // fallback, no viewer control, only the path and the unsupported line.
  if (selected === undefined && unviewable) {
    const { name: unsupportedName } = pathPartsOf(displayPath)
    return (
      <div className={css.preview} data-textpreview-state="unsupported" data-textpreview-url={tab.contentId}>
        <div className={css.header}>
          <HeaderPath pathRef={pathRef} pathTextRef={pathTextRef} path={displayPath} />
        </div>
        <div className={css.body} data-textpreview-body>
          <div className={css.empty} data-textpreview-unsupported>
            <FileTypeIcon kind={classifyFileType(unsupportedName)} size={36} className={css.emptyIcon} />
            <p className={css.emptyLine}>{t('unsupportedFile')}</p>
          </div>
        </div>
      </div>
    )
  }
  if (state === undefined || selected === undefined) {
    return (
      <div className={css.status} data-textpreview-state="loading">
        {meta.status === 'none'
          ? <p className={css.statusLine}>{t('resourceUnavailable')}</p>
          : <LoadingIndicator className={css.statusLine} label={t('loading')} />}
      </div>
    )
  }
  const next = loadedThrough + 1
  const { name } = pathPartsOf(displayPath)
  const observedVersion = meta.value?.version
  // A renderer-owned body (the CodeMirror editor) watches disk itself and owns
  // its own change banner, so the shared bar never doubles that signal.
  const changed = mode !== 'renderer' && current?.version !== undefined && observedVersion !== undefined
    && observedVersion !== current.version && observedVersion !== current.observedVersion
  const loadNext = (): void => {
    if (!canRead || current?.loading || current?.eof) return
    loadPage(tab.id, file, next, signal, meta.value?.version)
  }
  const reload = (): void => {
    if (!canRead) return
    if (mode === 'text-pages') reloadPages(tab.id, file, signal, meta.value?.version)
    else if (mode === 'bytes-complete') reloadAll(tab.id, file, signal, meta.value?.version)
    // A renderer-owned body owns its reload: the content channel is the one
    // path so a dirty editor confirms before the outer refresh.
    else if (content !== undefined && content.kind === 'renderer') content.reload()
    else rendererReload()
  }
  return (
    <div className={css.preview} data-textpreview-state="text" data-textpreview-url={tab.contentId} data-document-preview={selected.id}>
      {meta.failure !== undefined && hasContent
        ? (
          // The file's metadata failed — gone, or its workspace unknown — which
          // outranks a pending change; the pages already read stay under it.
          // With nothing read the body's own failure already says it, so the
          // bar would only repeat the same line.
          <p className={css.changed} data-textpreview-meta-failed={meta.failure.code}>
            <span>{failureLine(t, meta.failure)}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )
        : changed && (
          <p className={css.changed} data-textpreview-changed>
            <span>{t('changed')}</span>
            <button
              type="button"
              className={css.action}
              data-textpreview-reload-now
              onClick={reload}
            >
              {t('reloadNow')}
            </button>
          </p>
        )}
      <div className={css.header}>
        <HeaderPath pathRef={pathRef} pathTextRef={pathTextRef} path={displayPath} />
        {candidates.length > 1
          && (
            <Menu
              open={menuOpen}
              anchor={(
                <button type="button" className={clsx(css.tool, css.viewerTool)} aria-label={t('openWith')} title={selected.title()} data-document-viewer-menu onClick={() => { setMenuOpen(value => !value) }}>
                  {selected.title()}
                </button>
              )}
              items={candidates.map(candidate => ({ id: candidate.id, label: candidate.title() }))}
              selectedId={selected.id}
              onSelect={(id) => {
                actions.selected(tab.id, id)
                rememberViewerByExtension(file.path, id)
                setMenuOpen(false)
              }}
              onClose={() => { setMenuOpen(false) }}
              align="end"
              portal
              dense
            />
          )}
        {flash !== null && <span className={css.action} data-textpreview-flash>{t(flash)}</span>}
        {editorCandidate !== undefined && editorCandidate.id !== selected.id && (
          // One click from the rich view into the editing surface: the switch
          // changes this tab's display type in place — the registered editing
          // tab kind has no open path anymore.
          <Tooltip label={t('editor.open')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('editor.open')}
              data-textpreview-tool="editor"
              onClick={() => {
                actions.selected(tab.id, editorCandidate.id)
                rememberViewerByExtension(file.path, editorCandidate.id)
              }}
            >
              <IconEditOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        {selected?.capabilities?.gotoLine === true && (
          <Tooltip label={t('gotoLine')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('gotoLine')}
              data-textpreview-tool="goto-line"
              onClick={gotoLine}
            >
              <IconListPenOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        {selected?.capabilities?.search === true && (
          <Tooltip label={t('findInFile')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('findInFile')}
              data-textpreview-tool="find"
              onClick={findInFile}
            >
              <IconSearchOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        {selected?.loading !== 'bytes-complete' && (
          <Tooltip label={t('copyContent')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-label={t('copyContent')}
              data-textpreview-tool="copy-content"
              onClick={quickCopyContent}
            >
              <IconCopyOutline16 size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('copyPath')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('copyPath')}
            data-textpreview-tool="copy-path"
            onClick={quickCopyPath}
          >
            <IconLinkOutline16 size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t('download')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('download')}
            data-textpreview-tool="download"
            onClick={quickDownload}
          >
            <IconDownloadOutline16 size={14} />
          </button>
        </Tooltip>
        {selected.wrap === true && (
          // The tooltip names the action while the stable aria name and
          // `aria-pressed` expose the control and its current state.
          <Tooltip label={t(state.wrap ? 'wrap.disable' : 'wrap.enable')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.tool}
              aria-pressed={state.wrap}
              aria-label={t('wrap.aria')}
              data-textpreview-tool="wrap"
              onClick={() => { actions.toggledWrap(tab.id) }}
            >
              {state.wrap ? <IconNowrapFill16 /> : <IconWrapFill16 />}
            </button>
          </Tooltip>
        )}
        <Tooltip label={t('reload')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            data-textpreview-tool="reload"
            onClick={reload}
          >
            <IconRefreshOutline16 />
          </button>
        </Tooltip>
      </div>
      <div
        ref={bindBody}
        className={clsx(css.body, state.wrap && css.wrap)}
        data-textpreview-body
        data-textpreview-wrap={state.wrap ? '' : undefined}
        onScrollCapture={(event) => {
          const body = scrollportRef.current
          /* v8 ignore next -- callback refs bind the scrollport during commit, before user input. */
          if (body === null) return
          if (event.target !== body) return
          actions.scrolled(tab.id, body.scrollTop)
          if (mode === 'text-pages' && current?.failure === undefined && body.clientHeight > 0
            && body.scrollTop + body.clientHeight >= body.scrollHeight - 1) loadNext()
        }}
      >
        {mode !== 'renderer' && !hasContent && current?.failure === undefined && (
          <LoadingIndicator className={clsx(css.statusLine, css.bodyLoading)} label={t('loading')} />
        )}
        {content !== undefined && renderSlot('sidebar.right.tab.document', {
          resourceAddress: tab.contentId, content, wrap: state.wrap, scrollportRef: bindScrollport,
          commandsRef: bindCommands,
        }, {
          entryKey: selected.id, hookContext: useTabInfo,
          fallback: <p className={css.statusLine}>{t('rendererUnavailable', { name: selected.title() })}</p>,
        })}
        {current?.failure !== undefined && (hasContent
          ? (
            <p className={css.statusLine} data-textpreview-failed={current.failure.code}>
              <span>{failureLine(t, current.failure)}</span>
              <button
                type="button"
                className={css.action}
                data-textpreview-retry
                onClick={loadNext}
              >
                {t('retry')}
              </button>
            </p>
          )
          : (
            // With no content, retry the selected renderer's read; metadata
            // observation remains owned by the resource provider.
            <div className={css.empty} data-textpreview-failed={current.failure.code}>
              <FileTypeIcon kind={classifyFileType(name)} size={36} className={css.emptyIcon} />
              <p className={css.emptyLine}>{failureLine(t, current.failure)}</p>
              <button
                type="button"
                className={css.retry}
                data-textpreview-retry
                onClick={reload}
              >
                <IconRefreshOutline16 size={14} />
                {t('retry')}
              </button>
            </div>
          ))}
        {mode === 'text-pages' && current !== undefined && loaded.length > 0 && !current.eof && current.failure === undefined && (
          <button
            type="button"
            className={css.more}
            disabled={current.loading}
            data-textpreview-more
            onClick={loadNext}
          >
            {current.loading ? <LoadingIndicator label={t('loading')} /> : t('loadMore')}
          </button>
        )}
      </div>
    </div>
  )
}
