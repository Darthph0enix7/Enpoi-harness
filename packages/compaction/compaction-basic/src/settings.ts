/**
 * Live `enpoi-orchestration` settings reads: the operator-owned compaction
 * policy parameters and the compaction summariser seat.
 *
 * Under the merged settings model the `enpoi-orchestration` entry's Config IS
 * the shared document (`parameters` and `personas` are opaque plugin-owned
 * vocabularies). These reads are best-effort and fail open: a missing service,
 * a missing entry, or a malformed value yields the code defaults, never a
 * failed compaction.
 *
 * @module @deepseek-ai/dsh-compaction-basic/settings
 */

import type { Context } from '@deepseek-ai/cordis'

/** Namespace owning the shared Enpoi orchestration document. */
const ORCHESTRATION_NS = 'enpoi-orchestration'

/** Compaction policy values read from `parameters.compaction` (all optional). */
export interface CompactionSettingsValues {
  readonly thresholdRatio?: number
  readonly retainRatio?: number
  readonly headroomTokens?: number
  readonly retainTokens?: number
  readonly pruneThresholdChars?: number
  readonly pruneHeadChars?: number
  readonly pruneTailChars?: number
}

/** One resolved summariser route from the `personas.compaction` seat. */
export interface CompactionSeatRoute {
  readonly provider: string
  readonly model: string
  /** Model-group id the route was resolved through, when the seat named a chain. */
  readonly chain?: string
}

/**
 * Structural view of the Settings service this package reads through
 * `ctx.get('settings')`; no service interface is imported so the package stays
 * independently composable.
 */
export interface CompactionSettingsHandle {
  describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
}

/** Structural view of the orchestration document keys this package consumes. */
export interface OrchestrationDocument {
  parameters?: { compaction?: unknown }
  personas?: Record<string, unknown>
  chains?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A finite number in (0, 1], or `undefined` when the value is unusable. */
function ratio(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : undefined
}

/** A positive integer, or `undefined` when the value is unusable. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** A non-negative integer, or `undefined` when the value is unusable. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Read the live orchestration document through the Settings service's
 * `describe()` descriptors. A missing service, a missing configurable entry,
 * or a failed read yields `undefined` so consumers keep their code defaults.
 * @param ctx - context that may provide the Settings service.
 * @returns the described document, or `undefined` when unavailable.
 */
export function readOrchestrationDocument(ctx: Context): OrchestrationDocument | undefined {
  try {
    const settings = ctx.get('settings') as CompactionSettingsHandle | undefined
    const value = settings?.describe?.().find(entry => entry.ns === ORCHESTRATION_NS)?.value
    return isRecord(value) ? value : undefined
  } catch {
    // A settings read is best-effort: a provider fault must not fail compaction.
    return undefined
  }
}

/**
 * Read and validate `parameters.compaction`. Every field is validated
 * independently; an invalid field is omitted so the resolved plugin default
 * applies instead (0 < ratios ≤ 1, positive integer token budgets,
 * non-negative integer prune head/tail).
 * @param ctx - context that may provide the Settings service.
 * @returns validated settings values; empty when nothing usable is configured.
 */
export function readCompactionSettings(ctx: Context): CompactionSettingsValues {
  const raw = readOrchestrationDocument(ctx)?.parameters?.compaction
  if (!isRecord(raw)) return {}
  const values: Record<string, number> = {}
  const thresholdRatio = ratio(raw.thresholdRatio)
  if (thresholdRatio !== undefined) values.thresholdRatio = thresholdRatio
  const retainRatio = ratio(raw.retainRatio)
  if (retainRatio !== undefined) values.retainRatio = retainRatio
  const headroomTokens = positiveInteger(raw.headroomTokens)
  if (headroomTokens !== undefined) values.headroomTokens = headroomTokens
  // `0` is the documented "unset" value: absolute retention is optional and
  // mutually exclusive with `retainRatio`.
  const retainTokens = nonNegativeInteger(raw.retainTokens)
  if (retainTokens !== undefined && retainTokens > 0) values.retainTokens = retainTokens
  const pruneThresholdChars = positiveInteger(raw.pruneThresholdChars)
  if (pruneThresholdChars !== undefined) values.pruneThresholdChars = pruneThresholdChars
  const pruneHeadChars = nonNegativeInteger(raw.pruneHeadChars)
  if (pruneHeadChars !== undefined) values.pruneHeadChars = pruneHeadChars
  const pruneTailChars = nonNegativeInteger(raw.pruneTailChars)
  if (pruneTailChars !== undefined) values.pruneTailChars = pruneTailChars
  return values
}

/**
 * Resolve the `personas.compaction` seat to one concrete summariser route. A
 * seat naming a chain resolves through the live chains document to its first
 * enabled link, like the delegation persona resolver; a stale or disabled
 * chain yields `undefined` so the engine inherits the conversation route
 * instead of failing. The chain id is carried for diagnostics; the one-shot
 * summarization call itself does not fail over.
 * @param ctx - context that may provide the Settings service.
 * @returns the seat route, or `undefined` when the seat inherits the session model.
 */
export function resolveCompactionSeat(ctx: Context): CompactionSeatRoute | undefined {
  const document = readOrchestrationDocument(ctx)
  const personas = document?.personas
  if (!isRecord(personas)) return undefined
  const entry = personas.compaction
  if (!isRecord(entry)) return undefined

  const chain = nonEmptyString(entry.chain)
  if (chain !== undefined) {
    const group = document?.chains?.[chain]
    if (!isRecord(group) || group.disabled === true) return undefined
    const link = Array.isArray(group.links) ? group.links[0] : undefined
    if (!isRecord(link)) return undefined
    const provider = nonEmptyString(link.provider)
    const model = nonEmptyString(link.model)
    return provider === undefined || model === undefined
      ? undefined
      : { provider, model, chain }
  }

  const provider = nonEmptyString(entry.provider)
  const model = nonEmptyString(entry.model)
  return provider === undefined || model === undefined ? undefined : { provider, model }
}
