/**
 * Catalog-backed model picker face for the group editor.
 *
 * The Providers page is session-less, so the link editor reuses the shared
 * picker's global catalog directory (`ctx.modelDirectories.catalog`) instead of
 * a per-session directory. Choosing a model in this face only fills an editor
 * draft — it never submits a session selection.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ModelDirectoryResolver, ModelDirectoryState,
} from '@deepseek-ai/dsh-client-ui-model-selection/client'

/** The picker inputs the group editor renders against. */
export interface ModelPickerFace {
  available: true
  directory: SnapshotStore<ModelDirectoryState>
  load: () => void
}

/**
 * Map the global model catalog onto the directory state the shared picker
 * consumes. The derived store is read-only; selections route to the editor
 * draft through the picker's override face.
 * @param catalog - the global catalog directory owned by ui-model-selection.
 * @returns the directory face plus a disposer for its catalog subscription.
 */
export function createCatalogPickerFace(
  catalog: ModelDirectoryResolver['catalog'],
): { face: ModelPickerFace; dispose: () => void } {
  const directory = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })
  const publish = (): void => {
    const current = catalog.store.getSnapshot()
    directory.set({
      current: current.value?.default ?? null,
      routable: null,
      groups: current.value?.groups ?? [],
      failures: current.value?.failures ?? [],
      status: current.status,
      error: current.error,
    })
  }
  const unsubscribe = catalog.store.subscribe(publish)
  publish()
  return {
    face: {
      available: true,
      directory,
      load: () => { catalog.load().catch(() => { /* surfaced on the shared catalog store */ }) },
    },
    dispose: unsubscribe,
  }
}
