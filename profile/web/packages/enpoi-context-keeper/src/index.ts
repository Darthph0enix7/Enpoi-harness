/**
 * Enpoi Harness Context Keeper — demand-driven cognition (Oracle-approved
 * redesign, docs 31/35 amendments).
 *
 * The prose Living Brief is NO LONGER pushed on every turn end. It is
 * materialized ON DEMAND via `ensureFreshBrief()`, consumed exclusively by
 * the Oracle (call #1) and Council (roundtable/chorus start) — both blocking
 * tools that await it. Workers receive the deterministic fold + task card +
 * whatever prose cache exists at spawn (read-only; they never trigger
 * generation and never receive deltas).
 *
 * Cache policy (Oracle amendments 2-4):
 * - Freshness is STRUCTURAL-SEQ distance (basedOnSeq vs current seq, counting
 *   only user/message, turn/end, tool/call, tool/result), not wall-clock.
 * - `structuralDistanceK` (default 24) structural events → re-distill.
 * - `minRefreshMs` (default 60s) is an anti-thrash floor, not a TTL.
 * - Single-flight keyed per (session, basedOnSeq window): a caller joins the
 *   in-flight pass only when its window is still fresh.
 * - Failures are negative-cached for `negativeCacheMs` (default 120s) so a
 *   provider outage cannot fire repeated fallback chains.
 * - A `turn/end` that leaves the projection structurally stale schedules one
 *   debounced BACKGROUND prefetch (single-flight, same floors), so the next
 *   consumer (oracle/council wait <= 4s) hits the cache instead of paying for
 *   the distillation. The on-demand path stays the fallback.
 * - Raw tool-call/function-call echoes, JSON tool envelopes, and mostly-markup
 *   payloads are rejected as prose (they fail the attempt, so the model chain
 *   advances; rejected text is never published).
 *
 * Memory claims (CBDC Stream B) are DECOUPLED from prose: a batched listener
 * runs one extraction pass per `claimsBatchSize` (default 8) non-aborted
 * turn/ends or `claimsBatchMinutes` (default 5), whichever first. Per-claim
 * trust labels: tool-sourced → `verified_execution`, chat-sourced →
 * `operator` (Oracle amendment 5 — fixes the pre-existing trust bug where
 * chat hearsay auto-graduated as verified).
 *
 * Deleted machinery (P3): the turn/end prose arming, debounce, rerun latch,
 * and wedge-race state machine. The keeper is now a service, not a watcher.
 *
 * @module dsh-enpoi-context-keeper
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { SessionLogOffset, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { BlockAssembler, createUserMessage, isContextWindowExceededError, type ContextFormed, type GenerateOptions } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Enpoi context keeper: state-checkpoint surface messages and keeper model requests. */
    'enpoi-keeper': { kind: 'enpoi-keeper' } & ContextFormed
  }
}
import { deadline } from '@deepseek-ai/dsh-timeout'
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openMemoryDb } from 'dsh-enpoi-memory'
import { makePipeline } from 'dsh-enpoi-memory'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'enpoi-context-keeper'

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Unwrap one effective Config field (Volatile ref on 0.1.7+, plain value before it). */
function value<T>(field: T | Volatile<T>): T {
  return typeof (field as Volatile<T> | undefined)?.get === 'function'
    ? (field as Volatile<T>).get()
    : field as T
}

/** Detach every Config field into plain values (idempotent on pre-0.1.7 plain configs). */
function plainConfig<T extends object>(config: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config)) out[key] = value(field as unknown as Volatile<unknown>)
  return out as T
}

/** The llm service is required — the keeper is a model-backed worker. */
export const inject = ['llm']

/** Minimal file diagnostics — the Cordis logger only buffers (no console sink). */
function diag(line: string): void {
  try {
    // Unit runs (vitest) must not append fixture noise to the operator's live
    // journal; an explicit DSH_HOME still wins (the prefetch spec asserts its
    // own redirected log).
    const home = process.env.DSH_HOME
      ?? (process.env.VITEST === 'true' ? join(tmpdir(), 'dsh-keeper-vitest') : process.env.HOME ?? '/tmp')
    const dir = join(home.endsWith('.dsh') ? home : join(home, '.dsh'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'enpoi-keeper.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the keeper
  }
}

/**
 * Whether the Context Keeper is enabled in the Capabilities Control Center
 * (enpoi-orchestration.capabilities.tools.keeper, default true). When
 * disabled, prose distillation and claims extraction are skipped.
 */
function keeperEnabled(ctx: Context): boolean {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const tools = (doc?.capabilities as { tools?: Record<string, boolean> } | undefined)?.tools
    return tools?.['keeper'] !== false
  } catch {
    return true
  }
}

/** Keeper primary/fallback route plus its per-wake budgets (doc 38; live-editable).
 * The primary defaults to the keyless kilo seed (`kilo/kilo-auto/free`) a fresh
 * install can reach; a configured machine overrides it through the plugin row or
 * `enpoi-orchestration.personas.keeper`. There is no default fallback: a second
 * link exists only when the operator sets `fallbackProvider` and `fallbackModel`
 * or assigns a chain via `personas.keeper.chain`. */
export interface Config {
  provider?: Volatile<string>
  model?: Volatile<string>
  fallbackProvider?: Volatile<string>
  fallbackModel?: Volatile<string>
  leaseMs?: Volatile<number>
  maxInputEvents?: Volatile<number>
  maxOutputTokens?: Volatile<number>
  /** Structural-event distance that triggers a re-distillation. */
  structuralDistanceK?: Volatile<number>
  /** Anti-thrash floor: reuse a distillation younger than this. */
  minRefreshMs?: Volatile<number>
  /** Failure negative-cache window. */
  negativeCacheMs?: Volatile<number>
  /** Claims batch: one pass per N non-aborted turn/ends… */
  claimsBatchSize?: Volatile<number>
  /** …or T minutes, whichever first. */
  claimsBatchMinutes?: Volatile<number>
  /** Staleness floor: structural events since the last state checkpoint. */
  checkpointStaleEvents?: Volatile<number>
  /** Staleness floor: hours since the last state checkpoint. */
  checkpointStaleHours?: Volatile<number>
}

export const Config = Schema.object({
  provider: live(Schema.string().default('kilo')),
  model: live(Schema.string().default('kilo-auto/free')),
  fallbackProvider: live(Schema.string()),
  fallbackModel: live(Schema.string()),
  leaseMs: live(Schema.number().default(45_000)),
  maxInputEvents: live(Schema.number().default(80)),
  maxOutputTokens: live(Schema.number().default(2048)),
  structuralDistanceK: live(Schema.number().default(24)),
  minRefreshMs: live(Schema.number().default(60_000)),
  negativeCacheMs: live(Schema.number().default(120_000)),
  claimsBatchSize: live(Schema.number().default(8)),
  claimsBatchMinutes: live(Schema.number().default(5)),
  checkpointStaleEvents: live(Schema.number().default(12)),
  checkpointStaleHours: live(Schema.number().default(24)),
})

/** Secrets-exclusion instruction (doc 35 §1.1) — summarization never credentials. */
const PROSE_PROMPT = [
  'You are the Enpoi Harness context keeper — the master background summarizer and architectural keeper for this coding session.',
  'You maintain a running, concise, and highly accurate Living Brief of the session for later dispatch to the Oracle and Council debaters.',
  'If a [PREVIOUS SESSION BRIEF] is provided, incrementally merge it with the [RECENT SESSION EVENTS & TOOL RESULTS] (including Council/Roundtable consensus, Oracle verdicts, subagent returns, tool results, documentation paths, and user directives).',
  'NEVER extract, repeat, or retain credentials, passwords, API keys, tokens, or personal secrets.',
  '',
  'CRITICAL SECTION DISCIPLINE (ZERO-FILLER RULE):',
  '- ONLY include a section if there is genuine, substantive information established in the session.',
  '- If no documentation files were created or referenced, DO NOT emit the 📚 section and NEVER write "No documentation...".',
  '- If no approaches were debated/rejected, DO NOT emit the 🚫 section and NEVER write "No alternative approaches...".',
  '- If there are no open blockers, DO NOT emit the ⚡ section and NEVER write "No blockers remain...".',
  '- For simple queries, greetings, or health-checks (e.g. ping), emit ONLY a single-line 🎯 ACTIVE GOAL or keep the brief empty. NEVER invent placeholder bullets.',
  '',
  'Output ONLY the relevant section headers from below (omit any section with no substantive content):',
  '',
  '🎯 ACTIVE GOAL & CORE TRAJECTORY:',
  '- Current active objective, user directives, and high-level technical paradigms.',
  '',
  '📚 DOCUMENTATION & SPECIFICATIONS INVENTORY:',
  '- List documentation, plans, architectures, and spec files written, modified, or referenced in the session with a 1-line summary.',
  '',
  '🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:',
  '- Concrete technical decisions established in the session: exact component boundaries, protocols (IPC/HTTP/WS/Redis), data keys/schemas, state machines, and concurrency rules.',
  '',
  '🚫 REJECTED APPROACHES & EDGE CASES:',
  '- Approaches debated and explicitly ruled out (and reasons why), edge cases handled, and failure modes defended.',
  '',
  '⚡ ACTIVE BLOCKERS & OPEN QUESTIONS:',
  '- Unresolved technical questions, pending implementation tasks, or immediate next steps.',
  '',
  'No other text at all — no preamble, no CLAIMS block, no JSON.',
].join('\n')

/** Claims-only extraction prompt — decoupled from prose (Oracle amendment 5). */
const CLAIMS_PROMPT = [
  'You are the Enpoi Harness memory extractor. From the [RECENT SESSION EVENTS & TOOL RESULTS] below, extract durable, permanent facts about operator\'s environment, infrastructure, and architecture.',
  'NEVER extract, repeat, or retain credentials, passwords, API keys, tokens, or personal secrets.',
  '',
  'Output EXACTLY one line: "CLAIMS:" followed by a JSON array: [{"fact":"...","category":"ARCHITECTURE","tags":"...","source":"tool"}]',
  '- category limited to ARCHITECTURE, CONFIG_VALUES, or PROJECT.',
  '- source MUST be "tool" when the fact is derived from tool results/executions (verified by execution), or "chat" when it was stated by the user or assistant in conversation.',
  '- File 2-4 durable facts whenever the session surfaces them; else "CLAIMS: []".',
  '- Skip transient chatter and anything already obvious from the session itself.',
  'No other text at all.',
].join('\n')

/** Structural event types — the only events that age the brief (Oracle amendment 3). */
const STRUCTURAL_TYPES = new Set(['user/message', 'turn/end', 'tool/call', 'tool/result'])

/**
 * Doc-38 ceiling for a keeper summary's output budget. `maxOutputTokens` is
 * clamped to this value, and a route cut by the configured cap is retried once
 * at the ceiling before the chain treats the link as dead: a long brief is a
 * cap problem, not a route problem, and losing the whole distill to it leaves
 * the Living Brief stale (live defect 2026-09-26).
 */
export const KEEPER_MAX_OUTPUT_TOKENS = 4096

/**
 * Incremental structural-event totals per Session object (a WeakMap, so a
 * disposed session takes its counter with it): seeded with ONE read per
 * session, then maintained from committed events so freshness checks are O(1)
 * (the synchronous history readers are deprecated; the runtime intends to stop
 * keeping the sequence resident).
 */
const structuralCounters = new WeakMap<Session, { seq: number; total: number }>()

/**
 * Seed on first use, maintain from committed events, and catch up over any
 * appended tail a missed delivery left behind — only the delta is read, so
 * freshness checks stay O(1) instead of cloning the whole log.
 */
function structuralTotal(session: Session): number {
  const known = structuralCounters.get(session)
  if (known === undefined) {
    let count = 0
    for (const event of session.snapshotEvents()) {
      if (STRUCTURAL_TYPES.has(event.type)) count += 1
    }
    structuralCounters.set(session, { seq: session.seq, total: count })
    return count
  }
  // `session.seq` is the next sequence number (log length), so `known.seq`
  // already points one past the last counted event.
  if (session.seq <= known.seq) return known.total
  let count = known.total
  for (const event of session.snapshotEvents(SessionLogOffset(known.seq))) {
    if (STRUCTURAL_TYPES.has(event.type)) count += 1
  }
  structuralCounters.set(session, { seq: session.seq, total: count })
  return count
}

/** Resolved model route for one keeper wake (Oracle: resolve once per run, never inside executeRoute). */
export interface RouteChainLink {
  provider: string
  model: string
  effort?: string
}

interface ResolvedRoute {
  provider: string
  model: string
  /** Second link, present only when the operator configured one. */
  fallbackProvider?: string
  /** Second link model, present only when the operator configured one. */
  fallbackModel?: string
  reasoningEffort?: string
  /** Chain id when the keeper persona assigned a model chain (doc 60). */
  chainId?: string
  /** Frozen chain link snapshot, taken when the run resolved its route. */
  chainLinks?: RouteChainLink[]
}

/** One resolved chain snapshot as the `modelChains` service answers it. */
interface ChainSnapshot {
  id: string
  links: Array<{ provider: string; model: string; effort?: string }>
  attempts?: number
  onCut?: 'failover' | 'continue'
}

/**
 * Resolve a model-chain snapshot through the `modelChains` service (provided
 * by dsh-enpoi-model-chains). Fail-open: a missing service, an unknown or
 * disabled id, a malformed payload, or any read error answers `undefined` and
 * the caller keeps its single-model behaviour.
 * @param ctx - owning plugin context.
 * @param id - candidate chain id (usually `personas.keeper.chain`).
 * @returns the frozen link snapshot, or undefined.
 */
function resolveChainSnapshot(ctx: Context, id: unknown): ChainSnapshot | undefined {
  if (typeof id !== 'string' || id.trim() === '') return undefined
  try {
    const service = ctx.get('modelChains') as { resolve?: (id: string) => unknown } | undefined
    const snapshot = service?.resolve?.(id.trim())
    if (snapshot === null || typeof snapshot !== 'object') return undefined
    const record = snapshot as { id?: unknown; links?: unknown; attempts?: unknown; onCut?: unknown }
    if (!Array.isArray(record.links)) return undefined
    const links: ChainSnapshot['links'] = []
    for (const raw of record.links) {
      if (raw === null || typeof raw !== 'object') continue
      const link = raw as { provider?: unknown; model?: unknown; effort?: unknown }
      const provider = typeof link.provider === 'string' ? link.provider.trim() : ''
      const model = typeof link.model === 'string' ? link.model.trim() : ''
      if (provider === '' || model === '') continue
      const effort = typeof link.effort === 'string' && link.effort.trim() !== '' ? link.effort.trim() : undefined
      links.push({ provider, model, ...(effort !== undefined ? { effort } : {}) })
    }
    if (links.length === 0) return undefined
    const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts) && record.attempts >= 1
      ? Math.floor(record.attempts)
      : undefined
    const onCut = record.onCut === 'continue' ? 'continue' as const : 'failover' as const
    return {
      id: typeof record.id === 'string' && record.id !== '' ? record.id : id.trim(),
      links,
      ...(attempts !== undefined ? { attempts } : {}),
      onCut,
    }
  } catch {
    return undefined
  }
}

