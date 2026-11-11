/**
 * Reading a provider's model listing: the provider-neutral fields that
 * `llm-pi-ai` discovery, the heavy-provider planner, and provider sync accept
 * from a `/models` reply or a raw registry document.
 *
 * One reader keeps the capability mapping — context window, input cap, output
 * cap, input modalities, tool/reasoning support, and the advertised effort
 * ladder — identical on every path. A route created by Add therefore carries
 * what a later refresh would disclose instead of losing it to a second,
 * smaller reading.
 *
 * Everything absent or malformed is left undisclosed rather than guessed at.
 * A boolean capability is reported only when the document states it, an effort
 * ladder is reported only when the document advertises one, and a numeric
 * budget never invents named efforts.
 *
 * @module dsh-llm-pi-ai/listing
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'

/**
 * Longest value accepted as a display label or id. A longer string on these
 * fields is prose (the proxy's `description`-as-name habit), not a name.
 */
const MAX_LABEL_CHARS = 200

/**
 * Every pi-ai thinking level a model profile may declare, in escalation order.
 * The `Record` key type is a drift gate: a pi-ai upgrade that adds or removes a
 * level fails compilation here instead of letting the parser silently drop it.
 */
const THINKING_LEVEL_GATE: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/** The declared levels a configured profile accepts; anything else stays parser metadata. */
const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(Object.keys(THINKING_LEVEL_GATE))

/**
 * The modality vocabulary a listing may disclose. The `Record` key type is a
 * drift gate for the same reason as the thinking-level gate.
 */
const MODALITY_GATE: Record<ModelModality, true> = {
  text: true,
  image: true,
  audio: true,
  video: true,
  pdf: true,
}

/** One model entry of a supported listing reply, however the gateway spells its fields. */
export interface ListingEntry {
  id?: unknown
  /** Request alias some registries publish beside the canonical id. */
  slug?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  description?: unknown
  /** Instruction text some registries publish; never read as a prompt or a label. */
  base_instructions?: unknown
  /** Active runtime context caps reported by open-source/local engines (LM Studio, vLLM, SGLang). */
  loaded_context_length?: unknown
  loadedContextLength?: unknown
  max_model_len?: unknown
  maxModelLen?: unknown
  max_context_length?: unknown
  maxContextLength?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  /** Input-only capacity, distinct from the combined context window. */
  maxInputTokens?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_output_tokens?: unknown
  max_tokens?: unknown
  maxTokens?: unknown
  /** Top-level output alias some registries publish. */
  max_completion_tokens?: unknown
  /** Google-style output alias. */
  outputTokenLimit?: unknown
  limit?: { context?: unknown; output?: unknown } | null
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown; max_output_tokens?: unknown } | null
  /** Model type tag some local engines publish (for example LM Studio `vlm`). */
  type?: unknown
  /** Provider-neutral capability block some gateways (and Anthropic) nest per model, or string capability array. */
  capabilities?: unknown
  /** Flat boolean disclosures used by LiteLLM / OpenAI-compatible hosting servers. */
  supports_function_calling?: unknown
  supports_tool_choice?: unknown
  supports_vision?: unknown
  supports_reasoning?: unknown
  supports_audio_input?: unknown
  supports_video_input?: unknown
  supports_pdf_input?: unknown
  /** Raw registry input-modality spellings. */
  supportedInputModalities?: unknown
  input_modalities?: unknown
  modalities?: { input?: unknown } | null
  architecture?: { input_modalities?: unknown } | null
  /** Explicit tool/reasoning claims; absent means undisclosed. */
  tools?: unknown
  tool_call?: unknown
  reasoning?: unknown
  thinking?: unknown
  /** OpenRouter-style enumeration of supported request parameters. */
  supported_parameters?: unknown
  /** Raw registry ladder of `{ effort, ... }` descriptors or plain strings. */
  supported_reasoning_levels?: unknown
}

