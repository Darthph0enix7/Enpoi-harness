/**
 * Command Code request conversion: harness message content → the
 * `/alpha/generate` envelope.
 *
 * The endpoint validates top-level fields, so a minimal body is rejected:
 * `config` (object), `memory` (string), `taste`, `skills`, and
 * `permissionMode` must all be present (the CLI sends stubs; so do we).
 *
 * Ported from `@darthph0enix/commandcode-go-opencode-provider/src/convert.ts`
 * with three deliberate properties:
 * 1. media-type detection order is `mediaType → mimeType → media_type → the
 *    `data:` header → application/octet-stream` (checking only `mimeType`
 *    inlined raw base64 as text and produced ~1.5M-token requests);
 * 2. a binary image inside a tool result is hoisted out and re-emitted as a
 *    synthetic user message immediately after the tool message (the API
 *    accepts images only in user content), and user-attached images ride a
 *    per-request size budget (12 images / 16 MiB, 8 MiB per image) that keeps
 *    the newest and omits the oldest — the request's only image budget;
 * 3. text sanitization (embedded-base64 scrub, 200k cap) happens here, at the
 *    conversion seam, when the route has no keypool proxy in front of it
 *    (`sanitizeText` input). The default keypool route leaves it to the proxy
 *    so its forwarded bytes stay unchanged.
 *
 * @module dsh-enpoi-commandcode-provider/convert
 */

import { sanitizeText } from './sanitize.js'

/** One part-like object accepted from a caller (AI-SDK-shaped or harness-built). */
export interface CcInputPart {
  type: string
  text?: string
  /** opencode's serialiser spelling. */
  mediaType?: string
  /** older callers' spelling. */
  mimeType?: string
  /** snake_case spelling some callers use. */
  media_type?: string
  data?: string | Uint8Array
  url?: string
  image?: string | Uint8Array
  [key: string]: unknown
}

/** One input message; `content` is a plain string or part-like objects. */
export interface CcInputMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content: string | readonly CcInputPart[]
  /** Tool-role messages: provider-issued call id this message answers. */
  toolCallId?: string
  /** Tool-role messages: whether the tool invocation failed. */
  isError?: boolean
}

/** One declared tool, already in the Command Code wire shape. */
export interface CcTool {
  type: 'function'
  name: string
  description?: string
  input_schema: unknown
}

type CcUserContent = string | Array<{ type: string; [key: string]: unknown }>

type CcAssistantContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }

interface CcToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text'; value: string } | { type: 'error-text'; value: string }
}

type CcMessage =
  | { role: 'user'; content: CcUserContent }
  | { role: 'assistant'; content: CcAssistantContent[] }
  | { role: 'tool'; content: CcToolResultContent[] }

/** The complete `/alpha/generate` envelope. */
export interface CcEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CcMessage[]
    tools: CcTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    top_k?: number
    reasoning_effort?: string
  }
}

/** Caller-supplied inputs to {@link buildRequest}. */
export interface BuildRequestInput {
  model: string
  messages: readonly CcInputMessage[]
  tools?: readonly CcTool[]
  system?: string
  maxTokens?: number
  temperature?: number
  /** Exact, catalog-selected reasoning effort (never invented here). */
  reasoningEffort?: string
  /** Whether the target model accepts image input; comes from the catalog. */
  visionEnabled?: boolean
  /**
   * Run the keypool text sanitizer over message text (embedded-base64 scrub,
   * 200k cap). The pooled native route sets this because no keypool proxy
   * sanitizes the body downstream; the default keypool route leaves it unset
   * so the bytes it forwards are exactly what they have always been.
   */
  sanitizeText?: boolean
  /** Optional resolution hook for caller-shaped image parts (legacy callers). */
  resolveImage?: (part: CcInputPart) => string | undefined
  workingDir?: string
  now?: Date
}

/** Text transform applied at conversion: the sanitizer, or the identity for proxy-fronted routes. */
type TextScrub = (text: string) => string

/** No-op scrub for routes whose keypool proxy owns sanitization. */
const KEEP_TEXT: TextScrub = text => text

