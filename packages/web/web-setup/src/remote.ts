/**
 * The `webSetup` Typert Remote namespace: the host controller the welcome
 * wizard drives. `status` projects the effective provider selection from the
 * live profile rows; `validateProvider` runs a one-shot canary; `applySetup`
 * stores vault credentials, performs provider/`web`/`tool-web` row surgery
 * through `ctx.configEditor`, and reports what committed.
 *
 * Row surgery is sequential and non-atomic by design: every operation reports
 * after it commits, and the first failure returns the operations already
 * applied. A config-editor write that fails is reported as a `pendingRestart`
 * because the change could not be hot-applied to the running profile.
 *
 * @module @deepseek-ai/dsh-web-setup/remote
 */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { runHttpCanary } from './canaries.ts'
import {
  anyProviderSpec,
  catalogKeyRefs,
  providerSpec,
  TOOL_WEB_PLUGIN_NAME,
  TOOL_WEB_ROW_ID,
  WEB_PLUGIN_NAME,
  WEB_ROW_ID,
  WEB_SETUP_PROVIDERS,
} from './catalog.ts'
import type {
  WebSetupApplyRequest,
  WebSetupApplyResult,
  WebSetupConfigEditor,
  WebSetupCredentialState,
  WebSetupEditorRow,
  WebSetupMountedProvider,
  WebSetupProviderKind,
  WebSetupProviderSpec,
  WebSetupSeams,
  WebSetupStatus,
  WebSetupValidateRequest,
  WebSetupValidation,
} from './types.ts'

/** A request the service refuses before any write. */
class SetupRefusal extends Error {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host controller for wizard-driven web search and fetch setup. */
    webSetup: WebSetupService
  }
}

/** A config-editor operation that could not be hot-applied; reported via `pendingRestart`. */
class SetupPendingRestart extends Error {
  constructor(readonly ns: string, message: string) {
    super(message)
  }
}

/** One normalized `applySetup` group. */
interface NormalizedSearch {
  provider: string | null
  apiKey?: string
  baseURL?: string
}

