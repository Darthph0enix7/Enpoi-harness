/**
 * Global reactive in-memory cache for Enpoi persona model assignments.
 *
 * Ensures synchronous 0ms render on tab switch or session switch (zero delay,
 * zero reloading, zero 2-second fallback jumps), and hot-syncs changes to
 * the server's `enpoi-orchestration` settings namespace in the background.
 * `refreshFromServer` re-reads the namespace for cross-client live sync; a
 * persona key with a local write in flight keeps its optimistic value until
 * that write settles.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

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

/** One describe view of the enpoi-orchestration namespace, structural subset. */
interface OrchestrationNamespaceView {
  ns?: string
  value?: { personas?: PersonaMap }
  user?: { personas?: PersonaMap }
}

/** Monotonic describe rpcIds: the gateway echoes the id and duplicates race. */
let describeSeq = 0

/** Monotonic write rpcIds for the same reason. */
let writeSeq = 0

/** Read the enpoi-orchestration namespace through the live gateway. */
async function describeOrchestration(): Promise<OrchestrationNamespaceView | undefined> {
  describeSeq += 1
  const res = await fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `persona-describe-${describeSeq}`,
      payload: { args: {} },
    }),
  })
  if (!res.ok) return undefined
  const json: unknown = await res.json()
  const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
  return Array.isArray(namespaces)
    ? (namespaces as OrchestrationNamespaceView[]).find(n => n.ns === 'enpoi-orchestration')
    : undefined
}

/**
 * Replace the snapshot from one server read. Keys with an in-flight local write
 * keep their optimistic value; every other key follows the server (so a
 * concurrent clear in another client is applied).
 * @param serverPersonas - the personas map the host just reported.
 */
function applyServerPersonas(serverPersonas: PersonaMap): void {
  const merged: PersonaMap = { ...serverPersonas }
  for (const key of pendingPersonaKeys) {
    if (!Object.hasOwn(currentPersonas, key)) {
      delete merged[key]
      continue
    }
    const local = currentPersonas[key]
    if (local !== undefined) merged[key] = local
  }
  currentPersonas = merged
  notify()
}

/** Re-read the namespace and merge it into the snapshot (cross-client live sync). */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await describeOrchestration()
    if (view === undefined) return
    const personas = view.value?.personas ?? view.user?.personas
    if (personas !== undefined && typeof personas === 'object') {
      applyServerPersonas({ ...personas })
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
 * "Inherit" (0ms update) and persisting the leaf write in the background.
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
          ops: [{ op: 'set', path: ['personas', key], value: null }],
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
