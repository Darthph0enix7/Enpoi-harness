/**
 * SearXNG-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service; the instance base URL is required and
 * the instance's own authentication, if any, stays outside this provider.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SearxngSearchProvider } from './provider.ts'
import type { SearxngSearchProviderOptions } from './provider.ts'
import type { SearxngSafeSearch, SearxngTimeRange } from './types.ts'

export { SEARXNG_PROVIDER_ID, SearxngSearchProvider } from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'
export type {
  SearxngError,
  SearxngResult,
  SearxngSafeSearch,
  SearxngSearchResponse,
  SearxngTimeRange,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying this provider's endpoint and search filters. */
export const WEB_SEARCH_SEARXNG_SETTINGS_NAMESPACE = 'web-search-searxng'

/** Plugin config (all optional except the instance base — `apply` fills constant defaults). */
export interface Config {
  /** Instance base URL; `/search` is appended. Required — SearXNG has no public default instance. */
  baseURL: Volatile<string>
  /** Comma-separated SearXNG categories, e.g. `general,news`. */
  categories: Volatile<string | undefined>
  /** Language code sent as `language`; `auto` defers to the instance. */
  language: Volatile<string | undefined>
  /** Recency window sent as `time_range`. */
  timeRange: Volatile<SearxngTimeRange | undefined>
  /** Restrict results to these engine names; joined with commas as `engines`. Empty = every engine. */
  engines: Volatile<string[]>
  /** Safe-search level sent as `safesearch`: `0` none, `1` moderate, `2` strict. */
  safesearch: Volatile<SearxngSafeSearch | undefined>
}

export const Config = z.object({
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().required().volatile(),
  categories: z.string().volatile(),
  language: z.string().volatile(),
  timeRange: z.union(['day', 'week', 'month', 'year'] as const).volatile(),
  engines: z.array(z.string()).default([]).volatile(),
  safesearch: z.union([0, 1, 2] as const).volatile(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * search with. The provider performs no environment or credential fallback:
 * SearXNG is keyless, so every value here comes from the section alone.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(
  config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): SearxngSearchProviderOptions {
  return {
    baseURL: config.baseURL,
    ...config.categories !== undefined ? { categories: config.categories } : {},
    ...config.language !== undefined ? { language: config.language } : {},
    ...config.timeRange !== undefined ? { timeRange: config.timeRange } : {},
    ...config.engines.length > 0 ? { engines: config.engines } : {},
    ...config.safesearch !== undefined ? { safesearch: config.safesearch } : {},
  }
}

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider(() => resolveOptions({
    baseURL: config.baseURL.get(), categories: config.categories.get(), language: config.language.get(),
    timeRange: config.timeRange.get(), engines: config.engines.get(), safesearch: config.safesearch.get(),
  })))
}
