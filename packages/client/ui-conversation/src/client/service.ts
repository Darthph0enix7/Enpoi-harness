/**
 * Scope-addressed conversation send, cancel, and history orchestration.
 *
 * Scope addressing rides the cordis Service tracker: property access through
 * `ctx.conversation` rebinds `this.ctx` to the caller's context, so methods
 * read the session tag with `scopeOf`. Mutable state must remain reachable
 * through one property read; assignment through the tracker proxy and `#`
 * private fields bypass that rebinding.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// Type-only imports: a plugin-to-plugin value import is a bundle purity
// error, so scope resolution goes through the sessions service (scopeOf
// method) instead of the standalone helper.
import type {
  ISessions, PendingSubmissionRetirement, SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ComposerAttachment, ComposerFileAttachment, ComposerImageAttachment, DraftFileUpload,
  UnavailableComposerAttachment,
} from './contract/slots.ts'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ComposerBlocks } from './contract/composer-blocks.ts'
import type { ComposerTabDirection, ComposerTabHandler } from './contract/composer-tab.ts'
import type {
  DraftAttachmentId, DraftAttachmentSerializationResult, RestoredDraftAttachment,
  SessionInputResolver, SubmitAttachment, SubmitOutcome,
} from './contract/input.ts'
import type { InputSubmitMode } from './contract/composer-submission.ts'

/**
 * The outward conversation face (`ctx.conversation`): the scope-addressed
 * verbs and the input registry other plugins may reach — and exactly what a
 * test fake must supply.
 */
export interface IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /**
   * The per-session composer-block registry: how a plugin the composer
   * cannot import makes a session's input inert with its own reason.
   */
  readonly blocks: ComposerBlocks
  /**
   * Claim the composer's unclaimed Tab gesture (agent-preset cycling). One
   * live handler at a time; registering a second throws.
   * @param handler - owner of the Tab gesture.
   * @returns disposer releasing the claim.
   */
  registerComposerTab(handler: ComposerTabHandler): () => void
  /**
   * Send a prompt into the caller scope's session (queued turn).
   * @param text - prompt text, sent verbatim as one text block.
   * @returns completion; business failures reject (and land in promptError).
   */
  send(text: string): Promise<void>
  /**
   * Apply one edit, remove, or Steer operation to a pending queue occurrence.
   * @param itemId - agent-owned inbox occurrence identity.
   * @param action - requested queue operation.
   * @returns completion; converged QueueDock races resolve, while other failures reject.
   */
  updateQueue(itemId: MessageId, action: QueueAction): Promise<void>
  /**
   * Cancel the scoped session's in-flight turn while preserving its pending Queue.
   * @param intent - stop intent forwarded to the Host; absent keeps its default.
   * @returns completion; failures reject as in send.
   */
  cancel(intent?: 'detach' | 'stop-all'): Promise<void>
  /**
   * Pull one older history page for the scoped session.
   * @returns completion of the page pull.
   */
  loadOlder(): Promise<void>
}

/** Create one browser-only image draft descriptor; only its id enters input state. */
function browserDraftAttachment(file: File): ComposerImageAttachment {
  return {
    kind: 'image',
    id: randomUUID() as DraftAttachmentId,
    previewUrl: URL.createObjectURL(file),
    file,
  }
}

/**
 * Fill the draft's intrinsic dimensions once the browser parses the image
 * header (a metadata read off the preview URL, not a full decode). Failures
 * and non-browser runtimes leave them absent — consumers size those images
 * from CSS constraints instead. The descriptors stay registry-owned; submit
 * reads the dimensions into an immutable echo snapshot, so this late write
 * does not require a store notification.
 */
function probeDimensions(attachment: ComposerImageAttachment): void {
  if (typeof Image !== 'function') return
  const probe = new Image()
  probe.onload = () => {
    attachment.width = probe.naturalWidth
    attachment.height = probe.naturalHeight
  }
  probe.src = attachment.previewUrl
}

/** Give the echo one paint opportunity without letting a throttled frame clock block admission. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        setTimeout(resolve, 0)
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        setTimeout(resolve, 0)
      }
      const fallback = setTimeout(finish, 100)
      requestAnimationFrame(finish)
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/** Native canonical base64 of one browser image (FileReader data-URL encode; no main-thread byte loop). */
function base64ImageOf(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => {
      reject(reader.error ?? new Error('conversation: image read failed'))
    }
    reader.readAsDataURL(file)
  })
}

