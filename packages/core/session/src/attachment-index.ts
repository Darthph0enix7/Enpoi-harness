/**
 * Incremental and snapshot attachment-reference lookup over a Session event log.
 *
 * @module @deepseek-ai/dsh-session/attachment-index
 */

import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

type ImageAttachmentRef = ImageBlock['attachment']
type FileAttachmentRef = FileBlock['attachment']

/**
 * Per-Session O(1) lookup index for logged image and verbatim file references.
 * Advances incrementally via {@link ingest} or constructs from a log snapshot
 * via {@link fromEvents}.
 */
export class SessionAttachmentIndex {
  private readonly attachments = new Map<string, ImageAttachmentRef>()
  private readonly files = new Map<string, FileAttachmentRef>()
  private throughSeq = -1

  /**
   * Build an attachment index from one contiguous durable event log.
   * @param events - dense zero-based log events.
   * @returns the populated attachment index.
   */
  static fromEvents(events: readonly SessionEvent[]): SessionAttachmentIndex {
    const index = new SessionAttachmentIndex()
    for (const event of events) index.apply(event)
    index.throughSeq = events.length - 1
    return index
  }

  /**
   * Advance the index with one appended event, ignoring already-indexed sequences.
   * @param event - event appended after previously indexed events.
   */
  ingest(event: SessionEvent): void {
    if (event.seq <= this.throughSeq) return
    this.apply(event)
    this.throughSeq = event.seq
  }

  /**
   * Resolve one image attachment id to the first log event referencing it.
   * @param attachmentId - opaque attachment identity.
   * @returns the referenced image, or undefined when the log never cites it.
   */
  referencedImage(attachmentId: string): ImageAttachmentRef | undefined {
    return this.attachments.get(attachmentId)
  }

  /**
   * Resolve one verbatim-file reference to its committed user message.
   * Restored composer drafts and prompt citations may only re-cite files the
   * Session itself logged, and prompt file blocks enter through `user/message`
   * events alone.
   * @param attachmentId - opaque file attachment identity.
   * @returns the referenced file, or undefined when no user message cites it.
   */
  referencedFile(attachmentId: string): FileAttachmentRef | undefined {
    return this.files.get(attachmentId)
  }

  private apply(event: SessionEvent): void {
    if (event.type === 'user/message') {
      for (const block of event.data.content) {
        if (block.type !== 'file') continue
        const id = String(block.attachment.attachmentId)
        if (!this.files.has(id)) this.files.set(id, block.attachment)
      }
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
export function referencedImageInEvents(
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
  for (const record of assistant.data.stream) {
    if (record.type === 'chunk' && record.chunk.type === 'block-end') {
      collectBlockImages([record.chunk.block], out)
    }
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
  for (const record of assistant.data.stream) {
    if (record.type === 'chunk' && record.chunk.type === 'block-end') {
      const found = imageBlockIn([record.chunk.block], match)
      if (found !== undefined) return found
    }
  }
  return undefined
}
