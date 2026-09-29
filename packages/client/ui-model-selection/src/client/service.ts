/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { ModelCatalogDirectory } from './catalog.ts'
import { ModelDirectory, type ModelDirectoryState } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/**
 * Namespaces whose commits can move the advertised model inputs: the `llm-*`
 * provider configurations, and `enpoi-orchestration` (pool and rule
 * preferences). Any other settings commit leaves the catalog as it is, so a
 * theme or whiteboard write no longer reloads 1,393 models.
 * @param ns - the namespace named by a `settings/document-updated` event.
 * @returns whether the event can change the model catalog.
 */
function affectsModelCatalog(ns: string): boolean {
  return ns.startsWith('llm-') || ns === 'enpoi-orchestration'
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Directories keyed by Client binding, removed by their scope disposer. */
  readonly directories: WeakMapWithValues<SessionBinding, ModelDirectory>
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['sessions', 'remote', 'remote.session']

  private readonly live: LiveState = { directories: new WeakMapWithValues() }
  /** The shared Host-generation catalog; global surfaces (e.g. Fleet Routing)
   * read it directly when no session directory exists. */
  readonly catalog: ModelCatalogDirectory
  /**
   * The session-less composer seat's state: the shared catalog plus the Host's
   * deployment default selection. The first-run shell renders the model picker
   * before a session exists, so this is the one directory-shaped value that
   * needs no session scope.
   */
  readonly hero: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
  })

  /**
   * @param ctx - owning root context (the service registers itself as `models`).
   */
  constructor(ctx: Context) {
    super(ctx, 'modelDirectories')
    this.catalog = new ModelCatalogDirectory(ctx)
    this.catalog.store.subscribe(() => { this.syncHero() })
    this.syncHero()
    void this.catalog.load().catch(() => { /* selectors expose the shared error */ })
    ctx.on('connection/reset', () => {
      this.catalog.resetGeneration()
      for (const directory of this.live.directories.values) directory.resetConnected()
    })
    ctx.remote.$on('llm/adapters-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('settings/document-updated', (ns) => {
      if (affectsModelCatalog(ns)) this.catalog.refresh()
    })
    ctx.remote.$on('credentials/record-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('credentials/reference-updated', () => { this.catalog.refresh() })
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const sessions = this.ctx.sessions
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const binding = sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`)
    const existing = live.directories.get(binding)
    if (existing !== undefined) return existing
    const directory = new ModelDirectory(
      this.ctx.remote.session,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.catalog,
      binding.session.projections.faceOf('modelSelection'),
    )
    live.directories.set(binding, directory)
    actx.effect(() => () => {
      directory.dispose()
      live.directories.delete(binding)
    }, 'ui-model-selection: session directory')
    return directory
  }

  /**
   * Republish the session-less seat state from the shared catalog: the Host's
   * deployment default (`kilo-auto/free` in the shipped profile) is the
   * selection the picker shows, with its effort caption, while no session
   * exists.
   */
  private syncHero(): void {
    const catalog = this.catalog.store.getSnapshot()
    const selection = catalog.value?.default ?? null
    const reasoning = selection === null ? undefined : this.catalog.reasoningFor(selection)
    const effort = selection?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    const routable = selection === null
      ? null
      : catalog.value?.groups.some(group => group.id === selection.provider
        && group.models.some(model => model.id === selection.model)) ?? false
    this.hero.set({
      current: selection,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups: catalog.value?.groups ?? [],
      failures: catalog.value?.failures ?? [],
      status: catalog.status === 'error' ? 'error' : catalog.status === 'ready' ? 'ready' : 'loading',
      pending: null,
      error: catalog.error,
    })
  }
}
