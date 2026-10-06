/**
 * Command Code adapter for the harness LLM seam.
 *
 * Registered with `ctx.llm.registerAdapter()` like any other adapter — the
 * seam has no protocol table, so a bespoke wire protocol is a first-class
 * citizen. Requests go to `POST {baseURL}/alpha/generate`.
 *
 * Two credential postures share the envelope and the SSE parser:
 * - pooled (the shipped route: `pool.identities` on the route): the route is
 *   self-contained. The shared `PoolEngine` orders identities per model, the
 *   adapter injects the CLI headers and the per-identity auth itself, has
 *   `convert.ts` sanitize text at the conversion seam (embedded-base64 scrub,
 *   200k cap; images ride the converter's one forward budget), retries a 413
 *   once on the same identity with older images stripped, and rotates only
 *   before the first content delta commits.
 * - single-key: a route without pool identities resolves its `apiKeyEnv` once
 *   per request. A keyless route is refused unless the baseURL is loopback —
 *   a keypool deployment there injects the vendor auth (and CLI headers)
 *   itself, while an anonymous request to the public vendor cannot pass its
 *   gate, so the adapter fails with the Keys-card action instead of sending
 *   it. A pooled route ignores `keyless` entirely.
 *
 * Capabilities come exclusively from the route's catalog (the keypool's
 * `{baseURL}/catalog.json` when the baseURL is loopback, otherwise the
 * bundled snapshot); user-attached images are
 * resolved from the harness attachment service through the route's
 * request-sized reader (the `store.readImageRequest` pixel/byte target), and
 * tool-result images keep their stored bytes before the converter hoists them
 * into a following user message.
 *
 * @module dsh-enpoi-commandcode-provider/adapter
 */

import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { PoolEngine, PoolFailureClass } from '@deepseek-ai/dsh-llm-pi-ai'
import { parseQuotaHeaders, ROTATING_CLASSES } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CatalogEntry } from './catalog.js'
import { CatalogStore, contextWindowOf, effortsOf, entryFor, isLoopbackBaseURL, modalitiesOf, visionOf } from './catalog.js'
import type { CcEnvelope, CcInputMessage, CcInputPart, CcTool } from './convert.js'
import { buildRequest } from './convert.js'
import { classifyCommandCodeError } from './errors.js'
import { commandCodeHeaders } from './headers.js'
import { stripOlderImagesKeepingNewest } from './sanitize.js'
import { parseCommandCodeStream } from './stream.js'

/** One credential identity inside a route's native pool (mirrors llm-pi-ai's identity record). */
export interface CommandCodePoolIdentity {
  /** Stable identity key (state file, logs, Keys card). */
  id: string
  /** Credential reference resolved per attempt through the plugin's resolver. */
  credentialRef: string
  /** Lower serves first under `priority-sticky`; omission ranks last. */
  priority?: number
  /** Disabled identities are skipped without losing their cooldown state. */
  enabled?: boolean
}

/** Opt-in multi-credential routing for one Command Code route. */
export interface CommandCodePoolConfig {
  /** Selection strategy; defaults to `priority-sticky` (the keypool proxy's behavior). */
  strategy?: 'priority-sticky' | 'balanced'
  /** The route's credential identities (≥ 1, unique ids). */
  identities: CommandCodePoolIdentity[]
}

/** One route this adapter serves, as written by the heavy-provider flow. */
export interface CommandCodeRouteProfile {
  /** Provider route key (`commandcode`). */
  route: string
  displayName: string
  /** Route base URL: the vendor endpoint, or a loopback keypool that fronts it. */
  baseURL: string
  /** Credential reference when the route is BYOK; absent for a keypool route. */
  apiKeyEnv?: string
  /**
   * Keyless routes need a loopback baseURL whose keypool injects the auth
   * (and CLI) headers; a pooled route ignores this flag entirely.
   */
  keyless: boolean
  /**
   * Opt-in native credential pool. Present with at least one identity, the
   * route resolves and rotates keys itself (shared `PoolEngine`, per-identity
   * CLI headers, request sanitizer) and `keyless`/`apiKeyEnv` no longer drive
   * the wire auth; absent, the route keeps its single-key or keypool path.
   */
  pool?: CommandCodePoolConfig
  /** Models the route writer discovered; the catalog supersedes them. */
  models?: readonly { id: string; name?: string }[]
  /** Total-pixel budget for one user-attached request image. */
  userImageMaxPixels: number
  /** Encoded-byte target for one user-attached request image. */
  userImageMaxBytes: number
}