/**
 * Resolve the keeper's runtime parameters (doc 38): the
 * `enpoi-orchestration.parameters.keeper` settings namespace overrides the
 * plugin Config per wake — hot-swap, no restart. Values are clamped to the
 * doc-38 ranges.
 */
export function resolveKeeperParams(ctx: Context, config: Config): Config {
  config = plainConfig(config)
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const p = (doc?.parameters as { keeper?: Partial<Config> } | undefined)?.keeper
    if (p === undefined || typeof p !== 'object') return config
    const clamp = (v: unknown, fallback: number, min: number, max: number): number =>
      typeof v === 'number' && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : fallback
    return {
      ...config,
      leaseMs: clamp(p.leaseMs, config.leaseMs ?? 45_000, 15_000, 120_000),
      maxInputEvents: clamp(p.maxInputEvents, config.maxInputEvents ?? 80, 20, 200),
      maxOutputTokens: clamp(p.maxOutputTokens, config.maxOutputTokens ?? 2048, 512, KEEPER_MAX_OUTPUT_TOKENS),
      structuralDistanceK: clamp(p.structuralDistanceK, config.structuralDistanceK ?? 24, 4, 200),
      minRefreshMs: clamp(p.minRefreshMs, config.minRefreshMs ?? 60_000, 5_000, 300_000),
      negativeCacheMs: clamp(p.negativeCacheMs, config.negativeCacheMs ?? 120_000, 5_000, 600_000),
      claimsBatchSize: clamp(p.claimsBatchSize, config.claimsBatchSize ?? 8, 1, 50),
      claimsBatchMinutes: clamp(p.claimsBatchMinutes, config.claimsBatchMinutes ?? 5, 1, 60),
      checkpointStaleEvents: clamp(p.checkpointStaleEvents, config.checkpointStaleEvents ?? 12, 1, 500),
      checkpointStaleHours: clamp(p.checkpointStaleHours, config.checkpointStaleHours ?? 24, 1, 168),
    }
  } catch {
    return config
  }
}

/**
 * Resolve the keeper's model route for this wake.
 *
 * Precedence (Oracle amendment): `enpoi-orchestration.personas.keeper` (operator
 * assignment) > plugin Config primary/fallback. A fallback link exists only when
 * the operator configured `fallbackProvider` and `fallbackModel`, or assigned a
 * chain. Partial entries (missing provider or model) are ignored. The Config
 * primary defaults to the keyless kilo seed a fresh install routes.
 */
export function resolveKeeperRoute(ctx: Context, config: Config): ResolvedRoute {
  config = plainConfig(config)
  const fallback = config.fallbackProvider !== undefined && config.fallbackModel !== undefined
    ? { fallbackProvider: config.fallbackProvider, fallbackModel: config.fallbackModel }
    : {}
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const entry = (doc?.personas as Record<string, { provider?: string; model?: string; reasoningEffort?: string; chain?: string } | null> | undefined)?.['keeper']
    // Model chain (doc 60): `personas.keeper.chain` names a chain whose links
    // replace the primary → fallback pair for this run. The persona's
    // provider/model (when present) is the ACTIVE link; the chain's remaining
    // links follow in order. Snapshot ownership stays here — summarize() never
    // re-reads settings between attempts.
    const chain = resolveChainSnapshot(ctx, entry?.chain)
    if (chain !== undefined) {
      const active: RouteChainLink = entry !== undefined && entry.provider && entry.model
        ? {
            provider: entry.provider,
            model: entry.model,
            ...(entry.reasoningEffort ? { effort: entry.reasoningEffort } : {}),
          }
        : { ...chain.links[0]! }
      const links: RouteChainLink[] = [
        active,
        ...chain.links.filter(link => !(link.provider === active.provider && link.model === active.model)),
      ]
      return {
        provider: active.provider,
        model: active.model,
        ...fallback,
        ...(active.effort ? { reasoningEffort: active.effort } : {}),
        chainId: chain.id,
        chainLinks: links,
      }
    }
    if (entry && entry.provider && entry.model) {
      return {
        provider: entry.provider,
        model: entry.model,
        ...fallback,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      }
    }
  } catch {
    // settings unavailable — fall through to config defaults
  }
  return {
    provider: config.provider ?? 'kilo',
    model: config.model ?? 'kilo-auto/free',
    ...fallback,
  }
}

/**
 * The ordered attempts for one summarize call: the run's frozen chain link
 * snapshot when the keeper persona assigned a chain, else the primary followed
 * by the explicitly configured fallback link when the operator set one.
 * Attempts are one-per-link (the fork's adapter loop owns the per-link
 * `attempts` budget); the consumer's validator is the cut detector, so a
 * cut/error advances to the next link.
 * @param route - the route resolved once per keeper run.
 * @returns the ordered provider/model attempts.
 */
export function keeperAttempts(route: ResolvedRoute): Array<{ provider: string; model: string; reasoningEffort?: string }> {
  if (route.chainLinks !== undefined && route.chainLinks.length > 0) {
    return route.chainLinks.map(link => ({
      provider: link.provider,
      model: link.model,
      ...(link.effort !== undefined ? { reasoningEffort: link.effort } : {}),
    }))
  }
  const attempts = [
    {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
    },
  ]
  if (route.fallbackProvider !== undefined && route.fallbackModel !== undefined) {
    attempts.push({
      provider: route.fallbackProvider,
      model: route.fallbackModel,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
    })
  }
  return attempts
}

/** Result of an ensureFreshBrief call. */
export interface BriefResult {
  ok: boolean
  prose: string | null
  model?: string
  reason: 'cache-hit' | 'distilled' | 'failed' | 'negative-cached'
}

/**
 * Default per-session entry cap for the keeper's caches. Disposal
 * (`session/disposed`) is the primary eviction path; the cap is the
 * belt-and-braces bound so a missed lifecycle edge can never grow a cache
 * without limit.
 */
export const KEEPER_CACHE_CAP = 128

/**
 * Per-session LRU map: reads refresh recency and writes evict the oldest entry
 * once the cap is exceeded (O(1) per operation). Evicting is always
 * behavior-neutral — every cache here is a projection of the session log, so a
 * miss is merely recomputed.
 */
export class BoundedSessionCache<V> extends Map<string, V> {
  readonly cap: number

  /**
   * @param cap - maximum live entries (LRU).
   * @param onEvict - optional cleanup for a value the LRU evicts (e.g. a
   *   pending timer). Never called by explicit `delete`/`clear` — callers that
   *   drop an entry deliberately own its teardown.
   */
  constructor(
    cap: number = KEEPER_CACHE_CAP,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {
    super()
    this.cap = Number.isFinite(cap) ? Math.max(1, Math.floor(cap)) : KEEPER_CACHE_CAP
  }

  get(key: string): V | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      // Re-insert at the newest position — an O(1) recency refresh.
      super.delete(key)
      super.set(key, value)
    }
    return value
  }

  set(key: string, value: V): this {
    super.delete(key)
    super.set(key, value)
    if (super.size > this.cap) {
      const oldest = super.keys().next().value
      if (oldest !== undefined) {
        const evicted = super.get(oldest) as V
        super.delete(oldest)
        try {
          this.onEvict?.(oldest, evicted)
        } catch {
          // an eviction hook must never break the write path
        }
      }
    }
    return this
  }
}

