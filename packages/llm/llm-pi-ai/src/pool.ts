/**
 * Provider identity pool engine.
 *
 * One provider route may carry several credentials (API keys today; OAuth
 * accounts later). The engine owns the routing state that makes multi-
 * credential routes behave like one endpoint: per-identity × per-model
 * cooldowns driven by a failure classifier, priority-sticky ordering with
 * optimistic probing when everything looks exhausted, and durable state so
 * cooldowns survive restarts.
 *
 * Design debts consciously taken (P1):
 * - Identity kinds: API keys referenced through the credentials service only.
 * - Cooldown durations are fixed constants (documented below) rather than
 *   per-route configuration; QUOTA always defers to a parsed upstream reset
 *   hint when the error body carries one.
 *
 * @module dsh-llm-pi-ai/pool
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isContextWindowExceededError, isEntitlementGatedError, isFreeTierGatedError } from '@deepseek-ai/dsh-llm'
import type { LlmPoolIdentityStatus } from '@deepseek-ai/dsh-llm'
import type { PiAiPoolIdentity, PoolStrategy } from './config.ts'

/** Why one attempt failed, and what the pool should do about it. */
export type PoolFailureClass =
  | 'AUTH'
  | 'QUOTA'
  | 'CAPACITY'
  | 'ENTITLEMENT'
  | 'GATEWAY_OUTAGE'
  | 'INVALID_REQUEST'
  | 'POLICY'
  | 'UPSTREAM'

/**
 * Failure classes that justify moving to the next identity. ENTITLEMENT
 * rotates: the gate is identity-specific (sibling identities have served the
 * same model while one account was gated), so the pool must reach an entitled
 * identity rather than failing the whole request.
 */
export const ROTATING_CLASSES: ReadonlySet<PoolFailureClass> = new Set([
  'AUTH', 'QUOTA', 'CAPACITY', 'ENTITLEMENT', 'UPSTREAM',
])

/** Progressive same-identity retry delays for capacity exhaustion (ms). */
export const CAPACITY_BACKOFF_TIERS_MS: readonly number[] = [5000, 10_000, 20_000, 30_000, 60_000]

/** Cooldown applied per failure class when no reset hint refines it (ms). */
export const CLASS_COOLDOWN_MS: Readonly<Record<PoolFailureClass, number>> = {
  AUTH: 15 * 60_000,
  QUOTA: 30_000,
  CAPACITY: 60_000,
  // An entitlement gate is an account/subscription property, not a transient
  // fault: re-probing it every 30 s produced 233 consecutive failures on one
  // live identity. Six hours stops the churn while still recovering the same
  // day after an operator upgrades the plan. The pool's optimistic probe path
  // re-attempts cooling identities when NONE are healthy, so an early upgrade
  // is never blocked for the full window when it is the only identity.
  ENTITLEMENT: 6 * 3600_000,
  GATEWAY_OUTAGE: 0,
  INVALID_REQUEST: 0,
  // A route-wide server policy gate (OpenCode's free-tier client gate) is a
  // property of the route itself, not of this credential: rotating or cooling
  // cannot help, so it terminates instead of rotating.
  POLICY: 0,
  UPSTREAM: 30_000,
}

/** Gateway-side transient model rejections: never rotate, never cool down. */
const TRANSIENT_MODEL_RE = /supported api model names|model is unavailable/i

/** Upstream quota/rate-limit vocabulary (after the transient check). */
const QUOTA_RE = /\b429\b|quota|rate limit|usage limit|resource_exhausted|too many requests/i

/** Capacity/overload vocabulary (distinct from hard quota exhaustion). */
const CAPACITY_RE = /\b503\b|\b529\b|overloaded|capacity|server is busy|model_capacity/i

/** Auth vocabulary. Checked late: status-code words are weaker than bodies. */
// The provider-code clauses (`auth_required`, `authentication`, `invalid_token`,
// `invalid…api…key`) match the `CODE: message` detail the stream mapper carries
// for an AUTH failure, where the original 401/403 status text is no longer part
// of the message.
// eslint-disable-next-line @stylistic/max-len -- the AUTH_RE literal must stay one line (auditable pattern).
const AUTH_RE = /\b401\b|\b402\b|\b403\b|unauthorized|invalid.{0,4}api.{0,4}key|incorrect[_ ]api[_ ]key|permission denied|insufficient (?:credits|balance)|\bauth\b|auth_required|authentication|invalid[_ ]token/i

