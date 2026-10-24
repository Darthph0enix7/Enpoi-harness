/**
 * Load-time validation and routed-model policy resolution for compaction-basic.
 *
 * @module @deepseek-ai/dsh-compaction-basic/config
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { CompactionSettingsValues } from './settings.ts'
import type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedContextUxConfig,
  ResolvedRetention,
  ResolvedSummarizerResilience,
  ResolvedTargetPolicy,
} from './types.ts'

/** Default request-pressure fraction for every routed model. */
const DEFAULT_THRESHOLD_RATIO = 0.6

/** Default verbatim-tail fraction for every routed model. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Default per-pinned-message price ceiling. */
const DEFAULT_PIN_LEADING_MAX_TOKENS = 4_000

/** Default replay budget used when the summariser window is unknown. */
const DEFAULT_SUMMARIZER_UNKNOWN_WINDOW_TOKENS = 16_384

/** Default extra attempts with a smaller frame after a size-class rejection. */
const DEFAULT_SUMMARIZER_FRAME_RETRIES = 2

/** Default fraction of a rejected frame kept for the next attempt. */
const DEFAULT_SUMMARIZER_FRAME_SHRINK_RATIO = 0.5

/** Default consecutive failures before the session route is tried. */
const DEFAULT_SUMMARIZER_ESCALATION_FAILURES = 2

/** Default consecutive failures that open one route's circuit. */
const DEFAULT_SUMMARIZER_CIRCUIT_FAILURES = 4

/** Default share of the compacted region the mechanical fallback must free. */
const DEFAULT_MECHANICAL_FALLBACK_FREE_SHARE = 0.5

/** Fields shared by top-level defaults and exact-target overrides. */
const POLICY_CONFIG_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
] as const

/** Complete public top-level configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...POLICY_CONFIG_KEYS,
  'modelPolicies',
  'auto',
  'recallFooter',
  'recallFooterTools',
  'pinLeadingUserMessages',
  'pinLeadingMaxTokens',
  'pinScope',
  'summarizerUnknownWindowTokens',
  'summarizerFrameRetries',
  'summarizerFrameShrinkRatio',
  'summarizerEscalationFailures',
  'summarizerCircuitFailures',
  'mechanicalFallbackFreeShare',
])

/** Complete exact-target override key set. */
const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'model',
  ...POLICY_CONFIG_KEYS,
])

/** Target-specific pressure configuration failure eligible for warning suppression. */
export class TargetPressureConfigError extends Error {
  /**
   * @param targetKey - exact provider/model route used as the warning key.
   * @param message - actionable configuration failure detail.
   */
  constructor(readonly targetKey: string, message: string) {
    super(message)
  }
}

/**
 * Resolve and validate service defaults plus exact-target partial overrides.
 * @param config - untrusted plugin configuration after Loader normalization.
 * @returns detached immutable defaults and validated exact-target overrides.
 */
export function resolveConfig(config: BasicCompactionConfig = {}): ResolvedConfig {
  validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, 'BasicCompactionConfig')
  validatePolicy(config, 'BasicCompactionConfig')
  if (config.auto !== undefined && typeof config.auto !== 'boolean') {
    throw new Error('BasicCompactionConfig: auto must be a boolean')
  }
  validateContextUx(config)
  validateSummarizerResilience(config)

  const headroomTokens = config.headroomTokens ?? 65_536
  const maxTokens = config.maxTokens ?? headroomTokens
  assertPositiveInteger('BasicCompactionConfig.maxTokens (explicit or from headroomTokens)', maxTokens)
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO })
  validateRatioRetention(thresholdRatio, retention, 'BasicCompactionConfig')
  const modelPolicies = resolveModelPolicies(config.modelPolicies)
  for (const [index, policy] of modelPolicies.entries()) {
    if (policy.maxTokens === undefined && config.maxTokens === undefined
      && policy.headroomTokens !== undefined) {
      policy.maxTokens = policy.headroomTokens
    }
    assertPositiveInteger(
      `BasicCompactionConfig: modelPolicies[${index}].maxTokens (explicit or from headroomTokens)`,
      policy.maxTokens ?? maxTokens,
    )
    validateRatioRetention(
      policy.thresholdRatio ?? thresholdRatio,
      resolveRetention(policy, retention),
      `BasicCompactionConfig: modelPolicies[${index}]`,
    )
  }

  return deepFreeze({
    thresholdRatio,
    headroomTokens,
    ...retention,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    ...resolveContextUx(config),
    ...resolveSummarizerResilience(config),
    modelPolicies,
    auto: config.auto ?? true,
  })
}