/** The service behind the generated `webSetup` Remote namespace. */
export class WebSetupService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes its seams. */
  static inject: string[] = []

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param seams - lazy host seams; each may mount after this plugin.
   */
  constructor(ctx: Context, private readonly seams: () => WebSetupSeams) {
    super(ctx, 'webSetup')
  }

  /** Diagnostics sink; absent seams default to no logging. */
  private log(line: string): void {
    this.seams().log?.(`[web-setup] ${line}`)
  }

  /** Monotonic clock used for canary latency. */
  private clock(): () => number {
    return this.seams().now ?? (() => performance.now())
  }

  /** Live Loader rows, or none when the editor seam is absent or unreadable. */
  private rows(editor: WebSetupConfigEditor): readonly WebSetupEditorRow[] {
    try {
      return editor.entries()
    } catch (error) {
      this.log(`configEditor.entries() failed: ${messageOf(error)}`)
      return []
    }
  }

  /**
   * The effective search/fetch provider read from the live `web` row — the
   * row's own config first, then the `DSH_WEB_*` environment fallback that
   * `WebRuntime` itself resolves. `entries()` is the config-editor projection
   * of active Loader entries (the same rows the running composition mounted);
   * settings describe cannot see these non-volatile fields.
   */
  private effectiveProvider(rows: readonly WebSetupEditorRow[], field: 'searchProvider' | 'fetchProvider', env: Record<string, string | undefined>): string | null {
    const envName = field === 'searchProvider' ? 'DSH_WEB_SEARCH_PROVIDER' : 'DSH_WEB_FETCH_PROVIDER'
    const web = rows.find(row => row.options.id === WEB_ROW_ID || row.options.name === WEB_PLUGIN_NAME)
    if (web === undefined) return null
    const configured = web.options.config?.[field]
    if (typeof configured === 'string' && configured !== '') return configured
    const fromEnv = env[envName]
    return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : null
  }

  /** Catalog providers with a live, enabled row carrying their module name. */
  private mountedProviders(rows: readonly WebSetupEditorRow[]): WebSetupMountedProvider[] {
    const mounted: WebSetupMountedProvider[] = []
    for (const spec of WEB_SETUP_PROVIDERS) {
      if (rows.some(row => row.options.name === spec.row.name && row.options.disabled !== true)) {
        mounted.push({ kind: spec.kind, provider: spec.id })
      }
    }
    return mounted
  }

  /** One credential state per catalog reference; an absent seam reports all unconfigured. */
  private async credentialStates(): Promise<Record<string, WebSetupCredentialState>> {
    const refs = catalogKeyRefs()
    const credentials = this.seams().credentials
    if (credentials === undefined) {
      return Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: false }]))
    }
    const entries = await Promise.all(refs.map(async (ref): Promise<[string, WebSetupCredentialState]> => {
      try {
        const info = await credentials.describe(credentialRef(ref))
        return [ref, {
          configured: info.configured,
          ...info.source === undefined ? {} : { source: info.source },
          writable: info.writable,
        }]
      } catch (error) {
        this.log(`credentials.describe(${ref}) failed: ${messageOf(error)}`)
        return [ref, { configured: false, writable: false }]
      }
    }))
    return Object.fromEntries(entries)
  }

  /** Resolve one catalog reference to its current value; resolution failures read as absent. */
  private async storedKey(ref: string | null): Promise<string | undefined> {
    if (ref === null) return undefined
    const credentials = this.seams().credentials
    if (credentials === undefined) return undefined
    try {
      const resolved = await credentials.resolve(credentialRef(ref))
      return resolved?.value
    } catch (error) {
      this.log(`credentials.resolve(${ref}) failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * The effective provider selection, the mounted catalog providers, and the
   * vault state of every catalog reference.
   * @returns the status projection; row reads that fail degrade to empty state.
   */
  @Remote
  async status(): Promise<WebSetupStatus> {
    const editor = this.seams().configEditor
    const env = this.seams().env
    const rows = editor === undefined ? [] : this.rows(editor)
    return {
      searchProvider: this.effectiveProvider(rows, 'searchProvider', env),
      fetchProvider: this.effectiveProvider(rows, 'fetchProvider', env),
      mounted: this.mountedProviders(rows),
      credentials: await this.credentialStates(),
    }
  }

  /**
   * Run one live provider canary. The candidate key is one-shot; when the
   * request carries none, the catalog reference is resolved from the vault.
   * `deepseek-official` reports credential presence only (it reuses the model
   * key and its search is a full auxiliary model request), and `http` reports
   * success without an external call.
   * @param request - kind, provider id, and optional one-shot key/baseURL.
   * @param signal - caller cancellation supplied by the Remote carrier.
   * @returns the probe outcome; every failure is a value, never a throw.
   */
  @Remote
  async validateProvider(request: WebSetupValidateRequest, signal: AbortSignal): Promise<WebSetupValidation> {
    try {
      const input = recordOrUndefined(request)
      if (input === undefined) return { ok: false, error: 'validateProvider: request must be an object' }
      const kind = input.kind
      if (kind !== 'search' && kind !== 'fetch') return { ok: false, error: 'validateProvider: kind must be "search" or "fetch"' }
      const provider = input.provider
      if (typeof provider !== 'string' || provider === '') return { ok: false, error: 'validateProvider: provider must be a non-empty string' }
      if (input.apiKey !== undefined && typeof input.apiKey !== 'string') return { ok: false, error: 'validateProvider: apiKey must be a string' }
      if (input.baseURL !== undefined && typeof input.baseURL !== 'string') return { ok: false, error: 'validateProvider: baseURL must be a string' }
      const spec = providerSpec(kind, provider)
      if (spec === undefined) {
        const other = anyProviderSpec(provider)
        return {
          ok: false,
          error: other === undefined
            ? `unknown ${kind} provider "${provider}"`
            : `"${provider}" is a ${other.kind} provider, not ${kind}`,
        }
      }
      const apiKey = input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : await this.storedKey(spec.keyRef)
      const baseURL = input.baseURL !== undefined && input.baseURL !== '' ? input.baseURL : undefined
      if (spec.canary.kind === 'none') return { ok: true }
      if (spec.canary.kind === 'credential') {
        return apiKey === undefined ? { ok: false, error: missingCredentialError(spec) } : { ok: true }
      }
      return await runHttpCanary({
        spec,
        ...apiKey === undefined ? {} : { apiKey },
        ...baseURL === undefined ? {} : { baseURL },
        fetchImpl: this.seams().fetchImpl,
        now: this.clock(),
        signal,
      })
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * Apply one setup selection: store a given key, ensure the provider rows,
   * set `web.searchProvider`/`fetchProvider` (`null` unsets), and write the
   * `tool-web` toggles. `toolToggles.search`/`fetch` may only be `true` when
   * the effective provider exists and its row is mounted or mounted by this
   * call; a refusal stops before the tool row is touched.
   * @param request - selections and toggles; absent groups leave rows untouched.
   * @returns the committed operations, or the first failure with them.
   */
  @Remote
  async applySetup(request: WebSetupApplyRequest): Promise<WebSetupApplyResult> {
    const applied: string[] = []
    try {
      const normalized = normalizeApply(request)
      const editor = this.seams().configEditor
      if (editor === undefined) {
        throw new SetupPendingRestart('web-setup', pendingRestartMessage('web-setup', 'the profile configuration editor is not mounted in this deployment'))
      }
      const rows = this.rows(editor)
      const env = this.seams().env
      const currentSearch = this.effectiveProvider(rows, 'searchProvider', env)
      const currentFetch = this.effectiveProvider(rows, 'fetchProvider', env)

      const nextSearch = normalized.search === undefined
        ? undefined
        : normalized.search.provider === null ? null : requireSpec('search', normalized.search.provider)
      const nextFetch = normalized.fetch === undefined
        ? undefined
        : normalized.fetch.provider === null ? null : requireSpec('fetch', normalized.fetch.provider)
      const effectiveSearch = nextSearch === undefined ? currentSearch : nextSearch === null ? null : nextSearch.id
      const effectiveFetch = nextFetch === undefined ? currentFetch : nextFetch === null ? null : nextFetch.id

      // §6.3: never enable a tool whose capability cannot resolve. A provider
      // row this call mounts counts; a configured id without a mount does not.
      this.requireToggleTarget('search', normalized.toolToggles?.search === true, effectiveSearch, rows, nextSearch?.id)
      this.requireToggleTarget('fetch', normalized.toolToggles?.fetch === true, effectiveFetch, rows, nextFetch?.id)

      if (normalized.search?.apiKey !== undefined) {
        const selected = nextSearch
        if (selected === undefined || selected === null) throw new SetupRefusal('search.apiKey requires a selected search provider')
        if (selected.keyRef === null) throw new SetupRefusal(`the "${selected.id}" provider takes no API key`)
        const credentials = this.seams().credentials
        if (credentials === undefined) throw new SetupRefusal('no credential provider is mounted; the key cannot be stored')
        await credentials.set(credentialRef(selected.keyRef), normalized.search.apiKey)
        applied.push(`credentials:${selected.keyRef}`)
      }

      if (nextSearch !== undefined && nextSearch !== null) {
        const changed = await this.ensureProviderRow(editor, nextSearch, normalized.search?.baseURL)
        if (changed) applied.push(`row:${nextSearch.row.id}`)
        this.ensureMounted(editor, nextSearch)
      }
      if (nextFetch !== undefined && nextFetch !== null) {
        const changed = await this.ensureProviderRow(editor, nextFetch, undefined)
        if (changed) applied.push(`row:${nextFetch.row.id}`)
        this.ensureMounted(editor, nextFetch)
      }

      if (nextSearch !== undefined && (nextSearch?.id ?? null) !== currentSearch) {
        await this.editWebRow(editor, nextSearch === null ? null : nextSearch.id, undefined)
        applied.push('web.searchProvider')
      }
      if (nextFetch !== undefined && (nextFetch?.id ?? null) !== currentFetch) {
        await this.editWebRow(editor, undefined, nextFetch === null ? null : nextFetch.id)
        applied.push('web.fetchProvider')
      }

      if (normalized.toolToggles !== undefined) {
        applied.push(...await this.editToolRow(editor, normalized.toolToggles))
      }

      return { ok: true, applied }
    } catch (error) {
      if (error instanceof SetupPendingRestart) {
        return { ok: false, applied, pendingRestart: { ns: error.ns, message: error.message } }
      }
      return { ok: false, applied, error: messageOf(error) }
    }
  }

  /** Refuse a toggle whose effective provider is absent, unknown, or unmounted by an untouched profile. */
  private requireToggleTarget(
    kind: WebSetupProviderKind,
    enabling: boolean,
    effectiveId: string | null,
    rows: readonly WebSetupEditorRow[],
    mountingId: string | undefined,
  ): void {
    if (!enabling) return
    if (effectiveId === null) throw new SetupRefusal(`tool-web.${kind} cannot be enabled without a ${kind} provider`)
    const spec = requireSpec(kind, effectiveId)
    const mounted = rows.some(row => row.options.name === spec.row.name && row.options.disabled !== true)
    if (!mounted && mountingId !== spec.id) {
      throw new SetupRefusal(`the "${spec.id}" provider row is not mounted in the running profile; select it in this setup so its row is added`)
    }
  }

  /**
   * Ensure the provider row exists enabled in the profile: edit the mounted
   * enabled row with the catalog template, replace a profile-document row that
   * carries `disabled` (the editor writes only `config`, so the disabled
   * declaration is removed and the enabled template re-inserted), or insert a
   * new top-level row. A row disabled by a layer this document does not own
   * cannot be re-enabled and is reported as pending-restart naming the exact
   * field to change. An editor failure is reported as pending-restart.
   * @returns whether the row's config changed.
   */
  private async ensureProviderRow(editor: WebSetupConfigEditor, spec: WebSetupProviderSpec, baseURL: string | undefined): Promise<boolean> {
    const template = { ...spec.row.config, ...baseURL === undefined || baseURL === '' ? {} : { baseURL } }
    const rows = this.rows(editor).filter(row => row.options.name === spec.row.name)
    const enabled = rows.find(row => row.options.disabled !== true)
    if (enabled !== undefined) {
      try {
        const current = enabled.options.config ?? {}
        const unchanged = Object.entries(template).every(([key, value]) => isDeepStrictEqual(current[key], value))
        await editor.edit(enabled, config => ({ ...config, ...template }))
        return !unchanged
      } catch (error) {
        throw new SetupPendingRestart(spec.row.id, pendingRestartMessage(spec.row.id, messageOf(error)))
      }
    }
    const disabled = rows.find(row => row.options.disabled === true)
    if (disabled !== undefined) {
      await this.replaceDisabledProviderRow(editor, spec, disabled, template)
      return true
    }
    try {
      await editor.insert({ id: spec.row.id, name: spec.row.name, config: template })
      return true
    } catch (error) {
      throw new SetupPendingRestart(spec.row.id, pendingRestartMessage(spec.row.id, messageOf(error)))
    }
  }

  /**
   * Replace one disabled provider row with the enabled catalog template.
   * `remove` owns only rows declared in the editable profile document, so a
   * disabled row from a shipped layer reports the exact field to change
   * instead of pretending a restart alone would enable it.
   */
  private async replaceDisabledProviderRow(
    editor: WebSetupConfigEditor,
    spec: WebSetupProviderSpec,
    disabled: WebSetupEditorRow,
    template: Record<string, unknown>,
  ): Promise<void> {
    try {
      await editor.remove(disabled.options.id)
    } catch (error) {
      throw new SetupPendingRestart(spec.row.id, pendingRestartMessage(spec.row.id,
        `the "${disabled.options.id}" row for ${spec.row.name} is disabled by a layer this profile's editable document does not own (${messageOf(error)}); set "disabled: false" on row "${disabled.options.id}" (or delete its disabled override) in the profile composition, then restart the service`))
    }
    try {
      await editor.insert({ id: spec.row.id, name: spec.row.name, config: template })
    } catch (error) {
      throw new SetupPendingRestart(spec.row.id, pendingRestartMessage(spec.row.id,
        `the disabled row "${disabled.options.id}" was removed, but re-inserting "${spec.row.id}" enabled failed: ${messageOf(error)}`))
    }
  }

  /** Post-condition of {@link ensureProviderRow}: the provider's row is a live enabled entry. */
  private ensureMounted(editor: WebSetupConfigEditor, spec: WebSetupProviderSpec): void {
    const mounted = this.rows(editor).some(row => row.options.name === spec.row.name && row.options.disabled !== true)
    if (!mounted) {
      throw new SetupRefusal(`the "${spec.id}" provider row was not mounted by the running profile; build the provider package and restart`)
    }
  }

  /** Edit the live `web` row in place; the row must already be part of the composition. */
  private async editWebRow(
    editor: WebSetupConfigEditor,
    search: string | null | undefined,
    fetch: string | null | undefined,
  ): Promise<void> {
    const row = this.rows(editor).find(candidate => candidate.options.id === WEB_ROW_ID || candidate.options.name === WEB_PLUGIN_NAME)
    if (row === undefined) {
      throw new SetupPendingRestart(WEB_ROW_ID, pendingRestartMessage(WEB_ROW_ID, `the "${WEB_PLUGIN_NAME}" row is not part of the running profile`))
    }
    try {
      await editor.edit(row, (current) => {
        const config = { ...current }
        if (search !== undefined) {
          if (search === null) Reflect.deleteProperty(config, 'searchProvider')
          else config.searchProvider = search
        }
        if (fetch !== undefined) {
          if (fetch === null) Reflect.deleteProperty(config, 'fetchProvider')
          else config.fetchProvider = fetch
        }
        return config
      })
    } catch (error) {
      throw new SetupPendingRestart(WEB_ROW_ID, pendingRestartMessage(WEB_ROW_ID, messageOf(error)))
    }
  }

  /**
   * Edit every enabled row that gates the model-facing web tools.
   *
   * The Web app disables the host `tool-web` row and composes the tools inside
   * each agent preset's `config.plugins`; those nested rows live in per-preset
   * in-memory Loader trees and are invisible to `entries()`. This method edits
   * the preset group rows (the definitions the preset registry mounts) as well
   * as any enabled top-level `tool-web` row, so the toggles reach the schemas
   * agents actually receive. A nested plugin entry carrying `disabled: true` is
   * re-enabled by writing `disabled: false` into the group config, which the
   * preset tree honors. When only a disabled top-level row exists, the exact
   * row to change is reported instead.
   * @returns the changed toggle fields, empty when every target already matches.
   */
  private async editToolRow(editor: WebSetupConfigEditor, toggles: { search: boolean; fetch: boolean }): Promise<string[]> {
    const rows = this.rows(editor)
    const isDirect = (row: WebSetupEditorRow): boolean =>
      row.options.name === TOOL_WEB_PLUGIN_NAME || row.options.id === TOOL_WEB_ROW_ID
    const direct = rows.filter(row => row.options.disabled !== true && isDirect(row))
    const presets = rows.filter(row => row.options.disabled !== true && toolPluginsOf(row).length > 0)
    if (direct.length === 0 && presets.length === 0) {
      const disabled = rows.find(row => row.options.disabled === true && isDirect(row))
      const detail = disabled === undefined
        ? `no enabled "${TOOL_WEB_PLUGIN_NAME}" row and no enabled preset group carrying one is part of the running profile`
        : `the "${disabled.options.id}" host row is disabled by the composition and the config editor cannot clear an entry's disabled flag; edit the per-preset "${TOOL_WEB_PLUGIN_NAME}" rows (or set "disabled: false" on row "${disabled.options.id}") and restart the service`
      throw new SetupPendingRestart(TOOL_WEB_ROW_ID, pendingRestartMessage(TOOL_WEB_ROW_ID, detail))
    }
    const current = collectToolToggleValues(direct, presets)
    const changed: string[] = []
    if (current.search.some(value => value !== toggles.search)) changed.push('tool-web.search')
    if (current.fetch.some(value => value !== toggles.fetch)) changed.push('tool-web.fetch')
    if (changed.length === 0) return changed
    try {
      for (const row of direct) {
        const config = row.options.config ?? {}
        if (config.search === toggles.search && config.fetch === toggles.fetch) continue
        await editor.edit(row, config => ({ ...config, search: toggles.search, fetch: toggles.fetch }))
      }
      for (const row of presets) {
        if (!presetToolDiffers(row, toggles)) continue
        await editor.edit(row, config => applyPresetToolToggles(config, toggles))
      }
    } catch (error) {
      throw new SetupPendingRestart(TOOL_WEB_ROW_ID, pendingRestartMessage(TOOL_WEB_ROW_ID, messageOf(error)))
    }
    return changed
  }
}

