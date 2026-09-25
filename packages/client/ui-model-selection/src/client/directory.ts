/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Read the optional group id off a selection, ignoring non-string wiring. */
function chainOf(selection: ModelSelection): string | undefined {
  const chain = selection.chain
  return typeof chain === 'string' && chain !== '' ? chain : undefined
}

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Saved selection, retained even when its provider or model leaves the catalog. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending: ModelSelection | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The choice reaches
   * the shared current immediately (optimistic), so both entries and a
   * remounting seat show it without waiting for the Host; the answer replaces
   * it, and a rejection restores the previous selection while surfacing the
   * failure on the store and returning it to the caller. A selection may carry
   * a model-group id (`chain`); a Host that refuses the unknown field is retried
   * without it, so the concrete provider/model selection still applies.
   * @param selection - provider, provider-owned model id, optional adapter-owned effort, optional group id.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const generation = ++this.generation
    const prevCurrent = this.store.getSnapshot().current
    const chainId = chainOf(selection)
    const optimistic: ModelSelection = chainId === undefined
      ? selection
      : { ...selection, chain: chainId }
    this.store.update((s) => {
      s.current = optimistic
      s.routable = true
      s.status = 'selecting'
      s.pending = selection
      s.error = null
    })
    try {
      const { result, chainAccepted } = await this.selectOnHost(selection, chainId)
      if (this.disposed || generation !== this.generation) {
        return result.ok ? { ok: true, value: undefined } : result
      }
      if (!result.ok) {
        this.store.update((s) => {
          s.current = prevCurrent
          s.status = 'error'
          s.pending = null
          s.error = `${result.error.code}: ${result.error.message}`
        })
        return result
      }
      const accepted: ModelSelection = chainAccepted && chainId !== undefined
        ? { ...result.value.selected, chain: chainId }
        : result.value.selected
      this.store.update((s) => {
        s.current = accepted
        s.routable = true
        s.status = 'ready'
        s.pending = null
        s.error = null
      })
    } catch (err: unknown) {
      if (!this.disposed && generation === this.generation) {
        this.store.update((s) => {
          s.current = prevCurrent
          s.status = 'error'
          s.pending = null
          s.error = err instanceof Error ? err.message : String(err)
        })
      }
      throw err
    }
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Submit one selection to the Host, carrying the optional group id. The
   * request object is extended at the wire boundary (the selection lane adds
   * `chain` to the request type); a Host that does not admit the field refuses
   * the call, and that refusal is retried without it so the concrete
   * provider/model selection still takes effect.
   */
  private async selectOnHost(
    selection: ModelSelection,
    chain: string | undefined,
  ): Promise<{
    result: RemoteResult<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
    chainAccepted: boolean
  }> {
    const base = {
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
    if (chain === undefined) {
      return { result: await this.sessions.selectModel(base), chainAccepted: false }
    }
    const first = await this.sessions.selectModel({ ...base, chain })
    if (first.ok) return { result: first, chainAccepted: true }
    return { result: await this.sessions.selectModel(base), chainAccepted: false }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const intended = projected?.next ?? catalog.value?.default
    const reasoning = intended === undefined ? undefined : this.catalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      this.store.set({
        current: catalog.value === null ? null : this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups: catalog.value?.groups ?? [],
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
      })
      return
    }
    const selection = projected.next ?? catalog.value.default
    const routable = catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
