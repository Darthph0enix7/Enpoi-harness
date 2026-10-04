/**
 * Wire values, catalog records, and host seams of the `webSetup` Remote
 * namespace. Types only — {@link WebSetupProviderSpec} rows are data in
 * `catalog.ts` and the service behavior in `remote.ts`.
 *
 * @module @deepseek-ai/dsh-web-setup/types
 */

import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** The two web capability kinds a provider can serve. */
export type WebSetupProviderKind = 'search' | 'fetch'

/** One provider plugin the running profile has mounted. */
export interface WebSetupMountedProvider {
  kind: WebSetupProviderKind
  /** The provider id the plugin registers with `ctx.web`. */
  provider: string
}

/** Configuration facts for one credential reference; never the value. */
export interface WebSetupCredentialState {
  configured: boolean
  /** Credential-provider source layer currently supplying the value. */
  source?: string
  writable: boolean
}

/** `webSetup.status` result: the effective provider selection and vault state. */
export interface WebSetupStatus {
  /** Effective `web.searchProvider` from the live `web` row, then its environment fallback; `null` when unset. */
  searchProvider: string | null
  /** Effective `web.fetchProvider` from the live `web` row, then its environment fallback; `null` when unset. */
  fetchProvider: string | null
  /** Catalog providers whose plugin row is a live, enabled Loader entry. */
  mounted: WebSetupMountedProvider[]
  /** One entry per catalog credential reference, keyed by that bare reference name. */
  credentials: Record<string, WebSetupCredentialState>
}

/** `webSetup.validateProvider` request. */
export interface WebSetupValidateRequest {
  kind: WebSetupProviderKind
  provider: string
  /** One-shot candidate key; when absent the stored/keyless path is probed. */
  apiKey?: string
  /** Endpoint override the candidate row would use (Exa, SearXNG, Jina). */
  baseURL?: string
}

/** `webSetup.validateProvider` result; every failure is reported, never thrown. */
export interface WebSetupValidation {
  ok: boolean
  /** HTTP status of the canary response, when a request was made. */
  status?: number
  latencyMs?: number
  error?: string
  /** Sources in the canary response, when the provider's payload carries them. */
  sourcesCount?: number
}

/** A search selection: `provider: null` unsets `web.searchProvider`. */
export interface WebSetupSearchSelection {
  provider: string | null
  /** Stored in the credential vault under the catalog reference; never written to YAML. */
  apiKey?: string
  /** Written into the provider row's `baseURL`. */
  baseURL?: string
}

/** A fetch selection: `provider: null` unsets `web.fetchProvider`. */
export interface WebSetupFetchSelection {
  provider: string | null
}

/** `tool-web` registration toggles; both fields are written together. */
export interface WebSetupToolToggles {
  search: boolean
  fetch: boolean
}

/** `webSetup.applySetup` request. An absent group leaves its rows untouched. */
export interface WebSetupApplyRequest {
  search?: WebSetupSearchSelection
  fetch?: WebSetupFetchSelection
  toolToggles?: WebSetupToolToggles
}

/** One row whose hot apply failed; the profile needs a restart to load it. */
export interface WebSetupPendingRestart {
  /** Row id (or service row id) the change targeted. */
  ns: string
  message: string
}

/** `webSetup.applySetup` result. Operations apply in order; `applied` lists committed ones. */
export interface WebSetupApplyResult {
  ok: boolean
  applied: string[]
  pendingRestart?: WebSetupPendingRestart
  error?: string
}

/** Which live probe one catalog provider uses. */
export type WebSetupCanary =
  | { kind: 'http-search'; provider: 'exa' | 'brave' | 'tavily' | 'searxng' }
  | { kind: 'http-fetch'; provider: 'jina' }
  /** Key-presence check through the credential seam (DeepSeek reuses the model key). */
  | { kind: 'credential' }
  /** No external call is meaningful (built-in HTTP fetch). */
  | { kind: 'none' }

/** One catalog provider: its registration id, vault reference, profile row, and canary. */
export interface WebSetupProviderSpec {
  /** Provider id the plugin registers with `ctx.web` and the id `web.searchProvider`/`fetchProvider` names. */
  id: string
  kind: WebSetupProviderKind
  /** Bare credential reference the row's `apiKeyEnv` names; `null` for keyless providers. */
  keyRef: string | null
  /** The profile row `applySetup` inserts when the plugin is not already mounted. */
  row: {
    /** Canonical row id, unique within one profile patch document. */
    id: string
    /** Plugin module name the Loader imports. */
    name: string
    /** Complete raw row config for the plugin's Config schema. */
    config: Record<string, unknown>
  }
  canary: WebSetupCanary
}

/** One live Loader entry as the config editor exposes it (structural seam). */
export interface WebSetupEditorRow {
  options: {
    id: string
    name: string
    config?: Record<string, unknown>
    disabled?: boolean | null
  }
}

/** The subset of `ctx.configEditor` this package drives: rows, insert, remove, and targeted edit. */
export interface WebSetupConfigEditor {
  /** Active entries with unique profile patch ids. */
  entries(): readonly WebSetupEditorRow[]
  /** Derive, persist, and reconcile one row's next config. */
  edit(
    entry: WebSetupEditorRow,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
  /** Insert a new top-level profile row and reconcile the Loader. */
  insert(row: { id: string; name: string; config: Record<string, unknown> }): Promise<void>
  /** Remove every profile-document row for an entry id and reconcile the Loader. */
  remove(id: string): Promise<void>
}

/** The subset of `ctx.credentials` this package drives. */
export interface WebSetupCredentialsSeam {
  describe(ref: CredentialRef): Promise<CredentialInfo>
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

/** Fetch surface the canaries call; injectable so tests mock only the external HTTP input. */
export type WebSetupFetch = (url: string, init?: RequestInit) => Promise<Response>

/** Lazily read host seams; each may mount after this plugin. */
export interface WebSetupSeams {
  configEditor?: WebSetupConfigEditor
  credentials?: WebSetupCredentialsSeam
  fetchImpl: WebSetupFetch
  /** Monotonic clock for latency measurement; defaults to `performance.now`. */
  now?: () => number
  /** Environment fallback source for `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER`. */
  env: Record<string, string | undefined>
  /** Optional diagnostics sink. */
  log?: (line: string) => void
}
