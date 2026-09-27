/** Shared Host wiring for the DeepSeek protocol adapter. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from './types.ts'

/**
 * Register one provider with request-local transport services and live retry policy.
 * @param ctx - provider plugin lifetime with the LLM registry injected.
 * @param provider - exact route owned by this plugin.
 * @param dependencies - provider-owned discovery, credential, and configuration callbacks.
 * `enabled` is read at mount and on every volatile config update: a false
 * answer withdraws the route from the registry, so a shipped route a settings
 * surface removed stops serving without a restart.
 */
export function registerDeepSeekProvider<C extends DeepSeekConnectionOptions>(
  ctx: Context, provider: string, dependencies: Pick<DeepSeekAdapterOptions<C>,
  'options' | 'resolveAuth' | 'providerName' | 'discoverModels'> & { enabled?: () => boolean }): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  let userId: AnonymousUserId | undefined
  // `enabled` is this wiring's own input; the adapter receives only its options.
  const { enabled: _enabled, ...adapterDependencies } = dependencies
  const adapter = new DeepSeekAdapter({
    ...adapterDependencies,
    resolveUserId: () => userId ??= getOrCreateAnonymousUserId(),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`llm-deepseek: unusable Messages replay state on assistant history for route "${provider}/${model}"; sending provider-neutral content (${reason})`)
    },
    onExtensionsOmitted: ({ provider, model, fields, error }) => {
      ctx.logger.warn(`llm-deepseek: sending route "${provider}/${model}" without request extension fields ${fields.join(', ')} because they failed to serialize: %o`, error)
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
  const enabled = (): boolean => dependencies.enabled?.() ?? true
  let registration: AdapterRegistrationHandle | undefined
  let registeredPolicy: ReturnType<typeof dependencies.options>['retryPolicy'] | undefined
  let registeredEnabled = false
  // One reconcile path for mount and volatile updates: the route set and the
  // registration-captured retry policy both force a `replace`, and a disabled
  // route stays out of the registry until a later config enables it again.
  const sync = (): void => {
    const nextEnabled = enabled()
    const policy = dependencies.options().retryPolicy
    if (registration === undefined) {
      registeredPolicy = policy
      if (!nextEnabled) return
      registration = ctx.llm.registerAdapter([provider], adapter)
      registeredEnabled = true
      return
    }
    const policyChanged = !deepEqualJson(policy, registeredPolicy)
    registeredPolicy = policy
    if (nextEnabled === registeredEnabled && (!nextEnabled || !policyChanged)) return
    registration.replace(nextEnabled ? [provider] : [])
    registeredEnabled = nextEnabled
  }
  // The mount call propagates an invalid configuration; only later updates log.
  sync()
  ctx.on('loader/volatile-update', () => {
    try { sync() }
    catch (error) { ctx.logger.warn(error) }
  })
}
