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
/** Model the baseline selection resolves to: the gateway's free auto tier. */
export const BASELINE_MODEL = 'kilo-auto/free'

/**
 * Resolve a possibly unset provider/model pair against the configured baseline.
 * A blank field is an unset selection, never a route or model id. Under the
 * default `kilo` baseline a deployment that selects nothing still starts every
 * Session on a provider; under `off` the blanks stay blank and the consumer
 * owns the missing route.
 * @param configured - provider and model as configured; blank means unset.
 * @param baseline - baseline policy; omitted means the shipped `kilo` default.
 * @returns the configured pair, or the Kilo free-auto baseline per blank field.
 */
export function resolveBaseline(
  configured: { provider: string; model: string },
  baseline: BaselineMode = 'kilo',
): { provider: string; model: string } {
  if (baseline === 'off') return { provider: configured.provider, model: configured.model }
  return {
    provider: configured.provider === '' ? BASELINE_PROVIDER : configured.provider,
    model: configured.model === '' ? BASELINE_MODEL : configured.model,
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

/**
 * Owns the default model selection independently of any Host or transport.
 * Each operation reads the owning Config references.
 */
export class AgentDefaultModelConfig extends Service {
  private saves: Promise<void> = Promise.resolve()

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
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection {
    const reasoningEffort = this.config.reasoningEffort.get()
    const chain = this.config.chain?.get()
    return selection({
      ...resolveBaseline({
        provider: this.config.provider.get(),
        model: this.config.model.get(),
      }, this.config.baseline.get()),
      ...chain === undefined ? {} : { chain },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves. A `chain` the optional
   * `modelChains` registry cannot route is dropped before the profile write.
   * The deployment's `baseline` policy is not part of a selection and is carried
   * over from the live entry, so a model pick never silently re-enables the Kilo
   * fallback an owner turned off.
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
      const baseline = current.baseline
      return baseline === 'kilo' || baseline === 'off' ? { ...config, baseline } : config
    }))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
