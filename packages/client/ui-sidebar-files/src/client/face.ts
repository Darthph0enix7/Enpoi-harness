/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's workspace-relative path as well,
 * which the tree has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import type { WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'
import { FsOpsError } from './fsops.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list`, exactly as the Host's generated client declares it.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/**
 * The absolute path of one entry's parent directory.
 *
 * Both separators cut, so a Windows path's segments end where its own do. A
 * path with no separator has no parent to name and comes back unchanged.
 * @param path - absolute path of an entry.
 * @returns the directory holding it.
 */
export function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (at < 0) return path
  if (at === 0) return trimmed.slice(0, 1)
  return trimmed.slice(0, at)
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root, or the operator document directory.
   * @param signal - the tab record's lifetime.
   * @param operator - whether the root is the operator document view: levels list through
   *   the fenced fs routes and watches are replaced by manual reload.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal, operator?: boolean) => void
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
}

/**
 * The operator document listing, bound to the profile's fenced `/sidebar/fsops`
 * routes. The route refuses any directory outside the settings document's own
 * directory, so the tree's root override cannot become a general filesystem
 * browser; a refusal reaches the level as its failure line.
 */
export type ListOperatorDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => Promise<DirLevel>

/**
 * The operator view's watch: readiness only, no invalidation stream.
 *
 * The workspace watcher is workspace-scoped and would report every operator
 * directory as outside the workspace; the operator view therefore re-lists on
 * its reload control alone, while the editor keeps its own stat poll for the
 * document it saves.
 * @param _path - unused; the fs route carries its own grant.
 * @param signal - node lifetime; ends the idle wait.
 * @returns a stream that announces readiness and stays silent until abort.
 */
export function inertWatch(_path: string, signal: AbortSignal): AsyncIterable<'ready' | 'change'> {
  return (async function* () {
    if (signal.aborted) return
    yield 'ready' as const
    await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  })()
}

/** One thrown fs-route failure as the tree's failure vocabulary. */
function failureOf(error: unknown, path: string): RemoteFailure {
  if (error instanceof RemoteError) return error
  if (error instanceof FsOpsError) {
    if (error.code === 'not-found') return new RemoteError('workspace-file/not-found', error.message, { path })
    if (error.code === 'not-text') return new RemoteError('workspace-file/not-text', error.message, { path })
  }
  return new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {})
}

/**
 * Bind the tree's face to one directory listing.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @param listOperator - the fenced fs-routes listing used by the operator document view.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
  listOperator: ListOperatorDirectory,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    /** Per tab, per absolute path: the listing generation a settlement must match; the latest request wins. */
    const generations = new Map<TabId, Map<string, number>>()
    /** Operator-rooted tabs: their levels come from the fs routes, never the workspace Remote. */
    const operatorTabs = new Set<TabId>()
    const roots = new Map<TabId, DirectoryNode>()
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      const settled = operatorTabs.has(tabId)
        ? listOperator(sessionId, path, signal)
        : list(sessionId, path, signal).then((result) => {
          if (!result.ok) throw result.error
          return result.value
        })
      return settled.then((level): DirLevel | undefined => {
        // A newer listing of this level was asked for since, or the record is
        // gone and its bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return undefined
        actions.loaded(tabId, path, level)
        return level
      }, (error: unknown): undefined => {
        if (signal.aborted || generations.get(tabId)?.get(path) !== generation) return undefined
        actions.failed(tabId, path, failureOf(error, path))
        return undefined
      })
    }
    return {
      refresh: (tabId) => { void roots.get(tabId)?.refreshTree() },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        roots.get(tabId)?.setAutomatic(enabled)
      },
      start(tabId, root, signal, operator = false) {
        if (operator) operatorTabs.add(tabId)
        else operatorTabs.delete(tabId)
        actions.start(tabId, root, operator)
        signal.addEventListener('abort', () => {
          void roots.get(tabId)?.close()
          roots.delete(tabId)
          generations.delete(tabId)
          operatorTabs.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        roots.set(tabId, new DirectoryNode(root,
          (path, lifetime) => load(tabId, path, lifetime),
          operator ? inertWatch : (path, lifetime) => watch(sessionId, path, lifetime),
          (path, error) => {
            if (!signal.aborted) actions.failed(tabId, path, failureOf(error, path))
          }, signal,
        ).open())
      },
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const root = roots.get(tabId)
        if (root === undefined) return
        const parent = root.find(parentPath)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        root.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
