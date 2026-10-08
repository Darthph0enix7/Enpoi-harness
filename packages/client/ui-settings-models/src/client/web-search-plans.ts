/**
 * Shipped web-search plan facts.
 *
 * Plan names, prices, limits, and pricing links are provider facts that change
 * on their own schedule, so they live here as data rather than in translated
 * prose. The wizard renders rows from this table; an operator can override one
 * row's fields from the `enpoi-orchestration.uiPreferences.webSearchPlans`
 * settings record the Models page already mirrors.
 *
 * @module ui-settings-models/web-search-plans
 */

import type { WebSearchProviderId } from './web-setup.ts'

/** One web-search provider plan, as the wizard states it. */
export interface WebSearchPlan {
  /** Search provider the plan belongs to. */
  provider: WebSearchProviderId
  /** Plan name (for example `Free`). */
  plan: string
  /** Price line, including any free allowance. */
  price: string
  /** Other limits or positioning, one clause. */
  limits: string
  /** Provider pricing/dashboard URL. */
  link: string
}

/** The frozen shipped plans; a provider without a row renders no plan line. */
export const SHIPPED_WEB_SEARCH_PLANS: readonly WebSearchPlan[] = [
  {
    provider: 'exa',
    plan: 'Starter',
    price: '$10/month free credit',
    limits: 'neural search with date filters',
    link: 'https://exa.ai/pricing',
  },
  {
    provider: 'brave',
    plan: 'Free',
    price: '$5/month free credit',
    limits: 'the fastest independent index',
    link: 'https://brave.com/search/api/',
  },
  {
    provider: 'tavily',
    plan: 'Free',
    price: '1,000 free searches a month',
    limits: 'built for agents',
    link: 'https://tavily.com/#pricing',
  },
]

/** One shipped row's overridable fields; absent fields keep the shipped value. */
export type WebSearchPlanOverride = Partial<Omit<WebSearchPlan, 'provider'>>

/** Operator overrides keyed by provider id. */
export type WebSearchPlanOverrides = Readonly<Record<string, WebSearchPlanOverride>>

/** Whether `value` is a plain JSON object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one non-empty string override field, ignoring other values. */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse the web-search plan override map out of a settings namespace document:
 * the `enpoi-orchestration` namespace's `uiPreferences.webSearchPlans` record,
 * keyed by provider id. Malformed entries and non-string fields are dropped
 * rather than coerced.
 * @param document - the namespace document, as read from the settings mirror.
 * @returns the overrides; empty when the document carries none.
 */
export function parseWebSearchPlanOverrides(document: unknown): WebSearchPlanOverrides {
  if (!isRecord(document)) return {}
  const uiPreferences = document['uiPreferences']
  if (!isRecord(uiPreferences)) return {}
  const plans = uiPreferences['webSearchPlans']
  if (!isRecord(plans)) return {}
  const overrides: Record<string, WebSearchPlanOverride> = {}
  for (const [provider, raw] of Object.entries(plans)) {
    if (!isRecord(raw)) continue
    const plan = stringField(raw, 'plan')
    const price = stringField(raw, 'price')
    const limits = stringField(raw, 'limits')
    const link = stringField(raw, 'link')
    if (plan === undefined && price === undefined && limits === undefined && link === undefined) continue
    overrides[provider] = {
      ...plan === undefined ? {} : { plan },
      ...price === undefined ? {} : { price },
      ...limits === undefined ? {} : { limits },
      ...link === undefined ? {} : { link },
    }
  }
  return overrides
}

/**
 * One provider's effective plan: the shipped row with the operator's fields
 * applied over it.
 * @param provider - search provider id.
 * @param overrides - parsed operator overrides.
 * @returns the plan, or undefined when the provider ships no row.
 */
export function resolveWebSearchPlan(
  provider: WebSearchProviderId,
  overrides: WebSearchPlanOverrides = {},
): WebSearchPlan | undefined {
  const shipped = SHIPPED_WEB_SEARCH_PLANS.find(row => row.provider === provider)
  if (shipped === undefined) return undefined
  const override = overrides[provider]
  return override === undefined ? shipped : { ...shipped, ...override, provider }
}
