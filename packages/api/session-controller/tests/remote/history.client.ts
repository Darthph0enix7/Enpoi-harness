/** Pure history response builders for assembled Session tests. */
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import type {
  SessionAssistantStreamBaseline, SessionFollowFrame, SessionFollowRequest, SessionPage, SessionProjectionBaseline,
  SessionRevertFold,
} from '../../src/types.ts'
import { historyRecordLastSeq } from '../../src/client/sessions/history-records.ts'
import { foldRevertEvents, revertFoldValue } from '../../src/revert-fold.ts'

/** Empty durable revert block for a log with no revert events. */
export function emptyRevertFold(asOfSeq = -1): SessionRevertFold {
  return { fromSeq: null, shadowRanges: [], conflicts: [], outcomes: {}, asOfSeq }
}

/**
 * Fold one scripted full log exactly as the Host does, so a page can be cut
 * independently of what the fold itself must see.
 * @param events - complete scripted log in seq order.
 * @param asOfSeq - inclusive fold cut; defaults to the last event.
 * @returns the durable revert block.
 */
export function hostRevertFold(
  events: readonly { readonly type: string; readonly seq: number; readonly data?: unknown; readonly surfaceOp?: unknown }[],
  asOfSeq = events.length - 1,
): SessionRevertFold {
  return revertFoldValue(foldRevertEvents(events, asOfSeq), asOfSeq)
}

/**
 * Cut a history page at the Host cursor, preserving its other fields.
 * @param page - scripted history page.
 * @param throughSeq - inclusive final sequence.
 * @returns the page without records beyond the cursor.
 */
export function pageThrough(page: SessionPage, throughSeq: number): SessionPage {
  return { ...page, records: page.records.filter(record => historyRecordLastSeq(record) <= throughSeq) }
}

/**
 * Build the opening follow frame for a Session or addressed child.
 * @param page - history and optional projection baseline.
 * @param request - addressed follow request.
 * @param cursor - opening cursor; defaults to the history tail, or -1 when empty.
 * @param assistantStream - baseline included only when the request opts in.
 * @returns the opening frame.
 */
export function followSnapshot(
  page: SessionPage & { readonly projections?: SessionProjectionBaseline },
  request: SessionFollowRequest,
  cursor = page.records.length === 0 ? -1 : historyRecordLastSeq(page.records.at(-1)!),
  assistantStream: SessionAssistantStreamBaseline = { revision: 0 },
): Extract<SessionFollowFrame, { type: 'snapshot' }> {
  const { address } = request
  return {
    type: 'snapshot',
    header: {
      version: SESSION_FORMAT_VERSION,
      id: address.kind === 'session' ? address.sessionId : address.childSessionId,
      createdAt: 0,
      isSeeded: false,
      ...(address.kind === 'subagent' ? { origin: 'subagent', parentSession: address.parentSessionId } : {}),
    },
    cursor,
    records: pageThrough(page, cursor).records,
    hasMore: page.hasMore,
    revert: page.revert,
    projections: page.projections ?? { asOfSeq: cursor, values: {} },
    ...(request.assistantStream === true ? { assistantStream } : {}),
  }
}
