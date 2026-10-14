/**
 * enpoi-update-check — the `updateCheck` Typert Remote namespace.
 *
 * Endpoints (wire names): `updateCheck/status`, `updateCheck/checkNow`,
 * `updateCheck/dismiss`, `updateCheck/start`, `updateCheck/apply`,
 * `updateCheck/run`, `updateCheck/cancel`, `updateCheck/clearStale`. Thin decorated shell over {@link UpdateCheckCore} and
 * {@link UpdateRunController} (decorator-free, so the vitest pipeline tests
 * the logic directly). Advisory until `start` is called: nothing here
 * downloads or applies an update on its own, and `start` (prepare) never
 * switches the tree — only `apply` does.
 *
 * @module dsh-enpoi-update-check/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { UpdateRunRecord } from './run.js'
import { RunRefusedError, type UpdateCancelOutcome, type UpdateRunController } from './run-service.js'
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
   * Start one prepare run (`dsh update --channel <c> --prepare`): pin the
   * available target, stage the update detached, and return the fresh run
   * record. The [Update now] click is the operator's consent to prepare; the
   * staged tree waits for an explicit `apply`.
   *
   * @returns the run record (phase `starting`, then `preparing`).
   * @throws RemoteError `gateway/bad-request` when no update is available, a
   *   run is active, an update is already prepared, the shim is missing, or
   *   the launch fails (including no resolvable Node.js runtime).
   */
  @Remote
  async start(): Promise<UpdateRunRecord> {
    try {
      return await this.runs.start()
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError('gateway/bad-request', error.message, {})
      }
      throw error
    }
  }

  /**
   * Apply the staged update (`dsh update --apply`): switch, service restart,
   * self-check, health, retention, then the staged marker is consumed. The
   * [Restart to update] click is the operator's restart decision.
   *
   * @returns the run record (phase `applying`).
   * @throws RemoteError `gateway/bad-request` when nothing is staged, a run is
   *   active, the shim is missing, or the launch fails.
   */
  @Remote
  apply(): UpdateRunRecord {
    try {
      return this.runs.apply()
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

  /**
   * Clear stale update state so a stuck failure can recover: refuses while a
   * run or the engine's lock is genuinely live, otherwise heals the persisted
   * record to a terminal state and drops the dead pid file. The engine marker
   * and the staged tree are never touched, so a valid staged update survives
   * for an immediate re-apply.
   *
   * @returns the run record after clearing, or null.
   * @throws RemoteError `gateway/bad-request` when something is genuinely live.
   */
  @Remote
  clearStale(): UpdateRunRecord | null {
    try {
      return this.runs.clearStale()
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError('gateway/bad-request', error.message, {})
      }
      throw error
    }
  }

  /**
   * Cancel the running update through the engine's own `dsh update --cancel`
   * (bounded; refuses once the run is past the switch; a no-op when nothing
   * runs). The engine owns the kill/cleanup semantics.
   *
   * @returns the engine's outcome and the resulting record.
   */
  @Remote
  async cancel(): Promise<UpdateCancelOutcome> {
    try {
      return await this.runs.cancel()
    } catch (error) {
      if (error instanceof RunRefusedError) {
        throw new RemoteError('gateway/bad-request', error.message, {})
      }
      throw error
    }
  }
}
