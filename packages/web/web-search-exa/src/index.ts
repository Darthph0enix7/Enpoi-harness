/**
 * Exa-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service, and resolves its credential through
 * `ctx.credentials` on every search so a vault-stored key applies live.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'
import type { ExaSearchProviderOptions } from './provider.ts'
import type { ExaCategory, ExaSearchType } from './types.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  EXA_TEXT_FALLBACK_MAX_CHARS,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'
export type { ExaCategory, ExaSearchType } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'EXA_API_KEY'

/** Settings namespace carrying this provider's endpoint, mode, filters, and key reference. */
export const WEB_SEARCH_EXA_SETTINGS_NAMESPACE = 'web-search-exa'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `EXA_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL: Volatile<string | undefined>
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType: Volatile<ExaSearchType>
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults: Volatile<number | undefined>
  /** Highlight excerpts requested per result. Defaults to 1. */
  highlightsPerResult: Volatile<number>
  /** Only results published after this ISO-8601 instant. */
  startPublishedDate: Volatile<string | undefined>
  /** Only results published before this ISO-8601 instant. */
  endPublishedDate: Volatile<string | undefined>
  /** Exa data-category focus. `company`/`people` reject date and exclusion filters. */
  category: Volatile<ExaCategory | undefined>
  /** Restrict results to these domains or domain paths. */
  includeDomains: Volatile<string[] | undefined>
  /** Drop results from these domains or domain paths. */
  excludeDomains: Volatile<string[] | undefined>
  /** Force a live fetch instead of cached page content. */
  livecrawl: Volatile<boolean | undefined>
  /**
   * Request full page text. Set `maxCharacters` to enable it: a schemastery
   * object node resolves to `{}` when unset, so an absent cap is
   * indistinguishable from an unset field.
   */
  text: Volatile<{
    /** Maximum characters of page text to request. */
    maxCharacters: number
  } | undefined>
  /** Request a generated per-page summary. */
  summary: Volatile<boolean | undefined>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  searchType: z
    .union(['instant', 'fast', 'auto', 'deep-lite', 'deep', 'deep-reasoning'] as const)
    .default(EXA_DEFAULT_SEARCH_TYPE)
    .volatile(),
  numResults: z.number().step(1).min(1).volatile(),
  highlightsPerResult: z.number().step(1).min(1).default(EXA_DEFAULT_HIGHLIGHTS_PER_RESULT).volatile(),
  startPublishedDate: z.string().volatile(),
  endPublishedDate: z.string().volatile(),
  category: z
    .union(['company', 'people', 'publication', 'news', 'personal site', 'financial report'] as const)
    .volatile(),
  includeDomains: z.array(z.string()).volatile(),
  excludeDomains: z.array(z.string()).volatile(),
  livecrawl: z.boolean().volatile(),
  text: z.object({ maxCharacters: z.number().step(1).min(1) }).volatile(),
  summary: z.boolean().volatile(),
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
): ExaSearchProviderOptions {
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
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType,
    highlightsPerResult: config.highlightsPerResult,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
    ...config.startPublishedDate !== undefined ? { startPublishedDate: config.startPublishedDate } : {},
    ...config.endPublishedDate !== undefined ? { endPublishedDate: config.endPublishedDate } : {},
    ...config.category !== undefined ? { category: config.category } : {},
    ...config.includeDomains !== undefined && config.includeDomains.length > 0
      ? { includeDomains: config.includeDomains }
      : {},
    ...config.excludeDomains !== undefined && config.excludeDomains.length > 0
      ? { excludeDomains: config.excludeDomains }
      : {},
    ...config.livecrawl !== undefined ? { livecrawl: config.livecrawl } : {},
    ...config.text?.maxCharacters !== undefined ? { text: config.text } : {},
    ...config.summary !== undefined ? { summary: config.summary } : {},
  }
}

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    searchType: config.searchType.get(), numResults: config.numResults.get(),
    highlightsPerResult: config.highlightsPerResult.get(), startPublishedDate: config.startPublishedDate.get(),
    endPublishedDate: config.endPublishedDate.get(), category: config.category.get(),
    includeDomains: config.includeDomains.get(), excludeDomains: config.excludeDomains.get(),
    livecrawl: config.livecrawl.get(), text: config.text.get(), summary: config.summary.get(),
  })))
}
