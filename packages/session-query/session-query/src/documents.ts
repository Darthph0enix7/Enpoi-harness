/** Shared event metadata and semantic-document projection. */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord, SessionEventSearchDocument, SessionEventSurface } from './types.ts'
import { SessionQueryError } from './config.ts'
import { extractSessionEventText } from './extraction.ts'

/**
 * Project a raw log into lightweight surface-aware event records.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns one record per event in ascending seq order.
 */
export function buildSessionEventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  const surfaceBySeq = classifySurface(events).surfaceBySeq
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: surfaceBySeq.get(event.seq) ?? 'log-only',
  }))
}

/**
 * Surface classification and searchable documents for one complete raw event log.
 * The classified surface state is the baseline an incremental provider folds
 * later appends onto without re-reading the whole log.
 */
export interface SessionEventSearchDocumentState {
  /** Searchable documents in ascending seq order; structural events are omitted. */
  readonly documents: SessionEventSearchDocument[]
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly SessionSeq[]
  /**
   * Event sequences shadowed by any committed replacement, in replacement
   * order. A later `revert/branch` that re-activates an event leaves it listed
   * here, matching the complete-fold classification.
   */
  readonly shadowed: readonly SessionSeq[]
}

/**
 * Build first-party semantic documents and the surface baseline for one complete raw event log.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns searchable documents plus the surface state that classifies them.
 */
export function buildSessionEventSearchDocumentState(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocumentState {
  const surface = classifySurface(events)
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: surface.surfaceBySeq.get(event.seq) ?? 'log-only',
      text,
    })
  }
  return { documents, nodes: surface.nodes, shadowed: surface.shadowed }
}

/**
 * Build first-party semantic documents for one complete raw event log.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns searchable documents in ascending seq order; structural events are omitted.
 */
export function buildSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  return buildSessionEventSearchDocumentState(sessionId, events).documents
}

interface ClassifiedSurface {
  readonly surfaceBySeq: Map<SessionSeq, SessionEventSurface>
  readonly nodes: readonly SessionSeq[]
  readonly shadowed: readonly SessionSeq[]
}

function classifySurface(events: readonly SessionEvent[]): ClassifiedSurface {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events, currentSessionMessageProjections)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const surfaceBySeq = new Map<SessionSeq, SessionEventSurface>()
  const shadowed: SessionSeq[] = []
  for (const seq of folded.nodes) surfaceBySeq.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) {
      surfaceBySeq.set(seq, 'shadowed')
      shadowed.push(seq)
    }
  }
  return { surfaceBySeq, nodes: folded.nodes, shadowed }
}