/** The capability fields one listing entry discloses. */
export interface ListingCapabilities {
  /** Maximum combined request and response context the entry disclosed. */
  contextWindow?: number
  /** Maximum input tokens the entry disclosed separately from the combined context window. */
  maxInputTokens?: number
  /** Maximum output tokens the entry disclosed. */
  maxTokens?: number
  /**
   * Accepted input modalities the entry explicitly disclosed. A text-only
   * array stays `['text']`; absent means undisclosed, never "text only".
   */
  inputModalities?: readonly ModelModality[]
  /** Whether the entry explicitly stated tool-call support; absent means undisclosed. */
  tools?: boolean
  /** Whether the entry explicitly stated reasoning support; absent means undisclosed. */
  reasoning?: boolean
  /**
   * Selectable reasoning levels (picker id → wire value) the entry disclosed.
   * Only identifiers a configured profile accepts appear here. An explicit
   * empty ladder is `{}`; absent means undisclosed.
   */
  reasoningEfforts?: Readonly<Record<string, string>>
  /**
   * Effort identifiers the entry advertised that no configured profile accepts,
   * preserved verbatim for diagnostics. They never reach a materialized ladder.
   */
  unsupportedReasoningEfforts?: readonly string[]
}

/** One model read from a listing body. */
export interface ListingModel extends ListingCapabilities {
  /** Request id: a named model-map key, then the entry's `id`, then `slug` when neither exists. */
  readonly id: string
  /** Human-readable name when the entry supplied one. */
  readonly name?: string
  /** The entry's `slug` when it accompanied or supplied the request id. */
  readonly sourceAlias?: string
  /** Exact endpoint owner namespace used only for scoped metadata lookup. */
  readonly owner?: string
}

/** Why a request body could not be read as a model listing. */
export type ListingReadFailure = 'not-a-listing' | 'no-usable-models'

/** Outcome of {@link readModelListing}; valid empty is distinct from invalid. */
export type ListingReadResult =
  | { readonly ok: true; readonly models: readonly ListingModel[] }
  | { readonly ok: false; readonly reason: ListingReadFailure }

/**
 * A positive integer field of a listing entry, or `undefined` when absent or unusable.
 * @param candidates - field values in precedence order.
 * @returns the first positive integer.
 */
export function listingCapacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * A non-empty, plausibly-a-name string field of a listing entry, or
 * `undefined` when every candidate is absent, empty, or prose-length.
 * @param candidates - field values in precedence order.
 * @returns the first usable string.
 */
export function listingText(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_LABEL_CHARS) return candidate
  }
  return undefined
}

/** A plain JSON object, or `undefined` for anything else (arrays included). */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

/** Whether one `{ supported: boolean }` capability object explicitly advertises support. */
function supported(value: unknown): boolean {
  return typeof value === 'boolean' ? value : record(value)?.supported === true
}

/** An explicitly stated boolean capability, or `undefined` when the document stayed silent. */
function statedBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** A boolean carried directly or in a `{ supported: boolean }` block. */
function capabilityBoolean(value: unknown): boolean | undefined {
  const stated = statedBoolean(value)
  if (stated !== undefined) return stated
  const block = record(value)
  return typeof block?.supported === 'boolean' ? block.supported : undefined
}

/** One disclosed modality token, including the `vision` alias, or `undefined`. */
function modalityToken(value: unknown): ModelModality | undefined {
  if (typeof value !== 'string') return undefined
  if (value === 'vision') return 'image'
  return Object.hasOwn(MODALITY_GATE, value) ? value as ModelModality : undefined
}

/** The recognized, deduplicated modalities of one disclosed array, preserving order. */
function modalityList(raw: readonly unknown[]): ModelModality[] {
  const modalities: ModelModality[] = []
  for (const value of raw) {
    const modality = modalityToken(value)
    if (modality !== undefined && !modalities.includes(modality)) modalities.push(modality)
  }
  return modalities
}