/** Per-session brief cache entry. */
interface BriefCacheEntry {
  basedOnSeq: number
  basedOnStructuralCount: number
  prose: string
  model: string
  updatedAt: number
  /** Failure negative-cache deadline (ms epoch); 0 = none. */
  negativeUntil: number
  /** In-flight distillation promise (single-flight). */
  inFlight: Promise<BriefResult> | null
  /** The snapshot seq the in-flight pass is based on. */
  inFlightSnapshotSeq: number
  /** Structural total when the in-flight pass started. */
  inFlightStructural: number
}

function emptyEntry(): BriefCacheEntry {
  return {
    basedOnSeq: 0,
    basedOnStructuralCount: 0,
    prose: '',
    model: '',
    updatedAt: 0,
    negativeUntil: 0,
    inFlight: null,
    inFlightSnapshotSeq: 0,
    inFlightStructural: 0,
  }
}

/**
 * The demand-driven brief service. Owns the per-session prose cache and the
 * single-flight distillation. Exposed to consumers (oracle, council) via the
 * module-level singleton set in apply() — the profile packages are bundled
 * separately, so a Cordis service registry cannot be shared reliably.
 */
export class BriefService {
  private readonly cache = new BoundedSessionCache<BriefCacheEntry>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /** Live cache entries (diagnostics/tests; the map is LRU-bounded). */
  get cacheSize(): number {
    return this.cache.size
  }

  /**
   * Drop the session's cached brief — the `session/disposed` eviction path.
   * A later call recomputes from the log, so eviction is behavior-neutral.
   * @param sessionId - the disposed session's id.
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /**
   * Materialize (or reuse) the session's prose brief.
   *
   * Cache policy: negative-cache → anti-thrash floor → structural distance →
   * single-flight join → distill. Never throws for provider failures — it
   * returns `{ ok: false }` (soft-degrading, frozen doc principle). Throws
   * only when the CALLER's signal aborts (the consumer is being cancelled).
   */
  async ensureFreshBrief(session: Session, signal?: AbortSignal): Promise<BriefResult> {
    // Capabilities Control Center: the keeper can be disabled globally
    // (enpoi-orchestration.capabilities.tools.keeper). When disabled, prose
    // distillation is skipped — consumers (oracle/council) degrade to the
    // deterministic fold only.
    if (!keeperEnabled(this.ctx)) {
      return { ok: false, prose: null, reason: 'keeper-disabled' }
    }
    const key = session.id
    // Doc 38: runtime parameters resolved fresh per call (hot-swap).
    const cfg = resolveKeeperParams(this.ctx, this.config)
    const entry = this.cache.get(key)
    const now = Date.now()

    // 1. Negative cache: a recent failure is reused (no fallback-chain storms).
    if (entry !== undefined && entry.negativeUntil > now) {
      return { ok: false, prose: null, reason: 'negative-cached' }
    }

    // 2. Anti-thrash floor: a distillation younger than minRefreshMs is reused.
    if (entry !== undefined && entry.prose.length > 0 && now - entry.updatedAt < (cfg.minRefreshMs ?? 60_000)) {
      return { ok: true, prose: entry.prose, model: entry.model, reason: 'cache-hit' }
    }

    // 3. Structural freshness: silence never invalidates prose.
    if (entry !== undefined && entry.prose.length > 0) {
      const distance = structuralTotal(session) - entry.basedOnStructuralCount
      if (distance <= (cfg.structuralDistanceK ?? 24)) {
        return { ok: true, prose: entry.prose, model: entry.model, reason: 'cache-hit' }
      }
    }

    // 4. Single-flight: join an in-flight pass whose window is still fresh.
    if (entry !== undefined && entry.inFlight !== null) {
      const inFlightDistance = structuralTotal(session) - entry.inFlightStructural
      if (inFlightDistance <= (cfg.structuralDistanceK ?? 24)) {
        try {
          return await entry.inFlight
        } catch (error) {
          // Oracle defect 2: a joiner must NOT inherit the ORIGINATOR's abort
          // rejection — only this caller's own cancellation propagates.
          if (signal?.aborted) throw error
          return { ok: false, prose: null, reason: 'failed' }
        }
      }
      // The in-flight pass is for an older window — start a new one.
    }

    // 5. Distill (snapshot the seq BEFORE the async call — I3 causal ordering).
    const snapshotSeq = session.seq
    const promise = this.distill(session, signal, snapshotSeq, cfg)
    this.cache.set(key, {
      ...(entry ?? emptyEntry()),
      inFlight: promise,
      inFlightSnapshotSeq: snapshotSeq,
      inFlightStructural: structuralTotal(session),
    })
    try {
      return await promise
    } finally {
      const current = this.cache.get(key)
      if (current !== undefined && current.inFlight === promise) {
        this.cache.set(key, { ...current, inFlight: null })
      }
    }
  }

  /**
   * Whether a background prefetch is warranted right now. Consumers wait only
   * 4 s for prose (oracle/council), while a live distillation can take ~7 s —
   * so after a turn/end that leaves the projection structurally stale the
   * keeper warms the cache itself instead of making the next consumer miss.
   *
   * Honours the same floors as `ensureFreshBrief`: the anti-thrash floor
   * (minRefreshMs), the failure negative cache, and single-flight. Pure read —
   * never triggers work by itself.
   * @param session - the session whose projection may be stale.
   * @returns whether the caller should schedule a prefetch.
   */
  prefetchDue(session: Session): boolean {
    if (!keeperEnabled(this.ctx)) return false
    const cfg = resolveKeeperParams(this.ctx, this.config)
    const now = Date.now()
    const entry = this.cache.get(session.id)
    if (entry !== undefined) {
      if (entry.negativeUntil > now) return false // failure negative cache
      if (entry.inFlight !== null) return false // a pass is already running
      if (entry.prose.length > 0 && now - entry.updatedAt < (cfg.minRefreshMs ?? 60_000)) return false // anti-thrash floor
    }
    const distance = structuralTotal(session) - (entry?.basedOnStructuralCount ?? 0)
    return distance > (cfg.structuralDistanceK ?? 24)
  }

  /** One distillation pass: lease-bound LLM call, then append + cache. */
  private async distill(session: Session, signal: AbortSignal | undefined, snapshotSeq: number, cfg: Config): Promise<BriefResult> {
    const lease = new AbortController()
    const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45_000)
    const combined = signal !== undefined ? AbortSignal.any([signal, lease.signal]) : lease.signal
    try {
      const input = frameInput(session, cfg.maxInputEvents ?? 80)
      if (input.length === 0) {
        diag(`ensureFreshBrief: session=${session.id} — empty input, skipping`)
        return { ok: false, prose: null, reason: 'failed' }
      }
      const route = resolveKeeperRoute(this.ctx, cfg)
      const snapshotStructural = structuralTotal(session)
      diag(`ensureFreshBrief: session=${session.id} — calling LLM (input ${input.length} chars, route ${route.provider}/${route.model}, basedOnSeq ${snapshotSeq})`)
      const result = await summarize(this.ctx, cfg, session, input, combined, route, PROSE_PROMPT, false)
      const prose = cleanKeeperProse(result.text)
      if (prose.length === 0) {
        diag(`ensureFreshBrief: session=${session.id} — empty or cleaned-empty prose, skipping`)
        return { ok: false, prose: null, reason: 'failed' }
      }
      // Clean stack: the LLM resolved, no append is being published.
      session.append('brief/prose-updated', {
        basedOnSeq: snapshotSeq,
        basedOnStructuralCount: snapshotStructural,
        structuralDistanceK: cfg.structuralDistanceK ?? 24,
        model: result.route,
        text: prose,
        origin: 'context-keeper',
      })
      // Preserve the CURRENT entry's in-flight registration — a superseding
      // pass for a newer window may be registered while this one completes
      // (Oracle defect 1: unconditional inFlight:null erased it).
      const current = this.cache.get(session.id)
      this.cache.set(session.id, {
        ...(current ?? emptyEntry()),
        basedOnSeq: snapshotSeq,
        basedOnStructuralCount: snapshotStructural,
        prose,
        model: result.route,
        updatedAt: Date.now(),
        negativeUntil: 0,
      })
      diag(`ensureFreshBrief: session=${session.id} — appended brief/prose-updated via ${result.route} (${prose.length} chars, basedOnSeq ${snapshotSeq})`)
      return { ok: true, prose, model: result.route, reason: 'distilled' }
    } catch (error) {
      if (signal?.aborted) throw error // caller cancelled — propagate
      const entry = this.cache.get(session.id)
      this.cache.set(session.id, {
        ...(entry ?? emptyEntry()),
        negativeUntil: Date.now() + (cfg.negativeCacheMs ?? 120_000),
      })
      diag(`ensureFreshBrief: session=${session.id} — FAILED ${String(error)} (negative-cached ${cfg.negativeCacheMs ?? 120_000}ms)`)
      return { ok: false, prose: null, reason: 'failed' }
    } finally {
      clearTimeout(leaseTimer)
    }
  }
}

/** Module-level singleton — set by apply(), read by consumers (oracle/council). */
/** Cross-bundle anchor: even if a consumer bundle inlines this module, the
 *  live service published by the keeper's own apply() stays reachable. */
const BRIEF_SERVICE_ANCHOR = Symbol.for('enpoi.context-keeper.brief-service')
let briefService: BriefService | null = null

/**
 * Background-prefetch debounce: a burst of turn/ends coalesces into one
 * prefetch; a pending run is never reset (it always fires, and the service's
 * single-flight/staleness checks make it a no-op when one already landed).
 */
export const PREFETCH_DEBOUNCE_MS = 2_000

/** Get the mounted brief service (null before apply or if the plugin is absent). */
export function getBriefService(): BriefService | null {
  const anchored = (globalThis as unknown as Record<symbol, unknown>)[BRIEF_SERVICE_ANCHOR]
  return (anchored as BriefService | undefined) ?? briefService
}

/** Create a standalone service (tests / headless use). */
export function createBriefService(ctx: Context, config: Config): BriefService {
  return new BriefService(ctx, config)
}

// ── State checkpoint (doc 67 §A): surface layer [4] ─────────────────────────
//
// The keeper's five-section brief is written as an append-only
// `state/checkpoint` event whose newest member is INTENDED to be injected into
// every assembly through the runtime-context seam (order 130, after the frozen
// segments and before the whiteboard [5]/tail [6]). It has no reader yet —
// nothing consumes `state/checkpoint` today; the Watchtower "State" card is
// still pending in another lane, so the event is currently log-only. Refresh
// triggers: (1) a segment cut (`compaction/end` | `compaction/summary`),
// (2) the staleness floor (>= N structural events or >= T hours since the last
// checkpoint, whichever first — the floor fires on its own; token pressure is
// an extra trigger only), (3) on demand (`ensureCheckpoint`). The deterministic
// template always produces a valid checkpoint, so a provider outage can never
// leave the layer empty. There is no token budget on this layer; the 1 500
// token rendered budget (doc 67 §B) belongs to the whiteboard, not the
// checkpoint.

/** Producer-owned source kind of the keeper's own messages (V4 refuses the retired `plugin` kind). */
export const KEEPER_MESSAGE_KIND = 'enpoi-keeper'

/** Source marker that identifies the keeper's own surface checkpoint messages. */
export const CHECKPOINT_SOURCE = { kind: KEEPER_MESSAGE_KIND } as const

/**
 * One state checkpoint as persisted on the `state/checkpoint` event (and as the
 * text of the surface message that replaces the previous checkpoint node).
 */
