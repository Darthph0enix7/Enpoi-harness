/**
 * Policy evaluation and discovery for the peer routing service.
 *
 * Both entry points read the SAME per-call snapshot and the SAME
 * {@link checkRouteFacts} predicate, so a route `discover` lists is exactly a
 * route `evaluate` accepts. Every read happens at call time (catalogue, chain
 * artifact, route health), which is what catches a dynamic chain drifting to
 * include a paid member between a discovery and a create.
 *
 * Failure posture is FAIL CLOSED: an unknown chain, an unknown route, an
 * unprovable price, an unprovable training verdict, an unprovable tool
 * capability, a gated route, a deprecated catalogue record, a malformed cursor,
 * and an effort the model does not advertise all refuse the selection. A
 * refusal carries only the offending identifier, never the allowlist.
 *
 * @module dsh-enpoi-peer-routing/engine
 */

import type {
  PeerChainInfo, PeerModelInfo, PeerModelsFilter, PeerModelSelection, PeerRoutingPolicy, PeerRoutingService, PeerRoutingVerdict,
} from '@deepseek-ai/dsh-api-peer/types'
import type { CatalogEntry, PrivacyOverrides } from 'dsh-enpoi-catalog-rules'
import { parseResolvedChains, readCoolingRoutes, type ResolvedChain, type ResolvedChainMember } from './chains.ts'
import { projectRouteFacts, routeKey, type RouteFacts } from './facts.ts'
import { policyAllowsChain, policyAllowsEffort, policyAllowsModel } from './policy.ts'
import { trimmedString } from './util.ts'

/** Reason vocabulary of a refusal (the peer contract's closed set). */
export type RoutingDenyReason = Extract<PeerRoutingVerdict, { allowed: false }>['reason']

/** One refusal verdict. */
export type RoutingDenied = Extract<PeerRoutingVerdict, { allowed: false }>

/** One policy check: allowed, or a refusal verdict. */
export type RouteCheck = { readonly allowed: true } | RoutingDenied

/** Page-size bounds. */
export interface PeerRoutingLimits {
  /** Page size used when the caller omits or malforms `limit`. */
  readonly defaultLimit: number
  /** Hard cap on one page. */
  readonly maxLimit: number
}

/**
 * Every external read the engine performs, bound in production to `ctx` and
 * overridden in tests. Each call is made fresh per `evaluate`/`discover`.
 */
export interface PeerRoutingSources {
  /** Catalogue entries with gated markers applied. */
  readonly catalogue: () => readonly CatalogEntry[]
  /** Zero-price route keys, or undefined when the rule engine cannot prove them. */
  readonly zeroPriceKeys: () => ReadonlySet<string> | undefined
  /** Effective privacy overrides. */
  readonly privacy: () => PrivacyOverrides | undefined
  /** Raw `reasoningEfforts` fields keyed by `provider/model`. */
  readonly rawEfforts: () => ReadonlyMap<string, unknown>
  /** Published `modelChains.resolved` value. */
  readonly chains: () => unknown
  /** `ctx.llm.routeHealth()` output; empty when the runtime is absent. */
  readonly routeHealth: () => readonly unknown[]
  /** Current epoch milliseconds. */
  readonly now: () => number
}

/** One call-time routing snapshot shared by evaluation and discovery. */
interface RoutingSnapshot {
  readonly facts: ReadonlyMap<string, RouteFacts>
  readonly chains: ReadonlyMap<string, ResolvedChain>
  readonly cooling: ReadonlyMap<string, number>
  readonly now: number
}

/** Options of {@link checkRouteFacts}. */
export interface RouteCheckOptions {
  /**
   * `true` for a pinned provider/model: an explicit `allowModels` pattern must
   * match. `false` for a chain member: patterns only narrow when the policy
   * declares some, because the chain grant is the `allowChains` entry itself.
   */
  readonly requireExplicitModel: boolean
  /** Caller-named effort to validate against the policy and the model ladder. */
  readonly effort?: string
}

/**
 * Validate a caller-named reasoning effort against the policy allowlist and
 * the model's advertised ladder. An unknown ladder cannot prove support, so the
 * effort is refused rather than forwarded.
 * @param facts - route facts carrying the model's advertised ladder.
 * @param policy - pairing routing policy.
 * @param effort - caller-named effort.
 * @returns a refusal, or undefined when the effort is usable.
 */
export function checkEffort(facts: RouteFacts, policy: PeerRoutingPolicy, effort: string): RoutingDenied | undefined {
  if (!policyAllowsEffort(policy, effort)) return { allowed: false, reason: 'effort-not-allowed', denied: effort }
  if (!facts.reasoningEfforts.includes(effort)) return { allowed: false, reason: 'effort-not-allowed', denied: effort }
  return undefined
}

