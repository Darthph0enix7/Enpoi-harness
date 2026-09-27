/** API-key authentication and discovery for the official DeepSeek route. */
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { registerDeepSeekProvider, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import { Config, plainOptions, resolveAdapterOptions } from './config.ts'
import type { ResolvedDeepSeekOptions } from './config.ts'

export { Config, plainOptions, resolveAdapterOptions } from './config.ts'
export type { Options, ResolvedDeepSeekOptions } from './config.ts'
export const name = 'llm-deepseek-api-key'
export const inject = ['llm']

const PROVIDER = 'deepseek-official'

export function apply(ctx: Context, config: Config): void {
  const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx))
  options()
  const resolveApiKey = async (connection: ResolvedDeepSeekOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
  /** Whether the Models page has removed this shipped route. */
  const enabled = (): boolean => !config.disabled.get()
  const entry: LlmConfigurableProvider = {
    provider: PROVIDER,
    displayName: 'DeepSeek',
    settingsNs: ctx.fiber.entry?.options.id ?? name,
    settingsPath: [],
  }
  // `registerConfigurableProviders` refuses an empty initial set, so a route
  // disabled at boot registers and withdraws in one synchronous step — before
  // any remote reader can observe the directory. Later flips reconcile here;
  // the adapter side reconciles through the shared Host wiring. A replace only
  // runs on an actual flip, so an unrelated volatile update publishes no
  // topology event.
  const directory = ctx.llm.registerConfigurableProviders([entry])
  let directoryEnabled = true
  const syncDirectory = (): void => {
    const next = enabled()
    if (next === directoryEnabled) return
    directory.replace(next ? [entry] : [])
    directoryEnabled = next
  }
  if (!enabled()) syncDirectory()
  registerDeepSeekProvider(ctx, PROVIDER, {
    options, providerName: 'DeepSeek',
    enabled,
    resolveAuth: async connection => ({ headers: { 'x-api-key': await resolveApiKey(connection) } }),
    discoverModels: (provider) => {
      const connection = options()
      return Promise.resolve(connection.models.map(model => catalogModelInfo(provider, model)))
    },
  })
  ctx.on('loader/volatile-update', () => {
    try { syncDirectory() } catch (error) { ctx.logger.error(error) }
  })
}