export interface CheckpointData {
  /** Monotonic checkpoint version (1 on the first refresh). */
  version: number
  /** Session seq the brief is based on (snapshot taken before the model call). */
  basedOnSeq: number
  /** Structural-event total when the refresh started. */
  basedOnStructuralCount: number
  /** Serving route (`provider/model`) or `template`. */
  model: string
  /** Whether the prose came from the model or the deterministic fold. */
  via: 'llm' | 'template'
  /** The five-section brief (may be empty for a session with nothing yet). */
  text: string
  /** Temporal grounding + refresh provenance line. */
  telemetry: string
  createdAt: number
}

/** Result of an ensureCheckpoint call. */
export interface CheckpointResult {
  ok: boolean
  text: string | null
  model?: string
  reason: 'cache-hit' | 'refreshed' | 'keeper-disabled'
}

/**
 * The telemetry line every checkpoint carries (doc 66 §3d): temporal grounding
 * without token panic, plus the refresh provenance (planned for the Watchtower
 * state card — no reader consumes it today).
 * @param session - the session the checkpoint belongs to.
 * @param meta - route, mechanism, and seq facts of this refresh.
 * @returns the one-line telemetry.
 */
export function checkpointTelemetry(
  session: Session,
  meta: { seq: number; model: string; via: 'llm' | 'template' },
): string {
  const day = (value: number | undefined): string => {
    if (value === undefined || !Number.isFinite(value)) return 'unknown'
    try {
      return new Date(value).toISOString().slice(0, 10)
    } catch {
      return 'unknown'
    }
  }
  const parts: string[] = []
  const startedAt = (session.header as { createdAt?: number } | undefined)?.createdAt
  parts.push(`session started ${day(startedAt)}`)
  try {
    const events = session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!
      if (event.type !== 'turn/start') continue
      const turn = (event.data as { turn?: number }).turn
      if (typeof turn === 'number' && Number.isFinite(turn)) parts.push(`turn ${turn}`)
      break
    }
  } catch {
    // temporal grounding degrades to the two dates
  }
  parts.push(`today ${day(Date.now())}`)
  parts.push(`refreshed at seq ${meta.seq}`)
  parts.push(`by ${meta.model}`)
  parts.push(`via ${meta.via}`)
  return parts.join(' · ')
}

/**
 * Render one checkpoint into the exact injected block: header, the brief, and
 * the telemetry line. The newest checkpoint always replaces the previous
 * on the surface (the runtime-context projection owns that replacement).
 * @param data - the persisted checkpoint.
 * @returns the injected block.
 */
export function renderCheckpointBlock(data: CheckpointData): string {
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  return ['### State checkpoint', text, data.telemetry].filter((line) => line.length > 0).join('\n\n')
}

/**
 * Deterministic template checkpoint: the code-assembled fold used when the
 * managed model chain is unavailable. Always returns a string; sections with
 * no substantive content are omitted (zero-filler rule).
 * @param session - the session to fold.
 * @returns the five-section brief text (possibly empty for an empty session).
 */
export function buildTemplateCheckpoint(session: Session): string {
  try {
    const events = session.snapshotEvents()
    let firstUser = ''
    let lastUser = ''
    let lastAssistant = ''
    let lastError = ''
    const docFiles = new Set<string>()

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = messageText((event.data as { content: unknown }).content).trim()
        if (text.length > 0) {
          if (firstUser.length === 0) firstUser = text
          lastUser = text
        }
      } else if (event.type === 'assistant/message') {
        const text = assistantMessageText(event.data)
        if (text.length > 0) lastAssistant = text
      } else if (event.type === 'tool/call') {
        const args = (event.data as { arguments?: string }).arguments
        if (typeof args === 'string') {
          const matches = args.match(/["']([^"']*\.(?:md|json|yaml|yml))["']/g)
          if (matches !== null) {
            for (const match of matches) {
              const clean = match.replace(/["']/g, '')
              if (clean.length > 2 && docFiles.size < 8) docFiles.add(clean)
            }
          }
        }
      } else if (event.type === 'tool/result') {
        const error = (event.data as { error?: { message?: string } }).error
        if (typeof error?.message === 'string' && error.message.length > 0) lastError = error.message.slice(0, 300)
      }
    }

    const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)
    const sections: string[] = []
    if (firstUser.length > 0 || lastUser.length > 0) {
      const goal = firstUser.length > 0 ? `- Objective: ${clip(firstUser.replace(/\s+/g, ' '), 300)}` : ''
      const latest = lastUser.length > 0 && lastUser !== firstUser
        ? `- Latest directive: ${clip(lastUser.replace(/\s+/g, ' '), 300)}`
        : ''
      sections.push(['🎯 ACTIVE GOAL & CORE TRAJECTORY:', goal, latest].filter((line) => line.length > 0).join('\n'))
    }
    if (docFiles.size > 0) {
      sections.push(['📚 DOCUMENTATION & SPECIFICATIONS INVENTORY:', ...[...docFiles].map((file) => `- ${file}`)].join('\n'))
    }
    if (lastAssistant.length > 0) {
      const decision = clip(lastAssistant.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)[0] ?? '', 300)
      if (decision.length > 0) sections.push(['🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:', `- ${decision}`].join('\n'))
    }
    if (lastError.length > 0) {
      sections.push(['⚡ ACTIVE BLOCKERS & OPEN QUESTIONS:', `- Last tool error: ${lastError}`].join('\n'))
    }
    return sections.join('\n\n')
  } catch (error) {
    diag(`buildTemplateCheckpoint: fold failed (${String(error)})`)
    return ''
  }
}

/**
 * Incremental newest-checkpoint reader per live Session (WeakMap, so a disposed
 * session takes its cursor with it). Seeded with one read, then maintained from
 * committed events, with a delta catch-up for a missed delivery — the
 * runtime-context provider calls this on every assembly, so it must stay O(1).
 */
const checkpointCursors = new WeakMap<Session, { seq: number; data: CheckpointData | null }>()

/**
 * Read the newest `state/checkpoint` event from a session log.
 * @param session - the session to read.
 * @returns the newest checkpoint data, or null when the session has none.
 */
export function latestCheckpoint(session: Session): CheckpointData | null {
  const known = checkpointCursors.get(session)
  if (known !== undefined && session.seq <= known.seq) return known.data
  let data = known?.data ?? null
  const from = known?.seq ?? 0
  try {
    for (const event of session.snapshotEvents(SessionLogOffset(from))) {
      if (event.type !== 'state/checkpoint') continue
      const candidate = event.data as Partial<CheckpointData>
      if (typeof candidate?.text === 'string' || typeof candidate?.telemetry === 'string') {
        data = {
          version: typeof candidate.version === 'number' ? candidate.version : 0,
          basedOnSeq: typeof candidate.basedOnSeq === 'number' ? candidate.basedOnSeq : 0,
          basedOnStructuralCount: typeof candidate.basedOnStructuralCount === 'number' ? candidate.basedOnStructuralCount : 0,
          model: typeof candidate.model === 'string' ? candidate.model : 'unknown',
          via: candidate.via === 'llm' ? 'llm' : 'template',
          text: typeof candidate.text === 'string' ? candidate.text : '',
          telemetry: typeof candidate.telemetry === 'string' ? candidate.telemetry : '',
          createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
        }
      }
    }
  } catch (error) {
    diag(`latestCheckpoint: read failed (${String(error)})`)
  }
  checkpointCursors.set(session, { seq: session.seq, data })
  return data
}

/** Append one checkpoint event (log-only, ignorable for older readers). */
function appendCheckpoint(session: Session, data: CheckpointData): void {
  const append = session.append as unknown as (type: string, payload: unknown, opts?: { ignorable?: true }) => unknown
  append.call(session, 'state/checkpoint', data, { ignorable: true })
}

/**
 * The seq of the live surface node holding this keeper's previous checkpoint
 * message, or null when none survives. The log is the source of truth: a
 * message that was shadowed by a later revert is not a valid replace target,
 * so a resumed or reverted session appends a fresh node instead.
 * @param session - the session to inspect.
 * @returns the live checkpoint message seq, or null.
 */
export function latestCheckpointMessageSeq(session: Session): number | null {
  const surface = new Set(session.surface.nodes)
  if (surface.size === 0) return null
  let found: number | null = null
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== KEEPER_MESSAGE_KIND) continue
      if (surface.has(event.seq)) found = event.seq
    }
  } catch (error) {
    diag(`latestCheckpointMessageSeq: read failed (${String(error)})`)
  }
  return found
}

/**
 * Commit the checkpoint to the surface: one plugin-sourced user message whose
 * `surfaceOp` replaces the previous checkpoint node in place (append-only log,
 * never an in-place mutation). The replaced node leaves the priced surface, so
 * exactly one state checkpoint is live regardless of refresh count.
 * @param session - the session receiving the checkpoint message.
 * @param text - the rendered checkpoint block.
 */
function commitCheckpointMessage(session: Session, text: string): void {
  const append = session.append as unknown as (type: string, message: unknown, intent: unknown) => unknown
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...CHECKPOINT_SOURCE },
  })
  const previous = latestCheckpointMessageSeq(session)
  if (previous !== null) {
    try {
      append.call(session, 'user/message', message, {
        surfaceOp: { op: 'replace', startSeq: previous, endSeq: previous },
        sourceEventSeqs: [previous],
      })
      return
    } catch (error) {
      // The node can be shadowed between the scan and the append (a revert
      // commit). A checkpoint must never fail a turn: append a fresh node.
      diag(`commitCheckpointMessage: replace of seq ${previous} failed, appending (${String(error)})`)
    }
  }
  append.call(session, 'user/message', message, { surfaceOp: 'append' })
}

/** Per-session checkpoint cache entry (single-flight + freshness). */
interface CheckpointEntry {
  version: number
  basedOnSeq: number
  basedOnStructuralCount: number
  text: string
  model: string
  via: 'llm' | 'template'
  createdAt: number
  inFlight: Promise<CheckpointResult> | null
}

/**
 * The checkpoint writer. Owns the per-session freshness cache and the
 * single-flight refresh; the session log is the durable source of truth, so a
 * cold reopen rehydrates the cache from the newest event.
 */
export class CheckpointService {
  private readonly cache = new BoundedSessionCache<CheckpointEntry>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /** Live cache entries (diagnostics/tests; the map is LRU-bounded). */
  get cacheSize(): number {
    return this.cache.size
  }

