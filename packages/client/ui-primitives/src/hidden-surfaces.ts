/**
 * Parameterized duplicate-surface preference shared by the profile's view
 * rosters (the conversation tab strip and the right sidebar).
 *
 * One partition names its device-local cache key, the list in force until an
 * operator writes one, and the `enpoi-orchestration.uiPreferences.hiddenSurfaces`
 * field it reads. The namespace read follows the profile's client prefs pattern
 * (ui-settings-models/hidden-models): a synchronous `localStorage` cache the
 * roster reads on every derivation, a local publish, and
 * {@link HiddenSurfaces.refreshHiddenSurfaces} re-reading the namespace on boot
 * and after a `settings/document-updated` push. An empty list restores every
 * registered surface, no code change and no reload of the plugin.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives/hidden-surfaces
 */

/** One preference partition: cache key, shipped default, and namespace field. */
export interface HiddenSurfacesConfig {
  /** `localStorage` key holding the device-local list mirror. */
  readonly storageKey: string
  /** The list in force until a namespace value says otherwise. */
  readonly defaultList: readonly string[]
  /** The `uiPreferences.hiddenSurfaces` field this partition reads. */
  readonly pick: string
}

/** One partition's live preference face, synchronous for hot derivation paths. */
export interface HiddenSurfaces {
  /**
   * Re-read the namespace and adopt the operator's list (cross-device sync). A
   * namespace without a `hiddenSurfaces` value keeps the last local snapshot;
   * a `hiddenSurfaces` object without the partition's field means nothing is
   * hidden.
   * @returns nothing; the cache and its subscribers carry the outcome.
   */
  refreshHiddenSurfaces(): Promise<void>
  /**
   * Observe hidden-list changes (the boot read, a push-triggered re-read).
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe callback.
   */
  subscribeHiddenSurfaces(listener: () => void): () => void
  /**
   * The hidden ids in force.
   * @returns the hidden ids, memoized until the list moves.
   */
  getHidden(): ReadonlySet<string>
  /**
   * Whether one registered id is hidden right now.
   * @param id - the registered surface id.
   * @returns whether the id is hidden.
   */
  isHidden(id: string): boolean
}

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface HiddenSurfacesNamespaceView {
  ns?: string
  value?: { uiPreferences?: { hiddenSurfaces?: Record<string, unknown> } }
  user?: { uiPreferences?: { hiddenSurfaces?: Record<string, unknown> } }
}

/** A list of non-empty strings, or `undefined` when the value is not one. */
function parseList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  // A non-empty array whose entries are all foreign is a corrupt payload, not an
  // empty list: "nothing hidden" must come from an explicit empty array.
  if (value.length > 0 && entries.length === 0) return undefined
  return entries
}

/**
 * Create one hidden-preference partition. Each call owns its cache, describe
 * sequence, and subscriber set, so two partitions never share or race state.
 * @param config - storage key, shipped default, and namespace field.
 * @returns the synchronous getters and the namespace refresh.
 */
export function createHiddenSurfaces(config: HiddenSurfacesConfig): HiddenSurfaces {
  /** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
  let describeSeq = 0

  let cached: readonly string[] | undefined
  let cachedSet: ReadonlySet<string> | undefined
  const listeners = new Set<() => void>()

  /** The hidden list, preferring the cache; the default stands until one lands. */
  function hidden(): readonly string[] {
    if (cached !== undefined) return cached
    try {
      const raw = localStorage.getItem(config.storageKey)
      if (raw !== null) {
        const parsed = parseList(JSON.parse(raw))
        if (parsed !== undefined) {
          cached = parsed
          return cached
        }
      }
    } catch {
      // Private mode or a foreign payload: the default stands.
    }
    cached = config.defaultList
    return cached
  }

  /** Publish one list to the cache and every subscriber; an unchanged list is a no-op. */
  function publish(list: readonly string[]): void {
    const current = hidden()
    if (current.length === list.length && current.every((entry, index) => entry === list[index])) return
    cached = [...list]
    cachedSet = undefined
    try {
      localStorage.setItem(config.storageKey, JSON.stringify(cached))
    } catch {
      // A full or unavailable store only disables the cache; the live snapshot stays.
    }
    for (const listener of listeners) listener()
  }

  /** Read the enpoi-orchestration namespace through the shared coalesced describe when the wire root installed it. */
  async function describeNamespace(): Promise<HiddenSurfacesNamespaceView | undefined> {
    const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
    if (typeof shared === 'function') {
      const value = await (shared as () => Promise<{ namespaces?: readonly unknown[] } | undefined>)()
      const namespaces = value?.namespaces
      return Array.isArray(namespaces)
        ? (namespaces as HiddenSurfacesNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
        : undefined
    }
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: `hidden-surfaces-describe-${describeSeq}`,
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json: unknown = await res.json()
    const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
    return Array.isArray(namespaces)
      ? (namespaces as HiddenSurfacesNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
      : undefined
  }

  async function refreshHiddenSurfaces(): Promise<void> {
    const seq = ++describeSeq
    try {
      const view = await describeNamespace()
      // A newer refresh started while this one was in flight: its answer wins.
      if (seq !== describeSeq || view === undefined) return
      const prefs = view.value?.uiPreferences ?? view.user?.uiPreferences
      const surfaces = prefs?.hiddenSurfaces
      if (surfaces === undefined || surfaces === null || typeof surfaces !== 'object') return
      const raw = surfaces[config.pick]
      // An absent list means the operator hides nothing; a present-but-foreign
      // value keeps the last snapshot instead of silently un-hiding.
      if (raw === undefined) { publish([]); return }
      const list = parseList(raw)
      if (list !== undefined) publish(list)
    } catch {
      // Offline or malformed answer: the last snapshot stays until the next push.
    }
  }

  function subscribeHiddenSurfaces(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  function getHidden(): ReadonlySet<string> {
    if (cachedSet === undefined) cachedSet = new Set(hidden())
    return cachedSet
  }

  function isHidden(id: string): boolean {
    return getHidden().has(id)
  }

  return { refreshHiddenSurfaces, subscribeHiddenSurfaces, getHidden, isHidden }
}
