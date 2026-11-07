/**
 * Canonical provider-neutral message and streaming vocabulary for the loop,
 * session log, and plugins. Adapters alone translate provider wire messages;
 * mapped interfaces make the content, source, and finish unions extensible.
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MessageId, ToolCallId, ProviderRequestId, ReasoningEffortId } from './brand.ts'
import type { Message, UserMessage } from './message.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The provider topology changed: an adapter registered or unregistered
     * routes, or the configurable-provider directory gained or lost entries.
     * This payload-free registry notification fires at each commit point
     * (including registration disposal); consumers re-read `listProviders()`,
     * `listModels()`, or `listConfigurableProviders()` for the new state.
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'llm/adapters-updated'(): void
    /**
     * The in-memory route-health view moved: a `provider/model` cooled down, a
     * consecutive run grew, or a successful attempt cleared the route. The
     * view is process-local and never persisted, so this notification exists
     * only for status projections; consumers re-read `ctx.llm.routeHealth()`.
     * A listener failure is contained and cannot change a request's outcome.
     * @mode emit
     */
    'llm/route-health-updated'(): void
  }
}

export type {
  AssistantMessage,
  DeveloperMessage,
  AssistantProviderMetadata,
  Message,
  MessageSource,
  MessageSourceMap,
  ModelMessageSource,
  ToolMessageSource,
  ToolResultMessage,
  UserMessage,
} from './message.ts'

/** Serializable provider or transport failure facts; policy decides whether they are retryable. */
export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId
  /**
   * Registered provider route the failure came from, when the raiser knows it.
   * Set by the LLM seam, which resolves the route every attempt runs on.
   */
  readonly provider?: string
  /**
   * Provider-owned model id the failure came from, when the raiser knows it.
   * Set by the LLM seam, after model-group escalation has picked the link.
   */
  readonly model?: string
  /**
   * With code `IMAGE_OFFLOAD_REQUIRED`: how many more of the oldest retained
   * image occurrences the route needs offloaded before the same request fits
   * its exact byte accounting. `dsh-compaction-image-offload` records the
   * selected occurrences in an `image/offload` event and retries the step.
   */
  readonly offloadImages?: number
}

/** Plain text visible to the end user. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user messages may carry images.
 */
export interface ImageBlock {
  type: 'image'
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef
  /**
   * Derived from a durable image-offload decision or preserved by a message
   * rewrite. Every route sends placeholder text naming the image and its
   * available read-only path instead of image bytes.
   */
  offloaded?: true
}

/**
 * A durable verbatim file reference, valid in user content. Request assembly
 * projects every occurrence to deterministic handle text (name, byte size, and
 * the read-only saved path) unless the exact route declares
 * {@link LlmResolvedModelInfo.nativeFileInputs} and the filename suffix maps to
 * an accepted encoder; such a block reaches only that adapter as the same
 * typed reference. The durable log keeps the structured reference for
 * presentation and authorization either way.
 */
export interface FileBlock {
  type: 'file'
  /** Immutable verbatim bytes and display metadata owned by the attachment service. */
  attachment: FileAttachmentRef
}

/** A tool invocation requested by the model. */
export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: ToolCallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

/** Activates a tool definition from the developer event's referenced request header. */
export interface ToolAdditionBlock {
  type: 'tool-addition'
  /** Name of exactly one tool in the referenced historical header. */
  toolName: string
  /**
   * Reserved against inline definitions; the historical request header owns the schema.
   * @persistenceReserved
   */
  tool?: never
}

/** Records the dynamic removal of a tool identified by its session-local name. */
export interface ToolRemovalBlock {
  type: 'tool-removal'
  toolName: string
}

/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support. Tool-change blocks belong to
 * developer messages; `projectToolUpdates` selects what each route receives.
 */
export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'file': FileBlock
  'tool-call': ToolCallBlock
  'tool-addition': ToolAdditionBlock
  'tool-removal': ToolRemovalBlock
}

/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
export type ContentBlock = ContentBlockMap[ContentBlockType]

/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}

