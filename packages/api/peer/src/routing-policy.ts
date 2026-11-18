/**
 * Pairing routing-policy matching and clamping, shared by the peer host and
 * any consumer that needs to answer "may this alias select that route?".
 *
 * Patterns match `provider/model` with `*` as the only wildcard: it spans any
 * run of characters, `/` included, and the match is anchored at both ends.
 * Every other character is literal, so a pattern is never valid regex syntax
 * and cannot widen a match through metacharacters.
 *
 * @module @deepseek-ai/dsh-api-peer/routing-policy
 */

import type { PeerRoutingPolicy } from './types.ts'

/** Characters a routing pattern or chain id may contain. */
const PATTERN_CHARS = /^[A-Za-z0-9._:/@*+-]+$/

/**
 * Whether one operator-authored routing pattern or chain id is admissible.
 * @param value - pattern text from the pairing file.
 * @returns whether every character is in the routing charset.
 */
export function isRoutingPattern(value: string): boolean {
  return PATTERN_CHARS.test(value)
}

/**
 * Match one `provider/model` glob against a concrete route.
 * @param pattern - anchored glob; `*` spans any run of characters, `/` included.
 * @param provider - concrete provider id.
 * @param model - concrete model id.
 * @returns whether the route is inside the pattern.
 */
export function matchesPattern(pattern: string, provider: string, model: string): boolean {
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(`${provider}/${model}`)
}

/**
 * Whether a chain id is explicitly allowed. Chain ids are exact values, not
 * globs: a chain selection must name a configured chain the policy lists.
 * @param policy - pairing routing policy.
 * @param id - chain id the caller wants to use.
 * @returns whether `allowChains` names the chain.
 */
export function policyAllowsChain(policy: PeerRoutingPolicy, id: string): boolean {
  return policy.allowChains?.includes(id) === true
}

/**
 * Whether a concrete provider/model route matches any allowed model pattern.
 * An absent or empty `allowModels` selects no pinned route.
 * @param policy - pairing routing policy.
 * @param provider - concrete provider id.
 * @param model - concrete model id.
 * @returns whether the route is selectable under the policy.
 */
export function policyAllowsModel(policy: PeerRoutingPolicy, provider: string, model: string): boolean {
  const patterns = policy.allowModels
  if (patterns === undefined || patterns.length === 0) return false
  return patterns.some(pattern => matchesPattern(pattern, provider, model))
}

/**
 * Apply the policy's token ceiling to one create request.
 * - no policy ceiling: the requested value (or absence) passes through;
 * - requested above the ceiling: `'over'`, so the host refuses before creating;
 * - absent request: the policy ceiling becomes the session ceiling.
 * @param policy - pairing routing policy, when the pairing has one.
 * @param requested - caller's `maxTotalTokens`, when present.
 * @returns the ceiling to persist, `undefined` for none, or `'over'` to refuse.
 */
export function clampTokenCeiling(
  policy: PeerRoutingPolicy | undefined,
  requested: number | undefined,
): number | undefined | 'over' {
  const ceiling = policy?.maxTotalTokens
  if (ceiling === undefined) return requested
  if (requested === undefined) return ceiling
  return requested > ceiling ? 'over' : requested
}
