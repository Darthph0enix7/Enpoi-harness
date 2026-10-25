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
  /**
   * Model-group id the seat named. The summariser request carries it, so the
   * LLM runtime can fail over across the group's remaining members.
   */
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
}

/** Structural view of one resolved model group; the seat needs only its links. */
interface CompactionModelGroup {
  readonly links?: unknown
}

/** Structural view of the optional `modelChains` service the seat resolves through. */
interface CompactionModelChainsHandle {
  resolve?: (id: string) => CompactionModelGroup | undefined
}

/** Reasons a named seat group could not supply a route, deduped per context. */
const warnedSeatGroups = new WeakMap<Context, Set<string>>()

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
 * Emit one diagnostic when a named seat group cannot supply a route, keyed per
 * context and group id so a per-summary trigger never repeats it. stderr and
 * the logger are the observable channel, matching the engine's own warnings.
 * @param ctx - context that may provide the logger.
 * @param chainId - group id the seat named.
 * @param reason - why the group supplied no route.
 */
function warnSeatGroupUnusable(ctx: Context, chainId: string, reason: string): void {
  let warned = warnedSeatGroups.get(ctx)
  if (warned === undefined) {
    warned = new Set()
    warnedSeatGroups.set(ctx, warned)
  }
  if (warned.has(chainId)) return
  warned.add(chainId)
  const line = `compaction-basic: summariser seat group "${chainId}" ${reason}; inheriting the conversation route`
  try {
    ctx.logger.warn(line)
  } catch (_loggerUnavailable) {
    // stderr below still carries the diagnostic when no logger is mounted.
  }
  process.stderr.write(`[compaction-basic] ${line}\n`)
}

/**
 * Resolve one named seat group to its first usable member through the optional
 * `modelChains` service. The runtime resolves the group itself each request, so
 * this only supplies the route (`provider`/`model`) `GenerateOptions` requires;
 * carrying the group id is what enables per-request failover.
 * @param ctx - context that may provide the `modelChains` service.
 * @param chainId - group id the seat named.
 * @returns the first usable link, or `undefined` when the group supplies none.
 */
function resolveSeatGroup(ctx: Context, chainId: string): { provider: string; model: string } | undefined {
  const service = ctx.get('modelChains') as CompactionModelChainsHandle | undefined
  if (service === undefined || typeof service.resolve !== 'function') {
    warnSeatGroupUnusable(ctx, chainId, 'cannot resolve: no model-chains service is mounted')
    return undefined
  }
  let group: CompactionModelGroup | undefined
  try {
    group = service.resolve(chainId)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    warnSeatGroupUnusable(ctx, chainId, `cannot resolve: ${detail}`)
    return undefined
  }
  if (group === undefined) {
    warnSeatGroupUnusable(ctx, chainId, 'is not declared or is disabled')
    return undefined
  }
  const links = Array.isArray(group.links) ? group.links : []
  for (const candidate of links) {
    if (!isRecord(candidate)) continue
    const provider = nonEmptyString(candidate.provider)
    const model = nonEmptyString(candidate.model)
    if (provider !== undefined && model !== undefined) return { provider, model }
  }
  warnSeatGroupUnusable(ctx, chainId, 'resolves to zero usable members')
  return undefined
}

/**
 * Resolve the `personas.compaction` seat to one summariser route. An explicit
 * provider/model pair is the seat's own route and, when a chain is also named,
 * the group's implicit first member; the chain id is always carried so the LLM
 * runtime fails over per request instead of collapsing to one link. A
 * selector-only seat (a chain without an explicit pair) resolves its first
 * usable member through the optional `modelChains` service. A missing service,
 * an unknown or disabled group, and a group with no usable member leave the
 * seat unset so the engine inherits the conversation route, with one warning
 * naming the reason.
 * @param ctx - context that may provide the Settings and `modelChains` services.
 * @returns the seat route, or `undefined` when the seat inherits the session model.
 */
export function resolveCompactionSeat(ctx: Context): CompactionSeatRoute | undefined {
  const document = readOrchestrationDocument(ctx)
  const personas = document?.personas
  if (!isRecord(personas)) return undefined
  const entry = personas.compaction
  if (!isRecord(entry)) return undefined

  const chain = nonEmptyString(entry.chain)
  const provider = nonEmptyString(entry.provider)
  const model = nonEmptyString(entry.model)
  if (provider !== undefined && model !== undefined) {
    return chain === undefined ? { provider, model } : { provider, model, chain }
  }
  if (chain === undefined) return undefined
  const link = resolveSeatGroup(ctx, chain)
  return link === undefined ? undefined : { ...link, chain }
}
