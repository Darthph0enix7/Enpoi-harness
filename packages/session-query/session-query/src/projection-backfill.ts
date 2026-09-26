/**
 * Idempotent cold-read reindex of the persisted projection cache.
 *
 * The cache is a fold shortcut, never an authority: a checkpoint left behind a
 * session-format migration or a projection `stateVersion` bump is discarded at
 * read time, so every derived surface that reads rows without opening the
 * session (the session list's cached projection column, plugin dashboards)
 * goes blank until each session is opened once. This pass rebuilds those
 * checkpoints without opening anything: list the logical corpus, skip live
 * sessions (their own write path owns their checkpoints), skip rows that
 * already serve the requested keys, and fold every remaining stored log
 * through {@link SessionProjectionCache.reindex}.
 *
 * The pass is resumable because the skip test is the same data test the
 * consumers use: a re-run continues with whatever is still unserved, and a
 * completed re-run folds nothing. It never mutates the session log — only the
 * derived cache row.
 *
 * @module @deepseek-ai/dsh-session-query/projection-backfill
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { readColdSessionLog } from './cold-read.ts'

/** A projection key a backfill run checks before folding a session. */
export type ProjectionBackfillKey = Extract<keyof SessionProjectionMap, string>

/** What one examined session produced. */
export type ProjectionBackfillOutcome =
  | 'folded'
  | 'skipped-live'
  | 'skipped-served'
  | 'skipped-missing'
  | 'skipped-unsupported'
  | 'failed'

/** One examined session's outcome, emitted as the pass advances. */
export interface ProjectionBackfillProgress {
  /** Zero-based position among the examined sessions. */
  readonly index: number
  /** Number of sessions the run is examining. */
  readonly total: number
  /** The session just examined. */
  readonly sessionId: SessionId
  /** What the session produced. */
  readonly outcome: ProjectionBackfillOutcome
}

/** Options for {@link backfillProjectionCache}. */
export interface ProjectionBackfillOptions {
  /**
   * Exact sessions to rebuild. Absent lists and rebuilds the whole logical
   * corpus through `ctx.sessionQuery.listSessions`.
   */
  readonly sessionIds?: readonly SessionId[]
  /**
   * Wire keys a stored row must already serve for the session to be skipped.
   * Absent means a full reindex (every non-live session folds). Resumability
   * comes from this test: a later run refolds only what is still unserved.
   */
  readonly keys?: readonly ProjectionBackfillKey[]
  /** Milliseconds to yield between sessions so a large pass cannot starve the host. */
  readonly delayMs?: number
  /** Stop after this many sessions were folded; the next run resumes from the unserved remainder. */
  readonly limit?: number
  /** Cancellation checked between sessions; an abort returns the partial report. */
  readonly signal?: AbortSignal
  /** Per-session progress sink, called synchronously after each outcome. */
  readonly onProgress?: (progress: ProjectionBackfillProgress) => void
}

/** One session the pass could not rebuild, with the failure that kept it unserved. */
export interface ProjectionBackfillFailure {
  /** The session left unserved. */
  readonly sessionId: SessionId
  /** The failure's printable reason (error name and message). */
  readonly reason: string
}

/** What one backfill pass did. */
export interface ProjectionBackfillReport {
  /** Sessions the run examined (the requested ids, or the listed corpus). */
  readonly total: number
  /** Sessions whose checkpoint was rebuilt and durably written. */
  readonly folded: number
  /** Attached sessions skipped: the live write path owns their checkpoints. */
  readonly skippedLive: number
  /** Sessions whose stored rows already serve every requested key. */
  readonly skippedServed: number
  /** Requested sessions that no longer exist in persistence. */
  readonly skippedMissing: number
  /** Sessions whose log the running harness refuses to interpret (not migratable). */
  readonly skippedUnsupported: number
  /** Sessions whose read or write failed; the pass continued past them. */
  readonly failed: number
  /** One entry per failed session: the honest reason it stays blank. */
  readonly failures: readonly ProjectionBackfillFailure[]
  /** Whether the pass stopped early on `limit` or cancellation. */
  readonly stoppedEarly: boolean
}

/**
 * One caught value's printable reason for the failure ledger: the error name
 * and message, or the stringified value for a non-Error rejection.
 * @param error - the caught value.
 * @returns a single-line reason.
 */
function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const message = error.message.replaceAll('\n', ' ')
  return message.length === 0 ? error.name : `${error.name}: ${message}`
}