/** Any known finish reason, derived from {@link FinishReasonMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

/**
 * Token accounting for one model call (cache fields are optional).
 *
 * Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
 * reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input =
 * sum of the three). Adapters whose providers fold cache hits into a total
 * prompt count (DeepSeek's `prompt_tokens`) subtract them out.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /**
   * Exact full-call total including aggregate prompt and output tokens.
   *
   * Adapters preserve a provider total or derive it from authoritative
   * aggregate prompt/output counters; they omit it when unavailable or
   * inconsistent.
   */
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Request price of one ordered image occurrence under one exact model route's
 * request projection. Every occurrence resolves to the pair the wire actually
 * carries: provider visual tokens for a retained image, plus the model-visible
 * text sent with or instead of it (request-preview handle, offload placeholder,
 * or text-only substitution). The caller prices `text` with its own text
 * estimator so provider pricing never fixes a text tokenization.
 */
export interface LlmImageRequestPrice {
  /** Provider visual tokens for the retained request image; 0 when only text represents this occurrence. */
  visualTokens: number
  /** Model-visible text sent for this occurrence, to be priced by the caller's text estimator. */
  text: string
}

/**
 * Provider-side request-image pricing for one exact model route. Implemented
 * by adapters whose provider charges visual tokens; consumers (the token
 * meter) resolve it synchronously per measurement, so implementations must not
 * perform I/O.
 */
export interface LlmImageRequestPricing {
  /**
   * Price every image occurrence of one request projection.
   * @param images - surface image blocks in request order, one entry per occurrence; an `offloaded` block
   *   is priced as its placeholder text.
   * @returns one price per occurrence, aligned by index with `images`.
   */
  priceImages(images: readonly ImageBlock[]): readonly LlmImageRequestPrice[]
}

/**
 * File MIME types a native-file transport may carry. The vocabulary is closed
 * so an adapter cannot accept a filename suffix no encoder mapping describes.
 */
export type LlmNativeFileMimeType =
  | 'application/pdf'
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/flac'
  | 'video/mp4'
  | 'video/webm'

/** Closed set of native-file wire encoders; selection is explicit per MIME. */
export type LlmNativeFileEncoder =
  | 'anthropic-document'
  | 'openai-chat-file'
  | 'openai-chat-input-audio'
  | 'openai-chat-video-url'

/** Accepted MIME types in declaration order. */
export const LLM_NATIVE_FILE_MIME_TYPES: readonly LlmNativeFileMimeType[] = [
  'application/pdf',
  'audio/wav',
  'audio/mpeg',
  'audio/ogg',
  'audio/flac',
  'video/mp4',
  'video/webm',
]

/** Known encoders in declaration order. */
export const LLM_NATIVE_FILE_ENCODERS: readonly LlmNativeFileEncoder[] = [
  'anthropic-document',
  'openai-chat-file',
  'openai-chat-input-audio',
  'openai-chat-video-url',
]

/** MIME types each encoder can carry; incompatible pairs fail admission. */
const LLM_NATIVE_FILE_ENCODER_MIME_TYPES: Readonly<Record<LlmNativeFileEncoder, readonly LlmNativeFileMimeType[]>> = {
  'anthropic-document': ['application/pdf'],
  'openai-chat-file': ['application/pdf'],
  'openai-chat-input-audio': ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac'],
  'openai-chat-video-url': ['video/mp4', 'video/webm'],
}

/** Reserved prompt tokens for one natively sent file. */
export interface LlmNativeFileTokenReserve {
  /** Fixed tokens reserved per native file occurrence. */
  readonly perFile: number
  /** Tokens reserved per raw source byte. */
  readonly perByte: number
}

/**
 * Explicit native-file admission and pricing policy for one exact model route.
 *
 * Policy only: filenames, bytes, sentinels, and attachment ids stay in their
 * durable attachment and message records. A descriptor is never implied by a
 * model name, provider protocol, or advertised modality. Its presence enables
 * filename-based admission for the listed MIME types; absence keeps every file
 * as deterministic handle text. Byte limits are admission facts for the adapter
 * that serializes the request, while {@link LlmNativeFileTokenReserve} is the
 * synchronous meter budget reserved before that adapter reads real bytes.
 */
export interface LlmNativeFileInputs {
  /** Descriptor schema version; this build accepts only `1`. */
  readonly version: 1
  /** Accepted MIME type to wire encoder; an unmapped MIME stays a file handle. */
  readonly encoders: Readonly<Partial<Record<LlmNativeFileMimeType, LlmNativeFileEncoder>>>
  /** Largest raw source file the route admits. */
  readonly perFileBytes: number
  /** Largest raw source bytes across all native files in one request. */
  readonly totalBytes: number
  /** Largest serialized native payload the route admits. */
  readonly maxPayloadBytes: number
  /** Tokens reserved per native occurrence instead of the deterministic handle text. */
  readonly tokenReserve: LlmNativeFileTokenReserve
}

