/**
 * CLIProxyAPI upstream model-registry metadata — parser, exact resolver, and
 * sanitized snapshot support.
 *
 * The raw source is the registry the proxy daemon itself ships
 * (`internal/registry/models/models.json`): a channel map whose arrays carry
 * the proxy's own `ModelInfo` records. This module reads only the fields the
 * upstream file actually discloses. It never merges a record's input cap into
 * its context window, never turns a numeric thinking budget into named effort
 * levels, and never invents a capability for a model the registry does not
 * describe.
 *
 * Membership is *not* read here. The live proxy's `GET /v1/models` is the
 * membership authority (id + `owned_by`); this module resolves metadata for an
 * id the caller obtained elsewhere. The rich `?client_version` Codex
 * projection is deliberately not used: it synthesizes values the upstream
 * registry does not disclose.
 *
 * Dynamic updates are caller-driven: `createRegistryMetadataSnapshot` accepts
 * an externally fetched raw document plus a source label/version/time/hash, so
 * an hourly sync can build a fresh snapshot without this module fetching
 * anything by itself. The optional bounded fetch helper below is metadata-only
 * and has no auth/header surface, so it cannot reach management endpoints.
 *
 * @module dsh-enpoi-provider-sync/registry-metadata
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Snapshot envelope discriminator. */
export const REGISTRY_SNAPSHOT_FORMAT = 'dsh-enpoi-cliproxyapi-metadata' as const

/** Snapshot envelope version. A different version is refused, not guessed at. */
export const REGISTRY_SNAPSHOT_FORMAT_VERSION = 2 as const

/** The committed baseline snapshot filename (sibling of `src/`). */
export const BUNDLED_REGISTRY_SNAPSHOT_FILE = 'cliproxyapi-metadata.v8.0.54.json'

/** Pinned upstream raw URL the committed baseline was generated from. */
export const BUNDLED_REGISTRY_SOURCE_URL =
  'https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v8.0.54/internal/registry/models/models.json'

/** Pinned upstream tag/version the committed baseline was generated from. */
export const BUNDLED_REGISTRY_SOURCE_VERSION = 'v8.0.54'

/** Path of the registry file inside the CLIProxyAPI repository. */
export const BUNDLED_REGISTRY_SOURCE_PATH = 'internal/registry/models/models.json'

/** SHA-256 of the pinned raw v8.0.54 registry document bytes. */
export const BUNDLED_REGISTRY_SOURCE_SHA256 =
  '3e3f3a50cceaf812714ac85cde1601fc1b36c787a1e0dcf04072a9934c023aff'

/** Upstream license (CLIProxyAPI `LICENSE`). */
export const BUNDLED_REGISTRY_LICENSE = 'MIT'

/** Exact upstream license text shipped beside the snapshot. */
export const BUNDLED_REGISTRY_LICENSE_FILE = 'CLIProxyAPI-LICENSE.txt'

/** Attribution carried by every snapshot and resolved record. */
export const BUNDLED_REGISTRY_ATTRIBUTION =
  'CLIProxyAPI model registry (https://github.com/router-for-me/CLIProxyAPI), MIT License; full upstream license in CLIProxyAPI-LICENSE.txt.'

/**
 * Effort names the harness settings surface understands, in display order.
 * These are the only canonical setting keys this module ever emits. Raw names
 * outside this set (for example xAI's `none`) stay in `unsupportedLevels` for a
 * display diagnostic and are never silently remapped. In particular, a raw
 * `max` stays `max`; it is never rewritten as `ultra`.
 */
export const CANONICAL_EFFORT_KEYS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** One canonical effort/settings key. */
export type CanonicalEffortKey = (typeof CANONICAL_EFFORT_KEYS)[number]

const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORT_KEYS)

/** Modality tokens accepted from the upstream registry. */
export const MODEL_MODALITY_TOKENS = ['text', 'image', 'audio', 'video', 'pdf'] as const

/** One disclosed input/output modality. */
export type ModelModality = (typeof MODEL_MODALITY_TOKENS)[number]

const MODALITY_SET: ReadonlySet<string> = new Set(MODEL_MODALITY_TOKENS)

/**
 * Owner namespace to channel-set aliases. The table is explicit data: no
 * substring/family guessing is applied to ids or owner names. Callers that
 * know a route's exact channel pass `channel`; this table only widens a
 * metadata lookup to the channels an owner actually publishes.
 */
export const OWNER_CHANNEL_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ['claude'],
  openai: ['codex-free', 'codex-team', 'codex-plus', 'codex-pro'],
  antigravity: ['antigravity'],
  google: ['gemini', 'vertex', 'gemini-cli', 'aistudio'],
  moonshot: ['kimi'],
  xai: ['xai'],
  meta: ['meta'],
})

/** Structured diagnostic emitted by parsing, resolution, or fetching. */
export type RegistryDiagnosticCode =
  | 'invalid-document'
  | 'invalid-channel'
  | 'invalid-record'
  | 'unknown-modality'
  | 'invalid-query'
  | 'not-found'
  | 'ambiguous'
  | 'fetch-failed'
  | 'response-too-large'
  | 'stale-last-good'

