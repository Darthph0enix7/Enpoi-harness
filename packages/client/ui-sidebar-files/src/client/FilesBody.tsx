/**
 * The file tree's body: the session's workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a gesture means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. The header row is the text
 * preview's: the root's path, directories greyed and the last segment in full
 * ink, then the one control at its end, reload, which drops every listed level
 * and asks again for the expanded ones.
 *
 * Every row also carries its own actions — a 3-dots trigger and a right-click
 * context menu, one `RowMenu` for both — over the profile's fenced `/sidebar/
 * fsops` routes: create, mkdir, rename, delete (to the trash), download, copy
 * path, and copy relative path. Renames and new entries edit inline; a
 * successful mutation re-lists exactly the affected directory through the same
 * `load` the tree already uses, which is its invalidation entry point.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FileTypeIcon, IconEllipsisOutlineMedium, IconFolderCloseMedium, IconFolderOpenMedium,
  IconPlusOutlineMedium, IconRefreshOutlineMedium, classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor, pathPartsOf, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath, parentPath } from './face.ts'
import type { FilesInjected } from './face.ts'
import { createFsOps, failureMessage, saveDownload } from './fsops.ts'
import { MENU_LABEL_KEYS, menuItemsOf, menuReducer } from './menu.ts'
import type { MenuActionId, MenuState, MenuTarget, RowTarget } from './menu.ts'
import { RowMenu } from './RowMenu.tsx'
import type { RowMenuItem } from './RowMenu.tsx'
import type {} from './locales.ts'
import type { FilesTabState, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** How long one copy item shows its "copied" label, in ms. */
const COPIED_MS = 1200

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/* jscpd:ignore-start -- the header row is the document preview's (ui-sidebar-documentpreview
   TextPreview `usePathClipped`), copied because a plugin bundle shares runtime code
   only through the platform modules. TODO: once the artifact and slot surfaces
   settle, one copy in ui-primitives could serve every pane header. */
/**
 * Keep the path row's `data-files-path-clipped` current: set while the path's
 * text is wider than its box, so the stylesheet fades the clipped start. Read
 * after each commit that can change the path or mount the header, and whenever
 * either box resizes; written to the DOM directly because it changes only how
 * the stylesheet fades what is already rendered.
 */
function usePathClipped(
  box: RefObject<HTMLDivElement | null>,
  text: RefObject<HTMLSpanElement | null>,
  path: string | undefined,
): void {
  useLayoutEffect(() => {
    const outer = box.current
    const inner = text.current
    if (outer === null || inner === null) return undefined
    const apply = (): void => {
      if (inner.offsetWidth > outer.clientWidth) outer.dataset.filesPathClipped = ''
      else delete outer.dataset.filesPathClipped
    }
    apply()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply)
    observer?.observe(outer)
    observer?.observe(inner)
    return () => { observer?.disconnect() }
  }, [box, text, path])
}
/* jscpd:ignore-end */

/** The row name being renamed in place. */
interface RenameState {
  /** Absolute path of the row being renamed. */
  readonly path: string
  /** The edited basename, as typed. */
  readonly value: string
  /** The host failure to show inline, if any. */
  readonly error: string | null
}

/** The inline new-entry row inside one directory's listing. */
interface CreateState {
  /** Absolute path of the directory the entry is created in. */
  readonly parent: string
  /** Whether the inline row creates a file or a directory. */
  readonly kind: 'file' | 'directory'
  /** The typed basename. */
  readonly value: string
  /** The host failure to show inline, if any. */
  readonly error: string | null
}

/** What every level shares: the tab's tree, the gestures, and the inline editors. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (path: string) => void
  readonly onOpen: (path: string) => void
  readonly t: TranslateNS<'sidebarFiles'>
  /** The open row menu, so a trigger can mark itself expanded. */
  readonly menu: MenuState | null
  /** The row being renamed in place, if any. */
  readonly editing: RenameState | null
  /** The inline new-entry row, if any. */
  readonly creating: CreateState | null
  /** Right-click on a row: suppress the browser menu and open that row's menu. */
  readonly onRowMenu: (event: MouseEvent<HTMLElement>, target: RowTarget) => void
  /** The row's 3-dots: open the same menu without opening the row. */
  readonly onDotsMenu: (event: MouseEvent<HTMLButtonElement>, target: RowTarget) => void
  readonly onRenameChange: (pending: RenameState, value: string) => void
  readonly onRenameCommit: (pending: RenameState) => void
  readonly onRenameCancel: () => void
  readonly onCreateChange: (pending: CreateState, value: string) => void
  readonly onCreateCommit: (pending: CreateState) => void
  readonly onCreateCancel: () => void
}

