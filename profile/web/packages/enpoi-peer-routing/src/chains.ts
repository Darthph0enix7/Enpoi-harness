/**
 * Chain registry and route-health reads for the peer routing service.
 *
 * Chains come from the `modelChains.resolved` artifact the `modelChains`
 * plugin publishes beside the settings document — the same projection the
 * model picker renders. The artifact is read through the host's
 * `settings.readArtifact` seam; when it is absent, unreadable, or malformed the
 * service sees NO chains (fail closed) instead of inventing membership from
 * the settings document.
 *
 * Route health comes from the LLM runtime's in-memory ledger: a route that is
 * absent from the snapshot is READY, and a row with a future `coolingUntil` is
 * in cooldown.
 *
 * @module dsh-enpoi-peer-routing/chains
 */

import { isRecord, trimmedString } from './util.ts'

/** Artifact name the resolved model-group projection is published under. */
export const RESOLVED_GROUPS_ARTIFACT = 'modelChains.resolved'

/** The settings artifact read seam (structural subset of the settings service). */
export interface SettingsArtifactReader {
  /** Read one published artifact. */
  readArtifact?: (key: string) => { readonly value?: unknown } | undefined
}

/** The LLM runtime's route-health view (structural, no package dependency). */
export interface RouteHealthSeam {
  /** Current cooling routes, when the runtime exposes them. */
  routeHealth?: () => readonly unknown[]
}

/** One resolved chain member. */
export interface ResolvedChainMember {
  /** Provider route id. */
  readonly provider: string
  /** Model id within that route. */
  readonly model: string
  /** Adapter-owned reasoning effort declared by the chain, when declared. */
  readonly effort?: string
}

/** One chain the routing service may select, as the artifact resolves it. */
export interface ResolvedChain {
  /** Chain id (`chains.<id>`). */
  readonly id: string
  /** Operator-facing label, when declared. */
  readonly label?: string
  /** True when a selector auto-adopts new catalogue matches (membership drifts). */
  readonly dynamic: boolean
  /** Resolved members in attempt order; never empty. */
  readonly members: readonly ResolvedChainMember[]
}

/**
 * Read the published resolved-group value. A missing reader, a missing
 * artifact, or a throwing read all answer `undefined`.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns the raw artifact value, or undefined.
 */
export function readChainArtifact(settings: SettingsArtifactReader | undefined): unknown {
  try {
    return settings?.readArtifact?.(RESOLVED_GROUPS_ARTIFACT)?.value
  } catch {
    return undefined
  }
}

/** Parse one member list, dropping malformed rows. */
function parseMembers(raw: unknown): ResolvedChainMember[] {
  if (!Array.isArray(raw)) return []
  const members: ResolvedChainMember[] = []
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue
    const provider = trimmedString(candidate.provider)
    const model = trimmedString(candidate.model)
    if (provider === undefined || model === undefined) continue
    const effort = trimmedString(candidate.effort)
    members.push(Object.freeze({
      provider,
      model,
      ...(effort === undefined ? {} : { effort }),
    }))
  }
  return members
}

/** Whether one group carries an auto-adopting selector (published or expanded). */
function hasAdoptedSelector(raw: Record<string, unknown>): boolean {
  for (const field of ['selectors', 'selectorMatches']) {
    const list = raw[field]
    if (!Array.isArray(list)) continue
    if (list.some(item => isRecord(item) && item.adopt === true)) return true
  }
  return false
}

/**
 * Parse the `modelChains.resolved` artifact. Disabled groups and groups with no
 * usable member are omitted, so every returned chain resolves to at least one
 * member. Malformed rows never throw.
 * @param value - raw artifact value.
 * @returns usable chains keyed by id.
 */
export function parseResolvedChains(value: unknown): ReadonlyMap<string, ResolvedChain> {
  const chains = new Map<string, ResolvedChain>()
  if (!isRecord(value)) return chains
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || raw.disabled === true) continue
    const members = parseMembers(raw.members)
    if (members.length === 0) continue
    const label = trimmedString(raw.label)
    chains.set(id, {
      id,
      ...(label === undefined ? {} : { label }),
      dynamic: hasAdoptedSelector(raw),
      members,
    })
  }
  return chains
}

/**
 * Project the route-health view into cooling keys with their end time. Only a
 * future `coolingUntil` counts; malformed rows and already-expired entries are
 * READY.
 * @param view - `ctx.llm.routeHealth()` output.
 * @param now - current epoch milliseconds.
 * @returns `provider/model` keys mapped to their cooldown end.
 */
export function readCoolingRoutes(view: readonly unknown[], now: number): ReadonlyMap<string, number> {
  const cooling = new Map<string, number>()
  for (const raw of view) {
    if (!isRecord(raw)) continue
    const provider = trimmedString(raw.provider)
    const model = trimmedString(raw.model)
    const until = raw.coolingUntil
    if (provider === undefined || model === undefined) continue
    if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) continue
    const key = `${provider}/${model}`
    const current = cooling.get(key)
    if (current === undefined || until > current) cooling.set(key, until)
  }
  return cooling
}