/** Request-size budget for user-attached images on one route. */
export interface CcUserImageBudget {
  /** Total-pixel budget; larger sources are downscaled proportionally. */
  maxPixels: number
  /** Encoded-byte target of one request image. */
  maxBytes: number
}

/** Default total-pixel budget for user-attached request images (2048x2048, mirroring the pi-ai route default). */
export const DEFAULT_USER_IMAGE_MAX_PIXELS = 2048 * 2048
/** Default encoded-byte target for one user-attached request image, before base64 expansion. */
export const DEFAULT_USER_IMAGE_MAX_BYTES = 1024 * 1024

/** Constructor inputs the owning plugin supplies. */
export interface CommandCodeAdapterOptions {
  /** Current route profiles by provider route key. */
  profiles: () => ReadonlyMap<string, CommandCodeRouteProfile>
  /** Catalog store for one route, created and started by the plugin. */
  catalogFor: (profile: CommandCodeRouteProfile) => CatalogStore
  /** Resolve the route credential; called once per stream call. */
  resolveApiKey: (profile: CommandCodeRouteProfile) => Promise<string | undefined>
  /** Shared identity-pool engine; omission keeps every route on its single-key/keyless path. */
  pool?: PoolEngine
  /** Resolve one pool identity's credential reference; required by the pooled path. */
  resolveCredential?: (reference: string) => Promise<string | undefined>
  /** Pooled-attempt diagnostic sink (rotation decisions); defaults to silence. */
  log?: (message: string) => void
  /** Pooled-path identity-attempt cap; defaults to 5. */
  poolMaxAttempts?: number
  /** Pooled-path attempt deadline in milliseconds; defaults to 30 s. */
  poolDeadlineMs?: number
  /** Read one durable image attachment's stored bytes for a tool-result inline data URI. */
  readImage?: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** Read one durable user-attached image at the route's request size for an inline data URI. */
  readUserImage?: (
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch
  /** Injectable clock for the envelope's date. */
  now?: () => Date
}

/** Request timeout for one `/alpha/generate` call. */
const REQUEST_TIMEOUT_MS = 300_000

/** Pooled-path identity-attempt cap and whole-pass deadline (mirrors the pi-ai adapter). */
const DEFAULT_POOL_MAX_ATTEMPTS = 5
const DEFAULT_POOL_DEADLINE_MS = 30_000

/**
 * Translate one Command Code failure into the shared pool's class vocabulary.
 * `src/errors.ts` owns the Command Code-specific classification (status and
 * body wording); this maps its codes onto the classes that decide rotation
 * and cooldown, so the pool treats commandcode like every other route.
 * @param code - the `classifyCommandCodeError` code, or an `LlmError` code from a stream failure.
 * @param status - HTTP status when one exists; omitted for in-band stream errors.
 * @returns the pool failure class driving rotation and cooldown.
 */
export function poolFailureClassOf(code: string, status?: number): PoolFailureClass {
  if (code === CONTEXT_WINDOW_EXCEEDED_CODE || code === 'INVALID_REQUEST') return 'INVALID_REQUEST'
  if (code === QUOTA_EXCEEDED_CODE || code === 'RATE_LIMIT') return 'QUOTA'
  if (code === 'AUTH') return 'AUTH'
  // The vendor's client gate ("Proxy use detected") is a property of the route,
  // not of one credential: no key rotation or cooldown can satisfy it.
  if (code === 'PROXY_USE_DETECTED') return 'POLICY'
  if (code === 'SERVER') return status === 503 || status === 529 ? 'CAPACITY' : 'UPSTREAM'
  return 'UPSTREAM'
}

/** The harness tool declarations mapped to the Command Code wire shape. */
export function toCcTools(tools: readonly ToolSchema[] | undefined): CcTool[] {
  return (tools ?? []).map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

/** Deterministic request target for one source under the route's user-image budget. */
function userImageTarget(ref: ImageAttachmentRef, budget: CcUserImageBudget): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, budget.maxPixels), maxBytes: budget.maxBytes }
}

/**
 * Convert one harness request into wire messages, resolving image blocks
 * through the attachment service. User-attached images use the route's
 * request-sized reader when supplied; tool-result images keep their stored
 * bytes. Every unresolved image degrades to a text note; raw bytes are never
 * inlined as text.
 */
