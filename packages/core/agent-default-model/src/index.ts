/**
 * Default model selection for an Agent without a session-specific selection.
 * A configured pair that names no provider or model resolves to the keyless
 * Kilo Gateway free tier by default, so an Agent is never created without a
 * provider; the owning deployment can opt out with `baseline: off`.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { pruneUnusableChains, type ModelChainRegistry } from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Baseline policy for an unset provider or model. */
export type BaselineMode = 'kilo' | 'off'

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Optional model-group id whose links route the default selection's requests. */
  chain?: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
  /**
   * Fallback for an unset (blank) provider or model. `kilo` (default) resolves
   * each blank field to the keyless Kilo Gateway free tier; `off` keeps blanks
   * blank, so a deployment that configures no route creates Agents without the
   * Kilo fallback.
   */
  baseline: Volatile<BaselineMode>
}

/**
 * Route the baseline selection resolves to when no provider is configured:
 * the keyless Kilo Gateway, which the first-run seed also writes.
 */
export const BASELINE_PROVIDER = 'kilo'
/**
 * Model the baseline selection resolves to. Measured against the live gateway
 * on 2026-10-25: this id answered with real content (262k context, tools, and
 * reasoning advertised), while the retired `kilo-auto/free` answered 200 with
 * EMPTY content and `kilo-auto/balanced` answered 400 "You need to sign in to
 * use this model". The first-run seed writes the same id.
 */
export const BASELINE_MODEL = 'poolside/laguna-s-2.1:free'
/**
 * Model group the baseline pairs with: the shipped `free` selector group, so a
 * dead first attempt escalates through the zero-priced catalogue instead of
 * leaving the Session with nothing. Omitted when the configured model is set.
 */
export const BASELINE_CHAIN = 'free'

/**
 * Resolve a possibly unset provider/model pair against the configured baseline.
 * A blank field is an unset selection, never a route or model id. Under the
 * default `kilo` baseline a deployment that selects nothing still starts every
 * Session on a provider; under `off` the blanks stay blank and the consumer
 * owns the missing route. When the model falls back to {@link BASELINE_MODEL},
 * the resolved selection also carries {@link BASELINE_CHAIN}, the same fallback
 * rung the seed writes; a configured model keeps its own routing and gets no
 * implicit group.
 * @param configured - provider and model as configured; blank means unset.
 * @param baseline - baseline policy; omitted means the shipped `kilo` default.
 * @returns the configured pair, or the Kilo baseline pair plus its free group.
 */
export function resolveBaseline(
  configured: { provider: string; model: string },
  baseline: BaselineMode = 'kilo',
): { provider: string; model: string; chain?: string } {
  if (baseline === 'off') return { provider: configured.provider, model: configured.model }
  return {
    provider: configured.provider === '' ? BASELINE_PROVIDER : configured.provider,
    model: configured.model === '' ? BASELINE_MODEL : configured.model,
    ...configured.model === '' ? { chain: BASELINE_CHAIN } : {},
  }
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: {
  provider: string
  model: string
  chain?: string
  reasoningEffort?: string
}): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.chain === undefined ? {} : { chain: settings.chain },
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) },
  }
}

/** Structural view of the live provider registry the diagnostic reads. */
interface ProviderRouteRegistry {
  listProviders(): readonly { id: string }[]
}

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()
  /** Providers already warned about, so one dangling route warns once. */
  private readonly warnedMissing = new Set<string>()

  static Config = z.object({
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    chain: z.string().volatile(),
    reasoningEffort: z.string().volatile(),
    baseline: z.union(['kilo', 'off'] as const).default('kilo').volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Warn once when a selected provider route is not registered with the live
   * adapter registry. A route that disappeared from the settings document
   * without the Models page's removal cleanup (a hand edit, a composition
   * change, or a host-side teardown) leaves every consumer reading a route the
   * next request cannot reach; this diagnostic names the dangling selection
   * without changing it. Settings are always live, so a later registration of
   * the same provider stops the warning and clears the one-shot record: a
   * second disappearance is a new incident and must warn again.
   * @param provider - the resolved provider route id.
   */
  private diagnoseMissingRoute(provider: string): void {
    if (provider === '') return
    const registry = this.ownerContext.get('llm') as ProviderRouteRegistry | undefined
    if (registry === undefined) return
    if (registry.listProviders().some(candidate => candidate.id === provider)) {
      this.warnedMissing.delete(provider)
      return
    }
    if (this.warnedMissing.has(provider)) return
    this.warnedMissing.add(provider)
    this.ownerContext.logger.warn(
      `agent-default-model: selected provider "${provider}" is not registered; sessions created now will fail until it is re-added or the default model is reset`,
    )
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    const chain = this.config.chain?.get()
    const resolved = selection({
      ...resolveBaseline({
        provider: this.config.provider.get(),
        model: this.config.model.get(),
      }, this.config.baseline.get()),
      ...chain === undefined ? {} : { chain },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
    this.diagnoseMissingRoute(resolved.provider)
    return resolved
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves. A `chain` the optional
   * `modelChains` registry cannot route is dropped before the profile write.
   * The deployment's `baseline` policy is not part of a selection and is carried
   * over from the live entry, so a model pick never silently re-enables the Kilo
   * fallback an owner turned off; an entry that carries no legal policy (a
   * legacy row) records the live Config value, so every saved row has one.
   * The write re-validates the picked route against the live registry: a route
   * removed while the save waited in the queue is not resurrected as a dangling
   * default — the write falls back to the baseline pair instead.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const fields = {
      provider: next.provider, model: next.model,
      ...next.chain === undefined ? {} : { chain: next.chain },
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }
    // A pick can echo the seat's live `chain`; a group the runtime cannot
    // route must not reach the profile through this path either.
    const config = pruneUnusableChains(
      fields,
      this.ctx.get('modelChains') as ModelChainRegistry | undefined,
      (fieldPath, value) => {
        this.ctx.logger.warn(`agent-default-model: dropped unusable chain "${value}" at ${fieldPath}: the model group is disabled, unknown, or unregistered`)
      },
    )
    const saved = this.saves.then(() => editor.edit(entry, (current) => {
      // A legacy row may carry no legal policy at all; prefer the stored one,
      // then the live Config, so the write always records a baseline.
      const stored = current?.baseline
      const baseline = stored === 'kilo' || stored === 'off'
        ? stored
        : this.config.baseline.get() ?? 'kilo'
      // The route may have been removed while this save waited in the queue;
      // re-validate against the live registry so the write cannot resurrect a
      // dangling default. An absent registry leaves nothing to check.
      const registry = this.ownerContext.get('llm') as ProviderRouteRegistry | undefined
      const dangling = registry !== undefined
        && !registry.listProviders().some(candidate => candidate.id === next.provider)
      return {
        ...config,
        ...dangling ? resolveBaseline({ provider: '', model: '' }, baseline) : {},
        baseline,
      }
    }))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