/** The first declared modality array of an entry, in precedence order. */
function declaredModalities(entry: ListingEntry): readonly unknown[] | undefined {
  const modalities = record(entry.modalities)
  const architecture = record(entry.architecture)
  for (const candidate of [
    entry.supportedInputModalities,
    entry.input_modalities,
    modalities?.input,
    architecture?.input_modalities,
  ]) {
    if (Array.isArray(candidate)) return candidate as readonly unknown[]
  }
  return undefined
}

/** Explicit capability flags parsed from a string `capabilities` array (Ollama / LM Studio). */
function capabilityArrayTags(raw: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(raw)) return undefined
  const tags = new Set<string>()
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) tags.add(item.toLowerCase())
  }
  return tags
}

/** The modalities a provider-neutral capability block, tag array, or flat host booleans advertise. */
function capabilityModalities(
  entry: ListingEntry,
  capabilities: Readonly<Record<string, unknown>> | undefined,
  capabilityTags: ReadonlySet<string> | undefined,
): ModelModality[] {
  const modalities: ModelModality[] = []
  const add = (modality: ModelModality): void => {
    if (!modalities.includes(modality)) modalities.push(modality)
  }
  const flags: readonly [string, ModelModality][] = [
    ['text_input', 'text'],
    ['image_input', 'image'],
    ['audio_input', 'audio'],
    ['video_input', 'video'],
    ['pdf_input', 'pdf'],
  ]
  for (const [field, modality] of flags) {
    if (supported(capabilities?.[field])) add(modality)
  }
  if (capabilityTags !== undefined) {
    if (capabilityTags.has('vision') || capabilityTags.has('image')) add('image')
    if (capabilityTags.has('audio')) add('audio')
    if (capabilityTags.has('video')) add('video')
    if (capabilityTags.has('pdf')) add('pdf')
  }
  if (typeof entry.type === 'string' && entry.type.toLowerCase() === 'vlm') add('image')
  if (entry.supports_vision === true) add('image')
  if (entry.supports_audio_input === true) add('audio')
  if (entry.supports_video_input === true) add('video')
  if (entry.supports_pdf_input === true) add('pdf')
  return modalities
}

/** One disclosed effort ladder before the configured-level split. */
interface ListedLevels {
  /** Advertised identifiers in disclosure order with their exact wire spelling. */
  readonly levels: ReadonlyMap<string, string>
  /** Whether the document explicitly supplied a ladder, even an empty one. */
  readonly declared: boolean
}

/** The wire spelling of one advertised effort, or `undefined` when it is not offered. */
function effortWire(id: string, raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'boolean') return raw ? id : undefined
  if (raw === null) return id === 'off' ? '' : undefined
  const descriptor = record(raw)
  if (descriptor === undefined || descriptor.supported === false) return undefined
  const wire = listingText(descriptor.value, descriptor.wire, descriptor.wire_value)
  if (wire !== undefined) return wire
  return descriptor.supported === true ? id : undefined
}

/** Read one effort map (`{ level: descriptor | wire }`) without treating a status marker as a level. */
function listedEffortMap(raw: unknown): ListedLevels | undefined {
  const map = record(raw)
  if (map === undefined) return undefined
  const levels = new Map<string, string>()
  for (const [id, descriptor] of Object.entries(map)) {
    if (id.length === 0 || id === 'supported') continue
    const wire = effortWire(id, descriptor)
    if (wire !== undefined && !levels.has(id)) levels.set(id, wire)
  }
  return { levels, declared: true }
}