/**
 * Overlay live operator settings (`enpoi-orchestration.parameters.compaction`)
 * over the validated plugin config. Values are already field-validated by the
 * settings reader; a retention pair that conflicts with the resulting
 * threshold falls back to the resolved config so an edit can never fail a
 * turn. An absolute `retainTokens` wins over `retainRatio` when both are set.
 * @param config - resolved plugin configuration.
 * @param values - validated settings-document values; empty leaves `config` unchanged in effect.
 * @returns detached immutable configuration for this compaction decision.
 */
export function applySettingsOverrides(
  config: ResolvedConfig,
  values: CompactionSettingsValues,
): ResolvedConfig {
  const thresholdRatio = values.thresholdRatio ?? config.thresholdRatio
  const headroomTokens = values.headroomTokens ?? config.headroomTokens
  const configuredRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  let retention: ResolvedRetention = configuredRetention
  if (values.retainTokens !== undefined) retention = { retainTokens: values.retainTokens }
  else if (values.retainRatio !== undefined) retention = { retainRatio: values.retainRatio }
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    retention = configuredRetention
  }
  const base = {
    thresholdRatio,
    headroomTokens,
    summarizationProvider: config.summarizationProvider,
    summarizationModel: config.summarizationModel,
    maxTokens: config.maxTokens,
    compactionRetries: config.compactionRetries,
    maxOverflowRetries: config.maxOverflowRetries,
    recallFooter: config.recallFooter,
    recallFooterTools: config.recallFooterTools,
    pinLeadingUserMessages: config.pinLeadingUserMessages,
    pinLeadingMaxTokens: config.pinLeadingMaxTokens,
    pinScope: config.pinScope,
    summarizerUnknownWindowTokens: config.summarizerUnknownWindowTokens,
    summarizerFrameRetries: config.summarizerFrameRetries,
    summarizerFrameShrinkRatio: config.summarizerFrameShrinkRatio,
    summarizerEscalationFailures: config.summarizerEscalationFailures,
    summarizerCircuitFailures: config.summarizerCircuitFailures,
    mechanicalFallbackFreeShare: config.mechanicalFallbackFreeShare,
    modelPolicies: config.modelPolicies,
    auto: config.auto,
  }
  if (retention.retainTokens !== undefined) {
    return deepFreeze({ ...base, retainTokens: retention.retainTokens })
  }
  return deepFreeze({ ...base, retainRatio: retention.retainRatio ?? config.retainRatio })
}

/**
 * Merge the exact provider/model override over the validated default policy.
 * @param config - validated service defaults and override table.
 * @param target - exact durable provider/model route to match.
 * @returns detached immutable policy before model-capacity scaling.
 */
export function resolveTargetPolicy(
  config: ResolvedConfig,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
): ResolvedTargetPolicy {
  const override = config.modelPolicies.find(policy => (
    policy.provider === target.provider && policy.model === target.model
  ))
  const inheritedRetention: ResolvedRetention = config.retainTokens === undefined
    ? { retainRatio: config.retainRatio }
    : { retainTokens: config.retainTokens }
  return deepFreeze({
    target: { provider: target.provider, model: target.model },
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...resolveRetention(override ?? {}, inheritedRetention),
    summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
    summarizationModel: override?.summarizationModel ?? config.summarizationModel,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
  })
}

/**
 * Scale one routed policy into concrete token budgets for its model capacity.
 *
 * Pressure is capped by both the window fraction and the capacity remaining
 * after the routed output reservation plus compaction headroom. Retention scales
 * the message budget before headroom is deducted.
 *
 * @param policy - merged policy for the exact routed target.
 * @param contextWindow - positive adapter-owned capacity for that target.
 * @param reservedCompletionTokens - output tokens one routed request reserves.
 * @returns detached immutable pressure and retention budgets.
 */
