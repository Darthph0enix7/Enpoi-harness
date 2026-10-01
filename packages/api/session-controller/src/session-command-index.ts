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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { assistantStreamChunks } from '@deepseek-ai/dsh-llm'
import {
  emptyIterationFoldState,
  foldIterationEvent,
  type IterationFoldState,
} from './iteration-fold.ts'

/** Derived prompt-id, revert-boundary, iteration-pointer, and attachment-reference lookups for one Session. */
export class SessionCommandIndex {
  private readonly promptRequestIds = new Set<string>()
  private readonly attachments = new Map<string, ImageAttachmentRef>()
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
    return this.attachments.get(attachmentId)
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
    for (const ref of collectEventImages(event)) {
      const id = String(ref.attachmentId)
      if (!this.attachments.has(id)) this.attachments.set(id, ref)
    }
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
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function collectBlockImages(content: unknown, out: ImageAttachmentRef[]): void {
  if (!Array.isArray(content)) return
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      out.push(block.attachment as ImageAttachmentRef)
    }
  }
}

/** Collect every image reference carried by one first-party event payload. */
function collectEventImages(event: SessionEvent): ImageAttachmentRef[] {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
  }
  const out: ImageAttachmentRef[] = []
  // First-party event payloads can be present without their producer plugin mounted.
  const type: string = event.type
  switch (type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      collectBlockImages(data.content, out)
      return out
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      collectBlockImages(data.message?.content, out)
      return out
    case 'agent/inbox/spliced': {
      const messages = data.inserted
      if (!Array.isArray(messages)) return out
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        collectBlockImages((message as { readonly content?: unknown }).content, out)
      }
      return out
    }
    case 'compaction/summary':
      collectBlockImages(data.summary, out)
      collectBlockImages(data.rawOutput, out)
      return out
    case 'assistant/message': {
      collectBlockImages(data.message?.content, out)
      break
    }
    case 'assistant/attempt': break
    default: return out
  }
  const assistant = event as SessionEvent<'assistant/message' | 'assistant/attempt'>
  for (const chunk of assistantStreamChunks(assistant.data.stream, 'block-end')) {
    collectBlockImages([chunk.block], out)
  }
  return out
}

function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
  }
  return undefined
}

/** Read only first-party declared content fields; unknown event payloads stay opaque. */
function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: unknown
    readonly summary?: unknown
    readonly rawOutput?: unknown
  }
  // First-party event payloads can be present without their producer plugin mounted.
  const type: string = event.type
  switch (type) {
    case 'user/message':
    case 'tool/ptc-dispatch':
      return imageBlockIn(data.content, match)
    case 'system/message':
    case 'developer/message':
    case 'tool/result':
    case 'team/message/queued':
      return imageBlockIn(data.message?.content, match)
    case 'agent/inbox/spliced': {
      const messages = data.inserted
      if (!Array.isArray(messages)) return undefined
      for (const message of messages as readonly unknown[]) {
        if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
        const found = imageBlockIn((message as { readonly content?: unknown }).content, match)
        if (found !== undefined) return found
      }
      return undefined
    }
    case 'compaction/summary':
      return imageBlockIn(data.summary, match) ?? imageBlockIn(data.rawOutput, match)
    case 'assistant/message': {
      const found = imageBlockIn(data.message?.content, match)
      if (found !== undefined) return found
      break
    }
    case 'assistant/attempt': break
    default: return undefined
  }
  const assistant = event as SessionEvent<'assistant/message' | 'assistant/attempt'>
  for (const chunk of assistantStreamChunks(assistant.data.stream, 'block-end')) {
    const found = imageBlockIn([chunk.block], match)
    if (found !== undefined) return found
  }
  return undefined
}
