/**
 * Bounded native-media wire planning for pi-ai protocols.
 *
 * The harness log stores files as durable {@link FileAttachmentRef} values and
 * pi-ai context only carries text and images. This module is the deliberately
 * isolated first step of native PDF/audio/video support: it validates real
 * bytes, produces a deterministic per-occurrence text sentinel that request
 * assembly can place where the file block was, and turns that sentinel into a
 * provider-native content part in pi-ai's `onPayload` hook.
 *
 * Nothing here reads the filesystem, appends session events, chooses a model
 * capability, or sends a request. A caller must explicitly resolve one model +
 * protocol + MIME list and inject a byte reader. When any check fails, the
 * error is raised before a payload exists, so unsupported media never reaches
 * the network.
 *
 * @module dsh-llm-pi-ai/native-media
 */

import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Wire protocols whose native-media encoding this module understands. */
export type NativeMediaProtocol = 'openai-completions' | 'anthropic-messages' | 'openai-responses'

/** Provider-neutral media shape derived from the filename extension and verified magic. */
export type NativeMediaKind = 'pdf' | 'audio' | 'video'

/** Audio container formats accepted by `input_audio.format`. */
export type NativeAudioFormat = 'wav' | 'mp3' | 'ogg' | 'flac'

/** Video container formats accepted by a `video_url` data URL. */
export type NativeVideoFormat = 'mp4' | 'webm'

/** MIME types this module can emit; each maps to one verified file signature. */
export type NativeMediaMimeType =
  | 'application/pdf'
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/flac'
  | 'video/mp4'
  | 'video/webm'

/** Exact wire format carried by one planned native media part. */
export type NativeMediaFormat = 'pdf' | NativeAudioFormat | NativeVideoFormat

/** Stable machine codes for rejected plans and payload patches. */
export type NativeMediaErrorCode =
  | 'INVALID_LIMIT'
  | 'INVALID_OCCURRENCE'
  | 'DUPLICATE_OCCURRENCE'
  | 'INVALID_PLAN'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNSUPPORTED_MEDIA'
  | 'MEDIA_TYPE_MISMATCH'
  | 'BYTE_LENGTH_MISMATCH'
  | 'FILE_TOO_LARGE'
  | 'AGGREGATE_TOO_LARGE'
  | 'ENCODED_FILE_TOO_LARGE'
  | 'ENCODED_AGGREGATE_TOO_LARGE'
  | 'PLACEHOLDER_MISSING'
  | 'PLACEHOLDER_DUPLICATED'
  | 'PLACEHOLDER_UNCONSUMED'
  | 'SENTINEL_COLLISION'
  | 'PAYLOAD_TOO_LARGE'

/** A rejected native-media plan or payload patch. */
export class NativeMediaError extends Error {
  /** Stable machine code callers may branch on. */
  readonly code: NativeMediaErrorCode

  /**
   * Create one native-media rejection.
   * @param code - stable machine code.
   * @param message - human-readable detail naming the offending file or token.
   */
  constructor(code: NativeMediaErrorCode, message: string) {
    super(message)
    this.name = 'NativeMediaError'
    this.code = code
  }
}

/**
 * Hard bounds applied before any native part is produced. Raw limits count
 * decoded file bytes; encoded limits count the exact UTF-8 byte length of the
 * JSON-serialized provider-native part, including data prefixes and JSON
 * escaping in the filename.
 */
export interface NativeMediaLimits {
  /** Maximum decoded bytes for one occurrence. */
  readonly maxFileBytes: number
  /** Maximum decoded bytes across every occurrence in the plan. */
  readonly maxTotalBytes: number
  /** Maximum bytes of `JSON.stringify(encodeNativeMediaPart(...))` for one occurrence. */
  readonly maxEncodedFileBytes: number
  /** Maximum sum of serialized native-part bytes across every occurrence. */
  readonly maxEncodedTotalBytes: number
}