export function resolveCompactSpec(
  policy: ResolvedTargetPolicy,
  contextWindow: number,
  reservedCompletionTokens: number,
): ResolvedCompactSpec {
  const targetKey = `${policy.target.provider}/${policy.target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`,
    )
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: reservedCompletionTokens (${reservedCompletionTokens}) `
      + 'must be a non-negative integer',
    )
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `of its ${contextWindow}-token context window, leaving no message budget; configure `
      + "the adapter model's contextWindow above the effective request maxTokens",
    )
  }
  const pressureBudgetTokens = messageBudgetTokens - policy.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new TargetPressureConfigError(
      targetKey,
      `compaction-basic: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `and ${policy.headroomTokens} headroom tokens of its ${contextWindow}-token context `
      + 'window, leaving no pressure budget; reduce the effective request maxTokens or '
      + 'compaction headroomTokens, or configure a larger adapter model contextWindow',
    )
  }
  const thresholdTokens = Math.floor(Math.min(
    contextWindow * policy.thresholdRatio,
    pressureBudgetTokens,
  ))
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudgetTokens * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    throw new TargetPressureConfigError(
      targetKey,
      `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens `
      + `(${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    target: { ...policy.target },
    contextWindow,
    thresholdRatio: policy.thresholdRatio,
    thresholdTokens,
    retainTokens,
    summarizationProvider: policy.summarizationProvider,
    summarizationModel: policy.summarizationModel,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  })
}

/** Choose an explicit retention form or inherit the already-resolved fallback. */
function resolveRetention(
  config: CompactionPolicyConfig,
  fallback: ResolvedRetention,
): ResolvedRetention {
  if (config.retainTokens !== undefined) return { retainTokens: config.retainTokens }
  if (config.retainRatio !== undefined) return { retainRatio: config.retainRatio }
  return fallback
}

/** Reject a capacity-independent retention conflict at plugin load. */
function validateRatioRetention(
  thresholdRatio: number,
  retention: ResolvedRetention,
  name: string,
): void {
  if (retention.retainRatio !== undefined && retention.retainRatio >= thresholdRatio) {
    throw new Error(
      `${name}: retainRatio (${retention.retainRatio}) must be less than `
      + `the resolved thresholdRatio (${thresholdRatio})`,
    )
  }
}

/** Validate, detach, and reject duplicate exact-target policies. */
function resolveModelPolicies(configured: unknown): ModelCompactPolicyConfig[] {
  if (configured === undefined) return []
  if (!Array.isArray(configured)) {
    throw new Error('BasicCompactionConfig: modelPolicies must be an array')
  }
  const seen = new Set<string>()
  return configured.map((source: unknown, index) => {
    const name = `BasicCompactionConfig: modelPolicies[${index}]`
    assertModelPolicy(source, name)
    const key = `${source.provider}\u0000${source.model}`
    if (seen.has(key)) {
      throw new Error(
        `BasicCompactionConfig: duplicate model policy for ${source.provider}/${source.model}`,
      )
    }
    seen.add(key)
    return { ...source }
  })
}

/** Validate one untrusted exact-target override and narrow its public type. */
function assertModelPolicy(
  source: unknown,
  name: string,
): asserts source is ModelCompactPolicyConfig {
  if (!isUnknownRecord(source)) throw new Error(`${name} must be an object`)
  validateKeys(source, MODEL_POLICY_KEYS, name)
  assertNonEmptyString(`${name}.provider`, source.provider)
  assertNonEmptyString(`${name}.model`, source.model)
  validatePolicy(source, name)
}

/** Validate the fields common to defaults and exact-target partial overrides. */
function validatePolicy(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const thresholdRatio = config.thresholdRatio
  const headroomTokens = config.headroomTokens
  const retainRatio = config.retainRatio
  const retainTokens = config.retainTokens
  const maxTokens = config.maxTokens
  const compactionRetries = config.compactionRetries
  const maxOverflowRetries = config.maxOverflowRetries
  if (thresholdRatio !== undefined) assertRatio(`${name}.thresholdRatio`, thresholdRatio)
  if (headroomTokens !== undefined) assertNonNegativeInteger(`${name}.headroomTokens`, headroomTokens)
  if (retainRatio !== undefined) assertRatio(`${name}.retainRatio`, retainRatio)
  if (retainTokens !== undefined) assertNonNegativeInteger(`${name}.retainTokens`, retainTokens)
  if (retainRatio !== undefined && retainTokens !== undefined) {
    throw new Error(`${name}: retainRatio and retainTokens are mutually exclusive`)
  }
  if (maxTokens !== undefined) assertPositiveInteger(`${name}.maxTokens`, maxTokens)
  if (compactionRetries !== undefined) {
    assertNonNegativeInteger(`${name}.compactionRetries`, compactionRetries)
  }
  if (maxOverflowRetries !== undefined) {
    assertNonNegativeInteger(`${name}.maxOverflowRetries`, maxOverflowRetries)
  }

  validateSummarizationPair(config, name)
}

/** Require one scope to omit, clear, or replace the summarization target as a pair. */
function validateSummarizationPair(
  config: CompactionPolicyConfig | Record<string, unknown>,
  name: string,
): void {
  const provider = config.summarizationProvider
  const model = config.summarizationModel
  if (provider !== undefined && typeof provider !== 'string') {
    throw new Error(`${name}.summarizationProvider must be a string`)
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new Error(`${name}.summarizationModel must be a string`)
  }
  if (provider === undefined && model === undefined) return
  if (provider === undefined || model === undefined
    || (provider.length === 0) !== (model.length === 0)) {
    throw new Error(
      `${name}: summarizationProvider and summarizationModel must be set together `
      + 'as an empty or non-empty pair',
    )
  }
}

/** Reject stale or misspelled keys before defaults can hide them. */
function validateKeys(config: object, keys: ReadonlySet<string>, name: string): void {
  for (const key of Object.keys(config)) {
    if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`)
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertPositiveInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} (${String(value)}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1]`)
  }
}

/**
 * Validate the top-level context-UX fields before a default can hide a stale
 * value. Pinning and the recall footer are deployment options, not per-model
 * policy, so they are rejected outside the service-wide config object.
 * @param config - untrusted plugin configuration after Loader normalization.
 */
function validateContextUx(config: BasicCompactionConfig): void {
  if (config.recallFooter !== undefined && typeof config.recallFooter !== 'string') {
    throw new Error('BasicCompactionConfig.recallFooter must be a string')
  }
  if (config.recallFooterTools !== undefined) {
    if (!Array.isArray(config.recallFooterTools)) {
      throw new Error('BasicCompactionConfig.recallFooterTools must be an array of tool names')
    }
    for (const [index, name] of config.recallFooterTools.entries()) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error(
          `BasicCompactionConfig.recallFooterTools[${index}] must be a non-empty string`,
        )
      }
    }
  }
  if (config.pinLeadingUserMessages !== undefined) {
    assertNonNegativeInteger(
      'BasicCompactionConfig.pinLeadingUserMessages',
      config.pinLeadingUserMessages,
    )
  }
  if (config.pinLeadingMaxTokens !== undefined) {
    assertPositiveInteger('BasicCompactionConfig.pinLeadingMaxTokens', config.pinLeadingMaxTokens)
  }
  if (config.pinScope !== undefined && config.pinScope !== 'child' && config.pinScope !== 'all') {
    throw new Error('BasicCompactionConfig.pinScope must be "child" or "all"')
  }
}

/** Validate the summariser resilience bounds before a default can hide a stale value. */
function validateSummarizerResilience(config: BasicCompactionConfig): void {
  if (config.summarizerUnknownWindowTokens !== undefined) {
    assertPositiveInteger(
      'BasicCompactionConfig.summarizerUnknownWindowTokens',
      config.summarizerUnknownWindowTokens,
    )
  }
  if (config.summarizerFrameRetries !== undefined) {
    assertNonNegativeInteger(
      'BasicCompactionConfig.summarizerFrameRetries',
      config.summarizerFrameRetries,
    )
  }
  if (config.summarizerFrameShrinkRatio !== undefined) {
    assertOpenRatio('BasicCompactionConfig.summarizerFrameShrinkRatio', config.summarizerFrameShrinkRatio)
  }
  if (config.summarizerEscalationFailures !== undefined) {
    assertPositiveInteger(
      'BasicCompactionConfig.summarizerEscalationFailures',
      config.summarizerEscalationFailures,
    )
  }
  if (config.summarizerCircuitFailures !== undefined) {
    assertPositiveInteger(
      'BasicCompactionConfig.summarizerCircuitFailures',
      config.summarizerCircuitFailures,
    )
  }
  if (config.mechanicalFallbackFreeShare !== undefined) {
    assertRatio(
      'BasicCompactionConfig.mechanicalFallbackFreeShare',
      config.mechanicalFallbackFreeShare,
    )
  }
}

/** A finite number strictly between 0 and 1, so a shrink attempt always shrinks. */
function assertOpenRatio(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} (${String(value)}) must be a number in (0, 1)`)
  }
}

