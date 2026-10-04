/**
 * Jina Reader-backed `WebFetchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service, and resolves its optional credential
 * through `ctx.credentials` on every fetch so a vault-stored key applies live;
 * without a key it stays on Jina's keyless quota.
 *
 * @module @deepseek-ai/dsh-web-fetch-jina
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { JinaFetchProvider, JINA_DEFAULT_BASE_URL } from './provider.ts'
import type { JinaFetchProviderOptions } from './provider.ts'
import type { JinaEngine } from './types.ts'

export {
  JINA_DEFAULT_BASE_URL,
  JINA_MAX_URL_LENGTH,
  JINA_PROVIDER_ID,
  JinaFetchProvider,
} from './provider.ts'
export type { JinaFetchProviderOptions } from './provider.ts'
export type { JinaEngine, JinaError } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-jina'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'JINA_API_KEY'

/** Settings namespace carrying this provider's endpoint, engine, limits, and key reference. */
export const WEB_FETCH_JINA_SETTINGS_NAMESPACE = 'web-fetch-jina'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Jina API key; prefer {@link apiKeyEnv} so no secret enters configuration files. Omitted = keyless. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each fetch; defaults to `JINA_API_KEY`. A missing value keeps the keyless mode. */
  apiKeyEnv: Volatile<string>
  /** Endpoint base; the target URL is appended as a path. Defaults to the public Reader. */
  baseURL: Volatile<string | undefined>
  /** Browser engine sent as `X-Engine`; omitted = Jina's automatic choice. */
  engine: Volatile<JinaEngine | undefined>
  /** Page-load wait in seconds sent as `X-Timeout`, at most 180. */
  timeoutSeconds: Volatile<number | undefined>
  /** Output-token cap sent as `X-Max-Tokens`, at least 500; Jina trims rather than rejects. */
  maxTokens: Volatile<number | undefined>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  engine: z.union(['browser', 'direct', 'cf-browser-rendering'] as const).volatile(),
  timeoutSeconds: z.number().step(1).min(1).max(180).volatile(),
  maxTokens: z.number().step(1).min(500).volatile(),
})

/**
 * Project one resolved section into the options the provider serves its next
 * fetch with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one fetch.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): JinaFetchProviderOptions {
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
    baseURL: config.baseURL ?? JINA_DEFAULT_BASE_URL,
    ...config.engine !== undefined ? { engine: config.engine } : {},
    ...config.timeoutSeconds !== undefined ? { timeoutSeconds: config.timeoutSeconds } : {},
    ...config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {},
  }
}

/** Register the Jina Reader fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerFetchProvider(new JinaFetchProvider(() => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(),
    engine: config.engine.get(), timeoutSeconds: config.timeoutSeconds.get(), maxTokens: config.maxTokens.get(),
  })))
}