/** Read one effort array of `{ effort, ... }` descriptors or plain strings. */
function listedEffortArray(raw: readonly unknown[]): ListedLevels {
  const levels = new Map<string, string>()
  for (const value of raw) {
    if (typeof value === 'string') {
      if (value.length > 0 && !levels.has(value)) levels.set(value, value)
      continue
    }
    const descriptor = record(value)
    if (descriptor === undefined || descriptor.supported === false) continue
    const id = listingText(descriptor.effort)
    if (id === undefined) continue
    const wire = listingText(descriptor.value, descriptor.wire, descriptor.wire_value) ?? id
    if (!levels.has(id)) levels.set(id, wire)
  }
  return { levels, declared: true }
}

/** Read a level source that may be either the map or the array spelling. */
function listedLevels(raw: unknown): ListedLevels | undefined {
  return Array.isArray(raw) ? listedEffortArray(raw) : listedEffortMap(raw)
}

/** Keys that mark a `reasoning`/`thinking` object as metadata rather than a level map. */
const LEVEL_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'supported',
  'mandatory',
  'default_effort',
  'defaultEffort',
  'supported_efforts',
  'supportedEfforts',
  'reasoning_options',
  'options',
  'types',
  'budget_tokens',
  'budgets',
])

/**
 * Read the advertised ladders from every spelling this parser accepts. A
 * source that is present but empty still counts as a declaration; a source
 * with only an unsupported marker contributes no levels.
 */
function reasoningLevels(entry: ListingEntry, capabilities: Readonly<Record<string, unknown>> | undefined): ListedLevels[] {
  const found: ListedLevels[] = []
  const capabilityEfforts = listedEffortMap(capabilities?.effort)
  if (capabilityEfforts !== undefined) found.push(capabilityEfforts)

  const capabilityReasoning = record(capabilities?.reasoning)
  const capabilityLevels = listedLevels(capabilityReasoning?.efforts ?? capabilityReasoning?.levels)
  if (capabilityLevels !== undefined) found.push(capabilityLevels)

  const supportedLevels = listedLevels(entry.supported_reasoning_levels)
  if (supportedLevels !== undefined) found.push(supportedLevels)

  const reasoning = record(entry.reasoning)
  if (reasoning !== undefined) {
    const explicit = listedLevels(reasoning.efforts ?? reasoning.levels ?? reasoning.values)
    if (explicit !== undefined) found.push(explicit)
    else {
      // A `reasoning` object may be a bare level map, optionally beside its
      // own status marker; metadata-shaped objects (OpenRouter's
      // `mandatory`/`supported_efforts`) leave no level keys behind.
      const levels: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(reasoning)) {
        if (!LEVEL_CONTAINER_KEYS.has(key)) levels[key] = value
      }
      const direct = listedEffortMap(levels)
      if (direct !== undefined && direct.levels.size > 0) found.push(direct)
    }
  }

  const thinking = record(entry.thinking)
  const thinkingLevels = listedLevels(thinking?.levels ?? thinking?.efforts)
  if (thinkingLevels !== undefined) found.push(thinkingLevels)
  return found
}

/** Whether a raw `thinking` block explicitly allows no-thinking output. */
function zeroAllowed(entry: ListingEntry, capabilities: Readonly<Record<string, unknown>> | undefined): boolean {
  const thinking = record(entry.thinking)
  const capabilityThinking = record(capabilities?.thinking)
  return thinking?.zero_allowed === true
    || thinking?.zeroAllowed === true
    || capabilityThinking?.zero_allowed === true
    || capabilityThinking?.zeroAllowed === true
}