/** The row's inline rename input, pre-filled and selected. */
function RenameInput({ editing, tree }: { editing: RenameState; tree: TreeContext }): ReactNode {
  return (
    <>
      <input
        className={css.editInput}
        value={editing.value}
        autoFocus
        aria-label={tree.t('menu.rename')}
        data-files-rename
        onFocus={(event) => { event.currentTarget.select() }}
        onChange={(event) => { tree.onRenameChange(editing, event.currentTarget.value) }}
        onClick={(event) => { event.stopPropagation() }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            tree.onRenameCommit(editing)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            tree.onRenameCancel()
          }
        }}
      />
      {editing.error !== null && <span className={css.editError} data-files-error>{editing.error}</span>}
    </>
  )
}

/** The inline new-file / new-folder row, drawn first under its directory. */
function CreateRow({ creating, tree }: { creating: CreateState; tree: TreeContext }): ReactNode {
  return (
    <li className={css.item} data-files-row="create">
      <div className={clsx(css.row, css.rowEditing)}>
        <span className={css.icon}>{creating.kind === 'directory' ? <IconFolderCloseMedium /> : <IconPlusOutlineMedium />}</span>
        <input
          className={css.editInput}
          value={creating.value}
          autoFocus
          aria-label={creating.kind === 'directory' ? tree.t('menu.newFolder') : tree.t('menu.newFile')}
          placeholder={creating.kind === 'directory' ? tree.t('create.folderPlaceholder') : tree.t('create.filePlaceholder')}
          data-files-create
          onChange={(event) => { tree.onCreateChange(creating, event.currentTarget.value) }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              tree.onCreateCommit(creating)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              tree.onCreateCancel()
            }
          }}
        />
        {creating.error !== null && <span className={css.editError} data-files-error>{creating.error}</span>}
      </div>
    </li>
  )
}

/** The row's 3-dots trigger, hidden until the row is hovered or keyboard-focused. */
function RowActionButton({ path, target, tree }: { path: string; target: RowTarget; tree: TreeContext }): ReactNode {
  const open = tree.menu !== null && tree.menu.target.kind !== 'root' && tree.menu.target.path === path
  return (
    <button
      type="button"
      className={css.rowAction}
      aria-label={tree.t('menu.trigger')}
      title={tree.t('menu.trigger')}
      aria-haspopup="menu"
      aria-expanded={open}
      data-files-actions
      onClick={(event) => { tree.onDotsMenu(event, target) }}
    >
      <IconEllipsisOutlineMedium />
    </button>
  )
}

