/**
 * Global reactive in-memory cache for Enpoi persona model assignments.
 *
 * Ensures synchronous 0ms render on tab switch or session switch (zero delay,
 * zero reloading, zero 2-second fallback jumps), and hot-syncs changes to
 * the server's `enpoi-orchestration` settings namespace in the background.
 * `refreshFromServer` re-reads through the package's shared coalesced describe
 * (settings-refresh.ts: one request per burst, scheduled by the pushed
 * `settings/document-updated`, a transport reconnect, the tab becoming
 * visible, or a stale mount); a read answering the revision this store last
 * applied notifies nobody, a read that reconciles to the values already held
 * republishes nothing (no row flickers through a write's echo), and a persona
 * key with a local write in flight keeps its optimistic value until that write
 * settles. A cleared key stays an explicit `null`, so clearing one seat never
 * removes another seat's row.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { readEnpoiNamespace } from './settings-refresh.ts'

/** Persona id → explicit model selection (null = inherit); the page's snapshot value. */
export type PersonaMap = Record<string, ModelSelection | null>

let currentPersonas: PersonaMap = {}
let primed = false
const listeners = new Set<() => void>()
/** Persona keys with a local write in flight; their optimistic value wins over a refresh. */
const pendingPersonaKeys = new Set<string>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Monotonic write rpcIds: the gateway echoes the id and duplicates race. */
let writeSeq = 0

/**
 * Revision this store last applied. A later read that answers the same
 * revision carries the document this snapshot already holds, so it is skipped
 * without a notify (the snapshot identity, and every subscriber, stays put).
 */
let lastAppliedRevision: number | undefined

/** Whether two assignments carry the same route. */
function sameSelection(left: ModelSelection | null | undefined, right: ModelSelection | null | undefined): boolean {
  if (left === right) return true
  if (left === null || left === undefined || right === null || right === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.chain ?? '') === (right.chain ?? '')
    && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/** Whether two persona snapshots carry the same keys and routes. */
function samePersonas(left: PersonaMap, right: PersonaMap): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !sameSelection(left[key], right[key])) return false
  }
  return true
}

/**
 * Reconcile one server read into the snapshot by value. Keys with an in-flight
 * local write keep their optimistic value, including a key the server document
 * has not caught up with yet; every other key follows the server (so a
 * concurrent change in another client is applied). A read that carries the
 * snapshot this store already holds republishes nothing — the map identity,
 * and every row, stays put through the write's settings echo.
 * @param serverPersonas - the personas map the host just reported.
 */
function applyServerPersonas(serverPersonas: PersonaMap): void {
  const merged: PersonaMap = { ...serverPersonas }
  for (const key of pendingPersonaKeys) {
    // The pending key's own state wins: its optimistic selection, or the
    // explicit null of a local clear.
    merged[key] = currentPersonas[key] ?? null
  }
  if (samePersonas(merged, currentPersonas)) return
  currentPersonas = merged
  notify()
}

/** Re-read the namespace and merge it into the snapshot (cross-client live sync). */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await readEnpoiNamespace()
    if (view === undefined) return
    if (view.revision !== undefined && view.revision === lastAppliedRevision) return
    const personas = view.value?.personas ?? view.user?.personas
    if (personas !== undefined && typeof personas === 'object') {
      lastAppliedRevision = view.revision
      applyServerPersonas({ ...(personas as PersonaMap) })
    }
  } catch {
    // Offline or malformed answer: the last snapshot stays until the next push.
  }
}

/** Eagerly prime the global in-memory cache from host settings on boot. */
export function primePersonaAssignments(): void {
  if (primed) return
  primed = true
  void refreshFromServer()
}

// Auto-prime on module import so it's already ready before any session opens.
if (typeof window !== 'undefined') {
  primePersonaAssignments()
}

/** Synchronous snapshot reader for React useSyncExternalStore (0ms latency). */
export function getPersonaAssignments(): PersonaMap {
  return currentPersonas
}

/** Subscribe to global persona changes across sessions/tabs. */
export function subscribePersonaAssignments(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Optimistically assign an explicit model to a persona (0ms update) and persist
 * the leaf write in the background. The key stays marked pending until the
 * write settles so a concurrent refresh cannot clobber the optimistic value.
 * @param personaId - display persona id.
 * @param selection - the model selection to store.
 * @returns whether the mutation was persisted.
 */
export function setPersonaAssignment(personaId: string, selection: ModelSelection): Promise<boolean> {
  const key = personaId.toLowerCase().replace(/^the\s+/, '').trim()
  currentPersonas = { ...currentPersonas, [key]: selection }
  notify()
  pendingPersonaKeys.add(key)

  return fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `persona-set-${key}-${String(++writeSeq)}`,
      payload: {
        args: {
          ns: 'enpoi-orchestration',
          ops: [{ op: 'set', path: ['personas', key], value: selection }],
        },
      },
    }),
  })
    .then(res => res.ok)
    .catch(() => false)
    .finally(() => {
      pendingPersonaKeys.delete(key)
    })
}

/**
 * Optimistically clear an explicit assignment, reverting the persona back to
 * its fallback route (0ms update) and persisting the leaf write in the
 * background. The cleared key stays as an explicit `null` — the seat's
 * `inherit`/`builtin-default` state — and every other key, explicit null
 * included, is carried over untouched: a clear changes one seat's state and
 * can never drop another seat's row.
 * @param personaId - display persona id.
 * @returns whether the mutation was persisted.
 */
export function clearPersonaAssignment(personaId: string): Promise<boolean> {
  const key = personaId.toLowerCase().replace(/^the\s+/, '').trim()
  currentPersonas = { ...currentPersonas, [key]: null }
  notify()
  pendingPersonaKeys.add(key)

  const op = { op: 'set' as const, path: ['personas', key], value: null }

  return fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `persona-clear-${key}-${String(++writeSeq)}`,
      payload: {
        args: {
          ns: 'enpoi-orchestration',
          ops: [op],
        },
      },
    }),
  })
    .then(res => res.ok)
    .catch(() => false)
    .finally(() => {
      pendingPersonaKeys.delete(key)
    })
}
