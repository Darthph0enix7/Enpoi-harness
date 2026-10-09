/**
 * Answering "which models can this provider serve?" for the configuration
 * surface's "fetch available models" action.
 *
 * The endpoint is asked first whenever the draft names one. For a route the
 * installed pi-ai catalog ships, the live answer is enriched from that catalog
 * — capacities and input types a listing endpoint would not disclose — and the
 * catalog stands in alone when the endpoint cannot be reached or read. A
 * catalog route whose draft names no endpoint is answered from the catalog
 * with no network call, because pi-ai's registry is then the only endpoint it
 * has.
 *
 * Neither path is a catalog refresh. Nothing here is stored: the request
 * carries a draft the user is still editing, and the reply is candidate
 * metadata the surface offers for adoption. `cordis.patch.yml` remains the only
 * thing that decides what a route serves.
 *
 * OpenAI-compatible and Anthropic Messages protocols are interrogated through
 * their native model-listing endpoints. The parser accepts the standard
 * `data` array and the enriched `models` map some compatible gateways expose.
 * Every other protocol reports that it cannot be interrogated so the surface
 * falls back to hand-entry rather than guessing its response fields.
 *
 * @module dsh-llm-pi-ai/discovery
 */

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryOperation } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { Api, Model } from '@earendil-works/pi-ai'
import { catalogModels } from './catalog.ts'

/**
 * Protocols whose model listing this module can read. OpenAI protocols use
 * bearer auth at `GET {baseURL}/models`; Anthropic Messages uses `x-api-key`
 * and `anthropic-version` at its native `GET /v1/models`. Azure is absent
 * despite its OpenAI lineage — it authenticates with an `api-key` header and
 * requires an `api-version` query — and Codex authenticates through OAuth;
 * guessing at either would report an authentication failure as a provider
 * with no models. pi-ai's remaining protocols are absent for the same reason.
 */
const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/** Largest model-list page accepted by Anthropic's public endpoint; discovery reads one page and does not follow `has_more`. */
const ANTHROPIC_MODEL_LIMIT = 1000

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims — the same two-stage shape `dsh-web-fetch`
 * uses for its own caller-supplied URLs, except that a truncated model listing
 * is not parseable, so overflow rejects instead of truncating. Deployments
 * override it through the plugin's `modelDiscoveryMaxResponseBytes`.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * Wall-clock budget for one listing interrogation. A configuration-time probe
 * must not outlive the form that started it: a black-holed endpoint would
 * otherwise leave the add-provider surface waiting forever. The timeout is
 * reported through the same failure path as an unreachable endpoint, so the
 * surface falls back to hand-entry exactly as it does for a refused listing.
 * Deployments override it through the plugin's `modelDiscoveryTimeoutMs`.
 */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000

/** Overridable bounds of one listing interrogation; omission keeps the shipped default. */
export interface ModelDiscoveryLimits {
  /** Wall-clock budget for one listing interrogation (default {@link DEFAULT_DISCOVERY_TIMEOUT_MS}). */
  readonly timeoutMs?: number
  /** Largest model-listing reply accepted (default {@link DEFAULT_MAX_RESPONSE_BYTES}). */
  readonly maxResponseBytes?: number
}

/** Capacity fields nested by enriched model-directory replies. */
interface ListingLimit {
  context?: unknown
  output?: unknown
}

/** Per-route capacities OpenRouter nests under each entry. */
interface ListingTopProvider {
  max_completion_tokens?: unknown
}

/** One entry of a supported `GET /models` reply. */
interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  displayName?: unknown
  contextWindow?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  maxTokens?: unknown
  limit?: ListingLimit | null
  top_provider?: ListingTopProvider | null
}

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Join the endpoint base with the protocol's listing path. The base is
 * treated as a prefix rather than a URL to resolve against, so a deployment
 * path such as `https://gateway.example/openai/v1` keeps its segments instead
 * of losing them to `URL` resolution. OpenAI protocols list at
 * `{baseURL}/models`. Anthropic lists at `{root}/v1/models`, where the root is
 * the base without trailing slashes and without one trailing `/v1` segment:
 * gateway documentation publishes both spellings of the same root. Only this
 * listing URL normalizes that segment; model requests receive the configured
 * `baseURL` unchanged.
 */
function listingUrl(baseURL: string, api: string): string {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string, maxResponseBytes: number): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${maxResponseBytes} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxResponseBytes) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxResponseBytes) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** One parsed listing row: {@link readListing} always resolves a display name. */
type LiveRow = LlmDiscoveredModel & { name: string }

