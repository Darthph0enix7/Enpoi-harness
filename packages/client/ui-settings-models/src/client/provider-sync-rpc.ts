/**
 * Client half of the `providerSync` Remote namespace (the profile plugin
 * `dsh-enpoi-provider-sync`). Same POST-per-method envelope the
 * `enpoiHeavy`/`enpoiUiState` calls use; a failure to reach or parse the
 * answer is reported to the caller, which falls back to the plain discovery
 * path without removals.
 *
 * `refreshRoute` is the editor-scoped route refresh: it answers the planned
 * records for the caller to persist. `refreshRoutes` is the page-level full
 * pass: the host re-lists every discoverable route (bypassing caches and
 * freshness gates), persists configured routes itself, and answers one status
 * per route so the page can report what each endpoint did.
 *
 * @module ui-settings-models/provider-sync-rpc
 */

/** The host's planned records and removal report for one route refresh. */
export interface ProviderSyncRefreshView {
  route: string
  /** The resulting settings records; replace-semantics base for the caller. */
  models: Array<Record<string, unknown>>
  /** Ids the host removed. */
  removed: string[]
  /** Ids kept only because a reference pins them (deprecated upstream). */
  deprecated: string[]
  /** Whether removals were withheld this refresh. */
  degraded: boolean
  /** Why removals were withheld, when they were. */
  degradedReason?: string
  /** Which listing answered. */
  source: string
  /** The membership authority the host applied. */
  authority: string
  /** The epoch milliseconds the plan ran at. */
  fetchedAt: number
}

/** One `providerSync.refreshRoute` call's outcome. */
export type ProviderSyncRpcResult =
  | { ok: true; value: ProviderSyncRefreshView }
  | { ok: false; message: string }

/** What one route's entry a full pass could do. */
export type ProviderSyncRouteState = 'ok' | 'unreachable' | 'no-listing' | 'static-catalog'

/** One route's outcome from a full refresh pass. */
export interface ProviderSyncRouteStatusView {
  route: string
  status: ProviderSyncRouteState
  /** Which listing answered: the live endpoint, the bundled catalog, or neither. */
  source: string
  /** The membership authority the host applied. */
  authority: string
  /** Models the listing advertised, when it answered. */
  advertised?: number
  /** The route's planned model count. */
  modelCount: number
  removed: string[]
  deprecated: string[]
  degraded: boolean
  degradedReason?: string
  /** Whether the discovered-model cache now holds this pass's listing. */
  cached: boolean
  /** Why the route was not probed, or the listing failure line. */
  message?: string
  fetchedAt: number
}

/** The host's full-pass answer. */
export interface ProviderSyncRefreshAllView {
  refreshedAt: number
  routes: ProviderSyncRouteStatusView[]
}

/** One `providerSync.refreshRoutes` call's outcome. */
export type ProviderSyncRpcAllResult =
  | { ok: true; value: ProviderSyncRefreshAllView }
  | { ok: false; message: string }

/** Every route state the wire may name; anything else reads as `no-listing`. */
const ROUTE_STATES: ReadonlySet<string> = new Set(['ok', 'unreachable', 'no-listing', 'static-catalog'])

let sequence = 0

/**
 * Structurally accept one wire value as the host's refresh result. A payload
 * without a `models` array is treated as unavailable so the caller falls back
 * to the discovery path rather than writing an empty catalog.
 * @param value - the raw wire value.
 * @returns the refresh view, or undefined when the payload is malformed.
 */
function readRefreshValue(value: unknown): ProviderSyncRefreshView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.models)) return undefined
  const strings = (raw: unknown): string[] => Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  return {
    route: typeof record.route === 'string' ? record.route : '',
    models: record.models.filter((model): model is Record<string, unknown> => model !== null && typeof model === 'object' && !Array.isArray(model)),
    removed: strings(record.removed),
    deprecated: strings(record.deprecated),
    degraded: record.degraded === true,
    ...typeof record.degradedReason === 'string' ? { degradedReason: record.degradedReason } : {},
    source: typeof record.source === 'string' ? record.source : 'none',
    authority: typeof record.authority === 'string' ? record.authority : 'none',
    fetchedAt: typeof record.fetchedAt === 'number' ? record.fetchedAt : 0,
  }
}

