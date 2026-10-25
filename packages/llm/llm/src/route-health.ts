/**
 * In-memory route-health ledger for model-group failover.
 *
 * A provider can answer and still be useless: a degenerate completion
 * (`EMPTY_RESPONSE`), a credential gate, a rate limit, or a server/timeout
 * failure means the next request on that route will likely waste a turn.
 * The ledger remembers those failures per `provider/model` and lets the chain
 * order DEMOTE a cooling member to the back of the request's attempt order.
 * Membership never changes: a group still holds every declared link, and a
 * request whose every member is cooling still tries them in their declared
 * order.
 *
 * State is process-local and never persisted: a restart clears every cooldown,
 * and nothing here is a settings write or a session event. Failure classes
 * outside {@link RouteHealthClass} (a bad request, an unknown model, a context
 * overflow) carry no cooldown — another request would fail identically, and
 * demotion would not repair it.
 *
 * @module @deepseek-ai/dsh-llm/route-health
 */

import { EMPTY_RESPONSE_CODE } from './error.ts'

/**
 * Failure classes this ledger cools down. `RATE_LIMIT` prefers the provider's
 * own reset hint; the other classes use the configured cooldown.
 */
export type RouteHealthClass = 'empty' | 'auth' | 'rate_limit' | 'server'

/** Cooldown durations (milliseconds) for every failure class. */
export interface RouteHealthPolicy {
  /** Cooldown after a completed response with no answer content. */
  readonly emptyResponseCooldownMs: number
  /** Cooldown after an auth/sign-in gate. */
  readonly authCooldownMs: number
  /** Fallback cooldown after a rate limit with no provider reset hint. */
  readonly rateLimitCooldownMs: number
  /** Cooldown after a server failure or a timeout. */
  readonly serverCooldownMs: number
}

/** Shipped defaults: ~10 min empty, ~6 h auth, ~60 s rate limit, ~3 min server. */
export const DEFAULT_ROUTE_HEALTH_POLICY: RouteHealthPolicy = Object.freeze({
  emptyResponseCooldownMs: 10 * 60_000,
  authCooldownMs: 6 * 60 * 60_000,
  rateLimitCooldownMs: 60_000,
  serverCooldownMs: 3 * 60_000,
})

/** One route as the ledger keys it. */
export interface RouteHealthLink {
  /** Provider route id. */
  readonly provider: string
  /** Model id within that route. */
  readonly model: string
}

/** One cooling (or previously failed, now expired) route, as the status view reports it. */
export interface RouteHealthEntry {
  /** Provider route id. */
  readonly provider: string
  /** Model id within that route. */
  readonly model: string
  /** Failure class of the latest consecutive run. */
  readonly class: RouteHealthClass
  /** Consecutive failures of that class since the last success. */
  readonly failures: number
  /** Failure code of the latest attempt. */
  readonly code: string
  /** Epoch milliseconds at which the cooldown ends. */
  readonly coolingUntil: number
  /** Whether the cooldown still holds when the view was read (always true in {@link RouteHealthLedger.snapshot}). */
  readonly cooling: boolean
}

/** One stored ledger row. */
interface RouteHealthRecord {
  readonly provider: string
  readonly model: string
  readonly class: RouteHealthClass
  readonly failures: number
  readonly code: string
  readonly coolingUntil: number
}

/** `provider/model` ledger key. */
function routeKey(link: RouteHealthLink): string {
  return `${link.provider}/${link.model}`
}

/**
 * Classify one failure code. Codes outside the cooled set answer `undefined`.
 * @param code - stable provider-neutral failure code.
 * @returns the failure class, or undefined when the code carries no cooldown.
 */
export function routeHealthClassOf(code: string): RouteHealthClass | undefined {
  switch (code) {
    case EMPTY_RESPONSE_CODE: return 'empty'
    case 'AUTH': return 'auth'
    case 'RATE_LIMIT': return 'rate_limit'
    case 'SERVER':
    case 'TIMEOUT': return 'server'
    default: return undefined
  }
}

/** Validate one configured duration, falling back to the shipped default. */
function duration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** One partial policy as a caller may supply it (plugin config, tests). */
export interface RouteHealthPolicyInput {
  emptyResponseCooldownMs?: number
  authCooldownMs?: number
  rateLimitCooldownMs?: number
  serverCooldownMs?: number
}

/**
 * Resolve one policy: every present, finite, non-negative duration wins; the
 * rest keep the shipped default. A zero duration is a legal opt-out (the
 * cooldown expires immediately).
 * @param input - partial policy from plugin config or a test.
 * @returns the effective policy.
 */