/** One non-fatal diagnostic. Fatal document-shape errors throw instead. */
export interface RegistryDiagnostic {
  code: RegistryDiagnosticCode
  message: string
  id?: string
  channel?: string
  channels?: readonly string[]
}

/** Disclosed numeric thinking-budget bounds, kept separate from named levels. */
export interface RegistryEffortBudget {
  min: number | null
  max: number | null
}

/** Reasoning/effort disclosure for one model record. */
export interface RegistryEffortMetadata {
  /**
   * Exact raw level names in source order, or `null` when the record
   * explicitly discloses no named levels (an adaptive budget-only record is
   * still reasoning; it just has no named ladder).
   */
  levels: readonly string[] | null
  /** Canonical settings keys derived only from disclosed raw names/zero_allowed. */
  supportedKeys: readonly CanonicalEffortKey[]
  /** Raw level names with no canonical settings key (display-only diagnostic). */
  unsupportedLevels: readonly string[]
  /** Whether upstream explicitly allows zero/off reasoning. */
  zeroAllowed: boolean | null
  /** Whether upstream explicitly allows dynamic/adaptive reasoning. */
  dynamicAllowed: boolean | null
  /** Numeric budget bounds as disclosed; never converted into named levels. */
  budget: RegistryEffortBudget | null
}

/** One sanitized model record: only fields the upstream record disclosed. */
export interface RegistryModelRecord {
  id: string
  /** Raw `owned_by` namespace, or `null` if upstream omitted it. */
  owner: string | null
  /** Raw `display_name`; never prefixed or decorated by this module. */
  name: string | null
  /** Raw `context_length`; deliberately never derived from input/output caps. */
  contextWindow: number | null
  /** Raw `inputTokenLimit`; not a combined context window. */
  maxInputTokens: number | null
  /** `max_completion_tokens`, else `outputTokenLimit`; the model's output cap. */
  maxTokens: number | null
  inputModalities: readonly ModelModality[] | null
  outputModalities: readonly ModelModality[] | null
  /**
   * `true` only when upstream discloses a thinking object (or explicit
   * `thinking: true`); `false` only for an explicit false source; `null` when
   * the record simply omits thinking and reasoning support is UNKNOWN.
   */
  reasoning: boolean | null
  /**
   * Effort disclosure, or `null` when upstream discloses no thinking config.
   * A non-null effort with `levels: null` is an explicit absence of named
   * levels (for example a budget-only/adaptive model).
   */
  effort: RegistryEffortMetadata | null
}

/** Provenance carried by snapshots and resolved records. */
export interface RegistrySourceAttribution {
  sourceUrl: string
  sourceVersion: string
  sourcePath: string | null
  /** SHA-256 of the raw document bytes, when supplied by the producer. */
  sourceSha256: string | null
  fetchedAt: string | null
  license: string
  attribution: string
}

/** Caller-supplied provenance for a freshly parsed registry document. */
export interface RegistrySnapshotSourceInput {
  sourceUrl: string
  sourceVersion: string
  sourcePath?: string | null
  sourceSha256?: string | null
  fetchedAt?: string | null
  license?: string
  attribution?: string
}

/** One parsed record together with the channel array it came from. */
export interface RegistryChannelRecord {
  channel: string
  model: RegistryModelRecord
}

/** Parsed, indexed registry metadata. */
export interface RegistryMetadataIndex {
  source: RegistrySourceAttribution
  channels: ReadonlyMap<string, readonly RegistryModelRecord[]>
  recordsById: ReadonlyMap<string, readonly RegistryChannelRecord[]>
  diagnostics: readonly RegistryDiagnostic[]
}

/** The committed sanitized snapshot shape. */
export interface RegistryMetadataSnapshot {
  format: typeof REGISTRY_SNAPSHOT_FORMAT
  formatVersion: typeof REGISTRY_SNAPSHOT_FORMAT_VERSION
  source: RegistrySourceAttribution
  channels: Record<string, RegistrySnapshotRecord[]>
}

/** A snapshot record is a model record with no channel/source embedding. */
export type RegistrySnapshotRecord = RegistryModelRecord

/** A resolved record plus its exact channel provenance. */
export interface RegistryResolvedModel extends RegistryModelRecord {
  /**
   * Exact channel when uniquely determined. `null` means multiple channels
   * published byte-identical disclosed metadata; `channels` lists them.
   */
  channel: string | null
  channels: readonly string[]
  source: RegistrySourceAttribution
}

/** Resolution outcome. An unknown model never carries fabricated metadata. */
export type RegistryModelLookup =
  | { status: 'resolved'; metadata: RegistryResolvedModel; diagnostics: readonly RegistryDiagnostic[] }
  | { status: 'unknown'; id: string; diagnostics: readonly RegistryDiagnostic[] }