/** One entry's row, its actions, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  const editing = tree.editing !== null && tree.editing.path === path ? tree.editing : null
  if (entry.type === 'directory') {
    const target: RowTarget = { kind: 'directory', path }
    const expanded = tree.state.expanded.includes(path)
    return (
      <li
        className={css.item}
        data-files-entry="directory"
        data-files-path={path}
        onContextMenu={(event) => { tree.onRowMenu(event, target) }}
      >
        {editing !== null
          ? (
            <div className={clsx(css.row, css.rowEditing)}>
              {expanded ? <IconFolderOpenMedium className={css.icon} /> : <IconFolderCloseMedium className={css.icon} />}
              <RenameInput editing={editing} tree={tree} />
            </div>
          )
          : (
            <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onToggle(path) }}>
              {expanded ? <IconFolderOpenMedium className={css.icon} /> : <IconFolderCloseMedium className={css.icon} />}
              <span className={css.name}>{entry.name}</span>
            </button>
          )}
        <RowActionButton path={path} target={target} tree={tree} />
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    const target: RowTarget = { kind: 'file', path }
    return (
      <li
        className={css.item}
        data-files-entry="file"
        data-files-path={path}
        onContextMenu={(event) => { tree.onRowMenu(event, target) }}
      >
        {editing !== null
          ? (
            <div className={clsx(css.row, css.rowEditing)}>
              <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
              <RenameInput editing={editing} tree={tree} />
            </div>
          )
          : (
            <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }}>
              <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.fileIcon} />
              <span className={css.name}>{entry.name}</span>
            </button>
          )}
        <RowActionButton path={path} target={target} tree={tree} />
      </li>
    )
  }
  return (
    <li
      className={css.item}
      data-files-entry="other"
      data-files-path={path}
      // Neither a file nor a directory: no row menu, and the browser's own
      // menu stays suppressed like every other row's.
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
    >
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const creating = tree.creating?.parent === path ? tree.creating : null
  const createRow = creating === null ? null : <CreateRow creating={creating} tree={tree} />
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return (
      <>
        {createRow}
        <li className={css.note} data-files-row="loading">{t('loading')}</li>
      </>
    )
  }
  if (level.kind === 'failed') {
    return (
      <>
        {createRow}
        <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
          {failureLine(t, level.failure)}
        </li>
      </>
    )
  }
  const entries = orderEntries(level.level.entries)
  return (
    <>
      {createRow}
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions, start, load, toggle, t,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const pathRef = useRef<HTMLDivElement>(null)
  const pathTextRef = useRef<HTMLSpanElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  usePathClipped(pathRef, pathTextRef, state?.root)

  const [menu, dispatchMenu] = useReducer(menuReducer, null)
  const [editing, setEditing] = useState<RenameState | null>(null)
  const [creating, setCreating] = useState<CreateState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const fsops = useMemo(createFsOps, [])
  // The element Escape/outside-click hands focus back to: the row (or the
  // empty area) whose gesture opened the menu. Not render state.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
    }
  }, [seeded])
  // Scrolling only moves the ref; the store hears about it once, on unmount,
  // so a scroll neither re-renders the tree nor writes after the owner's
  // abort has forgotten the bucket.
  useEffect(() => () => {
    if (seeded && !signal.aborted) actions.scrolled(tab.id, scrollTopRef.current)
  }, [seeded, signal, tab.id, actions])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  const copied = menu?.copied ?? null
  useEffect(() => {
    if (copied === null) return undefined
    const timer = setTimeout(() => { dispatchMenu({ type: 'copied-clear' }) }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])

  const closeMenu = useCallback((): void => {
    dispatchMenu({ type: 'close' })
    returnFocusRef.current?.focus()
  }, [])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null

  // Mutation reload: re-list exactly the affected directory. `load` is the
  // face's invalidation entry point — it marks the level loading and retires
  // any listing still in flight, so the tree shows the change when it settles.
  const reloadLevel = (path: string): void => { load(tab.id, path, signal) }
  const reportFailure = (error: unknown): void => {
    setNotice(t('error.opFailed', { message: failureMessage(error) }))
  }

  const commitRename = (pending: RenameState): void => {
    const name = pending.value.trim()
    if (name === '') {
      setEditing({ ...pending, error: t('error.emptyName') })
      return
    }
    const path = pending.path
    const parent = parentPath(path)
    if (name === pathPartsOf(path).name) {
      setEditing(null)
      return
    }
    setNotice(null)
    void fsops.rename(sessionId, path, childPath(parent, name)).then(() => {
      setEditing(null)
      reloadLevel(parent)
    }).catch((error: unknown) => {
      // Keep the input with what was typed, and say why inline.
      setEditing({ ...pending, error: failureMessage(error) })
    })
  }

  const commitCreate = (pending: CreateState): void => {
    const name = pending.value.trim()
    if (name === '') {
      setCreating({ ...pending, error: t('error.emptyName') })
      return
    }
    const parent = pending.parent
    setNotice(null)
    const operation = pending.kind === 'file'
      ? fsops.create(sessionId, parent, name)
      : fsops.mkdir(sessionId, parent, name)
    void operation.then(() => {
      setCreating(null)
      reloadLevel(parent)
    }).catch((error: unknown) => {
      setCreating({ ...pending, error: failureMessage(error) })
    })
  }

  const removeRow = (path: string): void => {
    setNotice(null)
    void fsops.delete(sessionId, path).then(() => { reloadLevel(parentPath(path)) }).catch(reportFailure)
  }

  const downloadFile = (path: string): void => {
    setNotice(null)
    void fsops.download(sessionId, path).then((payload) => { saveDownload(payload) }).catch(reportFailure)
  }

  const copyText = (action: 'copy-path' | 'copy-relative', target: MenuTarget): void => {
    setNotice(null)
    const relative = relativizeToCwd(target.path, state.root)
    // The tree's paths are the Host's absolute ones; the relative spelling is
    // what the workspace itself calls the same entry.
    const text = action === 'copy-path' ? childPath(cwd, relative) : relative
    void navigator.clipboard.writeText(text).then(() => {
      dispatchMenu({ type: 'copied', action })
    }).catch(reportFailure)
  }

  const openRowMenu = (event: MouseEvent<HTMLElement>, target: RowTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    returnFocusRef.current = event.currentTarget.querySelector<HTMLElement>('button')
    dispatchMenu({ type: 'open', target, x: event.clientX, y: event.clientY, align: 'start' })
  }

  const openDotsMenu = (event: MouseEvent<HTMLButtonElement>, target: RowTarget): void => {
    // The trigger sits beside the row's own button, but keep the promise the
    // gesture makes explicit: the dots never open or toggle the row.
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    // The trigger renders inside the row's li, whose first button is the row.
    returnFocusRef.current = (event.currentTarget.closest('li') as HTMLElement).querySelector('button')
    dispatchMenu({ type: 'open', target, x: rect.right, y: rect.bottom + 2, align: 'end' })
  }

  const openAreaMenu = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    returnFocusRef.current = bodyRef.current
    dispatchMenu({ type: 'open', target: { kind: 'root', path: state.root }, x: event.clientX, y: event.clientY, align: 'start' })
  }

  const beginCreate = (target: MenuTarget, kind: 'file' | 'directory'): void => {
    setNotice(null)
    const parent = target.path
    // The inline row lives at the top of the directory's listing: open the
    // directory first when it was collapsed.
    if (!state.expanded.includes(parent)) toggle(tab.id, parent, state.levels[parent] !== undefined, signal)
    setCreating({ parent, kind, value: '', error: null })
  }

  const handleMenuSelect = (id: MenuActionId, open: MenuState): void => {
    // The item table (`menuItemsOf`) is the authority on which actions each
    // target kind gets; the cases below rely on the target their items imply.
    const target = open.target
    switch (id) {
      case 'delete':
        dispatchMenu({ type: 'ask-delete' })
        return
      case 'delete-confirm':
        closeMenu()
        removeRow(target.path)
        return
      case 'open':
        tabActions.openResource(fileAddressFor(sessionId, state.root, target.path))
        closeMenu()
        return
      case 'download':
        downloadFile(target.path)
        closeMenu()
        return
      case 'rename':
        setEditing({ path: target.path, value: pathPartsOf(target.path).name, error: null })
        closeMenu()
        return
      case 'copy-path':
      case 'copy-relative':
        copyText(id, target)
        return
      case 'new-file':
      case 'new-folder':
        beginCreate(target, id === 'new-file' ? 'file' : 'directory')
        closeMenu()
        return
      case 'refresh':
        closeMenu()
        reload()
        return
    }
  }

  // Reload drops every level and asks again for the expanded ones; a collapsed
  // level is fetched again the next time it opens.
  const reload = (): void => {
    actions.reset(tab.id)
    for (const path of state.expanded) load(tab.id, path, signal)
  }

  const menuItems: readonly RowMenuItem[] = menu === null ? [] : menuItemsOf(menu).map(id => ({
    id,
    label: menu.copied === id ? t('copied') : t(MENU_LABEL_KEYS[id]),
    danger: id === 'delete' || id === 'delete-confirm',
  }))

  const tree: TreeContext = {
    state,
    onToggle: (path) => { toggle(tab.id, path, state.levels[path] !== undefined, signal) },
    // Every row is under the tree's root, so its address is session-relative.
    onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)) },
    t,
    menu,
    editing,
    creating,
    onRowMenu: openRowMenu,
    onDotsMenu: openDotsMenu,
    onRenameChange: (pending, value) => { setEditing({ ...pending, value, error: null }) },
    onRenameCommit: commitRename,
    onRenameCancel: () => { setEditing(null) },
    onCreateChange: (pending, value) => { setCreating({ ...pending, value, error: null }) },
    onCreateCommit: commitCreate,
    onCreateCancel: () => { setCreating(null) },
  }

  const { directory, name } = pathPartsOf(state.root)
  return (
    <div className={css.root} data-files-state="tree" data-files-root={state.root}>
      {/* jscpd:ignore-start -- the text preview's header row; see `usePathClipped`. */}
      <div className={css.header}>
        <div ref={pathRef} className={css.path} title={state.root} data-files-path>
          <span ref={pathTextRef} className={css.pathText}>
            {directory !== '' && <span className={css.pathDirectory}>{directory}</span>}
            <span className={css.pathName}>{name}</span>
          </span>
        </div>
        <button
          type="button"
          className={css.tool}
          aria-label={t('reload')}
          title={t('reload')}
          data-files-reload
          onClick={reload}
        >
          <IconRefreshOutlineMedium />
        </button>
      </div>
      {/* jscpd:ignore-end */}
      <div
        ref={bodyRef}
        className={css.body}
        tabIndex={-1}
        data-files-area
        data-files-body
        onContextMenu={openAreaMenu}
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
      >
        {notice !== null && <div className={css.notice} role="alert" data-files-notice>{notice}</div>}
        <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
      </div>
      {menu !== null && (
        <RowMenu
          menu={menu}
          items={menuItems}
          onSelect={(id) => { handleMenuSelect(id, menu) }}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
