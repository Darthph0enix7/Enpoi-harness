/** Cold Session history pagination and live-event source. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAddress,
  SessionAssistantStreamFrame,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionRevertFold,
  SessionWireHeader,
  SessionWireEvent,
} from './types.ts'
import { SessionAssistantStreamAccumulator } from './assistant-stream.ts'
import {
  emptyRevertFoldState,
  foldRevertEvent,
  revertFoldValue,
  type RevertFoldState,
} from './revert-fold.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
/** Bound on cached per-Session revert folds (cold readers never notify disposal). */
const REVERT_FOLD_CACHE_MAX = 32
/** Durable events one suffix read materializes while a slow consumer drains. */
const REPLAY_BATCH_EVENTS = 256
/** Retained reference, wrapper, and queue-slot overhead one buffered item adds. */
const BACKLOG_ITEM_OVERHEAD = 128

/**
 * Per-follow cap on live items retained while the Client is not pulling.
 * Events appended before listener installation replay from the log and never
 * consume this budget.
 */
export interface SessionFollowBufferLimits {
  /** Maximum retained live items before the follow ends for a clean resync. */
  readonly maxItems: number
  /** Maximum estimated retained bytes before the follow ends for a clean resync. */
  readonly maxBytes: number
}

/** Default residual live-item cap: 16384 items or 8 MiB, whichever comes first. */
export const DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS: SessionFollowBufferLimits = Object.freeze({
  maxItems: 16384,
  maxBytes: 8 * 1024 * 1024,
})

/** Default dense-event bound on one resumed follow opening. */
export const DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS = 2048

/**
 * Cursor-resume policy for follow openings. A resumed opening reads the dense
 * suffix from the durable log, so disabled or oversized resumes fall back to
 * the ordinary message-aligned snapshot.
 */
export interface SessionFollowResumeOptions {
  /** Whether a Client-held cursor may be answered with a suffix instead of a full snapshot. */
  readonly enabled: boolean
  /** Maximum dense durable events one resumed opening may carry. */
  readonly maxEvents: number
}