/** Resolve one kind/provider id or refuse with the precise reason. */
function requireSpec(kind: WebSetupProviderKind, id: string): WebSetupProviderSpec {
  const spec = providerSpec(kind, id)
  if (spec !== undefined) return spec
  const other = anyProviderSpec(id)
  if (other !== undefined) throw new SetupRefusal(`"${id}" is a ${other.kind} provider, not ${kind}`)
  throw new SetupRefusal(`unknown ${kind} provider "${id}"`)
}

/** One non-array object, or `undefined`. */
function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Whether one nested plugin entry is the model-facing web tool row. */
function isToolWebPlugin(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { name?: unknown }).name === TOOL_WEB_PLUGIN_NAME
}

/** The nested web-tool plugin entries one group row's `config.plugins` carries. */
function toolPluginsOf(row: WebSetupEditorRow): Array<Record<string, unknown>> {
  const plugins = row.options.config?.plugins
  if (!Array.isArray(plugins)) return []
  return plugins.filter(isToolWebPlugin)
}

/** Current `search`/`fetch` values across every direct row and nested preset plugin. */
function collectToolToggleValues(
  direct: readonly WebSetupEditorRow[],
  presets: readonly WebSetupEditorRow[],
): { search: unknown[]; fetch: unknown[] } {
  const search: unknown[] = []
  const fetch: unknown[] = []
  for (const row of direct) {
    search.push(row.options.config?.search)
    fetch.push(row.options.config?.fetch)
  }
  for (const row of presets) {
    for (const plugin of toolPluginsOf(row)) {
      const config = recordOrUndefined(plugin.config) ?? {}
      search.push(config.search)
      fetch.push(config.fetch)
    }
  }
  return { search, fetch }
}