/**
 * Deep equality for two optional native-file policy descriptors.
 * @param left - one descriptor or undefined.
 * @param right - the other descriptor or undefined.
 * @returns whether both name the same version, encoders, limits, and reserve.
 */
export function llmNativeFileInputsEqual(
  left: LlmNativeFileInputs | undefined,
  right: LlmNativeFileInputs | undefined,
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.perFileBytes !== right.perFileBytes
    || left.totalBytes !== right.totalBytes
    || left.maxPayloadBytes !== right.maxPayloadBytes
    || left.tokenReserve.perFile !== right.tokenReserve.perFile
    || left.tokenReserve.perByte !== right.tokenReserve.perByte) return false
  return LLM_NATIVE_FILE_MIME_TYPES.every(mime => left.encoders[mime] === right.encoders[mime])
}

/**
 * Whether a widened value is one closed native-file MIME type.
 * @param value - untrusted value from a descriptor or adapter.
 * @returns true for an accepted MIME type.
 */
export function isLlmNativeFileMimeType(value: unknown): value is LlmNativeFileMimeType {
  return LLM_NATIVE_FILE_MIME_TYPES.some(mime => mime === value)
}

/**
 * Whether a widened value is one closed native-file encoder.
 * @param value - untrusted value from a descriptor or adapter.
 * @returns true for a known encoder.
 */
export function isLlmNativeFileEncoder(value: unknown): value is LlmNativeFileEncoder {
  return LLM_NATIVE_FILE_ENCODERS.some(encoder => encoder === value)
}

/**
 * Whether one encoder can carry one MIME type. Pairs outside this table can
 * never become a plan, so configuration rejects them before any file is read.
 * @param encoder - closed encoder name.
 * @param mime - closed native-file MIME type.
 * @returns whether the encoder's wire part can carry that MIME type.
 */
