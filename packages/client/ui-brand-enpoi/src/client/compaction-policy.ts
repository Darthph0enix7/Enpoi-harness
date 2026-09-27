/**
 * Effective compaction-policy readout for the Orchestration settings page.
 *
 * The backend reads `enpoi-orchestration.parameters.compaction` fresh per
 * decision; this module mirrors the same derivation on the client so the
 * operator sees the token threshold and retained tail for the selected
 * summariser route before an incident. The derivation is a pure function over
 * the parameter group, the `personas.compaction` assignment, and the model
 * catalog (context window and adapter output cap).
 */
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { PARAM_DEFAULTS } from './params-store.ts'
import type { OrchestrationParams } from './params-store.ts'

/** Catalog facts one route contributes to the derivation. */
export interface CompactionModelInfo {
  contextWindow?: number
  maxTokens?: number
}

/** Derived, operator-facing compaction policy for the selected route. */
export interface CompactionPolicyReadout {
  /** Human-readable summariser route (`session model a/b`, `a/b`, `chain c`). */
  route: string
  /** Effective context window of the route, when the catalog knows it. */
  contextWindow?: number
  /** Output tokens reserved for the summariser's own generation. */
  outputReserveTokens?: number
  /** Token pressure at which compaction fires. */
  thresholdTokens?: number
  /** Verbatim tail retained below the threshold, in tokens. */
  retainTokens?: number
  /** Why no numbers can be shown, or the validation problem, when any. */
  problem?: string
}

const SESSION_MODEL_LABEL = 'session model'

/** Index one model catalog by `provider/model` for route lookups. */
export function compactionModels(catalog: ModelCatalog | undefined): Map<string, CompactionModelInfo> {
  const models = new Map<string, CompactionModelInfo>()
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      const info: CompactionModelInfo = {}
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow
      if (model.maxTokens !== undefined) info.maxTokens = model.maxTokens
      models.set(`${group.id}/${model.id}`, info)
    }
  }
  return models
}

/** A `provider/model` key for one selection, when both halves are present. */
function selectionKey(selection: Pick<ModelSelection, 'provider' | 'model'> | undefined): string | undefined {
  if (selection === undefined) return undefined
  const provider = selection.provider
  const model = selection.model
  return typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0
    ? `${provider}/${model}`
    : undefined
}

/**
 * Derive the effective policy exactly as `resolveCompactSpec` does: the
 * threshold is the window fraction capped by the window minus the output
 * reservation and headroom; the tail is the absolute floor when set, else the
 * fraction of the window minus the reservation.
 * @param params - the live `parameters.compaction` group.
 * @param assignment - the `personas.compaction` assignment, when one exists.
 * @param fallback - the model a session with no assignment would use (the catalog default).
 * @param models - catalog facts by `provider/model`.
 * @returns the readout; a `problem` string replaces the numbers when the
 *   combination cannot fire or the route's window is unknown.
 */
export function deriveCompactionPolicy(
  params: OrchestrationParams['compaction'],
  assignment: Pick<ModelSelection, 'provider' | 'model' | 'chain'> | null | undefined,
  fallback: Pick<ModelSelection, 'provider' | 'model'> | null | undefined,
  models: ReadonlyMap<string, CompactionModelInfo>,
): CompactionPolicyReadout {
  if (assignment?.chain !== undefined && assignment.chain !== '') {
    return { route: `chain ${assignment.chain}`, problem: 'a chain resolves to its first link at run time' }
  }
  const assignedKey = selectionKey(assignment ?? undefined)
  const fallbackKey = selectionKey(fallback ?? undefined)
  const key = assignedKey ?? fallbackKey
  const route = assignedKey !== undefined
    ? assignedKey
    : fallbackKey === undefined ? SESSION_MODEL_LABEL : `${SESSION_MODEL_LABEL} ${fallbackKey}`
  if (key === undefined) {
    return { route, problem: 'no model window known until the session routes a request' }
  }
  const info = models.get(key)
  const contextWindow = info?.contextWindow
  if (contextWindow === undefined || contextWindow <= 0) {
    return { route, problem: 'the catalog has no context window for this route' }
  }
  if (!Number.isInteger(params.headroomTokens) || params.headroomTokens <= 0) {
    // The backend ignores a non-positive settings headroom, so the readout
    // must not pretend it applies.
    return { route, contextWindow, problem: 'headroom must be a positive integer' }
  }

  const outputReserveTokens = Math.min(params.headroomTokens, Math.floor(contextWindow / 2))
  const thresholdTokens = Math.floor(Math.min(
    contextWindow * params.thresholdRatio,
    contextWindow - outputReserveTokens - params.headroomTokens,
  ))
  if (thresholdTokens <= 0) {
    return {
      route,
      contextWindow,
      outputReserveTokens,
      problem: `headroom ${params.headroomTokens} leaves no pressure budget below the window`,
    }
  }
  const retainTokens = params.retainTokens > 0
    ? params.retainTokens
    : Math.floor((contextWindow - outputReserveTokens) * params.retainRatio)
  if (retainTokens >= thresholdTokens) {
    return {
      route,
      contextWindow,
      outputReserveTokens,
      thresholdTokens,
      retainTokens,
      problem: `retain ${retainTokens} must stay below the ${thresholdTokens}-token threshold`,
    }
  }
  return { route, contextWindow, outputReserveTokens, thresholdTokens, retainTokens }
}

// --- global reactive view ---------------------------------------------------

let current: CompactionPolicyReadout = deriveCompactionPolicy(
  PARAM_DEFAULTS.compaction,
  null,
  null,
  new Map(),
)
const listeners = new Set<() => void>()

/** Recompute the readout from the current inputs and notify subscribers. */
export function refreshCompactionPolicy(
  params: OrchestrationParams['compaction'],
  assignment: Pick<ModelSelection, 'provider' | 'model' | 'chain'> | null | undefined,
  fallback: Pick<ModelSelection, 'provider' | 'model'> | null | undefined,
  catalog: ModelCatalog | undefined,
): void {
  current = deriveCompactionPolicy(params, assignment, fallback, compactionModels(catalog))
  for (const listener of listeners) listener()
}

/** Synchronous snapshot reader for `useSyncExternalStore`. */
export function getCompactionPolicy(): CompactionPolicyReadout {
  return current
}

/**
 * Subscribe to readout changes (parameter, assignment, or catalog movement).
 * @param listener - called after each readout change.
 * @returns unsubscribe function.
 */
export function subscribeCompactionPolicy(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