/** Whether one preset row's nested web-tool entries differ from the requested toggles. */
function presetToolDiffers(row: WebSetupEditorRow, toggles: { search: boolean; fetch: boolean }): boolean {
  return toolPluginsOf(row).some((plugin) => {
    const config = recordOrUndefined(plugin.config) ?? {}
    if (config.search !== toggles.search || config.fetch !== toggles.fetch) return true
    return plugin.disabled === true && (toggles.search || toggles.fetch)
  })
}

/**
 * Write the requested toggles into a preset row's nested web-tool entries,
 * clearing a nested `disabled: true` when the setup enables either tool.
 * @param current - the preset row's current config.
 * @param toggles - requested `search`/`fetch` values.
 * @returns the next config with every nested web-tool entry updated.
 */
export function applyPresetToolToggles(
  current: Record<string, unknown>,
  toggles: { search: boolean; fetch: boolean },
): Record<string, unknown> {
  const plugins = current.plugins
  if (!Array.isArray(plugins)) return current
  const list: unknown[] = plugins
  return {
    ...current,
    plugins: list.map((plugin) => {
      if (!isToolWebPlugin(plugin)) return plugin
      const config = recordOrUndefined(plugin.config) ?? {}
      const next: Record<string, unknown> = {
        ...plugin,
        config: { ...config, search: toggles.search, fetch: toggles.fetch },
      }
      if (plugin.disabled === true && (toggles.search || toggles.fetch)) next.disabled = false
      return next
    }),
  }
}