/** Client-payload vocabulary: the request itself is unserviceable. Deliberately
 *  narrow — several gateways stamp EVERY error envelope (including 401s) with
 *  an `invalid_request_error` code field, so that string alone must never
 *  decide the class. Status-code words are checked in classifyFailure's
 *  ordering instead. */
const INVALID_REQUEST_RE = /\b400\b|\b413\b|invalid argument|context (?:window|length)|maximum context|token limit exceeded/i

/** Transport vocabulary: the connection died before an answer. */
const TRANSPORT_RE = /terminated|premature close|network|econn|socket|fetch failed|other side closed|http2/i

/**
 * Parse an upstream reset hint ("Resets in 46min", "Resets in 4hr 53min",
 * "Resets in 14 days", Command Code's shorthand "Resets in 3h 25m") into
 * milliseconds. Only the first duration phrase directly after "resets in" is
 * taken — the longest contiguous run of number+unit pairs immediately
 * following the anchor (e.g. "4hr 53min" → 4h+53m is one phrase, but
 * "Resets in 46min. ... 5 per hour" → only 46min). Never sums distant
 * numbers. Single-letter units (`d`/`h`/`m`/`w`/`s`) are accepted beside the
 * full words; a bare `m` never matches a longer word because the unit must
 * end at a word boundary. Clamped to [30s, 24h].
 * @param message - the flattened upstream error text.
 * @returns the parsed duration clamped to [30_000, 24h], or undefined when
 *   no hint follows the phrase.
 */
export function parseResetMs(message: string): number | undefined {
  const anchor = message.match(/resets?\s+in\s+/i)
  if (anchor === null || anchor.index === undefined) return undefined
  const tail = message.slice(anchor.index + anchor[0].length)
  const UNIT: Record<string, number> = {
    days: 86_400_000, day: 86_400_000, d: 86_400_000,
    hours: 3_600_000, hour: 3_600_000, hr: 3_600_000, h: 3_600_000,
    minutes: 60_000, minute: 60_000, min: 60_000, m: 60_000,
    weeks: 604_800_000, week: 604_800_000, w: 604_800_000,
    months: 2_592_000_000, month: 2_592_000_000,
    seconds: 1000, second: 1000, sec: 1000, s: 1000,
  }
  const trimmed = tail.trimStart()
  if (trimmed.length === 0) return undefined
  // Longest unit spelling first so `min` wins over `m` and `hr` over `h`.
  const re = /(\d+)\s*(days|day|d|hours|hour|hr|h|minutes|minute|min|m|weeks|week|w|months|month|seconds|second|sec|s)\b/gi
  let total = 0
  let count = 0
  let pos = 0
  while (true) {
    re.lastIndex = pos
    const match = re.exec(trimmed)
    if (match === null || match.index === undefined) break
    const gap = trimmed.slice(pos, match.index)
    if (gap.length > 0 && !/^\s*$/.test(gap)) break
    const unit = UNIT[match[2]?.toLowerCase() ?? '']
    const amount = Number.parseInt(match[1] ?? '0', 10)
    if (unit !== undefined && Number.isFinite(amount)) {
      total += amount * unit
      count += 1
    }
    pos = match.index + match[0].length
  }
  if (count === 0 || total <= 0) return undefined
  return Math.min(Math.max(total, 30_000), 24 * 3600_000)
}

/**
 * Classify a flattened upstream failure. Order matters: the transient-model
 * check wins over everything (its messages embed 400s), 503/529 status codes
 * win over quota vocabulary, and bare status-code words are checked before
 * vocabulary. This ensures 429 → QUOTA wins over "capacity" vocabulary and
 * 503/529 → CAPACITY wins over quota.
 * @param message - the failure text (pi-ai flattens status + body into it).
 * @returns the failure class driving rotation/cooldown decisions.
 */
