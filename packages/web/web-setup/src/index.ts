/**
 * `web-setup` — host controller for wizard-driven web search and fetch setup.
 *
 * The welcome wizard's web step cannot use `settings.mutate`: the fields it
 * writes (`web.searchProvider`/`fetchProvider`, `tool-web.search`/`fetch`, and
 * provider rows) are non-volatile or structural. This plugin instead owns the
 * `webSetup` Remote namespace (`status`, `validateProvider`, `applySetup`),
 * which stores candidate keys in the credential vault and drives
 * `ctx.configEditor` row surgery with the Loader's hot-remount path.
 *
 * @module @deepseek-ai/dsh-web-setup
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { WebSetupService } from './remote.ts'
import type { WebSetupConfigEditor, WebSetupCredentialsSeam } from './types.ts'

export {
  CANARY_TIMEOUT_MS,
  runHttpCanary,
} from './canaries.ts'
export type { CanaryOptions } from './canaries.ts'
export {
  anyProviderSpec,
  catalogKeyRefs,
  providerSpec,
  TOOL_WEB_PLUGIN_NAME,
  TOOL_WEB_ROW_ID,
  WEB_PLUGIN_NAME,
  WEB_ROW_ID,
  WEB_SETUP_PROVIDERS,
} from './catalog.ts'
export { missingCredentialError, pendingRestartMessage, WebSetupService } from './remote.ts'
export type {
  WebSetupApplyRequest,
  WebSetupApplyResult,
  WebSetupCanary,
  WebSetupConfigEditor,
  WebSetupCredentialState,
  WebSetupCredentialsSeam,
  WebSetupEditorRow,
  WebSetupFetch,
  WebSetupMountedProvider,
  WebSetupPendingRestart,
  WebSetupProviderKind,
  WebSetupProviderSpec,
  WebSetupSearchSelection,
  WebSetupSeams,
  WebSetupStatus,
  WebSetupToolToggles,
  WebSetupValidateRequest,
  WebSetupValidation,
} from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-setup'

/** The config editor owns every row this plugin touches. */
export const inject = ['configEditor']

/** Plugin config; the wizard drives every input through `webSetup` methods. */
export const Config = z.object({})

/** Compile-time check that the live config editor still satisfies the seam this package drives. */
function editorSeam(editor: ConfigEditor | undefined): WebSetupConfigEditor | undefined {
  return editor
}

/** Compile-time check that the live credential provider still satisfies the seam this package drives. */
function credentialsSeam(provider: CredentialProvider | undefined): WebSetupCredentialsSeam | undefined {
  return provider
}

/**
 * Mount the `webSetup` service. Seams are read lazily per call so a credential
 * provider or config editor that mounts later is seen, and so a deployment
 * without one degrades to a reported result instead of failing the boot.
 * @param ctx - owning context.
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('web-setup')
  new WebSetupService(ctx, () => {
    const configEditor = editorSeam(ctx.get('configEditor'))
    const credentials = credentialsSeam(ctx.get('credentials'))
    return {
      ...configEditor === undefined ? {} : { configEditor },
      ...credentials === undefined ? {} : { credentials },
      fetchImpl: (url, init) => globalThis.fetch(url, init),
      env: process.env,
      log: (line) => { logger.info(line) },
    }
  })
}
