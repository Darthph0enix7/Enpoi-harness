/** Shared projection of the live LLM registry into the browser model catalog. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ModelCatalog,
  ModelReasoning,
  ModelSelection,
} from './types.ts'

/**
 * Native input kinds a resolved descriptor effectively carries, in display
 * order. Only an exact model whose route declared the descriptor answers any;
 * advertised-only modalities stay in `advertisedInputModalities`.
 * @param resolved - exact route metadata resolved from its adapter.
 * @returns effective modalities with admitted native kinds appended, or undefined when the route disclosed none.
 */
function effectiveInputModalities(resolved: LlmResolvedModelInfo): ModelModality[] | undefined {
  if (resolved.inputModalities === undefined) return undefined
  const modalities = [...resolved.inputModalities]
  const inputs = resolved.nativeFileInputs
  if (inputs === undefined) return modalities
  const kinds = new Set<ModelModality>()
  for (const mime of Object.keys(inputs.encoders)) {
    if (mime === 'application/pdf') kinds.add('pdf')
    else if (mime.startsWith('audio/')) kinds.add('audio')
    else if (mime.startsWith('video/')) kinds.add('video')
  }
  for (const kind of ['pdf', 'audio', 'video'] as const) {
    if (kinds.has(kind) && !modalities.includes(kind)) modalities.push(kind)
  }
  return modalities
}

/**
 * Model ids per provider whose stored settings row is marked `unverified`.
 * Provider-sync writes that marker when a row's capacities or capabilities
 * rest on labeled id-hints or on no disclosure at all; the picker reads the
 * marker from the catalog, so the projection carries it from the same route
 * profile the panel reads.
 * @param ctx - Host context whose optional settings service holds route profiles.
 * @returns provider → model ids marked unverified; empty when settings is absent.
 */
function unverifiedModelIds(ctx: Context): ReadonlyMap<string, ReadonlySet<string>> {
  const unverified = new Map<string, ReadonlySet<string>>()
  const settings = ctx.get('settings')
  if (settings === undefined) return unverified
  const descriptors = settings.describe({ redactSecrets: true })
  for (const provider of ctx.llm.listConfigurableProviders()) {
    const descriptor = descriptors.find(row => row.ns === provider.settingsNs)
    let profile: unknown = descriptor?.value
    for (const key of provider.settingsPath) {
      profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    }
    const models = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'models') : undefined
    if (!Array.isArray(models)) continue
    const ids = new Set<string>()
    for (const model of models) {
      if (typeof model !== 'object' || model === null || Reflect.get(model, 'unverified') !== true) continue
      const id = Reflect.get(model, 'id')
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
    if (ids.size > 0) unverified.set(provider.provider, ids)
  }
  return unverified
}

/**
 * Build the browser model catalog without requiring a Session.
 * @param ctx - Host context carrying the live LLM registry.
 * @param defaultSelection - deployment default used before a Session selects a model.
 * @returns successful non-empty provider groups and isolated provider failures.
 */
export async function buildModelCatalog(
  ctx: Context,
  defaultSelection: ModelSelection = ctx.agentDefaultModel.currentSelection(),
): Promise<ModelCatalog> {
  const providers = ctx.llm.listProviders()
  const unverified = unverifiedModelIds(ctx)
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort }),
          }
        const inputModalities = effectiveInputModalities(resolved)
        const advertisedInputModalities = resolved.advertisedInputModalities === undefined
          ? undefined
          : [...resolved.advertisedInputModalities]
        const unsupportedReasoningEfforts = resolved.unsupportedReasoningEfforts === undefined
          ? undefined
          : [...resolved.unsupportedReasoningEfforts]
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(resolved.context?.contextWindow === undefined
            ? {}
            : { contextWindow: resolved.context.contextWindow }),
          ...(resolved.context?.source === undefined
            ? {}
            : { contextWindowSource: resolved.context.source }),
          ...(resolved.context?.maxInputTokens === undefined
            ? {}
            : { maxInputTokens: resolved.context.maxInputTokens }),
          ...(resolved.context?.maxInputTokensSource === undefined
            ? {}
            : { maxInputTokensSource: resolved.context.maxInputTokensSource }),
          ...(resolved.maxOutputTokens === undefined
            ? {}
            : { maxTokens: resolved.maxOutputTokens }),
          ...(resolved.maxOutputTokensSource === undefined
            ? {}
            : { maxTokensSource: resolved.maxOutputTokensSource }),
          ...(resolved.defaultMaxTokens === undefined
            ? {}
            : { defaultMaxTokens: resolved.defaultMaxTokens }),
          ...(inputModalities === undefined ? {} : { inputModalities }),
          ...(advertisedInputModalities === undefined ? {} : { advertisedInputModalities }),
          ...(resolved.tools === undefined ? {} : { tools: resolved.tools }),
          ...(unverified.get(provider.id)?.has(model.id) === true ? { unverified: true } : {}),
          ...(unsupportedReasoningEfforts === undefined
            ? {}
            : { unsupportedReasoningEfforts }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }
      }))
      return {
        kind: 'group' as const,
        group: { id: provider.id, name: provider.name, models: entries },
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  const groups = catalog.flatMap(item => item.kind === 'group' ? [item.group] : [])
    .filter(group => group.models.length > 0)
  return {
    default: { ...defaultSelection },
    routableProviders: groups.map(group => group.id),
    groups,
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}

/**
 * Check a GUI selection against the current available provider catalog.
 * @param ctx - Host LLM registry.
 * @param selection - stored or explicitly requested selection.
 * @returns whether the exact model is currently advertised as available.
 */
export async function modelAvailable(ctx: Context, selection: ModelSelection): Promise<boolean> {
  if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) return false
  let models: readonly LlmModelInfo[]
  try { models = await ctx.llm.listModels(selection.provider) }
  catch (error) {
    throw new RemoteError('session/model-unavailable',
      error instanceof Error ? error.message : String(error),
      { provider: selection.provider, model: selection.model })
  }
  return models.some(model => model.id === selection.model)
}

/**
 * Check configured provider API-key references independently of model availability.
 * @param ctx - Host registry, settings, and credential services.
 * @returns whether any API-key provider has a configured credential.
 */
export async function hasProviderApiKey(ctx: Context): Promise<boolean> {
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')
  if (settings === undefined || credentials === undefined) {
    throw new RemoteError('session/provider-credentials-unavailable', 'provider credentials are unavailable', {})
  }
  const namespaces = settings.describe({ redactSecrets: true })
  for (const provider of ctx.llm.listConfigurableProviders()) {
    if (provider.provider === 'deepseek-account') continue
    let profile = namespaces.find(namespace => namespace.ns === provider.settingsNs)?.value
    for (const key of provider.settingsPath) {
      profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
    }
    if (typeof profile !== 'object' || profile === null) continue
    const ref: unknown = Reflect.get(profile, 'apiKeyEnv')
    if (typeof ref === 'string' && ref.length > 0
      && (await credentials.describe(credentialRef(ref))).configured) return true
  }
  return false
}
