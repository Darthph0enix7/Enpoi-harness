/**
 * Global reactive in-memory cache for Enpoi persona model assignments.
 *
 * Ensures synchronous 0ms render on tab switch or session switch (zero delay,
 * zero reloading, zero 2-second fallback jumps), and hot-syncs changes to
 * the server's `enpoi-orchestration` settings namespace in the background.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'

/** Persona id → explicit model selection (null = inherit); the page's snapshot value. */
export type PersonaMap = Record<string, ModelSelection | null>

let currentPersonas: PersonaMap = {}
let primed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Eagerly prime the global in-memory cache from host settings on boot. */
export function primePersonaAssignments(): void {
  if (primed) return
  primed = true
  void fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: 'prime-personas',
      payload: { args: {} },
    }),
  })
    .then(async (res) => {
      if (!res.ok) return
      const json: unknown = await res.json()
      const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
      const orch = Array.isArray(namespaces)
        ? (namespaces as Array<{ ns?: string; value?: { personas?: Record<string, ModelSelection> }; user?: { personas?: Record<string, ModelSelection> } }>).find(n => n.ns === 'enpoi-orchestration')
        : undefined
      const personas = orch?.value?.personas ?? orch?.user?.personas
      if (personas && typeof personas === 'object') {
        currentPersonas = { ...personas }
        notify()
      }
    })
    .catch(() => {})
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

/** Assign an explicit model to a persona globally (0ms instant update + background persist). */
export function setPersonaAssignment(personaId: string, selection: ModelSelection): Promise<boolean> {
  const key = personaId.toLowerCase().replace(/^the\s+/, '').trim()
  currentPersonas = { ...currentPersonas, [key]: selection }
  notify()

  return fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `persona-set-${key}`,
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
}

/** Clear explicit assignment, reverting persona back to "Inherit" (0ms instant update + background persist). */
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

  return fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `persona-clear-${key}`,
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
}