  /**
   * Drop the session's cached checkpoint — the `session/disposed` eviction
   * path. The log is the durable source of truth, so a later call rehydrates
   * from the newest `state/checkpoint` (behavior-neutral).
   * @param sessionId - the disposed session's id.
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  /**
   * Ensure the session's state checkpoint is fresh.
   *
   * `force` (a segment cut) refreshes even inside the freshness window: the
   * boundary busts the prompt cache anyway, and the keeper's brief is a
   * point-in-time snapshot by contract. Never throws for provider failures —
   * the deterministic template always yields a valid checkpoint.
   * @param session - the session to checkpoint.
   * @param opts - `force` for a segment-cut refresh.
   * @returns whether the checkpoint is present and how it was produced.
   */
  async ensureCheckpoint(session: Session, opts: { force?: boolean } = {}): Promise<CheckpointResult> {
    if (!keeperEnabled(this.ctx)) return { ok: false, text: null, reason: 'keeper-disabled' }
    const cfg = resolveKeeperParams(this.ctx, this.config)
    const key = session.id
    const now = Date.now()
    let entry = this.cache.get(key)
    if (entry === undefined) {
      const logged = latestCheckpoint(session)
      if (logged !== null) {
        entry = {
          version: logged.version,
          basedOnSeq: logged.basedOnSeq,
          basedOnStructuralCount: logged.basedOnStructuralCount,
          text: logged.text,
          model: logged.model,
          via: logged.via,
          createdAt: logged.createdAt,
          inFlight: null,
        }
        this.cache.set(key, entry)
      }
    }
    const structural = structuralTotal(session)
    if (entry !== undefined && opts.force !== true) {
      const freshStructural = structural - entry.basedOnStructuralCount < (cfg.checkpointStaleEvents ?? 12)
      const freshAge = now - entry.createdAt < (cfg.checkpointStaleHours ?? 24) * 3_600_000
      if (freshStructural && freshAge) {
        return { ok: true, text: entry.text, model: entry.model, reason: 'cache-hit' }
      }
    }
    if (entry?.inFlight != null) {
      try {
        return await entry.inFlight
      } catch {
        return { ok: false, text: null, reason: 'refreshed' }
      }
    }
    const snapshotSeq = session.seq
    const promise = this.refresh(session, snapshotSeq, cfg, structural)
    this.cache.set(key, {
      ...(entry ?? {
        version: 0, basedOnSeq: 0, basedOnStructuralCount: 0, text: '', model: '', via: 'template', createdAt: 0,
      }),
      inFlight: promise,
    })
    try {
      return await promise
    } finally {
      const current = this.cache.get(key)
      if (current !== undefined && current.inFlight === promise) this.cache.set(key, { ...current, inFlight: null })
    }
  }

  /** One refresh: model chain, then the deterministic template fallback. */
  private async refresh(
    session: Session,
    snapshotSeq: number,
    cfg: Config,
    structural: number,
  ): Promise<CheckpointResult> {
    let text = ''
    let model = 'template'
    let via: 'llm' | 'template' = 'template'
    const lease = new AbortController()
    const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45_000)
    try {
      const input = frameInput(session, cfg.maxInputEvents ?? 80)
      if (input.length > 0) {
        const route = resolveKeeperRoute(this.ctx, cfg)
        diag(`ensureCheckpoint: session=${session.id} — calling LLM (input ${input.length} chars, route ${route.provider}/${route.model}, basedOnSeq ${snapshotSeq})`)
        const result = await summarize(this.ctx, cfg, session, input, lease.signal, route, PROSE_PROMPT, false)
        const prose = cleanKeeperProse(result.text)
        if (prose.length > 0) {
          text = prose
          model = result.route
          via = 'llm'
        }
      }
    } catch (error) {
      diag(`ensureCheckpoint: session=${session.id} — model path failed, using template (${String(error)})`)
    } finally {
      clearTimeout(leaseTimer)
    }
    if (via === 'template') {
      text = buildTemplateCheckpoint(session)
      model = 'template'
    }
    const current = this.cache.get(session.id)
    const version = (latestCheckpoint(session)?.version ?? current?.version ?? 0) + 1
    const data: CheckpointData = {
      version,
      basedOnSeq: snapshotSeq,
      basedOnStructuralCount: structural,
      model,
      via,
      text,
      telemetry: checkpointTelemetry(session, { seq: snapshotSeq, model, via }),
      createdAt: Date.now(),
    }
    try {
      appendCheckpoint(session, data)
      commitCheckpointMessage(session, renderCheckpointBlock(data))
    } catch (error) {
      diag(`ensureCheckpoint: session=${session.id} — commit failed (${String(error)})`)
      return { ok: false, text: null, reason: 'refreshed' }
    }
    checkpointCursors.set(session, { seq: session.seq, data })
    this.cache.set(session.id, {
      version,
      basedOnSeq: snapshotSeq,
      basedOnStructuralCount: structural,
      text,
      model,
      via,
      createdAt: data.createdAt,
      inFlight: current?.inFlight ?? null,
    })
    diag(`ensureCheckpoint: session=${session.id} — appended state/checkpoint v${version} via ${via} (${text.length} chars)`)
    return { ok: true, text, model, reason: 'refreshed' }
  }
}

/**
 * Whether token pressure is above half the context window. Unknown facts
 * (no meter, no logged window) answer `true`: the staleness floor exists to
 * keep the layer current, so uncertainty must not withhold it.
 */
function pressureAboveHalf(ctx: Context, session: Session): boolean {
  try {
    const window = (session as { requestContext?: () => { contextWindow?: number } | undefined }).requestContext?.()?.contextWindow
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return true
    const meter = ctx.get('tokenMeter') as { measure?: (target: Session) => { totalTokens?: number } } | undefined
    const used = meter?.measure?.(session)?.totalTokens
    if (typeof used !== 'number' || !Number.isFinite(used)) return true
    return used >= window * 0.5
  } catch {
    return true
  }
}

/** Module-level singleton — set by apply(), read by on-demand consumers. */
const CHECKPOINT_SERVICE_ANCHOR = Symbol.for('enpoi.context-keeper.checkpoint-service')
let checkpointService: CheckpointService | null = null

/** Get the mounted checkpoint service (null before apply or if the plugin is absent). */
export function getCheckpointService(): CheckpointService | null {
  const anchored = (globalThis as unknown as Record<symbol, unknown>)[CHECKPOINT_SERVICE_ANCHOR]
  return (anchored as CheckpointService | undefined) ?? checkpointService
}

/** Create a standalone checkpoint service (tests / headless use). */
export function createCheckpointService(ctx: Context, config: Config): CheckpointService {
  return new CheckpointService(ctx, config)
}

/**
 * Read-only size view of the per-session bookkeeping owned by the most recent
 * apply() mount. Exists for diagnostics/tests — the runtime eviction path is
 * the `session/disposed` listener registered inside apply().
 */
export interface KeeperBookkeeping {
  claimCounters(): number
  prefetchTimers(): number
  prefetchRunning(): number
  claimsRunning(): number
}

let bookkeeping: KeeperBookkeeping | null = null

/** Bookkeeping sizes of the most recent apply() mount (null before one). */
export function getKeeperBookkeeping(): KeeperBookkeeping | null {
  return bookkeeping
}

export function apply(ctx: Context, config: Config): void {
  // Detach the effective values once; the live override surface for this
  // plugin is `enpoi-orchestration.parameters.keeper`, read per wake.
  config = plainConfig(config)
  const ownedService = createBriefService(ctx, config)
  briefService = ownedService
  ;(globalThis as unknown as Record<symbol, unknown>)[BRIEF_SERVICE_ANCHOR] = ownedService
  const ownedCheckpoint = createCheckpointService(ctx, config)
  checkpointService = ownedCheckpoint
  ;(globalThis as unknown as Record<symbol, unknown>)[CHECKPOINT_SERVICE_ANCHOR] = ownedCheckpoint
  diag(`apply: mounted (demand-driven; prose on oracle/council use, state checkpoint on segment cuts + staleness floor, surface replace in place, claims batched ${config.claimsBatchSize ?? 8}/${config.claimsBatchMinutes ?? 5}min)`)

  // ── Background brief prefetch (fix 2) ─────────────────────────────────────
  // A turn/end that leaves the projection structurally stale schedules one
  // debounced background distillation. Consumers still call ensureFreshBrief()
  // on demand (the fallback path); when they do it after a prefetch landed, they
  // hit the cache and need no LLM call. Failures stay negative-cached and the
  // prefetch never publishes rejected prose (cleanKeeperProse returns '').
  const prefetchTimers = new Map<string, NodeJS.Timeout>()
  const prefetchRunning = new Set<string>()
  const runPrefetch = (session: Session): void => {
    if (prefetchRunning.has(session.id)) return // single-flight
    prefetchRunning.add(session.id)
    void ownedService.ensureFreshBrief(session).then((result) => {
      diag(`prefetch: session=${session.id} — landed (${result.reason}, ${result.prose?.length ?? 0} chars, model ${result.model ?? 'n/a'})`)
    }).catch((error) => {
      diag(`prefetch: session=${session.id} — failed (${String(error)})`)
    }).finally(() => {
      prefetchRunning.delete(session.id)
    })
  }
  const schedulePrefetch = (session: Session): void => {
    try {
      if (!ownedService.prefetchDue(session)) return
      if (prefetchTimers.has(session.id)) return // debounced run already pending
      const timer = setTimeout(() => {
        prefetchTimers.delete(session.id)
        runPrefetch(session)
      }, PREFETCH_DEBOUNCE_MS)
      // Background nicety — never hold the process open for it.
      ;(timer as { unref?: () => void }).unref?.()
      prefetchTimers.set(session.id, timer)
    } catch {
      // prefetch is advisory — it must never affect the turn
    }
  }

  // ── Claims batched listener (P1, survives P3) ─────────────────────────────
  // A plain counter + timer — NO debounce, NO rerun latch, NO wedge machinery.
  // LRU-bounded like the service caches; an evicted counter cancels its timer.
  const claimCounters = new BoundedSessionCache<{ count: number; timer: NodeJS.Timeout | null }>(
    KEEPER_CACHE_CAP,
    (_id, counter) => {
      if (counter.timer !== null) clearTimeout(counter.timer)
    },
  )
  const claimsRunning = new Set<string>()

  // Diagnostics/tests: read-only size view of the apply-local maps.
  const ownedBookkeeping: KeeperBookkeeping = {
    claimCounters: () => claimCounters.size,
    prefetchTimers: () => prefetchTimers.size,
    prefetchRunning: () => prefetchRunning.size,
    claimsRunning: () => claimsRunning.size,
  }
  bookkeeping = ownedBookkeeping

  // ── Session disposal: canonical per-session eviction ─────────────────────
  // `session/disposed` is the harness's paired teardown edge (emitted when a
  // session leaves the store, including the permanent-delete RPC path). Drop
  // every per-session cache here so a long-lived keeper never retains one
  // entry per session ever seen. O(1), log-free; a later call simply
  // recomputes (behavior-neutral for any live session).
  ctx.on('session/disposed', (session: Session) => {
    ownedService.forget(session.id)
    ownedCheckpoint.forget(session.id)
    const counter = claimCounters.get(session.id)
    if (counter !== undefined) {
      if (counter.timer !== null) clearTimeout(counter.timer)
      claimCounters.delete(session.id)
    }
    const prefetchTimer = prefetchTimers.get(session.id)
    if (prefetchTimer !== undefined) {
      clearTimeout(prefetchTimer)
      prefetchTimers.delete(session.id)
    }
    prefetchRunning.delete(session.id)
    claimsRunning.delete(session.id)
  })

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    // Structural events age the brief; keep the total incrementally (a session
    // still unseeded is counted from its log on first use). A malformed event
    // (no numeric seq) leaves the counter untouched — the next structuralTotal
    // delta catch-up reads it from the log instead.
    if (STRUCTURAL_TYPES.has(event.type)) {
      const known = structuralCounters.get(session)
      if (known !== undefined && Number.isFinite(event.seq)) {
        structuralCounters.set(session, { seq: event.seq + 1, total: known.total + 1 })
      }
    }
    // Checkpoints keep their own cursor so the assembly-time reader stays O(1).
    if (event.type === 'state/checkpoint') {
      checkpointCursors.set(session, { seq: event.seq + 1, data: event.data as CheckpointData })
    }
    // Trigger 1 — segment cut: the compaction engine commits a boundary
    // (compaction/end | compaction/summary); refresh the state checkpoint now,
    // because the boundary already busts the prompt cache.
    if ((event.type === 'compaction/end' || event.type === 'compaction/summary') && keeperEnabled(ctx)) {
      void ownedCheckpoint.ensureCheckpoint(session, { force: true }).catch(() => {
        // the ladder never blocks a turn; the next trigger retries
      })
    }
    if (event.type !== 'turn/end') return
    if (!keeperEnabled(ctx)) return // Capabilities toggle: keeper disabled
    const reason = (event.data as { reason: { kind: string } }).reason
    if (reason.kind === 'aborted') return // don't extract from interrupted turns
    // Trigger 3 — staleness floor: >= N structural events or >= T hours since
    // the last checkpoint (fires on the floor alone — doc 67 amendment).
    maybeScheduleStaleCheckpoint(ctx, config, session, ownedCheckpoint)
    // Warm the prose cache for the next consumer (oracle/council wait only 4 s).
    schedulePrefetch(session)
    let counter = claimCounters.get(session.id)
    if (counter === undefined) {
      counter = { count: 0, timer: null }
      claimCounters.set(session.id, counter)
    }
    counter.count += 1
    // 5-min timer, reset on each turn/end ("or T minutes, whichever first").
    if (counter.timer !== null) clearTimeout(counter.timer)
    counter.timer = setTimeout(() => {
      counter!.timer = null
      void runClaimsPass(ctx, config, session, claimsRunning)
    }, (config.claimsBatchMinutes ?? 5) * 60_000)
    // Batch size reached — run now.
    if (counter.count >= (config.claimsBatchSize ?? 8)) {
      counter.count = 0
      if (counter.timer !== null) {
        clearTimeout(counter.timer)
        counter.timer = null
      }
      void runClaimsPass(ctx, config, session, claimsRunning)
    }
  })

  ctx.on('dispose', () => {
    for (const counter of claimCounters.values()) {
      if (counter.timer !== null) clearTimeout(counter.timer)
    }
    claimCounters.clear()
    claimsRunning.clear()
    for (const timer of prefetchTimers.values()) clearTimeout(timer)
    prefetchTimers.clear()
    prefetchRunning.clear()
    // Oracle Q4 nit: only null the singleton if WE own it — a second mounted
    // instance (tests + runtime) must not kill the first's service.
    if (briefService === ownedService) briefService = null
    if ((globalThis as unknown as Record<symbol, unknown>)[BRIEF_SERVICE_ANCHOR] === ownedService) {
      delete (globalThis as unknown as Record<symbol, unknown>)[BRIEF_SERVICE_ANCHOR]
    }
    if (checkpointService === ownedCheckpoint) checkpointService = null
    if ((globalThis as unknown as Record<symbol, unknown>)[CHECKPOINT_SERVICE_ANCHOR] === ownedCheckpoint) {
      delete (globalThis as unknown as Record<symbol, unknown>)[CHECKPOINT_SERVICE_ANCHOR]
    }
    if (bookkeeping === ownedBookkeeping) bookkeeping = null
  })
}

