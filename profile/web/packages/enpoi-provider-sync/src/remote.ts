/**
 * enpoi-provider-sync — the `providerSync` Typert Remote namespace.
 *
 * The Models page's manual Refresh runs the same route pipeline as the hourly
 * pass through one endpoint instead of re-implementing membership client-side.
 * The host returns the planned settings records and the removal report; the
 * caller persists them, so a refresh never writes behind an open editor. The
 * `@Remote` decorator lives in this lazily imported module so the unit-test
 * import graph never has to parse it.
 *
 * @module dsh-enpoi-provider-sync/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ProviderSyncRouteRefreshValue } from './index.ts'

/** The host pipeline one `refreshRoute` call runs. */
export type ProviderSyncRouteRefresh = (route: string) => Promise<ProviderSyncRouteRefreshValue>

/** The service behind the `providerSync` Remote namespace. */
export class ProviderSyncService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes its pipeline. */
  static inject: string[] = []

  private readonly refresh: ProviderSyncRouteRefresh

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param refresh - the shared route-refresh pipeline.
   */
  constructor(ctx: Context, refresh: ProviderSyncRouteRefresh) {
    super(ctx, 'providerSync')
    this.refresh = refresh
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
}

/**
 * Mount the `providerSync` Remote namespace on one plugin context.
 * @param ctx - the provider-sync plugin's context.
 * @param refresh - the plugin's shared route-refresh pipeline.
 */
export function mountProviderSyncRemote(ctx: Context, refresh: ProviderSyncRouteRefresh): void {
  new ProviderSyncService(ctx, refresh)
}
