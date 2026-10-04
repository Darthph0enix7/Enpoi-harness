/**
 * Brave-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service, and resolves its credential through
 * `ctx.credentials` on every search so a vault-stored key applies live.
 *
 * @module @deepseek-ai/dsh-web-search-brave
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BraveSearchProvider,
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_MAX_COUNT,
} from './provider.ts'
import type { BraveSearchProviderOptions } from './provider.ts'

export {
  BRAVE_DEFAULT_BASE_URL,
  BRAVE_DEFAULT_COUNT,
  BRAVE_MAX_COUNT,
  BRAVE_PROVIDER_ID,
  BraveSearchProvider,
} from './provider.ts'
export type { BraveSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-brave'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'BRAVE_API_KEY'

/** Settings namespace carrying this provider's endpoint, count, filters, and key reference. */
export const WEB_SEARCH_BRAVE_SETTINGS_NAMESPACE = 'web-search-brave'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Brave API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `BRAVE_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; `/res/v1/web/search` is appended. Defaults to the public API. */
  baseURL: Volatile<string | undefined>
  /** Default result count when a request carries no `maxResults`; Brave caps a request at 20. */
  count: Volatile<number>
  /**
   * Deployment-level freshness window: `pd` (past day), `pw` (past week), `pm`
   * (past month), `py` (past year), or an ISO-8601 range
   * `YYYY-MM-DDtoYYYY-MM-DD`. The seam's request has no recency field, so this
   * cannot vary per query without a seam change.
   */
  freshness: Volatile<string | undefined>
  /** Two-letter country code sent as Brave's `country`. */
  country: Volatile<string | undefined>
  /** Search-language code sent as Brave's `search_lang`. */
  searchLang: Volatile<string | undefined>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  count: z.number().step(1).min(1).max(BRAVE_MAX_COUNT).default(BRAVE_DEFAULT_COUNT).volatile(),
  freshness: z.string().volatile(),
  country: z.string().volatile(),
  searchLang: z.string().volatile(),
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
): BraveSearchProviderOptions {
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
    baseURL: config.baseURL ?? BRAVE_DEFAULT_BASE_URL,
    count: config.count,
    ...config.freshness !== undefined ? { freshness: config.freshness } : {},
    ...config.country !== undefined ? { country: config.country } : {},
    ...config.searchLang !== undefined ? { searchLang: config.searchLang } : {},
  }
}

/** Register the Brave search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new BraveSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    count: config.count.get(), freshness: config.freshness.get(), country: config.country.get(),
    searchLang: config.searchLang.get(),
  })))
}