/** One durable file occurrence and its position in the harness request history. */
export interface NativeMediaOccurrence {
  /** Verbatim durable file reference; its byte count is verified against the source. */
  readonly attachment: FileAttachmentRef
  /** Zero-based harness message index. */
  readonly messageIndex: number
  /** Zero-based content-block index inside that message. */
  readonly blockIndex: number
}

/** Explicit per-model acceptance policy; callers resolve it from their own catalog. */
export interface NativeMediaCapability {
  /** pi-ai wire protocol selected for this model. */
  readonly protocol: NativeMediaProtocol
  /** MIME types this exact model may receive natively. */
  readonly mimeTypes: readonly NativeMediaMimeType[]
}

/** Injected byte source. Implementations must stop when the signal aborts. */
export type NativeMediaReader = (
  attachment: FileAttachmentRef,
  signal: AbortSignal | undefined,
) => AsyncIterable<Uint8Array>

/** Inputs to {@link buildNativeMediaPlan}. */
export interface NativeMediaPlanRequest {
  /** Explicit model + protocol acceptance; never inferred from an endpoint. */
  readonly capability: NativeMediaCapability
  /** Durable file occurrences, normally only from user messages. */
  readonly occurrences: readonly NativeMediaOccurrence[]
  /** Injected readable source; this module never opens a filesystem path itself. */
  readonly readFile: NativeMediaReader
  /** Raw and encoded byte bounds. */
  readonly limits: NativeMediaLimits
  /** Cancels reads and rejects the plan before any payload exists. */
  readonly signal?: AbortSignal
}

/** One fully read, validated occurrence ready for wire encoding. */
export interface NativeMediaFilePlan {
  /** Durable reference the bytes were verified against. */
  readonly attachment: FileAttachmentRef
  /** Zero-based harness message index. */
  readonly messageIndex: number
  /** Zero-based content-block index inside that message. */
  readonly blockIndex: number
  /** Exact text that request assembly must place where the file block was. */
  readonly token: string
  /** Media shape derived from the filename extension and verified magic. */
  readonly kind: NativeMediaKind
  /** MIME type accepted by the model and implied by the extension. */
  readonly mimeType: NativeMediaMimeType
  /** Audio/video container format, or `pdf`. */
  readonly format: NativeMediaFormat
  /** Display filename carried by wire formats that preserve it. */
  readonly filename: string
  /** Verified decoded byte length. */
  readonly bytes: number
  /** Canonical base64 of the exact bytes; computed once at plan time. */
  readonly base64: string
  /** Exact UTF-8 bytes of the serialized provider-native part. */
  readonly encodedBytes: number
}

/** Completed plan: validated files plus aggregate accounting. */
export interface NativeMediaPlan {
  /** Protocol the files were validated for. */
  readonly protocol: NativeMediaProtocol
  /** One entry per occurrence, in request order, with a unique sentinel. */
  readonly files: readonly NativeMediaFilePlan[]
  /** Sum of verified decoded bytes. */
  readonly rawBytes: number
  /** Sum of exact serialized native-part bytes. */
  readonly encodedBytes: number
}

/** Optional enforcement for one payload patch. */
export interface NativeMediaPayloadPatchOptions {
  /**
   * Maximum UTF-8 bytes of `JSON.stringify` over the complete modified body,
   * including tools, images, history, and all unrelated fields. Omitted means
   * no payload cap; the route owner supplies one explicitly.
   */
  readonly maxPayloadBytes?: number
}

/** Provider-native content part emitted by {@link encodeNativeMediaPart}. */
export type NativeMediaPart =
  | { readonly type: 'file'; readonly file: { readonly filename: string; readonly file_data: string } }
  | { readonly type: 'input_audio'; readonly input_audio: { readonly data: string; readonly format: NativeAudioFormat } }
  | { readonly type: 'video_url'; readonly video_url: { readonly url: string } }
  | { readonly type: 'document'; readonly source: { readonly type: 'base64'; readonly media_type: 'application/pdf'; readonly data: string } }

interface ResolvedMedia {
  readonly kind: NativeMediaKind
  readonly mimeType: NativeMediaMimeType
  readonly format: NativeMediaFormat
}

