/**
 * Model groups (`enpoi-orchestration.chains`) as the picker, the chat badge,
 * and the Providers editor consume them.
 *
 * The settings row stays authoritative; this module never parses the raw
 * `chains` map. It reads the host's resolved-group projection
 * (`modelChains.resolved`) through the settings artifact channel
 * (`settings.describeArtifact`), so a selector-only group arrives with its
 * resolved member count, candidates, and warnings, and a disabled group
 * arrives marked disabled instead of disappearing. The revision-aware read
 * answers `changed: false` without a payload when the projection did not move.
 *
 * The `dsh:model-groups-changed` window event (dispatched by the Providers
 * editor after a committed write, or by any other client that changed the
 * registry) queues a re-read. The same payload is mirrored into
 * {@link MODEL_GROUPS_STORAGE_KEY} so a surface that must not fetch settings
 * itself (the chat attribution badge) can resolve a group label synchronously.
 *
 * The artifact parser and the `ModelGroup` types live in the shared
 * `@deepseek-ai/dsh-client-ui-primitives` owner, re-exported here.
 */
import {
  parseModelGroupList, parseModelGroups,
  type ModelGroup,
} from '@deepseek-ai/dsh-client-ui-primitives'

export { parseModelGroup, parseModelGroupList, parseModelGroups, parseResolvedModelGroup } from '@deepseek-ai/dsh-client-ui-primitives'
export type { ModelGroup, ModelGroupLink, ModelGroupSelector, ModelGroupSelectorMatch } from '@deepseek-ai/dsh-client-ui-primitives'

/** localStorage mirror of the last loaded resolved groups (read by ui-chat's badge). */
export const MODEL_GROUPS_STORAGE_KEY = 'dsh_model_groups_v1'

/** Window event asking every consumer to re-read the registry. */
export const MODEL_GROUPS_CHANGED_EVENT = 'dsh:model-groups-changed'

/** Artifact name the host publishes the resolved-group projection under. */
export const MODEL_GROUPS_ARTIFACT_KEY = 'modelChains.resolved'

let groups: readonly ModelGroup[] = []
let inflight: Promise<void> | undefined
/** A publication landed (fetch or mirror). */
let loaded = false
/** The synchronous snapshot was initialized; keeps `getSnapshot` referentially stable. */
let primed = false
/** Serialized form of the last published list; a matching read is a no-op. */
let lastSerialized: string | undefined
/** Host artifact revision already folded into the cache; absent before the first read. */
let artifactRevision: number | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One broken subscriber must not starve the others.
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(MODEL_GROUPS_CHANGED_EVENT))
  } catch {
    // No window (non-DOM caller): the in-memory cache still serves.
  }
}

function publish(next: readonly ModelGroup[]): void {
  const serialized = JSON.stringify(next)
  // A read that resolves to the list already published is a no-op: keep the
  // same reference and dispatch nothing, so consumers do not repaint and a
  // listener that re-reads cannot loop.
  if (serialized === lastSerialized) {
    loaded = true
    return
  }
  groups = next
  loaded = true
  primed = true
  lastSerialized = serialized
  try {
    localStorage.setItem(MODEL_GROUPS_STORAGE_KEY, serialized)
  } catch {
    // Storage disabled (private mode, quota): the in-memory cache still serves.
  }
  notify()
}

/** Read the mirror a previous load wrote, for a first paint before the fetch. */
function readMirror(): readonly ModelGroup[] {
  try {
    const raw = localStorage.getItem(MODEL_GROUPS_STORAGE_KEY)
    if (raw === null) return []
    const parsed = parseModelGroupList(JSON.parse(raw))
    lastSerialized = JSON.stringify(parsed)
    return parsed
  } catch {
    return []
  }
}

/**
 * Every group the projection reported, in stored order (disabled included).
 * The returned reference only moves on a publication, so it is safe as a
 * `useSyncExternalStore` snapshot.
 * @returns the current registry.
 */
export function getModelGroups(): readonly ModelGroup[] {
  if (!primed) {
    primed = true
    if (!loaded) groups = readMirror()
  }
  return groups
}

/** Subscribe to registry publications (React `useSyncExternalStore`). */
export function subscribeModelGroups(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable snapshot reader for React `useSyncExternalStore`. */
export function getModelGroupsSnapshot(): readonly ModelGroup[] {
  return getModelGroups()
}

/**
 * Groups a picker may assign: enabled, with at least one resolved member. A
 * selector-only group qualifies once its selector matches the catalogue — no
 * explicit link is required.
 */
export function assignableModelGroups(): readonly ModelGroup[] {
  return getModelGroups().filter(group => !group.disabled && group.members.length > 0)
}

/**
 * Groups a picker renders, disabled and member-less rows included: a retired
 * group stays visible (marked disabled) instead of vanishing, so an operator
 * can see why an assignment stopped resolving.
 */
export function pickerModelGroups(): readonly ModelGroup[] {
  return getModelGroups().filter(group => group.members.length > 0 || group.selectors.length > 0 || group.disabled)
}

/** Resolve one group by id, including disabled groups (attribution still names them). */
export function modelGroupById(id: string): ModelGroup | undefined {
  return getModelGroups().find(group => group.id === id)
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
 * Read the host artifact channel. `unsupported` means the host does not serve
 * `settings.describeArtifact` (a 404/405), so the projection is empty and there
 * is deliberately no raw-`chains` fallback. `unreachable` (offline, a 5xx, a
 * malformed answer) keeps the last published registry instead of wiping it.
 * @returns the changed flag with its value, or why the read did not answer.
 */
async function readArtifact(): Promise<{ changed: boolean; value?: unknown } | 'unsupported' | 'unreachable'> {
  try {
    const res = await fetch('/api/settings.describeArtifact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describeArtifact',
        rpcId: 'model-groups-artifact',
        payload: {
          args: {
            key: MODEL_GROUPS_ARTIFACT_KEY,
            ...artifactRevision === undefined ? {} : { knownRevision: artifactRevision },
          },
        },
      }),
    })
    if (!res.ok) return res.status === 404 || res.status === 405 ? 'unsupported' : 'unreachable'
    const json: unknown = await res.json()
    const result = (json as { result?: { ok?: unknown; value?: unknown } } | null)?.result
    if (result?.ok !== true || result.value === null || typeof result.value !== 'object') return 'unreachable'
    const read = result.value as { revision?: unknown; changed?: unknown; value?: unknown }
    if (typeof read.revision !== 'number' || typeof read.changed !== 'boolean') return 'unreachable'
    artifactRevision = read.revision
    return { changed: read.changed, ...read.changed ? { value: read.value } : {} }
  } catch {
    return 'unreachable'
  }
}

/**
 * Re-read the resolved-group projection.
 * @returns nothing; the cache and its event carry the outcome.
 */
export function refreshModelGroups(): Promise<void> {
  if (inflight !== undefined) return inflight
  const operation = readArtifact()
    .then((artifact) => {
      if (artifact === 'unsupported') {
        // No artifact route on this host: publish the empty projection rather
        // than reading the raw document, so no surface forks the source of truth.
        publish([])
        return
      }
      if (artifact === 'unreachable') {
        // Offline / transient: the last published registry stays until the next read.
        return
      }
      if (artifact.changed) publish(parseModelGroups(artifact.value))
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

// Prime on import so the per-session pickers never pay the artifact latency.
if (typeof window !== 'undefined') {
  void refreshModelGroups()
}