/** Parse `applySetup` input at the wire boundary; unknown fields are ignored. */
function normalizeApply(value: unknown): {
  search?: NormalizedSearch
  fetch?: { provider: string | null }
  toolToggles?: { search: boolean; fetch: boolean }
} {
  const input = recordOrUndefined(value)
  if (input === undefined) throw new SetupRefusal('applySetup: request must be an object')
  let search: NormalizedSearch | undefined
  if (input.search !== undefined) {
    const raw = recordOrUndefined(input.search)
    if (raw === undefined) throw new SetupRefusal('applySetup: search must be an object')
    const provider = raw.provider
    if (provider !== null && (typeof provider !== 'string' || provider === '')) {
      throw new SetupRefusal('applySetup: search.provider must be a non-empty string or null')
    }
    if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || raw.apiKey === '')) {
      throw new SetupRefusal('applySetup: search.apiKey must be a non-empty string')
    }
    if (raw.baseURL !== undefined && (typeof raw.baseURL !== 'string' || raw.baseURL === '')) {
      throw new SetupRefusal('applySetup: search.baseURL must be a non-empty string')
    }
    search = {
      provider,
      ...raw.apiKey === undefined ? {} : { apiKey: raw.apiKey },
      ...raw.baseURL === undefined ? {} : { baseURL: raw.baseURL },
    }
  }
  let fetch: { provider: string | null } | undefined
  if (input.fetch !== undefined) {
    const raw = recordOrUndefined(input.fetch)
    if (raw === undefined) throw new SetupRefusal('applySetup: fetch must be an object')
    const provider = raw.provider
    if (provider !== null && (typeof provider !== 'string' || provider === '')) {
      throw new SetupRefusal('applySetup: fetch.provider must be a non-empty string or null')
    }
    fetch = { provider }
  }
  let toolToggles: { search: boolean; fetch: boolean } | undefined
  if (input.toolToggles !== undefined) {
    const raw = recordOrUndefined(input.toolToggles)
    if (raw === undefined) throw new SetupRefusal('applySetup: toolToggles must be an object')
    if (typeof raw.search !== 'boolean' || typeof raw.fetch !== 'boolean') {
      throw new SetupRefusal('applySetup: toolToggles.search and toolToggles.fetch must be booleans')
    }
    toolToggles = { search: raw.search, fetch: raw.fetch }
  }
  return {
    ...search === undefined ? {} : { search },
    ...fetch === undefined ? {} : { fetch },
    ...toolToggles === undefined ? {} : { toolToggles },
  }
}

/** One-line diagnostic from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Refusal for a credential canary that has no usable key. The catalog binds
 * `credential` canaries to a reference; the fallback names the provider alone
 * so a malformed catalog still reports cleanly.
 * @param spec - the catalog entry being validated.
 * @returns the operator-facing refusal.
 */
export function missingCredentialError(spec: WebSetupProviderSpec): string {
  return spec.keyRef === null
    ? `${spec.id} needs a configured credential`
    : `${spec.id} needs a configured ${spec.keyRef} credential`
}

/**
 * The operator-facing restart fallback. Honest about both readings: a row the
 * profile already carries loads on restart, while a missing provider package
 * has to be built first.
 * @param ns - row id the change targeted.
 * @param detail - the config-editor failure verbatim.
 * @returns the message the wizard renders.
 */
export function pendingRestartMessage(ns: string, detail: string): string {
  return `Setup could not be applied while the service is running (${detail}). The "${ns}" change takes effect after a restart if the profile already carries it; if its provider package is missing, build the profile first, then restart the service.`
}