/** Options for an exact-id resolution. */
export interface RegistryResolveOptions {
  /** Exact owner namespace from the membership listing's `owned_by`. */
  owner?: string | null
  /** Exact upstream channel array name, when the route knows it. */
  channel?: string | null
  /** Data-driven alias override; defaults to `OWNER_CHANNEL_ALIASES`. */
  ownerChannels?: Readonly<Record<string, readonly string[]>>
}

/** Options for the optional bounded metadata-only fetch. */
export interface RegistryFetchOptions {
  /** Raw registry document URL; http is accepted only for loopback hosts. */
  url: string
  /** Abort after this many milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number
  /** Refuse a body larger than this. Defaults to 2 MiB. */
  maxBytes?: number
  /** Injectable fetch for tests/hosts. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Optional caller abort signal. */
  signal?: AbortSignal
}

/** Bounded fetch outcome; failures are values, not thrown errors. */
export type RegistryFetchResult =
  | { ok: true; url: string; document: unknown; bytes: number; sha256: string }
  | { ok: false; url: string; bytes: number; diagnostic: RegistryDiagnostic }

/** Default fetch timeout. */
export const DEFAULT_REGISTRY_FETCH_TIMEOUT_MS = 15_000

/** Default body ceiling (the upstream file is ~123 KiB). */
export const DEFAULT_REGISTRY_FETCH_MAX_BYTES = 2 * 1024 * 1024

/** Options for a self-contained, per-URL last-good metadata source. */
export interface RegistryMetadataSourceOptions extends RegistryFetchOptions {
  sourceVersion: string
  sourcePath?: string | null
  license?: string
  attribution?: string
  /** Clock injection for deterministic snapshots. */
  now?: () => Date
}

/** One state of a metadata source. A failed refresh keeps the last good one. */
export interface RegistryMetadataSourceState {
  snapshot: RegistryMetadataSnapshot | null
  index: RegistryMetadataIndex | null
  stale: boolean
  diagnostics: readonly RegistryDiagnostic[]
}

/** A per-instance source. It holds only its own last-good snapshot. */
export interface RegistryMetadataSource {
  refresh(): Promise<RegistryMetadataSourceState>
  current(): RegistryMetadataSourceState | null
}

/** A non-empty string, or `null`. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A positive safe integer, or `null`. Zero/negative/non-finite are absent. */
function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** A plain object, or `null`. Arrays/null/undefined are not records. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A boolean disclosure, or `null`. */
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Normalize a SHA-256 disclosure. */
function sourceSha256(value: unknown): string | null {
  const sha = nonEmptyString(value)
  if (sha === null) return null
  if (!/^[0-9a-f]{64}$/i.test(sha)) {
    throw new TypeError('CLIProxyAPI registry sourceSha256 must be a hex SHA-256 digest')
  }
  return sha.toLowerCase()
}

/** Normalize an attribution URL: no credentials, query, or fragment. */
function attributionUrl(value: unknown): string {
  const raw = nonEmptyString(value)
  if (raw === null) throw new TypeError('CLIProxyAPI registry sourceUrl must be a non-empty string')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new TypeError('CLIProxyAPI registry sourceUrl must be a valid URL')
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError('CLIProxyAPI registry sourceUrl must not carry credentials')
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/** Normalize and validate attribution. */
function normalizeSource(input: RegistrySnapshotSourceInput | RegistrySourceAttribution): RegistrySourceAttribution {
  const sourceUrl = attributionUrl(input.sourceUrl)
  const sourceVersion = nonEmptyString(input.sourceVersion)
  if (sourceVersion === null) throw new TypeError('CLIProxyAPI registry sourceVersion must be a non-empty string')
  return {
    sourceUrl,
    sourceVersion,
    sourcePath: nonEmptyString(input.sourcePath),
    sourceSha256: sourceSha256(input.sourceSha256),
    fetchedAt: nonEmptyString(input.fetchedAt),
    license: nonEmptyString(input.license) ?? BUNDLED_REGISTRY_LICENSE,
    attribution: nonEmptyString(input.attribution) ?? BUNDLED_REGISTRY_ATTRIBUTION,
  }
}

/** Read and validate a raw level-name array. */
function levelNames(
  value: unknown,
  channel: string,
  id: string,
  diagnostics: RegistryDiagnostic[],
): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: thinking levels must be an array of strings`,
      id,
      channel,
    })
    return []
  }
  const levels: string[] = []
  for (const level of value) {
    if (typeof level !== 'string' || level.length === 0) {
      diagnostics.push({
        code: 'invalid-record',
        message: `${channel}/${id}: ignoring a non-string thinking level`,
        id,
        channel,
      })
      continue
    }
    if (!levels.includes(level)) levels.push(level)
  }
  return levels
}

/** Read and validate a disclosed modality array. */
function modalities(
  value: unknown,
  channel: string,
  id: string,
  field: string,
  diagnostics: RegistryDiagnostic[],
): readonly ModelModality[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: ${field} must be an array of modality tokens`,
      id,
      channel,
    })
    return null
  }
  const tokens: ModelModality[] = []
  for (const token of value) {
    if (typeof token !== 'string' || token.length === 0) {
      diagnostics.push({
        code: 'invalid-record',
        message: `${channel}/${id}: ignoring a non-string ${field} token`,
        id,
        channel,
      })
      continue
    }
    if (!MODALITY_SET.has(token)) {
      diagnostics.push({
        code: 'unknown-modality',
        message: `${channel}/${id}: unknown ${field} token "${token}" was not retained`,
        id,
        channel,
      })
      continue
    }
    if (!tokens.includes(token as ModelModality)) tokens.push(token as ModelModality)
  }
  return tokens
}