interface ForwardedImage {
  mediaType: string
  dataUri: string
}

interface ImageForwarder {
  enabled: boolean
  images: ForwardedImage[]
  seen: Set<string>
  bytes: number
}

/** Image forwarding budget per request (bounded pathological reads). */
const MAX_FORWARD_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_FORWARD_IMAGES_TOTAL = 12
const MAX_FORWARD_IMAGE_BYTES_TOTAL = 16 * 1024 * 1024

function createImageForwarder(enabled: boolean): ImageForwarder {
  return { enabled, images: [], seen: new Set<string>(), bytes: 0 }
}

/**
 * Per-part decision for user-attached images: the resolved data URI to send,
 * or null when the request budget omits the image.
 */
type UserImagePlan = Map<CcInputPart, string | null>

/** Resolve an image part to the data URI the wire would carry, if any. */
function resolvePartDataUri(
  part: CcInputPart,
  resolveImage: ((part: CcInputPart) => string | undefined) | undefined,
): string | undefined {
  const payload = part.data ?? part.url ?? part.image
  if (typeof payload === 'string' && payload.startsWith('data:')) return payload
  const resolved = resolveImage?.(part)
  if (resolved !== undefined && resolved.startsWith('data:')) return resolved
  if (payload === undefined) return undefined
  return toDataUri(payload, detectMediaType(part))
}

/**
 * Plan the request's user-attached images against the same per-image and
 * per-request budget the tool-image forwarder uses. Selection is newest-first:
 * walking the plan backwards keeps the newest images that fit and omits the
 * older ones, so a request bearing many historical screenshots still carries
 * the freshest context to a native multimodal model. Parts that cannot be
 * resolved inline are left out of the plan and reported by conversion with
 * their own reason.
 * @param messages - the request's messages, in wire order.
 * @param resolveImage - optional resolver for caller-shaped image parts.
 * @returns the per-part keep/omit decision.
 */
function planUserImages(
  messages: readonly CcInputMessage[],
  resolveImage: ((part: CcInputPart) => string | undefined) | undefined,
): UserImagePlan {
  const candidates: Array<{ part: CcInputPart; dataUri: string }> = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (!isRecord(part) || typeof part.type !== 'string') continue
      if (part.type !== 'file' && part.type !== 'image' && part.type !== 'media') continue
      if (!detectMediaType(part).startsWith('image/')) continue
      const dataUri = resolvePartDataUri(part, resolveImage)
      if (dataUri === undefined) continue
      candidates.push({ part, dataUri })
    }
  }
  const plan: UserImagePlan = new Map()
  let keptBytes = 0
  let keptCount = 0
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index]
    if (candidate === undefined) continue
    if (
      candidate.dataUri.length > MAX_FORWARD_IMAGE_BYTES
      || keptCount >= MAX_FORWARD_IMAGES_TOTAL
      || keptBytes + candidate.dataUri.length > MAX_FORWARD_IMAGE_BYTES_TOTAL
    ) {
      plan.set(candidate.part, null)
      continue
    }
    plan.set(candidate.part, candidate.dataUri)
    keptBytes += candidate.dataUri.length
    keptCount += 1
  }
  return plan
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Extract the mime type from a `data:<mime>;base64,<payload>` URI. */
function dataUriMime(dataUri: string): string | null {
  if (!dataUri.startsWith('data:')) return null
  const semi = dataUri.indexOf(';')
  const comma = dataUri.indexOf(',')
  if (semi === -1 || comma === -1 || semi > comma) return null
  return dataUri.slice(5, semi) || null
}

/**
 * Media type of a binary part, in the required detection order:
 * `mediaType → mimeType → media_type → the data: header → application/octet-stream`.
 * @param part - the part-like object.
 * @returns the resolved media type.
 */
export function detectMediaType(part: CcInputPart): string {
  const declared = part.mediaType ?? part.mimeType ?? part.media_type
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim()
  const payload = part.data ?? part.url ?? part.image
  if (typeof payload === 'string') {
    const mime = dataUriMime(payload)
    if (mime !== null) return mime
  }
  return 'application/octet-stream'
}

