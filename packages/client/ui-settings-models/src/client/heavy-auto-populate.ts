/**
 * Automatic catalog population for a heavy provider route.
 *
 * A route added before its service can answer discovery is written with an
 * empty model list; after the operator configures the service (for example
 * logs into the Antigravity proxy dashboard) the catalog must appear without
 * a manual Refresh click. These helpers decide when one automatic discovery
 * is due — a configured route, a healthy service, and no real model yet —
 * and guarantee at most one attempt per successful status check (the card's
 * health snapshot), so the trigger can never loop or outpace the status TTL.
 *
 * @module ui-settings-models/heavy-auto-populate
 */

/**
 * Fabricated fallback model ids an older build wrote when discovery answered
 * nothing. A route whose whole catalog is one of these counts as empty for
 * automatic population, so the next successful discovery replaces it. The
 * values are legacy data — they are never written again and exist only so an
 * already-configured route can heal without a re-add.
 */
export const LEGACY_FALLBACK_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  antigravity: ['gemini-2.5-flash'],
}

/**
 * Whether a route declares no real model: an empty list, or only the
 * fabricated fallback ids an older build wrote.
 * @param providerId - the route key.
 * @param modelIds - the route's configured model ids.
 * @returns whether the catalog still needs a discovery pass.
 */
export function needsAutoPopulate(providerId: string, modelIds: readonly string[]): boolean {
  if (modelIds.length === 0) return true
  const legacy = LEGACY_FALLBACK_MODEL_IDS[providerId]
  return legacy !== undefined && modelIds.every(id => legacy.includes(id))
}

/** The health snapshot one automatic attempt was already made for. */
export interface AutoPopulateAttempt {
  providerId: string
  /** The `health.checkedAt` value of the status snapshot the attempt ran for. */
  checkedAt: number
}

/** The facts one automatic-population decision reads. */
export interface AutoPopulateInput {
  providerId: string
  /** The route is written in settings. */
  configured: boolean
  /** The last status probe answered the service. */
  healthOk: boolean
  /** A status read is in flight; the decision waits for it to settle. */
  checking: boolean
  /** The status snapshot's `health.checkedAt`. */
  checkedAt: number
  /** The route's configured model ids. */
  modelIds: readonly string[]
}

/**
 * Whether one automatic discovery is due now. True only for a configured,
 * healthy route with no real model, and only once per status snapshot: a
 * repeat call with the same `providerId` and `checkedAt` answers false, so a
 * re-render, an unchanged cached snapshot, or a short-lived status read can
 * never produce a second attempt. A new status snapshot (the status TTL
 * elapsed, or the card was reopened) is a new health success and may attempt
 * once more while the route is still empty.
 * @param attempt - the last attempt made, when any.
 * @param input - the current route/status facts.
 * @returns whether to run one automatic discovery (and then record it).
 */
export function autoPopulateDue(attempt: AutoPopulateAttempt | undefined, input: AutoPopulateInput): boolean {
  if (!input.configured || !input.healthOk || input.checking) return false
  if (!needsAutoPopulate(input.providerId, input.modelIds)) return false
  return attempt === undefined
    || attempt.providerId !== input.providerId
    || attempt.checkedAt !== input.checkedAt
}