/** Derive effort metadata from disclosed raw values only. */
function makeEffort(input: {
  levels: readonly string[]
  zeroAllowed: boolean | null
  dynamicAllowed: boolean | null
  min: number | null
  max: number | null
}): RegistryEffortMetadata {
  const levels = input.levels.length > 0 ? [...input.levels] : null
  const supportedKeys = CANONICAL_EFFORT_KEYS.filter((key) => {
    if (key === 'off') return input.zeroAllowed === true || levels?.includes('off') === true
    return levels?.includes(key) === true
  })
  const unsupportedLevels = levels === null ? [] : levels.filter((level) => !CANONICAL_EFFORT_SET.has(level))
  const budget = input.min !== null || input.max !== null ? { min: input.min, max: input.max } : null
  return {
    levels,
    supportedKeys,
    unsupportedLevels,
    zeroAllowed: input.zeroAllowed,
    dynamicAllowed: input.dynamicAllowed,
    budget,
  }
}

/** Read the upstream `thinking` object. */
function effortFromThinking(
  value: Record<string, unknown>,
  channel: string,
  id: string,
  diagnostics: RegistryDiagnostic[],
): RegistryEffortMetadata {
  return makeEffort({
    levels: levelNames(value.levels, channel, id, diagnostics),
    zeroAllowed: booleanOrNull(value.zero_allowed),
    dynamicAllowed: booleanOrNull(value.dynamic_allowed),
    min: positiveInteger(value.min),
    max: positiveInteger(value.max),
  })
}

/** Read a string array, or `null` when the value is not an array. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** Whether two string arrays are equal in order and value. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Read one sanitized snapshot effort object. Derived keys are recomputed. */
function effortFromSnapshot(
  value: Record<string, unknown>,
  channel: string,
  id: string,
  diagnostics: RegistryDiagnostic[],
): RegistryEffortMetadata {
  const budget = asRecord(value.budget)
  const effort = makeEffort({
    levels: levelNames(value.levels, channel, id, diagnostics),
    zeroAllowed: booleanOrNull(value.zeroAllowed),
    dynamicAllowed: booleanOrNull(value.dynamicAllowed),
    min: positiveInteger(budget?.min),
    max: positiveInteger(budget?.max),
  })
  const storedSupported = stringArray(value.supportedKeys)
  const storedUnsupported = stringArray(value.unsupportedLevels)
  if (storedSupported !== null && !sameStrings(storedSupported, effort.supportedKeys)) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: snapshot supportedKeys disagreed with disclosed levels; recomputed`,
      id,
      channel,
    })
  }
  if (storedUnsupported !== null && !sameStrings(storedUnsupported, effort.unsupportedLevels)) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: snapshot unsupportedLevels disagreed with disclosed levels; recomputed`,
      id,
      channel,
    })
  }
  return effort
}