function byteLengthOf(data: unknown): number {
  if (typeof data === 'string') return data.length
  if (data instanceof Uint8Array) return data.byteLength
  return 0
}

function kilobytes(payloadLength: number): number {
  return Math.max(1, Math.round(payloadLength / 1024))
}

function toDataUri(payload: string | Uint8Array, mediaType: string): string | undefined {
  if (typeof payload === 'string') {
    if (payload.startsWith('data:')) return payload
    return `data:${mediaType};base64,${payload}`
  }
  if (payload instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(payload).toString('base64')}`
  }
  return undefined
}

function describeOmitted(part: CcInputPart, mediaType: string, reason: string): string {
  const bytes = byteLengthOf(part.data) || byteLengthOf(part.image) || byteLengthOf(part.url)
  const size = bytes > 0 ? `, ${kilobytes(bytes)} KB` : ''
  return `[image omitted: ${mediaType}${size} — ${reason}]`
}

/** A binary attachment that is not an image is summarised, never inlined. */
export function describeBinaryPart(part: CcInputPart): string {
  const mediaType = detectMediaType(part)
  const bytes = byteLengthOf(part.data) || byteLengthOf(part.image) || byteLengthOf(part.url)
  const size = bytes > 0 ? `, ${kilobytes(bytes)} KB` : ''
  return `[attachment omitted: ${mediaType}${size} — binary payloads are not inlined into text]`
}

function isBinaryLikePart(part: CcInputPart): boolean {
  if (part.type === 'file' || part.type === 'image' || part.type === 'media') return true
  if (typeof part.data === 'string' && part.data.startsWith('data:')) return true
  if (typeof part.url === 'string' && part.url.startsWith('data:')) return true
  return false
}

/**
 * Convert one binary user part. An image becomes the vendor CLI's own wire
 * shape (`{type:"image", image:"data:...", mimeType}`); anything that cannot
 * be transported becomes a short note, never text-inlined payload. The
 * request plan decides budget omissions before any resolution work repeats.
 * @param part - the user content part.
 * @param parts - accumulator for the converted wire parts.
 * @param forwarder - the request's tool-image forwarder (vision flag).
 * @param resolveImage - optional resolver for caller-shaped image parts.
 * @param plan - the per-request user-image keep/omit decision.
 * @returns whether the part became multimodal image content.
 */
function convertBinaryPart(
  part: CcInputPart,
  parts: Array<{ type: string; [key: string]: unknown }>,
  forwarder: ImageForwarder,
  resolveImage: ((part: CcInputPart) => string | undefined) | undefined,
  plan: UserImagePlan,
): boolean {
  const mediaType = detectMediaType(part)
  const payload = part.data ?? part.url ?? part.image

  if (mediaType.startsWith('image/')) {
    if (!forwarder.enabled) {
      parts.push({ type: 'text', text: describeOmitted(part, mediaType, 'this model does not accept image input') })
      return false
    }
    const planned = plan.get(part)
    if (planned === null) {
      parts.push({
        type: 'text',
        text: describeOmitted(
          part,
          mediaType,
          'per-request image budget reached — older images are omitted and the newest are kept',
        ),
      })
      return false
    }
    if (planned !== undefined) {
      parts.push({ type: 'image', image: planned, mimeType: mediaType })
      return true
    }
    const resolved = typeof payload === 'string' && payload.startsWith('data:')
      ? payload
      : resolveImage?.(part)
    const dataUri = resolved ?? (payload === undefined ? undefined : toDataUri(payload, mediaType))
    if (dataUri !== undefined && dataUri.startsWith('data:')) {
      parts.push({ type: 'image', image: dataUri, mimeType: mediaType })
      return true
    }
    parts.push({
      type: 'text',
      text: describeOmitted(
        part,
        mediaType,
        payload === undefined
          ? 'no payload present'
          : 'the API accepts inline data URIs only, not remote URLs',
      ),
    })
    return false
  }

  if (mediaType.startsWith('text/') && typeof payload === 'string' && !payload.startsWith('data:')) {
    parts.push({ type: 'text', text: payload })
    return false
  }

  parts.push({ type: 'text', text: describeBinaryPart(part) })
  return false
}

function convertUserContent(
  content: string | readonly CcInputPart[],
  forwarder: ImageForwarder,
  resolveImage: ((part: CcInputPart) => string | undefined) | undefined,
  plan: UserImagePlan,
  scrub: TextScrub,
): CcUserContent {
  if (typeof content === 'string') return scrub(content)
  const parts: Array<{ type: string; [key: string]: unknown }> = []
  let hasMultimodal = false
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== 'string') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'file' || part.type === 'image' || part.type === 'media') {
      if (convertBinaryPart(part, parts, forwarder, resolveImage, plan)) hasMultimodal = true
      continue
    }
    if (isBinaryLikePart(part)) parts.push({ type: 'text', text: describeBinaryPart(part) })
  }
  // The scrub applies to exactly the text the wire receives: once over the
  // joined string a text-only message collapses to, or per part when the
  // message stays multimodal and each text part keeps its own slot.
  if (!hasMultimodal) return scrub(parts.map(part => part.type === 'text' ? String(part.text) : '').join('\n'))
  return parts.map(part => part.type === 'text' && typeof part.text === 'string'
    ? { ...part, text: scrub(part.text) }
    : part)
}

function imageFingerprint(dataUri: string): string {
  return `${dataUri.length}:${dataUri.slice(0, 64)}:${dataUri.slice(-64)}`
}

/**
 * Decide what happens to one binary tool-result part: images ride the
 * forwarder (re-emitted as a user message after the tool message), everything
 * else — and every over-budget image — becomes a short note.
 */
function handleBinaryPart(part: CcInputPart, forwarder: ImageForwarder): string {
  const mediaType = detectMediaType(part)
  const raw = part.data ?? part.image ?? part.url
  if (!forwarder.enabled || !mediaType.startsWith('image/')) return describeBinaryPart(part)
  const dataUri = typeof raw === 'string' && raw.startsWith('data:')
    ? raw
    : raw === undefined ? undefined : toDataUri(raw, mediaType)
  if (dataUri === undefined || !dataUri.startsWith('data:')) return describeBinaryPart(part)
  if (dataUri.length > MAX_FORWARD_IMAGE_BYTES) {
    return `[image omitted: ${mediaType}, ${kilobytes(dataUri.length)} KB exceeds the `
      + `${Math.round(MAX_FORWARD_IMAGE_BYTES / 1024 / 1024)} MB per-image forward limit]`
  }
  const fingerprint = imageFingerprint(dataUri)
  if (forwarder.seen.has(fingerprint)) {
    return `[identical ${mediaType} image already attached earlier in this conversation — not re-sent]`
  }
  if (
    forwarder.images.length >= MAX_FORWARD_IMAGES_TOTAL
    || forwarder.bytes + dataUri.length > MAX_FORWARD_IMAGE_BYTES_TOTAL
  ) {
    return `[image omitted: per-request image forward budget reached — ${forwarder.images.length} image(s), `
      + `${Math.round(forwarder.bytes / 1024 / 1024)} MB already forwarded]`
  }
  forwarder.seen.add(fingerprint)
  forwarder.bytes += dataUri.length
  forwarder.images.push({ mediaType, dataUri })
  return `[${mediaType} image, ${kilobytes(dataUri.length)} KB — attached as a user message below]`
}

/**
 * One tool-result content part as text. Parts are joined first and the scrub
 * runs once on the joined output, so the 200k cap sees the value the wire
 * receives rather than each fragment in isolation.
 */
function toolResultText(part: CcInputPart, forwarder: ImageForwarder): string {
  if (part.type === 'text' && typeof part.text === 'string') return part.text
  if (part.type === 'file' || part.type === 'image' || part.type === 'media' || isBinaryLikePart(part)) {
    return handleBinaryPart(part, forwarder)
  }
  try {
    return JSON.stringify(part) ?? ''
  } catch {
    return '[unserializable tool output omitted]'
  }
}

/** Parse an assistant tool-call's raw JSON argument string. */
function parseToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson)
  } catch {
    return argumentsJson
  }
}

/** The declared tool name for one call id, from the assistant history. */
function toolNamesById(messages: readonly CcInputMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call' && typeof part.toolName === 'string' && typeof part.toolCallId === 'string') {
        names.set(part.toolCallId, part.toolName)
      }
    }
  }
  return names
}

/**
 * Build the complete Command Code envelope. Asynchronous callers resolve
 * image payloads before calling this; the conversion itself is pure.
 * @param input - model, messages, tools, and generation knobs.
 * @returns the envelope to POST to `/alpha/generate`.
 */
export function buildRequest(input: BuildRequestInput): CcEnvelope {
  const scrub = input.sanitizeText === true ? sanitizeText : KEEP_TEXT
  const forwarder = createImageForwarder(input.visionEnabled !== false)
  const userImagePlan = forwarder.enabled
    ? planUserImages(input.messages, input.resolveImage)
    : new Map<CcInputPart, string | null>()
  const names = toolNamesById(input.messages)
  const messages: CcMessage[] = []
  let system = input.system ?? ''

  for (const message of input.messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') {
        system += (system === '' ? '' : '\n\n') + message.content
      } else {
        const text = message.content
          .filter(part => part.type === 'text' && typeof part.text === 'string')
          .map(part => String(part.text))
          .join('\n\n')
        if (text !== '') system += (system === '' ? '' : '\n\n') + text
      }
      continue
    }
    if (message.role === 'developer') continue

    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: convertUserContent(message.content, forwarder, input.resolveImage, userImagePlan, scrub),
      })
      continue
    }

    if (message.role === 'assistant') {
      const parts: CcAssistantContent[] = []
      if (typeof message.content !== 'string') {
        for (const part of message.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: scrub(part.text) })
          } else if (part.type === 'reasoning' && typeof part.text === 'string') {
            parts.push({ type: 'reasoning', text: scrub(part.text) })
          } else if (part.type === 'tool-call') {
            parts.push({
              type: 'tool-call',
              toolCallId: String(part.toolCallId ?? ''),
              toolName: String(part.toolName ?? ''),
              input: parseToolInput(String(part.arguments ?? '{}')),
            })
          }
        }
      }
      if (parts.length > 0) messages.push({ role: 'assistant', content: parts })
      continue
    }

    // tool
    const results: CcToolResultContent[] = []
    const callId = message.toolCallId ?? ''
    const value = scrub(typeof message.content === 'string'
      ? message.content
      : message.content.map(part => toolResultText(part, forwarder)).join('\n'))
    results.push({
      type: 'tool-result',
      toolCallId: callId,
      toolName: names.get(callId) ?? 'unknown',
      output: message.isError === true
        ? { type: 'error-text', value }
        : { type: 'text', value },
    })
    messages.push({ role: 'tool', content: results })

    // Images cannot ride inside a tool result: re-emit them as the very next
    // user message, exactly as the vendor CLI's hoistToolResultImages does.
    if (forwarder.images.length > 0) {
      const pending = forwarder.images.splice(0, forwarder.images.length)
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'Images returned by the tool call(s) above:' },
          ...pending.map(image => ({ type: 'image', image: image.dataUri, mimeType: image.mediaType })),
        ],
      })
    }
  }

  const params: CcEnvelope['params'] = {
    model: input.model,
    messages,
    tools: [...(input.tools ?? [])],
    system,
    max_tokens: input.maxTokens ?? 16384,
    stream: true,
    ...input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort },
    ...input.temperature === undefined ? {} : { temperature: input.temperature },
  }
  const now = input.now ?? new Date()
  return {
    config: {
      workingDir: input.workingDir ?? process.cwd(),
      date: now.toISOString().split('T')[0] ?? '',
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}
