/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory), directories sort first, hidden entries render dimmed. The
 * expansion set lives in the per-session state (owned by the caller); the
 * caller also owns the refresh affordance — a `refreshTick` bump wipes the
 * level cache so the visible set reloads.
 *
 * Row actions: hovering a row reveals an @-reference button on the far
 * right (appends `@<relative path>` to the composer draft), and right-click
 * opens a context menu: file rows offer the caller's open escapes
 * (new tab / to the side, only when the callbacks exist) and a download
 * action (the host serves raw bytes, binary-safe); every row can copy the
 * relative or absolute path (with a brief "copied" label replacing the
 * button after a successful write).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCodeOutline16, IconCopyOutline16, IconDownloadOutline16, IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16,
  IconLinkOutline16, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { api, downloadUrl, type FsEntry } from './api.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  expanded: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /** Insert `@<relative path>` into the composer draft. */
  onReferenceFile: (path: string) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** File-system operations (enpoi-fs-ops): rename / delete / create / mkdir. */
  onFsOp?: {
    rename: (from: string, to: string) => Promise<void>
    delete: (path: string, isDir: boolean) => Promise<void>
    create: (parent: string, name: string, isDir: boolean) => Promise<void>
  }
  /** Called after any successful fs operation so the caller can refresh. */
  onFsChanged?: () => void
}) {
  const { sessionId, cwd, expanded, onToggle, onOpenFile, onOpenFileNewTab, onOpenFileSide, onReferenceFile, refreshTick, onFsOp, onFsChanged } = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  const dataRef = useRef(data)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  /** Inline rename: the row path being renamed (null = none). */
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  /** Inline create: { parent, isDir } while the name input is open. */
  const [creating, setCreating] = useState<{ parent: string; isDir: boolean } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  // Focus the inline inputs when they mount.
  useEffect(() => {
    if (renamingPath !== null) renameInputRef.current?.focus()
  }, [renamingPath])
  useEffect(() => {
    if (creating !== null) createInputRef.current?.focus()
  }, [creating])

  /** Commit an inline rename: validate + call the fs op. */
  const commitRename = (path: string, value: string): void => {
    setRenamingPath(null)
    const name = value.trim()
    if (name === '' || name === path.split('/').pop()) return
    const to = path.slice(0, path.lastIndexOf('/') + 1) + name
    void onFsOp?.rename(path, to).then(() => onFsChanged?.()).catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : String(error))
    })
  }

  /** Commit an inline create: validate + call the fs op. */
  const commitCreate = (parent: string, isDir: boolean, value: string): void => {
    setCreating(null)
    const name = value.trim()
    if (name === '') return
    void onFsOp?.create(parent, name, isDir).then(() => onFsChanged?.()).catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : String(error))
    })
  }

  /** Delete with a confirm (trash-staged, recoverable). */
  const confirmDelete = (path: string, isDir: boolean): void => {
    const label = isDir ? 'folder' : 'file'
    if (!window.confirm(`Move this ${label} to trash?\n\n${path}`)) return
    void onFsOp?.delete(path, isDir).then(() => onFsChanged?.()).catch((error: unknown) => {
      window.alert(error instanceof Error ? error.message : String(error))
    })
  }

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir).then((listing) => {
      storeLevel(dir, { entries: listing.entries })
    }).catch((error: unknown) => {
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  // The caller's refresh tick wipes the cache (declared BEFORE the load
  // effect so the reload below sees the empty cache).
  const lastTick = useRef(refreshTick)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    dataRef.current = {}
    setData({})
  }, [refreshTick])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  /** The row's trailing actions: the @-reference button and 3-dots context menu button, or the copied label. */
  const rowActions = (entry: FsEntry): ReactNode => {
    if (copiedPath === entry.path) {
      return <span className={css.explorerCopied}>{t('copied')}</span>
    }
    return (
      <div className={css.explorerRowActions}>
        <button
          type="button"
          className={css.explorerRef}
          aria-label={t('referenceFile')}
          title={t('referenceFile')}
          onClick={(event) => {
            event.stopPropagation()
            onReferenceFile(entry.path)
          }}
        >
          {t('referenceFile')}
        </button>
        <button
          type="button"
          className={css.explorerMore}
          aria-label={t('more') || 'More'}
          title={t('more') || 'More options'}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            setRowMenu({
              path: entry.path,
              isDir: entry.isDir,
              x: rect.left,
              y: rect.bottom + 4,
            })
          }}
        >
          <IconEllipsisOutline16 size={14} />
        </button>
      </div>
    )
  }

  const openRowMenu = (event: MouseEvent, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const root = cwd

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    if (level === undefined) {
      return <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
    }
    if (level.error !== undefined) {
      return (
        <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
          {level.error}
        </div>
      )
    }
    const entries = level.entries ?? []
    return entries.map(entry => {
      if (entry.isDir) {
        const isOpen = expanded.includes(entry.path)
        return (
          <div key={entry.path}>
            <div
              role="button"
              tabIndex={0}
              className={clsx(css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden)}
              style={{ paddingLeft: depth * 22 + 6 }}
              onClick={() => { onToggle(entry.path) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onToggle(entry.path)
                }
              }}
              onContextMenu={(event) => { openRowMenu(event, entry.path, true) }}
            >
              {isOpen ? <IconFolderOpen16 size={14} /> : <IconFolderClose16 size={14} />}
              {renamingPath === entry.path
                ? (
                  <input
                    ref={renameInputRef}
                    className={css.explorerRenameInput}
                    defaultValue={entry.name}
                    spellCheck={false}
                    onClick={(event) => { event.stopPropagation() }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') { event.preventDefault(); commitRename(entry.path, (event.target as HTMLInputElement).value) }
                      if (event.key === 'Escape') { event.preventDefault(); setRenamingPath(null) }
                    }}
                    onBlur={(event) => { commitRename(entry.path, event.target.value) }}
                  />
                )
                : <span className={css.explorerName}>{entry.name}</span>}
              {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
              {rowActions(entry)}
            </div>
            {creating !== null && creating.parent === entry.path && creating.isDir && (
              <div className={css.explorerRow} style={{ paddingLeft: (depth + 1) * 22 + 6 }}>
                <IconFolderClose16 size={14} />
                <input
                  ref={createInputRef}
                  className={css.explorerRenameInput}
                  placeholder={t('newFolder')}
                  spellCheck={false}
                  onClick={(event) => { event.stopPropagation() }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); commitCreate(entry.path, true, (event.target as HTMLInputElement).value) }
                    if (event.key === 'Escape') { event.preventDefault(); setCreating(null) }
                  }}
                  onBlur={(event) => { commitCreate(entry.path, true, event.target.value) }}
                />
              </div>
            )}
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        )
      }
      return (
        <div
          key={entry.path}
          role="button"
          tabIndex={0}
          className={clsx(css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken)}
          style={{ paddingLeft: depth * 22 + 6 }}
          title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
          onClick={() => { onOpenFile(entry.path) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpenFile(entry.path)
            }
          }}
          onContextMenu={(event) => { openRowMenu(event, entry.path, false) }}
        >
          <IconCodeOutline16 size={14} />
          {renamingPath === entry.path
            ? (
              <input
                ref={renameInputRef}
                className={css.explorerRenameInput}
                defaultValue={entry.name}
                spellCheck={false}
                onClick={(event) => { event.stopPropagation() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); commitRename(entry.path, (event.target as HTMLInputElement).value) }
                  if (event.key === 'Escape') { event.preventDefault(); setRenamingPath(null) }
                }}
                onBlur={(event) => { commitRename(entry.path, event.target.value) }}
              />
            )
            : <span className={css.explorerName}>{entry.name}</span>}
          {entry.isSymlink && <IconLinkOutline16 size={12} className={css.explorerSymlink} />}
          {rowActions(entry)}
        </div>
      )
    })
  }

  return (
    <div className={css.explorerBody}>
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          <div
            className={css.explorerRow}
            style={{ paddingLeft: 6 }}
            onContextMenu={(event) => { openRowMenu(event, root, true) }}
          >
            <IconFolderOpen16 size={14} />
            <span className={css.explorerName}>{baseName(root)}</span>
            {copiedPath === root
              ? <span className={css.explorerCopied}>{t('copied')}</span>
              : (
                <div className={css.explorerRowActions}>
                  <button
                    type="button"
                    className={css.explorerRef}
                    aria-label={t('referenceFile')}
                    title={t('referenceFile')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onReferenceFile(root)
                    }}
                  >
                    {t('referenceFile')}
                  </button>
                  <button
                    type="button"
                    className={css.explorerMore}
                    aria-label={t('more') || 'More'}
                    title={t('more') || 'More options'}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      setRowMenu({
                        path: root,
                        isDir: true,
                        x: rect.left,
                        y: rect.bottom + 4,
                      })
                    }}
                  >
                    <IconEllipsisOutline16 size={14} />
                  </button>
                </div>
              )}
          </div>
          {data[root] !== undefined && renderLevel(root, 1)}
        </>
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutline16 size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpen16 size={14} /> }]
            : []),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutline16 size={14} /> }]
            : []),
          // File-system operations (enpoi-fs-ops).
          ...(onFsOp !== undefined && rowMenu !== null
            ? [
              ...(rowMenu.isDir
                ? [
                  { id: 'new-file', label: t('newFile'), icon: <IconCodeOutline16 size={14} /> },
                  { id: 'new-folder', label: t('newFolder'), icon: <IconFolderOpen16 size={14} /> },
                ]
                : []),
              { id: 'rename', label: t('rename'), icon: <IconCopyOutline16 size={14} /> },
              { id: 'delete', label: t('delete'), icon: <IconDownloadOutline16 size={14} /> },
            ]
            : []),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutline16 size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutline16 size={14} /> },
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'new-file') {
            setCreating({ parent: target.path, isDir: false })
            return
          }
          if (id === 'new-folder') {
            setCreating({ parent: target.path, isDir: true })
            return
          }
          if (id === 'rename') {
            setRenamingPath(target.path)
            return
          }
          if (id === 'delete') {
            confirmDelete(target.path, target.isDir)
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />
      {/* Root-level create inputs (new file / folder at the workspace root). */}
      {creating !== null && creating.parent === root && (
        <div className={css.explorerRow} style={{ paddingLeft: 6 }}>
          {creating.isDir ? <IconFolderClose16 size={14} /> : <IconCodeOutline16 size={14} />}
          <input
            ref={createInputRef}
            className={css.explorerRenameInput}
            placeholder={creating.isDir ? t('newFolder') : t('newFile')}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitCreate(root, creating.isDir, (event.target as HTMLInputElement).value) }
              if (event.key === 'Escape') { event.preventDefault(); setCreating(null) }
            }}
            onBlur={(event) => { commitCreate(root, creating.isDir, event.target.value) }}
          />
        </div>
      )}
    </div>
  )
}
