/**
 * Management of model visibility in the model picker (hidden models store).
 *
 * Models can be hidden/shown per provider from the Models Settings page.
 * The state is persisted in the `enpoi-orchestration.uiPreferences.hiddenModels`
 * settings key and synchronizes across all components (Settings page and
 * Composer ModelSelect) via reactive DOM events. `refreshFromServer` re-reads
 * the namespace for cross-client live sync; a provider with a local write in
 * flight keeps its optimistic value until that write settles. The map is
 * written whole, so every attempt re-reads the live document, re-applies the
 * operator's change onto that fresh map, and carries the read revision as a
 * write fence; a conflict re-reads and retries.
 */

const STORAGE_KEY = 'dsh_hidden_models_v1'
const EVENT_NAME = 'dsh:hidden-models-changed'
/** Conflict retries after the first attempt; the write then reports failure. */
const MAX_WRITE_RETRIES = 3

type HiddenMap = Record<string, string[]> // provider -> array of hidden model IDs

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface HiddenModelsNamespaceView {
  ns?: string
  /** Monotonic revision the namespace was read at; the whole-map write fence. */
  revision?: number
  value?: { uiPreferences?: { hiddenModels?: HiddenMap } }
  user?: { uiPreferences?: { hiddenModels?: HiddenMap } }
}

/** Providers with a local write in flight; their optimistic value wins over a refresh. */
const pendingProviders = new Set<string>()

function readStore(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as HiddenMap
  } catch {}
  return {}
}

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeHiddenModels(): Promise<HiddenModelsNamespaceView | undefined> {
  describeSeq += 1
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `hidden-describe-${describeSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json: unknown = await res.json()
  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
  return Array.isArray(namespaces)
    ? (namespaces as HiddenModelsNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
    : undefined
}

/** Publish one map to localStorage and notify subscribers (no server write). */
function publishLocal(map: HiddenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: {} }))
  } catch {}
}

/**
 * Re-read the namespace and merge the server map into the local one
 * (cross-client live sync). Providers with an in-flight local write keep their
 * optimistic value; every other provider follows the server.
 */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await describeHiddenModels()
    if (view === undefined) return
    const serverHidden = view.value?.uiPreferences?.hiddenModels ?? view.user?.uiPreferences?.hiddenModels
    if (serverHidden === undefined || typeof serverHidden !== 'object') return
    const local = readStore()
    const merged: HiddenMap = { ...local, ...serverHidden }
    for (const provider of pendingProviders) {
      if (Object.hasOwn(local, provider)) merged[provider] = local[provider] as string[]
      else delete merged[provider]
    }
    publishLocal(merged)
  } catch {
    // Offline or malformed answer: the last local snapshot stays until the next push.
  }
}

/** One mutate answer: whether it persisted, and whether the revision fence refused it. */
interface MutationOutcome {
  ok: boolean
  conflict: boolean
}

/** Post the whole hidden-model map with the read revision as the write fence. */
async function mutateHiddenModels(map: HiddenMap, expectedRevision: number | undefined): Promise<MutationOutcome> {
  const args: Record<string, unknown> = {
    ns: 'enpoi-orchestration',
    ops: [{ op: 'set', path: ['uiPreferences', 'hiddenModels'], value: map }],
  }
  if (expectedRevision !== undefined) args.expectedRevision = expectedRevision
  try {
    const res = await fetch('/api/settings.mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.mutate',
        rpcId: `hidden-mutate-${String(++describeSeq)}`,
        payload: { args },
      }),
    })
    if (!res.ok) return { ok: false, conflict: false }
    const json = await res.json() as { result?: { ok?: boolean; error?: { code?: string } } }
    if (json?.result?.ok === true) return { ok: true, conflict: false }
    return { ok: false, conflict: json?.result?.error?.code === 'settings/conflict' }
  } catch {
    // Transport failure: not a revision conflict, so the caller stops retrying.
    return { ok: false, conflict: false }
  }
}

/**
 * Persist one provider's change with read-modify-write retries: every attempt
 * re-reads the live map, re-applies `build` to that fresh value, and writes with
 * the read revision. The provider stays marked pending until the write settles.
 */
async function persistHiddenModels(
  provider: string,
  build: (fresh: HiddenMap) => HiddenMap,
): Promise<void> {
  pendingProviders.add(provider)
  try {
    for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
      const view = await describeHiddenModels()
      if (view === undefined) return
      const fresh = view.value?.uiPreferences?.hiddenModels ?? view.user?.uiPreferences?.hiddenModels ?? {}
      const outcome = await mutateHiddenModels(build(fresh), view.revision)
      if (outcome.ok) return
      // A refusal that is not a revision conflict will not clear on retry.
      if (!outcome.conflict) return
    }
  } finally {
    pendingProviders.delete(provider)
  }
}

function writeStore(map: HiddenMap, notifyProvider?: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { provider: notifyProvider } }))
  } catch {}
}

// Global server sync on module import: pulls cross-device preferences without blocking local 0ms render
if (typeof window !== 'undefined') {
  void refreshFromServer()
}

/** Check if a model is hidden from the selector. */
export function isModelHidden(provider: string, modelId: string): boolean {
  const map = readStore()
  const list = map[provider]
  return Array.isArray(list) && list.includes(modelId)
}

/** Get all hidden model IDs for a provider. */
export function getHiddenModels(provider: string): Set<string> {
  const map = readStore()
  const list = map[provider]
  return new Set(Array.isArray(list) ? list : [])
}

/**
 * Toggle model visibility. Returns the new hidden state.
 * @param provider - the provider id.
 * @param modelId - the model to toggle.
 * @returns the new hidden state.
 */
export function toggleModelHidden(provider: string, modelId: string): boolean {
  const map = readStore()
  const list = new Set(map[provider] ?? [])
  let nextHidden = false
  if (list.has(modelId)) {
    list.delete(modelId)
    nextHidden = false
  } else {
    list.add(modelId)
    nextHidden = true
  }
  map[provider] = [...list]
  writeStore(map, provider)
  void persistHiddenModels(provider, (fresh) => {
    const freshList = new Set(fresh[provider] ?? [])
    if (nextHidden) freshList.add(modelId)
    else freshList.delete(modelId)
    return { ...fresh, [provider]: [...freshList] }
  })
  return nextHidden
}

/**
 * Hide all given models for a provider.
 * @param provider - the provider id.
 * @param modelIds - the models to hide.
 */
export function hideAllModels(provider: string, modelIds: string[]): void {
  const map = readStore()
  map[provider] = [...new Set(modelIds)]
  writeStore(map, provider)
  void persistHiddenModels(provider, fresh => ({ ...fresh, [provider]: [...new Set(modelIds)] }))
}

/**
 * Show all models for a provider (clears hidden list).
 * @param provider - the provider id.
 */
export function showAllModels(provider: string): void {
  const map = readStore()
  const { [provider]: _removed, ...rest } = map
  writeStore(rest, provider)
  void persistHiddenModels(provider, (fresh) => {
    const { [provider]: _dropped, ...others } = fresh
    return others
  })
}

/** Subscribe to hidden model changes. Returns cleanup function. */
export function subscribeHiddenModels(onChange: (provider?: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ provider?: string }>).detail
    onChange(detail?.provider)
  }
  window.addEventListener(EVENT_NAME, handler)
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) onChange()
  })
  return () => {
    window.removeEventListener(EVENT_NAME, handler)
  }
}