/**
 * The one route predicate both entry points use. Clauses are ANDed; a gated or
 * deprecated route is always refused, price, training, and tools are refused
 * unless the catalogue proves them when the policy demands proof, and a pinned
 * route must match an allowed-model glob.
 * @param facts - route facts from the call-time snapshot.
 * @param policy - pairing routing policy.
 * @param options - pinned-vs-member mode and the caller-named effort.
 * @returns allowed, or the first refusal.
 */
export function checkRouteFacts(facts: RouteFacts, policy: PeerRoutingPolicy, options: RouteCheckOptions): RouteCheck {
  const key = routeKey(facts.provider, facts.model)
  if (facts.gated === true) return { allowed: false, reason: 'model-not-allowed', denied: key }
  // A deprecated record is kept only for a reference the catalogue already
  // names; selecting it would silently route to a model the endpoint dropped.
  if (facts.deprecated === true) return { allowed: false, reason: 'model-not-allowed', denied: key }
  if (options.requireExplicitModel) {
    if (!policyAllowsModel(policy, facts.provider, facts.model)) {
      return { allowed: false, reason: 'model-not-allowed', denied: key }
    }
  } else if (policy.allowModels !== undefined && policy.allowModels.length > 0) {
    if (!policyAllowsModel(policy, facts.provider, facts.model)) {
      return { allowed: false, reason: 'model-not-allowed', denied: key }
    }
  }
  if (policy.requireZeroPrice === true && facts.zeroPrice !== true) {
    return { allowed: false, reason: 'price-unproven', denied: key }
  }
  if (policy.requireNoTraining === true && facts.trainsOnData !== 'no') {
    return { allowed: false, reason: 'training-unproven', denied: key }
  }
  if (policy.requireTools === true && facts.tools !== true) {
    return { allowed: false, reason: 'tools-unproven', denied: key }
  }
  if (options.effort !== undefined) {
    const denied = checkEffort(facts, policy, options.effort)
    if (denied !== undefined) return denied
  }
  return { allowed: true }
}

/** Project facts into the peer discovery row. */
export function toPeerModelInfo(facts: RouteFacts): PeerModelInfo {
  return {
    provider: facts.provider,
    model: facts.model,
    tools: facts.tools,
    vision: facts.vision,
    ...(facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow }),
    zeroPrice: facts.zeroPrice,
    gated: facts.gated,
    trainsOnData: facts.trainsOnData,
    reasoningEfforts: [...facts.reasoningEfforts],
  }
}

/**
 * Apply one caller filter to a discovery row. A boolean clause requires exact
 * equality, so `unknown` never satisfies `zeroPrice: false` or `tools: false`;
 * a malformed `minContextWindow` is ignored rather than guessed.
 * @param info - discovery row.
 * @param filter - caller filter, when supplied.
 * @returns whether the row survives the filter.
 */
export function passesFilter(info: PeerModelInfo, filter: PeerModelsFilter | undefined): boolean {
  if (filter === undefined) return true
  if (filter.zeroPrice !== undefined && info.zeroPrice !== filter.zeroPrice) return false
  if (filter.tools !== undefined && info.tools !== filter.tools) return false
  if (filter.gated !== undefined && info.gated !== filter.gated) return false
  const minContextWindow = filter.minContextWindow
  if (typeof minContextWindow === 'number' && Number.isFinite(minContextWindow) && minContextWindow > 0) {
    if (info.contextWindow === undefined || info.contextWindow < minContextWindow) return false
  }
  return true
}

/** Deterministic text order (code-unit, locale independent). */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Deterministic `provider` then `model` order. */
function compareRoutes(left: { readonly provider: string; readonly model: string }, right: { readonly provider: string; readonly model: string }): number {
  return compareText(left.provider, right.provider) || compareText(left.model, right.model)
}

/** Decoded opaque cursor: the last row of the previous page. */
interface CursorPosition {
  readonly provider: string
  readonly model: string
}

/**
 * Encode one row position as the opaque cursor. Base64url keeps the value free
 * of characters a terminal, URL, or YAML document could mangle.
 * @param position - last returned row.
 * @returns the opaque cursor string.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify([position.provider, position.model]), 'utf8').toString('base64url')
}

/**
 * Decode one opaque cursor.
 * @param cursor - cursor from a previous page.
 * @returns the decoded position.
 * @throws Error `invalid cursor` when the value is not a cursor this service minted.
 */
export function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('invalid cursor')
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('invalid cursor')
  const provider = trimmedString(parsed[0])
  const model = trimmedString(parsed[1])
  if (provider === undefined || model === undefined) throw new Error('invalid cursor')
  return { provider, model }
}

/** First index whose row sorts strictly after the cursor position. */
function firstAfter(models: readonly PeerModelInfo[], position: CursorPosition): number {
  for (let index = 0; index < models.length; index += 1) {
    if (compareRoutes(models[index]!, position) > 0) return index
  }
  return models.length
}

