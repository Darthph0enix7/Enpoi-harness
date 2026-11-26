/**
 * Validation and log-backed canonicalization for durable attachment citations
 * in user prompts.
 *
 * @module @deepseek-ai/dsh-attachment/prompt-refs
 */

import { AttachmentError } from './error.ts'
import type { FileAttachmentRef, ImageAttachmentRef } from './types.ts'

/** Durable image media types accepted from the wire. */
const WIRE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** Read-only lookup of attachment references authorized by one Session log. */
export interface DurablePromptRefLookup {
  /**
   * Resolve one image attachment id cited by the target Session log.
   * @param attachmentId - opaque attachment identity.
   * @returns the logged image reference, or undefined when absent.
   */
  referencedImage(attachmentId: string): ImageAttachmentRef | undefined
  /**
   * Resolve one file attachment id cited by a user message in the target Session log.
   * @param attachmentId - opaque file attachment identity.
   * @returns the logged file reference, or undefined when absent.
   */
  referencedFile(attachmentId: string): FileAttachmentRef | undefined
}

/** A wire-submitted or restored-draft durable attachment citation. */
export type DurablePromptRefPart =
  | { readonly type: 'image-ref'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file-ref'; readonly attachment: FileAttachmentRef }

function isWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDurablePromptRefPart(part: { readonly type: string }): part is DurablePromptRefPart {
  return part.type === 'image-ref' || part.type === 'file-ref'
}

/**
 * Reject one malformed durable wire reference before authorization. The typed
 * request face cannot stop a JSON caller from omitting or mistyping citation
 * fields.
 * @param part - durable `image-ref` or `file-ref` prompt part.
 * @throws AttachmentError with `INVALID_ATTACHMENT_REF` for a malformed reference.
 */
function assertDurablePromptRef(part: DurablePromptRefPart): void {
  const malformed = (): never => {
    throw new AttachmentError(
      'Durable attachment reference is malformed.',
      'INVALID_ATTACHMENT_REF',
    )
  }
  const attachment: unknown = part.attachment
  if (!isWireRecord(attachment)) malformed()
  const record = attachment as Record<string, unknown>
  if (typeof record.attachmentId !== 'string' || record.attachmentId === '') malformed()
  if (typeof record.bytes !== 'number' || !Number.isFinite(record.bytes) || record.bytes < 0) malformed()
  if (part.type === 'image-ref') {
    if (typeof record.mediaType !== 'string' || !WIRE_IMAGE_MEDIA_TYPES.has(record.mediaType)) malformed()
    for (const field of ['width', 'height'] as const) {
      const value = record[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) malformed()
    }
    if (record.name !== undefined && typeof record.name !== 'string') malformed()
    return
  }
  if (typeof record.name !== 'string' || record.name === '') malformed()
}

/**
 * Authorize restored-draft or cited attachment references against the target
 * Session log and replace each with the reference the log recorded. A caller
 * may cite an existing image or file only through the target Session's log;
 * replacing the attachment with the logged copy also prevents a caller from
 * rewriting display metadata or byte counts. Malformed references fail before
 * lookup.
 * @param lookup - target Session index or log lookup holding its logged references.
 * @param content - prompt parts containing zero or more `image-ref` / `file-ref` citations.
 * @returns the same parts in order with every durable reference canonicalized.
 * @throws AttachmentError with `INVALID_ATTACHMENT_REF` or `ATTACHMENT_NOT_REFERENCED`.
 */
export function canonicalDurablePromptParts<Part extends { readonly type: string }>(
  lookup: DurablePromptRefLookup,
  content: readonly (Part | DurablePromptRefPart)[],
): (Part | DurablePromptRefPart)[] {
  for (const part of content) {
    if (isDurablePromptRefPart(part)) assertDurablePromptRef(part)
  }
  return content.map((part): Part | DurablePromptRefPart => {
    if (!isDurablePromptRefPart(part)) return part
    const id = String(part.attachment.attachmentId)
    if (part.type === 'image-ref') {
      const referenced = lookup.referencedImage(id)
      if (referenced === undefined) {
        throw new AttachmentError(
          'Attachment is not referenced by this session.',
          'ATTACHMENT_NOT_REFERENCED',
          {
            attachmentId: id,
            ...(typeof part.attachment.name === 'string' && part.attachment.name !== ''
              ? { attachmentName: part.attachment.name }
              : {}),
          },
        )
      }
      return { type: 'image-ref', attachment: referenced }
    }
    const referenced = lookup.referencedFile(id)
    if (referenced === undefined) {
      throw new AttachmentError(
        'Attachment is not referenced by this session.',
        'ATTACHMENT_NOT_REFERENCED',
        {
          attachmentId: id,
          ...(typeof part.attachment.name === 'string' && part.attachment.name !== ''
            ? { attachmentName: part.attachment.name }
            : {}),
        },
      )
    }
    return { type: 'file-ref', attachment: referenced }
  })
}