/** Unsupported browser-declared image type, localized by the UI boundary. */
export class UnsupportedImageMediaTypeError extends Error {
  /** Browser-declared MIME value, possibly empty. */
  readonly mediaType: string

  /** @param mediaType - Browser-declared MIME value, possibly empty. */
  constructor(mediaType: string) {
    super(`unsupported image media type: ${mediaType || '(empty)'}`)
    this.name = 'UnsupportedImageMediaTypeError'
    this.mediaType = mediaType
  }
}

/** Scope-addressed conversation service (root singleton, provided as `conversation`). */
export class ConversationController extends Service implements IConversation {
  /** The per-session input machine registry (SessionInputResolver face). */
  readonly input: SessionInputResolver
  /** The per-session composer-block registry. */
  readonly blocks: ComposerBlocks
  /** The one owner currently claiming unclaimed Tab gestures in the composer. */
  private composerTab: ComposerTabHandler | undefined
  /** Live upload state per file-kind draft; images never appear here. */
  readonly fileUploads: SnapshotStore<Record<string, DraftFileUpload>> = createSnapshotStore<Record<string, DraftFileUpload>>({})
  private readonly draftAttachments = new Map<DraftAttachmentId, ComposerAttachment>()
  private readonly fileUploadOperations = new Map<DraftAttachmentId, {
    readonly controller: AbortController
    readonly done: Promise<void>
  }>()
  private readonly pendingFileUploads = new Set<Promise<void>>()
  private readonly fileUploadQueue: Array<{
    readonly run: () => Promise<void>
    readonly settle: () => void
  }> = []
  private activeFileUploads = 0
  private readonly maxConcurrentFileUploads: number
  private readonly resolveImageUrl: (sessionId: SessionId, attachment: ImageAttachmentRef) => Promise<string>
  private readonly unavailableAttachmentText: () => string

  /**
   * @param ctx - owning root context (the plugin apply context; the service
   * registers itself and follows that fiber's lifetime).
   * @param config - carries the SessionInputResolver and composer-block registry
   * constructed by the plugin apply (the same instances the slot inject
   * factories close over).
   */
  constructor(ctx: Context, config: {
    input: SessionInputResolver
    blocks: ComposerBlocks
    maxConcurrentFileUploads: number
    /** Session-authorized preview URL loader for restored durable images. */
    resolveImageUrl: (sessionId: SessionId, attachment: ImageAttachmentRef) => Promise<string>
    /** Localized notice for a send that still carries an unavailable restored attachment. */
    unavailableAttachmentText: () => string
  }) {
    super(ctx, 'conversation')
    this.input = config.input
    this.blocks = config.blocks
    this.maxConcurrentFileUploads = config.maxConcurrentFileUploads
    this.resolveImageUrl = config.resolveImageUrl
    this.unavailableAttachmentText = config.unavailableAttachmentText
    ctx.effect(() => async () => {
      const operations = [...this.fileUploadOperations.values()]
      for (const operation of operations) operation.controller.abort()
      await Promise.allSettled([...this.pendingFileUploads])
      this.fileUploadOperations.clear()
      this.fileUploadQueue.length = 0
      for (const attachment of this.draftAttachments.values()) {
        // Restored previews are owned by the session image cache; only a
        // browser pick minted an object URL this service revokes.
        if (attachment.kind === 'image' && attachment.file !== undefined) revokePreview(attachment.previewUrl)
      }
      this.draftAttachments.clear()
      this.fileUploads.set({})
    }, 'conversation draft attachments')
  }

  /**
   * Claim the composer's unclaimed Tab gesture for one live handler.
   * @param handler - owner of the Tab gesture.
   * @returns disposer releasing the claim.
   * @throws when another handler is already registered.
   */
  registerComposerTab(handler: ComposerTabHandler): () => void {
    if (this.composerTab !== undefined) {
      throw new Error('conversation.registerComposerTab: a composer Tab handler is already registered')
    }
    this.composerTab = handler
    return () => {
      if (this.composerTab === handler) this.composerTab = undefined
    }
  }

  /**
   * Route one Tab gesture that no completion menu claimed to the registered owner.
   * @param sessionId - the composer's Session; absent on a session-less surface.
   * @param direction - next (Tab) or previous (Shift+Tab).
   * @returns whether the gesture was consumed; false without an owner.
   */
  dispatchComposerTab(sessionId: SessionId | undefined, direction: ComposerTabDirection): boolean {
    return this.composerTab?.handle(sessionId, direction) ?? false
  }

