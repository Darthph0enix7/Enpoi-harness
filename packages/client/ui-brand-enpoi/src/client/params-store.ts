/**
 * Global reactive in-memory cache for Enpoi orchestration parameters (doc 38).
 *
 * Same discipline as persona-store: eager boot priming from host settings,
 * synchronous 0ms snapshots via useSyncExternalStore, optimistic local
 * updates with background persistence to `enpoi-orchestration.parameters`.
 * Every change is hot-swapped — the backend resolvers read the namespace
 * fresh per use, so no restart is ever needed. `refreshFromServer` re-reads
 * through the package's shared coalesced describe (settings-refresh.ts: one
 * request per burst, scheduled by a push, a transport reconnect, the tab
 * becoming visible, or a stale mount); parameter keys with a local write in
 * flight keep their optimistic value until that write settles, and a read
 * answering the revision this store last applied notifies nobody.
 */
import { readEnpoiNamespace } from './settings-refresh.ts'

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
  compaction: {
    thresholdRatio: number
    retainRatio: number
    headroomTokens: number
    retainTokens: number
    pruneThresholdChars: number
    pruneHeadChars: number
    pruneTailChars: number
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
  // Mirrors the compaction-basic/pruner code defaults; the backend reads these
  // only when set, so untouched values keep today's behaviour exactly.
  compaction: {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    headroomTokens: 65_536,
    retainTokens: 0,
    pruneThresholdChars: 8192,
    pruneHeadChars: 4096,
    pruneTailChars: 1024,
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
/**
 * In-flight local writes: `group.key` for one parameter, bare `group` for a
 * whole-group reset. A marked path keeps its optimistic local value on refresh.
 */
const pendingParamPaths = new Set<string>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Revision this store last applied. A later read that answers the same
 * revision carries the document this snapshot already holds, so it is skipped
 * without a notify (the snapshot identity, and every subscriber, stays put).
 */
let lastAppliedRevision: number | undefined

/** Re-read the namespace and merge it into the snapshot (cross-client live sync). */
export async function refreshFromServer(): Promise<void> {
  try {
    const view = await readEnpoiNamespace()
    if (view === undefined) return
    if (view.revision !== undefined && view.revision === lastAppliedRevision) return
    const parameters = (view.value?.parameters ?? view.user?.parameters) as Partial<OrchestrationParams> | undefined
    if (parameters === undefined || typeof parameters !== 'object') return
    lastAppliedRevision = view.revision
    const merged = mergeParams(PARAM_DEFAULTS, parameters)
    for (const marker of pendingParamPaths) {
      const [group, key] = splitParamMarker(marker)
      const target = merged as unknown as Record<string, unknown>
      const local = currentParams as unknown as Record<string, unknown>
      if (key === undefined) target[group] = structuredClone(local[group])
      else {
        const targetGroup = target[group] as Record<string, number | boolean>
        const localGroup = local[group] as Record<string, number | boolean>
        targetGroup[key] = localGroup[key] as number | boolean
      }
    }
    currentParams = merged
    notify()
  } catch {
    // Offline or malformed answer: the last snapshot stays until the next push.
  }
}

/** Split a pending marker into its group and optional key (`keeper.leaseMs`). */
function splitParamMarker(marker: string): [keyof OrchestrationParams, string | undefined] {
  const dot = marker.indexOf('.')
  const group = (dot === -1 ? marker : marker.slice(0, dot)) as keyof OrchestrationParams
  return [group, dot === -1 ? undefined : marker.slice(dot + 1)]
}

/** Eagerly prime the in-memory cache from host settings on boot. */
export function primeOrchestrationParams(): void {
  if (primed) return
  primed = true
  void refreshFromServer()
}

/** Deep-merge partial parameters over defaults (missing groups/keys keep defaults). */
function mergeParams(base: OrchestrationParams, partial: Partial<OrchestrationParams>): OrchestrationParams {
  return {
    council: { ...base.council, ...(partial.council ?? {}) },
    keeper: { ...base.keeper, ...(partial.keeper ?? {}) },
    compaction: { ...base.compaction, ...(partial.compaction ?? {}) },
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

/**
 * Optimistic local update + background persistence (0ms UI, async disk). The
 * path stays marked pending until the write settles so a concurrent refresh
 * cannot clobber the optimistic value.
 * @param group - the parameter group.
 * @param key - the parameter within the group.
 * @param value - the next value.
 */
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
  const marker = `${group}.${key}`
  pendingParamPaths.add(marker)
  void fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `param-${group}-${key}`,
      payload: {
        args: {
          ns: 'enpoi-orchestration',
          ops: [{ op: 'set', path: ['parameters', group, key], value }],
        },
      },
    }),
  })
    .then((res) => {
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
    .finally(() => {
      pendingParamPaths.delete(marker)
    })
}

/**
 * Reset one group to its doc-38 defaults (0ms UI, background persist). The
 * whole group stays marked pending until the write settles.
 * @param group - the parameter group to reset.
 */
export function resetOrchestrationGroup(group: keyof OrchestrationParams): void {
  const next = structuredClone(currentParams)
  ;(next[group] as Record<string, number | boolean>) = structuredClone(PARAM_DEFAULTS[group]) as Record<string, number | boolean>
  currentParams = next
  notify()
  pendingParamPaths.add(group)
  void fetch('/api/settings.mutate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.mutate',
      rpcId: `param-reset-${group}`,
      payload: {
        args: {
          ns: 'enpoi-orchestration',
          ops: [{ op: 'set', path: ['parameters', group], value: PARAM_DEFAULTS[group] }],
        },
      },
    }),
  })
    .catch(() => { /* offline keeps the optimistic reset until the next write */ })
    .finally(() => {
      pendingParamPaths.delete(group)
    })
}