export function classifyFailure(message: string): PoolFailureClass {
  if (TRANSIENT_MODEL_RE.test(message)) return 'GATEWAY_OUTAGE'
  // OpenCode's free tier is gated server-side to OpenCode's own clients
  // ("You cannot use the free tier in other harnesses", anomalyco/opencode#49621).
  // Checked before the 403→AUTH vocabulary below: rotating keys or cooling an
  // identity down cannot satisfy a policy gate, and the class deliberately
  // stays out of ROTATING_CLASSES.
  if (isFreeTierGatedError(message)) return 'POLICY'
  // A per-account entitlement gate (OpenCode Go: "An active OpenCode Go
  // subscription is required to use Go models.") is identity-specific: live
  // pool state showed sibling identities answering 200 for the same model
  // while one account was gated. It therefore rotates to the next identity
  // with a long cooldown instead of failing the whole request.
  if (isEntitlementGatedError(message)) return 'ENTITLEMENT'
  if (/\b503\b|\b529\b/i.test(message)) return 'CAPACITY'
  if (QUOTA_RE.test(message)) return 'QUOTA'
  if (CAPACITY_RE.test(message)) return 'CAPACITY'
  // Auth before payload errors: real 401 bodies often embed an
  // `invalid_request_error` code field (DeepSeek does exactly that).
  if (AUTH_RE.test(message)) return 'AUTH'
  // The shared classifier catches context-overflow bodies the narrow regex
  // misses (e.g. "prompt is too long for this model"), so a request-shaped
  // 400 never rotates identities or cools a healthy key down.
  if (INVALID_REQUEST_RE.test(message) || isContextWindowExceededError(message)) return 'INVALID_REQUEST'
  if (TRANSPORT_RE.test(message)) return 'UPSTREAM'
  return 'UPSTREAM'
}

/** Quota metadata for one identity on one model. */
export interface IdentityQuotaState {
  remainingFraction?: number | null | undefined
  resetTime?: string | number | null | undefined
  source?: string | undefined
}

/**
 * Extract remaining fraction and reset time from standard rate-limit response headers
 * (OpenAI, Anthropic, OpenRouter, Google).
 */
export function parseQuotaHeaders(headers: Record<string, string | undefined> | Headers): IdentityQuotaState | undefined {
  const get = (name: string): string | undefined => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) ?? undefined
    }
    const rec = headers as Record<string, string | undefined>
    return rec[name] ?? rec[name.toLowerCase()] ?? undefined
  }

  // 1. Requests remaining / limit
  const reqRemStr = get('x-ratelimit-remaining-requests') ?? get('anthropic-ratelimit-requests-remaining')
  const reqLimStr = get('x-ratelimit-limit-requests') ?? get('anthropic-ratelimit-requests-limit')
  const reqReset = get('x-ratelimit-reset-requests') ?? get('anthropic-ratelimit-requests-reset')

  // 2. Tokens remaining / limit
  const tokRemStr = get('x-ratelimit-remaining-tokens') ?? get('anthropic-ratelimit-tokens-remaining')
  const tokLimStr = get('x-ratelimit-limit-tokens') ?? get('anthropic-ratelimit-tokens-limit')
  const tokReset = get('x-ratelimit-reset-tokens') ?? get('anthropic-ratelimit-tokens-reset')

  let remainingFraction: number | undefined
  const reqRem = reqRemStr !== undefined ? Number.parseFloat(reqRemStr) : Number.NaN
  const reqLim = reqLimStr !== undefined ? Number.parseFloat(reqLimStr) : Number.NaN
  const tokRem = tokRemStr !== undefined ? Number.parseFloat(tokRemStr) : Number.NaN
  const tokLim = tokLimStr !== undefined ? Number.parseFloat(tokLimStr) : Number.NaN

  if (!Number.isNaN(reqRem) && !Number.isNaN(reqLim) && reqLim > 0) {
    remainingFraction = Math.max(0, Math.min(1, reqRem / reqLim))
  }
  if (!Number.isNaN(tokRem) && !Number.isNaN(tokLim) && tokLim > 0) {
    const tokFrac = Math.max(0, Math.min(1, tokRem / tokLim))
    remainingFraction = remainingFraction !== undefined ? Math.min(remainingFraction, tokFrac) : tokFrac
  }

  const resetTime = reqReset ?? tokReset
  if (remainingFraction === undefined && resetTime === undefined) {
    return undefined
  }

  return {
    ...remainingFraction !== undefined ? { remainingFraction } : {},
    ...resetTime !== undefined ? { resetTime } : {},
    source: 'headers',
  }
}

