/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
} from '../types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from './sessions/history-records.ts'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import { assertSessionWireEvent } from './session-wire-event.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
  readonly projections?: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
  /**
   * Present when this opening continues the Client-held window. `records`
   * then carries the combined window for journal continuity, while
   * `resumeRecords` carries the durable suffix the Session appends.
   */
  readonly resumedFromSeq?: number
  readonly resumeRecords?: readonly SessionHistoryRecord[]
}

/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
    readonly type: 'replace' | 'prepend'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
    readonly hasMore: boolean
  }
  | {
    readonly type: 'resume'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionEventLikeEntry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  switch (change.type) {
    case 'replace':
      if (change.page.resumedFromSeq !== undefined && change.page.resumeRecords !== undefined) {
        return {
          type: 'resume',
          page: change.page,
          entries: historyEntries(change.page.resumeRecords),
          hasMore: change.hasMore,
        }
      }
      return { ...change, entries: historyEntries(change.entries) }
    case 'prepend':
      return { ...change, entries: historyEntries(change.entries) }
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

/** Brand one dense cursor, preserving the empty-log cursor -1. */
function followCursor(value: number): SessionSeqCursor {
  return value === -1 ? -1 : SessionSeq(value)
}

/**
 * Validate one resumed opening against the Client-held tail.
 * @param frame - Host snapshot claiming to continue the window.
 * @param expected - inclusive tail the Client already holds.
 * @returns whether the suffix starts after `expected`, stays contiguous, and ends at `cursor`.
 */
function resumeMatches(
  frame: Extract<SessionFollowFrame, { type: 'snapshot' }>,
  expected: number,
): boolean {
  if (frame.resumedFromSeq !== expected) return false
  if (frame.records.length === 0) return frame.cursor === expected
  let seq = expected + 1
  for (const record of frame.records) {
    if (record.event.seq !== seq) return false
    seq += 1
  }
  return frame.cursor === seq - 1
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  /**
   * Current durable Client window. Present, a reconnect requests the dense
   * suffix after its tail and a resumed opening appends to it; absent, every
   * opening stays a full replacement.
   */
  readonly window?: () => { readonly records: readonly SessionHistoryRecord[]; readonly hasMore: boolean }
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/**
 * A full Host snapshot behind the retained Client window. The Session replaces
 * the retained window through a fresh follow stream instead of surfacing a
 * protocol failure.
 */
export class SessionSnapshotBehindError extends Error {
  /**
   * @param cursor - inclusive tail seq carried by the rejected full snapshot.
   * @param heldCursor - inclusive tail seq the Client window already holds.
   */
  constructor(readonly cursor: number, readonly heldCursor: number) {
    super(`session snapshot at ${String(cursor)} is behind the client cursor ${String(heldCursor)}`)
    this.name = 'SessionSnapshotBehindError'
  }
}

/**
 * Test whether a terminal stream failure is {@link SessionSnapshotBehindError}
 * wrapped by the carrier's marked Remote failure.
 * @param error - a caught stream failure.
 * @returns whether the Session must reopen for a full replacement window.
 */
export function isSessionSnapshotBehindError(error: unknown): boolean {
  return error instanceof Error && error.cause instanceof SessionSnapshotBehindError
}

/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  /** Opening cursor of this stream's accepted generation, including an empty window. */
  private openedCursor: number | undefined
  /** Whether this stream already accepted an opening; a fresh stream never resumes. */
  private acceptedOpening = false
  /** One-shot fallback: the next generation asks for a full snapshot. */
  private suppressResume = false

  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    private readonly journalOptions: SessionEventStreamOptions,
  ) {
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { journalOptions.publish(toSessionJournalChange(change)) },
      ...(journalOptions.carrierFailed === undefined
        ? {}
        : { carrierFailed: journalOptions.carrierFailed }),
      failed: journalOptions.failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    let afterSeq = this.resumeAfterSeq()
    // A malformed resumed opening is rejected inside this generation: the
    // suffix stream is closed and one ordinary full-snapshot opening replaces
    // it, so the Client never receives a terminal protocol failure and the
    // Gateway retry budget is not consumed by a correctable answer.
    for (;;) {
      let assistantRevision: number | undefined
      let rejected = false
      for await (const frame of this.remote.session.follow({
        address: this.address,
        assistantStream: true,
        ...this.repairRequest(request),
        ...(afterSeq === undefined ? {} : { afterSeq: followCursor(afterSeq) }),
      }, signal)) {
        if (frame.type === 'snapshot') {
          for (const record of frame.records) assertSessionWireEvent(record.event)
          if (frame.assistantStream === undefined) {
            throw new RemoteError(
              'gateway/internal',
              'session assistant stream omitted its opted-in opening baseline',
              {},
            )
          }
          assistantRevision = frame.assistantStream.revision
          if (frame.resumedFromSeq !== undefined) {
            const window = this.journalOptions.window
            const expected = this.clientTail()
            if (window === undefined || expected === undefined || !resumeMatches(frame, expected)) {
              this.suppressResume = true
              rejected = true
              break
            }
            const current = window()
            this.openedCursor = frame.cursor
            this.acceptedOpening = true
            this.suppressResume = false
            yield {
              type: 'opened',
              cursor: frame.cursor,
              page: {
                records: [...current.records, ...frame.records],
                hasMore: current.hasMore,
                revert: frame.revert,
                projections: frame.projections,
                assistantStream: frame.assistantStream,
                resumedFromSeq: frame.resumedFromSeq,
                resumeRecords: frame.records,
              },
            }
            continue
          }
          if (this.acceptedOpening) {
            const held = this.clientTail()
            if (held !== undefined && frame.cursor < held) {
              throw new SessionSnapshotBehindError(frame.cursor, held)
            }
          }
          this.openedCursor = frame.cursor
          this.acceptedOpening = true
          this.suppressResume = false
          yield {
            type: 'opened',
            cursor: frame.cursor,
            page: {
              records: frame.records,
              hasMore: frame.hasMore,
              revert: frame.revert,
              projections: frame.projections,
              assistantStream: frame.assistantStream,
            },
          }
          continue
        }
        if (frame.type === 'assistant-stream') {
          const expected = (assistantRevision ?? 0) + 1
          if (frame.frame.revision !== expected) {
            throw new RemoteStreamCarrierError(
              `session assistant stream skipped revision ${String(expected)}`,
            )
          }
          assistantRevision = frame.frame.revision
          yield { type: 'notification', notification: frame.frame }
          continue
        }
        assertSessionWireEvent(frame.event)
        yield { type: 'entry', entry: frame }
      }
      if (!rejected) return
      afterSeq = this.resumeAfterSeq()
    }
  }

  /** Cursor one reconnect should resume after, or undefined for a full snapshot. */
  private resumeAfterSeq(): number | undefined {
    if (!this.acceptedOpening || this.suppressResume || this.journalOptions.window === undefined) return undefined
    return this.clientTail()
  }

  /** Inclusive tail the retained durable window already holds. */
  private clientTail(): number | undefined {
    const window = this.journalOptions.window?.()
    return window === undefined ? undefined : window.records.at(-1)?.event.seq ?? this.openedCursor
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request },
      signal,
    )
    if (!result.ok) throw result.error
    for (const record of result.value.records) assertSessionWireEvent(record.event)
    return result.value
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    }
  }
}
