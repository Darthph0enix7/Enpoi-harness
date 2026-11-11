/**
 * Same-host sibling endpoint enrichment for model discovery.
 *
 * Many proxies and self-hosted model servers expose multiple API dialects on
 * the exact same host and credential, where the standard OpenAI `GET /models`
 * reply omits capabilities or limits that a sibling endpoint on the same server
 * knows live (for example Gemini `/v1beta/models`, Anthropic `/v1/models` with
 * `anthropic-version`, LM Studio `/api/v0/models`, LiteLLM `/model/info`, or
 * Ollama `/api/tags` + `/api/show`).
 *
 * Membership is NEVER altered here: only IDs already returned by the primary
 * listing are enriched, and only fields the primary listing left undisclosed.
 * Probes are bounded, fail-open, and skipped entirely when the primary
 * listing already disclosed complete metadata.
 *
 * @module dsh-enpoi-provider-sync/sibling-discovery
 */

import { listingCapabilities, type ListingEntry } from '@deepseek-ai/dsh-llm-pi-ai'

/** Per-probe wall-clock timeout so a silent sibling route never stalls refresh. */
const SIBLING_PROBE_TIMEOUT_MS = 2500

/** Largest sibling response body accepted (4 MiB). */
const MAX_SIBLING_BYTES = 4 * 1024 * 1024

/** Maximum Ollama `/api/show` fan-out per pass and concurrency limit. */
const MAX_OLLAMA_SHOW_MODELS = 32
const OLLAMA_SHOW_CONCURRENCY = 4

/** Anthropic API version required by `/v1/models` on Anthropic-compatible servers. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Minimal model shape enriched in place from sibling endpoints. */
export interface SiblingEnrichableModel {
  id: string
  name?: string
  contextWindow?: number
  maxInputTokens?: number
  maxTokens?: number
  input?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  tools?: boolean
  reasoning?: boolean
  reasoningEfforts?: Readonly<Record<string, string>>
  unsupportedReasoningEfforts?: readonly string[]
}

/** Options controlling same-host sibling endpoint probing. */
export interface SiblingProbeOptions {
  /** Primary wire protocol (`openai-completions`, `anthropic-messages`, etc.). */
  api?: string
  /** Route credential, if any. */
  key?: string
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof globalThis.fetch
  /** Optional per-probe timeout override in milliseconds. */
  timeoutMs?: number
}

/** Whether a model still lacks fields a sibling endpoint on the same host could fill. */
function needsSiblingMetadata(model: SiblingEnrichableModel): boolean {
  return model.name === undefined
    || (model.contextWindow === undefined && model.maxInputTokens === undefined)
    || model.maxTokens === undefined
    || model.input === undefined
    || model.tools === undefined
    || model.reasoning === undefined
}

/** Derive the host root URL by stripping a trailing versioned API suffix (`/v1`, `/v1beta`, `/api/v1`). */
export function endpointRootUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '')
  return trimmed.replace(/\/(?:api\/v1|v1beta|v1)$/i, '')
}