/** Routing-relevant state for one identity on one model. Counters are
 *  deliberately NOT persisted: they feed observability only, and a restart
 *  must not resurrect stale traffic counts into routing decisions. */
export interface IdentityModelState {
  cooldownUntil: number
  consecutiveFailures: number
  lastStatus?: number | undefined
  lastError?: string | undefined
  quota?: IdentityQuotaState | undefined
}

interface PersistedProviderState {
  version: 1
  identities: Record<string, Record<string, IdentityModelState>>
}

function emptyModelState(): IdentityModelState {
  return { cooldownUntil: 0, consecutiveFailures: 0 }
}

/** Keep only well-typed quota fields from a loaded state file. */
function sanitizeQuota(value: unknown): IdentityQuotaState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Partial<IdentityQuotaState>
  const quota: IdentityQuotaState = {}
  if (typeof candidate.remainingFraction === 'number' && Number.isFinite(candidate.remainingFraction)) {
    quota.remainingFraction = candidate.remainingFraction
  }
  if (typeof candidate.resetTime === 'string' || typeof candidate.resetTime === 'number') {
    quota.resetTime = candidate.resetTime
  }
  if (typeof candidate.source === 'string') quota.source = candidate.source
  return Object.keys(quota).length > 0 ? quota : undefined
}

export interface PoolEngineOptions {
  /** Directory holding `<provider>.json` state files. */
  stateDir: string
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable delay (tests); must honour an abort signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Diagnostic sink; defaults to silence. */
  log?: (message: string) => void
  /** Debounce window for persisted writes (tests shrink it). */
  saveDebounceMs?: number
}

const DEFAULT_SAVE_DEBOUNCE_MS = 500

/**
 * The pool engine. One instance per plugin mount; all methods are safe to
 * call concurrently (Node's single thread serialises the synchronous state
 * transitions; writes are debounced, serialized per state file, and atomic).
 * State files assume one harness process per state directory: the per-file
 * write queue below keeps this process's concurrent flushes from racing their
 * renames, while two processes writing one file still end last-writer-wins.
 */
export class PoolEngine {
  readonly #stateDir: string
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #log: (message: string) => void
  readonly #saveDebounceMs: number
  readonly #providers = new Map<string, PersistedProviderState>()
  readonly #loaded = new Set<string>()
  /** In-flight (or finished) hydration per provider; concurrent callers share it. */
  readonly #hydrations = new Map<string, Promise<void>>()
  readonly #saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Providers whose state changed since their last successful write. */
  readonly #dirty = new Set<string>()
  /** Tail of the serialized write chain per state file; each new write queues behind it. */
  readonly #writeChains = new Map<string, Promise<void>>()

  /** Round-robin cursor per `provider:model` for the `balanced` strategy.
   *  In-memory only: a restart restarts rotation at the first identity, which
   *  is harmless (balanced ordering carries no correctness weight). */
  readonly #rotation = new Map<string, number>()