  /**
   * Send a prompt into the scoped session. Business failures also land in the
   * session snapshot's promptError (object-layer state); the rejection here
   * exists for caller choreography (the composer restores the draft on it).
   * @param text - prompt text, sent verbatim as one text block.
   */
  async send(text: string): Promise<void> {
    const session = this.scopedSession('send')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
  }

  /**
   * Submit ordered draft attachments with text through one host admission. A local
   * submission echo enters the session snapshot synchronously; serialization
   * and the prompt round-trip start after the browser can paint it. On the
   * echo's observed retirement seeds admitted image previews into the durable
   * cache and removes every attachment from the draft registry. On failure,
   * every attachment remains registered so the composer can restore it.
   * @param session - target session.
   * @param text - serialized prompt text.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @param mode - queue or steer delivery selected by composer policy.
   * @param signal - optional cancellation for the complete Host admission.
   * @returns the Host admission outcome; local attachment preparation failures reject.
   */
  async sendSession(
    session: SessionFace,
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: InputSubmitMode,
    signal?: AbortSignal,
  ): Promise<SubmitOutcome> {
    const attachments = this.resolveDraftAttachments(attachmentIds)
    if (attachments.length !== attachmentIds.length) {
      throw new Error('conversation.sendSession: one or more draft attachments are no longer available')
    }
    if (attachments.some(attachment => attachment.kind === 'unavailable')) {
      return { kind: 'error', text: this.unavailableAttachmentText() }
    }
    const sendable = attachments.filter(attachment => attachment.kind !== 'unavailable')
    const uploads = this.fileUploads.getSnapshot()
    const uploadFor = (attachment: ComposerFileAttachment): Extract<DraftFileUpload, { status: 'ready' }> => {
      const upload = uploads[attachment.id]
      if (upload === undefined || upload.status !== 'ready') {
        throw new Error('conversation.sendSession: one or more files have not finished uploading')
      }
      return upload
    }
    const browserFileOf = (attachment: ComposerImageAttachment): File => {
      if (attachment.file !== undefined) return attachment.file
      throw new Error('conversation.sendSession: image draft has neither browser bytes nor a durable reference')
    }
    const pendingAttachments = sendable.map((attachment) => {
      if (attachment.kind === 'image') {
        const name = attachment.attachment?.name ?? attachment.file?.name
        return {
          type: 'image' as const,
          value: {
            previewUrl: attachment.previewUrl,
            ...(name === undefined || name === '' ? {} : { name }),
            ...(attachment.width === undefined ? {} : { width: attachment.width }),
            ...(attachment.height === undefined ? {} : { height: attachment.height }),
          },
        }
      }
      return { type: 'file' as const, value: attachment.attachment ?? uploadFor(attachment).file }
    })
    const serializeAttachments = (): Promise<Parameters<SessionFace['prompt']>[0]> => Promise.all(
      sendable.map(async (attachment) => {
        if (attachment.kind === 'image') {
          if (attachment.attachment !== undefined) return { type: 'image-ref' as const, attachment: attachment.attachment }
          return { type: 'image' as const, ...await this.encodeImage(browserFileOf(attachment)) }
        }
        if (attachment.attachment !== undefined) return { type: 'file-ref' as const, attachment: attachment.attachment }
        return { type: 'file' as const, receiptId: uploadFor(attachment).receiptId }
      }),
    )
    const snapshot = session.getSnapshot()
    if (snapshot.subagent !== null) {
      const uploaded = await serializeAttachments()
      const content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
      const result = await session.prompt(content, mode, signal)
      if (result.ok) {
        this.releaseDraftAttachments(attachments)
        return { kind: 'success' }
      }
      this.markUnavailableOnSendError(attachments, result.error)
      return { kind: 'error' }
    }
    let finishRetirement: ((retirement: PendingSubmissionRetirement) => void) | undefined
    const retirement = attachments.length === 0
      ? undefined
      : new Promise<PendingSubmissionRetirement>((resolve) => { finishRetirement = resolve })
    const submission = session.beginSubmission({
      mode,
      text,
      attachments: pendingAttachments,
      onRetire: (settlement) => {
        this.settleSubmittedAttachments(session.sessionId, attachments, settlement)
        finishRetirement?.(settlement)
      },
    })
    let content: Parameters<SessionFace['prompt']>[0]
    try {
      await nextPaint()
      const uploaded = await serializeAttachments()
      content = [...uploaded, ...(text === '' ? [] : [{ type: 'text' as const, text }])]
    } catch (error) {
      submission.abandon()
      throw error
    }
    const result = await session.prompt(content, mode, signal, submission.requestId)
    if (!result.ok) {
      this.markUnavailableOnSendError(attachments, result.error)
      return { kind: 'error' }
    }
    if (retirement !== undefined && (await retirement).reason !== 'observed') return { kind: 'error' }
    return { kind: 'success' }
  }

