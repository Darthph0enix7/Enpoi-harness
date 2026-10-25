/**
 * enpoi-provider-sync — the `providerSync` Typert Remote namespace.
 *
 * The Models page's manual Refresh runs the same route pipeline as the hourly
 * pass through one endpoint instead of re-implementing membership client-side.
 * The per-route `refreshRoute` returns the planned settings records and the
 * removal report; the caller persists them, so a route refresh never writes
 * behind an open editor. The `refreshRoutes` full pass re-lists every
 * discoverable route, persists the configured routes itself (the hourly pass's
 * own write path), refreshes every discovery cache, and answers one status per
 * route. The `@Remote` decorator lives in this lazily imported module so the
 * unit-test import graph never has to parse it.
 *
 * @module dsh-enpoi-provider-sync/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderSyncRoutesRefreshValue, ProviderSyncRouteRefreshValue } from './index.ts'

/** The host pipeline one `refreshRoute` call runs. */
export type ProviderSyncRouteRefresh = (route: string) => Promise<ProviderSyncRouteRefreshValue>

/** The host pipeline one `refreshRoutes` call runs. */
export type ProviderSyncRoutesRefresh = (routes?: readonly string[]) => Promise<ProviderSyncRoutesRefreshValue>

/** The service behind the `providerSync` Remote namespace. */
export class ProviderSyncService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes its pipeline. */
  static inject: string[] = []

  private readonly refresh: ProviderSyncRouteRefresh

  private readonly refreshAll: ProviderSyncRoutesRefresh | undefined

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param refresh - the shared route-refresh pipeline.
   * @param refreshAll - the full-pass pipeline, when the plugin mounts one.
   */
  constructor(ctx: Context, refresh: ProviderSyncRouteRefresh, refreshAll?: ProviderSyncRoutesRefresh) {
    super(ctx, 'providerSync')
    this.refresh = refresh
    this.refreshAll = refreshAll
  }

  /**
   * Refresh one configured provider route and return the resulting settings
   * records plus the removal report. The route's membership, grace, guards,
   * deprecation, and visibility cleanup are the hourly pass's own pipeline.
   * @param route - the provider route key (for example `opencode-go`).
   * @returns the planned records and the removal audit.
   */
  @Remote
  async refreshRoute(route: string): Promise<ProviderSyncRouteRefreshValue> {
    if (typeof route !== 'string' || route.trim() === '') {
      throw new RemoteError('gateway/bad-request', 'providerSync.refreshRoute: route must be a non-empty string', {})
    }
    try {
      return await this.refresh(route)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('gateway/bad-request', `providerSync.refreshRoute: ${message}`, {})
    }
  }

  /**
   * Re-list every discoverable route in one pass: the online catalogue (not a
   * cached snapshot), each route's endpoint listing (bypassing the freshness
   * windows and the unattended shrink guard), the persisted records of every
   * configured route, and every discovery cache. Each route answers its own
   * status, so one unreachable provider never hides the rest.
   * @param routes - optional route keys to restrict the pass to.
   * @returns the per-route statuses and the pass timestamp.
   */
  @Remote
  async refreshRoutes(routes?: readonly string[]): Promise<ProviderSyncRoutesRefreshValue> {
    if (routes !== undefined
      && (!Array.isArray(routes) || routes.some(route => typeof route !== 'string' || route.trim() === ''))) {
      throw new RemoteError(
        'gateway/bad-request',
        'providerSync.refreshRoutes: routes must be an array of non-empty strings',
        {},
      )
    }
    if (this.refreshAll === undefined) {
      throw new RemoteError('gateway/unavailable', 'providerSync.refreshRoutes: the host did not mount a full-pass pipeline', {})
    }
    try {
      return await this.refreshAll(routes)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('gateway/bad-request', `providerSync.refreshRoutes: ${message}`, {})
    }
  }
}

/**
 * Mount the `providerSync` Remote namespace on one plugin context.
 * @param ctx - the provider-sync plugin's context.
 * @param refresh - the plugin's shared route-refresh pipeline.
 * @param refreshAll - the plugin's full-pass pipeline, when it has one.
 */
export function mountProviderSyncRemote(
  ctx: Context,
  refresh: ProviderSyncRouteRefresh,
  refreshAll?: ProviderSyncRoutesRefresh,
): void {
  new ProviderSyncService(ctx, refresh, refreshAll)
}