export async function toCcMessages(
  options: GenerateOptions,
  readImage: CommandCodeAdapterOptions['readImage'],
  readUserImage?: CommandCodeAdapterOptions['readUserImage'],
  userImageBudget?: CcUserImageBudget,
): Promise<CcInputMessage[]> {
  const messages: CcInputMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const parts: CcInputPart[] = []
      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            parts.push({ type: 'text', text: block.text })
            break
          case 'image': {
            if (block.offloaded === true) {
              parts.push({ type: 'text', text: '[image omitted to fit request image limits]' })
              break
            }
            const resolved = readUserImage === undefined || userImageBudget === undefined
              ? await readImage?.(block.attachment, options.signal)
              : await readUserImage(block.attachment, userImageTarget(block.attachment, userImageBudget), options.signal)
            if (resolved === undefined) {
              parts.push({
                type: 'text',
                text: `[image omitted: ${block.attachment.mediaType} — the attachment service could not read it]`,
              })
              break
            }
            parts.push({
              type: 'file',
              mediaType: resolved.mediaType,
              data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
            })
            break
          }
          case 'file':
            parts.push({ type: 'text', text: `[file attachment: ${block.attachment.name ?? 'unnamed'}]` })
            break
          default:
            break
        }
      }
      messages.push({ role: 'user', content: parts })
      continue
    }
    if (message.role === 'assistant') {
      const parts: CcInputPart[] = []
      for (const block of message.content) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') parts.push({ type: 'reasoning', text: block.text })
        else if (block.type === 'tool-call') {
          parts.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, arguments: block.arguments })
        }
      }
      if (parts.length > 0) messages.push({ role: 'assistant', content: parts })
      continue
    }
    // tool
    const parts: CcInputPart[] = []
    for (const block of message.content) {
      if (block.type === 'text') parts.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        if (block.offloaded === true) {
          parts.push({ type: 'text', text: '[image omitted to fit request image limits]' })
          continue
        }
        const resolved = readImage === undefined ? undefined : await readImage(block.attachment, options.signal)
        if (resolved === undefined) {
          parts.push({
            type: 'text',
            text: `[image omitted: ${block.attachment.mediaType} — the attachment service could not read it]`,
          })
          continue
        }
        // The converter hoists this out of the tool result into a following
        // user message; here it only has to be recognizable as binary.
        parts.push({
          type: 'file',
          mediaType: resolved.mediaType,
          data: `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`,
        })
      }
    }
    messages.push({ role: 'tool', content: parts, toolCallId: message.toolCallId, isError: message.isError === true })
  }
  return messages
}

/**
 * Command Code adapter. Each operation reads the current route profiles, so a
 * settings change reaches the next request without a restart.
 */
export class CommandCodeAdapter extends LlmAdapter {
  constructor(private readonly options: CommandCodeAdapterOptions) {
    super()
  }

