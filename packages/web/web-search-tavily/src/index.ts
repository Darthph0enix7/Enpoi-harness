/**
 * Tavily-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service, and resolves its credential through
 * `ctx.credentials` on every search so a vault-stored key applies live.
 *
 * @module @deepseek-ai/dsh-web-search-tavily
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  TavilySearchProvider,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_MAX_RESULTS,
} from './provider.ts'
import type { TavilySearchProviderOptions } from './provider.ts'
import type { TavilyAnswerMode, TavilySearchDepth, TavilyTimeRange, TavilyTopic } from './types.ts'

export {
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_DEFAULT_SEARCH_DEPTH,
  TAVILY_MAX_RESULTS,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
} from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'
export type { TavilyAnswerMode, TavilySearchDepth, TavilyTimeRange, TavilyTopic } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-tavily'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'

/** Settings namespace carrying this provider's endpoint, depth, filters, and key reference. */
export const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = 'web-search-tavily'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Tavily API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `TAVILY_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL: Volatile<string | undefined>
  /** Retrieval depth sent as Tavily's `search_depth`. Defaults to `basic`. */
  searchDepth: Volatile<TavilySearchDepth>
  /** Default result count when a request carries no `maxResults`; Tavily caps a request at 20. */
  maxResults: Volatile<number | undefined>
  /** Request a generated answer (`true`/`basic` quick, `advanced` detailed). */
  includeAnswer: Volatile<TavilyAnswerMode | undefined>
  /** Recency window sent as Tavily's `time_range`. */
  timeRange: Volatile<TavilyTimeRange | undefined>
  /** Search category sent as Tavily's `topic`. */
  topic: Volatile<TavilyTopic | undefined>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  searchDepth: z.union(['basic', 'advanced'] as const).default(TAVILY_DEFAULT_SEARCH_DEPTH).volatile(),
  maxResults: z.number().step(1).min(1).max(TAVILY_MAX_RESULTS).volatile(),
  includeAnswer: z.union([z.boolean(), 'basic', 'advanced'] as const).volatile(),
  timeRange: z.union(['day', 'week', 'month', 'year'] as const).volatile(),
  topic: z.union(['general', 'news', 'finance'] as const).volatile(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): TavilySearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth,
    ...config.maxResults !== undefined ? { maxResults: config.maxResults } : {},
    ...config.includeAnswer !== undefined ? { includeAnswer: config.includeAnswer } : {},
    ...config.timeRange !== undefined ? { timeRange: config.timeRange } : {},
    ...config.topic !== undefined ? { topic: config.topic } : {},
  }
}

/** Register the Tavily search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    searchDepth: config.searchDepth.get(), maxResults: config.maxResults.get(),
    includeAnswer: config.includeAnswer.get(), timeRange: config.timeRange.get(), topic: config.topic.get(),
  })))
}