const MEDIA_BY_EXTENSION: Readonly<Record<string, ResolvedMedia>> = Object.freeze({
  pdf: { kind: 'pdf', mimeType: 'application/pdf', format: 'pdf' },
  wav: { kind: 'audio', mimeType: 'audio/wav', format: 'wav' },
  mp3: { kind: 'audio', mimeType: 'audio/mpeg', format: 'mp3' },
  flac: { kind: 'audio', mimeType: 'audio/flac', format: 'flac' },
  ogg: { kind: 'audio', mimeType: 'audio/ogg', format: 'ogg' },
  mp4: { kind: 'video', mimeType: 'video/mp4', format: 'mp4' },
  webm: { kind: 'video', mimeType: 'video/webm', format: 'webm' },
})

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Read one canonical base64 character.
 * @param index - six-bit value in the range 0..63.
 * @returns the corresponding alphabet character.
 */
function base64Char(index: number): string {
  return BASE64_ALPHABET[index] as string
}

/**
 * Resolve a filename extension to the only media shape it may claim.
 * @param filename - sanitized attachment display name.
 * @returns the claimed media shape, or undefined when the extension is absent or unsupported.
 */
function mediaFromFilename(filename: string): ResolvedMedia | undefined {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return undefined
  return MEDIA_BY_EXTENSION[filename.slice(dot + 1).toLowerCase()]
}

/**
 * Compare one ASCII signature without decoding the whole buffer.
 * @param bytes - complete file bytes.
 * @param offset - byte offset of the signature.
 * @param signature - ASCII signature to match.
 * @returns whether the buffer contains exactly that signature at the offset.
 */
function hasAscii(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature.charCodeAt(index)) return false
  }
  return true
}

/**
 * Verify the fixed signature or container marker that proves a declared type.
 * Arbitrary bytes never acquire an audio or video identity by filename alone.
 * @param mimeType - MIME type claimed by the filename extension.
 * @param bytes - complete file bytes.
 * @returns whether the bytes match that MIME type's required signature.
 */
function hasMagic(mimeType: NativeMediaMimeType, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'application/pdf':
      return hasAscii(bytes, 0, '%PDF')
    case 'audio/wav':
      return hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WAVE')
    case 'audio/mpeg': {
      if (hasAscii(bytes, 0, 'ID3')) return true
      const second = bytes[1]
      return bytes[0] === 0xff && second !== undefined && (second & 0xe0) === 0xe0
    }
    case 'audio/flac':
      return hasAscii(bytes, 0, 'fLaC')
    case 'audio/ogg':
      return hasAscii(bytes, 0, 'OggS')
    case 'video/mp4':
      return hasAscii(bytes, 4, 'ftyp')
    case 'video/webm':
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  }
}

/**
 * Encode bytes as canonical, unpadded-line base64 exactly once per plan entry.
 * @param bytes - complete verified file bytes.
 * @returns canonical base64 without line breaks.
 */
function encodeBase64(bytes: Uint8Array): string {
  let output = ''
  let index = 0
  // The loop and remainder conditions prove every index below is in bounds.
  for (; index + 2 < bytes.length; index += 3) {
    const triple = ((bytes[index] as number) << 16)
      | ((bytes[index + 1] as number) << 8)
      | (bytes[index + 2] as number)
    output += base64Char((triple >> 18) & 63)
      + base64Char((triple >> 12) & 63)
      + base64Char((triple >> 6) & 63)
      + base64Char(triple & 63)
  }
  const remaining = bytes.length - index
  if (remaining === 1) {
    const triple = (bytes[index] as number) << 16
    return output + base64Char((triple >> 18) & 63)
      + base64Char((triple >> 12) & 63)
      + '=='
  }
  if (remaining === 2) {
    const triple = ((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8)
    return output + base64Char((triple >> 18) & 63)
      + base64Char((triple >> 12) & 63)
      + base64Char((triple >> 6) & 63)
      + '='
  }
  return output
}

/**
 * Count UTF-8 bytes without retaining the encoded filename.
 * @param value - display filename.
 * @returns exact UTF-8 byte length.
 */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Count the exact UTF-8 bytes of one JSON-serialized value.
 * @param value - value that `JSON.stringify` always turns into a string here.
 * @returns UTF-8 byte length of the serialized body.
 */
function jsonByteLength(value: unknown): number {
  return utf8Length(JSON.stringify(value))
}

/**
 * Reject a limit that is not a non-negative safe integer.
 * @param name - limit field name used in the error detail.
 * @param value - candidate limit.
 * @returns nothing when the limit is valid.
 */
function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeMediaError('INVALID_LIMIT', `${name} must be a non-negative safe integer`)
  }
}