/**
 * The staleness-floor trigger: refresh in the background (single-flight inside
 * the service, so repeated turn/ends cannot stack passes).
 *
 * Doc-67 amendment (fix 3): the structural floor fires ON ITS OWN —
 * >= N structural events or >= T hours since the last checkpoint, whichever
 * first. Token pressure is no longer a gate (live windows are 1 048 576 tokens,
 * so a half-window reading was unreachable and checkpoints never fired); it
 * stays an extra trigger only, and it can never bypass the service's
 * anti-thrash window (or create a first checkpoint before the structural
 * floor). At most one checkpoint per firing: `ensureCheckpoint` appends one
 * `state/checkpoint` event and replaces the previous surface node in place.
 */
function maybeScheduleStaleCheckpoint(
  ctx: Context,
  config: Config,
  session: Session,
  service: CheckpointService,
): void {
  try {
    const cfg = resolveKeeperParams(ctx, config)
    const last = latestCheckpoint(session)
    const structural = structuralTotal(session)
    const floorMet = last === null
      ? structural >= (cfg.checkpointStaleEvents ?? 12)
      : structural - last.basedOnStructuralCount >= (cfg.checkpointStaleEvents ?? 12)
        || Date.now() - last.createdAt >= (cfg.checkpointStaleHours ?? 24) * 3_600_000
    if (!floorMet) {
      // Extra trigger only: pressure can request a refresh but never before a
      // first checkpoint exists, and the service's freshness window still wins.
      if (last === null || !pressureAboveHalf(ctx, session)) return
    }
    void service.ensureCheckpoint(session).catch(() => {
      // non-blocking by contract; the next turn/end or segment cut retries
    })
  } catch {
    // staleness is advisory — it must never affect the turn
  }
}

/** One batched claims pass: single-flight, lease-bound, trust-split intake. */
async function runClaimsPass(
  ctx: Context,
  config: Config,
  session: Session,
  running: Set<string>,
): Promise<void> {
  if (running.has(session.id)) return // single-flight — the next batch catches it
  running.add(session.id)
  // Doc 38: runtime parameters resolved fresh per pass (hot-swap).
  const cfg = resolveKeeperParams(ctx, config)
  const lease = new AbortController()
  const leaseTimer = setTimeout(() => lease.abort(), cfg.leaseMs ?? 45_000)
  try {
    const input = frameInput(session, cfg.maxInputEvents ?? 80)
    if (input.length === 0) return
    const route = resolveKeeperRoute(ctx, cfg)
    diag(`claims: session=${session.id} — calling LLM (input ${input.length} chars, route ${route.provider}/${route.model})`)
    const result = await summarize(ctx, cfg, session, input, lease.signal, route, CLAIMS_PROMPT, true)
    const claims = splitClaims(result.text)
    if (claims.length === 0) {
      diag(`claims: session=${session.id} — no claims extracted`)
      return
    }
    // Open INSIDE the try (Oracle D1): makePipeline construction must also be
    // covered by the close — a construction throw must not leak the handle.
    const memDb = openMemoryDb()
    try {
      const mem = makePipeline(memDb)
      const provenance = JSON.stringify({ sessionId: session.id })
      const toolClaims = claims.filter(c => c.source === 'tool')
      const chatClaims = claims.filter(c => c.source !== 'tool')
      if (toolClaims.length > 0) {
        await mem.intake(
          toolClaims.map(c => ({ fact: c.fact, category: c.category, tags: c.tags })),
          { origin: 'keeper', trust: 'verified_execution', provenance },
        )
      }
      if (chatClaims.length > 0) {
        await mem.intake(
          chatClaims.map(c => ({ fact: c.fact, category: c.category, tags: c.tags })),
          { origin: 'keeper', trust: 'operator', provenance },
        )
      }
      diag(`claims: session=${session.id} — ${toolClaims.length} tool + ${chatClaims.length} chat claim(s) filed`)
    } finally {
      // Oracle defect 4: node:sqlite does not auto-close on GC — close the
      // per-pass handle or the fd leaks.
      memDb.close()
    }
  } catch (error) {
    diag(`claims: session=${session.id} — FAILED ${String(error)}`)
  } finally {
    clearTimeout(leaseTimer)
    running.delete(session.id)
  }
}

/** Case-insensitive markers of a raw tool-call / function-call echo. */
const PROSE_REJECT_MARKERS = ['<dots_function_call', '<function_call', 'tool_call', '<tool_use'] as const

/** Whether a parsed JSON value (to a bounded depth) looks like a tool-call envelope. */
function isToolEnvelopeValue(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(item => isToolEnvelopeValue(item, depth + 1))
  const record = value as Record<string, unknown>
  // The canonical envelope: {"name": ..., "arguments": ...}
  if (typeof record.name === 'string' && (typeof record.arguments === 'string' || (record.arguments !== null && typeof record.arguments === 'object'))) {
    return true
  }
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true
  for (const key of ['function_call', 'tool_call', 'tool_use', 'toolUse']) {
    if (record[key] !== null && typeof record[key] === 'object') return true
  }
  return false
}

/** Whether the whole output is a bare JSON tool envelope (never keeper prose). */
function isToolJsonEnvelope(text: string): boolean {
  if (!text.startsWith('{') && !text.startsWith('[')) return false
  try {
    return isToolEnvelopeValue(JSON.parse(text))
  } catch {
    return false
  }
}

/**
 * Whether the output is mostly markup with no brief section header — a raw
 * XML/HTML payload echo rather than a five-section brief.
 */
function isMostlyMarkup(text: string): boolean {
  // A real brief always carries at least one section header.
  if (/[🎯📚🏛️🚫⚡]/.test(text)) return false
  const tags = text.match(/<[^>]{0,300}>/g)
  if (tags === null || tags.length < 3) return false
  const tagChars = tags.reduce((sum, tag) => sum + tag.length, 0)
  const total = text.replace(/\s+/g, '').length
  return total > 0 && tagChars / total >= 0.4
}

/**
 * Reject raw tool-call / function-call echoes, JSON tool envelopes, and
 * mostly-markup payloads before they can ever become a brief.
 *
 * Live defect (2026-09-19, freellmapi/auto): the model echoed the framed input
 * back as `<dots_function_call>` XML, the stream looked clean (finish `stop`),
 * and `cleanKeeperProse` published the echo as prose. A rejection here is
 * treated as a failed attempt by the caller, so the model-chain fallback runs
 * and the rejected text is never appended or checkpointed.
 * @param text - raw model output.
 * @returns the rejection reason, or null when the text may be treated as prose.
 */
export function keeperProseRejection(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 'empty output'
  // A bare JSON document is never a brief; check the tool envelope first so a
  // `tool_calls` key reports the precise reason rather than the generic marker.
  if (isToolJsonEnvelope(trimmed)) return 'JSON tool-call envelope'
  const lower = trimmed.toLowerCase()
  for (const marker of PROSE_REJECT_MARKERS) {
    if (lower.includes(marker)) return `tool-call/function-call echo (${marker})`
  }
  if (isMostlyMarkup(trimmed)) return 'output is mostly markup'
  return null
}

/** The five section headers the prose prompt requires a brief to be built from. */
const KEEPER_SECTION_HEADERS_GLOBAL = /^[🎯📚🏛️🚫⚡]\s*/gm

/** Minimum published-brief length in characters; a one-line landing is never a brief. */
export const KEEPER_MIN_BRIEF_CHARS = 40
/** Minimum recognized section headers a published brief must carry. */
const KEEPER_MIN_BRIEF_SECTIONS = 1
/** Minimum bullet content lines a published brief must carry. */
const KEEPER_MIN_BRIEF_BULLETS = 1

/**
 * Structural floor for a publishable brief: at least one recognized section
 * header, at least one bullet line, and at least {@link KEEPER_MIN_BRIEF_CHARS}
 * characters. A probe echo, a header-only landing, or a one-line landing is
 * never a brief, so the caller's route ladder (fail over → template) runs.
 * @param text - raw model output before cleaning.
 * @returns the rejection reason, or null when the landing has brief structure.
 */
export function keeperBriefShapeRejection(text: string): string | null {
  const sections = text.match(KEEPER_SECTION_HEADERS_GLOBAL)?.length ?? 0
  if (sections < KEEPER_MIN_BRIEF_SECTIONS) return 'brief has no section header'
  const bullets = (text.match(/^\s*-\s+\S/gm) ?? []).length
  if (bullets < KEEPER_MIN_BRIEF_BULLETS) return 'brief has no bullet content'
  if (text.trim().length < KEEPER_MIN_BRIEF_CHARS) {
    return `brief is below the minimum length (${KEEPER_MIN_BRIEF_CHARS} chars)`
  }
  return null
}