/**
 * Policy-gated evaluation and discovery over the live catalogue, chain
 * registry, and route health. The class is dependency-injected through
 * {@link PeerRoutingSources}; production wiring lives in `index.ts`.
 */
export class PeerRoutingEngine implements PeerRoutingService {
  private readonly defaultLimit: number
  private readonly maxLimit: number

  /**
   * @param sources - every external read, called fresh per request.
   * @param limits - page-size bounds from the plugin config.
   */
  constructor(private readonly sources: PeerRoutingSources, limits: PeerRoutingLimits) {
    this.maxLimit = limits.maxLimit > 0 ? limits.maxLimit : 1
    this.defaultLimit = limits.defaultLimit > 0 ? Math.min(limits.defaultLimit, this.maxLimit) : this.maxLimit
  }

  /** Read the catalogue, chains, and route health once for one request. */
  private snapshot(): RoutingSnapshot {
    const now = this.sources.now()
    return {
      facts: projectRouteFacts({
        entries: this.sources.catalogue(),
        rawEfforts: this.sources.rawEfforts(),
        zeroPriceKeys: this.sources.zeroPriceKeys(),
        privacy: this.sources.privacy(),
      }),
      chains: parseResolvedChains(this.sources.chains()),
      cooling: readCoolingRoutes(this.sources.routeHealth(), now),
      now,
    }
  }

  /**
   * Resolve the first ready member of a chain, falling back to the first
   * declared member when every member is cooling.
   * @param chain - resolved chain.
   * @param cooling - cooling keys for this snapshot.
   * @returns the member to select.
   */
  private static firstReady(chain: ResolvedChain, cooling: ReadonlyMap<string, number>): ResolvedChainMember {
    for (const member of chain.members) {
      if (!cooling.has(routeKey(member.provider, member.model))) return member
    }
    return chain.members[0]!
  }

