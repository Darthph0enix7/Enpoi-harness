/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { contentHasImage, IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, projectOffloadedImages, requestImageHandleText, requiredImageOffload } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message, RequestMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  ImageRequestTarget,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES, DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET } from './config.ts'

/** Join the text blocks of a harness message. */
function flattenText(message: RequestMessage): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}


/** Recover the pi-ai toolResult message for one harness tool-role message. */
function toolResultOf(
  message: Extract<Message, { role: 'tool' }>,
  toolNames: Map<ToolCallId, string>,
  content: string | (TextContent | ImageContent)[],
): PiMessage {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string'
      ? [{ type: 'text', text: content || '(no output)' }]
      : content,
    isError: message.isError ?? false,
    timestamp: 0,
  }
}

/** Reject unsupported roles, tool-change blocks, and image roles before replay or image offloading. */
function assertSupportedHistory(messages: readonly RequestMessage[]): void {
  for (const message of messages) {
    // Developer history is persisted for V4; provider serialization is intentionally deferred.
    if (message.role === 'developer') throw new LlmError('Developer messages are not supported yet', 'UNSUPPORTED_CONTENT')
    if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new LlmError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

function userContent(
  blocks: readonly ContentBlock[],
  requestImages: ReadonlyMap<AttachmentId, RequestImageAttachment>,
  resolveImageAccess: ImageAttachmentAccessResolver,
): string | (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId) as RequestImageAttachment
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

/** Oldest-first retained image occurrences; one shared attachment repeats per occurrence. */
function retainedImageRefs(messages: readonly RequestMessage[]): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'image' && block.offloaded !== true) refs.push(block.attachment)
    }
  }
  return refs
}

/** Request payload length of one encoded version at the route's `base64` representation. */
function requestPayloadBytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** Materialise one ref per unique attachment id into `versions`, leaving present entries untouched. */
async function readRequestVersions(
  refs: readonly ImageAttachmentRef[],
  attachments: AttachmentStore,
  budget: PiImageRequestBudget,
  versions: Map<AttachmentId, RequestImageAttachment>,
  signal?: AbortSignal,
): Promise<void> {
  const missing: ImageAttachmentRef[] = []
  for (const ref of refs) {
    if (!versions.has(ref.attachmentId)) missing.push(ref)
  }
  const unique = [...new Map(missing.map(ref => [ref.attachmentId, ref])).values()]
  const prepared = await Promise.all(unique.map(
    ref => attachments.readImageRequest(ref, requestImageTarget(ref, budget), signal),
  ))
  for (const [index, ref] of unique.entries()) {
    versions.set(ref.attachmentId, prepared[index] as RequestImageAttachment)
  }
}

/** Request versions plus the oldest-first occurrences an over-budget request must still offload. */
interface PreparedRequestImages {
  /** Request versions for every retained attachment; empty when `offloadImages` is nonzero. */
  versions: Map<AttachmentId, RequestImageAttachment>
  /** Additional oldest retained occurrences to offload; zero when the request fits. */
  offloadImages: number
}

/**
 * Prepare request versions without materialising occurrences the request cannot
 * keep. Stored reference sizes (already known, no I/O) size the first parallel
 * batch to every occurrence that could still fit; the newest-first walk then
 * stops at the first occurrence whose exact request payload would exceed the
 * bound, so the oldest occurrences named for offload are never read,
 * normalised, or encoded. Without a bound every retained occurrence is
 * materialised.
 */
async function prepareRequestImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore,
  budget: PiImageRequestBudget,
  maxRequestImageBytes: number | undefined,
  signal?: AbortSignal,
): Promise<PreparedRequestImages> {
  const occurrences = retainedImageRefs(messages)
  if (maxRequestImageBytes === undefined) {
    const versions = new Map<AttachmentId, RequestImageAttachment>()
    await readRequestVersions(occurrences, attachments, budget, versions, signal)
    return { versions, offloadImages: 0 }
  }
  // Stored bytes are an upper estimate for transformed versions, so the stored
  // offload prefix cannot be materialised speculatively without dropping an
  // image that would have fit; it only bounds how many occurrences a first
  // batch may still retain.
  const storedOffload = requiredImageOffload(
    messages,
    { representation: 'base64', maxBytes: maxRequestImageBytes },
    block => block.attachment.bytes,
  )
  const total = occurrences.length
  const firstBatch = Math.min(total, total - storedOffload + 1)
  const versions = new Map<AttachmentId, RequestImageAttachment>()
  await readRequestVersions(occurrences.slice(total - firstBatch), attachments, budget, versions, signal)
  let payloadBytes = 0
  for (let index = total - 1; index >= 0; index -= 1) {
    const ref = occurrences[index] as ImageAttachmentRef
    let version = versions.get(ref.attachmentId)
    if (version === undefined) {
      // The exact walk crossed the stored-estimate batch; the remaining older
      // occurrences are read together before the walk continues deliberately.
      await readRequestVersions(occurrences.slice(0, index + 1), attachments, budget, versions, signal)
      version = versions.get(ref.attachmentId) as RequestImageAttachment
    }
    if (payloadBytes + requestPayloadBytes(version.bytes) > maxRequestImageBytes) {
      return { versions: new Map(), offloadImages: index + 1 }
    }
    payloadBytes += requestPayloadBytes(version.bytes)
  }
  return { versions, offloadImages: 0 }
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  // Deferred definitions are persisted for V4; provider loading is intentionally deferred.
  if (options.tools?.some(tool => tool.deferLoading === true)) {
    throw new LlmError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')
  }
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** The request split into pi-ai's single `systemPrompt` slot and the history that converts to `messages`. */
interface SystemPromptSplit {
  /** Text for pi-ai's `systemPrompt`; `undefined` sends no system prompt. */
  systemPrompt: string | undefined
  /** History messages that convert to pi-ai `messages`. */
  messages: readonly RequestMessage[]
}

/**
 * Select the pi-ai `systemPrompt` source shared by both conversion paths.
 * `options.system` wins when defined and every history message converts,
 * including a leading `system` message, which then folds into a `user`
 * message. Otherwise a leading `system` history message supplies the prompt
 * and leaves the converted history; empty leading text sends no prompt.
 */
function splitSystemPrompt(options: GenerateOptions): SystemPromptSplit {
  if (options.system !== undefined) return { systemPrompt: options.system, messages: options.messages }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') return { systemPrompt: undefined, messages: options.messages }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(systemPrompt: string | undefined, options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...systemPrompt !== undefined ? { systemPrompt } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function appendAssistant(
  message: Extract<Message, { role: 'assistant' }>,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  onReplayDegrade?: (reason: string) => void,
): void {
  const assistant = toPiAssistant(message, onReplayDegrade)
  for (const block of assistant.content) {
    if (block.type === 'toolCall') toolNames.set(brandString<ToolCallId>(block.id), block.name)
  }
  messages.push(assistant)
}

/** Append the system and assistant roles both context builders treat identically; true when consumed. */
function appendSystemOrAssistant(
  message: RequestMessage,
  messages: PiMessage[],
  toolNames: Map<ToolCallId, string>,
  onReplayDegrade?: (reason: string) => void,
): boolean {
  if (message.role === 'system') {
    // pi-ai has a single systemPrompt slot; a system message that did not
    // supply it folds into a user message to preserve order.
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
    return true
  }
  if (message.role === 'assistant') {
    appendAssistant(message, messages, toolNames, onReplayDegrade)
    return true
  }
  return false
}

function textOnlyContext(options: GenerateOptions, onReplayDegrade?: (reason: string) => void): PiContext {
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []
  for (const message of split.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, flattenText(message)))
      continue
    }
    messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
  }
  return piContext(split.systemPrompt, options, messages)
}

