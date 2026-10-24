/**
 * Reading a provider's model listing: the provider-neutral fields both
 * `llm-pi-ai` discovery and the heavy-provider planner accept from a
 * `/models` reply.
 *
 * The Models page asks through `discovery.ts`; the heavy-provider Add flow
 * reads the same reply through the planner, before any llm-pi-ai discovery
 * runs. One parser keeps the capability mapping — context window, output cap,
 * input modalities, and the advertised effort ladder — identical on both
 * paths, so a route created by Add carries what a later refresh would
 * disclose instead of losing it to a second, smaller reading.
 *
 * Everything absent or malformed is left undisclosed rather than guessed at.
 *
 * @module dsh-llm-pi-ai/listing
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'

/**
 * Longest value accepted as a display label or id. A longer string on these
 * fields is prose (the proxy's `description`-as-name habit), not a name.
 */
const MAX_LABEL_CHARS = 200

/** One model entry of a supported listing reply, however the gateway spells its fields. */
export interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  description?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_output_tokens?: unknown
  max_tokens?: unknown
  maxTokens?: unknown
  limit?: { context?: unknown; output?: unknown } | null
  top_provider?: { max_completion_tokens?: unknown } | null
  /** Provider-neutral capability block some gateways (and Anthropic) nest per model. */
  capabilities?: unknown
}

/** The capability fields one listing entry discloses. */
export interface ListingCapabilities {
  /** Maximum combined request and response context the entry disclosed. */
  contextWindow?: number
  /** Maximum output tokens the entry disclosed. */
  maxTokens?: number
  /** Accepted input modalities the entry disclosed, `text` always among them. */
  inputModalities?: readonly ModelModality[]
  /** Selectable reasoning levels (picker id → wire value) the entry disclosed. */
  reasoningEfforts?: Readonly<Record<string, string>>
}

/** One `{ supported: boolean }` capability object in a listing's `capabilities` block. */
interface ListingCapability {
  supported?: unknown
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
export function listingCapacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/**
 * A non-empty, plausibly-a-name string field of a listing entry, or
 * `undefined` when every candidate is absent, empty, or prose-length.
 */
export function listingText(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= MAX_LABEL_CHARS) return candidate
  }
  return undefined
}

/** Whether one capability object explicitly advertises support. */
function supported(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as ListingCapability).supported === true
}

/** A plain JSON object, or `undefined` for anything else (arrays included). */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

/**
 * Turn a listing's `capabilities.effort` block into selectable reasoning
 * levels. Only entries that explicitly report `supported: true` are offered;
 * the picker id is the advertised key and the wire value keeps the same
 * spelling because no per-gateway mapping was disclosed. A malformed or
 * absent block yields no levels instead of failing the discovery pass.
 */
function listedEfforts(raw: unknown): Readonly<Record<string, string>> | undefined {
  const efforts = record(raw)
  if (efforts === undefined) return undefined
  const levels: Record<string, string> = {}
  for (const [level, capability] of Object.entries(efforts)) {
    if (level.length > 0 && supported(capability)) levels[level] = level
  }
  return Object.keys(levels).length > 0 ? levels : undefined
}

/**
 * Read what one listing entry discloses: its capacities and the capabilities
 * in its provider-neutral block. Supported `image_input` / `pdf_input` become
 * input modalities, with `text` implied as it is for every prompt-capable
 * model; `effort` becomes the reasoning ladder.
 * @param entry - one listing entry, as read from the reply.
 * @returns the disclosed fields; undisclosed ones are absent, never guessed.
 */
export function listingCapabilities(entry: ListingEntry | null | undefined): ListingCapabilities {
  const contextWindow = listingCapacity(
    entry?.contextWindow,
    entry?.context_window,
    entry?.context_length,
    entry?.max_input_tokens,
    entry?.limit?.context,
  )
  const maxTokens = listingCapacity(
    entry?.maxOutputTokens,
    entry?.max_output_tokens,
    entry?.maxTokens,
    entry?.max_tokens,
    entry?.limit?.output,
    entry?.top_provider?.max_completion_tokens,
  )
  const capabilities = record(entry?.capabilities)
  const reasoningEfforts = capabilities === undefined ? undefined : listedEfforts(capabilities.effort)
  const modalities: ModelModality[] = ['text']
  if (supported(capabilities?.image_input)) modalities.push('image')
  if (supported(capabilities?.pdf_input)) modalities.push('pdf')
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...modalities.length === 1 ? {} : { inputModalities: modalities },
  }
}
