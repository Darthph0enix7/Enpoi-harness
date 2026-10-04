/**
 * enpoi-diagnostics — the `diagnostics` Typert Remote namespace (doc 68 §L3).
 *
 * Endpoints (wire names): `diagnostics/report`, `diagnostics/list`,
 * `diagnostics/patterns`, `diagnostics/mute`, `diagnostics/systemHealth`.
 * The UI wiring is a later lane; this file owns the endpoint surface only and
 * delegates every validated payload to `api.ts` (decorator-free so the profile
 * vitest pipeline can test it).
 *
 * @module dsh-enpoi-diagnostics/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  listIncidentsFrom,
  listPatternsFrom,
  mutePattern,
  submitClientReport,
  systemHealthFrom,
  type ClientReportRequest,
  type ClientReportValue,
  type ListRequest,
  type ListValue,
  type MuteRequest,
  type MuteValue,
  type PatternsRequest,
  type PatternsValue,
  type SystemHealthValue,
} from './api.js'
import type { IncidentBus } from './capture.js'
import type { IncidentStore } from './store.js'

/** Cordis service key and Typert wire namespace. */
export const DIAGNOSTICS_NAMESPACE = 'diagnostics'

/** Service construction dependencies (passed as the plugin config object). */
export interface DiagnosticsServiceOptions {
  readonly store: IncidentStore
  readonly bus: IncidentBus
  readonly degradeWindowMs?: number
  readonly now?: () => number
}

/**
 * The `diagnostics` Remote service. Reads fold the store; `report` ingests one
 * client failure; `mute` toggles pattern notification suppression.
 */
export class DiagnosticsService extends TypertRemoteService {
  /** Nothing is injected into the service fiber; the plugin passes its deps. */
  static inject: string[] = []

  private readonly store: IncidentStore
  private readonly bus: IncidentBus
  private readonly degradeWindowMs: number
  private readonly now: () => number

  /**
   * @param ctx - owning context (service registration is automatic).
   * @param options - store, bus, and optional test seams.
   */
  constructor(ctx: Context, options: DiagnosticsServiceOptions) {
    super(ctx, DIAGNOSTICS_NAMESPACE)
    this.store = options.store
    this.bus = options.bus
    this.degradeWindowMs = options.degradeWindowMs ?? 0
    this.now = options.now ?? Date.now
  }

  /**
   * Ingest one client-observed failure (`window.onerror`, unhandled rejection,
   * failed RPC, UI invariant trip). Malformed input is rejected at the
   * boundary; a storage failure is swallowed so a reporter never has to care.
   *
   * @param request - client report payload.
   * @returns the stable fingerprint and code so the client can dedupe.
   * @throws RemoteError `gateway/bad-request` for malformed input.
   */
  @Remote
  report(request: ClientReportRequest): ClientReportValue {
    return submitClientReport(this.bus, request)
  }

  /**
   * Read the recent incident tail.
   *
   * @param request - limit/since/severity/source/kind/fingerprint filters.
   * @returns incidents newest first; empty on any store failure.
   */
  @Remote('list')
  list(request: ListRequest): ListValue {
    return listIncidentsFrom(this.store, request, this.now, this.bus)
  }

  /**
   * Read pattern rollups with a sliding-window count.
   *
   * @param request - window/limit/minCount/kind filters.
   * @returns patterns by most recent activity; empty on any store failure.
   */
  @Remote('patterns')
  patterns(request: PatternsRequest): PatternsValue {
    return listPatternsFrom(this.store, request, this.now, this.bus)
  }

  /**
   * Mute or unmute one pattern by fingerprint. Muting never drops data; it
   * only removes the pattern from the default report fold.
   *
   * @param request - fingerprint plus the desired state (default mute).
   * @returns the resulting state; unknown fingerprints report `ok: false`.
   * @throws RemoteError `gateway/bad-request` for malformed input.
   */
  @Remote
  mute(request: MuteRequest): MuteValue {
    return mutePattern(this.store, this.bus, request)
  }

  /**
   * Compact health projection: degraded subsystems, top patterns, and counters.
   *
   * @returns the health fold; `status: 'degraded'` when any subsystem is flagged.
   */
  @Remote('systemHealth')
  systemHealth(): SystemHealthValue {
    return systemHealthFrom(this.store, this.bus, {
      ...(this.degradeWindowMs === 0 ? {} : { degradeWindowMs: this.degradeWindowMs }),
      now: this.now,
    })
  }
}
