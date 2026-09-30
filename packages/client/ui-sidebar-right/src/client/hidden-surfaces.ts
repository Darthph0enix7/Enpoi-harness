/**
 * Duplicate-surface preference: right-sidebar page kinds the operator hides.
 *
 * The list lives at `enpoi-orchestration.uiPreferences.hiddenSurfaces.sidebarRight`
 * and follows the profile's client prefs pattern (ui-settings-models/hidden-models):
 * a synchronous localStorage cache the registry reads on every derivation, a
 * local publish, and `refreshFromServer` re-reading the namespace on boot and
 * after a `settings/document-updated` push. The duplicate-surface decision is
 * the default: dsh-context's Context page is hidden until an operator writes a
 * different list; an empty list restores every registered kind, no code change
 * and no reload of the plugin.
 */

/** Device-local cache of the last resolved list. */
const STORAGE_KEY = 'dsh_hidden_surfaces_sidebar_right_v1'

/** The list in force until a namespace value says otherwise (the decision). */
const DEFAULT_HIDDEN_KINDS: readonly string[] = ['dsh-context']

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

let cached: readonly string[] | undefined
let cachedSet: ReadonlySet<string> | undefined
const listeners = new Set<() => void>()

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface HiddenSurfacesNamespaceView {
  ns?: string
  value?: { uiPreferences?: { hiddenSurfaces?: { sidebarRight?: unknown } } }
  user?: { uiPreferences?: { hiddenSurfaces?: { sidebarRight?: unknown } } }
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

/** The hidden kinds, preferring the cache; the default stands until one lands. */
function hiddenKinds(): readonly string[] {
  if (cached !== undefined) return cached
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
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
  cached = DEFAULT_HIDDEN_KINDS
  return cached
}

/** Publish one list to the cache and every subscriber; an unchanged list is a no-op. */
function publish(list: readonly string[]): void {
  const current = hiddenKinds()
  if (current.length === list.length && current.every((kind, index) => kind === list[index])) return
  cached = [...list]
  cachedSet = undefined
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached))
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

/**
 * Re-read the namespace and adopt the operator's list (cross-device sync). A
 * namespace without a `hiddenSurfaces` value keeps the last local snapshot, so
 * the shipped default stands until an operator writes the preference; a
 * `hiddenSurfaces` object without a `sidebarRight` list means nothing is hidden.
 */
export async function refreshHiddenSurfaces(): Promise<void> {
  const seq = ++describeSeq
  try {
    const view = await describeNamespace()
    // A newer refresh started while this one was in flight: its answer wins.
    if (seq !== describeSeq || view === undefined) return
    const prefs = view.value?.uiPreferences ?? view.user?.uiPreferences
    const surfaces = prefs?.hiddenSurfaces
    if (surfaces === undefined || surfaces === null || typeof surfaces !== 'object') return
    const raw = surfaces.sidebarRight
    // An absent list means the operator hides nothing; a present-but-foreign
    // value keeps the last snapshot instead of silently un-hiding.
    if (raw === undefined) { publish([]); return }
    const list = parseList(raw)
    if (list !== undefined) publish(list)
  } catch {
    // Offline or malformed answer: the last snapshot stays until the next push.
  }
}

/**
 * The page kinds the right sidebar must not surface.
 * @returns the hidden kinds in force.
 */
export function getHiddenSidebarRightKinds(): ReadonlySet<string> {
  if (cachedSet === undefined) cachedSet = new Set(hiddenKinds())
  return cachedSet
}

/**
 * Whether one page kind is hidden right now.
 * @param kind - the registered tab kind.
 * @returns whether the kind is hidden.
 */
export function isSidebarRightKindHidden(kind: string): boolean {
  return getHiddenSidebarRightKinds().has(kind)
}

/**
 * Observe hidden-list changes (the boot read, a push-triggered re-read).
 * @param listener - synchronous invalidation callback.
 * @returns unsubscribe callback.
 */
export function subscribeHiddenSurfaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Global server sync on module import: the cache serves the first paint.
if (typeof window !== 'undefined') {
  void refreshHiddenSurfaces()
}
