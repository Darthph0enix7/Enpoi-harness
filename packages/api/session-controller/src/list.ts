/** Cold-safe Session list and search projection. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SessionQueryError, type SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './types.ts'
import type {
  SessionListMetadata, SessionListRequest, SessionListValue, SessionProjectionHints,
  SessionProjectionValues, SessionSearchItem, SessionSearchValue, SessionSummary,
} from './types.ts'

const SEARCH_PROVIDER_CALL_LIMIT = 100
const SESSION_SEARCH_QUERY_MAX_CHARS = 500
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Per-Session projection keys excluded from list rows. A list page carries
 * every row's title and small routing facts; these values are per-Session
 * workspace payloads (context-lens timelines, generated-title input) whose
 * measured wire size dominated the cold list (tens of KB per Session). They
 * arrive with the Session's own history opening or control frames instead.
 */
const LIST_EXCLUDED_PROJECTION_KEYS: ReadonlySet<string> = new Set([
  'contextLens',
  'contextTimeline',
  'contextHeaders',
  'titleInput',
])

/** Largest accepted page size; a client may ask for any window up to the full catalog. */
const SESSION_LIST_PAGE_SIZE_MAX = 500

/** One catalog row before the page's wire values are materialized. */
interface ListOrderRow {
  readonly header: SessionHeader
  /** Attached Session when live; absent for persisted rows. */
  readonly session: Session | undefined
  readonly updatedAt: number
}

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

const imageLimitsSchema = z.object({
  maxImageBytes: z.number().int().positive(),
  maxImagesPerMessage: z.number().int().positive(),
  maxMessageImageBytes: z.number().int().positive(),
  maxImagePixels: z.number().int().positive(),
  maxImageDimension: z.number().int().positive(),
  mediaTypes: z.array(z.string()),
}) as unknown as z.ZodType<ImageAttachmentLimits>

/**
 * Advance the Session-list metadata projection by one committed event.
 * @param state - metadata before the event.
 * @param event - next committed Session event.
 * @returns the original or advanced metadata value.
 */
export function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Return the longest prefix containing at most `maximum` Unicode code points.
 * @param value - source text.
 * @param maximum - maximum number of Unicode code points.
 * @returns the source text or its longest allowed prefix.
 */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Owns list projection registration, bounded cold summaries, and authorized search. */
