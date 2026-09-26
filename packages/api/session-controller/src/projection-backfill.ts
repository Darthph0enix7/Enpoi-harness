/**
 * Authenticated POST /api/session-projections/backfill — runs the persisted
 * projection-cache reindex inside the live host.
 *
 * The route exists so an operator (or the `dsh-projections-backfill` CLI) can
 * repair derived per-session rows after a session-format migration, a
 * projection `stateVersion` bump, or a restore from an older cache, without
 * opening each session. The connection service authenticates the request
 * before this handler; the host services supply listing, reading, and the
 * fold. Each call is bounded by its `limit`, so a client loops with
 * `limit` pages and the pass resumes from whatever is still unserved.
 * @module @deepseek-ai/dsh-api-session-controller/projection-backfill
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { backfillProjectionCache } from '@deepseek-ai/dsh-session-query'
import type { ProjectionBackfillKey, ProjectionBackfillOptions } from '@deepseek-ai/dsh-session-query'

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

/**
 * Parse one JSON request body into backfill options, rejecting foreign shapes
 * at the wire boundary.
 * @param request - the buffered route request.
 * @returns parsed options, or the refusal message.
 */
async function parseOptions(request: Request): Promise<{ options: ProjectionBackfillOptions } | { error: string }> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { error: 'request body must be JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'request body must be a JSON object' }
  }
  const record = body as Readonly<Record<string, unknown>>
  const { keys, delayMs, limit } = record
  if (keys !== undefined
    && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || key.length === 0))) {
    return { error: 'keys must be an array of non-empty projection key strings' }
  }
  if (delayMs !== undefined
    && (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0)) {
    return { error: 'delayMs must be a non-negative number' }
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    return { error: 'limit must be a positive integer' }
  }
  return {
    options: {
      ...(keys === undefined ? {} : { keys: keys as readonly ProjectionBackfillKey[] }),
      ...(delayMs === undefined ? {} : { delayMs }),
      ...(limit === undefined ? {} : { limit }),
    },
  }
}

/**
 * Projection-cache backfill contribution. The connection service supplies
 * authentication; the query, persistence, session, and cache services supply
 * the corpus read and the durable fold.
 */
export const SessionProjectionBackfill = {
  inject: ['connection', 'sessionQuery', 'sessionPersistence', 'sessions', 'sessionProjectionCache'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/session-projections/backfill',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const parsed = await parseOptions(request)
        if ('error' in parsed) {
          return Response.json({ ok: false, error: parsed.error }, { status: 400, headers: NO_STORE })
        }
        const report = await backfillProjectionCache(ctx, { ...parsed.options, signal: request.signal })
        return Response.json({ ok: true, report }, { headers: NO_STORE })
      },
    }), 'session-controller: /api/session-projections/backfill')
  },
}
