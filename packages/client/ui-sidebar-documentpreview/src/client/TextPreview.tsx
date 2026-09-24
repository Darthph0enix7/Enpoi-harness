/**
 * The text preview's body: a file's content, or the reason it is not showing.
 *
 * Two sources meet here. The standard `useResource` hook gives the file's
 * metadata — its version — and this type's
 * own store holds the content it read through its face. A Host-reported change is
 * announced, not applied: reloading under a reader would lose their place, so
 * the bar waits for a click. A failed metadata frame — the file gone, its
 * workspace unknown — takes the same bar's place over the pages already loaded,
 * with the same reload. One toolbar row carries everything: the path, the
 * display-type menu, the selected renderer's own segment
 * ({@link DocumentRendererCommands} and the keyed document-toolbar seat), and
 * the host quick actions (reload, download, copy path, copy content, go to
 * line, find, wrap). Actions that do not fit collapse behind `⋯` rather than
 * wrapping; go-to-line and the host-owned find open themed popovers, never a
 * browser prompt.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconChevronDownOutline14, IconChevronUpOutline14, IconCloseOutline16, IconCopyOutline16,
  IconDownloadOutline16, IconEllipsisOutline16, IconLinkOutline16, IconListPenOutline16,
  IconRefreshOutline16, IconSearchOutline16, Menu, Tooltip, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { TextInjected } from './face.ts'
import { failureLine } from './failure-line.ts'
import { IconNowrapFill16, IconWrapFill16 } from './icons.tsx'
import { LoadingIndicator } from './LoadingIndicator.tsx'
import { hostFileOf } from './rpc.ts'
import type { TextStore } from './store.ts'
import type { DocumentContent, DocumentDiffParams, DocumentRendererCommands } from './document/contract.ts'
import { binaryDocumentPath, matchingDocumentPreviews } from './document/registry.ts'
import type { DocumentPreviewDefinition } from './document/registry.ts'
import { unviewableBinaryPath } from './document/unviewable.ts'
import {
  extensionOf, readViewerPrefs, rememberViewerByExtension,
} from './document/viewer-prefs.ts'
import { PLAIN_BODY_ID } from './text/index.ts'
import { findLinesOf, loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
import { copyPlainText, downloadSessionFile } from './quick-actions.ts'
import css from './TextPreview.module.css'

export { linesOf, loadedPages, lastLineLoaded, scrollToLine } from './text/lines.ts'
export type { LoadedPage } from './text/lines.ts'

/** One shared toolbar control; the array order is the rendered order. */
type ToolbarActionId = 'reload' | 'download' | 'copyPath' | 'copyContent' | 'gotoLine' | 'find' | 'wrap'