/** Inputs that bind deterministic request images to one current tool execution world. */
export interface PiImageRequestContext {
  /** Durable provider that resolves request-image bytes and provider-owned host objects. */
  attachments: AttachmentStore
  /** Resolve current tool access separately from deterministic request-image versions. */
  resolveImageAccess: ImageAttachmentAccessResolver
  /** Request-level bound on the base64-encoded payload of retained images; omission leaves the bound unchecked. */
  maxRequestImageBytes?: number
  /** Route pixel and raw encoded-byte budgets. */
  requestImagePolicy?: PiImageRequestBudget
}

/** Per-route budgets from which each request image's target is derived. */
export interface PiImageRequestBudget {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Encoded-byte target for one request image. */
  maxBytes: number
}

/** Deterministic request target for one source under the route budgets. */
function requestImageTarget(ref: ImageAttachmentRef, budget: PiImageRequestBudget): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes }
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system`, else a leading `system` message, maps to pi-ai's single `systemPrompt` slot.
 * @param images - absent; selects the synchronous conversion.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 * @throws {LlmError} `UNSUPPORTED_CONTENT` for images in any history role, including a leading system message.
 */
export function toPiContext(
  options: GenerateOptions,
  images?: undefined,
  onReplayDegrade?: (reason: string) => void,
): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls. Image
 * occurrences the surface marks offloaded become text placeholders; when the
 * retained occurrences' exact base64 payload still exceeds
 * `maxRequestImageBytes`, the call fails with `IMAGE_OFFLOAD_REQUIRED` naming
 * how many more oldest occurrences must be offloaded.
 * @param options - the harness request; `options.system`, else a leading `system` message, maps to pi-ai's single `systemPrompt` slot.
 * @param images - attachment provider, current path resolver, and request limits.
 * @param onReplayDegrade - forwarded to {@link toPiAssistant} for each assistant message.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(
  options: GenerateOptions,
  images: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext>
export function toPiContext(
  options: GenerateOptions,
  images?: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
): PiContext | Promise<PiContext> {
  return images === undefined
    ? textOnlyContext(options, onReplayDegrade)
    : toPiContextWithImages(options, images, onReplayDegrade)
}

async function toPiContextWithImages(
  options: GenerateOptions,
  images: PiImageRequestContext,
  onReplayDegrade?: (reason: string) => void,
): Promise<PiContext> {
  const { attachments, resolveImageAccess, maxRequestImageBytes } = images
  const requestImagePolicy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const bound = maxRequestImageBytes
  const prepared = await prepareRequestImages(
    split.messages,
    attachments,
    requestImagePolicy,
    bound,
    options.signal,
  )
  if (prepared.offloadImages > 0 && bound !== undefined) {
    throw new LlmError(
      `pi-ai request images exceed the ${bound}-byte base64 bound; ${prepared.offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages: prepared.offloadImages },
    )
  }
  const requestImages = prepared.versions
  const exactMessages = projectOffloadedImages(
    split.messages,
    ref => offloadedImageText(ref, resolveImageAccess(ref)),
  )
  const toolNames = new Map<ToolCallId, string>()
  const messages: PiMessage[] = []

  for (const message of exactMessages) {
    if (appendSystemOrAssistant(message, messages, toolNames, onReplayDegrade)) continue
    if (message.role === 'tool') {
      messages.push(toolResultOf(message, toolNames, userContent(message.content, requestImages, resolveImageAccess)))
      continue
    }
    const content = userContent(message.content, requestImages, resolveImageAccess)
    messages.push({ role: 'user', content, timestamp: 0 })
  }

  return piContext(split.systemPrompt, options, messages)
}
