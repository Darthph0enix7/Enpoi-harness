/**
 * Management of model visibility in the model picker (hidden models store).
 *
 * Models can be hidden/shown per provider from the Models Settings page.
 * The state is persisted in localStorage and synchronizes across all components
 * (Settings page and Composer ModelSelect) via reactive DOM events.
 */

const STORAGE_KEY = 'dsh_hidden_models_v1'
const EVENT_NAME = 'dsh:hidden-models-changed'

type HiddenMap = Record<string, string[]> // provider -> array of hidden model IDs

function readStore(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as HiddenMap
  } catch {}
  return {}
}

function persistToServer(map: HiddenMap): void {
  void fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: 'sync-hidden-models',
      payload: {
        ns: 'enpoi-orchestration',
        ops: [{ op: 'set', path: ['uiPreferences', 'hiddenModels'], value: map }],
      },
    }),
  }).catch(() => {})
}

function writeStore(map: HiddenMap, notifyProvider?: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { provider: notifyProvider } }))
  } catch {}
  persistToServer(map)
}

// Global server sync on module import: pulls cross-device preferences without blocking local 0ms render
if (typeof window !== 'undefined') {
  void fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: 'prime-hidden-models',
      payload: {},
    }),
  })
    .then(async (res) => {
      if (!res.ok) return
      const json: unknown = await res.json()
      const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
      const orch = Array.isArray(namespaces)
        ? (namespaces as Array<{ ns?: string; value?: { uiPreferences?: { hiddenModels?: HiddenMap } }; user?: { uiPreferences?: { hiddenModels?: HiddenMap } } }>).find(n => n.ns === 'enpoi-orchestration')
        : undefined
      const serverHidden = orch?.value?.uiPreferences?.hiddenModels ?? orch?.user?.uiPreferences?.hiddenModels
      if (serverHidden && typeof serverHidden === 'object') {
        const local = readStore()
        const merged: HiddenMap = { ...local, ...serverHidden }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
        window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: {} }))
      }
    })
    .catch(() => {})
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

/** Toggle model visibility. Returns the new hidden state. */
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
  return nextHidden
}

/** Hide all given models for a provider. */
export function hideAllModels(provider: string, modelIds: string[]): void {
  const map = readStore()
  map[provider] = [...new Set(modelIds)]
  writeStore(map, provider)
}

/** Show all models for a provider (clears hidden list). */
export function showAllModels(provider: string): void {
  const map = readStore()
  const { [provider]: _removed, ...rest } = map
  writeStore(rest, provider)
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