/** The stable DOM id of each control, so selectors survive internal renaming. */
const TOOL_ID: Record<ToolbarActionId, string> = {
  reload: 'reload',
  download: 'download',
  copyPath: 'copy-path',
  copyContent: 'copy-content',
  gotoLine: 'goto-line',
  find: 'find',
  wrap: 'wrap',
}

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
  & PropsRenderSlots<'sidebar.right.tab.document' | 'sidebar.right.tab.document.toolbar'>
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
  // A navigation that asked for the comparison wins over every remembered
  // display choice; the renderer declaring the `diff` capability is selected
  // even though its empty extension list never matches a filename.
  const diffRequested = navigation.params !== undefined && 'diff' in navigation.params
    ? navigation.params.diff as DocumentDiffParams | undefined
    : undefined
  const diffCandidate = diffRequested === undefined
    ? undefined
    : definitions.find(definition => definition.capabilities?.diff === true)
  const selected = diffCandidate
    ?? candidates.find(candidate => candidate.id === state?.rendererId)
    ?? candidates.find(candidate => candidate.id === prefs.byPath[file.path])
    ?? candidates.find(candidate => candidate.id === prefs.byExtension[extension])
    ?? candidates[0]
  const mode = selected?.loading
  const contentRendererId = mode === 'renderer' ? selected?.id : undefined
  const current = (state?.mode ?? 'text-pages') === mode && state?.contentRendererId === contentRendererId ? state : undefined
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const storedScrollTopRef = useRef(0)
  // The selected renderer's toolbar commands (find, go to line), filled by the
  // body when it mounts and withdrawn when it unmounts. `commandsReady` is the
  // reactive mirror: the navigation effect re-runs when the bridge arrives or
  // leaves, so a line waiting for a still-mounting renderer is not dropped.
  const commandsRef = useRef<DocumentRendererCommands | null>(null)
  const commandsReadyRef = useRef(false)
  const [commandsReady, setCommandsReady] = useState(false)
  const bindCommands = useCallback((value: DocumentRendererCommands | null): void => {
    const bound = value !== null
    // Only the bridge's arrival or departure is a state change. A body that
    // rebinds on every render (a fresh commands object) must not schedule a
    // render-phase update each time: React would re-render until its loop cap.
    if (commandsReadyRef.current === bound) {
      commandsRef.current = value
      return
    }
    commandsReadyRef.current = bound
    commandsRef.current = value
    setCommandsReady(bound)
  }, [])
  const pathRef = useRef<HTMLDivElement | null>(null)
  const pathTextRef = useRef<HTMLSpanElement | null>(null)
  // The single toolbar row: the header measures itself and moves trailing
  // controls behind the overflow menu instead of wrapping.
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [collapsed, setCollapsed] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  /** Whether the themed go-to-line popover is open. */
  const [gotoOpen, setGotoOpen] = useState(false)
  /** The line a renderer could not land on, shown as a hint instead of dropped. */
  const [lineHint, setLineHint] = useState<number | null>(null)
  /** Whether the host-owned find popover is open (renderer-owned find uses its own surface). */
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)
  const gotoInputRef = useRef<HTMLInputElement | null>(null)
  /** The quick actions' last outcome, flashed beside the toolbar. */
  const [flash, setFlash] = useState<'copied' | 'copiedPath' | 'downloadFailed' | 'copyFailed' | null>(null)
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
  // is scrolled to and marked. A renderer that offers `gotoLine` is told where
  // to land once it declared content loaded; one that does not still opens,
  // with the line surfaced as a hint instead of being silently dropped. The
  // store remembers the answer, so a remount restores the reader's place.
  useEffect(() => {
    const body = scrollportRef.current
    if (current === undefined || body === null || current.revision === navigation.revision) return
    if (line === undefined) {
      setLineHint(null)
      actions.navigated(tab.id, navigation.revision)
      return
    }
    if (mode === 'renderer') {
      const commands = commandsRef.current
      if (selected?.capabilities?.gotoLine === true) {
        if (commands?.gotoLine !== undefined) {
          // The body streams its own content into the store; wait for the
          // loaded revision so the editor has a document to move inside.
          if (current.version === undefined) return
          commands.gotoLine(line)
          setLineHint(null)
          actions.navigated(tab.id, navigation.revision)
          return
        }
        // No bridge yet and no content either: the body may still be mounting.
        if (!commandsReady && current.version === undefined) return
      }
      setLineHint(line)
      actions.navigated(tab.id, navigation.revision)
      return
    }
    if (mode !== 'text-pages') {
      setLineHint(line)
      actions.navigated(tab.id, navigation.revision)
      return
    }
    setLineHint(null)
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
    navigation.revision, line, loadedThrough, current?.eof, current?.loading, current?.failure, current?.version,
    started, selected?.id, selected?.capabilities?.gotoLine, mode, file, canRead, meta.value?.version, commandsReady,
  ])

  // Which shared controls this display type offers, in rendered order. The
  // editor-only entries are capability-gated; a rich view keeps only the host
  // actions it can honour.
  const toolbarActions = useMemo((): readonly ToolbarActionId[] => {
    const actions: ToolbarActionId[] = ['reload', 'download', 'copyPath']
    if (selected?.loading !== 'bytes-complete') actions.push('copyContent')
    if (selected?.capabilities?.gotoLine === true) actions.push('gotoLine')
    if (selected?.capabilities?.search === true) actions.push('find')
    if (selected?.wrap === true) actions.push('wrap')
    return actions
  }, [selected])

  // One row, never two: when the controls overrun the header, move the
  // trailing ones into the overflow menu (the path shrinks first, and the
  // reload control never collapses).
  const maxCollapsed = Math.max(toolbarActions.length - 1, 0)
  const collapsedNow = Math.min(collapsed, maxCollapsed)
  useLayoutEffect(() => {
    const header = headerRef.current
    if (header === null) return undefined
    const measure = (): void => {
      const overflowing = header.scrollWidth > header.clientWidth + 1
      setCollapsed((current) => {
        if (overflowing) return current < maxCollapsed ? current + 1 : current
        // Only re-expand with real slack, so the row cannot oscillate.
        if (current > 0 && header.scrollWidth < header.clientWidth - 64) return current - 1
        return current
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(header)
    return () => { observer?.disconnect() }
  }, [collapsed, maxCollapsed, toolbarActions.length])

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

  // Go to line: the renderer's own jump when it offers one (the editor moves
  // its cursor), otherwise the tab's line navigation, which loads the pages
  // the target needs on the way. The field is our popover, never a prompt.
  const jumpToLine = useCallback((line: number): void => {
    const viaRenderer = commandsRef.current?.gotoLine
    if (viaRenderer !== undefined) {
      viaRenderer(line)
      return
    }
    tab.actions.openResource(tab.contentId, { params: { line } })
  }, [tab.actions, tab.contentId])
  // Find prefers the renderer's own surface; a host-owned source view gets the
  // shared popover, whose matches are the loaded lines holding the query.
  const openFind = useCallback((): void => {
    const viaRenderer = commandsRef.current?.find
    if (viaRenderer !== undefined) {
      viaRenderer()
      return
    }
    setFindQuery('')
    setFindIndex(0)
    setFindOpen(true)
  }, [])
  const findMatches = useMemo(() => findLinesOf(loaded, findQuery), [loaded, findQuery])

  // Reveal the current host-owned find match whenever the query or index moves.
  useEffect(() => {
    if (!findOpen) return
    const line = findMatches[findIndex]
    const body = scrollportRef.current
    if (line === undefined || body === null) return
    if (scrollToLine(body, line)) actions.scrolled(tab.id, body.scrollTop)
  }, [actions, findIndex, findMatches, findOpen, tab.id])

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

  const labelOf = (id: ToolbarActionId): string => {
    switch (id) {
      case 'reload': return t('reload')
      case 'download': return t('download')
      case 'copyPath': return t('copyPath')
      case 'copyContent': return t('copyContent')
      case 'gotoLine': return t('gotoLine')
      case 'find': return t('findInFile')
      case 'wrap': return t(state.wrap ? 'wrap.disable' : 'wrap.enable')
    }
  }
  const iconOf = (id: ToolbarActionId): ReactNode => {
    switch (id) {
      case 'reload': return <IconRefreshOutline16 />
      case 'download': return <IconDownloadOutline16 size={14} />
      case 'copyPath': return <IconLinkOutline16 size={14} />
      case 'copyContent': return <IconCopyOutline16 size={14} />
      case 'gotoLine': return <IconListPenOutline16 size={14} />
      case 'find': return <IconSearchOutline16 size={14} />
      case 'wrap': return state.wrap ? <IconNowrapFill16 /> : <IconWrapFill16 />
    }
  }
  const runAction = (id: ToolbarActionId): void => {
    switch (id) {
      case 'reload': reload(); return
      case 'download': quickDownload(); return
      case 'copyPath': quickCopyPath(); return
      case 'copyContent': quickCopyContent(); return
      case 'gotoLine': setGotoOpen(true); return
      case 'find': openFind(); return
      case 'wrap': actions.toggledWrap(tab.id); return
    }
  }
  const toolbarButton = (id: ToolbarActionId): ReactNode => (
    <Tooltip key={id} label={labelOf(id)} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.tool}
        aria-pressed={id === 'wrap' ? state.wrap : undefined}
        aria-label={id === 'wrap' ? t('wrap.aria') : labelOf(id)}
        data-textpreview-tool={TOOL_ID[id]}
        onClick={() => { runAction(id) }}
      >
        {iconOf(id)}
      </button>
    </Tooltip>
  )
  /** Step the host-owned find through its matches, wrapping at either end. */
  const stepFind = (delta: 1 | -1): void => {
    const total = findMatches.length
    setFindIndex(current => (total === 0 ? 0 : (current + delta + total) % total))
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === 'f' && selected.capabilities?.search === true) {
      event.preventDefault()
      openFind()
      return
    }
    if (key === 'g' && selected.capabilities?.gotoLine === true) {
      event.preventDefault()
      setGotoOpen(true)
    }
  }
  const visibleActions = toolbarActions.slice(0, toolbarActions.length - collapsedNow)
  const hiddenActions = toolbarActions.slice(toolbarActions.length - collapsedNow)

  return (
    <div
      className={css.preview}
      data-textpreview-state="text"
      data-textpreview-url={tab.contentId}
      data-document-preview={selected.id}
      onKeyDown={handleKeyDown}
    >
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
      {lineHint !== null && (
        <p className={css.changed} data-textpreview-line-hint={lineHint}>
          <span>{t('lineHint', { line: String(lineHint) })}</span>
        </p>
      )}
      <div className={css.header} ref={headerRef} data-textpreview-toolbar>
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
                // Leaving the comparison is an explicit display choice: the
                // navigation that requested it is cleared in the same gesture,
                // so the picked renderer is what the pane shows.
                if (diffRequested !== undefined) tab.actions.openResource(tab.contentId, { params: {} })
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
        {renderSlot('sidebar.right.tab.document.toolbar', { rendererId: selected.id, compact: collapsed > 0 }, {
          entryKey: selected.id, hookContext: useTabInfo, fallback: null,
        })}
        <div className={css.tools} data-textpreview-tools>
          {visibleActions.map(toolbarButton)}
          {flash !== null && <span className={css.action} data-textpreview-flash>{t(flash)}</span>}
          {hiddenActions.length > 0 && (
            <Menu
              open={moreOpen}
              anchor={(
                <button
                  type="button"
                  className={css.tool}
                  aria-label={t('more')}
                  title={t('more')}
                  data-textpreview-more
                  onClick={() => { setMoreOpen(value => !value) }}
                >
                  <IconEllipsisOutline16 size={14} />
                </button>
              )}
              items={hiddenActions.map(id => ({ id, label: labelOf(id) }))}
              onSelect={(id) => { setMoreOpen(false); runAction(id as ToolbarActionId) }}
              onClose={() => { setMoreOpen(false) }}
              align="end"
              portal
              dense
            />
          )}
        </div>
        {/* The pane's own dismiss route: the dock's tab strip is hidden in the
            product, so a preview opened beside a page (the editor pane) would
            otherwise have no close anywhere. Closing the record closes the
            pane and its parked tab together. */}
        <button
          type="button"
          className={css.tool}
          aria-label={t('close')}
          title={t('close')}
          data-textpreview-close
          onClick={() => { tab.actions.close() }}
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      {gotoOpen && (
        <div className={css.popover} role="dialog" aria-label={t('gotoLine')} data-textpreview-popover="goto">
          <IconListPenOutline16 size={14} className={css.popoverIcon} />
          <input
            ref={gotoInputRef}
            className={css.popoverInput}
            placeholder={t('goto.placeholder')}
            aria-label={t('goto.placeholder')}
            autoFocus
            inputMode="numeric"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setGotoOpen(false)
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              const line = Number.parseInt(event.currentTarget.value, 10)
              setGotoOpen(false)
              if (Number.isInteger(line) && line > 0) jumpToLine(line)
            }}
          />
          <button
            type="button"
            className={css.popoverButton}
            aria-label={t('close')}
            data-textpreview-popover-close
            onClick={() => { setGotoOpen(false) }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
      )}
      {findOpen && (
        <div className={css.popover} role="search" aria-label={t('findInFile')} data-textpreview-popover="find">
          <IconSearchOutline16 size={14} className={css.popoverIcon} />
          <input
            className={css.popoverInput}
            value={findQuery}
            placeholder={t('find.placeholder')}
            aria-label={t('find.placeholder')}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => { setFindQuery(event.target.value); setFindIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setFindOpen(false)
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              stepFind(event.shiftKey ? -1 : 1)
            }}
          />
          <span className={css.popoverCount} data-textpreview-find-count>
            {findQuery === ''
              ? ''
              : findMatches.length === 0
                ? t('find.noMatch')
                : t('find.count', { index: findIndex + 1, total: findMatches.length })}
          </span>
          <button
            type="button"
            className={css.popoverButton}
            aria-label={t('find.previous')}
            data-textpreview-find-prev
            onClick={() => { stepFind(-1) }}
          >
            <IconChevronUpOutline14 size={14} />
          </button>
          <button
            type="button"
            className={css.popoverButton}
            aria-label={t('find.next')}
            data-textpreview-find-next
            onClick={() => { stepFind(1) }}
          >
            <IconChevronDownOutline14 size={14} />
          </button>
          <button
            type="button"
            className={css.popoverButton}
            aria-label={t('close')}
            data-textpreview-popover-close
            onClick={() => { setFindOpen(false) }}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>
      )}
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
