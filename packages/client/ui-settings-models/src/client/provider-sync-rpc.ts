/**
 * Client half of the `providerSync` Remote namespace (the profile plugin
 * `dsh-enpoi-provider-sync`). Same POST-per-method envelope the
 * `enpoiHeavy`/`enpoiUiState` calls use; a failure to reach or parse the
 * answer is reported to the caller, which falls back to the plain discovery
 * path without removals.
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
    const result = json?.result
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