/**
 * Sanitize keeper prose by stripping sections that contain ONLY negative filler / boilerplate.
 * (e.g. "No documentation...", "No alternative approaches were debated...", "No blockers remain...").
 * Keeps the brief clean, meaningful, and token-efficient. Rejected outputs
 * (tool-call echoes / envelopes / markup blobs / shape failures) clean to '' —
 * never published.
 *
 * Live defect (2026-09-27, opencode-go/deepseek-v4.1-flash): a background
 * prefetch landed the assistant's probe answer (`F1=640 … F10=unknown`, 87
 * chars) with no section header at all; the splitter treated line 0 as a
 * header and line 1 as content, so the echo was published as the Living Brief.
 * A landing without brief structure (header, bullet, length) is never a brief:
 * clean to '' (the caller advances the route and nothing is appended).
 */
export function cleanKeeperProse(text: string): string {
  if (!text || text.trim().length === 0) return ''
  if (keeperProseRejection(text) !== null) return ''
  if (keeperBriefShapeRejection(text) !== null) return ''
  const sectionChunks = text.split(/(?=^[🎯📚🏛️🚫⚡]\s*)/m)
  const cleaned: string[] = []

  for (const chunk of sectionChunks) {
    const trimmed = chunk.trim()
    if (!trimmed) continue

    const lines = trimmed.split('\n')
    const contentLines = lines.slice(1).map(l => l.trim()).filter(Boolean)

    // If section has header but 0 content lines, omit
    if (contentLines.length === 0) continue

    // Check if every bullet in the section is just negative filler / placeholder
    const isAllNegativeFiller = contentLines.every(l =>
      /^-\s*(no\b|none\b|n\/a\b|nothing\b|not applicable\b)/i.test(l) ||
      /no documentation.*(?:created|referenced|modified|identified)/i.test(l) ||
      /no alternative approaches/i.test(l) ||
      /no blockers/i.test(l) ||
      /no open questions/i.test(l) ||
      /no edge cases/i.test(l)
    )

    if (!isAllNegativeFiller) {
      cleaned.push(trimmed)
    }
  }

  const cleanedText = cleaned.join('\n\n')
  // Cleaning can strip a long-but-filler-only landing below the floor; the
  // published brief must still clear it.
  return cleanedText.length < KEEPER_MIN_BRIEF_CHARS ? '' : cleanedText
}

/** Parse the CLAIMS block with per-claim source tags (A3.5: parse is isolated). */
export function splitClaims(text: string): Array<{ fact: string; category: string; tags?: string; source: 'tool' | 'chat' }> {
  const idx = text.indexOf('CLAIMS:')
  if (idx === -1) return []
  const jsonPart = text.slice(idx + 'CLAIMS:'.length).trim()
  try {
    // Balanced extraction (Oracle defect 5 + live defect 2026-09-26): greedy
    // matching ran to the LAST ']' (trailing bracketed prose broke parse);
    // non-greedy stopped at the FIRST ']' even inside a string value. The
    // string-aware scanner honours both.
    const json = extractClaimsJsonArray(jsonPart)
    if (json === null) return []
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).fact === 'string')
      .map(c => ({
        fact: String(c.fact).trim().slice(0, 300),
        category: String(c.category ?? 'PROJECT').slice(0, 32),
        tags: typeof c.tags === 'string' ? c.tags : undefined,
        source: c.source === 'tool' ? 'tool' : 'chat',
      }))
      .filter(c => c.fact.length > 0)
  } catch {
    diag('splitClaims: CLAIMS JSON parse failed (isolated)')
    return []
  }
}