/** Explicit tool-call support, when the entry, tag array, or capability block states it. */
function listedTools(
  entry: ListingEntry,
  capabilities: Readonly<Record<string, unknown>> | undefined,
  capabilityTags: ReadonlySet<string> | undefined,
): boolean | undefined {
  const stated = statedBoolean(entry.tools)
    ?? statedBoolean(entry.tool_call)
    ?? capabilityBoolean(entry.tools)
    ?? capabilityBoolean(entry.tool_call)
    ?? statedBoolean(entry.supports_function_calling)
    ?? statedBoolean(entry.supports_tool_choice)
  if (stated !== undefined) return stated
  const blocked = capabilityBoolean(capabilities?.tools) ?? capabilityBoolean(capabilities?.tool_call)
  if (blocked !== undefined) return blocked
  if (capabilityTags !== undefined && (capabilityTags.has('tools') || capabilityTags.has('tool_use') || capabilityTags.has('function_calling'))) {
    return true
  }
  if (!Array.isArray(entry.supported_parameters)) return undefined
  const parameters = entry.supported_parameters.filter((value): value is string => typeof value === 'string')
  return parameters.includes('tools') || parameters.includes('tool_choice')
}

/** Explicit reasoning support, when the entry, tag array, or capability block states it. */
function listedReasoning(
  entry: ListingEntry,
  capabilities: Readonly<Record<string, unknown>> | undefined,
  capabilityTags: ReadonlySet<string> | undefined,
): boolean | undefined {
  const stated = statedBoolean(entry.reasoning)
    ?? capabilityBoolean(entry.reasoning)
    ?? statedBoolean(entry.supports_reasoning)
  if (stated !== undefined) return stated
  const blocked = capabilityBoolean(capabilities?.reasoning) ?? capabilityBoolean(capabilities?.thinking)
  if (blocked !== undefined) return blocked
  if (capabilityTags !== undefined && (capabilityTags.has('thinking') || capabilityTags.has('reasoning'))) {
    return true
  }
  if (!Array.isArray(entry.supported_parameters)) return undefined
  return entry.supported_parameters.includes('reasoning')
}

/**
 * Read what one listing entry discloses: its capacities, input modalities,
 * tool/reasoning claims, and the offered effort ladder. Supported
 * `image_input` / `pdf_input` capability booleans become input modalities,
 * with `text` implied only when the modalities came from those booleans rather
 * than an explicit array. An advertised `effort` map, `supported_reasoning_levels`
 * array, or raw `thinking.levels` becomes the ladder; `thinking.zero_allowed`
 * adds `off` only when it is explicitly true. Unknown effort identifiers stay
 * in {@link ListingCapabilities.unsupportedReasoningEfforts} instead of being
 * renamed or coerced.
 * @param entry - one listing entry, as read from the reply.
 * @returns the disclosed fields; undisclosed ones are absent, never guessed.
 */
export function listingCapabilities(entry: ListingEntry | null | undefined): ListingCapabilities {
  const contextWindow = listingCapacity(
    entry?.loaded_context_length,
    entry?.loadedContextLength,
    entry?.max_model_len,
    entry?.maxModelLen,
    entry?.max_context_length,
    entry?.maxContextLength,
    entry?.contextWindow,
    entry?.context_window,
    entry?.context_length,
    entry?.limit?.context,
    entry?.top_provider?.context_length,
  )
  const maxInputTokens = listingCapacity(entry?.maxInputTokens, entry?.max_input_tokens)
  const maxTokens = listingCapacity(
    entry?.maxOutputTokens,
    entry?.max_output_tokens,
    entry?.maxTokens,
    entry?.max_tokens,
    entry?.max_completion_tokens,
    entry?.outputTokenLimit,
    entry?.limit?.output,
    entry?.top_provider?.max_completion_tokens,
    entry?.top_provider?.max_output_tokens,
  )
  const capabilities = record(entry?.capabilities)
  const capabilityTags = capabilityArrayTags(entry?.capabilities)

  const declared = declaredModalities(entry ?? {})
  const advertised = capabilityModalities(entry ?? {}, capabilities, capabilityTags)
  let inputModalities: ModelModality[] | undefined
  if (declared !== undefined) {
    const normalized = modalityList(declared)
    inputModalities = normalized.length === 0 && advertised.length === 0
      ? undefined
      : [...normalized, ...advertised.filter(modality => !normalized.includes(modality))]
  } else if (advertised.length > 0) {
    inputModalities = [...new Set<ModelModality>(['text', ...advertised])]
  }

  const levels = reasoningLevels(entry ?? {}, capabilities)
  const efforts = new Map<string, string>()
  for (const source of levels) {
    for (const [id, wire] of source.levels) {
      if (!efforts.has(id)) efforts.set(id, wire)
    }
  }
  const supportsZero = zeroAllowed(entry ?? {}, capabilities)
  if (supportsZero && !efforts.has('off')) efforts.set('off', '')
  const ladder: Record<string, string> = {}
  const unsupported: string[] = []
  for (const [id, wire] of efforts) {
    if (THINKING_LEVEL_SET.has(id)) ladder[id] = wire
    else if (!unsupported.includes(id)) unsupported.push(id)
  }
  const declaredLadder = levels.length > 0 || supportsZero

  const tools = listedTools(entry ?? {}, capabilities, capabilityTags)
  const reasoning = listedReasoning(entry ?? {}, capabilities, capabilityTags)

  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxInputTokens === undefined ? {} : { maxInputTokens },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...inputModalities === undefined ? {} : { inputModalities },
    ...tools === undefined ? {} : { tools },
    ...reasoning === undefined ? {} : { reasoning },
    ...declaredLadder ? { reasoningEfforts: ladder } : {},
    ...unsupported.length === 0 ? {} : { unsupportedReasoningEfforts: unsupported },
  }
}

