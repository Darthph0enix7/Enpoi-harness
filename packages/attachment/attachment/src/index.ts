/** Durable attachment storage seam (`ctx.attachments`). @module @deepseek-ai/dsh-attachment */

import { stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { admitEncodedFile as admitFileInput, admitEncodedImages } from './admission.ts'
import { AttachmentError, isAttachmentError as matchesAttachmentError } from './error.ts'
import type { DurablePromptRefPart } from './prompt-refs.ts'
import type {
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  EncodedFileAttachment,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId, ImageVariantId } from './brand.ts'
export { AttachmentError, isAttachmentError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, AttachmentErrorOptions, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedFile, admitEncodedImages } from './admission.ts'
export { canonicalDurablePromptParts } from './prompt-refs.ts'
export type { DurablePromptRefLookup, DurablePromptRefPart } from './prompt-refs.ts'
export { longEdgeDimensions, requestImageDimensions } from './request-projection.ts'
export type { ProjectedDimensions } from './request-projection.ts'
export type {
  AttachmentId as AttachmentIdType,
  AdmittedPromptContentPart,
  AttachmentAdmissionPart,
  EncodedFileAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestTarget,
  ImageMediaType,
  PromptContentPart,
  RequestImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/**
 * Service-wide cap on durable file references one prompt may cite, used by
 * providers that do not resolve a deployment value. `attachment-local`
 * exposes the same bound as validated configuration.
 */
export const DEFAULT_MAX_FILE_REFERENCES_PER_MESSAGE = 64

/** Exact decoded byte length of one canonical base64 payload, computed without decoding. */
function encodedBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(data.length / 4) * 3 - padding)
}

async function hostAttachmentExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw new AttachmentError('Unable to inspect attachment object.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
}

function missingAttachmentLabel(attachmentId: string, name?: string): string {
  return name !== undefined && name !== '' ? `"${name}" (${attachmentId})` : attachmentId
}

/**
 * Verify via metadata probes that every durable image or file reference in a
 * prompt still has a backing stored object before the prompt is admitted.
 * @param store - attachment store owning existence checks.
 * @param parts - prompt parts containing durable references.
 * @param signal - optional cancellation signal.
 * @throws AttachmentError with `ATTACHMENT_NOT_FOUND` naming the missing attachment id and name.
 */