/** Frame the recent turn's events into a compact summarizer input with rolling merge. */
function frameInput(session: Session, maxEvents: number): string {
  const events = session.snapshotEvents()

  // 1. Recover the most recent previous brief prose for rolling merge: the
  //    newest state checkpoint (the current truth) or a legacy prose update.
  let previousProse = ''
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    const candidate = e.type === 'state/checkpoint' || e.type === 'brief/prose-updated'
      ? (e.data as { text?: string }).text
      : undefined
    if (typeof candidate === 'string' && candidate.length > 0) {
      previousProse = candidate.slice(0, 4000)
      break
    }
  }

  // 2. Extract recent sliding window of events and detect specification/documentation files.
  const start = Math.max(0, events.length - maxEvents)
  const lines: string[] = []
  const docFiles = new Set<string>()

  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'user/message') {
      const text = messageText((event.data as { content: unknown }).content)
      if (text.length > 0) lines.push(`USER: ${text.slice(0, 2500)}`)
    } else if (event.type === 'assistant/message') {
      const text = assistantMessageText(event.data)
      if (text.length > 0) {
        lines.push(`ASSISTANT: ${text.slice(0, 2500)}`)
      }
    } else if (event.type === 'tool/call') {
      const data = event.data as { name: string; arguments?: string }
      const argsStr = typeof data.arguments === 'string' && data.arguments.length > 0
        ? ` ${data.arguments.slice(0, 600)}`
        : ''
      lines.push(`TOOL CALL: ${data.name}${argsStr}`)

      // Detect documentation and specification files
      if (data.arguments) {
        const matches = data.arguments.match(/["']([^"']*\.(?:md|json|yaml|yml))["']/g)
        if (matches) {
          for (const m of matches) {
            const clean = m.replace(/["']/g, '')
            if (clean.length > 2) docFiles.add(clean)
          }
        }
      }
    } else if (event.type === 'tool/result') {
      const resultText = toolResultText(event.data)
      if (resultText.length > 0) {
        lines.push(`TOOL RESULT: ${resultText.slice(0, 4000)}`)
      }
    }
  }

  const sections: string[] = []
  if (previousProse.length > 0) {
    sections.push(`--- PREVIOUS SESSION BRIEF ---\n${previousProse}`)
  }
  if (docFiles.size > 0) {
    sections.push(`--- RECENT SPECIFICATION & DOCUMENTATION FILES ---\n${Array.from(docFiles).map(f => `• ${f}`).join('\n')}`)
  }
  if (lines.length > 0) {
    sections.push(`--- RECENT SESSION EVENTS & TOOL RESULTS ---\n${lines.join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Best-effort assistant text from an `assistant/message` payload: the current
 * durable form carries `{ turn, step, message }`; a legacy/pre-fork fixture may
 * carry `text` directly.
 */
function assistantMessageText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const record = data as { text?: unknown; message?: { content?: unknown[] } }
  if (typeof record.text === 'string' && record.text.trim().length > 0) return record.text.trim()
  if (!Array.isArray(record.message?.content)) return ''
  const parts: string[] = []
  for (const block of record.message.content) {
    if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text)
    }
  }
  return parts.join('\n').trim()
}

/** Best-effort text extraction from a tool/result event data payload. */
function toolResultText(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as { message?: { content?: unknown[] }; error?: { message?: string } }
  if (d.error?.message) return `Error: ${d.error.message}`
  if (!d.message || !Array.isArray(d.message.content)) return ''
  const parts: string[] = []
  for (const block of d.message.content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block === 'object') {
      const b = block as { text?: string; content?: unknown[]; isError?: boolean }
      if (typeof b.text === 'string') parts.push(b.text)
      if (Array.isArray(b.content)) {
        for (const sub of b.content) {
          if (typeof sub === 'string') parts.push(sub)
          else if (sub && typeof sub === 'object' && typeof (sub as { text?: string }).text === 'string') {
            parts.push((sub as { text: string }).text)
          }
        }
      }
    }
  }
  return parts.filter(Boolean).join(' ').trim()
}

/** Best-effort text extraction from a user message content block. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter((text) => text.length > 0)
      .join(' ')
  }
  return ''
}

/**
 * Extract the first balanced JSON array from `text`, ignoring brackets inside
 * JSON strings and escapes. The non-greedy `\[[\s\S]*?\]` match it replaces
 * stopped at the first `]` even inside a string value (live defect 2026-09-26:
 * a claim containing `[bug]` made both chain links reject valid JSON with
 * "Unterminated string" and the claims pass exhausted the chain).
 * @param text - raw text beginning at/near the array's `[`.
 * @returns the balanced array substring, or null when unclosed.
 */
export function extractClaimsJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null
    }
  }
  return null
}

interface KeeperValidationResult {
  valid: boolean
  reason?: string
  /** Whether the failure is truncation-shaped (cap escalation may recover it). */
  cutLike?: boolean
}

/**
 * Validates that keeper output completed cleanly rather than cutting off mid-stream.
 * Checks authoritative provider finish signals and structural JSON balance without arbitrary length cutoffs.
 */
function validateKeeperOutput(text: string, finishKind?: string, expectClaims = false): KeeperValidationResult {
  // 1. Authoritative provider signal
  if (finishKind === 'max-tokens') {
    return { valid: false, reason: 'Stream truncated by maxOutputTokens limit' }
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { valid: false, reason: 'Empty output received from model' }
  }

  // 1b. Prose passes never accept tool-call echoes / envelopes / markup blobs.
  // Rejecting here (inside executeRoute) throws, so the model chain advances to
  // the next link; the rejected text is never published (fix: live defect
  // 2026-09-19, a freellmapi `<dots_function_call>` echo was accepted as prose).
  if (!expectClaims) {
    const rejection = keeperProseRejection(trimmed)
    if (rejection !== null) {
      return { valid: false, reason: `Rejected keeper prose: ${rejection}` }
    }
  }

  // 2. Case-insensitive CLAIMS structure verification (claims passes only)
  if (expectClaims) {
    const claimsMatch = trimmed.match(/CLAIMS:\s*([\s\S]*)$/i)
    if (claimsMatch) {
      const rawClaims = claimsMatch[1].trim()
      // Explicit empty indicators are valid
      if (/^(none|n\/a|\[\s*\])$/i.test(rawClaims)) {
        return { valid: true }
      }
      // Balanced (string-aware) JSON block extraction — see extractClaimsJsonArray.
      const json = extractClaimsJsonArray(rawClaims)
      if (json === null) {
        return { valid: false, reason: 'CLAIMS tag present but JSON array was truncated/unclosed', cutLike: true }
      }
      try {
        JSON.parse(json)
      } catch (e) {
        return { valid: false, reason: `Malformed CLAIMS JSON: ${String(e)}` }
      }
    }
  }

  return { valid: true }
}

/**
 * Consecutive final failures (any cause: empty landing, timeout, cap, invalid
 * output) before a keeper route link is quarantined. Mirrors the web-search
 * provider's bounded identity quarantine, but keyed on the route the keeper
 * actually selects (`provider/model`): the shared `llm` seam's `poolStatus`
 * reports credential-identity HTTP cooldowns, not per-route semantic health,
 * so the keeper keeps this in process memory (singleton, resets on restart).
 */
export const KEEPER_ROUTE_FAILURE_THRESHOLD = 2

/** In-memory quarantine window after repeated keeper route failures (web-search parity: 5 min). */
export const KEEPER_ROUTE_QUARANTINE_MS = 5 * 60_000

interface KeeperRouteHealth {
  failures: number
  quarantinedUntil: number
}

const keeperRouteHealth = new Map<string, KeeperRouteHealth>()

/** Clear all in-memory route health (tests / operator diagnostics). */
export function resetKeeperRouteHealth(): void {
  keeperRouteHealth.clear()
}

/** Remaining quarantine for one route in ms (0 = healthy / not tripped). */
export function keeperRouteQuarantineRemaining(provider: string, model: string, now = Date.now()): number {
  const entry = keeperRouteHealth.get(`${provider}/${model}`)
  return entry !== undefined && entry.quarantinedUntil > now ? entry.quarantinedUntil - now : 0
}

/**
 * Count one final failure of a route link. The failure streak survives a
 * quarantine expiry (a repeatedly bad route is re-quarantined on its very next
 * failure) and is cleared only by an actual landing success.
 * @returns the updated health row.
 */
function recordKeeperRouteFailure(provider: string, model: string): KeeperRouteHealth {
  const key = `${provider}/${model}`
  const entry = keeperRouteHealth.get(key) ?? { failures: 0, quarantinedUntil: 0 }
  entry.failures += 1
  if (entry.failures >= KEEPER_ROUTE_FAILURE_THRESHOLD) {
    entry.quarantinedUntil = Date.now() + KEEPER_ROUTE_QUARANTINE_MS
  }
  keeperRouteHealth.set(key, entry)
  return entry
}

/** A landed success clears the route's failure streak and quarantine. */
function clearKeeperRouteFailure(provider: string, model: string): void {
  keeperRouteHealth.delete(`${provider}/${model}`)
}

/**
 * Request-shaped failure codes: the payload, not the route, is the problem, so
 * the same call fails identically on every healthy link.
 */
const REQUEST_LEVEL_FAILURE_CODES = new Set([
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'UNSUPPORTED_CONTENT',
  'IMAGE_OFFLOAD_REQUIRED',
  // OpenCode's free-tier client gate: the route is policy-gated server-side
  // ("You cannot use the free tier in other harnesses", anomalyco/opencode#49621),
  // so a strike/quarantine would idle a link no credential can repair. The
  // free link is retired from default chains; this keeps a hand-enabled one
  // from poisoning route health while it explains itself.
  'FREE_TIER_GATED',
])

/**
 * Whether one summarizer failure describes the request rather than the route.
 * A context-overflow 400 (or a media refusal) must never count toward route
 * quarantine — striking every link over one oversized payload would idle the
 * keeper and hide the gateway's own explanation behind a rotation failure.
 * @param error - the caught attempt failure.
 * @returns true for request-shaped codes and context-overflow wording.
 */
/**
 * OpenCode's free-tier client gate as it appears in a provider body
 * (`FreeTierError`, or the policy phrase). Defined here textually so the
 * keeper does not depend on a built `@deepseek-ai/dsh-llm` export version:
 * a link routed through an older adapter may carry no FREE_TIER_GATED code yet.
 */
const FREE_TIER_GATED_RE = /FreeTierError|free tier can only be used/i

export function keeperRouteRequestLevelFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && REQUEST_LEVEL_FAILURE_CODES.has(code)) return true
  const message = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && (isContextWindowExceededError(message) || FREE_TIER_GATED_RE.test(message))
}

/** One LLM completion over the resolved route (primary plus any explicit fallback link; soft-degrading + cutoff shield). */
export async function summarize(
  ctx: Context,
  config: Config,
  session: Session,
  input: string,
  signal: AbortSignal,
  route: ResolvedRoute,
  systemPrompt: string,
  expectClaims: boolean,
): Promise<{ text: string; route: string }> {
  const messages = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: KEEPER_MESSAGE_KIND },
  })]
  const base: GenerateOptions = {
    messages,
    system: systemPrompt,
    maxTokens: config.maxOutputTokens,
    sessionId: session.id,
    purpose: 'context-keeper',
    signal,
  }

  async function executeRoute(provider: string, model: string, maxTokens: number, reasoningEffort?: string): Promise<string> {
    const result = await streamTextWithMeta(ctx, {
      ...base,
      maxTokens,
      provider,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort: reasoningEffort as GenerateOptions['reasoningEffort'] } : {}),
    })
    // validateKeeperOutput stays the cut detector (truncation + unclosed
    // CLAIMS JSON) — an invalid result throws, so the caller advances.
    const validation = validateKeeperOutput(result.text, result.finishKind, expectClaims)
    if (!validation.valid) {
      const error = new Error(`Output invalid/truncated on ${provider}/${model}: ${validation.reason}`) as Error & { code?: string }
      // A structurally truncated claims block is cut-shaped: earn the same
      // one-shot escalated-cap retry as a provider max-tokens finish.
      if (validation.cutLike === true) error.code = MAX_TOKENS_CUT_CODE
      throw error
    }
    // An empty landing after prose cleaning is still a dead route (live defect
    // 2026-09-26: a degraded route emitting only negative-filler sections
    // landed 0 chars and negative-cached without ever trying the next link).
    if (!expectClaims && cleanKeeperProse(result.text).length === 0) {
      const reason = keeperProseRejection(result.text)
        ?? keeperBriefShapeRejection(result.text)
        ?? 'empty output after keeper cleaning'
      throw new Error(`Output invalid/truncated on ${provider}/${model}: ${reason}`)
    }
    return result.text
  }

  // Frozen attempt list: chain links when the keeper persona assigned a chain,
  // else primary → fallback. Never re-read between attempts. Links inside
  // their bounded quarantine window are skipped; fail-open if every link is
  // quarantined (a transient quarantine must never wedge the keeper).
  const allAttempts = keeperAttempts(route)
  const enabledAttempts = allAttempts.filter(
    attempt => keeperRouteQuarantineRemaining(attempt.provider, attempt.model) === 0,
  )
  const attempts = enabledAttempts.length > 0 ? enabledAttempts : allAttempts
  if (enabledAttempts.length > 0 && attempts.length < allAttempts.length) {
    const skipped = allAttempts
      .filter(attempt => keeperRouteQuarantineRemaining(attempt.provider, attempt.model) > 0)
      .map(attempt => `${attempt.provider}/${attempt.model}`)
    process.stderr.write(`[model-chain] ${route.chainId ?? 'keeper'}: skipping quarantined link(s): ${skipped.join(', ')}\n`)
  }
  const configuredCap = config.maxOutputTokens ?? 2048
  // One same-link retry at the doc-38 ceiling when a summary is cut by the
  // configured output cap. A long brief overflowing 2048 output tokens used to
  // kill every link in turn (both cuts, then `all summary routes failed`), so
  // the Living Brief went stale on exactly the sessions that needed it most.
  const escalatedCap = Math.min(configuredCap * 2, KEEPER_MAX_OUTPUT_TOKENS)
  let lastError: unknown
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!
    let failure: unknown
    try {
      const text = await executeRoute(attempt.provider, attempt.model, configuredCap, attempt.reasoningEffort)
      clearKeeperRouteFailure(attempt.provider, attempt.model)
      if (index > 0) {
        process.stderr.write(`[model-chain] ${route.chainId ?? 'keeper'}: recovered on link ${index + 1} (${attempt.provider}/${attempt.model})\n`)
      }
      return { text, route: `${attempt.provider}/${attempt.model}` }
    } catch (error) {
      failure = error
      if (!signal.aborted && isMaxTokensCut(error) && escalatedCap > configuredCap) {
        try {
          const text = await executeRoute(attempt.provider, attempt.model, escalatedCap, attempt.reasoningEffort)
          clearKeeperRouteFailure(attempt.provider, attempt.model)
          process.stderr.write(
            `[model-chain] ${route.chainId ?? 'keeper'}: link ${index + 1} (${attempt.provider}/${attempt.model})`
            + ` hit maxOutputTokens at ${configuredCap}; retried at ${escalatedCap} and recovered\n`,
          )
          return { text, route: `${attempt.provider}/${attempt.model}` }
        } catch (escalationError) {
          failure = escalationError
        }
      }
    }
    if (signal.aborted) throw failure
    // Empty/timeout/cut/invalid landings are route failures: one strike per
    // summary attempt; a link at the threshold is quarantined for a bounded
    // window so the next wake goes straight to the next enabled link.
    // Request-level refusals never strike route health: another link may fit
    // where this one did not, and the explanation stays the gateway's own.
    if (keeperRouteRequestLevelFailure(failure)) {
      const message = failure instanceof Error ? failure.message : String(failure)
      process.stderr.write(
        `[model-chain] ${route.chainId ?? 'keeper'}: link ${index + 1} (${attempt.provider}/${attempt.model})`
        + ` rejected the request (no route strike): ${message}\n`,
      )
    } else {
      const health = recordKeeperRouteFailure(attempt.provider, attempt.model)
      if (health.quarantinedUntil > Date.now()) {
        const until = new Date(health.quarantinedUntil).toISOString()
        process.stderr.write(
          `[model-chain] ${route.chainId ?? 'keeper'}: route ${attempt.provider}/${attempt.model}`
          + ` quarantined until ${until} (${health.failures} consecutive failures)\n`,
        )
        diag(`route ${attempt.provider}/${attempt.model} quarantined until ${until} (${health.failures} consecutive failures)`)
      }
    }
    lastError = failure
    const next = attempts[index + 1]
    if (next === undefined) break
    const message = failure instanceof Error ? failure.message : String(failure)
    // One stderr audit line per failover (this harness's logger drops
    // info/warn, so stderr is the observable channel — doc 60).
    process.stderr.write(`[model-chain] ${route.chainId ?? 'keeper'}: link ${index + 1} (${attempt.provider}/${attempt.model}) FAILED/CUT → link ${index + 2} (${next.provider}/${next.model}): ${message}\n`)
    ctx.logger.warn(`enpoi-context-keeper: route ${attempt.provider}/${attempt.model} failed/cut off (${message}), advancing to ${next.provider}/${next.model}`)
    diag(`route ${attempt.provider}/${attempt.model} failed/cut off (${message}), advancing to ${next.provider}/${next.model}`)
  }
  throw new Error(`enpoi-context-keeper: all summary routes failed (${attempts.length} attempt(s)). Last: ${String(lastError)}`)
}

/** Provider finish code marking a summary cut by its output cap (retryable at a higher cap). */
const MAX_TOKENS_CUT_CODE = 'MAX_TOKENS_CUT'

/** Whether a failed keeper attempt was cut by the output cap rather than by the route. */
function isMaxTokensCut(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === MAX_TOKENS_CUT_CODE
}

/** Stream one completion into plain text and terminal metadata via BlockAssembler. */
async function streamTextWithMeta(ctx: Context, options: GenerateOptions): Promise<{ text: string; finishKind: string }> {
  using callDeadline = deadline(options.signal, 40_000, 'ENPOI_KEEPER_STREAM_TIMEOUT')
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ ...options, signal: callDeadline.signal })) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()
  return { text, finishKind: assembler.finish.kind }
}

/** Translate terminal finish reasons into an auxiliary-call failure (ported from session-title-llm). */
function finishError(finish: { kind: string; failure?: { message: string; code: string } }): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const failure = finish.failure ?? { message: 'unknown failure', code: 'UNKNOWN' }
      const error = new Error(failure.message) as Error & { code?: string }
      error.code = failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('enpoi-context-keeper: summary output reached maxOutputTokens') as Error & { code?: string }
      error.code = MAX_TOKENS_CUT_CODE
      return error
    }
    case 'tool-calls':
      return new Error('enpoi-context-keeper: summarizer unexpectedly requested a tool')
    default:
      return undefined
  }
}