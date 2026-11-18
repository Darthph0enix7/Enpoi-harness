/**
 * Local mirror of the peer pairing routing policy primitives.
 *
 * The profile is a separate pnpm workspace from the harness peer package, so
 * `@deepseek-ai/dsh-api-peer/routing-policy` is not importable here. This
 * module keeps exactly the same tiny semantics, with its own tests:
 *
 * - patterns match `provider/model`;
 * - `*` is the only wildcard and spans any run of characters, `/` included;
 * - the match is anchored at both ends;
 * - every other character is literal, regex metacharacters included;
 * - chain ids are exact values, never globs.
 *
 * @module dsh-enpoi-peer-routing/policy
 */

import type { PeerRoutingPolicy } from '@deepseek-ai/dsh-api-peer/types'

/** Regex metacharacters escaped before a pattern part becomes a regex source. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/gu

/**
 * Match one anchored routing glob against a concrete `provider/model` value.
 * @param pattern - glob with `*` as the only wildcard.
 * @param value - concrete route (`provider/model`).
 * @returns whether the whole value matches.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(REGEX_METACHARACTERS, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(value)
}

/**
 * Whether a chain id is explicitly allowed. Chain ids are exact values; an
 * absent or empty `allowChains` allows no chain at all.
 * @param policy - pairing routing policy.
 * @param id - chain id the caller wants to select.
 * @returns whether `allowChains` names the chain.
 */
export function policyAllowsChain(policy: PeerRoutingPolicy, id: string): boolean {
  return policy.allowChains?.includes(id) === true
}

/**
 * Whether a concrete route matches an allowed-model pattern. An absent or
 * empty `allowModels` selects no pinned route.
 * @param policy - pairing routing policy.
 * @param provider - concrete provider id.
 * @param model - concrete model id.
 * @returns whether the route is selectable as a pinned provider/model.
 */
export function policyAllowsModel(policy: PeerRoutingPolicy, provider: string, model: string): boolean {
  const patterns = policy.allowModels
  if (patterns === undefined || patterns.length === 0) return false
  return patterns.some(pattern => matchesPattern(pattern, `${provider}/${model}`))
}

/**
 * Whether a caller-named reasoning effort is inside the policy allowlist.
 * @param policy - pairing routing policy.
 * @param effort - effort identifier from the selection.
 * @returns whether the policy permits it (an absent list permits every effort).
 */
export function policyAllowsEffort(policy: PeerRoutingPolicy, effort: string): boolean {
  const allowed = policy.allowReasoningEfforts
  if (allowed === undefined) return true
  return allowed.includes(effort)
}
