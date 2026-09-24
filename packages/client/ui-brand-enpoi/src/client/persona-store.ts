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
 * applied notifies nobody, and a persona key with a local write in flight
 * keeps its optimistic value until that write settles.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { getRoleRegistry, isKnownFleetSeat } from './role-registry.ts'
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

/**
 * Replace the snapshot from one server read. Keys with an in-flight local write
 * keep their optimistic value; every other key follows the server (so a
 * concurrent clear in another client is applied).
 * @param serverPersonas - the personas map the host just reported.
 */
function applyServerPersonas(serverPersonas: PersonaMap): void {
  const merged: PersonaMap = {}
  for (const [key, value] of Object.entries(serverPersonas)) {
    if (pendingPersonaKeys.has(key)) {
      // An in-flight local clear drops the server's row; a local optimistic
      // value wins over it.
      if (!Object.hasOwn(currentPersonas, key)) continue
      const local = currentPersonas[key]
      if (local !== undefined) {
        merged[key] = local
        continue
      }
    }
    merged[key] = value
  }
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
 * background. A registry seat keeps its fleet row after the clear, so its key
 * stays as an explicit `null`; a persona id with no registry row exists only
 * as this assignment (a stray left by an older fleet), so the clear removes
 * the key itself — a `null` would leave the seat lingering as a "Custom" row.
 * @param personaId - display persona id.
 * @returns whether the mutation was persisted.
 */
export function clearPersonaAssignment(personaId: string): Promise<boolean> {
  const key = personaId.toLowerCase().replace(/^the\s+/, '').trim()
  const next: PersonaMap = {}
  for (const [k, v] of Object.entries(currentPersonas)) {
    if (k !== key && v !== null && v !== undefined) {
      next[k] = v
    }
  }
  currentPersonas = next
  notify()
  pendingPersonaKeys.add(key)

  const op = Object.hasOwn(getRoleRegistry(), key) || isKnownFleetSeat(key)
    ? { op: 'set' as const, path: ['personas', key], value: null }
    : { op: 'unset' as const, path: ['personas', key] }

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