/** Normalize one raw upstream `ModelInfo` record. */
function rawModelRecord(
  value: unknown,
  channel: string,
  diagnostics: RegistryDiagnostic[],
): RegistryModelRecord | null {
  const record = asRecord(value)
  const id = record === null ? null : nonEmptyString(record.id)
  if (record === null || id === null) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}: ignoring a model entry without a non-empty string id`,
      channel,
    })
    return null
  }

  let reasoning: boolean | null = null
  let effort: RegistryEffortMetadata | null = null
  if (record.thinking === undefined || record.thinking === null) {
    // Unknown, not false: many records omit thinking even when the model may
    // reason. Only a source that explicitly says false may produce false.
    reasoning = null
    effort = null
  } else if (record.thinking === false) {
    reasoning = false
    effort = null
  } else if (record.thinking === true) {
    reasoning = true
    effort = null
  } else {
    const thinking = asRecord(record.thinking)
    if (thinking === null) {
      diagnostics.push({
        code: 'invalid-record',
        message: `${channel}/${id}: thinking must be an object, true, or false; treating it as unknown`,
        id,
        channel,
      })
    } else {
      reasoning = true
      effort = effortFromThinking(thinking, channel, id, diagnostics)
    }
  }

  return {
    id,
    owner: nonEmptyString(record.owned_by),
    name: nonEmptyString(record.display_name),
    // context_length is the only context disclosure. inputTokenLimit is an
    // input ceiling and is never summed with output to synthesize context.
    contextWindow: positiveInteger(record.context_length),
    maxInputTokens: positiveInteger(record.inputTokenLimit),
    maxTokens: positiveInteger(record.max_completion_tokens) ?? positiveInteger(record.outputTokenLimit),
    inputModalities: modalities(record.supportedInputModalities, channel, id, 'supportedInputModalities', diagnostics),
    outputModalities: modalities(record.supportedOutputModalities, channel, id, 'supportedOutputModalities', diagnostics),
    reasoning,
    effort,
  }
}

/** Normalize one sanitized snapshot record. */
function snapshotModelRecord(
  value: unknown,
  channel: string,
  diagnostics: RegistryDiagnostic[],
): RegistryModelRecord | null {
  const record = asRecord(value)
  const id = record === null ? null : nonEmptyString(record.id)
  if (record === null || id === null) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}: ignoring a snapshot model entry without a non-empty string id`,
      channel,
    })
    return null
  }

  let effort: RegistryEffortMetadata | null = null
  const effortRecord = asRecord(record.effort)
  if (record.effort !== undefined && record.effort !== null && effortRecord === null) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: snapshot effort must be an object or null; no effort metadata retained`,
      id,
      channel,
    })
  } else if (effortRecord !== null) {
    effort = effortFromSnapshot(effortRecord, channel, id, diagnostics)
  }

  let reasoning: boolean | null = null
  if (typeof record.reasoning === 'boolean') {
    reasoning = record.reasoning
  } else if (record.reasoning !== null) {
    diagnostics.push({
      code: 'invalid-record',
      message: `${channel}/${id}: snapshot reasoning must be a boolean or null; treating it as unknown`,
      id,
      channel,
    })
  }

  return {
    id,
    owner: nonEmptyString(record.owner),
    name: nonEmptyString(record.name),
    contextWindow: positiveInteger(record.contextWindow),
    maxInputTokens: positiveInteger(record.maxInputTokens),
    maxTokens: positiveInteger(record.maxTokens),
    inputModalities: modalities(record.inputModalities, channel, id, 'inputModalities', diagnostics),
    outputModalities: modalities(record.outputModalities, channel, id, 'outputModalities', diagnostics),
    reasoning,
    effort,
  }
}

/** Build the index maps shared by raw and snapshot parsing. */
function buildIndex(
  channels: Map<string, RegistryModelRecord[]>,
  source: RegistrySourceAttribution,
  diagnostics: RegistryDiagnostic[],
): RegistryMetadataIndex {
  const recordsById = new Map<string, RegistryChannelRecord[]>()
  for (const [channel, models] of channels) {
    for (const model of models) {
      const entry: RegistryChannelRecord = { channel, model }
      const existing = recordsById.get(model.id)
      if (existing === undefined) recordsById.set(model.id, [entry])
      else existing.push(entry)
    }
  }
  return { source, channels, recordsById, diagnostics }
}

/**
 * Parse a raw CLIProxyAPI registry document (`channel -> ModelInfo[]`).
 *
 * Fatal shape errors throw. Individual malformed records/channels are skipped
 * with diagnostics so one bad upstream entry cannot poison the rest.
 *
 * @param raw parsed JSON document (not a string).
 * @param source provenance label/version/time for the document.
 */
export function parseRegistryModelDocument(
  raw: unknown,
  source: RegistrySnapshotSourceInput,
): RegistryMetadataIndex {
  const root = asRecord(raw)
  if (root === null) {
    throw new TypeError(
      'CLIProxyAPI registry: document must be an object mapping channel names to model arrays',
    )
  }
  const normalizedSource = normalizeSource(source)
  const diagnostics: RegistryDiagnostic[] = []
  const channels = new Map<string, RegistryModelRecord[]>()
  for (const [channel, value] of Object.entries(root)) {
    if (!Array.isArray(value)) {
      diagnostics.push({
        code: 'invalid-channel',
        message: `${channel}: registry channel must be an array of model entries`,
        channel,
      })
      continue
    }
    const models: RegistryModelRecord[] = []
    for (const entry of value) {
      const model = rawModelRecord(entry, channel, diagnostics)
      if (model !== null) models.push(model)
    }
    channels.set(channel, models)
  }
  return buildIndex(channels, normalizedSource, diagnostics)
}

/**
 * Sanitize a raw registry document into the committed snapshot shape.
 *
 * Only allowlisted capability fields survive: no descriptions, prompts,
 * native capabilities, config, or arbitrary upstream metadata. Attribution is
 * carried explicitly so a consumer can tell which pinned version produced the
 * snapshot.
 */
export function createRegistryMetadataSnapshot(
  raw: unknown,
  source: RegistrySnapshotSourceInput,
): RegistryMetadataSnapshot {
  const index = parseRegistryModelDocument(raw, source)
  const channels: Record<string, RegistrySnapshotRecord[]> = {}
  for (const [channel, models] of index.channels) channels[channel] = [...models]
  return {
    format: REGISTRY_SNAPSHOT_FORMAT,
    formatVersion: REGISTRY_SNAPSHOT_FORMAT_VERSION,
    source: index.source,
    channels,
  }
}

/** Serialize a snapshot in the committed, stable JSON form. */
export function serializeRegistryMetadataSnapshot(snapshot: RegistryMetadataSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

/**
 * Parse a sanitized snapshot back into an index.
 *
 * Fatal envelope errors throw. Malformed records are skipped with diagnostics.
 * Derived effort keys are recomputed from the disclosed raw level names, so a
 * hand-edited snapshot cannot smuggle in an unsupported settings key.
 */
export function parseRegistryMetadataSnapshot(raw: unknown): RegistryMetadataIndex {
  const root = asRecord(raw)
  if (root === null) throw new TypeError('CLIProxyAPI metadata snapshot must be an object')
  if (root.format !== REGISTRY_SNAPSHOT_FORMAT) {
    throw new TypeError(`CLIProxyAPI metadata snapshot: unsupported format ${JSON.stringify(root.format)}`)
  }
  if (root.formatVersion !== REGISTRY_SNAPSHOT_FORMAT_VERSION) {
    throw new TypeError(
      `CLIProxyAPI metadata snapshot: unsupported formatVersion ${JSON.stringify(root.formatVersion)}`,
    )
  }
  const source = asRecord(root.source)
  if (source === null) throw new TypeError('CLIProxyAPI metadata snapshot: source must be an object')
  const normalizedSource = normalizeSource(source as unknown as RegistrySnapshotSourceInput)
  const channelsRaw = asRecord(root.channels)
  if (channelsRaw === null) {
    throw new TypeError('CLIProxyAPI metadata snapshot: channels must be an object')
  }

  const diagnostics: RegistryDiagnostic[] = []
  const channels = new Map<string, RegistryModelRecord[]>()
  for (const [channel, value] of Object.entries(channelsRaw)) {
    if (!Array.isArray(value)) {
      diagnostics.push({
        code: 'invalid-channel',
        message: `${channel}: snapshot channel must be an array of model entries`,
        channel,
      })
      continue
    }
    const models: RegistryModelRecord[] = []
    for (const entry of value) {
      const model = snapshotModelRecord(entry, channel, diagnostics)
      if (model !== null) models.push(model)
    }
    channels.set(channel, models)
  }
  return buildIndex(channels, normalizedSource, diagnostics)
}

/** Resolve one exact model id to disclosed metadata. */
export function resolveRegistryModel(
  index: RegistryMetadataIndex,
  id: string,
  options: RegistryResolveOptions = {},
): RegistryModelLookup {
  if (typeof id !== 'string' || id.length === 0) {
    return {
      status: 'unknown',
      id: String(id),
      diagnostics: [{ code: 'invalid-query', message: 'model id must be a non-empty string', id: String(id) }],
    }
  }

  const channel = nonEmptyString(options.channel)
  const owner = nonEmptyString(options.owner)
  if (channel === null && owner === null) {
    return {
      status: 'unknown',
      id,
      diagnostics: [
        {
          code: 'invalid-query',
          message: 'metadata resolution requires an exact owner or channel; id-only lookup is refused',
          id,
        },
      ],
    }
  }

  const all = index.recordsById.get(id)
  if (all === undefined || all.length === 0) {
    return {
      status: 'unknown',
      id,
      diagnostics: [{ code: 'not-found', message: `model "${id}" is not present in the registry snapshot`, id }],
    }
  }

  let eligible: readonly RegistryChannelRecord[] = all

  if (channel !== null) {
    eligible = eligible.filter((entry) => entry.channel === channel)
    if (eligible.length === 0) {
      return {
        status: 'unknown',
        id,
        diagnostics: [
          {
            code: 'not-found',
            message: `model "${id}" has no record in channel "${channel}"`,
            id,
            channel,
          },
        ],
      }
    }
  }

  if (owner !== null) {
    eligible = eligible.filter((entry) => entry.model.owner === owner)
    if (eligible.length === 0) {
      return {
        status: 'unknown',
        id,
        diagnostics: [
          {
            code: 'not-found',
            message: `model "${id}" has no record owned by "${owner}"`,
            id,
          },
        ],
      }
    }
  }

  if (channel === null && owner !== null) {
    const aliases = options.ownerChannels?.[owner] ?? OWNER_CHANNEL_ALIASES[owner]
    if (aliases !== undefined) {
      const allowed = new Set(aliases)
      eligible = eligible.filter((entry) => allowed.has(entry.channel))
      if (eligible.length === 0) {
        return {
          status: 'unknown',
          id,
          diagnostics: [
            {
              code: 'not-found',
              message: `model "${id}" is not published by any channel aliased to owner "${owner}"`,
              id,
              channels: aliases,
            },
          ],
        }
      }
    }
  }

  const first = eligible[0]
  if (first === undefined) {
    return {
      status: 'unknown',
      id,
      diagnostics: [{ code: 'not-found', message: `model "${id}" produced no eligible record`, id }],
    }
  }

  const fingerprint = disclosedFingerprint(first.model)
  const conflict = eligible.find((entry) => disclosedFingerprint(entry.model) !== fingerprint)
  if (conflict !== undefined) {
    const channels = [...new Set(eligible.map((entry) => entry.channel))]
    return {
      status: 'unknown',
      id,
      diagnostics: [
        {
          code: 'ambiguous',
          message:
            `model "${id}" has conflicting records across channels: ${channels.join(', ')}; ` +
            'supply the exact owner or channel to resolve it',
          id,
          channels,
        },
      ],
    }
  }

  const channels = [...new Set(eligible.map((entry) => entry.channel))]
  return {
    status: 'resolved',
    metadata: {
      ...first.model,
      channel: channels.length === 1 ? channels[0]! : null,
      channels,
      source: index.source,
    },
    diagnostics: [],
  }
}

/** Compare only disclosed metadata, not provenance/channel. */
function disclosedFingerprint(model: RegistryModelRecord): string {
  return JSON.stringify({
    id: model.id,
    owner: model.owner,
    name: model.name,
    contextWindow: model.contextWindow,
    maxInputTokens: model.maxInputTokens,
    maxTokens: model.maxTokens,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    reasoning: model.reasoning,
    levels: model.effort?.levels ?? null,
    zeroAllowed: model.effort?.zeroAllowed ?? null,
    dynamicAllowed: model.effort?.dynamicAllowed ?? null,
    budget: model.effort?.budget ?? null,
  })
}

/** Join bounded body chunks without copying through a string per chunk. */
function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/** Maximum redirects followed by the bounded fetch. */
const MAX_REDIRECTS = 5

/** Redirect statuses handled manually so every hop is validated. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Whether an HTTP origin is an operator-local loopback endpoint. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
}

/** A URL safe to return in diagnostics/attribution: no credentials/query/hash. */
function sanitizedUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`
}

