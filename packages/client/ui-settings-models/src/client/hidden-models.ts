/**
 * Management of model visibility in the model picker (hidden & shown models store).
 *
 * Models can be hidden/shown per provider from the Models Settings page.
 * The state is persisted in the `enpoi-orchestration.uiPreferences.hiddenModels`
 * and `enpoi-orchestration.uiPreferences.shownModels` settings keys and
 * synchronizes across all components (Settings page and Composer ModelSelect)
 * via reactive DOM events.
 *
 * All local state updates are 0ms synchronous for an instantaneous UI feel.
 * Network persistence is serialized and debounced per provider so rapid toggles
 * coalesce into a single fenced write, never race, and never bounce from
 * intermediate server echoes.
 */

import { canonicalizeHiddenMap, withHiddenList } from './hidden-map.ts'

const STORAGE_KEY = 'dsh_hidden_models_v1'
const SHOWN_STORAGE_KEY = 'dsh_shown_models_v1'
const EVENT_NAME = 'dsh:hidden-models-changed'
/** Conflict retries after the first attempt; the write then reports failure. */
const MAX_WRITE_RETRIES = 3
const FLUSH_DEBOUNCE_MS = 50

type HiddenMap = Record<string, string[]> // provider -> array of hidden model IDs
/** Explicitly shown map: same wire form as {@link HiddenMap}, separate setting key. */
type ShownMap = Record<string, string[]> // provider -> array of explicitly shown model IDs

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface HiddenModelsNamespaceView {
  ns?: string
  /** Monotonic revision the namespace was read at; the whole-map write fence. */
  revision?: number
  value?: { uiPreferences?: { hiddenModels?: HiddenMap; shownModels?: HiddenMap } }
  user?: { uiPreferences?: { hiddenModels?: HiddenMap; shownModels?: HiddenMap } }
}

/** Providers with a local write in flight or pending; their optimistic value wins over a refresh. */
const pendingProviders = new Set<string>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
const writeQueues = new Map<string, Promise<void>>()

/**
 * One operator visibility action, persisted as a delta against the fresh
 * server map rather than as a whole-list replacement: a local mirror that has
 * not merged another client's change yet must never drop that change when this
 * client writes its own. Intents are idempotent, so a conflict retry may
 * re-apply the same list safely.
 */
type VisibilityIntent =
  | { kind: 'set'; modelId: string; hidden: boolean }
  | { kind: 'hideAll'; ids: readonly string[] }
  | { kind: 'showAll'; ids: readonly string[] }

/** Per-provider queue of operator actions awaiting persistence, in click order. */
const pendingIntents = new Map<string, VisibilityIntent[]>()

function readStore(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as HiddenMap
  } catch {}
  return {}
}

function readShownStore(): HiddenMap {
  try {
    const raw = localStorage.getItem(SHOWN_STORAGE_KEY)
    if (raw) return JSON.parse(raw) as HiddenMap
  } catch {}
  return {}
}

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

/** Read the enpoi-orchestration namespace through the wire root's shared coalesced describe when present. */
async function describeHiddenModels(): Promise<HiddenModelsNamespaceView | undefined> {
  const shared = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  if (typeof shared === 'function') {
    const value = await (shared as () => Promise<{ namespaces?: readonly unknown[] } | undefined>)()
    const namespaces = value?.namespaces
    return Array.isArray(namespaces)
      ? (namespaces as HiddenModelsNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
      : undefined
  }
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

/** Publish maps to localStorage and notify subscribers (no server write). */
function publishLocal(hiddenMap: HiddenMap, shownMap: ShownMap, notifyProvider?: string): void {
  let changed = false
  try {
    const hiddenSerialized = JSON.stringify(hiddenMap)
    if (localStorage.getItem(STORAGE_KEY) !== hiddenSerialized) {
      localStorage.setItem(STORAGE_KEY, hiddenSerialized)
      changed = true
    }
    const shownSerialized = JSON.stringify(shownMap)
    if (localStorage.getItem(SHOWN_STORAGE_KEY) !== shownSerialized) {
      localStorage.setItem(SHOWN_STORAGE_KEY, shownSerialized)
      changed = true
    }
  } catch {
    // Storage disabled: dispatch anyway; readers tolerate a failed read as an
    // empty map, so nothing here can keep the optimistic value alive.
    changed = true
  }
  if (!changed) return
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { provider: notifyProvider } }))
  } catch {}
}