export function resolveRouteHealthPolicy(input: RouteHealthPolicyInput = {}): RouteHealthPolicy {
  return Object.freeze({
    emptyResponseCooldownMs: duration(input.emptyResponseCooldownMs, DEFAULT_ROUTE_HEALTH_POLICY.emptyResponseCooldownMs),
    authCooldownMs: duration(input.authCooldownMs, DEFAULT_ROUTE_HEALTH_POLICY.authCooldownMs),
    rateLimitCooldownMs: duration(input.rateLimitCooldownMs, DEFAULT_ROUTE_HEALTH_POLICY.rateLimitCooldownMs),
    serverCooldownMs: duration(input.serverCooldownMs, DEFAULT_ROUTE_HEALTH_POLICY.serverCooldownMs),
  })
}

/**
 * Consecutive-failure ledger keyed `provider/model`. Successful attempts reset
 * the run; a failure of a different class restarts the count at one.
 */
export class RouteHealthLedger {
  private readonly records = new Map<string, RouteHealthRecord>()

  /**
   * @param policy - cooldown durations per failure class.
   * @param now - clock seam; the wall clock in production, frozen in tests.
   */
  constructor(
    private readonly policy: RouteHealthPolicy = DEFAULT_ROUTE_HEALTH_POLICY,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one failed attempt. An unclassified code leaves the ledger
   * untouched; a cooldown that already expired restarts the consecutive count.
   * @param provider - provider route id the attempt ran on.
   * @param model - model id the attempt ran on.
   * @param code - stable provider-neutral failure code.
   * @param providerRetryAfterMs - provider reset hint, honored for `RATE_LIMIT`.
   * @returns whether the ledger changed.
   */
  recordFailure(provider: string, model: string, code: string, providerRetryAfterMs?: number): boolean {
    const failureClass = routeHealthClassOf(code)
    if (failureClass === undefined) return false
    const key = `${provider}/${model}`
    const at = this.now()
    const previous = this.records.get(key)
    const active = previous !== undefined && previous.coolingUntil > at ? previous : undefined
    const failures = active !== undefined && active.class === failureClass ? active.failures + 1 : 1
    const hint = providerRetryAfterMs !== undefined && Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0
      ? providerRetryAfterMs
      : undefined
    const cooldown = failureClass === 'rate_limit' && hint !== undefined ? hint : this.cooldownOf(failureClass)
    this.records.set(key, Object.freeze({
      provider,
      model,
      class: failureClass,
      failures,
      code,
      coolingUntil: at + cooldown,
    }))
    return true
  }

  /** The configured cooldown for one failure class. */
  private cooldownOf(failureClass: RouteHealthClass): number {
    switch (failureClass) {
      case 'empty': return this.policy.emptyResponseCooldownMs
      case 'auth': return this.policy.authCooldownMs
      case 'rate_limit': return this.policy.rateLimitCooldownMs
      case 'server': return this.policy.serverCooldownMs
    }
  }

  /**
   * Record one answered attempt: the run breaks, so the route carries no
   * cooldown and no consecutive count.
   * @param provider - provider route id the attempt ran on.
   * @param model - model id the attempt ran on.
   * @returns whether the ledger changed.
   */
  recordSuccess(provider: string, model: string): boolean {
    return this.records.delete(`${provider}/${model}`)
  }

  /**
   * Stable-partition an attempt order: cooling members move to the back and
   * every other member keeps its relative position. When nothing is cooling,
   * or every member is, the input order is returned unchanged — a fully
   * cooling group still tries its members in order.
   * @param links - the request's attempt order.
   * @param linkOf - reads the provider/model route of one member.
   * @returns the same members, cooling ones last.
   */
  order<T>(links: readonly T[], linkOf: (member: T) => RouteHealthLink): readonly T[] {
    if (this.records.size === 0) return links
    const at = this.now()
    const healthy: T[] = []
    const cooling: T[] = []
    for (const link of links) {
      const record = this.records.get(routeKey(linkOf(link)))
      if (record !== undefined && record.coolingUntil > at) cooling.push(link)
      else healthy.push(link)
    }
    if (cooling.length === 0 || healthy.length === 0) return links
    return [...healthy, ...cooling]
  }

  /**
   * Whether one route is cooling right now.
   * @param link - provider/model route.
   * @returns whether its cooldown still holds.
   */
  isCooling(link: RouteHealthLink): boolean {
    const record = this.records.get(routeKey(link))
    return record !== undefined && record.coolingUntil > this.now()
  }

  /**
   * The current cooling routes, sorted by `provider/model`. Expired rows are
   * omitted; they stay in memory only until the next attempt on that route.
   * @returns the status view, safe to publish as an artifact.
   */
  snapshot(): readonly RouteHealthEntry[] {
    const at = this.now()
    const entries: RouteHealthEntry[] = []
    for (const key of [...this.records.keys()].sort()) {
      const record = this.records.get(key)
      if (record === undefined || record.coolingUntil <= at) continue
      entries.push(Object.freeze({
        provider: record.provider,
        model: record.model,
        class: record.class,
        failures: record.failures,
        code: record.code,
        coolingUntil: record.coolingUntil,
        cooling: true,
      }))
    }
    return Object.freeze(entries)
  }
}