/** Detach the validated summariser resilience fields with their shipped defaults. */
function resolveSummarizerResilience(config: BasicCompactionConfig): ResolvedSummarizerResilience {
  return {
    summarizerUnknownWindowTokens:
      config.summarizerUnknownWindowTokens ?? DEFAULT_SUMMARIZER_UNKNOWN_WINDOW_TOKENS,
    summarizerFrameRetries: config.summarizerFrameRetries ?? DEFAULT_SUMMARIZER_FRAME_RETRIES,
    summarizerFrameShrinkRatio:
      config.summarizerFrameShrinkRatio ?? DEFAULT_SUMMARIZER_FRAME_SHRINK_RATIO,
    summarizerEscalationFailures:
      config.summarizerEscalationFailures ?? DEFAULT_SUMMARIZER_ESCALATION_FAILURES,
    summarizerCircuitFailures:
      config.summarizerCircuitFailures ?? DEFAULT_SUMMARIZER_CIRCUIT_FAILURES,
    mechanicalFallbackFreeShare:
      config.mechanicalFallbackFreeShare ?? DEFAULT_MECHANICAL_FALLBACK_FREE_SHARE,
  }
}

/** Detach the validated context-UX fields with their shipped defaults. */
function resolveContextUx(config: BasicCompactionConfig): ResolvedContextUxConfig {
  return {
    recallFooter: config.recallFooter ?? '',
    recallFooterTools: [...(config.recallFooterTools ?? [])],
    pinLeadingUserMessages: config.pinLeadingUserMessages ?? 1,
    pinLeadingMaxTokens: config.pinLeadingMaxTokens ?? DEFAULT_PIN_LEADING_MAX_TOKENS,
    pinScope: config.pinScope ?? 'child',
  }
}
