/**
 * Effective compaction-policy readout for the Orchestration settings page.
 *
 * The backend reads `enpoi-orchestration.parameters.compaction` fresh per
 * decision; this module mirrors the same derivation on the client so the
 * operator sees the token threshold and retained tail for the selected
 * summariser route before an incident. The derivation is a pure function over
 * the parameter group, the `personas.compaction` assignment, and the model
 * catalog (context window, prompt-side cap, and adapter output cap).
 */
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { PARAM_DEFAULTS } from './params-store.ts'
import type { OrchestrationParams } from './params-store.ts'
import type { BrandT } from './locales.ts'

/** Catalog facts one route contributes to the derivation. */
export interface CompactionModelInfo {
  contextWindow?: number
  /** Provenance of {@link contextWindow}; `default` is a route fallback, not a disclosure. */
  contextWindowSource?: 'configured' | 'discovered' | 'installed' | 'default'
  /** Prompt-side cap disclosed separately from {@link contextWindow}, when one was stated. */
  maxInputTokens?: number
  /** Provenance of {@link maxInputTokens}; `default` is a route fallback, not a disclosure. */
  maxInputTokensSource?: 'configured' | 'discovered' | 'installed' | 'default'
  /** Declared output capability; a capability, not a request budget, so it never reserves. */
  maxTokens?: number
  /** Provenance of {@link maxTokens}; `default` is a route fallback, not a disclosure. */
  maxTokensSource?: 'configured' | 'discovered' | 'installed' | 'default'
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number
}

/** Derived, operator-facing compaction policy for the selected route. */
export interface CompactionPolicyReadout {
  /** Human-readable summariser route (`session model a/b`, `a/b`, `chain c`). */
  route: string
  /** Effective prompt budget: the disclosed window clipped by a disclosed input cap. */
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

/** Placeholder translate used only for the pre-refresh module snapshot. */
const identityT: BrandT = key => key

/** Index one model catalog by `provider/model` for route lookups. */
export function compactionModels(catalog: ModelCatalog | undefined): Map<string, CompactionModelInfo> {
  const models = new Map<string, CompactionModelInfo>()
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      const info: CompactionModelInfo = {}
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow
      if (model.contextWindowSource !== undefined) info.contextWindowSource = model.contextWindowSource
      if (model.maxInputTokens !== undefined) info.maxInputTokens = model.maxInputTokens
      if (model.maxInputTokensSource !== undefined) info.maxInputTokensSource = model.maxInputTokensSource
      if (model.maxTokens !== undefined) info.maxTokens = model.maxTokens
      if (model.maxTokensSource !== undefined) info.maxTokensSource = model.maxTokensSource
      if (model.defaultMaxTokens !== undefined) info.defaultMaxTokens = model.defaultMaxTokens
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
 * Derive the effective policy exactly as `resolveCompactSpec` does: the output
 * reservation is the adapter default then zero (a declared output capability is
 * not a request budget); the prompt budget is the combined window clipped by a
 * disclosed input-only cap, while a `default`-source window is only a route
 * fallback; the threshold is the prompt budget fraction capped by that budget
 * minus the reservation and one headroom subtraction; the tail is the absolute
 * floor when set, else the fraction of the prompt budget minus the reservation.
 * @param params - the live `parameters.compaction` group.
 * @param assignment - the `personas.compaction` assignment, when one exists.
 * @param fallback - the model a session with no assignment would use (the catalog default).
 * @param models - catalog facts by `provider/model`.
 * @param t - the package dictionary translate for route labels and problems.
 * @returns the readout; a `problem` string replaces the numbers when the
 *   combination cannot fire or the route's window is unknown or assumed.
 */
export function deriveCompactionPolicy(
  params: OrchestrationParams['compaction'],
  assignment: Pick<ModelSelection, 'provider' | 'model' | 'chain'> | null | undefined,
  fallback: Pick<ModelSelection, 'provider' | 'model'> | null | undefined,
  models: ReadonlyMap<string, CompactionModelInfo>,
  t: BrandT = identityT,
): CompactionPolicyReadout {
  if (assignment?.chain !== undefined && assignment.chain !== '') {
    return { route: t('orchRouteChain', { chain: assignment.chain }), problem: t('orchChainRuntime') }
  }
  const assignedKey = selectionKey(assignment ?? undefined)
  const fallbackKey = selectionKey(fallback ?? undefined)
  const key = assignedKey ?? fallbackKey
  const sessionModel = t('orchSessionModel')
  const route = assignedKey !== undefined
    ? assignedKey
    : fallbackKey === undefined ? sessionModel : `${sessionModel} ${fallbackKey}`
  if (key === undefined) {
    return { route, problem: t('orchNoModelWindow') }
  }
  const info = models.get(key)
  if (info === undefined) {
    return { route, problem: t('orchNoCatalogWindow') }
  }
  // Mirror declaredPromptBudget: a disclosed input-only cap binds on its own
  // even when the combined window is only a route default; otherwise a
  // default-source window stays unknown.
  const disclosedInput = info.maxInputTokens !== undefined
    && info.maxInputTokensSource !== 'default'
    && info.maxInputTokens > 0
    ? info.maxInputTokens
    : undefined
  const disclosedWindow = info.contextWindowSource === 'default' ? undefined : info.contextWindow
  const contextWindow = disclosedWindow === undefined
    ? disclosedInput
    : disclosedInput === undefined
      ? disclosedWindow
      : Math.min(disclosedWindow, disclosedInput)
  if (contextWindow === undefined || contextWindow <= 0) {
    return {
      route,
      problem: info.contextWindowSource === 'default'
        ? t('orchWindowDefaultSource')
        : t('orchNoCatalogWindow'),
    }
  }
  if (!Number.isInteger(params.headroomTokens) || params.headroomTokens <= 0) {
    // The backend ignores a non-positive settings headroom, so the readout
    // must not pretend it applies.
    return { route, contextWindow, problem: t('orchHeadroomPositive') }
  }

  // Mirror reservedCompletionTokens: a declared `maxTokens` is a capability,
  // not a request output budget. Only the adapter's per-request default, which
  // it materializes when the envelope omits one, reserves.
  const outputReserveTokens = info.defaultMaxTokens ?? 0
  const messageBudgetTokens = contextWindow - outputReserveTokens
  if (messageBudgetTokens <= 0) {
    return {
      route,
      contextWindow,
      outputReserveTokens,
      problem: t('orchNoMessageBudget', { reserve: outputReserveTokens, tokens: contextWindow }),
    }
  }
  // Headroom applies once on the message budget, exactly as resolveCompactSpec.
  const pressureBudgetTokens = messageBudgetTokens - params.headroomTokens
  const thresholdTokens = Math.floor(Math.min(contextWindow * params.thresholdRatio, pressureBudgetTokens))
  if (thresholdTokens <= 0) {
    return {
      route,
      contextWindow,
      outputReserveTokens,
      problem: t('orchNoPressureBudget', {
        reserve: outputReserveTokens,
        headroom: params.headroomTokens,
        tokens: contextWindow,
      }),
    }
  }
  const retainTokens = params.retainTokens > 0
    ? params.retainTokens
    : Math.floor(messageBudgetTokens * params.retainRatio)
  if (retainTokens >= thresholdTokens) {
    return {
      route,
      contextWindow,
      outputReserveTokens,
      thresholdTokens,
      retainTokens,
      problem: t('orchRetainConflict', { retain: retainTokens, threshold: thresholdTokens }),
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
  t: BrandT,
): void {
  current = deriveCompactionPolicy(params, assignment, fallback, compactionModels(catalog), t)
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