/** One row of a listing body: the model record and, for a `models` map, its property key. */
interface ListingRow {
  readonly key?: string
  readonly raw: unknown
}

/** The rows of a listing body, or `undefined` when the body is not a listing. */
function listingRows(body: unknown): readonly ListingRow[] | undefined {
  if (Array.isArray(body)) return (body as readonly unknown[]).map(raw => ({ raw }))
  const listing = record(body)
  if (listing === undefined) return undefined
  if (Array.isArray(listing.data)) return (listing.data as readonly unknown[]).map(raw => ({ raw }))
  const models = listing.models
  if (Array.isArray(models)) return (models as readonly unknown[]).map(raw => ({ raw }))
  const map = record(models)
  if (map === undefined) return undefined
  return Object.entries(map).map(([key, raw]) => ({ key, raw }))
}

/**
 * Read one provider listing body. Supported containers are a top-level array,
 * `{ data: [...] }`, `{ models: [...] }`, and the enriched `{ models: {...} }`
 * map. `data` takes precedence when both containers are present. A recognized
 * but empty container is a valid empty listing; a body with no recognized
 * container is invalid. Rows without a usable id are skipped rather than
 * failing the whole reply.
 *
 * The request id comes from the entry's `id` (or the map key for an enriched
 * map). `slug` is accepted only when those are absent, and is retained as
 * {@link ListingModel.sourceAlias} rather than replacing an actual id.
 * @param body - parsed JSON body of a `/models` reply or raw registry document.
 * @returns the models in endpoint order, or the invalid-body result.
 */
export function readModelListing(body: unknown): ListingReadResult {
  const rows = listingRows(body)
  if (rows === undefined) return { ok: false, reason: 'not-a-listing' }
  const models: ListingModel[] = []
  for (const { key, raw } of rows) {
    const row = record(raw)
    if (row === undefined) continue
    const entry = row as ListingEntry
    const id = listingText(key) ?? listingText(entry.id) ?? listingText(entry.slug)
    if (id === undefined) continue
    const name = listingText(entry.name, entry.display_name, entry.displayName)
    const sourceAlias = listingText(entry.slug)
    const owner = listingText(row.owned_by)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...sourceAlias === undefined ? {} : { sourceAlias },
      ...owner === undefined ? {} : { owner },
      ...listingCapabilities(entry),
    })
  }
  if (rows.length > 0 && models.length === 0) return { ok: false, reason: 'no-usable-models' }
  return { ok: true, models }
}