  /** Build one successful verdict with its concrete selection. */
  private static allow(provider: string, model: string, chain: string | undefined, effort: string | undefined): PeerRoutingVerdict {
    return {
      allowed: true,
      selection: {
        provider,
        model,
        ...(chain === undefined ? {} : { chain }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      },
    }
  }

  /**
   * Validate the EFFECTIVE effort of a concrete chain member (caller-named,
   * else the chain link's declared effort) and build the verdict. A chain link
   * effort is operator configuration, but the caller selects the chain, so it
   * still has to sit inside the policy's effort allowlist.
   * @param member - concrete chain member.
   * @param facts - member facts from the same snapshot.
   * @param policy - pairing routing policy.
   * @param chainId - selected chain id.
   * @param effort - caller-named effort, when supplied.
   * @returns the verdict.
   */
  private static allowMember(
    member: ResolvedChainMember,
    facts: RouteFacts,
    policy: PeerRoutingPolicy,
    chainId: string,
    effort: string | undefined,
  ): PeerRoutingVerdict {
    const effective = effort ?? member.effort
    if (effective !== undefined) {
      const denied = checkEffort(facts, policy, effective)
      if (denied !== undefined) return denied
    }
    return PeerRoutingEngine.allow(member.provider, member.model, chainId, effective)
  }

  /**
   * Evaluate one requested selection against a pairing's routing policy.
   *
   * Cases: chain only (membership grant), pinned provider/model (allowModels
   * grant), and pinned provider/model plus chain (both). Every member of a
   * selected chain is re-checked against the policy at call time so a dynamic
   * chain that drifted to include a paid, training, gated, or disallowed model
   * is refused before the host applies it.
   * @param policy - pairing routing policy.
   * @param selection - caller-requested route or chain.
   * @returns allowed with the concrete selection, or the refusal.
   */
  async evaluate(policy: PeerRoutingPolicy, selection: PeerModelSelection): Promise<PeerRoutingVerdict> {
    const provider = trimmedString(selection.provider)
    const model = trimmedString(selection.model)
    const chainId = trimmedString(selection.chain)
    const effort = trimmedString(selection.reasoningEffort)
    const snapshot = this.snapshot()

    if (chainId !== undefined) {
      if (!policyAllowsChain(policy, chainId)) return { allowed: false, reason: 'chain-not-allowed', denied: chainId }
      const chain = snapshot.chains.get(chainId)
      if (chain === undefined) return { allowed: false, reason: 'unknown-route', denied: chainId }
      for (const member of chain.members) {
        const key = routeKey(member.provider, member.model)
        const facts = snapshot.facts.get(key)
        if (facts === undefined) return { allowed: false, reason: 'unknown-route', denied: key }
        const check = checkRouteFacts(facts, policy, { requireExplicitModel: false })
        if (!check.allowed) return check
      }
      if (provider !== undefined || model !== undefined) {
        if (provider === undefined || model === undefined) {
          return { allowed: false, reason: 'unknown-route', denied: routeKey(provider ?? '', model ?? '') }
        }
        const key = routeKey(provider, model)
        const member = chain.members.find(candidate => candidate.provider === provider && candidate.model === model)
        if (member === undefined) return { allowed: false, reason: 'model-not-allowed', denied: key }
        const facts = snapshot.facts.get(key)!
        const check = checkRouteFacts(facts, policy, { requireExplicitModel: true })
        if (!check.allowed) return check
        return PeerRoutingEngine.allowMember(member, facts, policy, chain.id, effort)
      }
      const chosen = PeerRoutingEngine.firstReady(chain, snapshot.cooling)
      const facts = snapshot.facts.get(routeKey(chosen.provider, chosen.model))!
      return PeerRoutingEngine.allowMember(chosen, facts, policy, chain.id, effort)
    }

    if (provider === undefined || model === undefined) {
      return { allowed: false, reason: 'unknown-route', denied: routeKey(provider ?? '', model ?? '') }
    }
    const key = routeKey(provider, model)
    const facts = snapshot.facts.get(key)
    if (facts === undefined) return { allowed: false, reason: 'unknown-route', denied: key }
    const check = checkRouteFacts(facts, policy, {
      requireExplicitModel: true,
      ...(effort === undefined ? {} : { effort }),
    })
    if (!check.allowed) return check
    return PeerRoutingEngine.allow(provider, model, undefined, effort)
  }

  /** Discovery chains: every allowed and resolvable chain, with live member state. */
  private chainInfos(policy: PeerRoutingPolicy, snapshot: RoutingSnapshot): PeerChainInfo[] {
    const chains: PeerChainInfo[] = []
    const seen = new Set<string>()
    for (const id of policy.allowChains ?? []) {
      if (seen.has(id)) continue
      seen.add(id)
      const chain = snapshot.chains.get(id)
      if (chain === undefined) continue
      chains.push({
        id: chain.id,
        ...(chain.label === undefined ? {} : { label: chain.label }),
        dynamic: chain.dynamic,
        members: chain.members.map(member => {
          const key = routeKey(member.provider, member.model)
          // A deprecated member is not selectable, so its state wins over any
          // cooling window: a controller must not read it as merely resting.
          if (snapshot.facts.get(key)?.deprecated === true) {
            return { provider: member.provider, model: member.model, state: 'deprecated' as const }
          }
          const until = snapshot.cooling.get(key)
          return until === undefined
            ? { provider: member.provider, model: member.model, state: 'ready' as const }
            : { provider: member.provider, model: member.model, state: 'cooldown' as const, cooldownUntil: until }
        }),
      })
    }
    return chains
  }

  /** Discovery rows: every route the pinned predicate accepts, sorted. */
  private modelInfos(policy: PeerRoutingPolicy, snapshot: RoutingSnapshot, filter: PeerModelsFilter | undefined): PeerModelInfo[] {
    const models: PeerModelInfo[] = []
    for (const facts of snapshot.facts.values()) {
      const check = checkRouteFacts(facts, policy, { requireExplicitModel: true })
      if (!check.allowed) continue
      const info = toPeerModelInfo(facts)
      if (!passesFilter(info, filter)) continue
      models.push(info)
    }
    models.sort(compareRoutes)
    return models
  }

  /** Effective page size: bounded, with the configured default for a bad request. */
  private pageLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return this.defaultLimit
    return Math.min(limit, this.maxLimit)
  }

  /**
   * Policy-filtered discovery. Chains carry their full resolved membership (so
   * a controller can see cooldowns); models carry only routes the pinned policy
   * predicate accepts. Results are ordered `(provider, model)` and paginated by
   * an opaque cursor.
   * @param policy - pairing routing policy.
   * @param request - optional filter, cursor, and page size.
   * @returns the page and an optional continuation cursor.
   * @throws Error `invalid cursor` when `request.cursor` was not minted here.
   */
  async discover(
    policy: PeerRoutingPolicy,
    request: { readonly filter?: PeerModelsFilter; readonly cursor?: string; readonly limit?: number },
  ): Promise<{ readonly chains: readonly PeerChainInfo[]; readonly models: readonly PeerModelInfo[]; readonly nextCursor?: string }> {
    const snapshot = this.snapshot()
    const chains = this.chainInfos(policy, snapshot)
    const models = this.modelInfos(policy, snapshot, request.filter)
    const start = request.cursor === undefined ? 0 : firstAfter(models, decodeCursor(request.cursor))
    const limit = this.pageLimit(request.limit)
    const page = models.slice(start, start + limit)
    const nextCursor = start + limit < models.length ? encodeCursor(page[page.length - 1]!) : undefined
    return { chains, models: page, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }
}
