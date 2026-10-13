/**
 * enpoi-update-check — the `updateCheck` Typert Remote namespace.
 *
 * Endpoints (wire names): `updateCheck/status`, `updateCheck/checkNow`,
 * `updateCheck/dismiss`, `updateCheck/start`, `updateCheck/run`. Thin
 * decorated shell over {@link UpdateCheckCore} and
 * {@link UpdateRunController} (decorator-free, so the vitest pipeline tests
 * the logic directly). Advisory until `start` is called: nothing here
 * downloads or applies an update on its own.
 *
 * @module dsh-enpoi-update-check/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { UpdateRunRecord } from './run.js'
import { RunRefusedError, type UpdateRunController } from './run-service.js'
import type { UpdateCheckCore, UpdateCheckStatus } from './service.js'

/** Cordis service key and Typert wire namespace. */
export const UPDATE_CHECK_NAMESPACE = 'updateCheck'

/** Service construction dependencies. */
export interface UpdateCheckServiceOptions {
  readonly core: UpdateCheckCore
  /** The one-run controller (start/watch/run/reconcile). */
  readonly runs: UpdateRunController
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
  private readonly runs: UpdateRunController

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - the core that owns the status and the run controller.
   */
  constructor(ctx: Context, options: UpdateCheckServiceOptions) {
    super(ctx, UPDATE_CHECK_NAMESPACE)
    this.core = options.core
    this.runs = options.runs
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

  /**
   * Start one update run: pin the available target, launch the updater
   * detached, and return the fresh run record. The [Update now] click is the
   * operator's restart decision; the run proceeds to switch+restart on its
   * own.
   *
   * @returns the run record (phase `starting`).
   * @throws RemoteError `gateway/bad-request` when no update is available, a
   *   run is already active, the shim is missing, or the launch fails.
   */
  @Remote
  start(): UpdateRunRecord {
    try {
      return this.runs.start()
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError('gateway/bad-request', error.message, {})
      }
      throw error
    }
  }

  /**
   * The current run record, or null when no run has been started on this
   * install. Terminal records stay readable (their log tail backs the
   * failure/success surfaces); a new `start` replaces them.
   *
   * @returns the run record or null.
   */
  @Remote
  run(): UpdateRunRecord | null {
    return this.runs.run()
  }
}
