/**
 * Model groups (`enpoi-orchestration.chains`) as the picker and the chat badge
 * consume them.
 *
 * One settings.describe primes a module-level cache at load; the
 * `dsh:model-groups-changed` window event (dispatched by the Providers editor
 * after a committed write, or by any other client that changed the registry)
 * queues a re-read. The same payload is mirrored into
 * {@link MODEL_GROUPS_STORAGE_KEY} so a surface that must not fetch settings
 * itself (the chat attribution badge) can resolve a group label synchronously.
 */

/** One ordered link of a group: a route plus the model it serves. */
export interface ModelGroupLink {
  provider: string
  model: string
  effort?: string
}

/** One user-defined failover group (settings `chains.<id>`). */
export interface ModelGroup {
  readonly id: string
  readonly label: string
  readonly links: readonly ModelGroupLink[]
  readonly attempts: number
  readonly onCut: 'failover' | 'continue'
  readonly disabled: boolean
}

/** localStorage mirror of the last loaded registry (read by ui-chat's badge). */
export const MODEL_GROUPS_STORAGE_KEY = 'dsh_model_groups_v1'

/** Window event asking every consumer to re-read the registry. */
export const MODEL_GROUPS_CHANGED_EVENT = 'dsh:model-groups-changed'

/** Parse one stored link; a link without a route/model is dropped. */
function parseLink(raw: unknown): ModelGroupLink | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== 'string' || rec.provider === '') return undefined
  if (typeof rec.model !== 'string' || rec.model === '') return undefined
  return {
    provider: rec.provider,
    model: rec.model,
    ...typeof rec.effort === 'string' && rec.effort !== '' ? { effort: rec.effort } : {},
  }
}

/** Parse one stored group; undefined when the entry names no usable id. */
export function parseModelGroup(id: string, raw: unknown): ModelGroup | undefined {
  if (id === '' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const links = Array.isArray(rec.links)
    ? rec.links.map(parseLink).filter((link): link is ModelGroupLink => link !== undefined)
    : []
  const attempts = typeof rec.attempts === 'number' && Number.isInteger(rec.attempts) && rec.attempts >= 1
    ? rec.attempts
    : 2
  return {
    id,
    label: typeof rec.label === 'string' && rec.label !== '' ? rec.label : id,
    links,
    attempts,
    onCut: rec.onCut === 'continue' ? 'continue' : 'failover',
    disabled: rec.disabled === true,
  }
}

/** Parse the stored `chains` map into registry order, dropping malformed entries. */
export function parseModelGroups(value: unknown): ModelGroup[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const groups: ModelGroup[] = []
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const group = parseModelGroup(id, raw)
    if (group !== undefined) groups.push(group)
  }
  return groups
}

let groups: readonly ModelGroup[] = []
const listeners = new Set<() => void>()
let inflight: Promise<void> | undefined
let loaded = false

/**
 * The shared coalesced `settings.describe` reader the connection wire root
 * publishes; absent in standalone bundles, where the local fetch stands in.
 * @returns the shared reader, or undefined.
 */
function sharedDescribe(): (() => Promise<{ namespaces?: readonly unknown[] } | undefined>) | undefined {
  const candidate = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  return typeof candidate === 'function'
    ? candidate as () => Promise<{ namespaces?: readonly unknown[] } | undefined>
    : undefined
}

function notify(): void {
  for (const listener of listeners) listener()
}

function publish(next: readonly ModelGroup[]): void {
  groups = next
  loaded = true
  try {
    localStorage.setItem(MODEL_GROUPS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage disabled (private mode, quota): the in-memory cache still serves.
  }
  notify()
}

/** Read the mirror a previous load wrote, for a first paint before the fetch. */
function readMirror(): readonly ModelGroup[] {
  try {
    const raw = localStorage.getItem(MODEL_GROUPS_STORAGE_KEY)
    return raw === null ? [] : parseModelGroups(JSON.parse(raw))
  } catch {
    return []
  }
}

/** Every group the registry reported, in stored order. */
export function getModelGroups(): readonly ModelGroup[] {
  if (groups.length === 0) groups = readMirror()
  return groups
}

/** Groups a picker may assign: enabled, with at least one link. */
export function assignableModelGroups(): readonly ModelGroup[] {
  return getModelGroups().filter(group => !group.disabled && group.links.length > 0)
}

/** Resolve one group by id, including disabled groups (attribution still names them). */
export function modelGroupById(id: string): ModelGroup | undefined {
  return getModelGroups().find(group => group.id === id)
}

/** Resolve a group's display label, or undefined for an unknown/dangling id. */
export function modelGroupLabel(id: string): string | undefined {
  return modelGroupById(id)?.label
}

/** Subscribe to registry replacements (returns the unsubscribe). */
export function subscribeModelGroups(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Refresh unless one load already published; resolves once the cache is usable.
 * A picker mounted before the import-time fetch settled uses this to repaint.
 * @returns a promise resolving after the registry is published (or the read failed).
 */
export function ensureModelGroups(): Promise<void> {
  return loaded ? Promise.resolve() : refreshModelGroups()
}

/**
 * Re-read `enpoi-orchestration.chains` through the live gateway.
 * @returns nothing; the cache and its subscribers carry the outcome.
 */
export function refreshModelGroups(): Promise<void> {
  if (inflight !== undefined) return inflight
  const readNamespaces = async (): Promise<unknown> => {
    const shared = sharedDescribe()
    if (shared !== undefined) return (await shared())?.namespaces
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: 'model-groups-describe',
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json: unknown = await res.json()
    const response = json as { result?: { value?: { namespaces?: unknown } } } | null
    return response?.result?.value?.namespaces
  }
  const operation = readNamespaces()
    .then((namespaces) => {
      const namespace = Array.isArray(namespaces)
        ? (namespaces as Array<{ ns?: string; value?: { chains?: unknown }; user?: { chains?: unknown } }>)
          .find(entry => entry.ns === 'enpoi-orchestration')
        : undefined
      if (namespace !== undefined) publish(parseModelGroups(namespace.value?.chains ?? namespace.user?.chains))
    })
    .catch(() => {
      // Offline answer: the last published registry stays until the next read.
    })
    .finally(() => {
      inflight = undefined
    })
  inflight = operation
  return operation
}

// Prime on import so the per-session pickers never pay the describe latency.
if (typeof window !== 'undefined') {
  void refreshModelGroups()
}
