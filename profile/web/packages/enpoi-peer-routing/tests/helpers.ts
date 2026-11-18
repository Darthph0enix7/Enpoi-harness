import type { CatalogEntry, PrivacyOverrides } from 'dsh-enpoi-catalog-rules'
import { PeerRoutingEngine, type PeerRoutingLimits, type PeerRoutingSources } from '../src/index.ts'

/** One catalogue entry with the fields a spec cares about. */
export function entry(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return { provider, id, ...overrides }
}

/** A catalogue row with a known zero price. */
export function free(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry(provider, id, { cost: { input: 0, output: 0 }, tools: true, ...overrides })
}

/** A catalogue row with a known non-zero price. */
export function paid(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry(provider, id, { cost: { input: 1, output: 2 }, tools: true, ...overrides })
}

/** A catalogue row whose price the catalogue does not know. */
export function unpriced(provider: string, id: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry(provider, id, { tools: true, ...overrides })
}

/** Mutable test state behind the source closures. */
export interface RoutingHarness {
  readonly engine: PeerRoutingEngine
  readonly state: {
    entries: CatalogEntry[]
    efforts: Map<string, unknown>
    zeroPriceKeys: ReadonlySet<string> | undefined
    privacy: PrivacyOverrides | undefined
    chains: unknown
    health: readonly unknown[]
    now: number
  }
}

/** Build an engine over mutable state so a spec can drift it between calls. */
export function harness(options: {
  entries?: CatalogEntry[]
  efforts?: Record<string, unknown>
  zeroPrice?: readonly string[] | undefined
  privacy?: PrivacyOverrides
  chains?: unknown
  health?: readonly unknown[]
  now?: number
  limits?: PeerRoutingLimits
} = {}): RoutingHarness {
  const state: RoutingHarness['state'] = {
    entries: [...(options.entries ?? [])],
    efforts: new Map(Object.entries(options.efforts ?? {})),
    zeroPriceKeys: options.zeroPrice === undefined ? undefined : new Set(options.zeroPrice),
    privacy: options.privacy,
    chains: options.chains,
    health: options.health ?? [],
    now: options.now ?? 1_000,
  }
  const sources: PeerRoutingSources = {
    catalogue: () => state.entries,
    zeroPriceKeys: () => state.zeroPriceKeys,
    privacy: () => state.privacy,
    rawEfforts: () => state.efforts,
    chains: () => state.chains,
    routeHealth: () => state.health,
    now: () => state.now,
  }
  return {
    engine: new PeerRoutingEngine(sources, options.limits ?? { defaultLimit: 100, maxLimit: 500 }),
    state,
  }
}