/**
 * Run one provider route's manual refresh on the host. The host computes the
 * same membership the hourly pass computes (grace, protection, gates, shrink
 * guards) and returns the records to persist; the caller keeps ownership of
 * the settings write.
 * @param route - the provider route key.
 * @returns the refresh view, or a displayable failure message when the RPC is
 *   unavailable or the host refused the call.
 */
export async function refreshRouteViaPlugin(route: string): Promise<ProviderSyncRpcResult> {
  const method = 'providerSync.refreshRoute'
  try {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: `${method}-${sequence += 1}`,
        payload: { args: { route } },
      }),
    })
    if (!response.ok) return { ok: false, message: `providerSync.refreshRoute responded ${String(response.status)}` }
    const json = await response.json() as { result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } } }
    const result = json.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'providerSync.refreshRoute was rejected' }
    }
    const value = readRefreshValue(result.value)
    return value === undefined
      ? { ok: false, message: 'providerSync.refreshRoute returned an unusable payload' }
      : { ok: true, value }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Structurally accept one wire route status. Unusable entries are dropped
 * rather than failing the whole pass: one malformed route must not hide the
 * status of the others.
 * @param value - the raw wire entry.
 * @returns the status view, or undefined when the entry names no route.
 */
function readRouteStatus(value: unknown): ProviderSyncRouteStatusView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.route !== 'string' || record.route === '') return undefined
  const strings = (raw: unknown): string[] => Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  const count = typeof record.modelCount === 'number' && Number.isInteger(record.modelCount) && record.modelCount >= 0
    ? record.modelCount
    : 0
  return {
    route: record.route,
    status: typeof record.status === 'string' && ROUTE_STATES.has(record.status)
      ? record.status as ProviderSyncRouteState
      : 'no-listing',
    source: typeof record.source === 'string' ? record.source : 'none',
    authority: typeof record.authority === 'string' ? record.authority : 'none',
    ...typeof record.advertised === 'number' && Number.isInteger(record.advertised) && record.advertised >= 0
      ? { advertised: record.advertised }
      : {},
    modelCount: count,
    removed: strings(record.removed),
    deprecated: strings(record.deprecated),
    degraded: record.degraded === true,
    ...typeof record.degradedReason === 'string' ? { degradedReason: record.degradedReason } : {},
    cached: record.cached === true,
    ...typeof record.message === 'string' ? { message: record.message } : {},
    fetchedAt: typeof record.fetchedAt === 'number' ? record.fetchedAt : 0,
  }
}

/**
 * Structurally accept one full-pass answer. A payload with no routes array is
 * unusable; individual malformed entries are dropped.
 * @param value - the raw wire value.
 * @returns the pass view, or undefined when the payload is malformed.
 */
function readRefreshAllValue(value: unknown): ProviderSyncRefreshAllView | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.routes)) return undefined
  return {
    refreshedAt: typeof record.refreshedAt === 'number' ? record.refreshedAt : 0,
    routes: record.routes
      .map(readRouteStatus)
      .filter((entry): entry is ProviderSyncRouteStatusView => entry !== undefined),
  }
}

/**
 * Run the full manual refresh on the host: every discoverable route is
 * re-listed, the online catalogue is refreshed, configured routes' records are
 * persisted, and every discovery cache is updated. The host owns the writes
 * for this pass (unlike {@link refreshRouteViaPlugin}), because the operator
 * asked for a whole-page refresh rather than an edit of one route.
 * @param routes - optional route keys to restrict the pass to.
 * @returns the per-route statuses, or a displayable failure message when the
 *   RPC is unavailable, the host refused the call, or the payload is unusable.
 */
export async function refreshRoutesViaPlugin(routes?: readonly string[]): Promise<ProviderSyncRpcAllResult> {
  const method = 'providerSync.refreshRoutes'
  try {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        method,
        rpcId: `${method}-${sequence += 1}`,
        payload: { args: routes === undefined ? {} : { routes } },
      }),
    })
    if (!response.ok) return { ok: false, message: `providerSync.refreshRoutes responded ${String(response.status)}` }
    const json = await response.json() as { result?: { ok?: boolean; value?: unknown; error?: { message?: unknown } } }
    const result = json.result
    if (result?.ok !== true) {
      const message = result?.error?.message
      return { ok: false, message: typeof message === 'string' && message !== '' ? message : 'providerSync.refreshRoutes was rejected' }
    }
    const value = readRefreshAllValue(result.value)
    return value === undefined
      ? { ok: false, message: 'providerSync.refreshRoutes returned an unusable payload' }
      : { ok: true, value }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