/**
 * Re-read the namespace and merge the server maps into local ones
 * (cross-client live sync). Providers with an in-flight local write keep their
 * optimistic value; every other provider follows the server.
 */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await describeHiddenModels()
    if (view === undefined) return
    const serverHidden = view.value?.uiPreferences?.hiddenModels ?? view.user?.uiPreferences?.hiddenModels
    const serverShown = view.value?.uiPreferences?.shownModels ?? view.user?.uiPreferences?.shownModels

    const localHidden = readStore()
    const localShown = readShownStore()

    // The server map is authoritative for every settled provider (this is how a
    // removal on another client propagates); only providers with a pending
    // local write keep their optimistic value until that write settles.
    let mergedHidden: HiddenMap = isRecord(serverHidden)
      ? (canonicalizeHiddenMap({ ...serverHidden }) as HiddenMap)
      : localHidden
    let mergedShown: ShownMap = isRecord(serverShown)
      ? (canonicalizeHiddenMap({ ...serverShown }) as ShownMap)
      : localShown

    for (const provider of pendingProviders) {
      if (Object.hasOwn(localHidden, provider)) mergedHidden[provider] = localHidden[provider] as string[]
      else {
        const { [provider]: _forgotten, ...rest } = mergedHidden
        mergedHidden = rest
      }
      if (Object.hasOwn(localShown, provider)) mergedShown[provider] = localShown[provider] as string[]
      else {
        const { [provider]: _forgotten, ...rest } = mergedShown
        mergedShown = rest
      }
    }
    publishLocal(mergedHidden, mergedShown)
  } catch {
    // Offline or malformed answer: the last local snapshot stays until the next push.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One mutate answer: whether it persisted, and whether the revision fence refused it. */
interface MutationOutcome {
  ok: boolean
  conflict: boolean
}

/** Post hidden and shown model maps with the read revision as the write fence. */
async function mutateVisibilityPreferences(
  hiddenMap: HiddenMap,
  shownMap: ShownMap,
  expectedRevision: number | undefined,
): Promise<MutationOutcome> {
  const ops: Array<{ op: 'set'; path: string[]; value: unknown }> = [
    { op: 'set', path: ['uiPreferences', 'hiddenModels'], value: hiddenMap },
    // Always written, empty included: clearing the last shown pin must reach the
    // server, and a missing op would leave the stale server map in place.
    { op: 'set', path: ['uiPreferences', 'shownModels'], value: shownMap },
  ]
  const args: Record<string, unknown> = {
    ns: 'enpoi-orchestration',
    ops,
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
    const json = (await res.json()) as { result?: { ok?: boolean; error?: { code?: string } } }
    if (json?.result?.ok === true) return { ok: true, conflict: false }
    return { ok: false, conflict: json?.result?.error?.code === 'settings/conflict' }
  } catch {
    return { ok: false, conflict: false }
  }
}

/**
 * Persist queued visibility changes with atomic read-modify-write retries.
 * Every attempt re-reads the live maps and re-applies the queued operator
 * intents onto that fresh value, so concurrent changes from other clients
 * survive. The queue is consumed only by a confirmed write: a failed flush
 * keeps both the intents and the provider's pending mark, so the operator's
 * optimistic state survives refreshes and the next flush retries the queue.
 */
async function persistVisibilityPreferences(provider: string): Promise<void> {
  const queue = pendingIntents.get(provider)
  /* v8 ignore next -- queueIntent creates the entry before any flush; only a confirmed write inside this chain deletes it. */
  if (queue === undefined || queue.length === 0) return
  const intents = [...queue]
  for (let attempt = 0; attempt <= MAX_WRITE_RETRIES; attempt++) {
    const view = await describeHiddenModels()
    if (view === undefined) return
    const freshHidden = (view.value?.uiPreferences?.hiddenModels ?? view.user?.uiPreferences?.hiddenModels ?? {}) as HiddenMap
    const freshShown = (view.value?.uiPreferences?.shownModels ?? view.user?.uiPreferences?.shownModels ?? {}) as ShownMap

    const { hidden, shown } = applyVisibilityIntents(freshHidden, freshShown, provider, intents)
    const targetHidden = withHiddenList(freshHidden, provider, hidden) as HiddenMap
    const targetShown = withHiddenList(freshShown, provider, shown) as ShownMap

    const outcome = await mutateVisibilityPreferences(targetHidden, targetShown, view.revision)
    if (outcome.ok) {
      queue.splice(0, intents.length)
      if (queue.length === 0) pendingIntents.delete(provider)
      return
    }
    if (!outcome.conflict) return
    // A refused revision retries against a fresh read; anything else keeps the
    // queue for the next flush so the operator's change is never dropped.
  }
}

/**
 * Apply one provider's queued operator intents onto fresh server lists.
 * hide-all unions the ids into hidden and clears the shown pins; show-all
 * clears hidden and unions the ids into shown; a per-model set writes the
 * model into exactly one map.
 * @param freshHidden - the live hidden map.
 * @param freshShown - the live shown map.
 * @param provider - the provider route key.
 * @param intents - the operator actions to apply, in click order.
 * @returns the provider's next hidden and shown lists.
 */
function applyVisibilityIntents(
  freshHidden: HiddenMap,
  freshShown: ShownMap,
  provider: string,
  intents: readonly VisibilityIntent[],
): { hidden: string[]; shown: string[] } {
  const hidden = new Set(freshHidden[provider] ?? [])
  const shown = new Set(freshShown[provider] ?? [])
  for (const intent of intents) {
    if (intent.kind === 'set') {
      if (intent.hidden) {
        hidden.add(intent.modelId)
        shown.delete(intent.modelId)
      } else {
        hidden.delete(intent.modelId)
        shown.add(intent.modelId)
      }
      continue
    }
    if (intent.kind === 'hideAll') {
      for (const id of intent.ids) hidden.add(id)
      shown.clear()
      continue
    }
    hidden.clear()
    for (const id of intent.ids) shown.add(id)
  }
  return { hidden: [...hidden], shown: [...shown] }
}

/**
 * Queue one operator intent for the provider and arm its debounced flush.
 * @param provider - the provider route key.
 * @param intent - the operator action to persist.
 */
function queueIntent(provider: string, intent: VisibilityIntent): void {
  const queue = pendingIntents.get(provider)
  if (queue === undefined) pendingIntents.set(provider, [intent])
  else queue.push(intent)
  schedulePersist(provider)
}

/**
 * Schedule a debounced serialized flush for one provider.
 */
function schedulePersist(provider: string): void {
  pendingProviders.add(provider)
  const existingTimer = flushTimers.get(provider)
  if (existingTimer !== undefined) clearTimeout(existingTimer)
  flushTimers.set(
    provider,
    setTimeout(() => {
      flushTimers.delete(provider)
      const previousChain = writeQueues.get(provider) ?? Promise.resolve()
      const nextChain = previousChain
        .then(async () => {
          await persistVisibilityPreferences(provider)
        })
        .catch(() => {})
        .finally(() => {
          if (writeQueues.get(provider) === nextChain) {
            writeQueues.delete(provider)
            const queued = pendingIntents.get(provider)
            // A failed flush leaves its queue behind: the provider stays
            // pending so the optimistic value survives refreshes until a write
            // confirms it.
            if (!flushTimers.has(provider) && (queued === undefined || queued.length === 0)) {
              pendingProviders.delete(provider)
            }
          }
        })
      writeQueues.set(provider, nextChain)
    }, FLUSH_DEBOUNCE_MS),
  )
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

/** Check if a model is explicitly shown. */
export function isModelShown(provider: string, modelId: string): boolean {
  const map = readShownStore()
  const list = map[provider]
  return Array.isArray(list) && list.includes(modelId)
}

/** Get all hidden model IDs for a provider. */
export function getHiddenModels(provider: string): Set<string> {
  const map = readStore()
  const list = map[provider]
  return new Set(Array.isArray(list) ? list : [])
}

/** Get all explicitly shown model IDs for a provider. */
export function getShownModels(provider: string): Set<string> {
  const map = readShownStore()
  const list = map[provider]
  return new Set(Array.isArray(list) ? list : [])
}

/**
 * Toggle model visibility explicitly.
 * If currently hidden -> unhide/show (removes from hidden, adds to shown).
 * If currently visible -> hide (removes from shown, adds to hidden).
 * @param provider - the provider id.
 * @param modelId - the model to toggle.
 * @param currentlyHidden - whether the model is currently perceived as hidden.
 * @returns the new hidden state.
 */
export function toggleModelVisibility(provider: string, modelId: string, currentlyHidden: boolean): boolean {
  const hiddenMap = readStore()
  const shownMap = readShownStore()

  const hiddenList = new Set(hiddenMap[provider] ?? [])
  const shownList = new Set(shownMap[provider] ?? [])

  let nextHidden: boolean
  if (currentlyHidden) {
    // Unhide / show:
    hiddenList.delete(modelId)
    shownList.add(modelId)
    nextHidden = false
  } else {
    // Hide:
    shownList.delete(modelId)
    hiddenList.add(modelId)
    nextHidden = true
  }

  const nextHiddenMap = withHiddenList(hiddenMap, provider, [...hiddenList]) as HiddenMap
  const nextShownMap = withHiddenList(shownMap, provider, [...shownList]) as ShownMap

  publishLocal(nextHiddenMap, nextShownMap, provider)
  queueIntent(provider, { kind: 'set', modelId, hidden: nextHidden })
  return nextHidden
}

/**
 * Toggle model visibility (backwards compatibility).
 * @param provider - the provider id.
 * @param modelId - the model to toggle.
 * @returns the new hidden state.
 */
export function toggleModelHidden(provider: string, modelId: string): boolean {
  const currentlyHidden = isModelHidden(provider, modelId)
  return toggleModelVisibility(provider, modelId, currentlyHidden)
}

/**
 * Hide all given models for a provider.
 * @param provider - the provider id.
 * @param modelIds - the models to hide.
 */
export function hideAllModels(provider: string, modelIds: string[]): void {
  const hiddenMap = readStore()
  const shownMap = readShownStore()
  const ids = [...new Set(modelIds)]

  const nextHiddenMap = withHiddenList(hiddenMap, provider, ids) as HiddenMap
  const nextShownMap = withHiddenList(shownMap, provider, []) as ShownMap

  publishLocal(nextHiddenMap, nextShownMap, provider)
  queueIntent(provider, { kind: 'hideAll', ids })
}

/**
 * Show all models for a provider (clears hidden list, records shown list).
 * @param provider - the provider id.
 * @param modelIds - the models to show explicitly.
 */
export function showAllModels(provider: string, modelIds: string[] = []): void {
  const hiddenMap = readStore()
  const shownMap = readShownStore()
  const ids = [...new Set(modelIds)]

  const nextHiddenMap = withHiddenList(hiddenMap, provider, []) as HiddenMap
  const nextShownMap = withHiddenList(shownMap, provider, ids) as ShownMap

  publishLocal(nextHiddenMap, nextShownMap, provider)
  queueIntent(provider, { kind: 'showAll', ids })
}

/**
 * Drop one provider's visibility pins from local mirrors without a server write.
 * @param provider - the removed provider id.
 */
export function forgetHiddenProvider(provider: string): void {
  const { [provider]: _hidden, ...hiddenRest } = readStore()
  const { [provider]: _shown, ...shownRest } = readShownStore()
  publishLocal(hiddenRest, shownRest, provider)
}

/** Subscribe to model visibility changes. Returns cleanup function. */
export function subscribeHiddenModels(onChange: (provider?: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ provider?: string }>).detail
    onChange(detail?.provider)
  }
  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === SHOWN_STORAGE_KEY) onChange()
  }
  window.addEventListener(EVENT_NAME, handler)
  window.addEventListener('storage', storageHandler)
  return () => {
    window.removeEventListener(EVENT_NAME, handler)
    window.removeEventListener('storage', storageHandler)
  }
}