export async function verifyDurablePromptRefsExist(
  store: Pick<AttachmentStore, 'imageExists' | 'fileExists'>,
  parts: readonly (AttachmentAdmissionPart | DurablePromptRefPart)[],
  signal?: AbortSignal,
): Promise<void> {
  for (const part of parts) {
    signal?.throwIfAborted()
    if (part.type === 'image-ref') {
      if (!await store.imageExists(part.attachment, signal)) {
        const id = String(part.attachment.attachmentId)
        const name = part.attachment.name
        throw new AttachmentError(
          `Image attachment ${missingAttachmentLabel(id, name)} is missing.`,
          'ATTACHMENT_NOT_FOUND',
          { attachmentId: id, ...(name === undefined || name === '' ? {} : { attachmentName: name }) },
        )
      }
    } else if (part.type === 'file-ref' || part.type === 'file') {
      if (!await store.fileExists(part.attachment, signal)) {
        const id = String(part.attachment.attachmentId)
        const name = part.attachment.name
        throw new AttachmentError(
          `File attachment ${missingAttachmentLabel(id, name)} is missing.`,
          'ATTACHMENT_NOT_FOUND',
          { attachmentId: id, attachmentName: name },
        )
      }
    }
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Maximum durable file references (`file` or `file-ref` parts) one admitted
   * prompt may cite. Deployment backends override this from validated
   * configuration; the service bound applies when a provider names none.
   */
  readonly maxFileReferencesPerMessage: number = DEFAULT_MAX_FILE_REFERENCES_PER_MESSAGE

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate one ordered image batch before committing any member.
   * Validation failures start no writes; storage failures return no partial
   * references, although already published content-addressed objects may stay
   * unreachable until a future retention policy collects them.
   * @param inputs - encoded images in their owning message order.
   * @returns durable references in the exact input order.
   */
  protected validateImageBatch(inputs: readonly SaveImageAttachment[]): void {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
  }

  /**
   * Validate and durably commit one ordered image batch.
   * @param inputs - encoded images in owning-message order.
   * @returns durable normalized attachment references in the same order after every member succeeds.
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    for (const input of inputs) await this.validateImage(input)

    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * Admit one Host prompt and replace each uploaded image with its durable
   * reference. Text and durable image/file citations pass through unchanged.
   * Uploads and citations are charged together against the per-message image
   * count, aggregate image bytes, media types, and file-reference count; a
   * durable object cited more than once is refused. A prompt without image
   * parts performs no storage operation.
   * @param content - prompt parts in message order after file receipt resolution.
   * @returns admitted prompt parts in the same order as `content`.
   * @throws AttachmentError when the image batch, a citation, or the
   *   file-reference count is refused.
   */
  async admitPromptContent(
    content: readonly AttachmentAdmissionPart[],
  ): Promise<AdmittedPromptContentPart[]> {
    this.validatePromptReferences(content)
    await verifyDurablePromptRefsExist(this, content)
    const refs = content.some(part => part.type === 'image')
      ? await admitEncodedImages(this, content.filter(part => part.type === 'image'))
      : []
    let next = 0
    return content.map((part): AdmittedPromptContentPart => {
      switch (part.type) {
        case 'text': return { type: 'text', text: part.text }
        case 'image-ref': return { type: 'image', attachment: part.attachment }
        case 'file':
        case 'file-ref': return { type: 'file', attachment: part.attachment }
        case 'image': return { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
      }
    })
  }

  /**
   * Charge the complete prompt against the deployment batch limits before any
   * storage: uploaded image bytes and durable image citations share the image
   * count and aggregate-byte budgets, and every file citation counts against
   * {@link maxFileReferencesPerMessage}. A repeated durable-object id is
   * refused so repeats cannot multiply a limit.
   * @param content - prompt parts in message order.
   * @throws AttachmentError for an over-limit batch or a repeated citation.
   */
  private validatePromptReferences(content: readonly AttachmentAdmissionPart[]): void {
    const imageRefs = content.filter(
      (part): part is Extract<AttachmentAdmissionPart, { type: 'image-ref' }> => part.type === 'image-ref',
    )
    // Upload-only prompts keep the saveImages batch validation; a citation
    // additionally charges the uploads so the combined batch respects the
    // same per-message budgets.
    if (imageRefs.length > 0) {
      const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
      const uploads = content.filter(
        (part): part is Extract<AttachmentAdmissionPart, { type: 'image' }> => part.type === 'image',
      )
      if (uploads.length + imageRefs.length > maxImagesPerMessage) {
        throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
      }
      const imageBytes = uploads.reduce((sum, part) => sum + encodedBase64Bytes(part.data), 0)
        + imageRefs.reduce((sum, part) => sum + part.attachment.bytes, 0)
      if (imageBytes > maxMessageImageBytes) {
        throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
      }
      for (const part of imageRefs) {
        if (!mediaTypes.includes(part.attachment.mediaType)) {
          throw new AttachmentError(
            `Image type ${part.attachment.mediaType} is not accepted by this deployment.`,
            'UNSUPPORTED_IMAGE_TYPE',
          )
        }
      }
    }
    const imageIds = new Set<string>()
    for (const part of imageRefs) this.assertNewCitation(imageIds, String(part.attachment.attachmentId))
    const fileIds = new Set<string>()
    let files = 0
    for (const part of content) {
      if (part.type !== 'file' && part.type !== 'file-ref') continue
      // A receipt-resolved `file` part is this prompt's own upload, so identical
      // bytes uploaded twice stay two entries; only durable citations dedupe.
      if (part.type === 'file-ref') this.assertNewCitation(fileIds, String(part.attachment.attachmentId))
      files += 1
    }
    if (files > this.maxFileReferencesPerMessage) {
      throw new AttachmentError(
        'Prompt cites more file references than the configured per-message limit.',
        'TOO_MANY_FILES',
      )
    }
  }

  /**
   * Record one durable citation and refuse a repeated id in the same prompt.
   * @param seen - ids already cited for this attachment kind.
   * @param id - candidate opaque attachment id.
   * @throws AttachmentError with `DUPLICATE_ATTACHMENT_REF` for a repeated id.
   */
  private assertNewCitation(seen: Set<string>, id: string): void {
    if (seen.has(id)) {
      throw new AttachmentError(`Prompt cites attachment "${id}" more than once.`, 'DUPLICATE_ATTACHMENT_REF')
    }
    seen.add(id)
  }

  /**
   * Decode and durably commit one canonical base64 file upload.
   * @param input - canonical base64 bytes and optional display name.
   * @returns the durable content-addressed file reference.
   * @throws AttachmentError when the encoding or storage operation is refused.
   */
  admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef> {
    return admitFileInput(this, input)
  }

  /**
   * Identify a failure emitted by this attachment capability by its stable code.
   * @param error - value caught from an attachment operation.
   * @returns whether the value is an attachment failure.
   */
  isAttachmentError(error: unknown): error is AttachmentError {
    return matchesAttachmentError(error)
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * The returned reference describes the persisted normalized image. When
   * normalization reduces the raster, its `originalDimensions` records the
   * orientation-applied input dimensions.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns the durable content-addressed normalized image reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and normalized attachment reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * Check via metadata only (no full byte read) whether a stored normalized
   * image object exists in this store. Backends without host-file paths return
   * `true` unless they override this check.
   * @param ref - durable normalized attachment reference.
   * @param signal - optional cancellation signal.
   * @returns whether the stored object exists.
   */
  async imageExists(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const hostPath = this.imageHostPath(ref)
    if (hostPath === undefined) return true
    return hostAttachmentExists(hostPath)
  }

  /**
   * Check via metadata only (no full byte read) whether a stored verbatim file
   * object exists in this store. Backends without host-file paths return `true`
   * unless they override this check.
   * @param ref - durable file attachment reference.
   * @param signal - optional cancellation signal.
   * @returns whether the stored object exists.
   */
  async fileExists(ref: FileAttachmentRef, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const hostPath = this.fileHostPath(ref)
    if (hostPath === undefined) return true
    return hostAttachmentExists(hostPath)
  }

  /**
   * Locate the provider-owned normalized object in the harness host filesystem.
   * @param ref - durable normalized attachment reference.
   * @returns an absolute host path, or undefined when this backend is not host-file-backed.
   * @throws an AttachmentError when the durable reference is invalid.
   */
  imageHostPath(ref: ImageAttachmentRef): string | undefined {
    void ref
    return undefined
  }

  /**
   * Durably commit one file byte-for-byte before its owning session event is
   * appended. Files carry no admission limits: any byte content and length is
   * accepted, and the stored object is the exact submitted bytes. Backends
   * without verbatim file storage keep this default rejection.
   * @param input - exact bytes and optional display name.
   * @returns the durable content-addressed file reference.
   */
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot store verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * Durably commit one file byte-for-byte from bounded chunks. Providers must
   * apply backpressure and must not collect the complete file in memory.
   * Backends without streamed verbatim storage keep this default rejection.
   * @param input - ordered exact bytes, optional cancellation, and display name.
   * @returns the durable content-addressed file reference.
   */
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot stream verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * Read and verify one verbatim stored file as bounded chunks. Providers must
   * not collect the complete file in memory. Backends without verbatim file
   * reads keep this default rejection.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend reads and verification work.
   * @returns exact file bytes in order; integrity failures reject the iteration.
   */
  async *readFileStream(
    ref: FileAttachmentRef,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted()
    void ref
    await Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot read verbatim files.',
      'ATTACHMENT_FILES_UNSUPPORTED',
    ))
  }

  /**
   * Locate the verbatim stored file object in the harness host filesystem.
   * @param ref - durable file reference.
   * @returns an absolute host path, or undefined when this backend is not host-file-backed.
   * @throws an AttachmentError when the durable reference is invalid.
   */
  fileHostPath(ref: FileAttachmentRef): string | undefined {
    void ref
    return undefined
  }

  /**
   * Generate or read one deterministic model-request version from the stored normalized image.
   * @param ref - durable provider-independent normalized attachment reference.
   * @param target - route-chosen dimensions and byte target; an unmet byte target yields the smallest ladder output.
   * @param signal - optional cancellation.
   * @returns request bytes and the cache/upload identity covering every transform input.
   */
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    void ref
    void target
    return Promise.reject(new AttachmentError(
      'The mounted attachment provider cannot derive model-request images.',
      'ATTACHMENT_PROJECTION_UNSUPPORTED',
    ))
  }

}

export default AttachmentStore
