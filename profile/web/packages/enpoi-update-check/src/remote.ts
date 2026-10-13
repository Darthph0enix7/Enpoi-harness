/**
 * enpoi-update-check — the `updateCheck` Typert Remote namespace.
 *
 * Endpoints (wire names): `updateCheck/status`, `updateCheck/checkNow`,
 * `updateCheck/dismiss`. Thin decorated shell over {@link UpdateCheckCore}
 * (decorator-free, so the vitest pipeline tests the logic directly). Advisory
 * only: nothing here downloads or applies an update.
 *
 * @module dsh-enpoi-update-check/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { UpdateCheckCore, UpdateCheckStatus } from './service.js'

/** Cordis service key and Typert wire namespace. */
export const UPDATE_CHECK_NAMESPACE = 'updateCheck'

/** Service construction dependencies. */
export interface UpdateCheckServiceOptions {
  readonly core: UpdateCheckCore
}

/** `updateCheck.dismiss` request. */
export interface DismissRequest {
  /** Release version to skip (`0.1.7-enpoi.2.84`). */
  readonly version?: unknown
}

/**
 * The `updateCheck` Remote service: a pollable status plus an explicit refresh
 * and per-version skip.
 */
export class UpdateCheckService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes the core. */
  static inject: string[] = []

  private readonly core: UpdateCheckCore

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - the core that owns the status.
   */
  constructor(ctx: Context, options: UpdateCheckServiceOptions) {
    super(ctx, UPDATE_CHECK_NAMESPACE)
    this.core = options.core
  }

  /**
   * The current check result.
   *
   * @returns the status snapshot; `state: 'unknown'` before the first
   *   successful check and after a failure with no prior success.
   */
  @Remote
  status(): UpdateCheckStatus {
    return this.core.snapshot()
  }

  /**
   * Run one check now (single-flight with the interval timer).
   *
   * @returns the status after the attempt; never rejects.
   */
  @Remote
  checkNow(): Promise<UpdateCheckStatus> {
    return this.core.checkNow()
  }

  /**
   * Record one version as dismissed ("skip this version"). A newer catalog
   * version re-arms the indicator.
   *
   * @param request - the version to skip.
   * @returns the status after recording the skip.
   * @throws RemoteError `gateway/bad-request` when `version` is missing.
   */
  @Remote
  dismiss(request: DismissRequest): UpdateCheckStatus {
    const version = typeof request?.version === 'string' ? request.version.trim() : ''
    if (version === '') {
      throw new RemoteError('gateway/bad-request', 'updateCheck.dismiss: version is required', {})
    }
    return this.core.dismiss(version)
  }
}
