/**
 * The web-search wizard step's pure facts: the v1 provider catalogue, the
 * filtering that keeps only providers the host can actually configure, the
 * pre-selection read from the host's current state, and the apply request the
 * step sends. The host `web-setup` Remote owns the writes; this module never
 * touches the wire.
 * @module ui-settings-models/web-setup
 */

import type { WebSetupApplyRequest, WebSetupStatus, WebSetupValidateRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'

// The wire vocabulary is the generated `webSetup` namespace's own: the
// api-remotes assembly re-exports the host's `@deepseek-ai/dsh-web-setup/types`,
// so the client cannot drift from the descriptors it calls.
export type {
  WebSetupApplyRequest, WebSetupApplyResult, WebSetupCredentialState,
  WebSetupMountedProvider, WebSetupStatus, WebSetupValidateRequest, WebSetupValidation,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Search providers the wizard offers; every one is a host-mountable id. */
export type WebSearchProviderId = 'exa' | 'brave' | 'tavily' | 'deepseek-official' | 'searxng'

/** Fetch providers the wizard offers. */
export type WebFetchProviderId = 'http' | 'jina'

/** The selected search offer, including the explicit off choice. */
export type WebSearchChoice = WebSearchProviderId | 'none'

/** What one canary run answered. */
export type WebSetupValidateOutcome =
  /** The probe answered; `latencyMs` is the measured round trip. */
  | { readonly kind: 'validated'; readonly latencyMs: number }
  /** The probe answered and refused the candidate. */
  | { readonly kind: 'invalid'; readonly reason: string }
  /** The probe itself could not run (transport, missing service); `message` may be empty. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one apply answered. */
export type WebSetupApplyOutcome =
  /**
   * The writes landed; a non-null `pendingRestart` is the host's diagnostic
   * for a reconcile that could not hot-mount and needs a restart.
   */
  | {
    readonly kind: 'applied'
    readonly applied: readonly string[]
    readonly pendingRestart: { readonly ns: string; readonly message: string } | null
  }
  /** The apply was refused; `message` may be empty. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one status read answered. */
export type WebSetupStatusOutcome =
  | { readonly kind: 'status'; readonly status: WebSetupStatus }
  /** The read was refused; `message` may be empty. */
  | { readonly kind: 'refused'; readonly message: string }

/** The host `web-setup` calls the wizard makes. */
export interface WebSetupOperations {
  /** Read the current search/fetch slots, mounted providers, and credential state. */
  status: () => Promise<WebSetupStatusOutcome>
  /** Run one live canary; never persists the candidate. */
  validateProvider: (request: WebSetupValidateRequest) => Promise<WebSetupValidateOutcome>
  /** Store the credential and perform the row surgery atomically. */
  applySetup: (request: WebSetupApplyRequest) => Promise<WebSetupApplyOutcome>
}

/** Fields every search offer carries, whatever its id. */
interface WebSearchOfferBase {
  /** Layout group from the approved design. */
  readonly group: 'keyless' | 'hosted' | 'premium'
  readonly nameKey: keyof typeof en
  readonly bodyKey: keyof typeof en
  readonly recommended?: boolean
  /** Credential reference derived for this route; absent for keyless offers. */
  readonly keyRef?: string
  /** Where the user creates a key. */
  readonly dashboardUrl?: string
  /** The offer needs an endpoint instead of (or beside) a key. */
  readonly needsBaseURL?: boolean
}

/** One mountable search provider as the step renders it. */
export interface WebSearchProviderOffer extends WebSearchOfferBase {
  readonly id: WebSearchProviderId
}

/** The explicit off choice, which mounts nothing. */
export interface WebSearchOffOffer extends WebSearchOfferBase {
  readonly id: 'none'
}

/** One catalogue entry: a mountable provider or the off choice. */
export type WebSearchOffer = WebSearchProviderOffer | WebSearchOffOffer

/**
 * The v1 search catalogue, in the design's group order. A later build adds an
 * offer here when its host provider ships; `availableSearchOffers` keeps it
 * hidden until then.
 */
export const WEB_SEARCH_OFFERS: readonly WebSearchOffer[] = [
  { id: 'exa', group: 'premium', nameKey: 'wizWebExa', bodyKey: 'wizWebExaBody', recommended: true, keyRef: 'EXA_API_KEY', dashboardUrl: 'https://dashboard.exa.ai' },
  { id: 'brave', group: 'hosted', nameKey: 'wizWebBrave', bodyKey: 'wizWebBraveBody', keyRef: 'BRAVE_API_KEY', dashboardUrl: 'https://api-dashboard.search.brave.com' },
  { id: 'tavily', group: 'hosted', nameKey: 'wizWebTavily', bodyKey: 'wizWebTavilyBody', keyRef: 'TAVILY_API_KEY', dashboardUrl: 'https://app.tavily.com' },
  { id: 'searxng', group: 'keyless', nameKey: 'wizWebSearxng', bodyKey: 'wizWebSearxngBody', needsBaseURL: true },
  { id: 'deepseek-official', group: 'keyless', nameKey: 'wizWebDeepSeek', bodyKey: 'wizWebDeepSeekBody' },
  { id: 'none', group: 'keyless', nameKey: 'wizWebNone', bodyKey: 'wizWebNoneBody' },
]

/** The credential reference the DeepSeek native search provider resolves. */
export const DEEPSEEK_WEB_KEY_REF = 'DEEPSEEK_API_KEY'

/**
 * Whether one offer can be configured on this host. Every v1 catalogue entry
 * is a provider the host controller can insert a row for — the dead options
 * (Serper, You.com, Linkup, Perplexity, Firecrawl) never reach the catalogue.
 * DeepSeek native is the one conditional offer: it reuses the shared model key,
 * so it appears only while that credential exists.
 * @param offer - one catalogue entry.
 * @param deepSeekConfigured - whether the shared DeepSeek credential exists.
 * @returns whether the step may render the offer.
 */
export function offerAvailable(offer: WebSearchOffer, deepSeekConfigured: boolean): boolean {
  if (offer.id === 'deepseek-official') return deepSeekConfigured
  return true
}

/**
 * The offers the step renders, in catalogue order.
 * @param deepSeekConfigured - whether the shared DeepSeek credential exists.
 * @returns the host-configurable offers.
 */
export function availableSearchOffers(deepSeekConfigured: boolean): WebSearchOffer[] {
  return WEB_SEARCH_OFFERS.filter(offer => offerAvailable(offer, deepSeekConfigured))
}

/**
 * The selection a freshly loaded step opens on: the configured provider when the
 * host reports one the step renders, else the explicit off choice.
 * @param status - the host's current setup.
 * @param deepSeekConfigured - whether the shared DeepSeek credential exists.
 * @returns the pre-selected choice.
 */
export function initialSearchChoice(status: WebSetupStatus, deepSeekConfigured: boolean): WebSearchChoice {
  const configured = status.searchProvider
  if (configured !== null) {
    const match = availableSearchOffers(deepSeekConfigured).find(offer => offer.id === configured)
    if (match !== undefined) return match.id
  }
  const offers = availableSearchOffers(deepSeekConfigured)
  const exa = offers.find(offer => offer.id === 'exa')
  return exa !== undefined ? 'exa' : 'none'
}

/**
 * Whether the host reports one provider plugin as a live row. The step uses it
 * for the fetch fold's Jina row: until that adapter is mounted, Jina renders as
 * coming-later instead of a switch whose apply the host would refuse.
 * @param status - the host's current setup.
 * @param kind - capability to look for.
 * @param provider - provider id to look for.
 * @returns whether the mounted list contains the provider.
 */
export function providerMounted(status: WebSetupStatus, kind: 'search' | 'fetch', provider: string): boolean {
  return status.mounted.some(entry => entry.kind === kind && entry.provider === provider)
}

/** A copy key naming why a typed self-hosted endpoint cannot be used. */
export type WebBaseURLFailureKey = 'wizWebBaseUrlInvalid'

/**
 * Judge the SearXNG address field. An empty field is not a failure: it means
 * keep whatever the host already configured, mirroring the blank-key rule.
 * @param draft - the field's current value, untrimmed.
 * @returns the copy key for a field-level failure, or undefined to allow submit.
 */
export function webBaseURLFailure(draft: string): WebBaseURLFailureKey | undefined {
  const value = draft.trim()
  if (value.length === 0) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : 'wizWebBaseUrlInvalid'
  } catch {
    return 'wizWebBaseUrlInvalid'
  }
}

/** What one apply carries, as the step resolves it. */
export interface WebSetupWritesInput {
  /** Search provider to mount, or null for the explicit off state. */
  readonly search: WebSearchProviderId | null
  /** Self-hosted endpoint, when the selected offer takes one. */
  readonly baseURL?: string
  /** The pasted key, when the user entered one. */
  readonly apiKey?: string
  /** Fetch provider to mount, or null for none. */
  readonly fetch: WebFetchProviderId | null
  /** Whether `web_search` is registered; false stores the row unverified. */
  readonly searchEnabled: boolean
  /** Whether `web_fetch` is registered. */
  readonly fetchEnabled: boolean
}

/**
 * Build one apply request. Every group the step decides is present, so the host
 * never has to guess whether an absent field meant "leave alone".
 * @param input - the resolved picks for one apply.
 * @returns the request for `webSetup.applySetup`.
 */
export function webSetupWrites(input: WebSetupWritesInput): WebSetupApplyRequest {
  return {
    search: {
      provider: input.search,
      ...input.baseURL === undefined || input.baseURL.length === 0 ? {} : { baseURL: input.baseURL },
      ...input.apiKey === undefined || input.apiKey.length === 0 ? {} : { apiKey: input.apiKey },
    },
    fetch: { provider: input.fetch },
    toolToggles: { search: input.searchEnabled, fetch: input.fetchEnabled },
  }
}

/**
 * Whether the vault already holds a key for one offer.
 * @param offer - the selected offer.
 * @param status - the host's current setup.
 * @returns whether the offer's credential reference reports as configured.
 */
export function offerKeyConfigured(offer: WebSearchOffer, status: WebSetupStatus): boolean {
  return offer.keyRef === undefined ? false : status.credentials[offer.keyRef]?.configured === true
}