/**
 * Reject an occurrence index that is not a non-negative safe integer.
 * @param name - index field name used in the error detail.
 * @param value - candidate index.
 * @returns nothing when the index is valid.
 */
function assertIndex(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NativeMediaError('INVALID_OCCURRENCE', `${name} must be a non-negative safe integer`)
  }
}

/**
 * Read one occurrence under the raw per-file bound without trusting the reader.
 * @param request - plan inputs supplying the reader, limits, and cancellation signal.
 * @param attachment - durable reference whose byte count must be matched.
 * @returns the complete verified bytes.
 */
async function readOccurrence(
  request: NativeMediaPlanRequest,
  attachment: FileAttachmentRef,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  let completed = false
  const iterator = request.readFile(attachment, request.signal)[Symbol.asyncIterator]()
  try {
    while (true) {
      request.signal?.throwIfAborted()
      const next = await iterator.next()
      if (next.done) {
        completed = true
        break
      }
      request.signal?.throwIfAborted()
      const chunk = next.value
      total += chunk.byteLength
      if (total > attachment.bytes) {
        throw new NativeMediaError(
          'BYTE_LENGTH_MISMATCH',
          `${attachment.name} produced more than the ${attachment.bytes} bytes in its durable reference`,
        )
      }
      chunks.push(chunk)
    }
  } finally {
    if (!completed) await iterator.return?.()
  }
  request.signal?.throwIfAborted()
  if (total !== attachment.bytes) {
    throw new NativeMediaError(
      'BYTE_LENGTH_MISMATCH',
      `${attachment.name} produced ${total} bytes but its durable reference records ${attachment.bytes}`,
    )
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Build a pure native-media plan from durable file occurrences.
 *
 * All validation happens before a request exists: protocol limits, explicit
 * per-model MIME acceptance, filename extension, byte count, magic, and both
 * raw and encoded size bounds. The returned sentinels are unique per message
 * occurrence and deterministic across retries.
 * @param request - capability, occurrences, injected reader, limits, and signal.
 * @returns validated files ready for sentinel placement and payload patching.
 */
export async function buildNativeMediaPlan(request: NativeMediaPlanRequest): Promise<NativeMediaPlan> {
  request.signal?.throwIfAborted()
  const { capability, limits } = request
  assertLimit('maxFileBytes', limits.maxFileBytes)
  assertLimit('maxTotalBytes', limits.maxTotalBytes)
  assertLimit('maxEncodedFileBytes', limits.maxEncodedFileBytes)
  assertLimit('maxEncodedTotalBytes', limits.maxEncodedTotalBytes)
  if (capability.protocol === 'openai-responses') {
    throw new NativeMediaError('UNSUPPORTED_PROTOCOL', 'openai-responses native media is deferred: input part semantics are unverified')
  }

  const accepted = new Set<NativeMediaMimeType>(capability.mimeTypes)
  const positions = new Set<string>()
  let declaredTotal = 0
  for (const occurrence of request.occurrences) {
    assertIndex('messageIndex', occurrence.messageIndex)
    assertIndex('blockIndex', occurrence.blockIndex)
    const position = `${occurrence.messageIndex}:${occurrence.blockIndex}`
    if (positions.has(position)) {
      throw new NativeMediaError('DUPLICATE_OCCURRENCE', `message ${occurrence.messageIndex} block ${occurrence.blockIndex} appears more than once`)
    }
    positions.add(position)
    assertLimit('attachment.bytes', occurrence.attachment.bytes)
    if (occurrence.attachment.bytes > limits.maxFileBytes) {
      throw new NativeMediaError(
        'FILE_TOO_LARGE',
        `${occurrence.attachment.name} declares ${occurrence.attachment.bytes} bytes, above the ${limits.maxFileBytes}-byte per-file limit`,
      )
    }
    declaredTotal += occurrence.attachment.bytes
    if (declaredTotal > limits.maxTotalBytes) {
      throw new NativeMediaError(
        'AGGREGATE_TOO_LARGE',
        `declared files exceed the ${limits.maxTotalBytes}-byte aggregate limit`,
      )
    }
  }

  const files: NativeMediaFilePlan[] = []
  let rawBytes = 0
  let encodedBytes = 0
  for (const occurrence of request.occurrences) {
    request.signal?.throwIfAborted()
    const { attachment } = occurrence
    const media = mediaFromFilename(attachment.name)
    if (media === undefined) {
      throw new NativeMediaError('UNSUPPORTED_MEDIA', `${attachment.name} has no supported PDF, audio, or video extension`)
    }
    if (!accepted.has(media.mimeType)) {
      throw new NativeMediaError('UNSUPPORTED_MEDIA', `${attachment.name} is ${media.mimeType}, which this model did not accept`)
    }
    const protocolAccepts = capability.protocol === 'openai-completions'
      || media.mimeType === 'application/pdf'
    if (!protocolAccepts) {
      throw new NativeMediaError(
        'UNSUPPORTED_MEDIA',
        `${capability.protocol} cannot carry ${media.mimeType} natively`,
      )
    }
    const bytes = await readOccurrence(request, attachment)
    if (!hasMagic(media.mimeType, bytes)) {
      throw new NativeMediaError(
        'MEDIA_TYPE_MISMATCH',
        `${attachment.name} does not carry the bytes required for ${media.mimeType}`,
      )
    }
    const base64 = encodeBase64(bytes)
    const planned: Omit<NativeMediaFilePlan, 'encodedBytes'> = {
      attachment,
      messageIndex: occurrence.messageIndex,
      blockIndex: occurrence.blockIndex,
      token: `[[dsh-native-media:${attachment.attachmentId}:${occurrence.messageIndex}:${occurrence.blockIndex}]]`,
      kind: media.kind,
      mimeType: media.mimeType,
      format: media.format,
      filename: attachment.name,
      bytes: bytes.byteLength,
      base64,
    }
    const encodedBytesForFile = jsonByteLength(encodeNativeMediaPart(
      capability.protocol,
      { ...planned, encodedBytes: 0 },
    ))
    if (encodedBytesForFile > limits.maxEncodedFileBytes) {
      throw new NativeMediaError(
        'ENCODED_FILE_TOO_LARGE',
        `${attachment.name} serializes to ${encodedBytesForFile} bytes, above the ${limits.maxEncodedFileBytes}-byte per-file encoded limit`,
      )
    }
    encodedBytes += encodedBytesForFile
    if (encodedBytes > limits.maxEncodedTotalBytes) {
      throw new NativeMediaError(
        'ENCODED_AGGREGATE_TOO_LARGE',
        `encoded files exceed the ${limits.maxEncodedTotalBytes}-byte aggregate limit`,
      )
    }
    rawBytes += bytes.byteLength
    files.push({ ...planned, encodedBytes: encodedBytesForFile })
  }
  request.signal?.throwIfAborted()
  return { protocol: capability.protocol, files, rawBytes, encodedBytes }
}

/**
 * True when a planned format is one of the audio container labels.
 * @param format - planned media format.
 * @returns whether the value is a supported audio format.
 */
function isAudioFormat(format: NativeMediaFormat): format is NativeAudioFormat {
  return format === 'wav' || format === 'mp3' || format === 'ogg' || format === 'flac'
}

/**
 * True when a planned format is one of the video container labels.
 * @param format - planned media format.
 * @returns whether the value is a supported video format.
 */
function isVideoFormat(format: NativeMediaFormat): format is NativeVideoFormat {
  return format === 'mp4' || format === 'webm'
}

/**
 * Encode one planned file as the exact provider-native content part for a
 * protocol. Anthropic audio/video and the deferred Responses protocol fail
 * instead of sending a lossy or unverified part.
 * @param protocol - pi-ai wire protocol selected for the request.
 * @param file - validated file plan entry.
 * @returns the provider-native content part.
 */
export function encodeNativeMediaPart(protocol: NativeMediaProtocol, file: NativeMediaFilePlan): NativeMediaPart {
  const protocolName: string = protocol
  if (protocolName === 'openai-responses') {
    throw new NativeMediaError('UNSUPPORTED_PROTOCOL', 'openai-responses native media is deferred: input part semantics are unverified')
  }
  if (protocolName === 'anthropic-messages') {
    if (file.kind !== 'pdf') {
      throw new NativeMediaError('UNSUPPORTED_MEDIA', `anthropic-messages cannot carry ${file.mimeType} natively`)
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: file.base64 },
    }
  }
  if (protocolName === 'openai-completions') {
    switch (file.kind) {
      case 'pdf':
        return {
          type: 'file',
          file: {
            filename: file.filename,
            file_data: `data:${file.mimeType};base64,${file.base64}`,
          },
        }
      case 'audio':
        if (!isAudioFormat(file.format)) {
          throw new NativeMediaError('INVALID_PLAN', `${file.filename} claims audio without an audio format`)
        }
        return {
          type: 'input_audio',
          input_audio: { data: file.base64, format: file.format },
        }
      case 'video':
        if (!isVideoFormat(file.format)) {
          throw new NativeMediaError('INVALID_PLAN', `${file.filename} claims video without a video format`)
        }
        return {
          type: 'video_url',
          video_url: { url: `data:${file.mimeType};base64,${file.base64}` },
        }
    }
  }
  throw new NativeMediaError('UNSUPPORTED_PROTOCOL', `unsupported native-media protocol: ${protocolName}`)
}

/**
 * Replace one sentinel text block with its native part while retaining other
 * SDK-added block metadata such as cache control.
 * @param block - the exact sentinel block.
 * @param part - encoded native part.
 * @returns a new block carrying both the preserved metadata and the native part.
 */
function replaceSentinelBlock(block: Record<string, unknown>, part: NativeMediaPart): Record<string, unknown> {
  const { type: _type, text: _text, ...metadata } = block
  return { ...metadata, ...part }
}

/**
 * True when a value is a plain record suitable for payload traversal.
 * @param value - candidate value.
 * @returns whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Index a plan's files by unique sentinel.
 * @param plan - native-media plan.
 * @returns token-to-file lookup.
 */
function planFilesByToken(plan: NativeMediaPlan): Map<string, NativeMediaFilePlan> {
  const byToken = new Map<string, NativeMediaFilePlan>()
  for (const file of plan.files) {
    if (byToken.has(file.token)) {
      throw new NativeMediaError('INVALID_PLAN', `duplicate native-media sentinel in plan: ${file.token}`)
    }
    byToken.set(file.token, file)
  }
  return byToken
}

/**
 * Enforce an explicitly supplied complete-body byte cap.
 * @param payload - complete payload that would be sent.
 * @param maxPayloadBytes - explicit cap, or undefined for no cap.
 * @returns nothing when the body fits or no cap is configured.
 */
function assertPayloadBytes(payload: unknown, maxPayloadBytes: number | undefined): void {
  if (maxPayloadBytes === undefined) return
  const bytes = jsonByteLength(payload)
  if (bytes > maxPayloadBytes) {
    throw new NativeMediaError(
      'PAYLOAD_TOO_LARGE',
      `patched payload serializes to ${bytes} bytes, above the ${maxPayloadBytes}-byte payload limit`,
    )
  }
}

/**
 * Find one exact sentinel string anywhere inside a serializable history value.
 * @param value - candidate message tree.
 * @param tokens - planned sentinels.
 * @param seen - cycle guard for object graphs.
 * @returns the first colliding token, or undefined when none exists.
 */
function findExactToken(value: unknown, tokens: ReadonlySet<string>, seen: Set<object>): string | undefined {
  if (typeof value === 'string') return tokens.has(value) ? value : undefined
  if (typeof value !== 'object' || value === null) return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExactToken(item, tokens, seen)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const item of Object.values(value)) {
    const found = findExactToken(item, tokens, seen)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Compare one history attachment reference with the plan's durable reference.
 * @param attachment - candidate history attachment.
 * @param expected - durable reference recorded in the plan.
 * @returns whether identity, name, and byte count all match.
 */
function sameAttachment(attachment: unknown, expected: FileAttachmentRef): boolean {
  return isRecord(attachment)
    && attachment.attachmentId === expected.attachmentId
    && attachment.name === expected.name
    && attachment.bytes === expected.bytes
}

/**
 * Apply a plan to pi-ai's built payload without mutating the input.
 *
 * Only user-role messages are eligible, and only a text value exactly equal to
 * a planned sentinel is replaced. Tool results, assistant reasoning, tools,
 * cache metadata, and arbitrary user strings that merely contain the sentinel
 * stay untouched. Every planned sentinel must appear exactly once in a user
 * message; a missing, duplicated, or tool-role sentinel fails the request
 * before the returned payload can be sent.
 * @param plan - validated plan from {@link buildNativeMediaPlan}.
 * @param payload - pi-ai's built provider payload.
 * @param options - optional complete-body byte cap.
 * @returns a new payload with native parts; the input payload is not mutated.
 */
export function applyNativeMediaPayload(
  plan: NativeMediaPlan,
  payload: unknown,
  options?: NativeMediaPayloadPatchOptions,
): unknown {
  const maxPayloadBytes = options?.maxPayloadBytes
  if (maxPayloadBytes !== undefined) assertLimit('maxPayloadBytes', maxPayloadBytes)
  if (plan.files.length === 0) {
    assertPayloadBytes(payload, maxPayloadBytes)
    return payload
  }
  const byToken = planFilesByToken(plan)
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    throw new NativeMediaError('PLACEHOLDER_MISSING', 'payload has no messages array for native-media sentinels')
  }

  const sightings = new Map<string, { count: number; user: boolean }>()
  const sight = (token: string, role: unknown): void => {
    const current = sightings.get(token)
    if (current === undefined) sightings.set(token, { count: 1, user: role === 'user' })
    else current.count += 1
  }
  for (const message of payload.messages) {
    if (!isRecord(message)) continue
    const content = message.content
    if (typeof content === 'string') {
      if (byToken.has(content)) sight(content, message.role)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      if (byToken.has(block.text)) sight(block.text, message.role)
    }
  }
  for (const file of plan.files) {
    const sighting = sightings.get(file.token)
    if (sighting === undefined) {
      throw new NativeMediaError('PLACEHOLDER_MISSING', `native-media sentinel was not found: ${file.token}`)
    }
    if (sighting.count > 1) {
      throw new NativeMediaError('PLACEHOLDER_DUPLICATED', `native-media sentinel appears more than once: ${file.token}`)
    }
    if (!sighting.user) {
      throw new NativeMediaError('PLACEHOLDER_UNCONSUMED', `native-media sentinel is outside a user message: ${file.token}`)
    }
  }

  const sourceMessages: readonly unknown[] = payload.messages
  const messages = sourceMessages.map((message): unknown => {
    if (!isRecord(message)) return message
    const content = message.content
    if (typeof content === 'string') {
      const file = byToken.get(content)
      if (file === undefined) return message
      return { ...message, content: [encodeNativeMediaPart(plan.protocol, file)] }
    }
    if (!Array.isArray(content)) return message
    const sourceContent: readonly unknown[] = content
    let nextContent: readonly unknown[] = sourceContent
    for (let index = 0; index < sourceContent.length; index += 1) {
      const block = sourceContent[index]
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      const file = byToken.get(block.text)
      if (file === undefined) continue
      if (nextContent === sourceContent) nextContent = [...sourceContent]
      const copy = nextContent as unknown[]
      copy[index] = replaceSentinelBlock(block, encodeNativeMediaPart(plan.protocol, file))
    }
    return nextContent === sourceContent ? message : { ...message, content: nextContent }
  })
  const patched = { ...payload, messages }
  assertPayloadBytes(patched, maxPayloadBytes)
  return patched
}

/**
 * Insert each planned sentinel as a standalone text block in a cloned message
 * history, validating every planned position first.
 *
 * The history must still contain the exact durable file occurrence at every
 * plan index, in a user message, with the same attachment identity, name, and
 * byte count. Any pre-existing exact sentinel text anywhere in the history is
 * rejected before insertion so a typed token can never stand in for a missing
 * file. Unplanned file blocks, including those in tool messages, are preserved
 * untouched.
 * @param messages - harness request history (shape-compatible plain data).
 * @param plan - validated plan from {@link buildNativeMediaPlan}.
 * @returns a new messages array with changed messages cloned; the input is not mutated.
 */
export function insertNativeMediaSentinels(messages: readonly unknown[], plan: NativeMediaPlan): readonly unknown[] {
  const byToken = planFilesByToken(plan)
  if (plan.files.length === 0) return [...messages]
  const collision = findExactToken(messages, new Set(byToken.keys()), new Set())
  if (collision !== undefined) {
    throw new NativeMediaError('SENTINEL_COLLISION', `planned native-media sentinel already exists in history: ${collision}`)
  }
  const positions = new Set<string>()
  for (const file of plan.files) {
    const position = `${file.messageIndex}:${file.blockIndex}`
    if (positions.has(position)) {
      throw new NativeMediaError('DUPLICATE_OCCURRENCE', `message ${file.messageIndex} block ${file.blockIndex} appears more than once in the plan`)
    }
    positions.add(position)
    const message = messages[file.messageIndex]
    if (!isRecord(message) || message.role !== 'user') {
      throw new NativeMediaError('INVALID_OCCURRENCE', `planned native media at message ${file.messageIndex} is not in a user message`)
    }
    const content = message.content
    if (!Array.isArray(content)) {
      throw new NativeMediaError('INVALID_OCCURRENCE', `planned native media at message ${file.messageIndex} has no content array`)
    }
    const blocks: readonly unknown[] = content
    const block = blocks[file.blockIndex]
    if (!isRecord(block) || block.type !== 'file') {
      throw new NativeMediaError('INVALID_OCCURRENCE', `message ${file.messageIndex} block ${file.blockIndex} is not a file block`)
    }
    if (!sameAttachment(block.attachment, file.attachment)) {
      throw new NativeMediaError('INVALID_OCCURRENCE', `message ${file.messageIndex} block ${file.blockIndex} does not match the planned attachment`)
    }
  }

  const next = [...messages]
  for (const file of plan.files) {
    const message = next[file.messageIndex] as Record<string, unknown>
    const content = message.content as readonly unknown[]
    const copy = [...content]
    copy[file.blockIndex] = { type: 'text', text: file.token }
    next[file.messageIndex] = { ...message, content: copy }
  }
  return next
}

/**
 * Create the `onPayload` callback for one plan. It is pure and deterministic:
 * the same payload always yields the same result, and repeated calls do not
 * retain state between requests.
 * @param plan - validated plan from {@link buildNativeMediaPlan}.
 * @param options - optional complete-body byte cap supplied by the route.
 * @returns a callback suitable for pi-ai's `onPayload` option.
 */
export function createNativeMediaPayloadPatcher(
  plan: NativeMediaPlan,
  options?: NativeMediaPayloadPatchOptions,
): (payload: unknown) => unknown {
  return payload => applyNativeMediaPayload(plan, payload, options)
}
