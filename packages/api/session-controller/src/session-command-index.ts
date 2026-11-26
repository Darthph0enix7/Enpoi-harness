/**
 * Per-Session O(1) lookups over the append-only log.
 *
 * The command path otherwise re-materializes and scans the whole log on every
 * send (`hasPromptRequest`), restore (`latestRevertBoundary`), and attachment
 * read (`referencedImage`). Each index is derived state: it is built once from
 * a durable log snapshot when first needed and then advanced by
 * `session/event`, so the read cost is paid once per Session instead of once
 * per operation.
 */
import { SessionAttachmentIndex, referencedImageInEvents, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  emptyIterationFoldState,
  foldIterationEvent,
  type IterationFoldState,
} from './iteration-fold.ts'

/** Derived prompt-id, revert-boundary, iteration-pointer, and attachment-reference lookups for one Session. */
export class SessionCommandIndex {
  private readonly promptRequestIds = new Set<string>()
  private readonly attachmentRefs = new SessionAttachmentIndex()
  private revertFromSeq: number | undefined
  private throughSeq = -1
  /** Durable revert-iteration pointer index, advanced by the same ingest. */
  readonly iterations: IterationFoldState = emptyIterationFoldState()

  /**
   * Build the index over one durable log snapshot.
   * @param events - dense zero-based log events.
   * @returns the folded index.
   */
  static fromEvents(events: readonly SessionEvent[]): SessionCommandIndex {
    const index = new SessionCommandIndex()
    for (const event of events) index.apply(event)
    index.throughSeq = events.length - 1
    return index
  }

  /**
   * Advance the index with one durable appended event.
   * @param event - event appended after every event already indexed.
   */
  ingest(event: SessionEvent): void {
    if (event.seq <= this.throughSeq) return
    this.apply(event)
    this.throughSeq = event.seq
  }

  /** @param requestId - prompt idempotency key. @returns whether the log already carries it. */
  hasPromptRequest(requestId: string): boolean {
    return this.promptRequestIds.has(requestId)
  }

  /** @returns the latest non-cleared `revert/state` boundary, or undefined. */
  latestRevertBoundary(): number | undefined {
    return this.revertFromSeq
  }

  /**
   * Resolve one attachment id to the first log event referencing it.
   * @param attachmentId - opaque attachment identity.
   * @returns the referenced image, or undefined when the log never cites it.
   */
  referencedImage(attachmentId: string): ImageAttachmentRef | undefined {
    return this.attachmentRefs.referencedImage(attachmentId)
  }

  /**
   * Resolve one verbatim-file reference to its committed user message.
   * Restored composer drafts may only re-cite files the Session itself
   * logged, and a prompt's file blocks enter through `user/message` events
   * alone.
   * @param attachmentId - opaque file attachment identity.
   * @returns the referenced file, or undefined when no user message cites it.
   */
  referencedFile(attachmentId: string): FileAttachmentRef | undefined {
    return this.attachmentRefs.referencedFile(attachmentId)
  }

  private apply(event: SessionEvent): void {
    foldIterationEvent(this.iterations, event)
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') {
        this.promptRequestIds.add(source.rpcId)
      }
    } else if (event.type === 'revert/state') {
      const data = event.data as { readonly fromSeq?: number | null }
      if (data.fromSeq === null) this.revertFromSeq = undefined
      else if (typeof data.fromSeq === 'number') this.revertFromSeq = data.fromSeq
    }
    this.attachmentRefs.ingest(event)
  }
}

/**
 * First-image lookup over one already materialized event list (cold reads).
 * @param events - complete durable log.
 * @param attachmentId - opaque attachment identity.
 * @returns the referenced image, or undefined.
 */
export function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  return referencedImageInEvents(events, attachmentId)
}
