/**
 * enpoi-peer-routing — policy-gated model discovery and selection for the
 * device-to-device peer API.
 *
 * The peer host resolves this plugin's structural service through
 * `ctx.get('peerRouting')` and serves `peer.models` / routing at create /
 * `peer.selectModel` only when it exists. The service is INERT until a pairing
 * carries a `routing` block: with no policy it never mints a selection, and it
 * is mounted regardless so the host's handshake advertises what it can do.
 *
 * Every fact is resolved at call time from the same sources the model picker
 * uses — the `catalogRules` catalogue projection (gated overrides and the
 * zero-price selector rule), the `modelChains.resolved` artifact, and the LLM
 * runtime's route-health ledger. Evaluation and discovery share one predicate,
 * so discovery cannot list a route that evaluation refuses.
 *
 * Nothing here ever returns credentials, base URLs, headers, provider error
 * text, a settings document, or an allowlist: refusals carry only the offending
 * identifier.
 *
 * @module dsh-enpoi-peer-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PeerRoutingService } from '@deepseek-ai/dsh-api-peer/types'
import { type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import {
  readChainArtifact, type SettingsArtifactReader, type RouteHealthSeam,
} from './chains.ts'
import { PeerRoutingEngine, type PeerRoutingSources } from './engine.ts'
import {
  readGatedCatalogue, readPrivacyOverrides, readRawEfforts, readZeroPriceKeys, type CatalogRulesSeam,
} from './facts.ts'

export const name = 'enpoi-peer-routing'

/** The settings service must be up before a catalogue or artifact read. */
export const inject = ['settings']

/** Shipped page-size default for one discovery page. */
export const DEFAULT_PAGE_LIMIT = 100

/** Shipped hard cap for one discovery page. */
export const MAX_PAGE_LIMIT = 500

/** Optional page-size bounds; the peer host also clamps the caller's request. */
export interface Config {
  /** Page size used when a caller omits `limit`. */
  defaultLimit?: number
  /** Hard cap on one page. */
  maxLimit?: number
}

/** Schemastery validator for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  defaultLimit: Schema.natural().min(1).default(DEFAULT_PAGE_LIMIT),
  maxLimit: Schema.natural().min(1).default(MAX_PAGE_LIMIT),
})

/** The `llm` seam this plugin reads route health through. */
type LlmSeam = RouteHealthSeam

/**
 * Mount the `peerRouting` service.
 *
 * Every source is a closure over `ctx.get`, so the service sees the live
 * services at call time even when `catalogRules`, `modelChains`, or `llm` mount
 * after this plugin. Reads that throw degrade to the fail-closed answer:
 * no routes, no chains, or "all ready" health (an unprovable price still
 * refuses a price-requiring policy).
 * @param ctx - profile plugin Context.
 * @param config - page-size bounds; defaults ship with the plugin.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = (): SettingsDocumentReader | undefined => ctx.get('settings') as SettingsDocumentReader | undefined
  const sources: PeerRoutingSources = {
    catalogue: () => readGatedCatalogue(
      ctx.get('catalogRules') as CatalogRulesSeam | undefined,
      settings(),
    ),
    zeroPriceKeys: () => readZeroPriceKeys(ctx.get('catalogRules') as CatalogRulesSeam | undefined),
    privacy: () => readPrivacyOverrides(settings()),
    rawEfforts: () => readRawEfforts(settings()),
    chains: () => readChainArtifact(ctx.get('settings') as (SettingsDocumentReader & SettingsArtifactReader) | undefined),
    routeHealth: () => {
      try {
        const view = (ctx.get('llm') as LlmSeam | undefined)?.routeHealth?.()
        return Array.isArray(view) ? view : []
      } catch {
        return []
      }
    },
    now: () => Date.now(),
  }
  const engine = new PeerRoutingEngine(sources, {
    defaultLimit: config.defaultLimit ?? DEFAULT_PAGE_LIMIT,
    maxLimit: config.maxLimit ?? MAX_PAGE_LIMIT,
  })
  // Plain-object facade: the contract's methods are this-bound to nothing, so
  // a caller that destructures them still works.
  const service: PeerRoutingService = {
    evaluate: (policy, selection) => engine.evaluate(policy, selection),
    discover: (policy, request) => engine.discover(policy, request),
  }
  ctx.provide('peerRouting', service)
  process.stderr.write('[enpoi-peer-routing] mounted\n')
}

export { PeerRoutingEngine, checkEffort, checkRouteFacts, decodeCursor, encodeCursor, passesFilter, toPeerModelInfo } from './engine.ts'
export type {
  PeerRoutingLimits, PeerRoutingSources, RouteCheck, RouteCheckOptions, RoutingDenied, RoutingDenyReason,
} from './engine.ts'
export { matchesPattern, policyAllowsChain, policyAllowsEffort, policyAllowsModel } from './policy.ts'
export {
  projectReasoningEfforts, projectRouteFacts, readGatedCatalogue, readPrivacyOverrides, readRawEfforts, readZeroPriceKeys,
  routeKey, zeroPriceKeysOf,
  type CatalogRulesSeam, type RouteFacts, type RouteFactsOptions, type ZeroPriceExpansion,
} from './facts.ts'
export {
  RESOLVED_GROUPS_ARTIFACT, parseResolvedChains, readChainArtifact, readCoolingRoutes,
  type ResolvedChain, type ResolvedChainMember, type RouteHealthSeam, type SettingsArtifactReader,
} from './chains.ts'
