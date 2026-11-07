/** pi-ai model helpers assembled from public narrow entry points. */

import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type {
  Api,
  CreateModelsOptions,
  Model,
  ModelThinkingLevel,
  MutableModels,
  Provider,
  ProviderAuth,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import { THINKING_LEVELS } from './catalog.ts'

/** Input accepted by the static, single-protocol providers this package builds. */
interface StaticProviderOptions {
  id: string
  name: string
  baseUrl?: string
  auth: ProviderAuth
  models: readonly Model<Api>[]
  api: ProviderStreams
}

/**
 * Create an empty pi-ai collection without importing its aggregate entry point.
 * @param options - credential storage and ambient authentication integrations.
 * @returns a mutable collection with no registered providers.
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
  const models = builtinModels(options)
  models.clearProviders()
  return models
}

/**
 * Create the static, single-protocol provider used by configured custom routes.
 * @param input - provider identity, models, authentication, and protocol implementation.
 * @returns a provider that delegates each operation to the supplied protocol.
 */
export function createProvider(input: StaticProviderOptions): Provider {
  return {
    id: input.id,
    name: input.name,
    ...input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl },
    auth: input.auth,
    getModels: () => input.models,
    stream: (model, context, options) => input.api.stream(model, context, options),
    streamSimple: (model, context, options) => input.api.streamSimple(model, context, options),
  }
}

/**
 * Resolve selectable reasoning levels from pi-ai's public model metadata.
 *
 * Only a level the descriptor explicitly maps to a non-null wire value is
 * selectable. An absent map means no source disclosed a ladder — pi-ai's own
 * provider default applies and choosing an effort is refused — while a
 * `{ off: null }` map discloses only that off is unavailable. `off` itself is
 * selectable when the map omits it but discloses another level: omission means
 * "supported, send nothing" for a map that otherwise names spellings, and the
 * configured-entry path uses exactly that shape for an explicit `off: null`.
 * @param model - model descriptor carrying reasoning support and wire mappings.
 * @returns disclosed levels in pi-ai's escalation order.
 */
export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  if (!model.reasoning) return []
  const map = model.thinkingLevelMap
  if (map === undefined) return []
  const disclosed = THINKING_LEVELS.filter(level =>
    level !== 'off' && map[level] !== undefined && map[level] !== null)
  const offWire = map.off !== undefined && map.off !== null
  if (disclosed.length === 0 && !offWire) return []
  return THINKING_LEVELS.filter(level => level === 'off'
    ? offWire || (map.off === undefined && disclosed.length > 0)
    : map[level] !== undefined && map[level] !== null)
}
