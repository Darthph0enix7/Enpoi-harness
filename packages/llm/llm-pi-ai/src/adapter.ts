/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  appendAttemptFailedRecord,
  attributionHeaders,
  contentHasImage,
  FREE_TIER_GATED_CODE,
  FREE_TIER_GATED_EXPLANATION,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  AttemptRecordSink,
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  LlmFailure,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  CAPACITY_BACKOFF_TIERS_MS,
  classifyFailure,
  PoolEngine,
  ROTATING_CLASSES,
} from './pool.ts'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { createModels, getSupportedThinkingLevels } from './models.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/**
 * The non-empty placeholder key pi-ai's OpenAI-compatible APIs require before
 * they construct a client. A keyless attempt passes it and clears the
 * Authorization header the OpenAI SDK would derive from it (`null` is the
 * SDK's documented form for omitting a default header), so the request reaches
 * the wire with no Authorization header at all.
 */
const KEYLESS_REQUEST_KEY = 'unused'

/** Whether deployment headers already carry a non-empty Authorization. */
function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'authorization' && value.length > 0)
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back. A keyless profile also
   * answers `undefined` for a missing reference, and the attempt then sends no
   * Authorization header instead of failing.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * Multi-credential pool engine for routes declaring `pool`. When absent,
   * pooled profiles fail with a configuration diagnostic instead of routing.
   */
  pool?: PoolEngine
  /**
   * Non-throwing credential resolution for pool identities: `undefined` means
   * "this identity is not usable right now" and the pool skips it. Only when
   * every enabled identity lacks its credential does the request fail.
   */
  resolveCredential?: (credentialRef: string) => Promise<string | undefined>
  /** Diagnostic sink for pool decisions (skips, rotations). */
  log?: (message: string) => void
  /**
   * Session store the adapter appends one durable `llm/attempt-failed` record
   * to per pre-commit pool-identity rotation. Resolved per rotation; absent (or
   * a request without a session identity) leaves rotations unrecorded, as
   * before. Identity ids are recorded; credential values never are.
   */
  attemptRecords?: () => AttemptRecordSink | undefined
  /**
   * Pool attempt wall-clock budget in milliseconds; defaults to 30_000.
   * Tests inject a smaller budget to exercise deadline paths.
   */
  poolDeadlineMs?: number
  /** Injectable clock for pool deadline and snapshot calculations; defaults to Date.now. */
  now?: () => number
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      if (profile.piProvider !== undefined) models.setProvider(profile.piProvider)
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    const profile = this.profileOf(snapshot, provider)
    const failure = profile.modelErrors.get(model)
      ?? (profile.piProvider === undefined ? profile.catalogError : undefined)
    if (failure !== undefined) throw new LlmError(failure, 'INVALID_CONFIG')
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      return this.modelInfo(snapshot, provider, model)
    })
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model),
      stream: options => this.streamWithSnapshot(options, snapshot),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: watchdog.signal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      // Routing-affinity routes (opencode Zen Go) require the conversation's
      // session identity on a dedicated header; static deployment headers stay
      // deployment-owned and the Harness attribution still wins collisions.
      const sessionHeader = profile.sessionHeader === undefined || options.sessionId === undefined
        ? {}
        : { [profile.sessionHeader]: String(options.sessionId) }
      const commonHeaders = requestHeaders({ ...sessionHeader, ...profile.headers })
      const commonOptions = {
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        headers: commonHeaders,
      }
      /**
       * One attempt's stream options. A keyless attempt passes the placeholder
       * key pi-ai requires and clears the Authorization header the SDK derives
       * from it, unless deployment headers already carry their own
       * authorization. A keyless route never receives a resolved key — stored,
       * ambient, and env values are all suppressed before this point — so its
       * only possible Authorization header is deployment-owned. Any supplied
       * key on an authenticated route keeps the normal bearer header.
       */
      const attemptOptions = (apiKeyOverride: string | undefined): SimpleStreamOptions => {
        const keyless = profile.keyless && apiKeyOverride === undefined
        const headers: Record<string, string | null> = { ...commonHeaders }
        if (keyless && !hasAuthorizationHeader(commonHeaders)) headers.authorization = null
        return {
          ...profileOptions(profile, reasoning, keyless ? KEYLESS_REQUEST_KEY : apiKeyOverride),
          ...commonOptions,
          ...keyless ? { headers: headers as Record<string, string> } : {},
        }
      }
      const makeAttempt = (apiKeyOverride: string | undefined, signal: AbortSignal): AsyncGenerator<StreamChunk> =>
        toStreamChunks(snapshot.models.streamSimple(model, context, {
          ...attemptOptions(apiKeyOverride),
          signal,
        }), model.contextWindow, signal)[Symbol.asyncIterator]()

      // Pooled route: rotate across identities until one commits. The
      // committal barrier is the first NON-usage chunk — pi-ai delivers
      // failures as terminal events that toStreamChunks renders as
      // `usage` + error `finish`, so a bare "first chunk" peek would commit
      // on the usage chunk of a failed attempt.
      if (profile.pool !== undefined && this.config.pool !== undefined && profile.pool.identities.length > 0) {
        const engine = this.config.pool
        const resolveCredential = this.config.resolveCredential
        if (resolveCredential === undefined) {
          throw new LlmError(
            `llm-pi-ai: provider "${options.provider}" declares a credential pool but this adapter has no credential resolver`,
            'MISSING_CREDENTIAL',
          )
        }
        await engine.hydrate(options.provider)
        const order = engine.orderFor(options.provider, profile.pool.identities, options.model, profile.pool.strategy)
        if (order.length === 0) {
          throw new LlmError(
            `llm-pi-ai: provider "${options.provider}" has no enabled key-pool identity; enable one on the Models`
            + ' page (Keys card) and retry',
            'MISSING_CREDENTIAL',
          )
        }
        const identityById = new Map(profile.pool.identities.map(identity => [identity.id, identity]))
        // Fix maxAttempts counting: pre-resolve credentials to count only resolvable identities.
        const now = this.config.now ?? Date.now
        const resolvedKeys = new Map<string, string>()
        for (const candidate of order) {
          const identity = identityById.get(candidate.id)
          if (identity === undefined) continue
          const key = await resolveCredential(identity.credentialRef)
          if (key !== undefined && key.length > 0) {
            resolvedKeys.set(candidate.id, key)
          } else {
            this.config.log?.(
              `llm-pi-ai: provider "${options.provider}" pool identity "${identity.id}"`
              + ` names ${identity.credentialRef}, which resolves to nothing; skipping it`,
            )
          }
        }
        // A keyless route serves every identity with no credential at all
        // (its key material is resolved only for the logs and is never sent);
        // only an authenticated route requires every attempted identity to
        // resolve.
        const resolvableOrder = order.filter(candidate => resolvedKeys.has(candidate.id) || profile.keyless)
        if (resolvableOrder.length === 0) {
          // Plain credential language, not pool vocabulary: the outcome is a
          // route that needs a key before it can answer, and the user can store
          // one from the Models page. The missing references stay named so the
          // exact entry to fill is not a guess.
          const refs = profile.pool.identities.map(identity => identity.credentialRef).join(', ')
          throw new LlmError(
            `llm-pi-ai: provider "${options.provider}" needs a credential, but none of its key-pool references`
            + ` (${refs}) resolve; store one of them on the Models page (Keys card) or export it, then retry`,
            'MISSING_CREDENTIAL',
          )
        }
        const maxAttempts = Math.min(resolvableOrder.length, 5)
        const deadlineMs = this.config.poolDeadlineMs ?? 30_000
        const deadline = now() + deadlineMs
        let attempts = 0
        let lastFailure = 'no identity was attempted'
        for (const candidate of resolvableOrder) {
          if (attempts >= maxAttempts || now() > deadline) break
          if (upstream.aborted) {
            throw new LlmError('pi-ai request aborted by caller', 'ABORTED')
          }
          const identity = identityById.get(candidate.id)
          if (identity === undefined) continue
          const key = resolvedKeys.get(candidate.id)
          attempts += 1
          // A keyless route never sends a stored, ambient, or env-provided
          // key: even an identity whose credential reference resolves is
          // attempted anonymously, because any Authorization header turns the
          // gateway's anonymous path into 401 INVALID_TOKEN.
          const keylessAttempt = profile.keyless
          // Per-attempt teardown: a rotated-away request must not keep its
          // upstream connection open alongside the next attempt's.
          const attemptController = new AbortController()
          const attemptSignal = AbortSignal.any([watchdog.signal, attemptController.signal])
          const iterator = makeAttempt(keylessAttempt ? undefined : key, attemptSignal)
          const buffered: StreamChunk[] = []
          let committed = false
          let failure: LlmFailure | undefined
          try {
            while (true) {
              const result = await watchdog.next(iterator)
              const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
              if (timeout !== undefined) throw timeout
              if (result.done) break
              const chunk = result.value
              if (!committed) {
                if (chunk.type === 'usage') {
                  buffered.push(chunk)
                  continue
                }
                if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                  failure = chunk.reason.failure
                  break
                }
                committed = true
                for (const held of buffered) yield held
                buffered.length = 0
                engine.recordSuccess(options.provider, identity.id, options.model)
              }
              if (chunk.type === 'finish') {
                if (chunk.reason.kind === 'error') {
                  const midFailureClass = classifyFailure(chunk.reason.failure.message)
                  // A keyless attempt's 401/403 is the route's own answer
                  // (e.g. a free tier that now demands a key), not a
                  // credential failure: there is no key to cool down.
                  if (!(keylessAttempt && midFailureClass === 'AUTH')) {
                    // Mid-stream failure: too late to rotate transparently,
                    // but the state update steers the NEXT request away.
                    engine.recordFailure(
                      options.provider,
                      identity.id,
                      options.model,
                      midFailureClass,
                      chunk.reason.failure.message,
                    )
                  }
                }
              }
              yield chunk
            }
          } finally {
            if (!committed) {
              try {
                await iterator.return(undefined)
              } catch (_abortedSdkTeardown) {
                // Rotation owns teardown via attemptController; return-time abort cannot add an outcome.
              }
            }
          }
          if (committed) return
          const failureClass = classifyFailure(failure?.message ?? '')
          // A keyless attempt has no credential to rotate or cool: a 401/403
          // is the route's own answer (e.g. a free tier that now demands a
          // key), so it ends the request terminally instead of burning pool
          // identities.
          if (keylessAttempt && failureClass === 'AUTH') {
            throw new LlmError(
              `llm-pi-ai: keyless provider "${options.provider}" answered an auth failure (AUTH):`
              + ` ${failure?.message ?? 'unknown failure'}`,
              'AUTH',
            )
          }
          engine.recordFailure(options.provider, identity.id, options.model, failureClass, failure?.message ?? 'unknown failure')
          lastFailure = failure?.message ?? lastFailure
          if (!ROTATING_CLASSES.has(failureClass)) {
            // GATEWAY_OUTAGE / INVALID_REQUEST / POLICY: rotating cannot help —
            // every identity hits the same gateway, payload, or server-side
            // policy. POLICY keeps its own terminal code and carries the
            // free-tier client-gate explanation to the caller.
            throw new LlmError(
              `llm-pi-ai: provider "${options.provider}" request failed without failover (${failureClass}): ${lastFailure}`
              + (failureClass === 'POLICY' ? ` — ${FREE_TIER_GATED_EXPLANATION}` : ''),
              failureClass === 'GATEWAY_OUTAGE' ? 'PROVIDER_MODEL_OUTAGE'
                : failureClass === 'POLICY' ? FREE_TIER_GATED_CODE
                  : 'INVALID_REQUEST',
            )
          }
          // A rotation the pool will actually make: another resolvable identity
          // remains and the attempt budget has not elapsed. The record is
          // durable before the next identity starts, so a caller sees the
          // rotation even when a later attempt answers.
          const nextIdentity = attempts < maxAttempts ? resolvableOrder[attempts] : undefined
          const rotating = nextIdentity !== undefined && now() <= deadline
          if (rotating && options.sessionId !== undefined) {
            appendAttemptFailedRecord(this.config.attemptRecords?.(), options.sessionId, Object.freeze({
              provider: options.provider,
              model: options.model,
              identity: identity.id,
              code: failure?.code ?? 'UNKNOWN',
              message: failure?.message ?? 'the attempt ended without a terminal failure event',
              next: Object.freeze({ identity: nextIdentity.id }),
              ...failure?.status === undefined ? {} : { status: failure.status },
            }))
          }
          attemptController.abort('llm-pi-ai pool rotated to the next identity')
          this.config.log?.(
            `llm-pi-ai: provider "${options.provider}" identity "${identity.id}" failed (${failureClass});`
            + `${rotating ? ' rotating' : ' no attempts left'}`,
          )
          if (failureClass === 'CAPACITY' && attempts < maxAttempts) {
            const peekOrder = engine.orderFor(options.provider, profile.pool.identities, options.model, profile.pool.strategy, true)
            const othersHealthy = peekOrder.some(candidate2 => candidate2.id !== identity.id
              && engine.cooldownRemaining(options.provider, candidate2.id, options.model) === 0)
            if (!othersHealthy) {
              const snap = engine.snapshot(options.provider)
              const state = snap[identity.id]?.[options.model]
              const consecutive = state?.consecutiveFailures ?? 1
              const tierIdx = Math.min(Math.max(0, consecutive - 1), CAPACITY_BACKOFF_TIERS_MS.length - 1)
              const backoffMs = CAPACITY_BACKOFF_TIERS_MS[tierIdx] ?? CAPACITY_BACKOFF_TIERS_MS[0] ?? 5000
              await engine.backoff(backoffMs, upstream)
            }
          }
        }
        // Enriched exhausted error with per-identity reset times, last error,
        // and soonest reset — so the operator can see WHY each key failed
        // (e.g. prio-1 got a 500, not a quota error).
        {
          const snap = engine.snapshot(options.provider)
          const perIdentity = profile.pool.identities.map((ident) => {
            const remaining = engine.cooldownRemaining(options.provider, ident.id, options.model)
            const until = snap[ident.id]?.[options.model]?.cooldownUntil
            const lastError = snap[ident.id]?.[options.model]?.lastError
            const errSuffix = lastError !== undefined ? `, last: ${lastError.slice(0, 120)}` : ''
            if (remaining > 0 && until) {
              return `${ident.id} reset at ${new Date(until).toISOString()} (in ${Math.ceil(remaining / 1000)}s${errSuffix})`
            } else if (remaining > 0) {
              return `${ident.id} cooling ${Math.ceil(remaining / 1000)}s${errSuffix}`
            } else {
              return `${ident.id} ready${errSuffix}`
            }
          }).join(', ')
          let soonestMs: number | undefined
          for (const ident of profile.pool.identities) {
            const rem = engine.cooldownRemaining(options.provider, ident.id, options.model)
            if (rem > 0 && (soonestMs === undefined || rem < soonestMs)) soonestMs = rem
          }
          const sortedByPriority = [...profile.pool.identities]
            .filter(i => i.enabled !== false)
            .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
          const prio1 = sortedByPriority[0]
          const prio1Until = prio1 ? snap[prio1.id]?.[options.model]?.cooldownUntil : undefined
          const prio1Remaining = prio1 ? engine.cooldownRemaining(options.provider, prio1.id, options.model) : 0
          let enriched = `llm-pi-ai: provider "${options.provider}" exhausted its credential pool after ${attempts} attempt(s): ${lastFailure}`
          if (soonestMs !== undefined) {
            enriched += ` (soonest reset in ${Math.ceil(soonestMs / 1000)}s`
            if (prio1) {
              if (prio1Until) {
                enriched += `, prio-1 ${prio1.id} reset at ${new Date(prio1Until).toISOString()}`
              } else if (prio1Remaining > 0) {
                enriched += `, prio-1 ${prio1.id} reset in ${Math.ceil(prio1Remaining / 1000)}s`
              } else {
                enriched += `, prio-1 ${prio1.id} ready`
              }
            }
            enriched += `; ${perIdentity})`
          } else {
            enriched += ` (${perIdentity})`
          }
          throw new LlmError(enriched, 'PROVIDER_POOL_EXHAUSTED')
        }
      }

      const events = snapshot.models.streamSimple(model, context, {
        ...attemptOptions(apiKey),
        signal: watchdog.signal,
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}