/** Enabled resume bounded by {@link DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS}. */
export const DEFAULT_SESSION_FOLLOW_RESUME_OPTIONS: SessionFollowResumeOptions = Object.freeze({
  enabled: true,
  maxEvents: DEFAULT_SESSION_FOLLOW_RESUME_MAX_EVENTS,
})

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()
  private readonly assistantStreams = new Map<SessionId, SessionAssistantStreamAccumulator>()
  private readonly backlogs = new Set<FollowBacklog>()
  private readonly limits: SessionFollowBufferLimits
  private readonly resume: SessionFollowResumeOptions
  /**
   * Incremental per-Session revert folds. Each entry covers every event
   * through `throughSeq`; later requests fold only the appended suffix.
   */
  private readonly revertFolds = new Map<SessionId, { throughSeq: number; state: RevertFoldState }>()

  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   * @param limits - residual live-frame cap for one follow generation.
   * @param resume - cursor-resume policy for follow openings.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
    limits: SessionFollowBufferLimits = DEFAULT_SESSION_FOLLOW_BUFFER_LIMITS,
    resume: SessionFollowResumeOptions = DEFAULT_SESSION_FOLLOW_RESUME_OPTIONS,
  ) {
    this.limits = validateFollowBufferLimits(limits)
    this.resume = validateFollowResumeOptions(resume)
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let stream = this.assistantStreams.get(agent.session.id)
      if (stream === undefined) {
        stream = new SessionAssistantStreamAccumulator()
        this.assistantStreams.set(agent.session.id, stream)
      }
      stream.accept(frame, cursorBeforeNext(agent.session.seq))
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.assistantStreams.delete(agent.session.id)
      this.revertFolds.delete(agent.session.id)
    }, { global: true })
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const throughSeq: SessionSeqCursor = request.throughSeq === -1
      ? -1
      : SessionSeq(request.throughSeq)
    const beforeSeq = request.beforeSeq === undefined
      ? undefined
      : SessionLogOffset(request.beforeSeq)
    using source = await this.sourceFor(request.address, signal, false)
    signal.throwIfAborted()
    const sourceLog = source.events
    const sourceCursor: SessionSeqCursor = sourceLog.at(-1)?.seq ?? -1
    if (throughSeq > sourceCursor) {
      throw new RemoteError(
        'gateway/bad-request',
        `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
    if (throughSeq >= 0 && sourceLog[throughSeq]?.seq !== throughSeq) {
      throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(throughSeq)}`, {})
    }
    const page = paginate(
      sourceLog,
      beforeSeq,
      request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      throughSeq,
      request.turnWindow,
    )
    const records = pageRecords(page.events)
    return {
      records,
      hasMore: page.hasMore,
      revert: this.revertFoldAt(addressId(request.address), sourceLog, throughSeq),
    }
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free durable events and opted-in assistant frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateHistoryWindow(request)
    validateFollowAfterSeq(request.afterSeq)
    const { address } = request
    const target = addressId(address)
    const backlog = new FollowBacklog(this.limits)
    this.backlogs.add(backlog)
    let assistantStreamOrdinal = 0
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    let disposeEvent: (() => void) | undefined
    let disposeCreated: (() => void) | undefined
    const disposeAssistantStream = request.assistantStream !== true
      ? undefined
      : this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== target) return
        // Frames are transient and cannot be replayed from the log, so they
        // are the only live items retained while the opening snapshot is in
        // flight. Their durable watermark merges them back into event order.
        const durableCursor = cursorBeforeNext(agent.session.seq)
        backlog.pushFrame({
          frame: wireAssistantStreamFrame(frame, durableCursor),
          cursor: durableCursor,
          ordinal: ++assistantStreamOrdinal,
        })
        notify()
      }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      using source = await this.sourceFor(address, signal, true)
      const events = source.events
      signal.throwIfAborted()
      const cursor = source.cursor
      const resumedFromSeq = this.resumeFrom(request, events, cursor)
      let records: SessionHistoryRecord[]
      let hasMore: boolean
      if (resumedFromSeq === undefined) {
        const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES, cursor, request.turnWindow)
        records = pageRecords(page.events)
        hasMore = page.hasMore
      } else {
        records = pageRecords(events.slice(resumedFromSeq + 1))
        hasMore = false
      }
      const assistantStream = request.assistantStream === true
        ? this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 }
        : undefined
      // The accumulator snapshot and this watermark are synchronous. Frames
      // through the cut are represented or superseded by that baseline,
      // including larger revisions from a retired Agent; later revision
      // resets reach Client continuity validation.
      const assistantStreamOrdinalCut = assistantStreamOrdinal
      if (request.assistantStream === true) {
        // The baseline supersedes every frame at or before the cut, including
        // one that overflowed before this cut existed, so discard them and
        // start the post-cut budget clean.
        backlog.prune(assistantStreamOrdinalCut)
        backlog.resetOverflow()
      }
      yield {
        type: 'snapshot',
        header: wireHeader(source.header),
        cursor,
        records,
        hasMore,
        revert: this.revertFoldAt(target, events, cursor),
        projections: source.projections === undefined
          ? { asOfSeq: cursor, values: {} }
          : projectionBlock(source.projections),
        ...assistantStream === undefined ? {} : { assistantStream },
        ...resumedFromSeq === undefined ? {} : { resumedFromSeq },
      }
      // Frames emitted while the Client received the snapshot were dropped
      // once the cap was reached. End this generation; the Client treats an
      // accepted generation that ends as a retryable carrier loss and opens a
      // fresh snapshot instead of the follow silently skipping frames.
      if (backlog.hasOverflowed()) {
        this.warnBacklogOverflow(target)
        return
      }
      // Register durable listeners BEFORE capturing the replay cut, then read
      // everything between the snapshot cursor and that cut from the log. The
      // listener and the cut are captured in the same synchronous turn, so
      // every earlier event is in the replay and every later event is queued:
      // the snapshot-to-live boundary can neither lose nor duplicate a seq.
      let durableSession = this.ctx.sessions.get(target)
      let replayEnd = durableSession?.seq ?? SessionLogOffset(cursor + 1)
      disposeEvent = this.ctx.on('session/event', (session, event) => {
        if (session.id !== target) return
        backlog.pushEvent(event)
        notify()
      }, { global: true })
      disposeCreated = this.ctx.on('session/created', (session) => {
        if (session.id !== target) return
        // Constructor seed events have no session/event notification. Extend
        // the log replay to the new end instead of retaining the seed suffix.
        durableSession = session
        replayEnd = SessionLogOffset(Math.max(replayEnd, session.seq))
        notify()
      }, { global: true })
      if (address.kind === 'session' && source.source === 'prepared') {
        const promotion = source.retain()
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      }
      let nextOffset = SessionLogOffset(cursor + 1)
      let replayBatch: readonly SessionEvent[] = []
      let replayIndex = 0
      let heldFrame: BufferedAssistantFrame | undefined
      while (!follower.closed && !signal.aborted) {
        if (backlog.hasOverflowed()) {
          this.warnBacklogOverflow(target)
          return
        }
        const frame = heldFrame ?? backlog.popFrame()
        heldFrame = undefined
        if (frame !== undefined) {
          if (frame.ordinal <= assistantStreamOrdinalCut) continue
          if (frame.cursor < nextOffset) {
            yield { type: 'assistant-stream', frame: frame.frame }
            continue
          }
          // The frame was emitted after a durable event this follow has not
          // delivered yet; hold it until that event advances nextOffset.
          heldFrame = frame
        }
        if (replayIndex >= replayBatch.length && nextOffset < replayEnd) {
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          const batch = durableSession?.snapshotEvents(
            nextOffset,
            SessionLogOffset(Math.min(nextOffset + REPLAY_BATCH_EVENTS, replayEnd)),
          ) ?? []
          if (batch.length === 0) {
            throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(nextOffset)}`, {})
          }
          replayBatch = batch
          replayIndex = 0
        }
        if (replayIndex < replayBatch.length) {
          const event = replayBatch[replayIndex] as SessionEvent
          replayIndex += 1
          const expectedSeq = SessionSeq(nextOffset)
          if (event.seq !== expectedSeq) {
            throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
          }
          nextOffset = SessionLogOffset(nextOffset + 1)
          yield entryFor(event)
          continue
        }
        const live = backlog.popEvent()
        if (live !== undefined) {
          const expectedSeq = SessionSeq(nextOffset)
          if (live.seq < expectedSeq) continue
          if (live.seq !== expectedSeq) {
            throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
          }
          nextOffset = SessionLogOffset(nextOffset + 1)
          yield entryFor(live)
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated?.()
      disposeEvent?.()
      disposeAssistantStream?.()
      this.backlogs.delete(backlog)
      backlog.clear()
    }
  }

  /**
   * Decide whether one opening may continue the Client's dense window.
   * Absent or disabled cursors, a cursor beyond the observed tail, a broken
   * dense index, and an oversized suffix all select the full snapshot.
   * @param request - follow request carrying the Client-held cursor.
   * @param events - dense zero-based logical events of the observed log.
   * @param tail - inclusive final seq of the observation.
   * @returns the echoed resume cursor, or undefined for a full snapshot.
   */
  private resumeFrom(
    request: SessionFollowRequest,
    events: readonly SessionEvent[],
    tail: SessionSeqCursor,
  ): SessionSeqCursor | undefined {
    const { afterSeq } = request
    if (!this.resume.enabled || afterSeq === undefined) return undefined
    if (afterSeq > tail) return undefined
    if (afterSeq >= 0 && events[afterSeq]?.seq !== afterSeq) return undefined
    if (tail - afterSeq > this.resume.maxEvents) return undefined
    return afterSeq
  }

  /**
   * Report the residual live backlog across active follows. Events appended
   * before listener installation replay from the log and are never retained.
   * @returns aggregate retained items and estimated bytes.
   */
  followBacklog(): { readonly items: number; readonly bytes: number } {
    let items = 0
    let bytes = 0
    for (const backlog of this.backlogs) {
      items += backlog.items
      bytes += backlog.bytes
    }
    return { items, bytes }
  }

  private warnBacklogOverflow(sessionId: SessionId): void {
    this.ctx.logger.warn(
      'session-controller: ending follow for "%s" after its live Assistant backlog exceeded the %d-item or %d-byte cap',
      sessionId,
      this.limits.maxItems,
      this.limits.maxBytes,
    )
  }

  /**
   * Fold the durable revert state through one journal cut.
   *
   * The fold is maintained per Session and only ever extended forward, so a
   * page read folds the appended suffix rather than the whole log. A request
   * behind the cached cut (never produced by the forward-only journal cursor,
   * but possible after a log repair) rebuilds from the log prefix.
   * @param sessionId - durable Session identity owning the log.
   * @param events - dense zero-based log events.
   * @param throughSeq - inclusive final seq the fold must cover.
   * @returns the durable fold block carried by the page.
   */
  private revertFoldAt(
    sessionId: SessionId,
    events: readonly SessionEvent[],
    throughSeq: SessionSeqCursor,
  ): SessionRevertFold {
    let cached = this.revertFolds.get(sessionId)
    if (cached === undefined || cached.throughSeq > throughSeq) {
      cached = { throughSeq: -1, state: emptyRevertFoldState() }
    }
    for (let seq = cached.throughSeq + 1; seq <= throughSeq; seq++) {
      const event = events[seq]
      /* v8 ignore next -- dense zero-based logs guarantee an event at every seq through the cursor. */
      if (event === undefined) break
      foldRevertEvent(cached.state, event)
    }
    cached.throughSeq = throughSeq
    // LRU touch: reinsert so the oldest untouched Session is evicted first.
    this.revertFolds.delete(sessionId)
    this.revertFolds.set(sessionId, cached)
    while (this.revertFolds.size > REVERT_FOLD_CACHE_MAX) {
      const oldest = this.revertFolds.keys().next().value as SessionId
      this.revertFolds.delete(oldest)
    }
    return revertFoldValue(cached.state, throughSeq)
  }

  private async sourceFor(
    address: SessionAddress,
    signal: AbortSignal,
    withProjections: boolean,
  ): Promise<SessionObservation> {
    const sessionId = addressId(address)
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal,
        projectionMode: withProjections || address.kind === 'subagent' ? 'all' : 'none',
      })
      if (observation.header.cwd === undefined) {
        observation[Symbol.dispose]()
        rejectNotFound(address)
      }
      try {
        validateAddress(
          address,
          observation.header,
          observation.inheritedEventCount,
          observation.projections,
        )
      } catch (error: unknown) {
        observation[Symbol.dispose]()
        throw error
      }
      return observation
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') rejectNotFound(address)
      throw error
    }
  }

}

/** One transient Assistant frame retained while its opening snapshot is in flight. */
interface BufferedAssistantFrame {
  readonly frame: SessionAssistantStreamFrame
  readonly ordinal: number
  /** Last durable Session seq observed when the frame was emitted. */
  readonly cursor: SessionSeqCursor
}

/**
 * Bounded FIFO of live items for one follow generation.
 *
 * Events appended between the snapshot cut and listener installation replay
 * from the Session log and never enter this queue. Only events appended while
 * the Client is not pulling, plus transient Assistant frames, are retained. A
 * push that would exceed either limit clears the queue and marks the generation
 * overflowed, which ends it for a clean Client resync.
 */
class FollowBacklog {
  private readonly events = new Deque<{ readonly value: SessionEvent; readonly bytes: number }>()
  private readonly frames = new Deque<{ readonly value: BufferedAssistantFrame; readonly bytes: number }>()
  private bufferedItems = 0
  private bufferedBytes = 0
  private overflow = false

  /** @param limits - positive item and byte caps. */
  constructor(private readonly limits: SessionFollowBufferLimits) {}

  /**
   * Whether a push exceeded the cap and discarded every retained item.
   * @returns true while the generation must end for a Client resync.
   */
  hasOverflowed(): boolean {
    return this.overflow
  }

  /** Retained events and frames. */
  get items(): number {
    return this.bufferedItems
  }

  /** Estimated retained bytes. */
  get bytes(): number {
    return this.bufferedBytes
  }

  /**
   * Retain one live durable event. The Session log already owns the payload,
   * so only the queue reference and wrapper count against the budget.
   * @param event - appended event.
   */
  pushEvent(event: SessionEvent): void {
    this.push(this.events, event, BACKLOG_ITEM_OVERHEAD)
  }

  /**
   * Retain one transient Assistant frame, including its serialized bytes.
   * @param entry - frame and its durable watermark.
   */
  pushFrame(entry: BufferedAssistantFrame): void {
    this.push(this.frames, entry, BACKLOG_ITEM_OVERHEAD + jsonBytes(entry.frame))
  }

  /**
   * Remove the oldest durable event.
   * @returns the event, or undefined when the queue is empty.
   */
  popEvent(): SessionEvent | undefined {
    return this.pop(this.events)
  }

  /**
   * Remove the oldest Assistant frame.
   * @returns the frame, or undefined when the queue is empty.
   */
  popFrame(): BufferedAssistantFrame | undefined {
    return this.pop(this.frames)
  }

  /**
   * Discard frames at or before one ordinal because a snapshot baseline
   * represents them.
   * @param throughOrdinal - inclusive snapshot cutoff.
   */
  prune(throughOrdinal: number): void {
    for (;;) {
      const head = this.frames.popFront()
      if (head === undefined) return
      if (head.value.ordinal > throughOrdinal) {
        this.frames.pushFront(head)
        return
      }
      this.bufferedItems -= 1
      this.bufferedBytes -= head.bytes
    }
  }

  /** Clear a pre-cut overflow now that the snapshot baseline supersedes it. */
  resetOverflow(): void {
    this.overflow = false
  }

  /** Drop every retained item and release its memory. */
  clear(): void {
    this.events.clear()
    this.frames.clear()
    this.bufferedItems = 0
    this.bufferedBytes = 0
  }

  private push<T>(
    queue: Deque<{ readonly value: T; readonly bytes: number }>,
    value: T,
    bytes: number,
  ): void {
    if (this.overflow) return
    if (this.bufferedItems + 1 > this.limits.maxItems
      || this.bufferedBytes + bytes > this.limits.maxBytes) {
      this.overflow = true
      this.clear()
      return
    }
    queue.pushBack({ value, bytes })
    this.bufferedItems += 1
    this.bufferedBytes += bytes
  }

  private pop<T>(queue: Deque<{ readonly value: T; readonly bytes: number }>): T | undefined {
    const head = queue.popFront()
    if (head === undefined) return undefined
    this.bufferedItems -= 1
    this.bufferedBytes -= head.bytes
    return head.value
  }
}

function validateFollowResumeOptions(options: SessionFollowResumeOptions): SessionFollowResumeOptions {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0) {
    throw new RangeError('session follow resume maxEvents must be a positive safe integer')
  }
  return options
}

function validateFollowBufferLimits(limits: SessionFollowBufferLimits): SessionFollowBufferLimits {
  if (!Number.isSafeInteger(limits.maxItems) || limits.maxItems <= 0) {
    throw new RangeError('session follow buffer maxItems must be a positive safe integer')
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new RangeError('session follow buffer maxBytes must be a positive safe integer')
  }
  return limits
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function cursorBeforeNext(nextSeq: SessionLogOffsetType): SessionSeqCursor {
  return nextSeq === 0 ? -1 : SessionSeq(nextSeq - 1)
}

function wireAssistantStreamFrame(
  frame: AssistantStreamFrame,
  durableCursor: SessionSeqCursor,
): SessionAssistantStreamFrame {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor }
  if (frame.type === 'end') return frame
  return {
    ...frame,
    chunk: frame.chunk as JsonValue,
  }
}

function projectionBlock(
  snapshot: NonNullable<SessionObservation['projections']>,
): SessionProjectionBaseline {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values as SessionProjectionValues,
  }
}

function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq)
      || request.beforeSeq < 0
      || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  validateHistoryWindow(request)
}

function validateFollowAfterSeq(afterSeq: SessionSeqCursor | undefined): void {
  if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < -1)) {
    throw new RemoteError('gateway/bad-request', 'afterSeq must be an integer greater than or equal to -1', {})
  }
}

function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  const window = request.turnWindow
  if (window !== undefined) {
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let turns = 0
  let cut = SessionLogOffset(0)
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (turnWindow !== undefined && event.type === 'turn/start') {
      turns++
      if (count >= turnWindow.minMessages && turns >= turnWindow.minTurns) {
        cut = SessionLogOffset(index)
        break
      }
    }
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      break
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/** Translate current logical Session metadata to the browser wire. */
function wireHeader(header: SessionHeader): SessionWireHeader {
  return { ...header }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return events.map(entryFor)
}