/**
 * Read one supported model-listing reply. The standard `data` array takes
 * precedence when both supported formats are present. An enriched `models`
 * map uses each property key as the endpoint-facing id; its nested `id` is
 * only a fallback for an empty key because gateways may put a canonical model
 * identity there instead of the alias they accept on requests. Only
 * object-valued map entries are models; primitive properties are ignored
 * because they may be directory metadata rather than model records.
 *
 * Entries without a usable id are skipped rather than failing the whole
 * interrogation: a single malformed row should not deny the user the rest of
 * a working endpoint's catalog. Missing names fall back to the adopted id so
 * the Web form receives a complete human-readable row.
 */
function readListing(body: unknown): LiveRow[] {
  const listing = body as { data?: unknown; models?: unknown } | null
  const data = listing?.data
  let listed: { readonly key?: string; readonly raw: unknown }[]
  if (Array.isArray(data)) {
    const rows = data as readonly unknown[]
    listed = rows.map(raw => ({ raw }))
  } else {
    const models = listing?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new LlmError(
        'the endpoint\'s model listing has neither a "data" array nor a "models" object; '
        + 'enter this provider\'s models by hand',
        'DISCOVERY_FAILED',
      )
    }
    listed = Object.entries(models as Record<string, unknown>)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models: LiveRow[] = []
  for (const { key, raw } of listed) {
    const entry = raw as ListingEntry | null
    const id = label(key, entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name, entry?.displayName) ?? id
    const contextWindow = capacity(
      entry?.contextWindow,
      entry?.context_window,
      entry?.context_length,
      entry?.max_input_tokens,
      entry?.limit?.context,
    )
    const maxTokens = capacity(
      entry?.maxOutputTokens,
      entry?.max_output_tokens,
      entry?.maxTokens,
      entry?.max_tokens,
      entry?.limit?.output,
      entry?.top_provider?.max_completion_tokens,
    )
    models.push({
      id,
      name,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key typed into the form or read from storage.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/** Host-owned profile inputs that a configuration draft deliberately omits. */
export interface StoredModelDiscoveryProfile {
  /** Deployment headers configured on the named route. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** Resolve the named route's credential only when the draft carries none. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** The installed catalog's own answer for a route: every id with its metadata. */
function catalogAnswer(installed: ReadonlyMap<string, Model<Api>>): LlmDiscoveredModel[] {
  return [...installed.values()].map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: [...model.input],
  }))
}

/**
 * Enrich one live row with what the installed catalog knows for its id. A
 * capacity the listing disclosed wins — the endpoint is the fresher authority
 * for a route whose list moves — while a name that merely echoes the id, plus
 * the undisclosed capacities and input types, come from the catalog. A row the
 * catalog does not describe is returned untouched.
 */
function enrich(model: LiveRow, installed: ReadonlyMap<string, Model<Api>>): LlmDiscoveredModel {
  const base = installed.get(model.id)
  if (base === undefined) return model
  return {
    ...model,
    name: model.name === model.id ? base.name : model.name,
    contextWindow: model.contextWindow ?? base.contextWindow,
    maxTokens: model.maxTokens ?? base.maxTokens,
    inputModalities: [...base.input],
  }
}

/**
 * The one wire protocol a catalog route's installed models agree on, when they
 * do. A draft naming no protocol asks a catalog route as its models' protocol
 * instead of guessing OpenAI Chat Completions; a route whose installed models
 * disagree has no such answer and falls through to the guess.
 */
function catalogApi(installed: ReadonlyMap<string, Model<Api>>): string | undefined {
  const apis = new Set<string>()
  for (const model of installed.values()) apis.add(model.api)
  return apis.size === 1 ? [...apis][0] : undefined
}

/**
 * Interrogate one draft provider endpoint for the models it advertises.
 *
 * The draft's endpoint is authoritative whenever it names one. A route the
 * installed catalog ships is asked over the wire first, with the catalog
 * enriching the live rows and standing in alone when that endpoint cannot be
 * reached or read — so a fast-moving gateway's newest ids arrive without
 * losing the catalog metadata the endpoint does not disclose. A catalog route
 * the draft gives no endpoint is answered from the catalog with no network
 * call. Caller cancellation is always reported, never absorbed by the
 * fallback.
 * @param request - the endpoint, protocol, and one-shot credential to use.
 * @param storedProfile - Host-owned headers and lazy credential resolution for
 *   the named route. It is read only on the path that reaches the network; the
 *   credential is resolved only when the draft carries none.
 * @param limits - overridable interrogation bounds; omission keeps the shipped defaults.
 * @returns the advertised models in endpoint order, catalog-enriched.
 * @throws LlmError when the draft names no endpoint and no catalog describes
 *   the route, the protocol has no readable listing, the endpoint refuses or
 *   fails the request with no catalog to fall back on, or the reply is not a
 *   model listing.
 */
export async function discoverModels(
  request: LlmModelDiscoveryOperation,
  storedProfile?: () => StoredModelDiscoveryProfile | undefined,
  limits: ModelDiscoveryLimits = {},
): Promise<readonly LlmDiscoveredModel[]> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS
  const maxResponseBytes = limits.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const installed = request.provider === undefined ? new Map<string, Model<Api>>() : catalogModels(request.provider)
  const endpoint = request.baseURL !== undefined && request.baseURL.length > 0 ? request.baseURL : undefined
  if (endpoint === undefined) {
    if (installed.size > 0) return catalogAnswer(installed)
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  try {
    return await probeListing(endpoint, request, storedProfile, installed, { timeoutMs, maxResponseBytes })
  } catch (error: unknown) {
    // Cancellation is the caller's own decision and must surface as such; a
    // deadline expiry is this probe's own failure and keeps the catalog path.
    if (request.signal?.aborted === true) throw error
    if (installed.size > 0) return catalogAnswer(installed)
    throw error
  }
}

/**
 * Ask one endpoint for its model listing and enrich the reply from the
 * installed catalog. The credential and headers are resolved here, after the
 * caller has committed to the network path, so a catalog-route fallback can
 * never need a credential the draft did not have to supply.
 * @param endpoint - the absolute endpoint base the draft named.
 * @param request - the protocol, one-shot credential, and cancellation.
 * @param storedProfile - lazy Host-owned headers and credential resolution.
 * @param installed - the route's installed catalog entries, empty when pi-ai
 *   ships none.
 * @param limits - the interrogation bounds this probe runs under.
 * @returns the advertised models in endpoint order, catalog-enriched.
 */
async function probeListing(
  endpoint: string,
  request: LlmModelDiscoveryOperation,
  storedProfile: (() => StoredModelDiscoveryProfile | undefined) | undefined,
  installed: ReadonlyMap<string, Model<Api>>,
  limits: Required<ModelDiscoveryLimits>,
): Promise<readonly LlmDiscoveredModel[]> {
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. A catalog route with one installed
  // protocol asks in that protocol instead. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = request.api ?? catalogApi(installed) ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(endpoint, api)
  // A key typed into the form wins: it may replace the stored key that is
  // failing. The stored profile is asked past the catalog and protocol checks,
  // and its credential resolver remains lazy so a typed key cannot fail over a
  // stored credential it supersedes. A route may still authenticate through a
  // deployment-owned Authorization header when neither key exists.
  const stored = storedProfile?.()
  const supplied = request.apiKey ?? await stored?.resolveApiKey()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  const headers = new Headers(stored?.headers === undefined ? undefined : Object.entries(stored.headers))
  headers.set('accept', 'application/json')
  if (api === 'anthropic-messages') {
    headers.set('anthropic-version', ANTHROPIC_VERSION)
    if (apiKey !== undefined) headers.set('x-api-key', apiKey)
  } else if (apiKey !== undefined) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
  // The endpoint probe races the caller's cancellation against a deadline of
  // its own; both abort the same network phase, and each gets its own report.
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort() }, limits.timeoutMs)
  timer.unref()
  const signal = request.signal === undefined
    ? deadline.signal
    : AbortSignal.any([request.signal, deadline.signal])
  let text: string
  try {
    const response = await fetch(url, { method: 'GET', headers, signal })
    if (!response.ok) {
      throw new LlmError(
        `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
        'DISCOVERY_FAILED',
      )
    }
    text = await readBounded(response, url, limits.maxResponseBytes)
  } catch (error: unknown) {
    // Cancellation during the transfer rejects with the abort reason, which may
    // be any value; the caller and the deadline get the same coded failure they
    // would have for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    if (deadline.signal.aborted) {
      throw new LlmError(
        `${url} did not answer within ${String(limits.timeoutMs / 1000)} seconds;`
        + " check the endpoint URL, or enter this provider's models by hand",
        'DISCOVERY_FAILED',
        { cause: error },
      )
    }
    // A refusal the probe itself decided (a non-ok status, an oversized reply)
    // keeps its own message; anything else is a network reach failure.
    if (error instanceof LlmError) throw error
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  } finally {
    clearTimeout(timer)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body).map(model => enrich(model, installed))
}
