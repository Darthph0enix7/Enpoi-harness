/**
 * Resolved catalogue visibility (`enpoi-orchestration.catalogRules.resolved`)
 * as the composer picker consumes it.
 *
 * The host rules engine evaluates every catalogue entry against the current
 * `catalogRules` document after each settings update and publishes only the
 * decisions that differ from default-visible: hidden entries (with the reason
 * the picker renders) and manual pins (with the rule or gate they override).
 * One `settings.describe` primes a module-level cache at load; the
 * `dsh:catalog-visibility-changed` event queues a re-read, and the payload is
 * mirrored into {@link CATALOG_VISIBILITY_STORAGE_KEY} so a surface that must
 * not fetch settings itself can resolve a decision synchronously. An empty or
 * absent map means "no rules applied": the caller falls back to its own
 * manual hidden list.
 */

/** One resolved visibility decision for one `provider/model`. */
export interface CatalogVisibilityDecision {
  /** Whether the picker shows it. */
  state: 'visible' | 'hidden'
  /** Picker string, or null when visible by default. */
  reason: string | null
  /** Why: manual pin, hide rule, or gating. */
  source: 'default' | 'manual' | 'rule' | 'gated'
  /** The rule text that hid it (`source === 'rule'`). */
  rule?: string
  /** The rule text a manual pin overrode, when applicable. */
  overriddenRule?: string
}

/** localStorage mirror of the last loaded decision map. */
export const CATALOG_VISIBILITY_STORAGE_KEY = 'dsh_catalog_visibility_v1'

/** Window event asking every consumer to re-read the decision map. */
export const CATALOG_VISIBILITY_CHANGED_EVENT = 'dsh:catalog-visibility-changed'

/** Parse one published decision; undefined when malformed. */
export function parseCatalogVisibilityDecision(raw: unknown): CatalogVisibilityDecision | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (rec.state !== 'visible' && rec.state !== 'hidden') return undefined
  if (rec.reason !== null && typeof rec.reason !== 'string') return undefined
  const source = rec.source === 'default' || rec.source === 'manual' || rec.source === 'rule' || rec.source === 'gated'
    ? rec.source
    : undefined
  if (source === undefined) return undefined
  return {
    state: rec.state,
    reason: rec.reason,
    source,
    ...typeof rec.rule === 'string' ? { rule: rec.rule } : {},
    ...typeof rec.overriddenRule === 'string' ? { overriddenRule: rec.overriddenRule } : {},
  }
}

/** Parse the published `catalogRules.resolved` map, dropping malformed rows. */
export function parseCatalogVisibility(value: unknown): Map<string, CatalogVisibilityDecision> {
  const map = new Map<string, CatalogVisibilityDecision>()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return map
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const decision = parseCatalogVisibilityDecision(raw)
    if (decision !== undefined) map.set(key, decision)
  }
  return map
}

let decisions = new Map<string, CatalogVisibilityDecision>()
let loaded = false
let inflight: Promise<void> | undefined

/**
 * The shared coalesced `settings.describe` reader the connection wire root
 * publishes; absent in standalone bundles, where the local fetch stands in.
 * @returns the shared reader, or undefined.
 */
function sharedDescribe(): (() => Promise<{ namespaces?: readonly unknown[] } | undefined>) | undefined {
  const candidate = (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
  return typeof candidate === 'function'
    ? candidate as () => Promise<{ namespaces?: readonly unknown[] } | undefined>
    : undefined
}

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent(CATALOG_VISIBILITY_CHANGED_EVENT))
  } catch {
    // No window (non-DOM caller): the in-memory cache still serves.
  }
}

function publish(next: Map<string, CatalogVisibilityDecision>): void {
  decisions = next
  loaded = true
  try {
    localStorage.setItem(CATALOG_VISIBILITY_STORAGE_KEY, JSON.stringify(Object.fromEntries(next)))
  } catch {
    // Storage disabled (private mode, quota): the in-memory cache still serves.
  }
  notify()
}

/** Read the mirror a previous load wrote, for a first paint before the fetch. */
function readMirror(): Map<string, CatalogVisibilityDecision> {
  try {
    const raw = localStorage.getItem(CATALOG_VISIBILITY_STORAGE_KEY)
    return raw === null ? new Map() : parseCatalogVisibility(JSON.parse(raw))
  } catch {
    return new Map()
  }
}

/**
 * The current decision map; an absent key means the entry is visible by
 * default. The reference changes only when a load publishes.
 * @returns the live map.
 */
export function catalogVisibilitySnapshot(): ReadonlyMap<string, CatalogVisibilityDecision> {
  if (!loaded && decisions.size === 0) decisions = readMirror()
  return decisions
}

/**
 * The decision for one provider/model, or undefined when it is default-visible.
 * @param provider - provider route id.
 * @param modelId - model id.
 * @returns the published decision, when one exists.
 */
export function catalogDecision(provider: string, modelId: string): CatalogVisibilityDecision | undefined {
  return catalogVisibilitySnapshot().get(`${provider}/${modelId}`)
}

/**
 * Refresh unless one load already published; resolves once the cache is usable.
 * A picker mounted before the import-time fetch settled uses this to repaint.
 * @returns a promise resolving after the map is published (or the read failed).
 */
export function ensureCatalogVisibility(): Promise<void> {
  return loaded ? Promise.resolve() : refreshCatalogVisibility()
}

/**
 * Re-read `enpoi-orchestration.catalogRules.resolved` through the live gateway.
 * A missing namespace publishes the empty map, so a profile without the host
 * engine clears any stale mirror instead of hiding models forever.
 * @returns nothing; the cache and its event carry the outcome.
 */
export function refreshCatalogVisibility(): Promise<void> {
  if (inflight !== undefined) return inflight
  const readNamespaces = async (): Promise<unknown> => {
    const shared = sharedDescribe()
    if (shared !== undefined) return (await shared())?.namespaces
    const res = await fetch('/api/settings.describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method: 'settings.describe',
        rpcId: 'catalog-visibility-describe',
        payload: { args: {} },
      }),
    })
    if (!res.ok) return undefined
    const json: unknown = await res.json()
    const response = json as { result?: { value?: { namespaces?: unknown } } } | null
    return response?.result?.value?.namespaces
  }
  const operation = readNamespaces()
    .then((namespaces) => {
      if (!Array.isArray(namespaces)) return
      const namespace = (namespaces as Array<{ ns?: string; value?: unknown; user?: unknown }>)
        .find(entry => entry.ns === 'enpoi-orchestration')
      const rules = namespace === undefined
        ? undefined
        : ((namespace.value as { catalogRules?: { resolved?: unknown } } | undefined)?.catalogRules
          ?? (namespace.user as { catalogRules?: { resolved?: unknown } } | undefined)?.catalogRules)
      publish(parseCatalogVisibility(rules?.resolved))
    })
    .catch(() => {
      // Offline answer: the last published map stays until the next read.
    })
    .finally(() => {
      inflight = undefined
    })
  inflight = operation
  return operation
}

// Prime on import so the per-session pickers never pay the describe latency.
if (typeof window !== 'undefined') {
  void refreshCatalogVisibility()
}