/**
 * Refuse the one error family the pass must classify rather than count as a
 * failure: the persistence seam translates every "intact yet not
 * interpretable" refusal into a `SessionFormatUnsupported*` name.
 * @param error - the caught value.
 * @returns whether the running harness permanently refuses this log.
 */
function isUnsupportedFormat(error: unknown): boolean {
  return error instanceof Error && error.name.startsWith('SessionFormatUnsupported')
}

/**
 * Rebuild the persisted projection cache for existing sessions without
 * opening them. Idempotent (an already-served session is skipped), resumable
 * (a re-run folds only the unserved remainder), and safe beside a live host
 * (attached sessions are never touched).
 * @param ctx - host context carrying the query, persistence, session, and projection-cache services.
 * @param options - session selection, served-key test, pacing, and progress sink.
 * @returns the pass's counts plus one failure entry per unserved session.
 * @throws when the persistence or projection-cache service is not mounted, or on invalid options.
 */
export async function backfillProjectionCache(
  ctx: Context,
  options: ProjectionBackfillOptions = {},
): Promise<ProjectionBackfillReport> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('session-query: projection backfill requires the sessionQuery service')
  }
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) {
    throw new Error('session-query: projection backfill requires the sessionProjectionCache service')
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    throw new Error('session-query: projection backfill requires the sessionPersistence service')
  }
  const sessions = ctx.get('sessions')
  const delayMs = options.delayMs ?? 0
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error('session-query: projection backfill delayMs must be a non-negative number')
  }
  const limit = options.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('session-query: projection backfill limit must be a positive integer')
  }

  const headers: SessionHeader[] = []
  let skippedMissing = 0
  if (options.sessionIds === undefined) {
    for (const record of await query.listSessions(options.signal)) headers.push(record.header)
  } else {
    for (const id of options.sessionIds) {
      const snapshot = await persistence.stat(id, options.signal === undefined ? undefined : { signal: options.signal })
      if (snapshot === undefined) skippedMissing += 1
      else headers.push(snapshot.header)
    }
  }

  let folded = 0
  let skippedLive = 0
  let skippedServed = 0
  let skippedUnsupported = 0
  let failed = 0
  const failures: ProjectionBackfillFailure[] = []
  let stoppedEarly = false
  let examined = 0
  for (const header of headers) {
    if (options.signal?.aborted === true) {
      stoppedEarly = true
      break
    }
    const id = header.id
    const report = (outcome: ProjectionBackfillOutcome): void => {
      options.onProgress?.({ index: examined, total: headers.length, sessionId: id, outcome })
      examined += 1
    }
    if (sessions?.get(id) !== undefined) {
      skippedLive += 1
      report('skipped-live')
      continue
    }
    if (options.keys !== undefined && options.keys.length > 0
      && servesKeys(cache, header, options.keys)) {
      skippedServed += 1
      report('skipped-served')
      continue
    }
    if (limit !== undefined && folded >= limit) {
      stoppedEarly = true
      break
    }
    try {
      const log = await readColdSessionLog(persistence, id, options.signal)
      await cache.reindex(log.header, log.inheritedEventCount, log.events)
      folded += 1
      report('folded')
    } catch (error: unknown) {
      if (isUnsupportedFormat(error)) {
        skippedUnsupported += 1
        report('skipped-unsupported')
      } else {
        failed += 1
        failures.push({ sessionId: id, reason: failureReason(error) })
        ctx.logger.warn(`session-query: projection backfill failed for "${id}": ${String(error)}`)
        report('failed')
      }
    }
    if (delayMs > 0) await new Promise(resolve => { setTimeout(resolve, delayMs) })
  }

  return {
    total: headers.length,
    folded,
    skippedLive,
    skippedServed,
    skippedMissing,
    skippedUnsupported,
    failed,
    failures,
    stoppedEarly,
  }
}

/**
 * Whether the stored checkpoint already serves every requested wire key.
 * A throwing or mismatched read counts as unserved, so the session refolds —
 * the same permissive fallback the cache's own read ladder uses.
 * @param cache - the projection-cache service.
 * @param header - the listed or stored session header (identity witness).
 * @param keys - requested wire keys.
 * @returns whether every requested key is served.
 */
function servesKeys(
  cache: SessionProjectionCache,
  header: SessionHeader,
  keys: readonly ProjectionBackfillKey[],
): boolean {
  try {
    const block = cache.cachedSnapshot(header, keys)
    return block !== undefined && keys.every(key => block.values[key] !== undefined)
  } catch {
    return false
  }
}