  /**
   * Create runtime-only draft attachments. Files whose browser MIME is an
   * accepted image type become image drafts (object URL preview, bytes sent
   * with the prompt); every other file becomes a file draft whose background
   * upload starts immediately and remains owned by this service across Session
   * navigation until completion or explicit removal.
   * @param sessionId - target Agent-scope identity.
   * @param files - browser files to register.
   * @returns ordered draft descriptors.
   */
  createDrafts(sessionId: SessionId, files: readonly File[]): readonly ComposerAttachment[] {
    return files.map((file) => {
      if (isImageMediaType(file.type)) {
        const attachment = browserDraftAttachment(file)
        this.draftAttachments.set(attachment.id, attachment)
        probeDimensions(attachment)
        return attachment
      }
      const attachment: ComposerFileAttachment = {
        kind: 'file',
        id: randomUUID() as DraftAttachmentId,
        file,
      }
      this.draftAttachments.set(attachment.id, attachment)
      this.beginFileUpload(sessionId, attachment)
      return attachment
    })
  }

  /**
   * Create runtime-only drafts from durable references restored into the
   * composer. Images resolve their session-authorized preview URL and become
   * removable chips; an image whose bytes the Session can no longer serve
   * becomes an unavailable chip instead (the text still restores). No bytes
   * are copied or re-uploaded: the draft keeps the reference.
   * @param sessionId - target Agent-scope identity authorizing image reads.
   * @param references - durable references in original message order.
   * @returns ordered draft descriptors, including unavailable references.
   */
  async createRestoredDrafts(
    sessionId: SessionId,
    references: readonly RestoredDraftAttachment[],
  ): Promise<readonly ComposerAttachment[]> {
    return await Promise.all(references.map(async (reference): Promise<ComposerAttachment> => {
      if (reference.kind === 'file') {
        const attachment: ComposerFileAttachment = {
          kind: 'file',
          id: randomUUID() as DraftAttachmentId,
          attachment: reference.attachment,
          sessionId,
        }
        this.draftAttachments.set(attachment.id, attachment)
        return attachment
      }
      try {
        const previewUrl = await this.resolveImageUrl(sessionId, reference.attachment)
        const attachment: ComposerImageAttachment = {
          kind: 'image',
          id: randomUUID() as DraftAttachmentId,
          attachment: reference.attachment,
          sessionId,
          previewUrl,
          width: reference.attachment.width,
          height: reference.attachment.height,
        }
        this.draftAttachments.set(attachment.id, attachment)
        return attachment
      } catch {
        const attachment: UnavailableComposerAttachment = {
          kind: 'unavailable',
          id: randomUUID() as DraftAttachmentId,
          attachment: reference.attachment,
          ...(reference.attachment.name === undefined || reference.attachment.name === ''
            ? {}
            : { name: reference.attachment.name }),
        }
        this.draftAttachments.set(attachment.id, attachment)
        return attachment
      }
    }))
  }