/** Validate one fetch hop, including downgrade checks against the prior hop. */
function urlProblem(url: URL, previous: URL | null): string | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unsupported registry URL protocol'
  if (url.username.length > 0 || url.password.length > 0) return 'registry URL must not carry credentials'
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return 'plain-http registry URLs are allowed only for loopback hosts'
  }
  if (previous?.protocol === 'https:' && url.protocol === 'http:') {
    return 'registry redirect from HTTPS to HTTP is not allowed'
  }
  return null
}

/** Discard a response body without retaining it. */
async function discardBody(response: Response): Promise<void> {
  if (response.body === null) return
  try {
    await response.body.cancel()
  } catch {
    // The body may already be closed; discarding is best effort.
  }
}

/** A caught-error message with no raw URL, credential, or error text. */
function safeErrorMessage(): string {
  return 'registry request failed'
}

/**
 * Fetch a raw registry document with hard time/byte bounds.
 *
 * Redirects are followed manually (max 5), and every hop is validated:
 * credentials are refused, plain HTTP is loopback-only, and HTTPS-to-HTTP
 * downgrades are refused. Redirect/error bodies are cancelled and discarded.
 * There is no headers/auth surface, so this cannot reach a management
 * endpoint; the operator-supplied source remains metadata-only.
 */