  constructor(options: PoolEngineOptions) {
    this.#stateDir = options.stateDir
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error('pool backoff aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }))
    this.#log = options.log ?? (() => {})
    this.#saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS
  }

  /** Attempt order for one request: enabled identities, healthy ones first —
   *  in priority order (`priority-sticky`) or rotated per model (`balanced`);
   *  when none are healthy, ALL enabled identities ordered by priority first,
   *  cooldown as tiebreak (optimistic probing — a cached cooldown is a guess,
   *  a live attempt is the only truth). Only the healthy path advances the
   *  rotation cursor, and only when not peeking, so introspection call sites
   *  (e.g. CAPACITY backoff check) can order without perturbing rotation.
   *  For the all-cooling path, never advance the cursor.
   * @param peek - when true, do not advance the balanced rotation cursor
   *   (introspection must not perturb ordering). */
  orderFor(
    provider: string,
    identities: ReadonlyArray<{ id: string; priority?: number; enabled?: boolean }>,
    modelId: string,
    strategy?: PoolStrategy,
    peek?: boolean,
  ): Array<{ id: string; priority?: number }> {
    const effectiveStrategy = strategy ?? 'priority-sticky'
    const effectivePeek = peek ?? false
    const enabled = identities
      .filter(identity => identity.enabled !== false)
      .map(identity => ({ id: identity.id, ...identity.priority === undefined ? {} : { priority: identity.priority } }))
    const state = this.#providers.get(provider)
    const cooldownOf = (id: string): number =>
      state?.identities[id]?.[modelId]?.cooldownUntil ?? 0
    const healthy = enabled.filter(identity => cooldownOf(identity.id) <= this.#now())
    if (healthy.length > 0) {
      const byPriority = healthy.sort((a, b) =>
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
      if (effectiveStrategy !== 'balanced') return byPriority
      const key = `${provider}:${modelId}`
      const offset = (this.#rotation.get(key) ?? 0) % byPriority.length
      if (!effectivePeek) this.#rotation.set(key, offset + 1)
      return [...byPriority.slice(offset), ...byPriority.slice(0, offset)]
    }
    // All-cooling: priority first, cooldown as tiebreak. Never advance rotation.
    return [...enabled].sort((a, b) => {
      const pa = a.priority ?? Number.MAX_SAFE_INTEGER
      const pb = b.priority ?? Number.MAX_SAFE_INTEGER
      if (pa !== pb) return pa - pb
      return cooldownOf(a.id) - cooldownOf(b.id)
    })
  }

  /** Remaining cooldown for one identity × model (0 when ready). */
  cooldownRemaining(provider: string, identityId: string, modelId: string): number {
    const until = this.#providers.get(provider)?.identities[identityId]?.[modelId]?.cooldownUntil ?? 0
    return Math.max(0, until - this.#now())
  }

  /** Introspection snapshot (observability surfaces; not a hot path). */
  snapshot(provider: string): Record<string, Record<string, IdentityModelState>> {
    const raw = this.#providers.get(provider)?.identities ?? {}
    return structuredClone(raw)
  }

  /** A success proves the identity works right now: clear routing state. */
  recordSuccess(provider: string, identityId: string, modelId: string, status = 200): void {
    const entry = this.#entry(provider, identityId, modelId)
    entry.cooldownUntil = 0
    entry.consecutiveFailures = 0
    entry.lastStatus = status
    entry.lastError = undefined
    this.#scheduleSave(provider)
  }

  /** Record quota information for one identity on one model. */
  recordQuota(provider: string, identityId: string, modelId: string, quota: IdentityQuotaState): void {
    const entry = this.#entry(provider, identityId, modelId)
    entry.quota = { ...entry.quota, ...quota }
    this.#scheduleSave(provider)
  }

  /** Reset cooldowns for one identity or all identities under a provider. */
  resetCooldown(provider: string, identityId?: string): void {
    const providerState = this.#providers.get(provider)
    if (providerState === undefined) return
    const targets = identityId !== undefined
      ? (providerState.identities[identityId] ? [providerState.identities[identityId]] : [])
      : Object.values(providerState.identities)
    for (const models of targets) {
      if (!models) continue
      for (const entry of Object.values(models)) {
        if (!entry) continue
        entry.cooldownUntil = 0
        entry.consecutiveFailures = 0
        entry.lastError = undefined
      }
    }
    this.#scheduleSave(provider)
  }

  /** Status view of all identities configured under a provider route. */
  identitiesStatus(provider: string, identitiesConfig: readonly PiAiPoolIdentity[]): LlmPoolIdentityStatus[] {
    const providerState = this.#providers.get(provider)
    const now = this.#now()
    return identitiesConfig.map((config) => {
      const models = providerState?.identities[config.id] ?? {}
      const entries = Object.values(models)
      let maxCooldown = 0
      let maxFailures = 0
      let lastStatus: number | undefined
      let lastError: string | undefined
      let quota: IdentityQuotaState | undefined

      for (const entry of entries) {
        if (!entry) continue
        if (entry.cooldownUntil > maxCooldown) maxCooldown = entry.cooldownUntil
        if (entry.consecutiveFailures > maxFailures) maxFailures = entry.consecutiveFailures
        if (entry.lastStatus !== undefined) lastStatus = entry.lastStatus
        if (entry.lastError !== undefined) lastError = entry.lastError
        if (entry.quota !== undefined) quota = entry.quota
      }

      return {
        id: config.id,
        credentialRef: config.credentialRef,
        ...config.priority === undefined ? {} : { priority: config.priority },
        ...config.enabled === undefined ? {} : { enabled: config.enabled },
        cooldownUntil: maxCooldown > now ? maxCooldown : 0,
        consecutiveFailures: maxFailures,
        ...lastStatus === undefined ? {} : { lastStatus },
        ...lastError === undefined ? {} : { lastError },
        ...quota !== undefined ? {
          quota: {
            ...quota.remainingFraction !== undefined ? { remainingFraction: quota.remainingFraction } : {},
            ...quota.resetTime !== undefined ? { resetTime: quota.resetTime } : {},
            ...quota.source !== undefined ? { source: quota.source } : {},
          },
        } : {},
      }
    })
  }

  /**
   * Record one failure and apply its cooldown.
   * @returns the class assigned and the cooldown applied (0 for classes that
   *   never cool down).
   */
  recordFailure(
    provider: string,
    identityId: string,
    modelId: string,
    failureClass: PoolFailureClass,
    message: string,
    status?: number,
  ): { failureClass: PoolFailureClass; cooldownUntil: number } {
    const entry = this.#entry(provider, identityId, modelId)
    entry.consecutiveFailures += 1
    entry.lastStatus = status
    entry.lastError = message.slice(0, 500)
    let cooldownMs = CLASS_COOLDOWN_MS[failureClass]
    if (failureClass === 'QUOTA') {
      // A parsed reset hint is authoritative — the gateway told us exactly
      // when its window rolls over, so cooling longer would idle a working
      // key. Replacement, not Math.max: use parsed when present, otherwise
      // 30s floor. Clamped to [30s, 24h] against absurd hints.
      const parsed = parseResetMs(message)
      if (parsed !== undefined) {
        cooldownMs = Math.min(Math.max(parsed, 30_000), 24 * 3600_000)
      } else {
        cooldownMs = 30_000
      }
    }
    entry.cooldownUntil = cooldownMs > 0 ? this.#now() + cooldownMs : 0
    this.#scheduleSave(provider)
    return { failureClass, cooldownUntil: entry.cooldownUntil }
  }

  /** Abort-aware backoff sleep (capacity tiers). */
  backoff(ms: number, signal: AbortSignal): Promise<void> {
    return this.#sleep(ms, signal)
  }

  /** Flush any pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    const pending = new Set([...this.#dirty])
    for (const provider of pending) {
      const timer = this.#saveTimers.get(provider)
      if (timer !== undefined) {
        clearTimeout(timer)
        this.#saveTimers.delete(provider)
      }
      await this.#enqueueWrite(provider)
    }
  }

  #entry(provider: string, identityId: string, modelId: string): IdentityModelState {
    let providerState = this.#providers.get(provider)
    if (providerState === undefined) {
      providerState = { version: 1, identities: {} }
      this.#providers.set(provider, providerState)
      // First touch primes an empty cache; the async hydrate fills routing
      // state from disk before the next decision point (orderFor tolerates
      // absent state either way).
      void this.hydrate(provider)
    }
    providerState.identities[identityId] ??= {}
    providerState.identities[identityId][modelId] ??= emptyModelState()
    return providerState.identities[identityId][modelId]
  }

  /**
   * Load one provider's persisted routing state. Concurrent callers share the
   * same in-flight read, so `await hydrate(p)` after a first touch waits for
   * the merge instead of returning early.
   * @param provider - the provider route key.
   */
  hydrate(provider: string): Promise<void> {
    const pending = this.#hydrations.get(provider)
    if (pending !== undefined) return pending
    if (this.#loaded.has(provider)) return Promise.resolve()
    const run = this.#load(provider)
    this.#hydrations.set(provider, run)
    return run
  }

  async #load(provider: string): Promise<void> {
    this.#loaded.add(provider)
    let raw: string
    try {
      raw = await readFile(join(this.statePath(provider)), 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as PersistedProviderState
      if (parsed.version !== 1 || typeof parsed.identities !== 'object' || parsed.identities === null) {
        this.#log(`pool state for "${provider}" has an unknown shape; starting clean`)
        return
      }
      // Sanitize into fresh objects so hand-edited files cannot inject
      // prototype keys or wrong-typed fields into routing decisions.
      const identities: PersistedProviderState['identities'] = {}
      for (const [identityId, models] of Object.entries(parsed.identities)) {
        if (typeof models !== 'object' || models === null) continue
        identities[identityId] = {}
        for (const [modelId, entry] of Object.entries(models)) {
          if (typeof entry !== 'object' || entry === null) continue
          const candidate = entry as Partial<IdentityModelState>
          const quota = sanitizeQuota(candidate.quota)
          identities[identityId][modelId] = {
            cooldownUntil: typeof candidate.cooldownUntil === 'number' && Number.isFinite(candidate.cooldownUntil)
              ? candidate.cooldownUntil
              : 0,
            consecutiveFailures: typeof candidate.consecutiveFailures === 'number'
              && Number.isInteger(candidate.consecutiveFailures)
              && candidate.consecutiveFailures >= 0
              ? candidate.consecutiveFailures
              : 0,
            ...typeof candidate.lastStatus === 'number' ? { lastStatus: candidate.lastStatus } : {},
            ...typeof candidate.lastError === 'string' ? { lastError: candidate.lastError } : {},
            ...quota === undefined ? {} : { quota },
          }
        }
      }
      const existing = this.#providers.get(provider)
      if (existing === undefined) {
        this.#providers.set(provider, { version: 1, identities })
        return
      }
      if (!this.#dirty.has(provider)) {
        existing.identities = identities
        return
      }
      // Dirty: a failure or success was recorded before this read finished.
      // Memory is authoritative for the keys it already touched; disk
      // restores every other identity/model, so early traffic cannot drop
      // persisted routing state.
      let adopted = false
      for (const [identityId, models] of Object.entries(identities)) {
        const memoryModels = existing.identities[identityId] ?? {}
        existing.identities[identityId] = memoryModels
        for (const [modelId, entry] of Object.entries(models)) {
          if (memoryModels[modelId] === undefined) {
            memoryModels[modelId] = entry
            adopted = true
          }
        }
      }
      // A debounced write may have raced this read; persist the merged state.
      if (adopted) this.#scheduleSave(provider)
    } catch (error) {
      this.#log(`pool state for "${provider}" is unreadable (${String(error)}); starting clean`)
    }
  }

  statePath(provider: string): string {
    return join(this.#stateDir, `${provider}.json`)
  }

  #scheduleSave(provider: string): void {
    this.#dirty.add(provider)
    if (this.#saveTimers.has(provider)) return
    const timer = setTimeout(() => {
      this.#saveTimers.delete(provider)
      void this.#enqueueWrite(provider)
    }, this.#saveDebounceMs)
    this.#saveTimers.set(provider, timer)
  }

  async #persist(
    provider: string,
    path: string,
    tmp: string,
    state: PersistedProviderState,
  ): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(tmp, JSON.stringify(state), 'utf8')
      await rename(tmp, path)
    } catch (error) {
      this.#log(`pool state write for "${provider}" failed: ${String(error)}`)
    }
  }

  /**
   * Serialize one write behind every write already queued for the same state
   * file. tmp+rename is atomic against readers and crashes, but two
   * overlapping snapshots race at rename and the older one can land last,
   * dropping the newer deltas; the per-file chain keeps the final rename the
   * newest snapshot. The chain promise never rejects: `#persist` absorbs
   * every error and reports it through the log.
   */
  #enqueueWrite(provider: string): Promise<void> {
    const previous = this.#writeChains.get(provider) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.#writeNow(provider))
    this.#writeChains.set(provider, next)
    return next
  }

  async #writeNow(provider: string): Promise<void> {
    const state = this.#providers.get(provider)
    if (state === undefined) return
    this.#dirty.delete(provider)
    const path = this.statePath(provider)
    const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
    // Atomic last-writer-wins across processes; inside this process the queue
    // above makes the last writer the newest state.
    await this.#persist(provider, path, tmp, state)
  }
}