export class ApiSessionList {
  /**
   * @param ctx - Host context carrying Session, query, persistence, and projection services.
   * @param pageSize - default rows per list page, from the deployment's `listPageSize`.
   */
  constructor(
    private readonly ctx: Context,
    private readonly pageSize: number,
  ) {
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata',
      stateSchema: sessionListMetadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: applySessionListMetadata,
      wire: { viewSchema: sessionListMetadataSchema, view: state => state },
      stateVersion: 1,
    })
    ctx.inject(['attachments'], (attachmentCtx) => {
      ctx.sessionProjections.register<'imageLimits', null>({
        key: 'imageLimits',
        stateSchema: z.null(),
        init: () => null,
        apply: state => state,
        wire: {
          viewSchema: imageLimitsSchema,
          view: () => attachmentCtx.attachments.imageLimits,
        },
        stateVersion: 1,
      })
    })
  }

  /**
   * Build one current attached-Session summary.
   * @param session - attached Session to summarize.
   * @returns current list metadata and available projections.
   */
  summaryFor(session: Session): SessionSummary {
    const projections = this.projectionsFor(session.header, session)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: session.id,
      updatedAt: updatedAt(session.header, metadata),
      agentAvailable: this.ctx.agents.get(session.id)?.session === session,
      running: this.ctx.agents.get(session.id)?.status === 'running',
      blank: metadata?.blank ?? session.seq === 0,
      ...listFields(session.header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Read one newest-first window of visible attached and persisted Sessions
   * without activating an Agent. Heavy per-Session projections are excluded
   * from rows (see {@link LIST_EXCLUDED_PROJECTION_KEYS}); the cursor offsets
   * into the ordered catalog.
   * @param request - optional continuation cursor and page size.
   * @param signal - optional cancellation for persistence reads.
   * @returns the page's Session summaries plus a cursor when older rows remain.
   */
  async list(request: SessionListRequest, signal?: AbortSignal): Promise<SessionListValue> {
    const offset = listOffset(request.cursor)
    const limit = listLimit(request.limit, this.pageSize)
    signal?.throwIfAborted()
    const records = await this.ctx.sessionQuery.listSessions(signal)
    signal?.throwIfAborted()
    // Ordering reads only the list-metadata cut; full wire values are
    // materialized for the page's rows alone (validating every cached value of
    // every Session made cold listing CPU-bound, not wire-bound).
    const ordered: ListOrderRow[] = []
    for (const record of records) {
      const live = this.ctx.sessions.get(record.header.id)
      if (live !== undefined) {
        ordered.push({
          header: live.header,
          session: live,
          updatedAt: updatedAt(live.header, this.liveListMetadata(live)),
        })
        continue
      }
      if (record.header.cwd === undefined) continue
      ordered.push({
        header: record.header,
        session: undefined,
        updatedAt: updatedAt(record.header, this.coldListMetadata(record.header)),
      })
    }
    ordered.sort((left, right) => right.updatedAt - left.updatedAt)
    const window = ordered.slice(offset, offset + limit).map((row) => {
      const summary = row.session === undefined
        ? this.summarizeCold(row.header)
        : this.summaryFor(row.session)
      return listRow(summary)
    })
    const nextOffset = offset + window.length
    return {
      items: window,
      ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {}),
    }
  }

  /** List-metadata cut for one attached Session (ordering reads no other key). */
  private liveListMetadata(session: Session): SessionListMetadata | undefined {
    try {
      return this.ctx.sessionProjections
        .cachedSnapshot(session, ['sessionListMetadata'])
        ?.values.sessionListMetadata as SessionListMetadata | undefined
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: list metadata for "${session.id}" failed; ordering by creation time: ${String(error)}`,
      )
      return undefined
    }
  }

  /** List-metadata cut for one persisted Session (ordering reads no other key). */
  private coldListMetadata(header: SessionHeader): SessionListMetadata | undefined {
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      if (cache === undefined || header.isSeeded) return undefined
      const block = cache.cachedSnapshot(header, SessionLogOffset(0), ['sessionListMetadata'])
        ?? cache.cachedPredecessorTitle(header, SessionLogOffset(0))
      return block?.values.sessionListMetadata as SessionListMetadata | undefined
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: list metadata for "${header.id}" failed; ordering by creation time: ${String(error)}`,
      )
      return undefined
    }
  }

  private summarizeCold(header: SessionHeader): SessionSummary {
    const projections = this.projectionsFor(header, undefined)
    const metadata = projections?.values.sessionListMetadata
    return {
      sessionId: header.id,
      updatedAt: updatedAt(header, metadata),
      agentAvailable: false,
      running: false,
      // A large, metadata-less, or inaccessible cache miss remains unknown and visible.
      blank: metadata?.blank ?? false,
      ...listFields(header),
      ...(projections === undefined ? {} : { projections }),
    }
  }

  /**
   * Search current visible message content without activating any matching Session.
   * @param query - literal message-content query.
   * @param signal - cancellation for list and search reads.
   * @returns authorized bounded Session search results.
   */
  async search(query: string, signal: AbortSignal): Promise<SessionSearchValue> {
    const normalizedQuery = normalizeSearchQuery(query)
    signal.throwIfAborted()
    const provider = this.ctx.get('sessionQuery')
    if (provider === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
        {},
      )
    }
    try {
      const visible = await provider.listSessions(signal)
      signal.throwIfAborted()
      const visibleIds = new Set(visible
        .filter(record => record.header.cwd !== undefined)
        .map(record => record.header.id))
      if (visibleIds.size === 0) return { items: [], hasMore: false }
      const authorized: SessionSearchItem[] = []
      const acceptedIds = new Set<SessionId>()
      const seenCursors = new Set<SessionSearchCursor>()
      let cursor: SessionSearchCursor | undefined
      let providerCalls = 0
      let pageLimit = SESSION_SEARCH_RESULT_LIMIT
      while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
        signal.throwIfAborted()
        if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
          throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
        }
        providerCalls++
        const requestedCursor = cursor
        const requestedLimit = pageLimit
        let page
        try {
          page = await provider.searchSessions({
            query: normalizedQuery,
            eventFilters: [
              { kind: 'type', values: ['user/message', 'assistant/message'] },
              { kind: 'surface', values: ['current'] },
            ],
            limit: requestedLimit,
            ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
          }, { signal })
          signal.throwIfAborted()
        } catch (error: unknown) {
          signal.throwIfAborted()
          if (requestedCursor === undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_INVALID_LIMIT'
            && requestedLimit > 1) {
            pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
            continue
          }
          if (requestedCursor !== undefined
            && error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_STALE_CURSOR') {
            authorized.length = 0
            acceptedIds.clear()
            seenCursors.clear()
            cursor = undefined
            continue
          }
          throw error
        }
        if (page.items.length > requestedLimit) {
          throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
        }
        for (const hit of page.items) {
          if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
          if (!visibleIds.has(hit.header.id)
            || hit.bestMatch.sessionId !== hit.header.id
            || hit.bestMatch.surface !== 'current'
            || !MESSAGE_TYPES.has(hit.bestMatch.type)
            || acceptedIds.has(hit.header.id)) continue
          acceptedIds.add(hit.header.id)
          authorized.push({
            sessionId: hit.header.id,
            snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
          })
        }
        if (page.nextCursor !== undefined) {
          if (seenCursors.has(page.nextCursor)) {
            throw new Error('session search provider repeated a continuation cursor')
          }
          seenCursors.add(page.nextCursor)
        }
        if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
        cursor = page.nextCursor
      }
      return {
        items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
        hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
      }
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED') {
        throw new RemoteError('gateway/cancelled', 'session search was aborted', {})
      }
      throw new RemoteError('gateway/internal', `session search failed: ${String(error)}`, {})
    }
  }

  private projectionsFor(
    header: SessionHeader,
    session: Session | undefined,
  ): SessionProjectionHints | undefined {
    try {
      if (session !== undefined) {
        // The live registry computed the block for this Session: its watermark
        // shares the sequence space of the Session's baselines and frames.
        return hintsOf('sequenced', this.ctx.sessionProjections.cachedSnapshot(session))
      }
      // A cold row reads the persisted cache by header alone; the cache serves
      // seeded and unseeded lifecycles alike because a listing never seeds a
      // fold. The watermark is the stored record's own.
      const cache = this.ctx.get('sessionProjectionCache')
      return hintsOf('cached', cache?.cachedSnapshot(header) ?? cache?.cachedPredecessorTitle(header))
    } catch (error) {
      this.ctx.logger.warn(
        `api-session.list: projection column for "${header.id}" failed; serving the row without it: ${String(error)}`,
      )
      return undefined
    }
  }
}

