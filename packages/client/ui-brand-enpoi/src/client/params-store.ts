/**
 * Global reactive in-memory cache for Enpoi orchestration parameters (doc 38).
 *
 * Same discipline as persona-store: eager boot priming from host settings,
 * synchronous 0ms snapshots via useSyncExternalStore, optimistic local
 * updates with background persistence to `enpoi-orchestration.parameters`.
 * Every change is hot-swapped — the backend resolvers read the namespace
 * fresh per use, so no restart is ever needed.
 */
export interface OrchestrationParams {
  council: {
    maxDebateTokens: number
    defaultMaxRounds: number
    defaultHideLimit: boolean
    quorumFraction: number
    debaterTimeoutMs: number
    debaterRetryCount: number
    consensusThreshold: number
    plateauDeltaThreshold: number
  }
  keeper: {
    leaseMs: number
    maxInputEvents: number
    maxOutputTokens: number
    structuralDistanceK: number
    minRefreshMs: number
    negativeCacheMs: number
    claimsBatchSize: number
    claimsBatchMinutes: number
  }
  memory: {
    retrieverTopK: number
    retrieverCharBudget: number
  }
  oracle: {
    timeoutMs: number
  }
}

export const PARAM_DEFAULTS: OrchestrationParams = {
  council: {
    maxDebateTokens: 180_000,
    defaultMaxRounds: 5,
    defaultHideLimit: true,
    quorumFraction: 2 / 3,
    debaterTimeoutMs: 90_000,
    debaterRetryCount: 1,
    consensusThreshold: 0.8,
    plateauDeltaThreshold: 0.05,
  },
  keeper: {
    leaseMs: 45_000,
    maxInputEvents: 80,
    maxOutputTokens: 2048,
    structuralDistanceK: 24,
    minRefreshMs: 60_000,
    negativeCacheMs: 120_000,
    claimsBatchSize: 8,
    claimsBatchMinutes: 5,
  },
  memory: {
    retrieverTopK: 10,
    retrieverCharBudget: 1200,
  },
  oracle: {
    timeoutMs: 120_000,
  },
}

let currentParams: OrchestrationParams = structuredClone(PARAM_DEFAULTS)
let primed = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Eagerly prime the in-memory cache from host settings on boot. */
export function primeOrchestrationParams(): void {
  if (primed) return
  primed = true
  void fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: 'prime-orchestration-params',
      payload: {},
    }),
  })
    .then(async (res) => {
      if (!res.ok) return
      const json: unknown = await res.json()
      const namespaces = (json as { result?: { value?: { namespaces?: unknown } } })?.result?.value?.namespaces
      const orch = Array.isArray(namespaces)
        ? (namespaces as Array<{ ns?: string; value?: { parameters?: Partial<OrchestrationParams> }; user?: { parameters?: Partial<OrchestrationParams> } }>).find(n => n.ns === 'enpoi-orchestration')
        : undefined
      const parameters = orch?.value?.parameters ?? orch?.user?.parameters
      if (parameters && typeof parameters === 'object') {
        currentParams = mergeParams(PARAM_DEFAULTS, parameters)
        notify()
      }
    })
    .catch(() => {})
}

/** Deep-merge partial parameters over defaults (missing groups/keys keep defaults). */
function mergeParams(base: OrchestrationParams, partial: Partial<OrchestrationParams>): OrchestrationParams {
  return {
    council: { ...base.council, ...(partial.council ?? {}) },
    keeper: { ...base.keeper, ...(partial.keeper ?? {}) },
    memory: { ...base.memory, ...(partial.memory ?? {}) },
    oracle: { ...base.oracle, ...(partial.oracle ?? {}) },
  }
}

// Auto-prime on module import so it's ready before any settings panel opens.
if (typeof window !== 'undefined') {
  primeOrchestrationParams()
}

/** Synchronous snapshot reader for useSyncExternalStore (0ms latency). */
export function getOrchestrationParams(): OrchestrationParams {
  return currentParams
}

export function subscribeOrchestrationParams(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Optimistic local update + background persistence (0ms UI, async disk). */
export function setOrchestrationParam(
  group: keyof OrchestrationParams,
  key: string,
  value: number | boolean,
): void {
  const prev = currentParams
  const next = structuredClone(currentParams)
  ;(next[group] as Record<string, number | boolean>)[key] = value
  currentParams = next
  notify()
  void fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `param-${group}-${key}`,
      payload: {
        ns: 'enpoi-orchestration',
        ops: [{ op: 'set', path: ['parameters', group, key], value }],
      },
    }),
  })
    .then(res => {
      // Oracle: a server REJECTION must roll back the optimistic value —
      // otherwise the panel lies until reload.
      if (!res.ok) {
        currentParams = prev
        notify()
      }
    })
    .catch(() => {
      currentParams = prev
      notify()
    })
}

/** Reset one group to its doc-38 defaults (0ms UI, background persist). */
export function resetOrchestrationGroup(group: keyof OrchestrationParams): void {
  const next = structuredClone(currentParams)
  ;(next[group] as Record<string, number | boolean>) = structuredClone(PARAM_DEFAULTS[group]) as Record<string, number | boolean>
  currentParams = next
  notify()
  void fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `param-reset-${group}`,
      payload: {
        ns: 'enpoi-orchestration',
        ops: [{ op: 'set', path: ['parameters', group], value: PARAM_DEFAULTS[group] }],
      },
    }),
  }).catch(() => {})
}