  private profileOf(provider: string): CommandCodeRouteProfile {
    const profile = this.options.profiles().get(provider)
    if (profile === undefined) throw new LlmError(`Command Code adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    return profile
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.options.profiles().get(provider)?.displayName ?? provider }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profileOf(provider)
    const entries = await this.options.catalogFor(profile).entries()
    if (entries.length > 0) {
      return entries.map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        ...modalitiesOf(entry) === undefined ? {} : { inputModalities: modalitiesOf(entry) },
      }))
    }
    return (profile.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const profile = this.profileOf(provider)
    const entries = await this.options.catalogFor(profile).entries()
    const entry: CatalogEntry | undefined = entryFor(entries, model)
    const efforts = effortsOf(entry)
    const context = contextWindowOf(entry)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...modalitiesOf(entry) === undefined ? {} : { inputModalities: modalitiesOf(entry) },
      ...context === undefined ? {} : { context: { contextWindow: context } },
      ...efforts.length === 0
        ? {}
        : {
            reasoning: {
              efforts: efforts.map(effort => ({ id: effort as never, name: effort })),
            },
          },
    }
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const profile = this.profileOf(options.provider)
    const catalog = this.options.catalogFor(profile)
    const entries = await catalog.entries()
    const entry = entryFor(entries, options.model)

    const effort = options.reasoningEffort
    if (effort !== undefined) {
      const supported = effortsOf(entry)
      if (supported.length > 0 && !supported.includes(effort)) {
        throw new LlmError(
          `Command Code model "${options.model}" does not support reasoning effort "${effort}"`
          + ` (catalog offers: ${supported.join(', ')})`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    }

    const pooled = profile.pool !== undefined && profile.pool.identities.length > 0
    // A keyless route only makes sense in front of a keypool on this machine,
    // which injects the vendor auth (and CLI headers) itself. Pointed at a
    // public endpoint it could only send the anonymous request the vendor
    // rejects, so refuse it with the actionable credential step instead of a
    // broken round-trip. A route with its own pool never reaches this branch.
    if (!pooled && profile.keyless && !isLoopbackBaseURL(profile.baseURL)) {
      throw new LlmError(
        `Command Code route "${options.provider}" is keyless but points at the non-loopback endpoint ${profile.baseURL};`
        + ' add a key on the Models page (Keys card) or declare pool.identities, then retry',
        'MISSING_CREDENTIAL',
      )
    }
    const key = pooled || profile.keyless ? undefined : await this.options.resolveApiKey(profile)
    if (!pooled && !profile.keyless && key === undefined) {
      throw new LlmError(
        `Command Code route "${options.provider}" resolves ${profile.apiKeyEnv ?? 'no credential'}, which is not set;`
        + ' add a key on the Models page (Keys card) or export it, then retry',
        'MISSING_CREDENTIAL',
      )
    }

    const messages = await toCcMessages(options, this.options.readImage, this.options.readUserImage, {
      maxPixels: profile.userImageMaxPixels,
      maxBytes: profile.userImageMaxBytes,
    })
    const envelope = buildRequest({
      model: options.model,
      messages,
      // A direct route (pooled or single-key) talks to the vendor, so the
      // conversion seam sanitizes its text (scrub + 200k cap) once; a legacy
      // loopback keypool route leaves the body to the proxy downstream.
      sanitizeText: pooled || !isLoopbackBaseURL(profile.baseURL),
      tools: toCcTools(options.tools),
      ...options.system === undefined ? {} : { system: options.system },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...effort === undefined ? {} : { reasoningEffort: effort },
      visionEnabled: visionOf(entry),
      ...this.options.now === undefined ? {} : { now: this.options.now() },
    })

    if (pooled) {
      yield * this.#streamPooled(options, profile, envelope)
      return
    }

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response: Response
    try {
      response = await fetchImpl(`${profile.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
          // A direct vendor request must carry the CLI identity headers (the
          // vendor gate rejects generic clients); a legacy loopback keypool
          // route leaves them to the proxy and carries only the bearer token.
          ...isLoopbackBaseURL(profile.baseURL)
            ? (key === undefined ? {} : { authorization: `Bearer ${key}` })
            : commandCodeHeaders(key),
        },
        body: JSON.stringify(envelope),
        signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(
        `Command Code transport failure: ${error instanceof Error ? error.message : String(error)}`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const failure = classifyCommandCodeError(response.status, body)
      throw new LlmError(`Command Code API error (${String(response.status)}): ${failure.message}`, failure.code)
    }
    if (response.body === null) {
      throw new LlmError('Command Code API returned no response body', 'SERVER')
    }
    yield * parseCommandCodeStream(response.body)
  }

  /**
   * The opt-in pooled path: resolve one credential per identity, order them
   * through the shared pool engine, inject the Command Code CLI headers and
   * that identity's auth (the converted envelope is already text-sanitized and
   * image-budgeted), and rotate across identities until one commits. A 413 is
   * retried once on the same identity with older images stripped; after the
   * first content delta the request is committed and failures surface
   * unchanged.
   */
  async *#streamPooled(
    options: GenerateOptions,
    profile: CommandCodeRouteProfile,
    envelope: CcEnvelope,
  ): AsyncGenerator<StreamChunk> {
    const poolConfig = profile.pool
    const engine = this.options.pool
    if (poolConfig === undefined || poolConfig.identities.length === 0) {
      throw new LlmError(`Command Code route "${options.provider}" declares no pool identities`, 'MISSING_CREDENTIAL')
    }
    if (engine === undefined) {
      throw new LlmError(
        `Command Code route "${options.provider}" declares a credential pool but this adapter has no pool engine`,
        'MISSING_CREDENTIAL',
      )
    }
    const resolveCredential = this.options.resolveCredential
    if (resolveCredential === undefined) {
      throw new LlmError(
        `Command Code route "${options.provider}" declares a credential pool but this adapter has no credential resolver`,
        'MISSING_CREDENTIAL',
      )
    }

    await engine.hydrate(options.provider)
    const order = engine.orderFor(options.provider, poolConfig.identities, options.model, poolConfig.strategy)
    if (order.length === 0) {
      throw new LlmError(
        `Command Code route "${options.provider}" has no enabled key-pool identity; enable one on the Models`
        + ' page (Keys card) and retry',
        'MISSING_CREDENTIAL',
      )
    }
    const identityById = new Map(poolConfig.identities.map(identity => [identity.id, identity]))
    // Resolve every ordered identity once, before any attempt, so the attempt
    // budget counts only identities that can actually authenticate.
    const resolvedKeys = new Map<string, string>()
    for (const candidate of order) {
      const identity = identityById.get(candidate.id)
      if (identity === undefined) continue
      const credential = await resolveCredential(identity.credentialRef)
      if (credential !== undefined && credential.length > 0) {
        resolvedKeys.set(candidate.id, credential)
      } else {
        this.options.log?.(
          `commandcode-provider: pool identity "${identity.id}" names ${identity.credentialRef},`
          + ' which resolves to nothing; skipping it',
        )
      }
    }
    // `keyless` describes the keypool posture, where the proxy supplies auth;
    // a route that declares its own pool is authenticated by definition, so a
    // keyless flag must never turn its attempts anonymous. Only identities
    // whose credential resolves are attempted.
    const resolvableOrder = order.filter(candidate => resolvedKeys.has(candidate.id))
    if (resolvableOrder.length === 0) {
      const refs = poolConfig.identities.map(identity => identity.credentialRef).join(', ')
      throw new LlmError(
        `Command Code route "${options.provider}" needs a credential, but none of its key-pool references`
        + ` (${refs}) resolve; store one on the Models page (Keys card) or export it, then retry`,
        'MISSING_CREDENTIAL',
      )
    }

    // The converted envelope is the request's single image budget (the
    // converter's forward pass); only the 413 retry below rewrites it, and it
    // never re-budgets images.
    let body = JSON.stringify(envelope)
    let strippedOlderImages = false

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch
    const maxAttempts = Math.min(resolvableOrder.length, this.options.poolMaxAttempts ?? DEFAULT_POOL_MAX_ATTEMPTS)
    const deadline = Date.now() + (this.options.poolDeadlineMs ?? DEFAULT_POOL_DEADLINE_MS)
    let attempts = 0
    let lastFailure = 'no identity was attempted'

    for (const candidate of resolvableOrder) {
      if (attempts >= maxAttempts || Date.now() > deadline) break
      if (options.signal?.aborted === true) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED')
      }
      const identity = identityById.get(candidate.id)
      if (identity === undefined) continue
      attempts += 1
      const apiKey = resolvedKeys.get(identity.id)
      // Per-attempt teardown: a rotated-away request must not keep its upstream
      // connection open beside the next attempt's.
      const attemptController = new AbortController()
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = options.signal === undefined
        ? AbortSignal.any([attemptController.signal, timeout])
        : AbortSignal.any([options.signal, attemptController.signal, timeout])
      const send = (): Promise<Response> => fetchImpl(`${profile.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          // Precedence contract: attribution carries only `user-agent`
          // (DeepSeek-Harness/...), the vendor gate serves `user-agent: cli`.
          // The CLI set is spread last so it always wins, including the
          // user-agent override; reversing the spreads would silently trip
          // the gate.
          ...attributionHeaders(),
          ...commandCodeHeaders(apiKey),
        },
        body,
        signal,
      })

      let response: Response | undefined
      let transportError: unknown
      try {
        response = await send()
      } catch (error) {
        transportError = error
      }
      // The one 413 retry: the request is too large for the upstream, not the
      // key's fault. Strip every image but the newest and retry the SAME
      // identity once before surfacing the gateway's explanation.
      if (response !== undefined && response.status === 413 && !strippedOlderImages) {
        const removed = stripOlderImagesKeepingNewest(envelope)
        if (removed > 0) {
          strippedOlderImages = true
          body = JSON.stringify(envelope)
          this.options.log?.(
            `commandcode-provider: identity "${identity.id}" answered 413; stripped ${removed} older image(s)`
            + ' and retrying the same identity',
          )
          try {
            response = await send()
          } catch (error) {
            // The retry died on the wire; surface that transport failure, not
            // the stale 413 response the retry replaced.
            response = undefined
            transportError = error
          }
        }
      }

      if (response === undefined) {
        if (options.signal?.aborted) {
          throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: transportError })
        }
        const message = `Command Code transport failure: ${transportError instanceof Error ? transportError.message : String(transportError)}`
        engine.recordFailure(options.provider, identity.id, options.model, 'UPSTREAM', message)
        lastFailure = message
        attemptController.abort('commandcode pool rotated to the next identity')
        this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (UPSTREAM); rotating`)
        continue
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const failure = classifyCommandCodeError(response.status, errorBody)
        // A 413 that survived the strip retry (or had no image to strip) is
        // request-level: every identity rejects the same bytes, so the pass
        // stops without cooling a healthy key.
        if (response.status === 413 || failure.code === CONTEXT_WINDOW_EXCEEDED_CODE || failure.code === 'INVALID_REQUEST') {
          throw new LlmError(`Command Code API error (${String(response.status)}): ${failure.message}`, failure.code)
        }
        const failureClass = poolFailureClassOf(failure.code, response.status)
        engine.recordFailure(options.provider, identity.id, options.model, failureClass, failure.message, response.status)
        lastFailure = failure.message
        if (!ROTATING_CLASSES.has(failureClass)) {
          throw new LlmError(
            `Command Code route "${options.provider}" request failed without failover (${failureClass}): ${failure.message}`,
            failure.code,
          )
        }
        attemptController.abort('commandcode pool rotated to the next identity')
        this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (${failureClass}); rotating`)
        continue
      }

      const quota = parseQuotaHeaders(response.headers)
      if (quota !== undefined) engine.recordQuota(options.provider, identity.id, options.model, quota)
      if (response.body === null) {
        engine.recordFailure(options.provider, identity.id, options.model, 'UPSTREAM', 'the response carried no body')
        lastFailure = 'the response carried no body'
        attemptController.abort('commandcode pool rotated to the next identity')
        continue
      }

      // Commit barrier: buffer until the first content chunk. Before it the
      // caller has seen nothing, so a failure can rotate; once it is yielded
      // the request is committed and an error propagates unchanged.
      const iterator = parseCommandCodeStream(response.body)[Symbol.asyncIterator]()
      const buffered: StreamChunk[] = []
      let committed = false
      let midFailure: { code: string; message: string; status?: number } | undefined
      try {
        for (;;) {
          const result = await iterator.next()
          if (result.done === true) break
          const chunk = result.value
          if (!committed) {
            if (chunk.type === 'usage') {
              buffered.push(chunk)
              continue
            }
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
              midFailure = {
                code: chunk.reason.failure.code,
                message: chunk.reason.failure.message,
                ...chunk.reason.failure.status === undefined ? {} : { status: chunk.reason.failure.status },
              }
              break
            }
            committed = true
            engine.recordSuccess(options.provider, identity.id, options.model)
            for (const held of buffered) yield held
            buffered.length = 0
          }
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            engine.recordFailure(
              options.provider,
              identity.id,
              options.model,
              poolFailureClassOf(chunk.reason.failure.code, chunk.reason.failure.status),
              chunk.reason.failure.message,
            )
            yield chunk
            break
          }
          yield chunk
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
        }
        if (committed) {
          // Never retry after commit; the state update only steers the next request.
          if (error instanceof LlmError) {
            engine.recordFailure(
              options.provider,
              identity.id,
              options.model,
              poolFailureClassOf(error.code),
              error.message,
            )
          }
          throw error
        }
        midFailure = error instanceof LlmError
          ? { code: error.code, message: error.message }
          : { code: 'STREAM_CLOSED', message: error instanceof Error ? error.message : String(error) }
      } finally {
        // Always close the attempt's SSE reader: a rotated-away try and a
        // consumer that stopped after commit both release the connection here.
        try {
          await iterator.return(undefined)
        } catch (_abortedStreamTeardown) {
          // The attempt controller owns teardown; return-time abort cannot add an outcome.
        }
      }
      if (committed) return
      if (midFailure === undefined) {
        midFailure = { code: 'STREAM_CLOSED', message: 'the attempt ended without content' }
      }
      const failureClass = poolFailureClassOf(midFailure.code, midFailure.status)
      engine.recordFailure(
        options.provider,
        identity.id,
        options.model,
        failureClass,
        midFailure.message,
        midFailure.status,
      )
      lastFailure = midFailure.message
      if (!ROTATING_CLASSES.has(failureClass)) {
        throw new LlmError(
          `Command Code route "${options.provider}" request failed without failover (${failureClass}): ${midFailure.message}`,
          midFailure.code,
        )
      }
      attemptController.abort('commandcode pool rotated to the next identity')
      this.options.log?.(`commandcode-provider: identity "${identity.id}" failed (${failureClass}); rotating`)
    }

    throw new LlmError(
      `Command Code credential pool exhausted after ${attempts} attempt(s): ${lastFailure}`,
      'PROVIDER_POOL_EXHAUSTED',
    )
  }
}