export async function fetchRegistryDocument(options: RegistryFetchOptions): Promise<RegistryFetchResult> {
  let current: URL
  try {
    current = new URL(options.url)
  } catch {
    return {
      ok: false,
      url: '',
      bytes: 0,
      diagnostic: { code: 'fetch-failed', message: 'invalid registry URL' },
    }
  }

  const failure = (url: string, message: string, bytes = 0): RegistryFetchResult => ({
    ok: false,
    url,
    bytes,
    diagnostic: { code: 'fetch-failed', message },
  })

  const initialProblem = urlProblem(current, null)
  if (initialProblem !== null) return failure('', initialProblem)
  if (options.signal?.aborted === true) return failure(sanitizedUrl(current), 'registry request aborted before dispatch')

  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_REGISTRY_FETCH_TIMEOUT_MS
  const maxBytes =
    options.maxBytes !== undefined && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_REGISTRY_FETCH_MAX_BYTES

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let safeUrl = sanitizedUrl(current)

  try {
    for (let redirects = 0; ; ) {
      const response = await (options.fetchImpl ?? fetch)(current.toString(), {
        signal: controller.signal,
        redirect: 'manual',
      })

      if (REDIRECT_STATUSES.has(response.status)) {
        await discardBody(response)
        const location = response.headers.get('location')
        if (location === null || location.length === 0) {
          return failure(safeUrl, 'registry redirect is missing a Location header')
        }
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          return failure(safeUrl, 'invalid registry redirect target')
        }
        const nextProblem = urlProblem(next, current)
        if (nextProblem !== null) return failure(safeUrl, nextProblem)
        if (redirects >= MAX_REDIRECTS) {
          return failure(safeUrl, `registry redirect limit (${MAX_REDIRECTS}) exceeded`)
        }
        redirects += 1
        current = next
        safeUrl = sanitizedUrl(current)
        continue
      }

      if (!response.ok) {
        await discardBody(response)
        return failure(safeUrl, `registry request failed with HTTP ${response.status}`)
      }

      const declared = response.headers.get('content-length')
      if (declared !== null) {
        const length = Number(declared)
        if (Number.isFinite(length) && length > maxBytes) {
          await discardBody(response)
          return {
            ok: false,
            url: safeUrl,
            bytes: Math.max(0, Math.floor(length)),
            diagnostic: {
              code: 'response-too-large',
              message: `registry response declared ${length} bytes, over the ${maxBytes}-byte limit`,
            },
          }
        }
      }

      const hash = createHash('sha256')
      let bytes = 0
      const chunks: Uint8Array[] = []
      if (response.body !== null) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          bytes += value.byteLength
          if (bytes > maxBytes) {
            await reader.cancel().catch(() => {})
            controller.abort()
            return {
              ok: false,
              url: safeUrl,
              bytes,
              diagnostic: {
                code: 'response-too-large',
                message: `registry response exceeded the ${maxBytes}-byte limit`,
              },
            }
          }
          hash.update(value)
          chunks.push(value)
        }
      } else {
        const buffer = new Uint8Array(await response.arrayBuffer())
        bytes = buffer.byteLength
        if (bytes > maxBytes) {
          return {
            ok: false,
            url: safeUrl,
            bytes,
            diagnostic: {
              code: 'response-too-large',
              message: `registry response exceeded the ${maxBytes}-byte limit`,
            },
          }
        }
        hash.update(buffer)
        chunks.push(buffer)
      }

      const text = new TextDecoder().decode(concatChunks(chunks, bytes))
      try {
        return {
          ok: true,
          url: safeUrl,
          document: JSON.parse(text) as unknown,
          bytes,
          sha256: hash.digest('hex'),
        }
      } catch {
        return failure(safeUrl, 'registry response is not valid JSON', bytes)
      }
    }
  } catch {
    if (timedOut) return failure(safeUrl, `registry request timed out after ${timeoutMs}ms`)
    return failure(safeUrl, safeErrorMessage())
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Create a per-instance metadata source with last-good fallback.
 *
 * The cache lives only in the returned object and is bound to its own URL.
 * There is no module-global cache, so two routes/URLs can never share a stale
 * snapshot or credentials. A failed refresh returns the last successful
 * snapshot with `stale: true` and a `stale-last-good` diagnostic.
 */
export function createRegistryMetadataSource(
  options: RegistryMetadataSourceOptions,
): RegistryMetadataSource {
  let lastGood: { snapshot: RegistryMetadataSnapshot; index: RegistryMetadataIndex } | null = null
  let lastState: RegistryMetadataSourceState | null = null

  const staleState = (failure: readonly RegistryDiagnostic[]): RegistryMetadataSourceState => {
    if (lastGood === null) {
      lastState = { snapshot: null, index: null, stale: true, diagnostics: failure }
      return lastState
    }
    lastState = {
      snapshot: lastGood.snapshot,
      index: lastGood.index,
      stale: true,
      diagnostics: [
        {
          code: 'stale-last-good',
          message: `registry refresh failed; returning last-good snapshot ${lastGood.snapshot.source.sourceVersion}`,
        },
        ...failure,
      ],
    }
    return lastState
  }

  return {
    async refresh(): Promise<RegistryMetadataSourceState> {
      const fetched = await fetchRegistryDocument(options)
      if (!fetched.ok) return staleState([fetched.diagnostic])
      try {
        const snapshot = createRegistryMetadataSnapshot(fetched.document, {
          sourceUrl: fetched.url,
          sourceVersion: options.sourceVersion,
          sourcePath: options.sourcePath ?? null,
          sourceSha256: fetched.sha256,
          fetchedAt: (options.now?.() ?? new Date()).toISOString(),
          license: options.license,
          attribution: options.attribution,
        })
        const index = parseRegistryMetadataSnapshot(snapshot)
        lastGood = { snapshot, index }
        lastState = { snapshot, index, stale: false, diagnostics: index.diagnostics }
        return lastState
      } catch (error) {
        return staleState([
          {
            code: 'invalid-document',
            message: `registry document was refused: ${error instanceof Error ? error.message : String(error)}`,
          },
        ])
      }
    },
    current(): RegistryMetadataSourceState | null {
      return lastState
    },
  }
}

/** Absolute path of the committed baseline snapshot. */
function bundledSnapshotPath(): string {
  return fileURLToPath(new URL(`../${BUNDLED_REGISTRY_SNAPSHOT_FILE}`, import.meta.url))
}

/** Read the bundled snapshot raw JSON (validated by parse below). */
function readBundledSnapshotRaw(): unknown {
  const path = bundledSnapshotPath()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new Error(
      `CLIProxyAPI metadata snapshot ${path}: unreadable — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return raw
}

/** Load the committed baseline snapshot as a sanitized, resolver-ready index. */
export function loadBundledRegistryMetadataIndex(): RegistryMetadataIndex {
  return parseRegistryMetadataSnapshot(readBundledSnapshotRaw())
}