/** Narrow plain JSON object check. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Positive integer helper. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** Bounded JSON fetch returning `undefined` on any transport, HTTP, size, or parse failure. */
async function fetchBoundedJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  try {
    const response = await fetchImpl(url, init)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    const declared = Number(response.headers?.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_SIBLING_BYTES) {
      await response.body?.cancel().catch(() => {})
      return undefined
    }
    let text: string
    if (response.body === null || response.body === undefined) {
      text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_SIBLING_BYTES) return undefined
    } else {
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          total += value.byteLength
          if (total > MAX_SIBLING_BYTES) return undefined
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      text = new TextDecoder().decode(merged)
    }
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Build shared auth headers without modifying the URL. */
function bearerHeaders(key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`
  return headers
}

/** Partial metadata patch extracted from a sibling endpoint for one primary model ID. */
interface SiblingPatch {
  name?: string
  contextWindow?: number
  maxInputTokens?: number
  maxTokens?: number
  input?: Array<'text' | 'image' | 'audio' | 'video' | 'pdf'>
  tools?: boolean
  reasoning?: boolean
  reasoningEfforts?: Readonly<Record<string, string>>
  unsupportedReasoningEfforts?: readonly string[]
}

/** Merge a patch into an existing model, strictly filling only fields still absent on target. */
function applyPatchMissing(target: SiblingEnrichableModel, patch: SiblingPatch): void {
  if (target.name === undefined && patch.name !== undefined && patch.name !== target.id && patch.name.length <= 60) {
    target.name = patch.name
  }
  if (target.contextWindow === undefined && patch.contextWindow !== undefined) {
    target.contextWindow = patch.contextWindow
  }
  if (target.maxInputTokens === undefined && patch.maxInputTokens !== undefined) {
    target.maxInputTokens = patch.maxInputTokens
  }
  if (target.maxTokens === undefined && patch.maxTokens !== undefined) {
    target.maxTokens = patch.maxTokens
  }
  if (target.input === undefined && patch.input !== undefined && patch.input.length > 0) {
    target.input = [...patch.input]
  }
  if (target.tools === undefined && patch.tools !== undefined) {
    target.tools = patch.tools
  }
  if (target.reasoning === undefined && patch.reasoning !== undefined) {
    target.reasoning = patch.reasoning
  }
  if (target.reasoningEfforts === undefined && patch.reasoningEfforts !== undefined) {
    target.reasoningEfforts = { ...patch.reasoningEfforts }
  }
  if (target.unsupportedReasoningEfforts === undefined && patch.unsupportedReasoningEfforts !== undefined) {
    target.unsupportedReasoningEfforts = [...patch.unsupportedReasoningEfforts]
  }
}

/** Extract patch fields from a generic ListingEntry-shaped record. */
function patchFromListingRecord(row: Record<string, unknown>, id: string): SiblingPatch {
  const caps = listingCapabilities(row as ListingEntry)
  const rawName = typeof row.displayName === 'string' && row.displayName.length > 0
    ? row.displayName
    : typeof row.display_name === 'string' && row.display_name.length > 0
      ? row.display_name
      : typeof row.name === 'string' && row.name.length > 0 && !row.name.startsWith('models/')
        ? row.name
        : undefined
  return {
    ...rawName === undefined || rawName === id ? {} : { name: rawName },
    ...caps.contextWindow === undefined ? {} : { contextWindow: caps.contextWindow },
    ...caps.maxInputTokens === undefined ? {} : { maxInputTokens: caps.maxInputTokens },
    ...caps.maxTokens === undefined ? {} : { maxTokens: caps.maxTokens },
    ...caps.inputModalities === undefined ? {} : { input: [...caps.inputModalities] },
    ...caps.tools === undefined ? {} : { tools: caps.tools },
    ...caps.reasoning === undefined ? {} : { reasoning: caps.reasoning },
    ...caps.reasoningEfforts === undefined ? {} : { reasoningEfforts: caps.reasoningEfforts },
    ...caps.unsupportedReasoningEfforts === undefined ? {} : { unsupportedReasoningEfforts: caps.unsupportedReasoningEfforts },
  }
}

/** Probe Gemini `{root}/v1beta/models` for matching primary IDs. */
async function probeGeminiModels(
  root: string,
  key: string | undefined,
  knownIds: ReadonlySet<string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Map<string, SiblingPatch>> {
  const result = new Map<string, SiblingPatch>()
  const headers = bearerHeaders(key)
  if (key !== undefined && key.length > 0) headers['x-goog-api-key'] = key
  const body = await fetchBoundedJson(
    `${root}/v1beta/models`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
    fetchImpl,
  )
  const obj = asObject(body)
  if (!Array.isArray(obj?.models)) return result
  for (const item of obj.models) {
    const row = asObject(item)
    if (row === undefined) continue
    const rawId = typeof row.id === 'string' && row.id.length > 0
      ? row.id
      : typeof row.name === 'string' && row.name.length > 0
        ? (row.name.startsWith('models/') ? row.name.slice(7) : row.name)
        : undefined
    if (rawId === undefined || !knownIds.has(rawId)) continue
    const patch = patchFromListingRecord(row, rawId)
    const inputLimit = positiveInt(row.inputTokenLimit)
    if (patch.maxInputTokens === undefined && inputLimit !== undefined) {
      patch.maxInputTokens = inputLimit
    }
    result.set(rawId, patch)
  }
  return result
}

/** Probe Anthropic `{root}/v1/models?limit=1000` with `anthropic-version` for matching primary IDs. */
async function probeAnthropicModels(
  root: string,
  key: string | undefined,
  knownIds: ReadonlySet<string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Map<string, SiblingPatch>> {
  const result = new Map<string, SiblingPatch>()
  const headers: Record<string, string> = {
    ...bearerHeaders(key),
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (key !== undefined && key.length > 0) headers['x-api-key'] = key
  const body = await fetchBoundedJson(
    `${root}/v1/models?limit=1000`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
    fetchImpl,
  )
  const obj = asObject(body)
  const rows = Array.isArray(obj?.data) ? obj.data : undefined
  if (rows === undefined) return result
  for (const item of rows) {
    const row = asObject(item)
    if (row === undefined) continue
    const id = typeof row.id === 'string' ? row.id : undefined
    if (id === undefined || !knownIds.has(id)) continue
    result.set(id, patchFromListingRecord(row, id))
  }
  return result
}

/** Probe LM Studio `{root}/api/v0/models` for live VRAM `loaded_context_length` and `vlm`/tool tags. */
async function probeLmStudioModels(
  root: string,
  key: string | undefined,
  knownIds: ReadonlySet<string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Map<string, SiblingPatch>> {
  const result = new Map<string, SiblingPatch>()
  const body = await fetchBoundedJson(
    `${root}/api/v0/models`,
    { headers: bearerHeaders(key), signal: AbortSignal.timeout(timeoutMs) },
    fetchImpl,
  )
  const obj = asObject(body)
  const rows = Array.isArray(body) ? body : Array.isArray(obj?.data) ? obj.data : undefined
  if (rows === undefined) return result
  for (const item of rows) {
    const row = asObject(item)
    if (row === undefined) continue
    const id = typeof row.id === 'string' ? row.id : undefined
    if (id === undefined || !knownIds.has(id)) continue
    result.set(id, patchFromListingRecord(row, id))
  }
  return result
}

/** Probe LiteLLM `{root}/model/info` for configured upstream `model_info` limits & flags. */
async function probeLiteLlmModelInfo(
  root: string,
  key: string | undefined,
  knownIds: ReadonlySet<string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Map<string, SiblingPatch>> {
  const result = new Map<string, SiblingPatch>()
  const body = await fetchBoundedJson(
    `${root}/model/info`,
    { headers: bearerHeaders(key), signal: AbortSignal.timeout(timeoutMs) },
    fetchImpl,
  )
  const obj = asObject(body)
  if (!Array.isArray(obj?.data)) return result
  for (const item of obj.data) {
    const row = asObject(item)
    if (row === undefined) continue
    const info = asObject(row.model_info)
    const id = typeof row.model_name === 'string' && row.model_name.length > 0
      ? row.model_name
      : typeof info?.id === 'string' && info.id.length > 0
        ? info.id
        : undefined
    if (id === undefined || !knownIds.has(id) || info === undefined) continue
    const patch = patchFromListingRecord(info, id)
    // LiteLLM often places context cap in `max_input_tokens` alongside `max_output_tokens`.
    const maxInput = positiveInt(info.max_input_tokens)
    if (patch.maxInputTokens === undefined && maxInput !== undefined) {
      patch.maxInputTokens = maxInput
    }
    result.set(id, patch)
  }
  return result
}

/** Extract configured `num_ctx` or GGUF `*.context_length` and capabilities from Ollama `/api/show`. */
function parseOllamaShow(body: unknown): SiblingPatch | undefined {
  const obj = asObject(body)
  if (obj === undefined) return undefined
  let contextWindow: number | undefined
  if (typeof obj.parameters === 'string') {
    const match = /^\s*num_ctx\s+(\d+)\b/m.exec(obj.parameters)
    if (match?.[1] !== undefined) {
      const parsed = Number.parseInt(match[1], 10)
      if (Number.isInteger(parsed) && parsed > 0) contextWindow = parsed
    }
  }
  if (contextWindow === undefined) {
    const modelInfo = asObject(obj.model_info)
    if (modelInfo !== undefined) {
      for (const [field, value] of Object.entries(modelInfo)) {
        if (field.endsWith('.context_length')) {
          const cap = positiveInt(value)
          if (cap !== undefined) {
            contextWindow = cap
            break
          }
        }
      }
    }
  }
  const caps = listingCapabilities({ capabilities: obj.capabilities })
  const patch: SiblingPatch = {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...caps.inputModalities === undefined ? {} : { input: [...caps.inputModalities] },
    ...caps.tools === undefined ? {} : { tools: caps.tools },
    ...caps.reasoning === undefined ? {} : { reasoning: caps.reasoning },
  }
  return Object.keys(patch).length === 0 ? undefined : patch
}

/** Probe Ollama `{root}/api/tags` and bounded `{root}/api/show` for active local models. */
async function probeOllamaModels(
  root: string,
  key: string | undefined,
  knownIds: ReadonlySet<string>,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Map<string, SiblingPatch>> {
  const result = new Map<string, SiblingPatch>()
  const headers = bearerHeaders(key)
  const tagsBody = await fetchBoundedJson(
    `${root}/api/tags`,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
    fetchImpl,
  )
  const tagsObj = asObject(tagsBody)
  if (!Array.isArray(tagsObj?.models)) return result
  const matchedIds: string[] = []
  for (const item of tagsObj.models) {
    const row = asObject(item)
    const name = typeof row?.name === 'string'
      ? row.name
      : typeof row?.model === 'string'
        ? row.model
        : undefined
    if (name !== undefined && knownIds.has(name) && !matchedIds.includes(name)) {
      matchedIds.push(name)
    }
  }
  const targets = matchedIds.slice(0, MAX_OLLAMA_SHOW_MODELS)
  if (targets.length === 0) return result

  let cursor = 0
  const workers = Array.from({ length: Math.min(OLLAMA_SHOW_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const id = targets[cursor++]!
      const showBody = await fetchBoundedJson(
        `${root}/api/show`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ model: id }),
          signal: AbortSignal.timeout(timeoutMs),
        },
        fetchImpl,
      )
      const patch = parseOllamaShow(showBody)
      if (patch !== undefined) result.set(id, patch)
    }
  })
  await Promise.all(workers)
  return result
}

/**
 * Enrich primary listing models in place from read-only sibling endpoints on
 * the same server root. Skips probing altogether when every primary model
 * already disclosed full core metadata. Never adds or removes model IDs, and
 * never overwrites any field already disclosed by the primary listing.
 * @param baseURL - primary provider endpoint base URL.
 * @param models - normalized primary listing models (mutated in place with missing fields).
 * @param options - protocol, credential, fetch seam, and timeout options.
 * @returns the same `models` array after fail-open sibling enrichment.
 */
export async function enrichFromSiblingEndpoints<T extends SiblingEnrichableModel>(
  baseURL: string,
  models: T[],
  options: SiblingProbeOptions = {},
): Promise<T[]> {
  if (models.length === 0 || !models.some(needsSiblingMetadata)) return models
  const root = endpointRootUrl(baseURL)
  if (root === '') return models
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? SIBLING_PROBE_TIMEOUT_MS
  const knownIds = new Set(models.map(model => model.id))

  const probes: Array<Promise<Map<string, SiblingPatch>>> = [
    probeLmStudioModels(root, options.key, knownIds, fetchImpl, timeoutMs),
    probeLiteLlmModelInfo(root, options.key, knownIds, fetchImpl, timeoutMs),
    probeOllamaModels(root, options.key, knownIds, fetchImpl, timeoutMs),
  ]
  if (options.api !== 'google-generative-ai') {
    probes.unshift(probeGeminiModels(root, options.key, knownIds, fetchImpl, timeoutMs))
  }
  if (options.api !== 'anthropic-messages') {
    probes.splice(1, 0, probeAnthropicModels(root, options.key, knownIds, fetchImpl, timeoutMs))
  }

  const settled = await Promise.allSettled(probes)
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue
    for (const model of models) {
      const patch = outcome.value.get(model.id)
      if (patch !== undefined) applyPatchMissing(model, patch)
    }
  }
  return models
}
