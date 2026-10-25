/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { CONTEXT_WINDOW_EXCEEDED_CODE, HarnessError, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling services available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-tools'
import {
  applySettingsOverrides,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import type { PinLeadingOptions, RecallFraming } from './region.ts'
import { readCompactionSettings, resolveCompactionSeat } from './settings.ts'
import {
  resolveSummarizationTarget,
  SUMMARIZER_NO_REGION_CONTENT_CODE,
  summarizationFailureCause,
  summarizeWithLlm,
} from './summarizer.ts'
import type { SummarizationInput, SummarizationFraming, SummaryConfig, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedSummarizerResilience,
  ResolvedTargetPolicy,
} from './types.ts'

/**
 * Failure code recorded on the mechanical checkpoint when a summariser route's
 * circuit is open. It names the state rather than a provider refusal, so a
 * post-hoc reader can tell "we stopped paying" from "the provider said no".
 */
export const SUMMARIZER_CIRCUIT_OPEN_CODE = 'SUMMARIZER_CIRCUIT_OPEN'

/** Re-exported framing failure code; see {@link SUMMARIZER_NO_REGION_CONTENT_CODE} in the summariser. */
export { SUMMARIZER_NO_REGION_CONTENT_CODE }

/**
 * Whether one thrown summarisation failure is a framing decision rather than a
 * route fault: no region content means the next identical compaction would fail
 * the same way, so counting it toward escalation or the circuit would only mask
 * the real reason on later checkpoints.
 * @param error - value thrown by the summariser call.
 * @returns true when the request carried no shadowed-span content.
 */
function isFramingFailure(error: unknown): boolean {
  return error instanceof LlmError && error.code === SUMMARIZER_NO_REGION_CONTENT_CODE
}

/** Consecutive failures counted against one summariser route in one session. */
interface SummarizerRouteState {
  /** Paid attempts that failed since the last success or reset. */
  failures: number
  /** Whether the route is circuit-open and must not be called. */
  open: boolean
  /** The most recent recorded failure class, for the durable circuit notice. */
  lastCode: string
}

/** Stable map key for one resolved summariser route. */
function routeKey(route: { readonly provider: string; readonly model: string }): string {
  return `${route.provider}/${route.model}`
}

/** The synthetic failure that keeps a circuit-open route from being paid again. */
function circuitOpenError(key: string, state: SummarizerRouteState): HarnessError {
  return new HarnessError(
    `summariser route ${key} is circuit-open after ${state.failures} consecutive `
    + `failures (${state.lastCode}); no summary call is paid on it until the route, `
    + 'the session configuration, or /compact resets it',
    SUMMARIZER_CIRCUIT_OPEN_CODE,
  )
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** One priced surface node from the conversation meter. */
interface PricedSurfaceNode {
  readonly seq: SessionSeq
  readonly tokens: number
}

/** Sum the priced cost of the inclusive positional range the selection returned. */
function pricedRangeTokens(
  nodes: readonly PricedSurfaceNode[],
  start: SessionSeq,
  end: SessionSeq,
): number {
  let total = 0
  for (const node of nodes) {
    if (node.seq >= start && node.seq <= end) total += node.tokens
  }
  return total
}

/**
 * Whether every node in the range is a compaction-produced replacement (a
 * framed checkpoint). Re-summarising these compounds loss, so such a range is
 * never worth a summary pass on its own.
 */
function isCheckpointOnlyRange(
  session: Session,
  nodes: readonly PricedSurfaceNode[],
  start: SessionSeq,
  end: SessionSeq,
): boolean {
  let sawNode = false
  for (const node of nodes) {
    if (node.seq < start || node.seq > end) continue
    sawNode = true
    if (!isCompactionCheckpointNode(session, node.seq)) return false
  }
  return sawNode
}

/** Whether one surface node is a `user/message` replacement authored by a compaction summary. */
function isCompactionCheckpointNode(session: Session, seq: SessionSeq): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const event = session.eventAt(seq)
  if (event?.type !== 'user/message') return false
  const op = event.surfaceOp
  // `SurfaceOp` also has the plain-string form; the object guard is required at
  // runtime even where the static type has already narrowed.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  if (typeof op !== 'object' || op === null || op.op !== 'replace') return false
  return (event.sourceEventSeqs ?? []).some((source) => {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return session.eventAt(source)?.type === 'compaction/summary'
  })
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const summarizerUnknownWindowTokensSchema = z.number().step(1).min(1)
const summarizerFrameRetriesSchema = z.number().step(1).min(0)
const summarizerFrameShrinkRatioSchema = z.number()
const summarizerEscalationFailuresSchema = z.number().step(1).min(1)
const summarizerCircuitFailuresSchema = z.number().step(1).min(1)
const mechanicalFallbackFreeShareSchema = z.number()

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    recallFooter: z.string(),
    recallFooterTools: z.array(z.string()),
    pinLeadingUserMessages: z.number().step(1).min(0),
    pinLeadingMaxTokens: z.number().step(1).min(1),
    pinScope: z.union(['child', 'all'] as const),
    summarizerUnknownWindowTokens: summarizerUnknownWindowTokensSchema,
    summarizerFrameRetries: summarizerFrameRetriesSchema,
    summarizerFrameShrinkRatio: summarizerFrameShrinkRatioSchema,
    summarizerEscalationFailures: summarizerEscalationFailuresSchema,
    summarizerCircuitFailures: summarizerCircuitFailuresSchema,
    mechanicalFallbackFreeShare: mechanicalFallbackFreeShareSchema,
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly warnedPressureReliefTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /** Consecutive summariser failures per session route, and whether its circuit is open. */
  private readonly summarizerRoutes = new WeakMap<Session, Map<string, SummarizerRouteState>>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      // A resumed session or a revision of the routed configuration re-probes
      // every summariser route once more instead of inheriting a stale breaker.
      if (event.type === 'request/header'
        && (event.data.reason === 'resume' || event.data.reason === 'change')) {
        this.summarizerRoutes.delete(session)
        return
      }
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.effectiveConfig(), target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * The `personas.compaction` seat, when assigned, overrides the summariser
   * route (a different model loses the prefix cache and pays the region's full
   * input price); a seat naming a model group carries the group id, so one
   * summary request fails over across the group's members. When the
   * summariser's own context window is smaller than the
   * region, the replay is capped to fit and the durable checkpoint records the
   * un-summarized seqs for recall. An unresolvable window is framed by the
   * conservative `summarizerUnknownWindowTokens` budget instead of the whole
   * region. Consecutive failures on one route escalate to the session's own
   * routed provider/model, then open that route's circuit until the route, the
   * session configuration, or `/compact` resets it. Override this sole hook for
   * a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const settings = this.effectiveConfig()
    const config: SummaryConfig = target === undefined
      ? settings
      : resolveTargetPolicy(settings, target)
    const seat = resolveCompactionSeat(this.ctx)
    const preferred: SummaryConfig = seat === undefined
      ? config
      : {
        ...config,
        summarizationProvider: seat.provider,
        summarizationModel: seat.model,
        ...seat.chain === undefined ? {} : { summarizationChain: seat.chain },
      }
    const preferredRoute = resolveSummarizationTarget(preferred, agent)
    if (preferredRoute === undefined) {
      // No route at all is a configuration failure, not a route fault: never
      // count it toward a circuit or hide its actionable message.
      return summarizeWithLlm(this.ctx, preferred, input, agent, signal)
    }
    const fallback: SummaryConfig | undefined = target === undefined
      ? undefined
      : {
        summarizationProvider: target.provider,
        summarizationModel: target.model,
        maxTokens: config.maxTokens,
      }
    const preferredKey = routeKey(preferredRoute)
    const fallbackKey = target === undefined ? undefined : routeKey(target)
    // The observed routes bound the state table: a changed route has no entry,
    // so it starts with a clean counter (the "try once more" after a change).
    this.pruneSummarizerRoutes(agent.session, [
      preferredKey,
      ...fallbackKey === undefined || fallbackKey === preferredKey ? [] : [fallbackKey],
    ])
    const preferredState = this.summarizerRouteState(agent.session, preferredKey)
    const escalateTo = fallbackKey !== undefined
      && fallbackKey !== preferredKey
      && (preferredState.open || preferredState.failures >= settings.summarizerEscalationFailures)
      ? fallbackKey
      : undefined
    if (preferredState.open && escalateTo === undefined) throw circuitOpenError(preferredKey, preferredState)
    const active = escalateTo === undefined ? preferred : fallback
    const activeKey = escalateTo ?? preferredKey
    if (active === undefined) throw circuitOpenError(preferredKey, preferredState)
    const activeState = this.summarizerRouteState(agent.session, activeKey)
    if (activeState.open) throw circuitOpenError(activeKey, activeState)
    try {
      const framing = await this.summarizerFraming(
        active,
        agent,
        settings.summarizerUnknownWindowTokens,
        signal,
      )
      const result = await summarizeWithLlm(this.ctx, active, input, agent, signal, framing)
      activeState.failures = 0
      activeState.open = false
      activeState.lastCode = ''
      return result
    } catch (error: unknown) {
      // Cancellation is not a route fault, and an input that carried no region
      // content is a framing decision that would repeat identically on every
      // route: neither may count toward escalation or the breaker, or the
      // recorded failure would stop explaining why the call was never made.
      if (signal?.aborted !== true && !isFramingFailure(error)) {
        const cause = summarizationFailureCause(error)
        activeState.failures += 1
        activeState.lastCode = cause.code
        if (activeState.failures >= settings.summarizerCircuitFailures) {
          activeState.open = true
          this.ctx.logger.warn(
            `compaction: summariser route ${activeKey} open after `
            + `${activeState.failures} consecutive failures (${cause.code}); `
            + 'no further summary call is paid on it until the route, the session '
            + 'configuration, or /compact resets it',
          )
        }
      }
      throw error
    }
  }

  /** Resolve the summariser's usable input budget from its own context window. */
  private async summarizerFraming(
    config: SummaryConfig,
    agent: Agent,
    unknownWindowTokens: number,
    signal?: AbortSignal,
  ): Promise<SummarizationFraming> {
    // An unresolved window never sends the whole region: the conservative cap
    // is marked so the checkpoint explains the real reason for the clip.
    const conservative: SummarizationFraming = {
      inputBudgetTokens: unknownWindowTokens,
      unknownWindow: true,
    }
    const target = resolveSummarizationTarget(config, agent)
    if (target === undefined) return conservative
    try {
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
      const contextWindow = info.context?.contextWindow
      if (contextWindow === undefined) return conservative
      // The summariser's own completion is capped by the resolved generation
      // cap; never reserve more than half the window so the replay keeps room.
      const outputReserve = Math.min(config.maxTokens, Math.floor(contextWindow / 2))
      const inputBudgetTokens = contextWindow - outputReserve
      return inputBudgetTokens > 0 ? { inputBudgetTokens } : conservative
    } catch {
      // No window metadata or a metadata fault: the conservative cap keeps the
      // request bounded; the size-class retry ladder still applies on refusal.
      return conservative
    }
  }

  /** Drop state for routes no longer observed, so a route change resets its circuit. */
  private pruneSummarizerRoutes(session: Session, keep: readonly string[]): void {
    const routes = this.summarizerRoutes.get(session)
    if (routes === undefined) return
    for (const key of routes.keys()) {
      if (!keep.includes(key)) routes.delete(key)
    }
  }

  /** Consecutive-failure state for one summariser route in one session. */
  private summarizerRouteState(session: Session, key: string): SummarizerRouteState {
    let routes = this.summarizerRoutes.get(session)
    if (routes === undefined) {
      routes = new Map()
      this.summarizerRoutes.set(session, routes)
    }
    let state = routes.get(key)
    if (state === undefined) {
      state = { failures: 0, open: false, lastCode: '' }
      routes.set(key, state)
    }
    return state
  }

  /** Plugin config overlaid with the live `parameters.compaction` settings values. */
  private effectiveConfig(): ResolvedConfig {
    return applySettingsOverrides(this.config, readCompactionSettings(this.ctx))
  }

  /** Leading user messages pinned for this session under the configured scope. */
  private pinLeading(session: Session): PinLeadingOptions {
    const count = this.config.pinScope === 'all'
      || session.header.parentSession !== undefined
      ? this.config.pinLeadingUserMessages
      : 0
    return { count, maxTokens: this.config.pinLeadingMaxTokens }
  }

  /** Whether one named tool resolves in the compacting agent's own scope. */
  private toolVisible(agent: Agent, name: string): boolean {
    // A structural or headless agent without its own scoped context is read
    // through the plugin context, which is the same global view in a real boot.
    const agentContext = (agent.ctx as Context | undefined) ?? this.ctx
    return this.ctx.get('tools')?.get(name, scopeOf(agentContext)) !== undefined
  }

  /**
   * Resolve the recall wording for one compaction. The last omission sentence
   * needs both recall tools; the configured footer needs every tool it names.
   * A composition that lacks them is never told to use a tool it cannot call.
   */
  private recallFraming(agent: Agent): RecallFraming {
    const searchRead = this.toolVisible(agent, 'session_event_search')
      && this.toolVisible(agent, 'session_event_read')
    const footer = this.config.recallFooter.length > 0
      && this.config.recallFooterTools.every(name => this.toolVisible(agent, name))
      ? this.config.recallFooter
      : undefined
    return { searchRead, ...footer === undefined ? {} : { footer } }
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.effectiveConfig(), target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(
        agent.session,
        measurement,
        0,
        this.pinLeading(agent.session),
      )
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(
        agent.session,
        measurement,
        spec.retainTokens,
        this.pinLeading(agent.session),
      )
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      // A checkpoint-only range re-summarises derived content (loss compounds)
      // and a range whose removal still leaves the surface above threshold
      // cannot relieve pressure: the retained tail alone dominates. Warn once
      // per target and fall through instead of retrying every step.
      const rangeTokens = pricedRangeTokens(measurement.nodes, range.start, range.end)
      const checkpointOnly = isCheckpointOnlyRange(agent.session, measurement.nodes, range.start, range.end)
      if (checkpointOnly || (attempt > 0 && measurement.totalTokens - rangeTokens >= spec.thresholdTokens)) {
        this.warnCannotRelieve(targetKey, {
          totalTokens: measurement.totalTokens,
          thresholdTokens: spec.thresholdTokens,
          rangeTokens,
          retainTokens: spec.retainTokens,
          checkpointOnly,
        })
        return result
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.thresholdTokens) return result
    }

    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * Emit one diagnostic when a cut cannot relieve pressure, keyed by target so
   * a per-step trigger never repeats it. stderr is the observable channel: the
   * harness logger buffers info/warn.
   * @param targetKey - `provider/model` whose pressure could not be relieved.
   * @param numbers - the priced numbers behind the refusal.
   */
  private warnCannotRelieve(
    targetKey: string,
    numbers: { totalTokens: number; thresholdTokens: number; rangeTokens: number; retainTokens: number; checkpointOnly: boolean },
  ): void {
    if (this.warnedPressureReliefTargets.has(targetKey)) return
    this.warnedPressureReliefTargets.add(targetKey)
    const line = `compaction-basic: ${targetKey} cannot relieve pressure`
      + ` (surface ${numbers.totalTokens} >= threshold ${numbers.thresholdTokens};`
      + ` removable ${numbers.checkpointOnly ? 'checkpoint-only' : 'span'} ${numbers.rangeTokens} tokens,`
      + ` retained tail budget ${numbers.retainTokens}); skipping summary`
    this.ctx.logger.warn(line)
    process.stderr.write(`[compaction-basic] ${line}\n`)
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface', allowMechanicalFallback: true },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    // An explicit /compact is the operator's request to try the route again.
    this.summarizerRoutes.delete(agent.session)
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
            this.pinLeading(agent.session),
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              allowMechanicalFallback: false,
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
      warn: (line) => { this.ctx.logger.warn(line) },
      framing: agent => this.recallFraming(agent),
      summarizerPolicy: {
        frameRetries: this.config.summarizerFrameRetries,
        frameShrinkRatio: this.config.summarizerFrameShrinkRatio,
        mechanicalFreeShare: this.config.mechanicalFallbackFreeShare,
      },
    }
  }
}

export default BasicCompactionEngine