export function isLlmNativeFileEncoderCompatible(
  encoder: LlmNativeFileEncoder,
  mime: LlmNativeFileMimeType,
): boolean {
  return LLM_NATIVE_FILE_ENCODER_MIME_TYPES[encoder].some(candidate => candidate === mime)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`native file inputs ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`native file inputs ${field} must be a non-negative finite number`)
  }
  return value
}

/**
 * Validate, detach, and freeze one native-file descriptor.
 *
 * Persisted and adapter-supplied descriptors enter through this function. An
 * absent descriptor stays absent (native media off); a present descriptor with
 * an unknown version or an incompatible MIME/encoder pair fails loud.
 * @param value - untrusted descriptor value from an adapter, config, or log.
 * @returns a detached frozen descriptor accepted by this build.
 * @throws when the version is unknown, a limit is invalid, or a MIME/encoder pair is incompatible.
 */
export function validateLlmNativeFileInputs(value: unknown): LlmNativeFileInputs {
  if (!isRecord(value)) throw new Error('native file inputs must be an object')
  if (value['version'] !== 1) {
    throw new Error(`native file inputs version must be 1, got ${String(value['version'])}`)
  }
  const rawEncoders = value['encoders']
  if (!isRecord(rawEncoders)) throw new Error('native file inputs encoders must be an object')
  const encoders: Partial<Record<LlmNativeFileMimeType, LlmNativeFileEncoder>> = {}
  for (const key of Object.keys(rawEncoders)) {
    if (!isLlmNativeFileMimeType(key)) {
      throw new Error(`native file inputs has unknown MIME type "${key}"`)
    }
    const encoder = rawEncoders[key]
    if (!isLlmNativeFileEncoder(encoder)) {
      throw new Error(`native file inputs has unknown encoder for "${key}"`)
    }
    if (!isLlmNativeFileEncoderCompatible(encoder, key)) {
      throw new Error(`native file inputs maps "${key}" to incompatible encoder "${encoder}"`)
    }
    encoders[key] = encoder
  }
  const perFileBytes = positiveSafeInteger(value['perFileBytes'], 'perFileBytes')
  const totalBytes = positiveSafeInteger(value['totalBytes'], 'totalBytes')
  if (totalBytes < perFileBytes) {
    throw new Error('native file inputs totalBytes must be at least perFileBytes')
  }
  const maxPayloadBytes = positiveSafeInteger(value['maxPayloadBytes'], 'maxPayloadBytes')
  const rawReserve = value['tokenReserve']
  if (!isRecord(rawReserve)) throw new Error('native file inputs tokenReserve must be an object')
  const tokenReserve: LlmNativeFileTokenReserve = {
    perFile: nonNegativeFinite(rawReserve['perFile'], 'tokenReserve.perFile'),
    perByte: nonNegativeFinite(rawReserve['perByte'], 'tokenReserve.perByte'),
  }
  return Object.freeze({
    version: 1,
    encoders: Object.freeze(encoders),
    perFileBytes,
    totalBytes,
    maxPayloadBytes,
    tokenReserve: Object.freeze(tokenReserve),
  })
}

/** File suffixes mapped to the closed native-file MIME vocabulary, longest first. */
const LLM_NATIVE_FILE_SUFFIXES: readonly (readonly [string, LlmNativeFileMimeType])[] = [
  ['.pdf', 'application/pdf'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]

/**
 * Map a display filename suffix to the closed MIME vocabulary. Bytes are never
 * sniffed here; the adapter verifies magic separately before any payload exists.
 * @param name - attachment display name from the durable reference.
 * @returns the claimed MIME type, or undefined when no native encoder matches the suffix.
 */
export function llmNativeFileMimeType(name: string): LlmNativeFileMimeType | undefined {
  const lower = name.toLowerCase()
  for (const [suffix, mime] of LLM_NATIVE_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return mime
  }
  return undefined
}

/**
 * Resolve the encoder one descriptor accepts for a filename, or undefined for
 * handle text. This predicate is shared by request projection, the adapter
 * plan, and token pricing, so they cannot disagree about which files go native.
 * @param inputs - exact route descriptor, or undefined when native media is off.
 * @param ref - durable file reference from model history.
 * @returns the encoder selected for this filename, or undefined.
 */
export function llmNativeFileEncoderFor(
  inputs: LlmNativeFileInputs | undefined,
  ref: FileAttachmentRef,
): LlmNativeFileEncoder | undefined {
  if (inputs === undefined) return undefined
  const mime = llmNativeFileMimeType(ref.name)
  return mime === undefined ? undefined : inputs.encoders[mime]
}

/**
 * Reserved prompt tokens for one natively sent occurrence.
 * @param inputs - exact route descriptor.
 * @param ref - durable file reference priced by the call.
 * @returns the ceiling of the descriptor's fixed plus per-byte reserve.
 */
export function llmNativeFileReserveTokens(inputs: LlmNativeFileInputs, ref: FileAttachmentRef): number {
  return Math.ceil(inputs.tokenReserve.perFile + inputs.tokenReserve.perByte * ref.bytes)
}

/** Display metadata for one registered provider route. */
export interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}

/**
 * Merge-extensible provider model modality vocabulary.
 *
 * `text` and `image` are the request modalities every supported provider
 * protocol can carry; `audio`, `video`, and `pdf` are the disclosure-side
 * tokens provider catalogs such as models.dev report. An adapter may store the
 * disclosure-side tokens even where its wire protocol cannot express them yet,
 * so a catalogue read does not discard what the provider published.
 */
export interface ModelModalityMap {
  text: 'text'
  image: 'image'
  audio: 'audio'
  video: 'video'
  pdf: 'pdf'
}

/** Any declared provider model modality. */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

/**
 * One provider route an adapter plugin can activate through configuration,
 * whether or not the route is currently registered. Configuration surfaces
 * merge this directory with `listProviders()` to offer every configurable
 * provider alongside its live/dormant state.
 */
export interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string
  /** Human-readable provider name for configuration surfaces. */
  displayName: string
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[]
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean
  /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
  error?: string
}

/**
 * One interrogation of a provider endpoint that configuration has not stored
 * yet. Configuration surfaces send the draft a user is still editing, so the
 * request carries the endpoint and credential directly instead of naming a
 * route: a provider being added has no route to name.
 */
export interface LlmModelDiscoveryRequest {
  /**
   * Route the draft is editing, when it edits an existing one. A route whose
   * adapter already knows its models answers from that knowledge instead of
   * asking the endpoint — the adapter's own registry is the better answer, and
   * it costs no network call.
   */
  provider?: string
  /**
   * Endpoint to interrogate. Optional because a route the adapter already
   * describes needs none; a route it does not must supply one.
   */
  baseURL?: string
  /** Wire protocol the endpoint speaks, when the draft names one. */
  api?: string
  /** Credential for this interrogation alone; the harness never stores it. */
  apiKey?: string
}

/** Provider-side discovery request with operation-local cancellation attached. */
export interface LlmModelDiscoveryOperation extends LlmModelDiscoveryRequest {
  /** Caller cancellation; implementations must settle promptly after it aborts. */
  signal?: AbortSignal
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A draft provider interrogation refused or failed. */
    'llm/model-discovery-rejected': {
      readonly settingsNs: string
      readonly baseURL?: string
    }
  }
}

/**
 * One model an endpoint reports about itself. Every field but the id is
 * optional because most provider listings disclose an id and nothing else;
 * a surface adopting one of these still owes the capacities its adapter needs.
 */
export interface LlmDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
  /** Accepted input types when disclosed by the catalog or endpoint; absent means unknown. */
  inputModalities?: readonly ModelModality[]
  /**
   * Maximum input (prompt-side) tokens when the endpoint discloses one
   * separately from {@link contextWindow}; never derived from it.
   */
  maxInputTokens?: number
  /** Whether the endpoint stated tool-call support; absent means undisclosed. */
  tools?: boolean
  /** Whether the endpoint stated reasoning support; absent means undisclosed. */
  reasoning?: boolean
  /**
   * Selectable reasoning levels (picker id → wire value) when the endpoint
   * advertises them; absent means undisclosed, never "does not reason".
   */
  reasoningEfforts?: Readonly<Record<string, string>>
  /**
   * Effort identifiers the endpoint advertised that no configured level
   * accepts, preserved for diagnostics. They are never selectable and never
   * renamed to a canonical level.
   */
  unsupportedReasoningEfforts?: readonly string[]
  /**
   * Where this row's metadata came from. `catalog` means the endpoint probe
   * failed or was not attempted and the installed catalog answered; `endpoint`
   * means the live listing answered. Absent on rows from adapters that do not
   * distinguish the two.
   */
  source?: 'endpoint' | 'catalog'
  /**
   * Why the installed catalog answered instead of the endpoint, when
   * {@link source} is `catalog` and a probe was attempted and failed.
   */
  fallbackReason?: string
}

/** Status view for one credential identity inside a provider pool. */
export interface LlmPoolIdentityStatus {
  id: string
  credentialRef: string
  priority?: number
  enabled?: boolean
  cooldownUntil: number
  consecutiveFailures: number
  lastStatus?: number
  lastError?: string
  quota?: {
    remainingFraction?: number | null
    resetTime?: string | number | null
    source?: string
  }
}

/** Provider-owned pool management operations. */
export interface LlmPoolOperations {
  status(provider: string): Promise<LlmPoolIdentityStatus[]>
  resetCooldown(provider: string, identityId?: string): Promise<void>
  testIdentity(
    provider: string,
    identityId: string,
    apiKey?: string,
  ): Promise<{ ok: boolean; status?: number; latencyMs?: number; error?: string; modelsCount?: number }>
}

/** One adapter-discovered model; catalog membership is advisory, not request validation. */
export interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
  /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
  inputModalities?: readonly ModelModality[]
  /**
   * Input types a catalog, configuration, or listing advertised, including
   * tokens (`audio`, `video`, `pdf`) no native request encoding carries yet.
   * {@link inputModalities} stays the effective set the adapter sends.
   */
  advertisedInputModalities?: readonly ModelModality[]
  /** Whether a source stated tool-call support; absent means undisclosed. */
  tools?: boolean
  /**
   * Effort identifiers a source advertised that no selectable level accepts,
   * preserved for diagnostics. They never appear in a materialized ladder.
   */
  unsupportedReasoningEfforts?: readonly string[]
}

/** Provenance of one exact model's resolved capacity. */
export type LlmModelCapacitySource =
  /** A deployment's configuration stated it. */
  | 'configured'
  /** A retained endpoint discovery stated it. */
  | 'discovered'
  /** The adapter's installed catalog stated it. */
  | 'installed'
  /** No source sized the model; a route default stands in for execution. */
  | 'default'

/** Provider-owned context capacity for one exact provider/model route. */
export interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
  /**
   * Maximum input (prompt-side) tokens when configuration or discovery stated
   * it separately; never derived from {@link contextWindow} and never
   * defaulted beside it. Absent means no source stated an input-only cap.
   */
  maxInputTokens?: number
  /**
   * Provenance of {@link contextWindow}; `default` means no source stated this
   * capacity and the route fallback stands in for execution.
   */
  source?: LlmModelCapacitySource
  /**
   * Provenance of {@link maxInputTokens}; `default` means no source stated the
   * input-only cap and no prompt-side budget may bind on it.
   */
  maxInputTokensSource?: LlmModelCapacitySource
}

/**
 * Request-image budget one exact image-capable route enforces over the
 * retained occurrences' exact request-version bytes; for the `base64`
 * representation each byte count expands to its encoded length. A route whose
 * retained occurrences exceed the budget fails the request with
 * `IMAGE_OFFLOAD_REQUIRED` naming the additional occurrences to offload.
 */
export interface LlmImageRequestBudget {
  /** Whether the route accounts raw file bytes or inline base64 length. */
  representation: 'raw' | 'base64'
  /** Accumulated represented image bytes the route accepts; absent leaves bytes unbounded. */
  maxBytes?: number
  /** Image occurrences the route accepts; absent leaves the count unbounded. */
  maxImages?: number
  /** Represented bytes removed as one deterministic advance step; absent removes the minimum. */
  byteQuantum?: number
  /** Occurrences removed as one deterministic advance step; absent removes the minimum. */
  countQuantum?: number
}

/** Display metadata for one adapter-owned reasoning effort. */
export interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}

/** Selectable reasoning efforts for one exact provider/model route. */
export interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}

/**
 * How a model applies a system prompt that changes mid-conversation.
 * `'in-history'`: the model reads the latest `system` message at any position
 * of `messages` as the complete effective system prompt, so a changed prompt
 * can follow the cached history instead of rewriting message 0.
 */
export type SystemPromptUpdate = 'in-history'

/**
 * How a model accepts native tool declarations that change mid-conversation.
 * `'addition-only'`: the model reads a `tool-addition` block in a later
 * developer message as activating a tool declared with `deferLoading`, so an
 * added tool follows the cached history instead of rewriting the declaration
 * list. `'in-history'`: the model additionally reads `tool-removal` blocks,
 * so a removed tool keeps its declaration and the removal follows the history.
 * Absent means every request declares the complete current tool list.
 */
export type ToolUpdate = 'in-history' | 'addition-only'

/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext
  /**
   * Output-token capability the route resolved for the model. An adapter that
   * requires such a field (pi-ai's `Model.maxTokens`) always reports one, so a
   * value labelled `default` by {@link maxOutputTokensSource} is the execution
   * fallback rather than a disclosed cap.
   */
  maxOutputTokens?: number
  /** Provenance of {@link maxOutputTokens}; same vocabulary as {@link LlmModelContext.source}. */
  maxOutputTokensSource?: LlmModelCapacitySource
  /**
   * Adapter-configured per-request output cap materialized when callers omit
   * one; distinct from {@link maxOutputTokens}, which is the model capability.
   */
  defaultMaxTokens?: number
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo
  /** Declared mid-conversation system prompt handling; absent means only a leading system message is read. */
  systemPromptUpdate?: SystemPromptUpdate
  /** Declared mid-conversation tool declaration handling; absent means every request declares the complete tool list. */
  toolUpdate?: ToolUpdate
  /** Explicit native-file admission and pricing policy for this exact route; absent keeps every file as handle text. */
  nativeFileInputs?: LlmNativeFileInputs
}

/**
 * Adapter-private lossless-JSON state for replaying a successful response,
 * carried by a terminal `finish` chunk and stored on the assembled assistant
 * message's model source. Both halves stay opaque to the harness; only the
 * split is shared vocabulary, so assembly can keep stored metadata aligned
 * with stored content without reading either half.
 */
export interface ReplayEnvelope {
  /** Response-level adapter-private metadata (ids, native stop reason). */
  response: unknown
  /**
   * Per-block adapter-private metadata, one entry per emitted block in
   * first-seen stream order. When assembly drops a block it drops the entry at
   * the same position; entries whose length does not match the emitted block
   * count discard the whole envelope. An adapter whose metadata is independent
   * of block structure omits this field and the envelope passes through
   * assembly unchanged.
   */
  blocks?: readonly unknown[]
}

/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. Adapters emit usage before the terminal finish and nothing
 * afterward; tool arguments remain raw JSON strings. An adapter implementation
 * may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal
 * `error` or `aborted` finish before exposing it to consumers.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope
    /**
     * Enpoi Harness model-group provenance: the link that produced this
     * terminal outcome when the runtime escalated away from the request's own
     * route. Absent on every single-model request and whenever the request's
     * own route answered, so consumers that ignore it behave exactly as before.
     */
    answeringLink?: AnsweringLink
  }

/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
export interface ToolSchema {
  /**
   * Requests deferred loading of the tool definition into model context,
   * independently of whether a tool-addition block records the tool.
   * Uses Anthropic's defer_loading terminology.
   */
  deferLoading?: true
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

/** One ordered provider/model link of a model group. */
export interface ModelChainLink {
  /** Registered provider route selecting the adapter instance for this link. */
  provider: string
  /** Exact model id this link runs. */
  model: string
  /**
   * Adapter-owned reasoning effort for this link. Absent keeps the request's
   * effort when the link is the request's own route, and leaves the model's
   * own default otherwise, so an effort owned by a different model never
   * rejects the request.
   */
  effort?: string
}

/**
 * The model-group link that produced one request's terminal stream outcome.
 * Reported only when the runtime escalated away from the request's own route,
 * so a consumer can attribute the answer to the model that actually ran it.
 */
export interface AnsweringLink {
  /** Provider route that produced the outcome. */
  readonly provider: string
  /** Exact model id that produced the outcome. */
  readonly model: string
}

/**
 * One resolved model group (failover chain): an ordered list of links the
 * runtime tries before giving up on a request. Only `id`, `label`, and `links`
 * drive the core loop; retries inside one link belong to the key pool and
 * step retries to `dsh-llm-retry`, so a group's other document keys are not
 * part of this contract.
 */
export interface ResolvedModelChain {
  /** Stable group id carried by {@link GenerateOptions.chain}. */
  id: string
  /** Human-readable group name for diagnostics. */
  label?: string
  /** Ordered links; mixed providers are the point. */
  links: readonly ModelChainLink[]
}

/**
 * Optional `modelChains` service resolving a group id to its ordered links.
 * Read structurally through `ctx.get('modelChains')`; a deployment that
 * mounts no group registry keeps the single-model behavior.
 */
export interface ModelChainResolver {
  /**
   * Resolve one group id.
   * @param id - group id carried by {@link GenerateOptions.chain}.
   * @returns the ordered group, or `undefined` for an unknown id.
   */
  resolve(id: string): ResolvedModelChain | undefined
}

/** User input for one LLM request; it has no durable Session identity or source. */
export interface RequestUserInput {
  readonly role: 'user'
  readonly content: UserMessage['content']
  readonly id?: never
  readonly source?: never
}

/** A durable conversation message or a user input used only for one request. */
export type RequestMessage = Message | RequestUserInput

/** Logged tool declarations and update identities since the last declaration reset. */
export interface ToolHistory {
  /** Complete active declarations at the start of this history. */
  readonly tools: readonly ToolSchema[]
  /** Ordered developer messages, with additions resolved from their historical headers. */
  readonly updates: readonly {
    /** Identity used to locate this update in the derived request history. */
    readonly messageId: MessageId
    /** Added definitions resolved from the event's referenced request header. */
    readonly additions: readonly ToolSchema[]
  }[]
}

/** A single model request, fully assembled. */
export interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /**
   * Enpoi Harness model-group id. When set, {@link LlmRuntime.stream} resolves
   * the group through the optional `modelChains` service and re-issues the
   * request on the next link after a retryable pre-commit failure. Unset,
   * unknown, or link-less group ids keep today's single-model dispatch.
   */
  chain?: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them. A
   * loop-built request passes the derived history (dsh-agent-loop), whose
   * leading system-role message carries the system prompt; a hand-built
   * one-shot may include identity-free user inputs.
   */
  messages: RequestMessage[]
  /**
   * System prompt text for one-shot callers; adapters map it to the provider's
   * system slot ahead of `messages`. Loop-built requests leave it undefined.
   */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  /** Session-folded tool history used for route projection; omission sends complete declarations without tool updates. */
  toolHistory?: ToolHistory
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title'
}