/**
 * Wrap one projection block as Session-list hints of the named sequence space.
 * @param kind - which sequence space the block's watermark belongs to.
 * @param block - the block, or `undefined` when no source served one.
 * @returns the hints, or `undefined` when the block is absent or carries no value.
 */
function hintsOf(
  kind: SessionProjectionHints['kind'],
  block: ProjectionSnapshot | undefined,
): SessionProjectionHints | undefined {
  if (block === undefined || Object.keys(block.values).length === 0) return undefined
  // Listing hints contain every wire value the source currently holds but
  // remain partial: missing cells and cache rows are never materialized here.
  return { kind, asOfSeq: block.asOfSeq, values: block.values as SessionProjectionValues }
}

function normalizeSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new RemoteError('gateway/bad-request', 'session search query must not be empty', {})
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new RemoteError(
      'gateway/bad-request',
      `session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`,
      {},
    )
  }
  if (normalized.includes('\0')) {
    throw new RemoteError('gateway/bad-request', 'session search query must not contain NUL', {})
  }
  return normalized
}

function updatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

/**
 * Strip heavy per-Session projection values from one page row while preserving
 * every other field and the row's asOfSeq watermark.
 * @param summary - Host summary built for the full catalog.
 * @returns the row with {@link LIST_EXCLUDED_PROJECTION_KEYS} removed.
 */
function listRow(summary: SessionSummary): SessionSummary {
  const { projections, ...rest } = summary
  if (projections === undefined) return summary
  const values = Object.fromEntries(
    Object.entries(projections.values).filter(([key]) => !LIST_EXCLUDED_PROJECTION_KEYS.has(key)),
  ) as SessionProjectionValues
  return Object.keys(values).length === 0
    ? rest
    : { ...rest, projections: { asOfSeq: projections.asOfSeq, values } }
}

/**
 * Parse a list cursor into a catalog offset.
 * @param cursor - opaque cursor from a previous page; absent starts at zero.
 * @returns the non-negative offset.
 */
function listOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new RemoteError('gateway/bad-request', 'session list cursor must be a non-negative integer offset', {})
  }
  return Number(cursor)
}

/**
 * Resolve one page size against the deployment default and the wire bound.
 * @param limit - requested page size; absent uses the deployment default.
 * @param pageSize - deployment default.
 * @returns the accepted page size.
 */
function listLimit(limit: number | undefined, pageSize: number): number {
  if (limit === undefined) return pageSize
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_LIST_PAGE_SIZE_MAX) {
    throw new RemoteError(
      'gateway/bad-request',
      `session list limit must be an integer between 1 and ${String(SESSION_LIST_PAGE_SIZE_MAX)}`,
      {},
    )
  }
  return limit
}

function listFields(header: SessionHeader): {
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
} {
  return {
    ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  }
}
