/** Incremental semantic-document projection for one live Session log. */

import { SessionSeq, isSurfaceEligibleType, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchDocument, SessionEventSurface } from '@deepseek-ai/dsh-session-query'

/** Surface baseline and documents a complete fold produced for one live session. */
export interface LiveDocumentBaseline {
  readonly documents: readonly SessionEventSearchDocument[]
  readonly nodes: readonly number[]
  readonly shadowed: readonly number[]
}

/** One existing document whose surface classification moved. */
export interface LiveDocumentSurfaceChange {
  readonly seq: SessionSeq
  readonly surface: SessionEventSurface
}

/** Row changes one live append produces instead of a whole-session rewrite. */
export interface LiveDocumentDelta {
  /** New searchable documents; every seq was absent from the index before. */
  readonly inserts: readonly SessionEventSearchDocument[]
  /** Existing documents whose stored surface classification changed. */
  readonly surfaceChanges: readonly LiveDocumentSurfaceChange[]
}

/**
 * Document and surface state for one live session, advanced by folding only
 * appended events. The classification matches the complete
 * `buildSessionEventSearchDocumentState` fold: a shadowing replacement wins
 * over a later branch re-activation, exactly as the full fold classifies a
 * sequence that any replacement ever shadowed.
 */
export class LiveDocumentIndex {
  private readonly sessionId: SessionId
  private readonly nodes: SessionSeq[]
  private readonly current: Set<SessionSeq>
  private readonly shadowed = new Set<SessionSeq>()
  private readonly documentSurfaces = new Map<SessionSeq, SessionEventSurface>()
  private eventCount: number
  private lastEvent: SessionEvent | undefined

  /**
   * @param sessionId - session that owns the live log.
   * @param baseline - complete-fold surface state and documents.
   * @param eventCount - number of events the baseline covers.
   * @param lastEvent - last folded event, or undefined for an empty log.
   */
  constructor(
    sessionId: SessionId,
    baseline: LiveDocumentBaseline,
    eventCount: number,
    lastEvent: SessionEvent | undefined,
  ) {
    this.sessionId = sessionId
    this.nodes = baseline.nodes.map(seq => SessionSeq(seq))
    this.current = new Set(this.nodes)
    for (const seq of baseline.shadowed) this.shadowed.add(SessionSeq(seq))
    for (const document of baseline.documents) this.documentSurfaces.set(document.seq, document.surface)
    this.eventCount = eventCount
    this.lastEvent = lastEvent
  }

  /** Number of events folded into this index so far. */
  get foldedEvents(): number { return this.eventCount }

  /** Last folded event, used as the prefix identity checkpoint. */
  get tailEvent(): SessionEvent | undefined { return this.lastEvent }

  /**
   * Fold appended events over the retained baseline.
   * @param events - contiguous log prefix that must extend the folded prefix.
   * @returns the row delta, or undefined when `events` is not a strict continuation.
   */
  foldAppend(events: readonly SessionEvent[]): LiveDocumentDelta | undefined {
    if (events.length < this.eventCount) return undefined
    if (this.eventCount > 0 && events[this.eventCount - 1] !== this.lastEvent) return undefined
    const appended = events.slice(this.eventCount)
    const pendingText = new Map<SessionSeq, string>()
    const touched = new Set<SessionSeq>()
    for (const event of appended) {
      if (!this.applySurfaceStep(event, touched)) return undefined
      const text = extractSessionEventText(event)
      if (text.length > 0) pendingText.set(event.seq, text)
    }
    const inserts: SessionEventSearchDocument[] = []
    for (const event of appended) {
      const text = pendingText.get(event.seq)
      if (text === undefined) continue
      const surface = this.classify(event.seq)
      inserts.push({
        sessionId: this.sessionId, seq: event.seq, type: event.type, time: event.time, surface, text,
      })
      this.documentSurfaces.set(event.seq, surface)
    }
    const surfaceChanges: LiveDocumentSurfaceChange[] = []
    for (const seq of touched) {
      if (pendingText.has(seq)) continue
      const previous = this.documentSurfaces.get(seq)
      if (previous === undefined) continue
      const surface = this.classify(seq)
      if (surface === previous) continue
      this.documentSurfaces.set(seq, surface)
      surfaceChanges.push({ seq, surface })
    }
    this.eventCount = events.length
    this.lastEvent = events.at(-1)
    return { inserts, surfaceChanges }
  }

  private classify(seq: SessionSeq): SessionEventSurface {
    if (this.shadowed.has(seq)) return 'shadowed'
    return this.current.has(seq) ? 'current' : 'log-only'
  }

  /**
   * Apply one event's surface transition to the retained state.
   * @param event - appended event in sequence order.
   * @param touched - collects every sequence whose classification may have moved.
   * @returns false when the event needs the complete fold instead.
   */
  private applySurfaceStep(event: SessionEvent, touched: Set<SessionSeq>): boolean {
    if (event.type === 'revert/branch') {
      const data = event.data
      const startIdx = this.nodes.indexOf(SessionSeq(data.startSeq))
      const endIdx = this.nodes.indexOf(SessionSeq(data.endSeq))
      if (startIdx === -1 || endIdx < startIdx) return false
      for (let index = startIdx; index <= endIdx; index += 1) {
        const seq = this.nodes[index] as SessionSeq
        this.shadowed.add(seq)
        touched.add(seq)
      }
      const restored = data.restoredSeqs.map(seq => SessionSeq(seq))
      this.nodes.splice(startIdx, endIdx - startIdx + 1, ...restored)
      for (const seq of restored) {
        this.current.add(seq)
        touched.add(seq)
      }
      for (const seq of data.shadowedSeqs) this.shadowed.add(SessionSeq(seq))
      return true
    }
    if (!isSurfaceEligibleType(event.type)) return true
    if (!isSurfaceEvent(event)) return false
    const op = event.surfaceOp
    if (op === 'append') {
      this.nodes.push(event.seq)
      this.current.add(event.seq)
      return true
    }
    const startIdx = this.nodes.indexOf(op.startSeq)
    const endIdx = this.nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx < startIdx) return false
    for (let index = startIdx; index <= endIdx; index += 1) {
      const seq = this.nodes[index] as SessionSeq
      this.shadowed.add(seq)
      touched.add(seq)
    }
    this.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    this.current.add(event.seq)
    return true
  }
}