  /**
   * Restart one failed file upload.
   * @param sessionId - target Agent-scope identity.
   * @param id - draft attachment id whose upload previously failed.
   */
  retryFileUpload(sessionId: SessionId, id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined || attachment.kind !== 'file') return
    if (this.fileUploads.getSnapshot()[id]?.status !== 'error') return
    this.beginFileUpload(sessionId, attachment)
  }

  /**
   * Stage carried file drafts again for a new Session.
   * @param sessionId - target Agent-scope identity after a Workspace switch.
   * @param ids - carried draft attachment ids.
   */
  rebindDraftFiles(sessionId: SessionId, ids: readonly DraftAttachmentId[]): void {
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment?.kind === 'file') this.beginFileUpload(sessionId, attachment)
    }
  }

  private beginFileUpload(sessionId: SessionId, attachment: ComposerFileAttachment): void {
    // Restored files cite durable bytes and have nothing to upload; browser
    // picks always carry the File this path needs.
    const file = attachment.file
    if (file === undefined) return
    this.fileUploadOperations.get(attachment.id)?.controller.abort()
    const controller = new AbortController()
    this.fileUploads.update((draft) => {
      draft[attachment.id] = { status: 'uploading', loaded: 0 }
    })
    let settle!: () => void
    const done = new Promise<void>((resolve) => { settle = resolve })
    this.fileUploadOperations.set(attachment.id, { controller, done })
    this.pendingFileUploads.add(done)
    void done.then(() => { this.pendingFileUploads.delete(done) })
    const run = async (): Promise<void> => {
      try {
        if (controller.signal.aborted
          || this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        const result = await this.ctx.fileUpload.upload(
          sessionId,
          file,
          file.name === '' ? undefined : file.name,
          controller.signal,
          (progress) => {
            if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
            this.fileUploads.update((draft) => {
              if (!(attachment.id in draft)) return
              draft[attachment.id] = {
                status: 'uploading',
                loaded: progress.loaded,
                ...(progress.total === undefined ? {} : { total: progress.total }),
              }
            })
          },
        )
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return
          draft[attachment.id] = result.ok
            ? { status: 'ready', receiptId: result.value.receiptId, file: result.value.file }
            : { status: 'error', message: result.error.message }
        })
      } catch (error) {
        if (this.fileUploadOperations.get(attachment.id)?.controller !== controller) return
        this.fileUploads.update((draft) => {
          if (!(attachment.id in draft)) return
          draft[attachment.id] = {
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          }
        })
      } finally {
        if (this.fileUploadOperations.get(attachment.id)?.controller === controller) {
          this.fileUploadOperations.delete(attachment.id)
        }
      }
    }
    this.fileUploadQueue.push({ run, settle })
    this.pumpFileUploads()
  }

  /** Start queued upload Workers until the configured concurrency is occupied. */
  private pumpFileUploads(): void {
    while (this.activeFileUploads < this.maxConcurrentFileUploads) {
      const task = this.fileUploadQueue.shift()
      if (task === undefined) return
      this.activeFileUploads += 1
      void task.run().finally(() => {
        this.activeFileUploads -= 1
        task.settle()
        this.pumpFileUploads()
      })
    }
  }

  /**
   * Durable references carried by a set of draft ids, each with the Session
   * whose log authorized it. Used when a draft moves to another Session
   * (workspace switch) so restored attachments move only where their citation
   * is still authorized.
   * @param ids - draft attachment ids in rail order.
   * @returns each durable id with its reference and authorizing Session
   *   (browser picks omitted).
   */
  durableDraftAttachments(
    ids: readonly DraftAttachmentId[],
  ): readonly {
    readonly id: DraftAttachmentId
    readonly reference: RestoredDraftAttachment
    readonly sessionId: SessionId | undefined
  }[] {
    const entries: Array<{
      id: DraftAttachmentId
      reference: RestoredDraftAttachment
      sessionId: SessionId | undefined
    }> = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment === undefined || attachment.kind === 'unavailable') continue
      if (attachment.kind === 'image') {
        if (attachment.attachment !== undefined) {
          entries.push({
            id,
            reference: { kind: 'image', attachment: attachment.attachment },
            sessionId: attachment.sessionId,
          })
        }
        continue
      }
      if (attachment.attachment !== undefined) {
        entries.push({
          id,
          reference: { kind: 'file', attachment: attachment.attachment },
          sessionId: attachment.sessionId,
        })
      }
    }
    return entries
  }

  /**
   * Resolve ordered input-state ids to runtime-owned draft attachments.
   * @param ids - draft attachment ids.
   * @returns descriptors that remain live, in requested order.
   */
  resolveDraftAttachments(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] {
    const attachments: ComposerAttachment[] = []
    for (const id of ids) {
      const attachment = this.draftAttachments.get(id)
      if (attachment !== undefined) attachments.push(attachment)
    }
    return attachments
  }

  /**
   * Serialize ordered draft attachments to command-submit wire payloads without
   * sending or releasing them. Images are encoded; generic files cite receipts
   * from their completed background uploads and never reread browser bytes.
   * @param attachmentIds - ordered draft-local attachment ids.
   * @returns wire payloads in id order.
   */
  async serializeDraftAttachments(
    attachmentIds: readonly DraftAttachmentId[],
  ): Promise<DraftAttachmentSerializationResult> {
    const attachments = this.resolveDraftAttachments(attachmentIds)
    if (attachments.length !== attachmentIds.length) {
      throw new Error('conversation.serializeDraftAttachments: one or more draft attachments are no longer available')
    }
    const uploads = this.fileUploads.getSnapshot()
    return {
      attachments: await Promise.all(attachments.map(async (attachment) => {
        if (attachment.kind === 'unavailable') {
          throw new Error('conversation.serializeDraftAttachments: one or more draft attachments are no longer available')
        }
        if (attachment.kind === 'image') {
          if (attachment.attachment !== undefined) {
            throw new Error('conversation.serializeDraftAttachments: command submissions do not accept restored attachments')
          }
          if (attachment.file === undefined) {
            throw new Error('conversation.serializeDraftAttachments: image draft has neither browser bytes nor a durable reference')
          }
          return { type: 'image' as const, ...await this.encodeImage(attachment.file) }
        }
        if (attachment.attachment !== undefined) {
          throw new Error('conversation.serializeDraftAttachments: command submissions do not accept restored attachments')
        }
        const upload = uploads[attachment.id]
        if (upload === undefined || upload.status !== 'ready') {
          throw new Error('conversation.serializeDraftAttachments: one or more files have not finished uploading')
        }
        return { type: 'file' as const, receiptId: upload.receiptId }
      })),
    }
  }

  /**
   * Release one browser-owned draft attachment, aborting its active upload.
   * @param id - draft attachment id.
   */
  releaseDraftAttachment(id: DraftAttachmentId): void {
    const attachment = this.draftAttachments.get(id)
    if (attachment === undefined) return
    const operation = this.fileUploadOperations.get(id)
    this.fileUploadOperations.delete(id)
    operation?.controller.abort()
    this.draftAttachments.delete(id)
    if (attachment.kind === 'unavailable') return
    if (attachment.kind === 'image') {
      // A restored preview belongs to the session image cache; only a browser
      // pick's object URL is this service's to revoke.
      if (attachment.file !== undefined) revokePreview(attachment.previewUrl)
      return
    }
    // The stored Host object stays durable; only the draft's upload state ends.
    this.fileUploads.set(Object.fromEntries(
      Object.entries(this.fileUploads.getSnapshot()).filter(([key]) => key !== id),
    ))
  }

  /**
   * Release a set of browser-owned draft attachments.
   * @param attachments - descriptors to release.
   */
  releaseDraftAttachments(attachments: readonly ComposerAttachment[]): void {
    for (const attachment of attachments) this.releaseDraftAttachment(attachment.id)
  }

  /** Apply one operation to a pending queue occurrence. */
  async updateQueue(itemId: MessageId, action: QueueAction): Promise<void> {
    const session = this.scopedSession('updateQueue')
    const result = await session.updateQueue(itemId, action)
    if (!result.ok) {
      if (
        action.kind === 'steer'
        && (result.error.code === 'session/steer-unavailable' || result.error.code === 'session/queue-item-not-found')
      ) return
      throw new Error(`conversation.updateQueue failed: ${result.error.code}: ${result.error.message}`)
    }
  }

  /** Cancel the scoped session's in-flight turn while preserving Queue (failures land in promptError and reject, as in send). */
  async cancel(intent?: 'detach' | 'stop-all'): Promise<void> {
    const session = this.scopedSession('cancel')
    const result = await session.cancel(intent)
    if (!result.ok) throw new Error(`conversation.cancel failed: ${result.error.code}: ${result.error.message}`)
  }

  /** Pull one older history page for the scoped Session. */
  async loadOlder(): Promise<void> {
    await this.scopedSession('loadOlder').loadOlder()
  }

  /** Resolve the caller scope's session face or throw on root contexts. */
  private scopedSession(op: string): SessionFace {
    const id = this.scopeId(op)
    const binding = this.requireSessions().binding(id)
    if (binding === undefined) throw new Error(`conversation.${op}: session "${id}" resolved no binding`)
    return binding.session
  }

  /** Read the caller's session scope tag via the sessions service; root contexts fail loud. */
  private scopeId(op: string): SessionId {
    const id = this.requireSessions().scopeOf(this.ctx)
    if (id === undefined) {
      throw new Error(`conversation.${op} requires a session scope — address one via ctx.sessions.scope(id).conversation`)
    }
    return id
  }

  private requireSessions(): ISessions {
    // Strict ctx.get, not the injection proxy: the scope-addressed pattern
    // reads the service off whatever context the tracker rebound.
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('conversation: sessions service unavailable')
    return sessions
  }

  /**
   * Settle one submission's draft attachments when its echo retires. Observed:
   * each image leaves the registry, handing its preview URL to the durable
   * image cache (seeded under the admitted reference so the transcript node
   * renders immediately while the cache reads canonical bytes) or revoking it
   * when the cache already holds that reference. Failed: nothing changes;
   * the ids stay registered for the composer's rail restore.
   */
  private settleSubmittedAttachments(
    sessionId: SessionId,
    attachments: readonly ComposerAttachment[],
    retirement: PendingSubmissionRetirement,
  ): void {
    if (retirement.reason !== 'observed') return
    const uiConversation = this.ctx.get('uiConversation')
    let observedIndex = 0
    for (const attachment of attachments) {
      const live = this.draftAttachments.get(attachment.id)
      const ref = retirement.attachments[observedIndex++]
      if (live === undefined) continue
      if (attachment.kind !== 'image') {
        this.releaseDraftAttachment(attachment.id)
        continue
      }
      if (attachment.attachment !== undefined) {
        // Restored images cite a durable reference; the session image cache
        // already owns their preview URL.
        this.draftAttachments.delete(attachment.id)
        continue
      }
      this.draftAttachments.delete(attachment.id)
      if (ref !== undefined && 'mediaType' in ref
        && uiConversation?.seedImageUrl(sessionId, ref, attachment.previewUrl) === true) continue
      revokePreview(attachment.previewUrl)
    }
  }

  /** Mark missing restored durable attachments unavailable so the restored draft renders removable chips. */
  private markUnavailableOnSendError(attachments: readonly ComposerAttachment[], error: unknown): void {
    if (!isUnavailableSendError(error)) return
    const explicitIds = missingAttachmentIds(error)
    const hasRestoredFile = attachments.some(
      attachment => attachment.kind === 'file' && attachment.attachment !== undefined,
    )
    for (const attachment of attachments) {
      if (attachment.kind === 'unavailable' || attachment.attachment === undefined) continue
      if (!this.draftAttachments.has(attachment.id)) continue
      if (explicitIds !== undefined) {
        if (!explicitIds.has(String(attachment.attachment.attachmentId))) continue
      } else if (hasRestoredFile && attachment.kind !== 'file') {
        continue
      }
      const ref = attachment.attachment
      this.draftAttachments.set(attachment.id, {
        kind: 'unavailable',
        id: attachment.id,
        attachment: ref,
        ...(ref.name === undefined || ref.name === '' ? {} : { name: ref.name }),
      })
    }
  }

  /** Canonical base64 wire form of one browser image file. */
  private async encodeImage(file: File): Promise<Omit<Extract<SubmitAttachment, { type: 'image' }>, 'type'>> {
    return {
      mediaType: imageMediaType(file.type),
      data: await base64ImageOf(file),
      ...(file.name === '' ? {} : { name: file.name }),
    }
  }
}

function imageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      throw new UnsupportedImageMediaTypeError(value)
  }
}

/**
 * Whether a browser-declared MIME selects the image draft path (all other files upload verbatim).
 * @param value - the browser's declared MIME type.
 * @returns whether the file is an accepted raster image.
 */
export function isImageMediaType(value: string): boolean {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function isUnavailableSendError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? error.code : undefined
  if (code !== 'session/attachment-invalid' && code !== 'subagent/attachment-invalid') return false
  const details = 'details' in error ? error.details : undefined
  if (typeof details !== 'object' || details === null || !('reason' in details)) return false
  const reason = details.reason
  return reason === 'ATTACHMENT_NOT_FOUND' || reason === 'ATTACHMENT_NOT_REFERENCED'
}

function missingAttachmentIds(error: unknown): ReadonlySet<string> | undefined {
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined
  const details = error.details
  if (typeof details !== 'object' || details === null) return undefined
  const ids = new Set<string>()
  if ('attachmentId' in details && typeof details.attachmentId === 'string' && details.attachmentId !== '') {
    ids.add(details.attachmentId)
  }
  if ('attachmentIds' in details && Array.isArray(details.attachmentIds)) {
    for (const id of details.attachmentIds) {
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  return ids.size > 0 ? ids : undefined
}

function revokePreview(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}
