/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  ClientRemote, CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  WebSetupApplyOutcome, WebSetupOperations, WebSetupStatusOutcome, WebSetupValidateOutcome,
} from './web-setup.ts'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/**
 * The generated `webSetup` Remote face. api-remotes mounts the contribution
 * whenever the assembly selects it; an install without the web-setup
 * controller has no `remote.webSetup` service at all.
 */
type WebSetupFace = ClientRemote['webSetup']

/**
 * Read the web-setup namespace service from the optional-dependency store.
 * `remote.webSetup` is optional: declaring it in `inject` would park this
 * plugin's fiber on installs without the web-setup controller, so the read
 * goes through `ctx.get`, which resolves the service whenever it is mounted
 * and yields undefined otherwise; every caller degrades to a refused outcome.
 * @param ctx - the page plugin's context.
 * @returns the namespace face, or undefined when the service is not mounted.
 */
function webSetupFace(ctx: ClientContext): WebSetupFace | undefined {
  return ctx.get('remote.webSetup') as WebSetupFace | undefined
}

/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
  /** The web-search step's status, canary, and atomic apply calls. */
  webSetup: WebSetupOperations
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  return {
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
    webSetup: {
      status: async (): Promise<WebSetupStatusOutcome> => {
        const face = webSetupFace(ctx)
        if (face === undefined) return { kind: 'refused', message: '' }
        const response = await face.status()
        return response.ok
          ? { kind: 'status', status: response.value }
          : { kind: 'refused', message: response.error.message }
      },
      validateProvider: async (request): Promise<WebSetupValidateOutcome> => {
        const face = webSetupFace(ctx)
        if (face === undefined) return { kind: 'refused', message: '' }
        const response = await face.validateProvider(request)
        if (!response.ok) return { kind: 'refused', message: response.error.message }
        const validation = response.value
        return validation.ok
          ? { kind: 'validated', latencyMs: validation.latencyMs ?? 0 }
          : { kind: 'invalid', reason: validation.error ?? '' }
      },
      applySetup: async (request): Promise<WebSetupApplyOutcome> => {
        const face = webSetupFace(ctx)
        if (face === undefined) return { kind: 'refused', message: '' }
        const response = await face.applySetup(request)
        if (!response.ok) return { kind: 'refused', message: response.error.message }
        const result = response.value
        // A pending restart is an accepted apply whose reconcile could not be
        // hot-mounted; it is not a refusal, and the wizard advances with the
        // host's own diagnostic on the notice line.
        if (result.pendingRestart !== undefined) {
          return { kind: 'applied', applied: result.applied, pendingRestart: result.pendingRestart }
        }
        if (!result.ok) return { kind: 'refused', message: result.error ?? '' }
        return { kind: 'applied', applied: result.applied, pendingRestart: null }
      },
    },
  }
}
