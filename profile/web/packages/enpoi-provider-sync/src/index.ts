/**
 * Enpoi Harness provider-catalog sync.
 *
 * Refreshes each `llm-pi-ai` provider route's model list from the provider's
 * listing endpoint at the route's own wire protocol (`GET {baseURL}/models`
 * for the OpenAI protocols, `GET {root}/v1/models` for Anthropic Messages) and
 * enriches each entry from a route's declared exact registry metadata, the
 * `models.dev` catalog, and the installed pi-ai catalog. The Command Code
 * namespace is covered from the provider package's bundled catalog snapshot:
 * its vendor serves no model listing, so the sync merges the snapshot instead
 * of probing a nonexistent endpoint.
 *
 * Features:
 * - 100% Dynamic Discovery from live provider endpoints.
 * - Exact registry metadata for declared routes, owner/channel-scoped from the
 *   sanitized proxy registry; routes without a declaration never read it.
 * - Authoritative metadata from models.dev (193+ providers, 10,000+ models).
 * - Exact context windows (e.g. 1M for GLM-5.2, 1M for MiniMax-M3, 1.05M for Luna).
 * - Exact max output token limits.
 * - Exact modalities (text, image, audio, video, pdf).
 * - Exact reasoning options & effort ladders: a ladder the endpoint's own
 *   capability block advertises (with its image/pdf input support) is read by
 *   the shared llm-pi-ai listing parser and wins over catalog inference, so a
 *   refresh keeps what Add wrote; a `source: 'manual'` entry keeps the ladder
 *   its operator declared.
 * - Tool-calling and price metadata (models.dev `tool_call` / `cost`) consumed
 *   by the dynamic catalogue rules (dsh-enpoi-catalog-rules predicates).
 * - Live hot-swap into runtime memory without restarting the server.
 * - Authoritative membership, per route: an endpoint-authority route (one the
 *   installed catalog does not describe) converges to exactly the ids its own
 *   listing advertises whenever that listing fetched, so ids the provider
 *   retired are removed without waiting on the models.dev cache. A
 *   catalog-authority route converges to the endpoint-advertised models the
 *   fresh catalog confirms and needs both sources fresh. Hand-added
 *   (`source: 'manual'`), pinned (`pinnedModels`), overlay-`upsert`, recently
 *   first-seen endpoint-only, and referenced models survive; the shrink guards
 *   protect the unattended pass, and a manual refresh forces past the >half
 *   guard. A route profile that explicitly declares
 *   `catalogAuthority: 'endpoint'` may record a successful empty listing as
 *   `models: []`, which the catalog layer reports as `knownEmpty` instead of
 *   refilling from the installed catalog. Registry metadata never grants that
 *   authority.
 * - Provider isolation: a route's models.dev metadata resolves only within its
 *   own mapped provider keys, and its installed-catalog metadata only from its
 *   own pi-ai provider keys — an id collision can never inherit another
 *   vendor's metadata, and a route can never grow ids another route's endpoint
 *   advertised.
 *
 * @module dsh-enpoi-provider-sync
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SettingsConflictError, SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { readSettingsDocument, ORCHESTRATION_NAMESPACE } from 'dsh-enpoi-contracts'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { Model, Api } from '@earendil-works/pi-ai'
// Public listing reader: sync, Add, and discovery share one capability parser.
import {
  Config as PiAiConfig,
  listingCapabilities,
  listingText,
  readModelListing,
} from '@deepseek-ai/dsh-llm-pi-ai'
import type { ListingModel } from '@deepseek-ai/dsh-llm-pi-ai'
import * as piAiRoot from '@deepseek-ai/dsh-llm-pi-ai'
// The one authority for which reasoning levels a profile may declare. A
// ladder is only copied from what a source supplied; the sync never extends
// it, and unknown identifiers are dropped before they can reach settings.
import {
  CANONICAL_EFFORT_KEYS,
  OWNER_CHANNEL_ALIASES,
  createRegistryMetadataSource,
  loadBundledRegistryMetadataIndex,
  resolveRegistryModel,
  type RegistryMetadataIndex,
  type RegistryMetadataSource,
  type RegistryMetadataSourceState,
  type RegistryResolvedModel,
} from './registry-metadata.ts'
import {
  claimCapabilityHints,
  loadCapabilityHints,
  parseCapabilityHintsOverride,
  type CapabilityHintClaim,
  type CapabilityHints,
  type CapabilityHintsOverrideDocument,
} from './capability-hints.ts'

/**
 * The package-root `THINKING_LEVELS` export exists in source but is not yet in
 * the shipped `llm-pi-ai` build/types this profile links. Read it from the
 * root module at runtime and use the hardened registry canonical list as the
 * temporary same-vocabulary fallback; the named root import is the target.
 */
const rootThinkingLevels: unknown = Reflect.get(piAiRoot, 'THINKING_LEVELS')
const THINKING_LEVELS: readonly string[] = Array.isArray(rootThinkingLevels)
  ? rootThinkingLevels.filter((level): level is string => typeof level === 'string')
  : CANONICAL_EFFORT_KEYS

export const name = 'enpoi-provider-sync'

/** Optional-only seam reads: every capability is probed via `ctx.get`. */
export const inject: string[] = []

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Read one effective Config field (Volatile ref on 0.1.7+, plain value before it). */
function value<T>(field: T | Volatile<T>): T {
  return typeof (field as Volatile<T> | undefined)?.get === 'function'
    ? (field as Volatile<T>).get() as T
    : field as T
}

/**
 * Legacy route-level capacity assumption. The shipped profile declares none:
 * an operator who sets `capacityDefaults` is stating an explicit assumption
 * for routes whose endpoint discloses nothing, not a per-model fact. The sync
 * accepts the key for backward compatibility but never writes these values
 * into settings or the discovered cache; the route's own
 * `defaultContextWindow` / `defaultMaxTokens` resolves them at request time
 * with `source: 'default'`.
 */
export interface RouteCapacity {
  prefixes?: Record<string, { contextWindow?: number; maxTokens?: number }>
  default?: { contextWindow?: number; maxTokens?: number }
}

/** The authoritative models.dev catalogue URL; the `modelsDevUrl` config may point at a mirror. */
export const DEFAULT_MODELS_DEV_URL = 'https://models.dev/api.json'

/** How long an endpoint-only model survives before pruning while models.dev has not indexed it yet; the `endpointGraceMs` config overrides it. */
export const ENDPOINT_ONLY_GRACE_MS = 14 * 24 * 60 * 60 * 1000

/** Freshness window for the on-disk models.dev cache when the online refresh fails; the `catalogFreshMs` config overrides it. */
export const CATALOG_FRESH_MS = 48 * 60 * 60 * 1000

/**
 * One route's declaration that its model metadata comes from a registry
 * source in addition to the endpoint listing. The declaration is enrichment
 * only: it never changes membership, empty-listing authority, or
 * `catalogAuthority`. The route profile owns endpoint authority explicitly.
 */
export interface RouteMetadataSourceConfig {
  /** Registry family. `cliproxyapi` reads the sanitized proxy registry schema. */
  source: 'cliproxyapi'
  /** Exact registry channel, when the route knows it; otherwise owner aliases resolve it. */
  channel?: string
  /** Exact registry owner namespace; overrides the listing's `owned_by` for lookup. */
  owner?: string
  /** Extra owner → channel aliases, merged over the shipped explicit table. */
  ownerChannels?: Record<string, string[]>
  /**
   * Raw registry document URL for background metadata refresh. Declaring it
   * opts this route in; omission keeps the pinned bundled baseline and performs
   * no network read. `sourceVersion` is required alongside it.
   */
  refreshUrl?: string
  /** Actual source label/version for the refreshed document; required with `refreshUrl`. */
  sourceVersion?: string
  /** Set false to keep the configured URL for provenance but skip refreshing it. */
  refresh?: boolean
}

/**
 * The shipped route declarations. Keying by route id is data, not inference:
 * an operator who renames the route adds the same declaration under the new
 * key. The baseline snapshot is always available; an explicit `refreshUrl` is
 * the opt-in for a live upstream refresh.
 */
export const DEFAULT_ROUTE_METADATA_SOURCES: Readonly<Record<string, RouteMetadataSourceConfig>> = {
  cliproxyapi: { source: 'cliproxyapi' },
}

/** Live-editable sync schedule and enrichment configuration. */
export interface Config {
  /** Refresh cadence in milliseconds; hourly by default, matching the shipped profile. */
  intervalMs: Volatile<number>
  /** Run one pass shortly after boot. */
  syncOnStart: Volatile<boolean>
  /** Delay before the boot pass. */
  syncDelayMs: Volatile<number>
  /** Known endpoints for routes whose profile leaves baseURL to the catalog default. */
  endpoints: Volatile<Record<string, string>>
  /**
   * Legacy route-level capacity assumption, accepted for backward
   * compatibility. Non-empty values are never persisted as per-model
   * disclosures; the route resolves its own labeled defaults instead.
   */
  capacityDefaults: Volatile<Record<string, RouteCapacity>>
  /**
   * Route → routing-affinity header name a configured route requires (for
   * example `opencode-go: x-opencode-session`). The plugin enforces the header
   * on every configured route in the map, so a live provider block that
   * predates the requirement converges on the next pass without a manual edit.
   */
  sessionHeaders: Volatile<Record<string, string>>
  /** models.dev catalogue URL; a deployment may point it at a mirror. */
  modelsDevUrl: Volatile<string>
  /**
   * Route → models.dev provider keys, merged over {@link DEFAULT_ROUTE_PROVIDER_MAP}
   * per key. Mapping a route this deployment serves does not require a code change.
   */
  routeProviderMap: Volatile<Record<string, string[]>>
  /**
   * Route → model ids this deployment pins against catalog-driven removal. A
   * pinned id survives every refresh even when neither the endpoint nor
   * models.dev advertises it, like an overlay `upsert` but without a record.
   * An empty map is the shipped default: nothing is pinned.
   */
  pinnedModels: Volatile<Record<string, string[]>>
  /**
   * How long an endpoint-only model (advertised by the listing but not yet
   * indexed by models.dev) survives before pruning; live Config, shipped
   * default {@link ENDPOINT_ONLY_GRACE_MS}.
   */
  endpointGraceMs: Volatile<number>
  /**
   * Freshness window for the on-disk models.dev cache when the online refresh
   * fails; live Config, shipped default {@link CATALOG_FRESH_MS}.
   */
  catalogFreshMs: Volatile<number>
  /**
   * Route → registry metadata declaration. A declared route resolves exact
   * capability metadata from the sanitized registry after the endpoint's own
   * disclosure; routes absent here never read registry metadata.
   */
  metadataSources: Volatile<Record<string, RouteMetadataSourceConfig>>
}

export const Config = Schema.object({
  intervalMs: live(Schema.number().default(3_600_000)),
  syncOnStart: live(Schema.boolean().default(true)),
  syncDelayMs: live(Schema.number().default(2000)),
  endpoints: live(Schema.dict(String).default({})),
  capacityDefaults: live(Schema.any().default({})),
  sessionHeaders: live(Schema.dict(String).default({})),
  modelsDevUrl: live(Schema.string().default(DEFAULT_MODELS_DEV_URL)),
  routeProviderMap: live(Schema.dict(Schema.array(String)).default({})),
  pinnedModels: live(Schema.dict(Schema.array(String)).default({})),
  endpointGraceMs: live(Schema.number().default(ENDPOINT_ONLY_GRACE_MS)),
  catalogFreshMs: live(Schema.number().default(CATALOG_FRESH_MS)),
  metadataSources: live(Schema.dict(Schema.object({
    source: Schema.union(['cliproxyapi']).required(),
    channel: Schema.string(),
    owner: Schema.string(),
    ownerChannels: Schema.dict(Schema.array(String)),
    refreshUrl: Schema.string(),
    sourceVersion: Schema.string(),
    refresh: Schema.boolean(),
  })).default(DEFAULT_ROUTE_METADATA_SOURCES)),
})

/** One request-modality token a listing or catalog may disclose. */
export type LiveModality = 'text' | 'image' | 'audio' | 'video' | 'pdf'

/** One request-wide price tier above an input-token threshold, normalized from models.dev. */
export interface LiveCostTier {
  /** Input tokens above which this tier prices the whole request. */
  inputTokensAbove: number
  /** Tier input price per million tokens, when disclosed. */
  input?: number
  /** Tier output price per million tokens, when disclosed. */
  output?: number
}

/** One entry from a provider's OpenAI-style `GET /models` listing. */
interface LiveModel {
  id: string
  name?: string
  contextWindow?: number
  /** Input-only token cap the endpoint stated separately from the combined window. */
  maxInputTokens?: number
  maxTokens?: number
  /**
   * Endpoint `owned_by` namespace, used only to scope a registry metadata
   * lookup. It is membership provenance, never a model-id prefix rule.
   */
  owner?: string
  /**
   * Modalities the listing itself disclosed — its modality fields or the
   * capability block's image/pdf support; `undefined` means it said nothing.
   */
  input?: Array<LiveModality>
  /** Whether the listing advertised tool calling; `undefined` means undisclosed. */
  tools?: boolean
  /** Whether the listing advertised reasoning; `undefined` means undisclosed. */
  reasoning?: boolean
  /**
   * Selectable reasoning levels (picker id → wire value) the listing's
   * capability block advertised. Absent means the endpoint said nothing; an
   * empty object is an explicit empty ladder, which blocks inference.
   */
  reasoningEfforts?: Readonly<Record<string, string>>
  /** Advertised effort names no configured profile accepts; diagnostics only. */
  unsupportedReasoningEfforts?: readonly string[]
  /** The listing's own price fields, verbatim. */
  pricing?: Record<string, string>
  /** Whether the listing's directory marked the model free. */
  isFree?: boolean
  /**
   * Whether the listing marked the model sign-in/paid-only (`isFree: false`).
   * Aligns with the catalogue rules engine's `gated` predicate: a gated entry
   * is dimmed by the picker with {@link gateReason} and can be excluded by a
   * `gated: true|false` rule clause.
   */
  gated?: boolean
  /** Why the model is gated, when it is; absent otherwise. */
  gateReason?: string
}

/** One route's registry metadata lookup context; absent means the route declared none. */
export interface RegistryMetadataContext {
  /** Parsed registry snapshot or refreshed document index. */
  index: RegistryMetadataIndex
  /** Exact registry channel, when the route declaration names one. */
  channel?: string
  /** Exact owner namespace that overrides the endpoint listing's `owned_by`. */
  owner?: string
  /** Route-specific owner → channel aliases, merged over the shipped table. */
  ownerChannels?: Readonly<Record<string, readonly string[]>>
}

/** The gate reason the listing's own `isFree: false` verdict earns. */
const SIGN_IN_REQUIRED = 'sign-in required'

/**
 * Picker-facing reason stamped on a route whose profile sets
 * `freeTierGated` without naming its own. It describes the policy, not a
 * provider: no provider name reaches code through this path.
 */
export const DEFAULT_FREE_TIER_GATE_REASON = "free tier is gated to the provider's own clients"

/** One route's durable free-tier gate, resolved from its provider profile. */
export interface FreeTierGate {
  /** Picker-facing reason stamped on every zero-priced model. */
  reason: string
}

/**
 * Resolve the gate a route's profile declares, or `undefined` when it declares
 * none.
 * @param profile - the route's configured profile, when one exists.
 * @returns the gate with its effective reason, or undefined.
 */
export function freeTierGateOf(profile: ProviderProfile | undefined): FreeTierGate | undefined {
  if (profile?.freeTierGated !== true) return undefined
  const configured = profile.freeTierGateReason
  return { reason: typeof configured === 'string' && configured !== '' ? configured : DEFAULT_FREE_TIER_GATE_REASON }
}

/** Whether one record's disclosed price is known and entirely zero. */
function isKnownZeroPrice(entry: Record<string, unknown>): boolean {
  const cost = entry.cost
  if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) return false
  const prices = cost as Record<string, unknown>
  const values = [prices.input, prices.output]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 && values.every(value => value === 0)
}

/**
 * Stamp the route's durable gate onto every zero-priced settings record. A
 * record with no disclosed price stays untouched (absent is "unknown", never
 * a free claim), and a paid record keeps whatever gate the listing gave it.
 * With no gate configured the list is returned unchanged, so a route that
 * does not declare one writes byte-identical records.
 * @param models - the route's planned settings records.
 * @param gate - the gate its profile declares, when any.
 * @returns the records to persist.
 */
export function applyFreeTierGate<T extends Record<string, unknown>>(
  models: readonly T[],
  gate: FreeTierGate | undefined,
): T[] {
  if (gate === undefined) return [...models]
  return models.map((model) => {
    if (!isKnownZeroPrice(model)) return model
    const listed = model.gateReason
    return {
      ...model,
      gated: true,
      gateReason: typeof listed === 'string' && listed !== '' ? listed : gate.reason,
    }
  })
}

/** The llm-pi-ai namespace (branded through the settings seam). */
const LLM_NS = 'llm-pi-ai'

/** The default-model selection's Config namespace (the `agent-default-model` profile entry). */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** The Host setting that authorizes exact subagent routes (its profile entry id). */
const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** Both readable spellings of the subagent route list; the Host entry id is authoritative. */
const SUBAGENT_MODEL_SELECTION_NAMESPACES: readonly string[] = [SUBAGENT_MODEL_SELECTION_NS, 'subagent-model-selection']

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

interface SettingsSeam {
  /** Pre-0.1.7 seam: one registered namespace's resolved value. */
  get?: (ns: string) => unknown
  /** 0.1.7+ seam: one descriptor per configurable entry, carrying the projected value. */
  describe(): Array<{ ns: SettingsNamespace; revision: number; value?: unknown }>
  mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
}

interface ProviderProfile {
  baseURL?: string
  /** The route's wire protocol (`anthropic-messages`, an openai-* api, …), when configured. */
  api?: string
  apiKeyEnv?: string
  /** Anonymous route: its listing is fetched without any credential, like its requests. */
  keyless?: boolean
  /**
   * Route-level declaration that its zero-priced models are gated to the
   * provider's own clients. The listing (and therefore every per-model
   * `gated` marking) is rewritten each pass, so this profile field is what
   * survives; the sync stamps every zero-priced record it writes.
   */
  freeTierGated?: boolean
  /** Picker-facing reason stamped beside the gate; the sync default fills an omitted one. */
  freeTierGateReason?: string
  /** Which source may fill an unconfigured/empty model list; registry routes set `endpoint`. */
  catalogAuthority?: 'catalog' | 'endpoint'
  /** Installed-catalog overrides; incompatible with endpoint catalog authority. */
  modelOverrides?: Record<string, unknown>
  models?: Array<Record<string, unknown>>
  pool?: {
    strategy?: string
    identities?: Array<{ id: string, credentialRef: string, priority?: number, enabled?: boolean }>
  }
}

/**
 * Enforce routing-affinity headers on configured routes. Idempotent: a route
 * whose header already matches is skipped, a route that is not configured is
 * never created, and a concurrent settings edit is retried like the model
 * writes. The value is the header NAME (the adapter sends the session id as
 * its value), so no per-device state is written.
 * @param settings - the settings seam.
 * @param wanted - route → required header name.
 * @param log - optional line logger (the plugin's info channel).
 * @returns the routes whose header this call wrote.
 */
export async function enforceSessionHeaders(
  settings: SettingsSeam,
  wanted: Record<string, string>,
  log?: (message: string) => void,
): Promise<string[]> {
  const written: string[] = []
  for (const [route, header] of Object.entries(wanted)) {
    if (header === '') continue
    const profile = sectionOf(settings, LLM_NS)?.providers?.[route] as { sessionHeader?: string } | undefined
    if (profile === undefined || profile.sessionHeader === header) continue
    for (let attempt = 0; ; attempt++) {
      try {
        await settings.mutate(
          LLM_NS as SettingsNamespace,
          [{ op: 'set', path: ['providers', route, 'sessionHeader'], value: header }],
          revisionOf(settings, LLM_NS),
        )
        written.push(route)
        log?.(`route ${route}: session header enforced (${header})`)
        break
      } catch (error) {
        const conflict = error as Partial<SettingsConflictError>
        if (conflict?.code !== 'SETTINGS_CONFLICT' || attempt >= 2) {
          log?.(`route ${route}: could not write the session header (${header}): ${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    }
  }
  return written
}

function sectionOf(settings: SettingsSeam, ns: string): { providers?: Record<string, ProviderProfile> } | undefined {
  const section = readSettingsDocument(settings, ns) as { providers?: Record<string, ProviderProfile> } | undefined
  if (section === null || typeof section !== 'object') return undefined
  return section
}

/** The namespace's current revision, from the settings descriptors. */
function revisionOf(settings: SettingsSeam, ns: string): number | undefined {
  return settings.describe().find(entry => entry.ns === ns)?.revision
}

/** Models.dev schema definitions. */
interface ModelsDevModel {
  id?: string
  name?: string
  description?: string
  family?: string
  attachment?: boolean
  reasoning?: boolean
  reasoning_options?: Array<{ type?: string; values?: string[] }>
  tool_call?: boolean
  structured_output?: boolean
  /** ISO `YYYY-MM-DD` release date models.dev publishes. */
  release_date?: string
  /** USD per million tokens, as models.dev publishes it. */
  cost?: {
    input?: number
    output?: number
    /** Request-wide price tiers above an input-token threshold. */
    tiers?: Array<{
      input?: number
      output?: number
      tier?: { type?: string, size?: number }
    }>
    /** Pricing above a 200K-token context, which models.dev publishes beside the base cost. */
    context_over_200k?: { input?: number, output?: number }
  }
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
  contextWindow?: number
  maxTokens?: number
}

interface ModelsDevProvider {
  id?: string
  name?: string
  models?: Record<string, ModelsDevModel>
}

type ModelsDevDatabase = Record<string, ModelsDevProvider>

let modelsDevCache: ModelsDevDatabase | undefined

/** Distinguishes concurrent models.dev temp names that share a millisecond. */
let modelsDevTmpSeq = 0

/** First non-empty string; `undefined` when every candidate is absent or empty. */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value
  }
  return undefined
}

/**
 * The OS user-cache directory: `$XDG_CACHE_HOME` when set, else `~/.cache` on
 * Linux, `~/Library/Caches` on macOS, and `%LOCALAPPDATA%` on Windows.
 * `undefined` when no home or cache root can be resolved — callers then skip
 * the on-disk cache instead of guessing a user path.
 * @param env - environment to read (tests inject one).
 * @param platform - OS key to branch on (tests inject one).
 * @returns the cache root, or undefined when unresolvable.
 */
export function osCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const xdg = firstNonEmpty(env.XDG_CACHE_HOME)
  if (xdg !== undefined) return xdg
  if (platform === 'win32') return firstNonEmpty(env.LOCALAPPDATA)
  const home = firstNonEmpty(env.HOME, homedir())
  if (home === undefined) return undefined
  return platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache')
}

/**
 * OpenCode's shared models.dev cache, keeping the `opencode/models.json`
 * layout inside {@link osCacheDir} (`%LOCALAPPDATA%\opencode\models.json` on
 * Windows, `~/Library/Caches/opencode/models.json` on macOS,
 * `$XDG_CACHE_HOME/opencode/models.json` or `~/.cache/opencode/models.json` on
 * Linux). `DSH_MODELS_DEV_PATH` overrides the whole path for a deployment
 * whose catalogue cache is not the OS one. `undefined` when no cache dir
 * resolves: the online refresh and the in-memory copy then serve alone, and no
 * guessed path is ever written.
 * @param env - environment to read (tests inject one).
 * @param platform - OS key to branch on (tests inject one).
 * @returns the cache file path, or undefined when unresolvable.
 */
export function modelsDevCachePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const override = firstNonEmpty(env.DSH_MODELS_DEV_PATH)
  if (override !== undefined) return override
  const base = osCacheDir(env, platform)
  return base === undefined ? undefined : join(base, 'opencode', 'models.json')
}

function loadModelsDev(): ModelsDevDatabase {
  if (modelsDevCache !== undefined) return modelsDevCache
  const path = modelsDevCachePath()
  try {
    if (path !== undefined && existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      modelsDevCache = JSON.parse(raw) as ModelsDevDatabase
      return modelsDevCache
    }
  } catch {
    // ignore read error
  }
  return {}
}

/** Coded-diagnostics sink; the plugin wires it to the `diagnostics` service. */
export type SyncDiagnosticSink = (kind: string, message: string) => void

/**
 * Refresh the models.dev catalogue from the network. Fail-open by contract —
 * the local cache and the in-memory copy keep serving — but every failure is
 * reported through the sink with a coded message and a plain sentence, so a
 * stale or missing cache is visible instead of swallowed.
 * @param report - optional diagnostics sink.
 * @param url - the catalogue URL; defaults to {@link DEFAULT_MODELS_DEV_URL}.
 * @returns whether the online refresh landed; `false` leaves the local cache
 *   and the in-memory copy serving (the removal gate then falls back to the
 *   cache's own age).
 */
export async function refreshModelsDevOnline(report?: SyncDiagnosticSink, url: string = DEFAULT_MODELS_DEV_URL): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      report?.('provider-sync/models-dev-fetch', `models.dev refresh failed — GET ${url} -> HTTP ${String(res.status)}; local cache kept`)
      return false
    }
    const data = (await res.json()) as ModelsDevDatabase
    if (!data || typeof data !== 'object' || Object.keys(data).length <= 50) {
      report?.('provider-sync/models-dev-fetch', 'models.dev refresh ignored — response did not look like the catalogue (>50 providers); local cache kept')
      return false
    }
    modelsDevCache = data
    // Persist the fresh catalog to the shared cache so OpenCode and every
    // restart read current metadata even when OpenCode itself is idle.
    const path = modelsDevCachePath()
    try {
      if (path === undefined) {
        report?.('provider-sync/models-dev-cache', 'models.dev catalogue refreshed in memory, but no OS cache dir resolved — not persisted')
        return true
      }
      mkdirSync(dirname(path), { recursive: true })
      // Atomic replace: a reader (or a crash) never observes a half-written
      // catalogue, and a failed write leaves no temp file behind.
      const temporary = `${path}.tmp-${String(process.pid)}-${String(Date.now())}-${String(modelsDevTmpSeq++)}`
      try {
        writeFileSync(temporary, JSON.stringify(data), 'utf8')
        renameSync(temporary, path)
      } catch (error) {
        try {
          rmSync(temporary, { force: true })
        } catch {
          // A failed temp cleanup must not mask the cache-write failure
          // reported below.
        }
        throw error
      }
    } catch (error) {
      report?.('provider-sync/models-dev-cache', `models.dev catalogue refreshed in memory, but the cache write failed — ${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  } catch (error) {
    report?.('provider-sync/models-dev-fetch', `models.dev refresh failed — ${error instanceof Error ? error.message : String(error)}; local cache kept`)
    return false
  }
}

/**
 * Age of the on-disk models.dev cache at `now`, or `undefined` when no path
 * resolves or the file is absent. Read-only: nothing is refreshed here.
 * @param now - the epoch milliseconds to measure against.
 * @param env - environment to read (tests inject one).
 * @param platform - OS key to branch on (tests inject one).
 * @returns the cache age in milliseconds, or undefined when unknown.
 */
export function catalogCacheAgeMs(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  const path = modelsDevCachePath(env, platform)
  if (path === undefined) return undefined
  try {
    return Math.max(0, now - statSync(path).mtimeMs)
  } catch {
    return undefined
  }
}

/** Route → models.dev provider keys, most specific first. */
export type RouteProviderMap = Record<string, readonly string[]>

/**
 * Shipped route mapping to models.dev provider keys. The configured
 * `routeProviderMap` merges over these keys, so a route this table does not
 * carry can be mapped without a code change; a route no table carries resolves
 * against its own key alone.
 */
export const DEFAULT_ROUTE_PROVIDER_MAP: RouteProviderMap = Object.freeze({
  'opencode-go': ['opencode-go', 'opencode'],
  'opencode': ['opencode', 'opencode-go'],
  'antigravity': ['google', 'anthropic'],
  'minimax': ['minimax', 'minimax-cn-coding-plan'],
  'deepseek': ['deepseek'],
  'deepseek-official': ['deepseek'],
  'openrouter': ['openrouter'],
  'huggingface': ['huggingface'],
})

/**
 * Resolve a model from models.dev within the route's own provider namespace.
 *
 * Only the providers the route declares are consulted: the mapped keys when
 * the route map names the route, its own key alone otherwise. There is no
 * cross-provider fallback — an id that no declared provider carries is
 * resolved by no one, so a route can never inherit another vendor's metadata
 * through an id collision. Callers disclose nothing for it instead.
 * @param route - the provider route key.
 * @param modelId - the endpoint-advertised model id.
 * @param routeProviderMap - the effective route → models.dev provider keys.
 * @returns the mapped provider's record, or `undefined` when none carries it.
 */
function resolveFromModelsDev(
  route: string,
  modelId: string,
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
): ModelsDevModel | undefined {
  const db = loadModelsDev()
  const candidateProviders = routeProviderMap[route] ?? [route]

  // Exact key only: a suffix, family prefix, or case-folded spelling is a
  // different id, and borrowing another row's facts is a guess. A deployment
  // that needs an alias declares it as exact data (an overlay upsert).
  const find = (pModels: Record<string, unknown> | undefined): ModelsDevModel | undefined => {
    if (!pModels) return undefined
    const hit = pModels[modelId] as ModelsDevModel | undefined
    return hit
  }

  // The route's declared providers are the only namespace consulted; there is
  // deliberately no global scan, so an id collision cannot lend this route a
  // foreign vendor's metadata.
  for (const p of candidateProviders) {
    const hit = find(db[p]?.models)
    if (hit) return hit
  }

  return undefined
}

/** Per-route installed-catalog indexes, keyed by the exact provider-key set consulted. */
const routeCatalogIndexes = new Map<string, Map<string, Model<Api>>>()

/**
 * The installed pi-ai catalog index for one route: the models of the route's
 * own pi-ai provider id plus the provider ids its route map declares, and
 * nothing else. A route therefore never inherits another vendor's catalog
 * metadata through an id collision; a route pi-ai does not describe and whose
 * map names no pi-ai provider has no catalog answer at all.
 * @param route - the provider route key.
 * @param routeProviderMap - the effective route → models.dev provider keys.
 * @returns the exact-id index of the route's own providers.
 */
function catalogIndexForRoute(route: string, routeProviderMap: RouteProviderMap): Map<string, Model<Api>> {
  const providerKeys = [...new Set([route, ...(routeProviderMap[route] ?? [])])]
  const cacheKey = providerKeys.join('\u0000')
  const cached = routeCatalogIndexes.get(cacheKey)
  if (cached !== undefined) return cached
  const index = new Map<string, Model<Api>>()
  for (const provider of providerKeys) {
    let models: readonly Model<Api>[]
    try {
      models = getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0])
    } catch {
      // A provider key pi-ai does not know contributes nothing.
      continue
    }
    for (const m of models) {
      // Exact ids only: a vendor-stripped short id names a different model.
      if (!index.has(m.id)) index.set(m.id, m)
    }
  }
  routeCatalogIndexes.set(cacheKey, index)
  return index
}

/**
 * Whether the installed pi-ai catalog describes this route. A described route
 * needs no discovery: the catalog already answers with better metadata, and
 * the discovered cache must never shadow it.
 * @param route - the provider route key.
 * @returns true when pi-ai ships one or more models for the route.
 */
export function isCatalogRoute(route: string): boolean {
  try {
    return getBuiltinModels(route as Parameters<typeof getBuiltinModels>[0]).length > 0
  } catch {
    return false
  }
}

/** Cleanly beautifies raw model IDs into human-readable titles. */
function beautifyId(id: string): string {
  return id
    .replace(/^openai\//i, 'OpenAI: ')
    .replace(/^google\//i, 'Google: ')
    .replace(/^meta-llama\//i, 'Meta: ')
    .replace(/^qwen\//i, 'Qwen: ')
    .replace(/^minimax\//i, 'MiniMax: ')
    .replace(/^moonshotai\//i, 'MoonshotAI: ')
    .replace(/qwen(\d)/gi, 'Qwen $1')
    .replace(/mimo/gi, 'MiMo')
    .replace(/[-_.]/g, (m, offset, str) => {
      const prev = str[offset - 1]
      const next = str[offset + 1]
      if (m === '.' && /\d/.test(prev ?? '') && /\d/.test(next ?? '')) return '.'
      return ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/Gpt/g, 'GPT')
    .replace(/Vl/g, 'VL')
    .replace(/Ai/g, 'AI')
    .replace(/Qwen/g, 'Qwen')
    .replace(/Glm/g, 'GLM')
    .replace(/R1/g, 'R1')
    .replace(/V(\d)/g, 'V$1')
    .replace(/Free\b/i, '(Free)')
}

/** A non-empty string field of a listing entry, or `undefined`. */
function listingString(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * One disclosed token as a vocabulary token, or `undefined` for a token the
 * vocabulary does not carry. `vision` is the one alias mapped: gateways spell
 * image input with it.
 */
function liveModality(value: unknown): LiveModality | undefined {
  if (value === 'text' || value === 'image' || value === 'audio' || value === 'video' || value === 'pdf') return value
  return value === 'vision' ? 'image' : undefined
}

/** The deduplicated vocabulary tokens of one disclosure, preserving disclosure order. */
function liveModalities(raw: readonly unknown[]): LiveModality[] {
  const inputs: LiveModality[] = []
  for (const value of raw) {
    const modality = liveModality(value)
    if (modality !== undefined && !inputs.includes(modality)) inputs.push(modality)
  }
  return inputs
}

/** The listing's price fields as strings, or `undefined` when it priced nothing. */
function listingPricing(entry: Record<string, unknown>): Record<string, string> | undefined {
  const raw = entry.pricing
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const pricing: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') pricing[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) pricing[key] = String(value)
  }
  return Object.keys(pricing).length === 0 ? undefined : pricing
}

/**
 * Normalize one parsed listing row into the sync's model record. Capabilities
 * come from the shared `llm-pi-ai` parser, so a refresh and the Add flow see
 * the same context window, separate input cap, modalities, booleans, and
 * exact effort ladder. Only gateway-specific extras (`pricing`, `isFree`)
 * remain local.
 * @param listing - one row as the shared parser read it.
 * @param raw - the raw row, for the gateway-specific extras.
 * @returns the normalized model.
 */
function normalizeListingModel(listing: ListingModel, raw: unknown): LiveModel {
  const row = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const pricing = listingPricing(row)
  const isFree = typeof row.isFree === 'boolean' ? row.isFree : undefined
  return {
    id: listing.id,
    ...listing.name === undefined ? {} : { name: listing.name },
    ...listing.contextWindow === undefined ? {} : { contextWindow: listing.contextWindow },
    ...listing.maxInputTokens === undefined ? {} : { maxInputTokens: listing.maxInputTokens },
    ...listing.maxTokens === undefined ? {} : { maxTokens: listing.maxTokens },
    ...listing.inputModalities === undefined ? {} : { input: [...listing.inputModalities] },
    ...listing.tools === undefined ? {} : { tools: listing.tools },
    ...listing.reasoning === undefined ? {} : { reasoning: listing.reasoning },
    ...listing.reasoningEfforts === undefined ? {} : { reasoningEfforts: { ...listing.reasoningEfforts } },
    ...listing.unsupportedReasoningEfforts === undefined
      ? {}
      : { unsupportedReasoningEfforts: [...listing.unsupportedReasoningEfforts] },
    ...listing.owner === undefined ? {} : { owner: listing.owner },
    ...pricing === undefined ? {} : { pricing },
    ...isFree === undefined ? {} : { isFree },
    ...isFree === false ? { gated: true, gateReason: SIGN_IN_REQUIRED } : {},
  }
}

/**
 * Normalize one raw listing row into the fields this sync understands. The
 * row is read by the shared listing parser, so an explicit id wins over a map
 * label or `slug`, and a malformed capability block stays undisclosed instead
 * of becoming a guess.
 * @param entry - one raw row of the endpoint's listing.
 * @returns the normalized model, or `undefined` when it names no usable id.
 */
export function normalizeListingEntry(entry: unknown): LiveModel | undefined {
  const parsed = readModelListing([entry])
  if (!parsed.ok) return undefined
  const listing = parsed.models[0]
  return listing === undefined ? undefined : normalizeListingModel(listing, entry)
}

/** One raw listing row plus the map key an enriched `models` object supplies. */
interface RawListingRow {
  key?: string
  raw: unknown
}

/**
 * The raw rows of one listing body, keeping the map keys the shared parser
 * would read as ids. This only recovers gateway extras the parser does not
 * return; ids and capabilities always come from {@link readModelListing}.
 * @param body - parsed listing body.
 * @returns the raw rows, or an empty list for an unsupported container.
 */
function rawListingRows(body: unknown): RawListingRow[] {
  if (Array.isArray(body)) return body.map(raw => ({ raw }))
  if (body === null || typeof body !== 'object') return []
  const listing = body as { data?: unknown, models?: unknown }
  if (Array.isArray(listing.data)) return listing.data.map(raw => ({ raw }))
  if (Array.isArray(listing.models)) return listing.models.map(raw => ({ raw }))
  if (listing.models !== null && typeof listing.models === 'object') {
    return Object.entries(listing.models as Record<string, unknown>).map(([key, raw]) => ({ key, raw }))
  }
  return []
}

/** Largest model-listing reply accepted, matching the discovery reader's bound. */
export const MAX_MODEL_LISTING_BYTES = 4 * 1024 * 1024

/** Stable API version required by Anthropic's native model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The model-listing request one route's wire protocol expects: OpenAI-protocol
 * routes list at `{baseURL}/models` with a Bearer token; an Anthropic-Messages
 * route lists at the root's `/v1/models` with `anthropic-version` and
 * `x-api-key` (llm-pi-ai's own discovery makes the same call). A base that
 * already carries one trailing `/v1` segment keeps every other path segment
 * and gets the prefix back, and the endpoint's page cap is requested so a
 * large catalog is not truncated to the default page. The antigravity proxy
 * serves exactly this Anthropic address while its route baseURL deliberately
 * carries no `/v1`.
 * @param baseURL - the configured endpoint base.
 * @param api - the route's wire protocol, when known.
 * @param key - the credential to present, when one resolves.
 * @returns the absolute listing URL and the headers for it.
 */
export function modelListingRequest(
  baseURL: string,
  api?: string,
  key?: string,
): { url: string; headers: Record<string, string> } {
  const base = baseURL.replace(/\/+$/, '')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (key !== undefined && key.length > 0) headers['x-api-key'] = key
    return { url: `${root}/v1/models?limit=1000`, headers }
  }
  if (key !== undefined && key.length > 0) headers.authorization = `Bearer ${key}`
  return { url: `${base}/models`, headers }
}

/**
 * Read a listing reply body, refusing one larger than
 * {@link MAX_MODEL_LISTING_BYTES}. A declared length is checked before the
 * transfer; the accumulated stream total is what actually enforces the bound.
 * @param response - the listing response.
 * @param url - the request URL, for the diagnostic.
 * @returns the decoded body text.
 * @throws when the reply exceeds the bound.
 */
async function readBoundedListingText(response: Response, url: string): Promise<string> {
  const oversized = (): Error =>
    new Error(`GET ${url} answered with more than ${String(MAX_MODEL_LISTING_BYTES)} bytes`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_MODEL_LISTING_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MODEL_LISTING_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {
      // Cleanup after a drained or abandoned read; the reply is already decided.
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

/**
 * GET one provider's model listing. Fails loudly for the caller to log; the
 * caller is also the only one that knows whether the route already has a
 * usable catalogue to fall back on.
 * @param baseURL - the provider endpoint; the protocol's listing path is derived from it.
 * @param key - the route's credential, when one exists. Kilo and other
 *   anonymous gateways list unauthenticated.
 * @param api - the route's wire protocol; Anthropic Messages selects the
 *   native `/v1/models` address and `x-api-key` header, every OpenAI protocol
 *   keeps `{baseURL}/models` with Bearer.
 * @returns the normalized listing in endpoint order, deduplicated by id.
 */
export async function fetchModels(baseURL: string, key: string | undefined, api?: string): Promise<LiveModel[]> {
  const request = modelListingRequest(baseURL, api, key)
  const response = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`GET ${request.url} -> HTTP ${String(response.status)}`)
  const text = await readBoundedListingText(response, request.url)
  let body: unknown
  try {
    body = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`GET ${request.url} -> invalid JSON — ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = readModelListing(body)
  if (!parsed.ok) throw new Error(`GET ${request.url} -> unexpected shape`)
  const rawById = new Map<string, unknown>()
  for (const row of rawListingRows(body)) {
    const raw = row.raw
    const entry = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    // Same id precedence as the shared reader: a named map key is the request
    // id, then the row's `id`, then `slug` when neither exists.
    const id = listingText(row.key) ?? listingText(entry.id) ?? listingText(entry.slug)
    if (id !== undefined && !rawById.has(id)) rawById.set(id, raw)
  }
  const seen = new Set<string>()
  const models: LiveModel[] = []
  for (const listing of parsed.models) {
    if (seen.has(listing.id)) continue
    seen.add(listing.id)
    models.push(normalizeListingModel(listing, rawById.get(listing.id)))
  }
  return models
}

/** The Command Code adapter's settings namespace (the heavy manifest's `settingsNs`). */
const COMMANDCODE_NS = 'commandcode-provider'

/** The sibling provider package's bundled Command Code catalog snapshot. */
export function commandCodeCatalogPath(): string {
  const override = process.env.DSH_COMMANDCODE_CATALOG
  if (override !== undefined && override.length > 0) return override
  return fileURLToPath(new URL('../../enpoi-commandcode-provider/catalog.snapshot.json', import.meta.url))
}

/**
 * Read the bundled Command Code catalog as a live listing. The vendor serves
 * no model-listing endpoint — `dsh-enpoi-commandcode-provider` answers model
 * discovery from its shipped `catalog.snapshot.json` (a legacy loopback
 * keypool may serve `/catalog.json`, but the snapshot is the packaged source
 * of truth) — so the sync merges from the snapshot instead of probing a
 * `{baseURL}/models` address the vendor does not serve. Fails loudly for the
 * caller to report; an unreadable, malformed, or empty snapshot never
 * replaces a route's configured models.
 * @param path - snapshot path; defaults to the sibling package's bundled file.
 * @returns the normalized listing in snapshot order, deduplicated by id.
 */
export function loadCommandCodeCatalog(path: string = commandCodeCatalogPath()): LiveModel[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const rows = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>)
  const seen = new Set<string>()
  const models: LiveModel[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const entry = row as Record<string, unknown>
    const id = listingString(entry.id)
    if (id === undefined || seen.has(id)) continue
    const limit = entry.limit as { context?: unknown; output?: unknown } | undefined
    const modalities = entry.modalities as { input?: unknown } | undefined
    const supported = [
      ...(entry.tool_call === true ? ['tools'] : []),
      ...(entry.reasoning === true ? ['reasoning'] : []),
    ]
    // The snapshot publishes the selectable levels as an array of names. They
    // are handed to the shared listing parser in its provider-neutral
    // `capabilities.effort` shape, so the ladder the adapter serves is the
    // same one the sync writes — never a second mapping of the same claim.
    // The adapter serves no levels for a non-reasoning row, so the sync must
    // not credit one with a ladder the picker would then offer.
    const advertisedLevels = entry.reasoning === true && Array.isArray(entry.reasoningEfforts)
      ? entry.reasoningEfforts.filter((level): level is string => typeof level === 'string' && level.length > 0)
      : []
    const model = normalizeListingEntry({
      id,
      name: entry.name,
      context_window: limit?.context,
      max_output_tokens: limit?.output,
      ...(Array.isArray(modalities?.input) ? { input_modalities: modalities.input } : {}),
      ...(supported.length === 0 ? {} : { supported_parameters: supported }),
      ...(advertisedLevels.length === 0 ? {} : {
        capabilities: { effort: Object.fromEntries(advertisedLevels.map(level => [level, { supported: true }])) },
      }),
      ...(entry.cost === null || typeof entry.cost !== 'object' || Array.isArray(entry.cost) ? {} : { pricing: entry.cost }),
    })
    if (model === undefined) continue
    // The catalog's booleans are disclosures even when false; the listing
    // parser only infers flags from `supported_parameters` presence.
    if (typeof entry.tool_call === 'boolean') model.tools = entry.tool_call
    if (typeof entry.reasoning === 'boolean') model.reasoning = entry.reasoning
    if (entry.attachment === true && model.input === undefined) model.input = ['text', 'image']
    seen.add(id)
    models.push(model)
  }
  if (models.length === 0) throw new Error(`Command Code catalog ${path} held no usable models`)
  return models
}

/**
 * One route's maintained catalog correction. The overlay is a data file, not
 * code: `remove` names ids this deployment no longer serves even when the
 * endpoint still advertises them, and `upsert` carries the settings records
 * (the same field-for-field shape this sync writes and the Models page edits)
 * for ids the endpoint does not advertise or whose metadata is wrong. Applied
 * after the live merge, an upsert's fields win over the listing's, which is
 * what lets a record pin a display name the upstream catalog spells wrong.
 */
export interface RouteCatalogOverlay {
  /** Model ids dropped from the route after the live merge. */
  remove?: readonly string[]
  /** Settings records upserted into the route by id; named fields win over the merged entry. */
  upsert?: ReadonlyArray<Record<string, unknown>>
}

/** The overlays document, keyed by provider route id. */
export interface CatalogOverlayDocument {
  version?: number
  routes?: Record<string, RouteCatalogOverlay>
}

/** The shipped catalog overlays, sibling of this module in the package. */
export function catalogOverlaysPath(): string {
  const override = process.env.DSH_CATALOG_OVERLAYS
  if (override !== undefined && override.length > 0) return override
  return fileURLToPath(new URL('../catalog-overlays.json', import.meta.url))
}

/**
 * Read the catalog overlays. An absent file is no overlays; a present but
 * malformed one throws so the caller reports it instead of silently dropping
 * a maintained correction. Shape errors are refused at load rather than
 * guessed at merge time, and the message names the file.
 * @param path - overlays path; defaults to the package's bundled file.
 * @returns the parsed document; `{}` when the file is absent.
 */
export function loadCatalogOverlays(path: string = catalogOverlaysPath()): CatalogOverlayDocument {
  if (!existsSync(path)) return {}
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`catalog overlays ${path}: document must be an object`)
  }
  const routes = (raw as { routes?: unknown }).routes
  if (routes === undefined) return raw as CatalogOverlayDocument
  if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
    throw new Error(`catalog overlays ${path}: "routes" must be an object keyed by route id`)
  }
  for (const [route, value] of Object.entries(routes)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`catalog overlays ${path}: route "${route}" must be an object`)
    }
    const overlay = value as { remove?: unknown; upsert?: unknown }
    if (overlay.remove !== undefined && !Array.isArray(overlay.remove)) {
      throw new Error(`catalog overlays ${path}: route "${route}" has a "remove" that is not a list of model ids`)
    }
    for (const id of (overlay.remove ?? []) as unknown[]) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`catalog overlays ${path}: route "${route}" has a remove entry that is not a model id`)
      }
    }
    if (overlay.upsert !== undefined && !Array.isArray(overlay.upsert)) {
      throw new Error(`catalog overlays ${path}: route "${route}" has an "upsert" that is not a list of model records`)
    }
    for (const entry of (overlay.upsert ?? []) as unknown[]) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || listingString((entry as { id?: unknown }).id) === undefined) {
        throw new Error(`catalog overlays ${path}: route "${route}" has an upsert entry without a model id`)
      }
      const id = listingString((entry as { id?: unknown }).id) ?? ''
      try {
        // Validate the capability fields through the shared pi-ai model schema
        // so a string `contextWindow` (or any other wrong type) refuses the
        // file instead of persisting a route llm-pi-ai later rejects.
        PiAiConfig({ providers: { [route]: { models: [entry] } } })
      } catch (error) {
        throw new Error(
          `catalog overlays ${path}: route "${route}" upsert "${id}" is not a valid model record —`
          + ` ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
  return raw as CatalogOverlayDocument
}

/** The route-local protection an overlay removal must respect. */
export interface CatalogOverlayProtection {
  /**
   * Ids the overlay's `remove` keeps as the operator's own record: a
   * `source: 'manual'` entry or a `pinnedModels` id. Precedence: operator
   * record over overlay removal.
   */
  keep?: ReadonlySet<string>
  /**
   * Ids the overlay's `remove` keeps but marks `deprecated: true` because a
   * route-local reference still names them (main default, chain link, persona
   * seat, subagent allowed route, favorite). Precedence: reference over
   * overlay removal; the model stays visible as deprecated, never as a
   * current member.
   */
  deprecate?: ReadonlySet<string>
}

/**
 * Apply one route's overlay to its merged settings-model list: removal wins
 * over the listing, an upsert replaces the entry's named fields, and an id
 * neither the listing nor the configuration carries is appended. A
 * `source: 'manual'` entry keeps its operator-declared name, input, limits,
 * and ladder over an upsert too. The input is returned unchanged when the
 * route has no overlay, so routes the file does not name are untouched.
 * @param models - the merged settings records, in endpoint/configuration order.
 * @param overlay - the route's overlay, `undefined` when the file names none.
 * @param protection - ids an overlay removal keeps (operator records) or keeps deprecated (references).
 * @returns the corrected list.
 */
export function applyCatalogOverlay(
  models: Array<Record<string, unknown>>,
  overlay: RouteCatalogOverlay | undefined,
  protection?: CatalogOverlayProtection,
): Array<Record<string, unknown>> {
  if (overlay === undefined) return models
  const removed = new Set(overlay.remove ?? [])
  const upserts = new Map<string, Record<string, unknown>>()
  for (const entry of overlay.upsert ?? []) {
    const id = listingString(entry.id)
    if (id !== undefined) upserts.set(id, entry)
  }
  if (removed.size === 0 && upserts.size === 0) return models
  const applied: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const entry of models) {
    const id = listingString(entry.id)
    if (id !== undefined && removed.has(id)) {
      const upsert = upserts.get(id)
      if (protection?.keep?.has(id) === true) {
        applied.push({
          ...entry,
          ...(upsert === undefined ? {} : { ...upsert, unverified: undefined, capabilityHints: undefined }),
          ...preservedManualFields(entry),
        })
        seen.add(id)
        continue
      }
      if (protection?.deprecate?.has(id) === true) {
        applied.push({
          ...entry,
          ...(upsert === undefined ? {} : { ...upsert, unverified: undefined, capabilityHints: undefined }),
          ...preservedManualFields(entry),
          source: 'pinned-in-use',
          deprecated: true,
        })
        seen.add(id)
        continue
      }
      continue
    }
    const upsert = id === undefined ? undefined : upserts.get(id)
    if (upsert === undefined) {
      applied.push(entry)
    } else {
      // The overlay record is maintained truth: its fields win, and the
      // "nothing described this model" marker and the id-hint claim the merge
      // may have stamped are cleared because the overlay does describe it.
      applied.push({ ...entry, ...upsert, ...preservedManualFields(entry), unverified: undefined, capabilityHints: undefined })
    }
    if (id !== undefined) seen.add(id)
  }
  for (const [id, entry] of upserts) {
    if (seen.has(id)) continue
    if (removed.has(id) && protection?.keep?.has(id) !== true) continue
    applied.push({ ...entry })
  }
  return applied
}

/**
 * One model of the discovered-model cache written for `llm-pi-ai` to read.
 * The cache file is the contract between this profile plugin and the
 * `dsh-llm-pi-ai` resolution layer (`src/discovered.ts` there owns the
 * reader); keep the shapes in step.
 */
export interface DiscoveredFileModel {
  id: string
  name?: string
  contextWindow?: number
  /** Input-only token cap, separate from the combined context window. */
  maxInputTokens?: number
  maxTokens?: number
  input?: Array<LiveModality>
  tools?: boolean
  reasoning?: boolean
  /**
   * Selectable reasoning levels (picker id → wire value) the route disclosed.
   * Persisted so a route resolving from this cache offers the same ladder a
   * configured entry carries; absent means nothing disclosed one.
   */
  reasoningEfforts?: Readonly<Record<string, string>>
  /** Advertised effort names no configured profile accepts; diagnostics only, never materialized. */
  unsupportedReasoningEfforts?: readonly string[]
  pricing?: Record<string, string>
  isFree?: boolean
  /** Whether the listing marked the model sign-in/paid-only, mirroring the rules engine's `gated` entry flag. */
  gated?: boolean
  /** The picker-facing reason a gated model is unavailable; absent when not gated. */
  gateReason?: string
  /** models.dev's release date (`YYYY-MM-DD`), when disclosed. */
  releaseDate?: string
  /** Request-wide price tiers above an input-token threshold, when models.dev disclosed any. */
  costTiers?: LiveCostTier[]
  /**
   * True when a capability rests on the schema floor instead of a disclosure:
   * nothing at all described the model, or its modality/reasoning row was
   * left to the id hints (which are persisted only in `capabilityHints`).
   */
  unverified?: boolean
  /**
   * True when the endpoint stopped advertising this model while a route-local
   * reference or an operator pin still names it: the record is kept so a
   * configured default/chain/favorite does not break silently. A later pass
   * that advertises the id again drops the marker.
   */
  deprecated?: boolean
  source: 'discovered'
  discoveredAt: number
}

/** One route's discovered models plus the fetch that produced them. */
export interface DiscoveredFileRoute {
  baseURL?: string
  fetchedAt: number
  models: DiscoveredFileModel[]
}

interface DiscoveredFile {
  version: number
  routes: Record<string, DiscoveredFileRoute>
}

/** Cache format version; must match `dsh-llm-pi-ai`'s reader. */
const DISCOVERED_CACHE_VERSION = 1

/**
 * Resolve the DSH home directory: an explicit `DSH_HOME`, else the real user
 * home (`HOME`, or `USERPROFILE` on Windows) with `.dsh` appended. The OS
 * account home is the last resort; a literal user path is never assumed.
 * @param env - environment to read (tests inject one).
 * @param platform - OS key to branch on (tests inject one).
 * @returns the DSH home directory.
 * @throws when no home directory can be resolved at all.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = firstNonEmpty(env.DSH_HOME)
  if (explicit !== undefined) return explicit
  const home = firstNonEmpty(env.HOME, platform === 'win32' ? env.USERPROFILE : undefined, homedir())
  if (home === undefined) {
    throw new Error('dsh-enpoi-provider-sync: no home directory resolved (set HOME, USERPROFILE, or DSH_HOME) — cannot locate the discovered-models cache')
  }
  return join(home, '.dsh')
}

/** The shared discovered-model cache path, overridable for tests. */
export function discoveredCachePath(): string {
  const override = process.env.DSH_DISCOVERED_MODELS
  if (override !== undefined && override.length > 0) return override
  return join(resolveDshHome(), 'cache', 'discovered-models.json')
}

/**
 * The deployment owner's capability-hints override path:
 * `$DSH_HOME/model-capability-hints.json`, overridable for tests. The file's
 * per-route/per-model hints win over the shipped id table
 * (`model-capability-hints.json`); an absent file is no override.
 * @param env - environment to read (tests inject one).
 * @param platform - OS key to branch on (tests inject one).
 * @returns the override file path.
 */
export function capabilityHintsOverridePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = firstNonEmpty(env.DSH_CAPABILITY_HINTS_OVERRIDE)
  if (override !== undefined) return override
  return join(resolveDshHome(env, platform), 'model-capability-hints.json')
}

/**
 * Read the owner's capability-hints override. An absent file is no override;
 * a present but malformed one throws so the caller reports it instead of
 * silently dropping maintained hints.
 * @param path - override path; defaults to `$DSH_HOME/model-capability-hints.json`.
 * @returns the parsed document; `{}` when the file is absent.
 */
export function loadCapabilityHintsOverride(path: string = capabilityHintsOverridePath()): CapabilityHintsOverrideDocument {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`capability-hints override ${path}: unreadable — ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseCapabilityHintsOverride(raw, path)
}

/**
 * The hint evaluation one sync pass uses: the shipped table plus the owner
 * override (when one loaded). Callers that omit it get the shipped table and
 * no override, which keeps unit merges deterministic.
 */
export interface CapabilityHintContext {
  table: CapabilityHints
  override: CapabilityHintsOverrideDocument
}

/** Read the cache tolerantly: a corrupt file is replaced, never fatal to a sync pass. */
function readDiscoveredFile(path: string): DiscoveredFile {
  try {
    if (!existsSync(path)) return { version: DISCOVERED_CACHE_VERSION, routes: {} }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiscoveredFile>
    const routes = raw.routes
    if (routes === null || typeof routes !== 'object' || Array.isArray(routes)) {
      return { version: DISCOVERED_CACHE_VERSION, routes: {} }
    }
    // Normalize just enough for the merge to be total: a hand-edited route
    // without a models array is dropped rather than crashing the pass that
    // would have fixed it.
    const safe: Record<string, DiscoveredFileRoute> = {}
    for (const [route, value] of Object.entries(routes as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Partial<DiscoveredFileRoute>
      if (!Array.isArray(record.models)) continue
      safe[route] = {
        ...typeof record.baseURL === 'string' ? { baseURL: record.baseURL } : {},
        fetchedAt: typeof record.fetchedAt === 'number' ? record.fetchedAt : 0,
        models: record.models,
      }
    }
    return { version: DISCOVERED_CACHE_VERSION, routes: safe }
  } catch {
    return { version: DISCOVERED_CACHE_VERSION, routes: {} }
  }
}

/** The content identity of a discovered record, excluding the provenance stamps a re-stamp would change. */
function discoveredContent(model: object): string {
  const { discoveredAt: _stamp, source: _source, ...rest } = model as { discoveredAt?: number; source?: string }
  return JSON.stringify(rest)
}

/**
 * Merge a fresh listing into the cache record for one route. Idempotent by
 * construction: a model whose content is unchanged keeps its original
 * `discoveredAt`, so re-running a sync pass over an unchanged endpoint leaves
 * the file byte-identical instead of re-stamping every model every hour.
 *
 * The listing is authoritative for everything it advertises: a changed
 * capacity, ladder, or modality replaces the prior record and re-stamps it;
 * an id the endpoint stopped advertising is dropped — unless this pass names
 * it in `retain` (a route-local reference or an operator pin). A retained
 * record keeps its last disclosed fields, is stamped `deprecated: true`, and
 * disappears on the first pass that no longer retains it. A retained id the
 * endpoint advertises again is replaced by the fresh record, clearing the
 * marker.
 * @param previous - the route's existing record, when one exists.
 * @param baseURL - the endpoint interrogated.
 * @param models - the freshly analyzed models, without provenance stamps.
 * @param now - the current epoch milliseconds.
 * @param retain - prior ids to keep though the listing no longer advertises them.
 * @returns the record to persist.
 */
export function mergeDiscoveredRoute(
  previous: DiscoveredFileRoute | undefined,
  baseURL: string,
  models: Array<Omit<DiscoveredFileModel, 'source' | 'discoveredAt'>>,
  now: number,
  retain: readonly string[] = [],
): DiscoveredFileRoute {
  const priorById = new Map((previous?.models ?? []).map(model => [model.id, model]))
  const merged: DiscoveredFileModel[] = models.map((model) => {
    const prior = priorById.get(model.id)
    return {
      ...model,
      source: 'discovered',
      discoveredAt: prior !== undefined && discoveredContent(prior) === discoveredContent(model)
        ? prior.discoveredAt
        : now,
    }
  })
  // The endpoint is the membership authority; a reference keeps a retired id
  // instead of breaking the default/chain/favorite that names it. The record
  // keeps the last facts the endpoint disclosed and its original stamp, so an
  // unchanged retention pass stays byte-identical.
  const advertised = new Set(merged.map(model => model.id))
  if (retain.length > 0) {
    const seen = new Set(advertised)
    for (const id of retain) {
      if (seen.has(id)) continue
      seen.add(id)
      const prior = priorById.get(id)
      if (prior === undefined) continue
      merged.push({ ...prior, deprecated: true })
    }
  }
  const unchanged = previous !== undefined
    && previous.baseURL === baseURL
    && JSON.stringify(previous.models) === JSON.stringify(merged)
  return {
    baseURL,
    fetchedAt: unchanged ? previous.fetchedAt : now,
    models: merged,
  }
}

/**
 * Tail of the in-process discovered-cache write chain. The file is shared by
 * every route (and by sibling tooling), so a read-modify-write pair must not
 * interleave: each locked task re-reads the file it is about to replace, and
 * a write of route A therefore cannot drop a concurrent write of route B.
 */
let discoveredWriteChain: Promise<void> = Promise.resolve()

/**
 * Persist one route's discovered models atomically. Writes serialize through
 * an in-process promise chain and re-read the file inside the locked task, so
 * concurrent distinct-route writes all survive. Cache-write failures are
 * logged by the caller and never fail the sync pass: the settings-side merge
 * (for configured routes) is the durable catalogue, and this file is the
 * resolution layer's copy.
 * @param route - the provider route key.
 * @param record - the merged route record.
 * @returns fulfillment after the write lands; rejection when it fails.
 */
export function writeDiscoveredRoute(route: string, record: DiscoveredFileRoute): Promise<void> {
  const write = discoveredWriteChain.then(() => {
    const path = discoveredCachePath()
    const document = readDiscoveredFile(path)
    document.version = DISCOVERED_CACHE_VERSION
    document.routes[route] = record
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.tmp-${String(process.pid)}`
    try {
      writeFileSync(temporary, JSON.stringify(document), 'utf8')
      renameSync(temporary, path)
    } catch (error) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // A failed temp cleanup must not mask the write failure reported below.
      }
      throw error
    }
  })
  // A failed write rejects the caller's promise but must not break the chain:
  // later routes still serialize behind it.
  discoveredWriteChain = write.catch(() => {})
  return write
}

/**
 * The honest failure line for a route whose listing could not be fetched:
 * the current error plus where a person can put models instead.
 * @param route - the provider route key.
 * @param error - the fetch failure.
 * @param ns - the settings namespace that owns the route; defaults to `llm-pi-ai`.
 * @returns one line the caller logs verbatim.
 */
export function describeSyncFailure(route: string, error: unknown, ns: string = LLM_NS): string {
  return `route ${route}: sync failed — ${error instanceof Error ? error.message : String(error)};`
    + ' add models manually on the Models page, or list them in '
    + `${ns}.providers["${route}"].models`
}


/**
 * models.dev's `release_date`, when it carries the `YYYY-MM-DD` spelling the
 * catalogue publishes and parses as an ISO date. Anything else is the absence
 * of a fact, not a date to guess at.
 * @param value - the raw `release_date`.
 * @returns the ISO date, or `undefined`.
 */
export function modelsDevReleaseDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? undefined : value
}

/** One finite non-negative price, or `undefined`. */
function finitePrice(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * models.dev's request-wide price tiers, normalized. `cost.tiers` carries the
 * per-threshold prices; `cost.context_over_200k` is the same fact published as
 * a named 200K tier. Duplicate thresholds collapse, a tier naming no price is
 * dropped, and anything that is not a positive integer threshold is ignored.
 * @param value - the raw `cost` object.
 * @returns the tiers ordered by ascending threshold, or `undefined` when none is usable.
 */
export function modelsDevCostTiers(value: unknown): LiveCostTier[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cost = value as { tiers?: unknown, context_over_200k?: unknown }
  const tiers: LiveCostTier[] = []
  const add = (rawThreshold: unknown, input: unknown, output: unknown): void => {
    if (typeof rawThreshold !== 'number' || !Number.isInteger(rawThreshold) || rawThreshold <= 0) return
    const priceIn = finitePrice(input)
    const priceOut = finitePrice(output)
    if (priceIn === undefined && priceOut === undefined) return
    if (tiers.some(tier => tier.inputTokensAbove === rawThreshold)) return
    tiers.push({
      inputTokensAbove: rawThreshold,
      ...priceIn === undefined ? {} : { input: priceIn },
      ...priceOut === undefined ? {} : { output: priceOut },
    })
  }
  if (Array.isArray(cost.tiers)) {
    for (const raw of cost.tiers) {
      if (raw === null || typeof raw !== 'object') continue
      const tier = raw as { input?: unknown, output?: unknown, tier?: { size?: unknown } }
      add(tier.tier?.size, tier.input, tier.output)
    }
  }
  const over = cost.context_over_200k
  if (over !== null && typeof over === 'object') {
    const rates = over as { input?: unknown, output?: unknown }
    add(200_000, rates.input, rates.output)
  }
  return tiers.length === 0 ? undefined : tiers.sort((left, right) => left.inputTokensAbove - right.inputTokensAbove)
}

/**
 * Copy a disclosed effort ladder without extending it. Unknown level ids are
 * dropped, a non-`off` level needs a usable wire string, and an explicit
 * `off` is kept as the valueless key (`null`) when the source spelled it with
 * an empty wire. The ladder is returned only when at least one thinking level
 * remains, because settings refuse an `off`-only declaration.
 * @param ladder - the level-to-wire map a source supplied.
 * @returns the exact usable ladder, or `undefined` when nothing usable was supplied.
 */
function disclosedLadder(
  ladder: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | null> | undefined {
  if (ladder === undefined) return undefined
  const copied: Record<string, string | null> = {}
  let thinking = false
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(ladder, level)) continue
    const wire = ladder[level]
    if (level === 'off') {
      if (wire === null || wire === '') copied.off = null
      else if (typeof wire === 'string') copied.off = wire
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) continue
    copied[level] = wire
    thinking = true
  }
  return thinking ? copied : undefined
}

/**
 * The ladder models.dev and the installed catalog supply, without inference.
 * models.dev's `reasoning_options` names levels directly; the installed
 * catalog's `thinkingLevelMap` carries each level's wire spelling and `null`
 * for an unsupported one. The catalog entry wins per level. An id neither
 * source sizes yields no ladder, which is how `reasoning: true` with no
 * disclosed levels stays absent instead of becoming an invented full ladder.
 * @param mDev - the route's models.dev entry, when one exists.
 * @param catalogModel - the installed catalog entry, when one exists.
 * @returns the exact supplied ladder, or `undefined` when neither supplied usable levels.
 */
function catalogReasoningLadder(
  mDev: ModelsDevModel | undefined,
  catalogModel: Model<Api> | undefined,
): Record<string, string | null> | undefined {
  const merged = new Map<string, string | null>()
  if (Array.isArray(mDev?.reasoning_options)) {
    for (const option of mDev.reasoning_options) {
      for (const value of option.values ?? []) {
        if (typeof value === 'string' && value.length > 0) merged.set(value, value)
      }
    }
  }
  if (catalogModel?.thinkingLevelMap !== undefined) {
    for (const [level, wire] of Object.entries(catalogModel.thinkingLevelMap)) merged.set(level, wire)
  }
  // Object.fromEntries creates own data properties, so an external `__proto__`
  // identifier cannot rewrite the prototype before the canonical filter runs.
  return disclosedLadder(Object.fromEntries(merged))
}

/**
 * Resolve one model's exact registry metadata. The endpoint's `owned_by` value
 * scopes the lookup; a route declaration may override it with an exact owner
 * or channel for a renamed user-created instance. An unknown id or an
 * ambiguous cross-channel record answers `undefined` instead of guessing.
 * @param context - the route's registry lookup context, when it declares one.
 * @param model - the endpoint row being enriched.
 * @returns the exact sanitized record, or `undefined` when the registry does not resolve it.
 */
function registryMetadataFor(
  context: RegistryMetadataContext | undefined,
  model: LiveModel,
): RegistryResolvedModel | undefined {
  if (context === undefined) return undefined
  const owner = context.owner !== undefined && context.owner.length > 0 ? context.owner : model.owner
  const channel = context.channel !== undefined && context.channel.length > 0 ? context.channel : undefined
  // Exact scope is required: an id-only lookup could attach one channel's
  // metadata to a different provider's model, so a missing owner/channel is
  // an unknown record rather than a fallback.
  if ((owner === undefined || owner.length === 0) && channel === undefined) return undefined
  const lookup = resolveRegistryModel(context.index, model.id, {
    ...channel === undefined ? {} : { channel },
    ...owner === undefined || owner.length === 0 ? {} : { owner },
    ...context.ownerChannels === undefined
      ? {}
      : { ownerChannels: { ...OWNER_CHANNEL_ALIASES, ...context.ownerChannels } },
  })
  return lookup.status === 'resolved' ? lookup.metadata : undefined
}

/**
 * The selectable ladder a resolved registry record discloses, without
 * converting budgets into named levels. A budget-only or explicitly empty
 * disclosure yields `undefined`, which blocks lower sources from inventing a
 * full ladder; the reasoning flag remains whatever the registry stated.
 * @param effort - the resolved record's non-null effort disclosure.
 * @returns the canonical ladder, or `undefined` when no named level is offered.
 */
function registryReasoningLadder(effort: NonNullable<RegistryResolvedModel['effort']>): Record<string, string | null> | undefined {
  const supported: ReadonlySet<string> = new Set(effort.supportedKeys)
  const ladder: Record<string, string | null> = {}
  let thinking = false
  for (const level of THINKING_LEVELS) {
    if (level === 'off') {
      if (supported.has('off')) ladder.off = null
      continue
    }
    if (!supported.has(level)) continue
    ladder[level] = level
    thinking = true
  }
  return thinking ? ladder : undefined
}

/** One model's two renderings: what settings stores and what the discovery cache keeps. */
interface AnalyzedModel {
  /**
   * The settings-model record. Capabilities are disclosed facts; an
   * undisclosed capacity stays absent so runtime route defaults resolve it, a
   * guess from the shared id table rides only in the labeled
   * `capabilityHints` field, and `unverified: true` marks a record no
   * disclosure justified.
   */
  settings: Record<string, unknown>
  /** The discovered-cache record, minus the provenance stamps the writer adds. */
  discovered: Omit<DiscoveredFileModel, 'source' | 'discoveredAt'>
}

/**
 * Analyze a live model with canonical naming, reasoning efforts, capacity
 * metadata, and honest capability provenance.
 *
 * Capabilities are persisted only when a source disclosed them: the listing,
 * a declared route's exact registry record, models.dev, or the installed
 * catalog. The shared id table's operands never become facts — a capability
 * nothing disclosed keeps the schema floor (`text` input, no reasoning) and is
 * marked `unverified`, with the id guess kept only in the labeled
 * `capabilityHints` field. The rules engine and the panel therefore read
 * vectors, not guesses.
 * @param route - the provider route key, for models.dev scoping.
 * @param model - the normalized listing entry.
 * @param hints - the shipped hint table plus the owner override.
 * @param routeProviderMap - the effective route → models.dev provider keys.
 * @param registryContext - the route's exact registry lookup, when declared.
 * @returns the settings record and the cache record.
 */
function analyzeModel(
  route: string,
  model: LiveModel,
  hints: CapabilityHintContext,
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
  registryContext: RegistryMetadataContext | undefined = undefined,
): AnalyzedModel {
  const mDev = resolveFromModelsDev(route, model.id, routeProviderMap)
  const catalog = catalogIndexForRoute(route, routeProviderMap)
  const cat = catalog.get(model.id)
  const registry = registryMetadataFor(registryContext, model)

  // 1. Resolve Name — the endpoint's own label wins; the registry's raw name
  // is next, then models.dev, then the installed catalog, then the id. A live
  // proxy description is often mislabeled ("Gemini 3.1 Flash Lite"), so only a
  // plausible short label is accepted.
  const liveName = model.name
  const name = liveName !== undefined && liveName !== model.id && liveName.length <= 60
    ? liveName
    : registry?.name ?? mDev?.name ?? cat?.name ?? beautifyId(model.id)

  // 2. Resolve Context Window, Input Cap & Max Output Tokens — the endpoint's
  // own disclosure wins, then an exact registry record, then models.dev, then
  // the installed catalog. No adapter default or route-level capacity guess is
  // materialized here: an undisclosed capacity stays absent so the route's own
  // `defaultContextWindow` / `defaultMaxTokens` resolves it at runtime instead
  // of being persisted as if a source had disclosed it. models.dev's
  // `limit.input` is a prompt-side cap, never a substitute for the combined
  // window and never derived from one.
  const devContext = mDev?.limit?.context ?? mDev?.contextWindow
  const devMaxInputTokens = mDev?.limit?.input
  const devMax = mDev?.limit?.output ?? mDev?.maxTokens

  const contextWindow = model.contextWindow ?? registry?.contextWindow ?? devContext ?? cat?.contextWindow
  const maxInputTokens = model.maxInputTokens ?? registry?.maxInputTokens ?? devMaxInputTokens
  const maxTokens = model.maxTokens ?? registry?.maxTokens ?? devMax ?? cat?.maxTokens

  // 3. Resolve Modalities, Reasoning, and their provenance. The endpoint's own
  // listing speaks for the route it serves, so a disclosure it makes wins over
  // every enrichment. A declared route's raw registry record is next, then
  // models.dev and the installed catalog; the shared id table's operands stay
  // hints in `capabilityHints`. The registry is exact metadata, never
  // membership, and an explicit `reasoning: false` or a budget-only record
  // blocks lower sources from inventing a ladder.
  const registryInput = registry?.inputModalities !== null && registry?.inputModalities !== undefined
    && registry.inputModalities.length > 0
    ? registry.inputModalities
    : undefined
  const disclosed = [model.input, registryInput, mDev?.modalities?.input, cat?.input]
    .find(value => Array.isArray(value) && liveModalities(value).length > 0)
  const modalityDisclosed = disclosed !== undefined
  const inputModalities: LiveModality[] = modalityDisclosed
    ? ['text', ...liveModalities(disclosed).filter(modality => modality !== 'text')]
    : ['text']
  const endpointReasoning = typeof model.reasoning === 'boolean' ? model.reasoning : undefined
  const endpointLadderDeclared = model.reasoningEfforts !== undefined
  const endpointLadder = endpointLadderDeclared ? disclosedLadder(model.reasoningEfforts) : undefined
  const registryReasoning = registry?.reasoning ?? undefined
  const registryEffort = registry?.effort ?? undefined
  const registryLadder = registryEffort === undefined ? undefined : registryReasoningLadder(registryEffort)
  // `null` registry reasoning means upstream omitted the field, so it is not a
  // disclosure and lower sources may fill it. Any explicit flag or effort
  // object is a registry claim and blocks catalog inference, including the
  // budget-only case whose named ladder is intentionally absent.
  const registryBlocksReasoning = registryReasoning !== undefined || registryEffort !== undefined
  const catalogMaySpeak = !endpointLadderDeclared && endpointReasoning !== false && !registryBlocksReasoning
  const enrichedReasoning = [mDev?.reasoning, cat?.reasoning]
    .filter((value): value is boolean => typeof value === 'boolean')
  const catalogEfforts = catalogMaySpeak ? catalogReasoningLadder(mDev, cat) : undefined
  const reasoningKnown = endpointLadderDeclared || endpointReasoning !== undefined || registryBlocksReasoning
    || enrichedReasoning.length > 0 || catalogEfforts !== undefined
  const reasoningDisclosed = reasoningKnown
  const isReasoning = endpointReasoning !== undefined
    ? endpointReasoning
    : endpointLadderDeclared
      ? true
      : registryReasoning !== undefined
        ? registryReasoning
        : registryEffort !== undefined
          ? true
          : enrichedReasoning.some(value => value === true) || catalogEfforts !== undefined

  // The shared table's guess (and any owner override) never becomes a fact:
  // it is kept only under `capabilityHints`, and a claim for a capability
  // nothing disclosed marks the record unverified.
  const claim: CapabilityHintClaim | undefined = claimCapabilityHints(route, model.id, hints.table, hints.override)
  const hintedInput = !modalityDisclosed && claim !== undefined && claim.input.length > 0
  const hintedReasoning = !reasoningDisclosed && claim?.reasoning === true
  const nothingDescribed = registry === undefined && mDev === undefined && cat === undefined
    && model.input === undefined && model.reasoning === undefined && model.tools === undefined
    && !endpointLadderDeclared
  const unverified = nothingDescribed || hintedInput || hintedReasoning
  // A disclosed capability keeps its fact; the labeled hint field carries only
  // the claims a disclosure did not cover.
  const capabilityHints: Record<string, unknown> | undefined = claim === undefined ? undefined : {
    ...claim.input.length === 0 || modalityDisclosed ? {} : { input: claim.input },
    ...claim.reasoning && !reasoningDisclosed ? { reasoning: true } : {},
    source: claim.source,
  }

  // 4. Resolve Reasoning Efforts. The endpoint's ladder wins and travels
  // verbatim; otherwise the registry's exact named levels are next, and only a
  // route with no registry declaration accepts the catalog's own ladder. No
  // branch invents levels: an explicit false or a budget-only record leaves
  // the ladder absent, and `off` is kept only when a source supplied it.
  const reasoningEfforts: Record<string, string | null> | undefined = endpointReasoning === false
    ? undefined
    : endpointLadderDeclared
      ? endpointLadder
      : registryBlocksReasoning
        ? registryLadder
        : catalogEfforts

  // 5. Tool-calling and price metadata. Both feed the dynamic catalogue rules
  // (dsh-enpoi-catalog-rules): the `tools` and `zeroPrice`/`maxPrice`
  // predicates. The listing's own disclosure wins (it serves the route);
  // models.dev fills what the listing did not state; absent fields stay absent
  // so a rule can tell "unknown" from "known free"/"known pays".
  const tools = typeof model.tools === 'boolean'
    ? model.tools
    : mDev?.tool_call
  const costInput = typeof mDev?.cost?.input === 'number' && Number.isFinite(mDev.cost.input) ? mDev.cost.input : undefined
  const costOutput = typeof mDev?.cost?.output === 'number' && Number.isFinite(mDev.cost.output) ? mDev.cost.output : undefined
  const cost = costInput !== undefined || costOutput !== undefined
    ? { ...(costInput !== undefined ? { input: costInput } : {}), ...(costOutput !== undefined ? { output: costOutput } : {}) }
    : undefined

  // 5b. Display tags models.dev carries beyond scalar facts: the release date
  // feeds the Models page's "new" marker and the request-wide price tiers feed
  // its usage-tier marker. Neither is guessed when models.dev says nothing.
  const releaseDate = modelsDevReleaseDate(mDev?.release_date)
  const costTiers = modelsDevCostTiers(mDev?.cost)

  // 6. Gate marker. The listing's own `isFree: false` verdict means the model
  // is sign-in/paid-only on that gateway; both records carry the rules engine's
  // `gated` flag so the picker dims it with the reason and a `gated` rule
  // clause can exclude it. Models the listing did not price stay ungated:
  // absent is "undisclosed", never a gate.
  const gated = model.gated === true || model.isFree === false
  const gate = gated ? { gated: true, gateReason: model.gateReason ?? SIGN_IN_REQUIRED } : {}

  // The discovered record carries the same ladder the settings record does,
  // narrowed to wire-value strings the cache's own schema accepts. This is
  // what keeps a route resolving from the cache from losing the efforts a
  // configured route (or the Add flow) wrote.
  const discoveredEfforts = reasoningEfforts === undefined
    ? undefined
    : Object.fromEntries(Object.entries(reasoningEfforts)
      .filter(([, wire]) => typeof wire === 'string' && wire.length > 0)) as Record<string, string>
  const discoveredEffortsValue = discoveredEfforts !== undefined && Object.keys(discoveredEfforts).length > 0
    ? discoveredEfforts
    : undefined
  const discoveredReasoning = model.reasoning ?? registry?.reasoning ?? undefined
  const unsupportedEfforts = [...new Set([
    ...model.unsupportedReasoningEfforts ?? [],
    ...registryEffort?.unsupportedLevels ?? [],
  ])]

  return {
    settings: {
      id: model.id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      input: inputModalities,
      // A registry lookup with omitted thinking is UNKNOWN: omit the field
      // instead of asserting false. Generic unknown records keep the floor.
      ...(!reasoningKnown && registry !== undefined ? {} : { reasoning: isReasoning }),
      ...(tools !== undefined ? { tools } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(costTiers === undefined ? {} : { costTiers }),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(capabilityHints === undefined ? {} : { capabilityHints }),
      ...gate,
      ...(unverified ? { unverified: true } : {}),
    },
    discovered: {
      id: model.id,
      name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(modalityDisclosed ? { input: inputModalities } : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(discoveredReasoning === undefined ? {} : { reasoning: discoveredReasoning }),
      ...(discoveredEffortsValue === undefined ? {} : { reasoningEfforts: discoveredEffortsValue }),
      ...(unsupportedEfforts.length === 0 ? {} : { unsupportedReasoningEfforts: unsupportedEfforts }),
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      ...(model.isFree === undefined ? {} : { isFree: model.isFree }),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(costTiers === undefined ? {} : { costTiers }),
      ...gate,
      ...(unverified ? { unverified: true } : {}),
    },
  }
}

/**
 * The fields one configured entry keeps through a refresh because they are the
 * operator's own claim: a `source: 'manual'` model's name, input modalities,
 * capacities, reasoning flag, and reasoning ladder. Every field the operator
 * left unfilled still refreshes from the listing or the overlay. The settings
 * record is stored JSON, so each value is narrowed here.
 * @param entry - the configured model record.
 * @returns the fields a refresh must not overwrite; `{}` for a non-manual entry.
 */
function preservedManualFields(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.source !== 'manual') return {}
  const preserved: Record<string, unknown> = {
    ...preservedOperatorFields(entry),
  }
  if (typeof entry.name === 'string') preserved.name = entry.name
  if (typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow)) {
    preserved.contextWindow = entry.contextWindow
  }
  if (typeof entry.maxInputTokens === 'number' && Number.isFinite(entry.maxInputTokens)) {
    preserved.maxInputTokens = entry.maxInputTokens
  }
  if (typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens)) {
    preserved.maxTokens = entry.maxTokens
  }
  if (Array.isArray(entry.input)) preserved.input = [...entry.input]
  if (typeof entry.reasoning === 'boolean') preserved.reasoning = entry.reasoning
  const ladder = entry.reasoningEfforts
  if (ladder !== null && typeof ladder === 'object' && !Array.isArray(ladder) && Object.keys(ladder).length > 0) {
    preserved.reasoningEfforts = { ...ladder as Record<string, unknown> }
  }
  return preserved
}

/**
 * The per-model fields only operator configuration can declare: a native-file
 * policy (`nativeFileInputs`) and wire-compatibility switches (`compat`) are
 * statements about the deployment's gateway, never facts a listing, the
 * registry, models.dev, or the installed catalog can disclose. A refresh
 * therefore carries them over from the configured entry (or the overlay
 * upsert that wrote it) for the same model id, and never invents them: a model
 * that never declared one keeps none.
 * @param entry - the configured (or overlay-upsert) model record.
 * @returns the operator-declared fields to keep; `{}` when the entry declares none.
 */
function preservedOperatorFields(entry: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {}
  const nativeFileInputs = entry.nativeFileInputs
  if (nativeFileInputs !== null && typeof nativeFileInputs === 'object' && !Array.isArray(nativeFileInputs)) {
    preserved.nativeFileInputs = { ...nativeFileInputs as Record<string, unknown> }
  }
  const compat = entry.compat
  if (compat !== null && typeof compat === 'object' && !Array.isArray(compat)) {
    preserved.compat = { ...compat as Record<string, unknown> }
  }
  return preserved
}

/**
 * Every configured field one merge keeps: the operator-only declarations on
 * any entry, plus the manual entry's own capability claims (which already
 * include the operator-only declarations, so the spread order is harmless).
 * @param entry - the configured model record.
 * @returns the fields a refresh must not overwrite.
 */
function preservedConfiguredFields(entry: Record<string, unknown>): Record<string, unknown> {
  return { ...preservedManualFields(entry), ...preservedOperatorFields(entry) }
}

/** One route's merged model list plus the configured ids the listing omitted. */
export interface ConfiguredMerge {
  /** Configured entries first (updated in place), then newly advertised entries. */
  models: Array<Record<string, unknown>>
  /** Configured ids the live listing did not advertise this pass. */
  unadvertised: string[]
}

/**
 * Merge a live listing into a route's configured `models` instead of
 * replacing them wholesale: an advertised id is refreshed from the listing,
 * an id the listing omits is kept exactly as configured and stamped
 * `source: 'configured'` so it survives a degraded pass (a hand-added
 * `source: 'manual'` entry keeps its own stamp and its own reasoning ladder),
 * and a live id the configuration does not name is appended. A refreshed
 * entry carries the listing's own effort ladder when the listing advertised
 * one; a listing that advertises nothing leaves the inference result, exactly
 * as before. This is the degraded-pass merge: the removal-aware membership
 * planner ({@link planRouteModels}) is the path a healthy pass takes.
 * @param route - provider route key, for models.dev scoping.
 * @param configured - the route's current `models` array, when any.
 * @param live - normalized live listing entries.
 * @param hints - the shipped hint table plus the owner override; defaults to
 *   the shipped table with no override.
 * @param routeProviderMap - the effective route → models.dev provider keys;
 *   defaults to the shipped table.
 * @param registryContext - the route's exact registry metadata lookup, when declared.
 * @returns the merged list and the configured ids nothing advertised.
 */
export function mergeConfiguredModels(
  route: string,
  configured: Array<Record<string, unknown>> | undefined,
  live: LiveModel[],
  hints: CapabilityHintContext = { table: loadCapabilityHints(), override: {} },
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
  registryContext: RegistryMetadataContext | undefined = undefined,
): ConfiguredMerge {
  const advertised = new Map<string, Record<string, unknown>>()
  for (const model of live) {
    if (advertised.has(model.id)) continue
    advertised.set(model.id, analyzeModel(route, model, hints, routeProviderMap, registryContext).settings)
  }
  const models: Array<Record<string, unknown>> = []
  const unadvertised: string[] = []
  const seen = new Set<string>()
  for (const entry of configured ?? []) {
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
    if (id === undefined) {
      models.push(entry)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    const fresh = advertised.get(id)
    if (fresh !== undefined) {
      // A manual entry is the operator's own claim: the listing refreshes the
      // rest of the record, and a ladder they declared stays theirs. Every
      // entry keeps its operator-only per-model declarations
      // (`nativeFileInputs`, `compat`): no disclosure can restate them, so a
      // merge that dropped them would silently disable media or wire
      // behavior the operator configured.
      models.push(entry.source === 'manual'
        ? { ...fresh, ...preservedConfiguredFields(entry), source: 'manual' }
        : { ...fresh, ...preservedOperatorFields(entry) })
      continue
    }
    const keptSource = entry.source === 'manual' || entry.source === 'pinned-in-use' ? entry.source : 'configured'
    models.push({ ...entry, source: keptSource })
    unadvertised.push(id)
  }
  for (const [id, entry] of advertised) {
    if (seen.has(id)) continue
    seen.add(id)
    models.push(entry)
  }
  return { models, unadvertised }
}

/** Whether one entry carries a usable `firstSeenAt` stamp. */
function firstSeenAtOf(entry: Record<string, unknown>): number | undefined {
  const value = entry.firstSeenAt
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The model ids one models.dev provider carries, as the exact published key
 * set. A case-folded spelling is a different id and never confirms membership.
 * `undefined` when the fresh snapshot does not carry the provider at all —
 * membership then has no catalog authority for the route.
 * @param providerKey - the exact models.dev provider key.
 * @returns the id set, or undefined when the provider is absent.
 */
function modelsDevProviderModelIds(providerKey: string): Set<string> | undefined {
  const provider = loadModelsDev()[providerKey]
  if (provider?.models === undefined) return undefined
  return new Set(Object.keys(provider.models))
}

/** One route-local model reference that must never be pruned silently. */
export interface RouteModelReference {
  /** The referenced model id on this route. */
  id: string
  /**
   * Why it is referenced (`agent-default-model`, `chain:<id>`, `persona:<seat>`,
   * `subagent-allowed-model`, `favorite`).
   */
  reason: string
}

/**
 * Collect every model of `route` referenced by the default model selection,
 * the `enpoi-orchestration.chains` links and `personas` seats, the subagent
 * allowed-model routes, and the picker favorites. Malformed entries are
 * ignored: a reference nothing can express is no reference.
 * @param defaultModel - the `agent-default-model` settings document, when read.
 * @param orchestration - the `enpoi-orchestration` settings document, when read.
 * @param route - the provider route key whose models are collected.
 * @param subagentSelections - one subagent model-selection document, or an
 *   array of them when both namespace spellings are readable.
 * @returns the route-local references with their reasons.
 */
export function referencedRouteModels(
  defaultModel: unknown,
  orchestration: unknown,
  route: string,
  subagentSelections: unknown = undefined,
): RouteModelReference[] {
  const found: RouteModelReference[] = []
  const pushRoute = (entry: unknown, providerKey: 'provider', modelKey: 'model' | 'modelId', reason: string): void => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
    const candidate = entry as Record<string, unknown>
    const model = candidate[modelKey]
    if (candidate[providerKey] === route && typeof model === 'string' && model !== '') {
      found.push({ id: model, reason })
    }
  }
  pushRoute(defaultModel, 'provider', 'model', 'agent-default-model')
  if (orchestration !== null && typeof orchestration === 'object' && !Array.isArray(orchestration)) {
    const document = orchestration as { chains?: unknown, personas?: unknown, uiPreferences?: unknown }
    const chains = document.chains
    if (chains !== null && typeof chains === 'object' && !Array.isArray(chains)) {
      for (const [chainId, raw] of Object.entries(chains as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        const links = (raw as { links?: unknown }).links
        if (!Array.isArray(links)) continue
        for (const link of links) pushRoute(link, 'provider', 'model', `chain:${chainId}`)
      }
    }
    // A seat's direct provider/model route is the same operator claim a chain
    // link is; a seat that names only a chain is covered by that chain's links.
    const personas = document.personas
    if (personas !== null && typeof personas === 'object' && !Array.isArray(personas)) {
      for (const [seat, raw] of Object.entries(personas as Record<string, unknown>)) {
        pushRoute(raw, 'provider', 'model', `persona:${seat}`)
      }
    }
    const preferences = document.uiPreferences
    if (preferences !== null && typeof preferences === 'object' && !Array.isArray(preferences)) {
      const favorites = (preferences as { favorites?: unknown }).favorites
      if (Array.isArray(favorites)) {
        for (const favorite of favorites) pushRoute(favorite, 'provider', 'modelId', 'favorite')
      }
    }
  }
  for (const selection of Array.isArray(subagentSelections) ? subagentSelections : [subagentSelections]) {
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) continue
    const allowed = (selection as { allowedModels?: unknown }).allowedModels
    if (!Array.isArray(allowed)) continue
    for (const entry of allowed) pushRoute(entry, 'provider', 'model', 'subagent-allowed-model')
  }
  return found
}

/**
 * Merge a live listing into the discovered-cache records, without provenance stamps.
 * @param route - provider route key, for models.dev scoping.
 * @param live - normalized live listing entries.
 * @param hints - the shipped hint table plus the owner override; defaults to
 *   the shipped table with no override.
 * @param routeProviderMap - the effective route → models.dev provider keys;
 *   defaults to the shipped table.
 * @param registryContext - the route's exact registry metadata lookup, when declared.
 * @returns the discovered records, minus the provenance stamps the writer adds.
 */
export function mergeDiscoveredModels(
  route: string,
  live: LiveModel[],
  hints: CapabilityHintContext = { table: loadCapabilityHints(), override: {} },
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
  registryContext: RegistryMetadataContext | undefined = undefined,
): Array<Omit<DiscoveredFileModel, 'source' | 'discoveredAt'>> {
  return live.map(model => analyzeModel(route, model, hints, routeProviderMap, registryContext).discovered)
}

/** The `uiPreferences` fields one prune cleaned; a field nothing changed in is absent. */
export interface PrunedReferenceCleanup {
  /** The full `hiddenModels` map, when this route's entry lost ids. */
  hiddenModels?: Record<string, string[]>
  /** The full `favorites` array, when this route lost entries. */
  favorites?: Array<Record<string, unknown>>
}

/**
 * Drop pruned ids from `enpoi-orchestration.uiPreferences`: the route's
 * `hiddenModels` entry and any `favorites` reference to the route. Fields
 * nothing changed in are omitted, so an unchanged document is never rewritten.
 * @param orchestration - the `enpoi-orchestration` settings document, when read.
 * @param route - the provider route whose ids were pruned.
 * @param removed - the pruned model ids.
 * @returns the cleaned fields; `{}` when nothing referenced them.
 */
export function pruneRouteReferences(
  orchestration: unknown,
  route: string,
  removed: readonly string[],
): PrunedReferenceCleanup {
  const cleanup: PrunedReferenceCleanup = {}
  if (removed.length === 0) return cleanup
  if (orchestration === null || typeof orchestration !== 'object' || Array.isArray(orchestration)) return cleanup
  const preferences = (orchestration as { uiPreferences?: unknown }).uiPreferences
  if (preferences === null || typeof preferences !== 'object' || Array.isArray(preferences)) return cleanup
  const removedSet = new Set(removed)
  const hidden = (preferences as { hiddenModels?: unknown }).hiddenModels
  if (hidden !== null && typeof hidden === 'object' && !Array.isArray(hidden)) {
    const map = hidden as Record<string, unknown>
    const list = map[route]
    if (Array.isArray(list)) {
      const next = list.filter(id => typeof id !== 'string' || !removedSet.has(id))
      if (next.length !== list.length) {
        const nextMap = { ...(map as Record<string, string[]>) }
        // An empty route list is canonicalized away: the client reads an
        // absent key and an empty list as the same "nothing hidden here".
        if (next.length === 0) Reflect.deleteProperty(nextMap, route)
        else nextMap[route] = next as string[]
        cleanup.hiddenModels = nextMap
      }
    }
  }
  const favorites = (preferences as { favorites?: unknown }).favorites
  if (Array.isArray(favorites)) {
    const next = favorites.filter((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return true
      const reference = entry as { provider?: unknown, modelId?: unknown }
      return reference.provider !== route || typeof reference.modelId !== 'string' || !removedSet.has(reference.modelId)
    })
    if (next.length !== favorites.length) cleanup.favorites = next as Array<Record<string, unknown>>
  }
  return cleanup
}

/** Which listing answered a route's membership question this pass. */
export type RouteAuthority = 'catalog' | 'endpoint' | 'none'

/** The audit of one route's membership decision. */
export interface RouteRefreshReport {
  /** Ids the membership decision dropped this pass; overlay removals are not membership decisions. */
  removed: string[]
  /** Ids kept only because they are referenced and no longer a member (or overlay-removed). */
  deprecated: string[]
  /** Whether removals were withheld (gate, guard, or no authority). */
  degraded: boolean
  /** Why removals were withheld, when they were. */
  degradedReason?: string
  /** Membership authority applied this pass. */
  authority: RouteAuthority
  /** Which listing answered: the live endpoint, the bundled catalog, or neither. */
  source: 'live' | 'catalog' | 'none'
}

/** One route's planned settings records plus the removal audit. */
export interface PlannedRouteModels {
  models: Array<Record<string, unknown>>
  report: RouteRefreshReport
}

/** The inputs of one route's membership decision. */
export interface PlanRouteInput {
  /** Provider route key, for models.dev scoping and analysis. */
  route: string
  /** The route's current `models` array, when any. */
  configured: Array<Record<string, unknown>> | undefined
  /** The normalized endpoint listing, or `undefined` when the fetch failed. */
  live: LiveModel[] | undefined
  /** Whether the installed pi-ai catalog describes the route. */
  catalogRoute: boolean
  /** Whether the live route profile explicitly declares endpoint catalog authority. */
  endpointAuthority?: boolean | undefined
  /** The exact primary models.dev provider key this route declares, when one does. */
  catalogProviderKey?: string | undefined
  /** Whether the endpoint listing fetch succeeded this pass. */
  endpointFresh: boolean
  /** Whether the models.dev catalogue is fresh (online refresh, or cache younger than 48 h). */
  catalogFresh: boolean
  /**
   * How long an endpoint-only id survives before pruning; defaults to
   * {@link ENDPOINT_ONLY_GRACE_MS}.
   */
  endpointGraceMs?: number | undefined
  /** Route-level ids the deployment pins against removal. */
  pinnedModels?: readonly string[] | undefined
  /** The route's maintained catalog overlay, when the file names one. */
  overlay?: RouteCatalogOverlay | undefined
  /** Route-local references that must never be pruned silently. */
  references?: readonly RouteModelReference[] | undefined
  /** The pass clock; injected by tests. */
  now: number
  /** The shipped hint table plus the owner override. */
  hints?: CapabilityHintContext | undefined
  /** The effective route → models.dev provider keys. */
  routeProviderMap?: RouteProviderMap | undefined
  /** The route's exact registry metadata lookup, when its declaration names one. */
  metadata?: RegistryMetadataContext | undefined
  /**
   * Whether this route may authoritatively advertise zero models. Set from the
   * configured route profile's explicit `catalogAuthority: 'endpoint'`; a
   * registry-metadata declaration never supplies it.
   */
  allowEmpty?: boolean | undefined
  /** The durable free-tier gate the route's profile declares, when any. */
  freeTierGate?: FreeTierGate | undefined
  /** Which listing answered the endpoint authority question. */
  source?: 'live' | 'catalog' | undefined
  /** Force removal execution even if removals drop >50% (e.g. manual refresh or authoritative endpoint). */
  force?: boolean | undefined
}

/**
 * Plan one route's settings records under the authoritative-membership rules.
 *
 * On a catalog route whose declared primary models.dev provider carries a
 * model set in the fresh snapshot, membership is the endpoint-advertised ids
 * that set confirms, plus protected entries (`source: 'manual'`, pinned ids,
 * overlay `upsert` ids), plus endpoint-only ids first seen inside the 14-day
 * grace, minus the overlay's `remove` ids. On any other route with a
 * successful listing fetch the advertised list itself is the authority, and
 * removals run on that listing alone — the catalogue's freshness gates a
 * catalog-authority intersection, never an endpoint-authoritative prune.
 * Removals abort when the effective set would be empty or, on an unattended
 * pass, would drop more than half of the route's stored models; `force`
 * (the operator's manual refresh) bypasses the shrink guard. A referenced
 * model that would be pruned is kept, stamped `deprecated: true` and
 * `source: 'pinned-in-use'`, and named in the report. An overlay `remove` id
 * follows the same protections: a `source: 'manual'` entry or a `pinnedModels`
 * id stays as the operator's record, and a referenced id stays marked
 * `deprecated: true`. A degraded pass is the legacy merge: nothing is
 * removed, though an overlay removal still applies to unprotected ids.
 * @param input - the route, its stored records, the listing, and the gate facts.
 * @returns the records to persist and the removal audit.
 */
export function planRouteModels(input: PlanRouteInput): PlannedRouteModels {
  const configured = input.configured ?? []
  const live = input.live
  const endpointGraceMs = input.endpointGraceMs ?? ENDPOINT_ONLY_GRACE_MS
  const hints = input.hints ?? { table: loadCapabilityHints(), override: {} }
  const routeProviderMap = input.routeProviderMap ?? DEFAULT_ROUTE_PROVIDER_MAP
  const advertised = new Map<string, Record<string, unknown>>()
  for (const model of live ?? []) {
    if (advertised.has(model.id)) continue
    advertised.set(model.id, analyzeModel(input.route, model, hints, routeProviderMap, input.metadata).settings)
  }

  const endpointAuthority = input.endpointAuthority === true
  const catalogIds = !endpointAuthority && input.catalogRoute && input.catalogProviderKey !== undefined
    ? modelsDevProviderModelIds(input.catalogProviderKey)
    : undefined
  const authority: RouteAuthority = live === undefined
    ? 'none'
    : catalogIds !== undefined
      ? 'catalog'
      : input.catalogRoute && !endpointAuthority ? 'none' : 'endpoint'
  const report: RouteRefreshReport = {
    removed: [],
    deprecated: [],
    degraded: false,
    authority,
    source: live === undefined ? 'none' : input.source ?? 'live',
  }

  const configuredById = new Map<string, Record<string, unknown>>()
  for (const entry of configured) {
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
    if (id !== undefined && !configuredById.has(id)) configuredById.set(id, entry)
  }

  // Grace: endpoint-advertised ids models.dev does not carry yet. An id already
  // stored without a `firstSeenAt` is long-standing, so the first pass under
  // this logic prunes it; an id first advertised by this pass is stamped now.
  const grace = new Set<string>()
  if (authority === 'catalog' && catalogIds !== undefined) {
    for (const id of advertised.keys()) {
      if (catalogIds.has(id)) continue
      const prior = configuredById.get(id)
      const firstSeen = prior === undefined ? input.now : firstSeenAtOf(prior)
      if (firstSeen !== undefined && input.now - firstSeen < endpointGraceMs) grace.add(id)
    }
  }

  const pinned = new Set(input.pinnedModels ?? [])
  const overlayUpserts = new Set<string>()
  for (const entry of input.overlay?.upsert ?? []) {
    const id = listingString(entry.id)
    if (id !== undefined) overlayUpserts.add(id)
  }
  const protectedIds = new Set<string>()
  // Operator records outrank an overlay removal; an overlay upsert does not,
  // so an id the same overlay both removes and upserts is still removable.
  const overlayKeepIds = new Set<string>(pinned)
  for (const [id, entry] of configuredById) {
    if (entry.source === 'manual' || pinned.has(id)) overlayKeepIds.add(id)
    if (entry.source === 'manual' || pinned.has(id) || overlayUpserts.has(id)) protectedIds.add(id)
  }
  // A pinned or upsert id that the endpoint advertises but the configuration
  // does not name is protected too; upserts without a listing record are
  // appended by the overlay after this plan.
  for (const id of pinned) if (advertised.has(id)) protectedIds.add(id)
  for (const id of overlayUpserts) if (advertised.has(id)) protectedIds.add(id)

  const references = new Map<string, string[]>()
  for (const reference of input.references ?? []) {
    const reasons = references.get(reference.id) ?? []
    if (!reasons.includes(reference.reason)) reasons.push(reference.reason)
    references.set(reference.id, reasons)
  }

  const memberBase = new Set<string>()
  if (authority === 'catalog' && catalogIds !== undefined) {
    for (const id of advertised.keys()) {
      if (catalogIds.has(id)) memberBase.add(id)
    }
  } else if (authority === 'endpoint') {
    for (const id of advertised.keys()) memberBase.add(id)
  }
  const isMember = (id: string): boolean => memberBase.has(id) || protectedIds.has(id) || grace.has(id)

  // The freshness each authority needs: an endpoint-authority route's members
  // are exactly its listing's advertised ids, so the listing is the only
  // source that must be fresh; catalogue freshness is required only where
  // membership itself is the endpoint ∩ models.dev intersection. Stale
  // catalogue metadata never withholds an endpoint-authoritative prune.
  const removalsAllowed = authority === 'endpoint'
    ? input.endpointFresh
    : authority === 'catalog' && input.endpointFresh && input.catalogFresh
  let keepAll = !removalsAllowed
  if (keepAll) {
    report.degraded = true
    report.degradedReason = live === undefined
      ? 'the endpoint listing could not be fetched'
      : !input.endpointFresh
        ? 'the endpoint listing fetch did not succeed'
        : authority === 'catalog' && !input.catalogFresh
          ? 'the models.dev catalogue is stale (no online refresh and the cache is 48 h or older)'
          : input.catalogRoute
            ? 'the route has no declared models.dev catalog mapping'
            : 'no membership authority'
  } else {
    const currentIds = [...configuredById.keys()]
    const wouldRemove = currentIds.filter(id => !isMember(id) && !references.has(id))
    const skipWithholdGuard = input.force === true
    const emptySet = memberBase.size === 0 && protectedIds.size === 0 && grace.size === 0
    const emptyAllowed = input.allowEmpty === true && authority === 'endpoint'
    if (emptySet && !emptyAllowed) {
      keepAll = true
      report.degraded = true
      report.degradedReason = 'the effective model set would be empty'
    } else if (!skipWithholdGuard
      && !(emptyAllowed && wouldRemove.length === currentIds.length)
      && currentIds.length > 0 && wouldRemove.length * 2 > currentIds.length) {
      keepAll = true
      report.degraded = true
      report.degradedReason = `removals would drop ${String(wouldRemove.length)} of ${String(currentIds.length)} stored models (more than half)`
    }
  }

  const models: Array<Record<string, unknown>> = []
  if (keepAll) {
    models.push(...(live === undefined ? configured : mergeConfiguredModels(input.route, configured, live, hints, routeProviderMap, input.metadata).models))
  } else {
    const seen = new Set<string>()
    for (const entry of configured) {
      const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
      if (id === undefined) {
        models.push(entry)
        continue
      }
      if (seen.has(id)) continue
      seen.add(id)
      const fresh = advertised.get(id)
      const isGrace = grace.has(id)
      if (!isMember(id)) {
        const reasons = references.get(id)
        if (reasons !== undefined) {
          models.push({ ...entry, source: 'pinned-in-use', deprecated: true })
          report.deprecated.push(id)
        } else {
          report.removed.push(id)
        }
        continue
      }
      if (fresh !== undefined) {
        models.push({
          ...fresh,
          // The healthy pass refreshes the record too; a manual entry's own
          // ladder is the operator's claim and survives it, and every entry
          // keeps the operator-only declarations (`nativeFileInputs`,
          // `compat`) no disclosure can restate.
          ...preservedConfiguredFields(entry),
          ...entry.source === 'manual' ? { source: 'manual' } : {},
          ...isGrace ? { firstSeenAt: firstSeenAtOf(entry) ?? input.now } : {},
        })
      } else if (isGrace) {
        models.push({ ...entry, firstSeenAt: firstSeenAtOf(entry) ?? input.now })
      } else {
        models.push(entry)
      }
    }
    for (const [id, fresh] of advertised) {
      if (seen.has(id)) continue
      seen.add(id)
      if (!isMember(id)) continue
      models.push(grace.has(id) ? { ...fresh, firstSeenAt: input.now } : fresh)
    }
  }
  // An overlay removal never deletes an operator record or a live reference.
  // A referenced id stays as a deprecated record so a default/chain/persona/
  // subagent/favorite keeps resolving the last facts it had; it never becomes
  // a current member again until the endpoint advertises it.
  const overlaid = applyCatalogOverlay(models, input.overlay, {
    keep: overlayKeepIds,
    deprecate: new Set(references.keys()),
  })
  for (const id of input.overlay?.remove ?? []) {
    if (!references.has(id) || overlayKeepIds.has(id)) continue
    if (!models.some(model => model.id === id)) continue
    if (!report.deprecated.includes(id)) report.deprecated.push(id)
  }
  return { models: applyFreeTierGate(overlaid, input.freeTierGate), report }
}

/** The value `providerSync.refreshRoute` returns to the client. */
export interface ProviderSyncRouteRefreshValue {
  route: string
  /** The route's planned settings records; the caller persists them. */
  models: Array<Record<string, unknown>>
  /**
   * Every id the route no longer carries — membership removals and overlay
   * removals alike. A client that merges stored rows into this list must drop
   * these or an overlay removal would come back on its next read.
   */
  removed: string[]
  /** Ids kept only for a reference (deprecated upstream). */
  deprecated: string[]
  /** Whether removals were withheld this refresh. */
  degraded: boolean
  /** Why removals were withheld, when they were. */
  degradedReason?: string
  /** Which listing answered. */
  source: 'live' | 'catalog' | 'none'
  /** The membership authority the plan applied. */
  authority: RouteAuthority
  /** The epoch milliseconds the plan ran at. */
  fetchedAt: number
}

/**
 * What one route's manual full-pass entry answered:
 * - `ok` — its listing (or bundled catalog) answered and the route was planned;
 * - `unreachable` — the route has an endpoint but the listing fetch failed;
 * - `no-listing` — the route has no endpoint to list;
 * - `static-catalog` — the installed pi-ai catalog serves the route and it is
 *   not configured, so there is no profile to write a discovered listing into.
 */
export type ProviderSyncRouteState = 'ok' | 'unreachable' | 'no-listing' | 'static-catalog'

/** One route's outcome from a manual full refresh. */
export interface ProviderSyncRouteStatus {
  /** The provider route key. */
  route: string
  /** What this pass could do for the route. */
  status: ProviderSyncRouteState
  /** Which listing answered: the live endpoint, the bundled catalog, or neither. */
  source: 'live' | 'catalog' | 'none'
  /** The membership authority the plan applied. */
  authority: RouteAuthority
  /** Models the listing advertised this pass, when it answered. */
  advertised?: number
  /** The route's planned model count (settings records for a configured route). */
  modelCount: number
  /** Every id the route no longer carries (membership plus overlay removals). */
  removed: string[]
  /** Ids kept only for a reference (deprecated upstream). */
  deprecated: string[]
  /** Whether removals were withheld this pass. */
  degraded: boolean
  /** Why removals were withheld, when they were. */
  degradedReason?: string
  /** Whether the discovered-model cache now holds this pass's listing. */
  cached: boolean
  /** Why the route was not probed, or the listing failure line. */
  message?: string
  /** The epoch milliseconds the route finished at. */
  fetchedAt: number
}

/** The value `providerSync.refreshRoutes` returns to the client. */
export interface ProviderSyncRoutesRefreshValue {
  /** The epoch milliseconds the pass ran at. */
  refreshedAt: number
  /** One entry per discoverable route, in settings order. */
  routes: ProviderSyncRouteStatus[]
}

function stringifyComparable(models: Array<Record<string, unknown>> | undefined): string {
  return JSON.stringify(
    (models ?? []).map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxInputTokens: m.maxInputTokens,
      maxTokens: m.maxTokens,
      input: m.input ?? null,
      reasoning: m.reasoning ?? null,
      // The ladder's wire spellings are part of the record: a provider that
      // renames a level's wire value (or changes which levels exist) must be
      // written, not treated as an unchanged key set.
      reasoningEfforts: m.reasoningEfforts !== null && typeof m.reasoningEfforts === 'object'
        && !Array.isArray(m.reasoningEfforts)
        ? Object.entries(m.reasoningEfforts as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
        : null,
      unsupportedReasoningEfforts: m.unsupportedReasoningEfforts ?? null,
      tools: m.tools ?? null,
      // Operator-only declarations are part of the record: a change (or a
      // refresh that would drop them) must be written, not treated as equal.
      nativeFileInputs: m.nativeFileInputs ?? null,
      compat: m.compat ?? null,
      cost: m.cost ?? null,
      releaseDate: m.releaseDate ?? null,
      costTiers: m.costTiers ?? null,
      gated: m.gated ?? null,
      gateReason: m.gateReason ?? null,
      capabilityHints: m.capabilityHints ?? null,
      unverified: m.unverified ?? null,
      source: m.source ?? null,
      deprecated: m.deprecated ?? null,
      firstSeenAt: m.firstSeenAt ?? null,
    })),
  )
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('enpoi-provider-sync')
  const endpoints = value(config.endpoints) ?? {}
  const sessionHeaders = value(config.sessionHeaders) ?? {}
  const modelsDevUrl = value(config.modelsDevUrl) ?? DEFAULT_MODELS_DEV_URL
  const legacyCapacityDefaults = value(config.capacityDefaults) ?? {}
  if (Object.keys(legacyCapacityDefaults).length > 0) {
    // Accepted for compatibility, never persisted: a route-level prefix or
    // default is the operator's assumption, not a disclosure about each model.
    reportSyncDiagnostic(
      'provider-sync/capacity-defaults',
      'capacityDefaults is an explicit operator assumption and is no longer written into model records;'
      + ' declare exact per-model capacities or a catalog-overlay upsert when a value must reach the catalog',
    )
  }
  // The configured route map extends the shipped table key by key: a route the
  // deployment newly serves is mapped from configuration alone.
  const routeProviderMap: RouteProviderMap = { ...DEFAULT_ROUTE_PROVIDER_MAP, ...value(config.routeProviderMap) }
  // Route declarations are data: a renamed user-created instance adds its
  // route key and the same declaration; no model-id prefix is ever consulted.
  const metadataSources: Record<string, RouteMetadataSourceConfig> = {
    ...DEFAULT_ROUTE_METADATA_SOURCES,
    ...value(config.metadataSources),
  }
  /** Per-route opt-in refresh clients; only a declared URL + version creates one. */
  const registrySources = new Map<string, RegistryMetadataSource>()
  const registryAbort = new AbortController()
  ctx.effect(() => () => { registryAbort.abort() }, 'enpoi-provider-sync registry metadata')
  for (const [route, declaration] of Object.entries(metadataSources)) {
    if (declaration.refreshUrl === undefined || declaration.refresh === false) continue
    if (declaration.sourceVersion === undefined || declaration.sourceVersion.length === 0) {
      // A URL alone cannot produce honest provenance: the bundled label must
      // never be applied to an operator's branch/master document.
      reportSyncDiagnostic(
        'provider-sync/registry-metadata',
        `route ${route}: refreshUrl declared without sourceVersion; using the bundled baseline until the actual source version is configured`,
      )
      continue
    }
    registrySources.set(route, createRegistryMetadataSource({
      url: declaration.refreshUrl,
      sourceVersion: declaration.sourceVersion,
      signal: registryAbort.signal,
    }))
  }
  /** Baseline snapshot index, loaded once and reused for every declared route. */
  let registryBaseline: RegistryMetadataIndex | null | undefined
  /** One in-flight metadata refresh shared by overlapping passes. */
  let registryRefresh: Promise<void> | undefined

  /**
   * Load the pinned registry baseline once. Failure disables registry metadata
   * for declared routes and reports the reason instead of failing a sync pass.
   * @returns the parsed index, or undefined when the bundled snapshot is unusable.
   */
  function registryBaselineIndex(): RegistryMetadataIndex | undefined {
    if (registryBaseline !== undefined) return registryBaseline ?? undefined
    const started = Date.now()
    try {
      const index = loadBundledRegistryMetadataIndex()
      registryBaseline = index
      const models = [...index.channels.values()].reduce((count, entries) => count + entries.length, 0)
      logger.info(`registry metadata baseline ${index.source.sourceVersion}: ${String(models)} model(s) in ${String(Date.now() - started)} ms`)
      return index
    } catch (error) {
      registryBaseline = null
      reportSyncDiagnostic(
        'provider-sync/registry-metadata',
        `registry metadata baseline could not be loaded — ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  /**
   * Refresh every declared route's configured registry URL, bounded by the
   * helper's timeout/byte limits and reusing one in-flight promise. A failed
   * refresh keeps the last good state and falls back to the bundled baseline.
   * @returns fulfillment after every declared source settled.
   */
  function refreshRegistrySources(): Promise<void> {
    if (registryRefresh !== undefined) return registryRefresh
    if (registryAbort.signal.aborted || registrySources.size === 0) return Promise.resolve()
    const started = Date.now()
    registryRefresh = (async () => {
      // One bounded task per declared source; they run concurrently and share
      // the single in-flight promise so startup/hourly/manual callers never
      // serialize 15-second fetches or stack duplicate refreshes.
      await Promise.allSettled([...registrySources].map(async ([route, source]) => {
        const before = Date.now()
        let state: RegistryMetadataSourceState
        try {
          state = await source.refresh()
        } catch (error) {
          if (registryAbort.signal.aborted) return
          reportSyncDiagnostic(
            'provider-sync/registry-metadata',
            `route ${route}: registry refresh failed — ${error instanceof Error ? error.message : String(error)}`,
          )
          return
        }
        if (registryAbort.signal.aborted) return
        const models = state.index === null
          ? 0
          : [...state.index.channels.values()].reduce((count, entries) => count + entries.length, 0)
        logger.info(
          `route ${route}: registry metadata ${state.stale ? 'kept last-good' : 'refreshed'}`
          + ` (${String(models)} model(s), ${String(Date.now() - before)} ms)`,
        )
        if (state.diagnostics.length > 0) {
          reportSyncDiagnostic(
            'provider-sync/registry-metadata',
            `route ${route}: registry refresh diagnostics — ${state.diagnostics.slice(0, 3).map(diagnostic => diagnostic.message).join('; ')}`,
          )
        }
      }))
      if (!registryAbort.signal.aborted) {
        logger.debug(`registry metadata refresh finished in ${String(Date.now() - started)} ms`)
      }
    })().finally(() => { registryRefresh = undefined })
    return registryRefresh
  }

  /**
   * The lookup context for one declared route. A refreshed index wins over the
   * pinned baseline; an undeclared route never reads registry metadata.
   * @param route - configured provider route id.
   * @returns the context, or undefined when the route declares none or no index is available.
   */
  function metadataContextFor(route: string): RegistryMetadataContext | undefined {
    const declaration = metadataSources[route]
    if (declaration === undefined) return undefined
    const index = registrySources.get(route)?.current()?.index ?? registryBaselineIndex()
    if (index === undefined) return undefined
    return {
      index,
      ...declaration.channel === undefined ? {} : { channel: declaration.channel },
      ...declaration.owner === undefined ? {} : { owner: declaration.owner },
      ...declaration.ownerChannels === undefined ? {} : { ownerChannels: declaration.ownerChannels },
    }
  }

  /**
   * Whether the live llm-pi-ai profile explicitly declares endpoint catalog
   * authority. Registry metadata declarations never supply this: only the
   * configured route profile may make an empty listing authoritative.
   * @param settings - the settings seam.
   * @param route - the configured provider route id.
   * @returns true only for an explicit `catalogAuthority: 'endpoint'`.
   */
  function configuredEndpointAuthority(settings: SettingsSeam, route: string): boolean {
    return sectionOf(settings, LLM_NS)?.providers?.[route]?.catalogAuthority === 'endpoint'
  }

  /**
   * Report how many advertised ids the declared registry resolved exactly.
   * Provenance fields are not persisted: the settings/discovered schemas have
   * no source/version field, so this diagnostic is the only visible authority.
   * @param route - provider route id.
   * @param live - the normalized listing, when fetched.
   * @param metadata - the route's lookup context, when declared.
   */
  function reportRegistryUsage(
    route: string,
    live: LiveModel[] | undefined,
    metadata: RegistryMetadataContext | undefined,
  ): void {
    if (live === undefined || live.length === 0 || metadata === undefined) return
    let resolved = 0
    const unsupported = new Set<string>()
    for (const model of live) {
      const record = registryMetadataFor(metadata, model)
      if (record === undefined) continue
      resolved += 1
      for (const level of record.effort?.unsupportedLevels ?? []) unsupported.add(level)
    }
    reportSyncDiagnostic(
      'provider-sync/registry-metadata',
      `route ${route}: registry metadata ${metadata.index.source.sourceVersion} resolved ${String(resolved)}/${String(live.length)} model(s)`
      + ` (${String(live.length - resolved)} unknown fall through to models.dev/catalog)`
      + (unsupported.size === 0 ? '' : `; unsupported raw effort names (diagnostic only): ${[...unsupported].join(', ')}`)
      + '; provenance is diagnostic-only',
    )
  }

  /**
   * Record one coded incident (kind `provider-sync/...`) and log it. The
   * diagnostics service is optional: when absent the log line still fires.
   */
  function reportSyncDiagnostic(kind: string, message: string): void {
    let code: string | undefined
    try {
      const diagnostics = ctx.get('diagnostics') as
        | { report?: (request: { kind: string; message: string }) => { code?: string } }
        | undefined
      code = diagnostics?.report?.({ kind, message })?.code
    } catch {
      // The incident channel is observability only; the log line below still fires.
    }
    logger.warn(code === undefined ? message : `${message} (diagnostics ${code})`)
  }

  // Load models.dev database on startup and refresh online in background
  loadModelsDev()
  void refreshModelsDevOnline(reportSyncDiagnostic, modelsDevUrl)
  void refreshRegistrySources()

  /** Last successfully loaded overlay document; a malformed edit must not discard it. */
  let lastGoodOverlays: CatalogOverlayDocument | undefined

  /**
   * Read the maintained overlays once per pass. A malformed file is refused
   * whole (never half-applied) and reported; later passes keep the last good
   * document until the file parses again.
   * @returns the current overlay document, or the last good one when this read failed.
   */
  function loadOverlays(): CatalogOverlayDocument {
    try {
      const document = loadCatalogOverlays()
      lastGoodOverlays = document
      return document
    } catch (error) {
      reportSyncDiagnostic('provider-sync/catalog-overlays', error instanceof Error ? error.message : String(error))
      return lastGoodOverlays ?? {}
    }
  }

  /**
   * Read the shipped hint table and the owner's override once per pass. A
   * malformed override (or packaging mistake in the shipped table) is reported
   * and the pass continues with hints disabled, so the floor — never a guess —
   * is what gets persisted.
   */
  function loadHints(): CapabilityHintContext {
    try {
      return { table: loadCapabilityHints(), override: loadCapabilityHintsOverride() }
    } catch (error) {
      reportSyncDiagnostic('provider-sync/capability-hints', error instanceof Error ? error.message : String(error))
      return { table: { reasoning: [], image: [], audio: [], video: [], files: [], toolsExclude: [] }, override: {} }
    }
  }

  const credentials = ctx.get('credentials') as CredentialsSeam | undefined

  /**
   * Resolve the credential one route's listing probe presents. A keyless
   * route fetches anonymously; a pooled route uses its highest-priority
   * enabled identity's credential.
   * @param profile - the route's configured profile, when it has one.
   * @returns the credential value, or undefined when none resolves.
   */
  async function resolveListingKey(profile: ProviderProfile | undefined): Promise<string | undefined> {
    if (profile?.keyless === true) return undefined
    if (profile?.apiKeyEnv !== undefined) {
      const hit = credentials === undefined ? undefined : await credentials.resolve(profile.apiKeyEnv)
      return hit?.value
    }
    if (profile?.pool?.identities !== undefined && profile.pool.identities.length > 0) {
      const primary = [...profile.pool.identities]
        .filter(identity => identity.enabled !== false)
        .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))[0]
      if (primary !== undefined) {
        const hit = credentials === undefined ? undefined : await credentials.resolve(primary.credentialRef)
        return hit?.value
      }
    }
    return undefined
  }

  /** Revision fence for one namespace; `undefined` when the namespace is not described. */
  function revisionOf(settings: SettingsSeam, ns: string): number | undefined {
    return settings.describe().find(entry => entry.ns === ns)?.revision
  }

  /**
   * Read every route-local reference from the live settings documents. The
   * caller runs this on the initial plan and on every conflict retry, so a
   * persona, chain, favorite, default, or subagent authorization written while
   * a write was in flight protects its model in the re-plan.
   * @param settings - the settings seam.
   * @param route - the provider route key.
   * @returns the route-local references with their reasons.
   */
  function routeReferences(settings: SettingsSeam, route: string): RouteModelReference[] {
    return referencedRouteModels(
      readSettingsDocument(settings, AGENT_DEFAULT_MODEL_NS),
      readSettingsDocument(settings, ORCHESTRATION_NAMESPACE),
      route,
      SUBAGENT_MODEL_SELECTION_NAMESPACES
        .map(ns => readSettingsDocument(settings, ns))
        .filter((document): document is Record<string, unknown> => document !== undefined),
    )
  }

    interface RouteComputeOutcome {
      route: string
      /** The settings namespace that owns the route. */
      ns: string
      /** Whether the route has a settings profile (a write is skipped otherwise). */
      hasProfile: boolean
      /** The route's stored records, when it has a profile. */
      configured: Array<Record<string, unknown>>
      /** Whether the live profile explicitly declares endpoint catalog authority. */
      endpointAuthority: boolean
      overlay: RouteCatalogOverlay | undefined
      live: LiveModel[] | undefined
      baseURL: string
      models: Array<Record<string, unknown>>
      report: RouteRefreshReport
      /**
       * Ids the route lost this pass — membership removals plus ids the
       * overlay dropped — for visibility cleanup. Distinct from
       * `report.removed`, which audits membership decisions only.
       */
      cleanup: string[]
      /** Configured ids the listing did not advertise this pass. */
      unadvertised: string[]
      advertisedCount?: number
      /** The listing failure, when the fetch did not answer usable models. */
      fetchError?: string
      /** Route-local references (default model, chain links, favorites) this pass read. */
      references: RouteModelReference[]
      /** The route's exact registry metadata lookup, when its declaration names one. */
      metadata?: RegistryMetadataContext | undefined
      /** The fetched facts a settings-conflict retry re-plans against. */
      plan: PlanRecipe
    }

    /**
     * The fetched facts one plan uses. A settings-conflict retry re-plans from
     * these without refetching the listing or the catalogue.
     */
    interface PlanRecipe {
      live: LiveModel[] | undefined
      catalogRoute: boolean
      catalogProviderKey: string | undefined
      catalogOnlineOk: boolean
      overlay: RouteCatalogOverlay | undefined
      hints: CapabilityHintContext
      source: 'live' | 'catalog'
      /** The registry metadata lookup resolved when the pass started. */
      metadata?: RegistryMetadataContext | undefined
      /** The durable free-tier gate the route profile declares, when any. */
      freeTierGate?: FreeTierGate | undefined
      force?: boolean | undefined
    }

    /** The human label of the membership authority behind a removal decision. */
    function authorityLabel(report: RouteRefreshReport): string {
      if (report.authority === 'catalog') return 'live endpoint ∩ models.dev'
      if (report.authority === 'endpoint') return report.source === 'catalog' ? 'bundled catalog snapshot' : 'live endpoint'
      return 'no authority'
    }

    /**
     * Plan one route's records from an already-fetched listing. The initial
     * pass and a settings-conflict retry both call it: the retry passes the
     * records the namespace currently holds, so a concurrent edit is respected
     * without refetching anything. Pinned ids, references, the grace window,
     * and the cache-freshness gate are read live at plan time.
     * @param route - the provider route key.
     * @param configured - the route's stored records to plan from.
     * @param recipe - the pass's fetched facts.
     * @param settings - the settings seam references are re-read from.
     * @returns the planned records and the removal audit.
     */
    function planWith(
      route: string,
      configured: Array<Record<string, unknown>> | undefined,
      recipe: PlanRecipe,
      settings: SettingsSeam,
    ): PlannedRouteModels {
      const endpointAuthority = configuredEndpointAuthority(settings, route)
      return planRouteModels({
        route,
        configured,
        live: recipe.live,
        catalogRoute: recipe.catalogRoute,
        catalogProviderKey: recipe.catalogProviderKey,
        endpointAuthority,
        allowEmpty: endpointAuthority,
        endpointFresh: recipe.live !== undefined,
        catalogFresh: recipe.catalogOnlineOk
          || (catalogCacheAgeMs(Date.now()) ?? Number.POSITIVE_INFINITY) < (value(config.catalogFreshMs) ?? CATALOG_FRESH_MS),
        pinnedModels: (value(config.pinnedModels) ?? {})[route],
        overlay: recipe.overlay,
        references: routeReferences(settings, route),
        now: Date.now(),
        hints: recipe.hints,
        routeProviderMap,
        ...recipe.metadata === undefined ? {} : { metadata: recipe.metadata },
        ...recipe.freeTierGate === undefined ? {} : { freeTierGate: recipe.freeTierGate },
        source: recipe.source,
        endpointGraceMs: value(config.endpointGraceMs) ?? ENDPOINT_ONLY_GRACE_MS,
        force: recipe.force,
      })
    }

    /** Every configured id the plan no longer carries, for visibility cleanup. */
    function danglingIds(
      configured: ReadonlyArray<Record<string, unknown>>,
      models: ReadonlyArray<Record<string, unknown>>,
    ): string[] {
      const plannedIds = new Set(models.map(model => (typeof model.id === 'string' ? model.id : '')))
      return [...new Set(configured
        .map(entry => (typeof entry.id === 'string' ? entry.id : ''))
        .filter(id => id !== '' && !plannedIds.has(id)))]
    }

    /** The configured ids one listing did not advertise. */
    function unadvertisedIds(
      configured: ReadonlyArray<Record<string, unknown>>,
      live: LiveModel[] | undefined,
    ): string[] {
      const advertised = new Set((live ?? []).map(model => model.id))
      return configured
        .map(entry => typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined)
        .filter((id): id is string => id !== undefined && !advertised.has(id))
    }

    /**
     * Compute one route's refresh: fetch its listing (or the bundled Command
     * Code snapshot), resolve the deployment references, and plan the records
     * under the authoritative-membership rules. Diagnostics for pruning,
     * deprecation, and degraded removals are emitted here so the hourly pass
     * and the manual RPC report identically; persistence stays with the
     * caller.
     * @param route - the provider route key.
     * @param options - the pass's catalogue verdict, overlays, hints, and settings seam.
     * @returns the computed outcome, or undefined when the route is unknown or has no endpoint.
     */
    async function computeRouteRefresh(route: string, options: {
      catalogOnlineOk: boolean
      overlays: CatalogOverlayDocument
      hints: CapabilityHintContext
      settings: SettingsSeam
      force?: boolean
    }): Promise<RouteComputeOutcome | undefined> {
      const llmProfiles = sectionOf(options.settings, LLM_NS)?.providers
      const commandCodeProfiles = sectionOf(options.settings, COMMANDCODE_NS)?.providers
      const profile: ProviderProfile | undefined = llmProfiles?.[route] ?? commandCodeProfiles?.[route]
      const ns = llmProfiles?.[route] !== undefined ? LLM_NS : commandCodeProfiles?.[route] !== undefined ? COMMANDCODE_NS : LLM_NS
      const knownEndpoint = endpoints[route]
      if (profile === undefined && knownEndpoint === undefined) return undefined
      // A route the installed catalog already describes and nothing configured
      // has its answer; the discovered cache would only shadow a better one.
      const catalogRoute = isCatalogRoute(route)
      if (profile === undefined && catalogRoute) return undefined
      // A configured baseURL is the operator's own endpoint and outranks the
      // shipped route endpoint table, which only serves routes the profile
      // does not address itself.
      const baseURL = profile?.baseURL ?? knownEndpoint
      if (baseURL === undefined) {
        logger.debug(`route ${route}: no baseURL and no known endpoint — skipped`)
        return undefined
      }
      const overlay = options.overlays.routes?.[route]
      const key = await resolveListingKey(profile)
      let live: LiveModel[] | undefined
      let fetchError: string | undefined
      try {
        // Command Code serves no model listing; its bundled snapshot is the listing.
        live = ns === COMMANDCODE_NS ? loadCommandCodeCatalog() : await fetchModels(baseURL, key, profile?.api)
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error)
        logger.warn(describeSyncFailure(route, error, ns))
      }
      const gate = freeTierGateOf(profile)
      const metadata = metadataContextFor(route)
      const recipe: PlanRecipe = {
        live,
        catalogRoute,
        catalogProviderKey: routeProviderMap[route]?.[0],
        catalogOnlineOk: options.catalogOnlineOk,
        overlay,
        hints: options.hints,
        ...metadata === undefined ? {} : { metadata },
        ...gate === undefined ? {} : { freeTierGate: gate },
        source: ns === COMMANDCODE_NS ? 'catalog' : 'live',
        force: options.force,
      }
      const planned = planWith(route, profile?.models, recipe, options.settings)
      const references = routeReferences(options.settings, route)
      reportRegistryUsage(route, live, metadata)
      const plannedIds = new Set(planned.models.map(model => (typeof model.id === 'string' ? model.id : '')))
      const unadvertised = unadvertisedIds(profile?.models ?? [], live).filter(id => plannedIds.has(id))
      // Every configured id the plan no longer carries (membership removals
      // and overlay removals alike) is a dangling visibility reference.
      const cleanup = danglingIds(profile?.models ?? [], planned.models)
      if (planned.report.removed.length > 0) {
        reportSyncDiagnostic(
          'provider-sync/model-pruned',
          `route ${route}: pruned ${String(planned.report.removed.length)} outdated model(s) (source: ${authorityLabel(planned.report)}): ${planned.report.removed.join(', ')}`,
        )
      }
      // Cleanup also carries ids the maintained overlay removed: those are not
      // membership decisions, but the client must drop them all the same.
      const overlayRemoved = cleanup.filter(id => !planned.report.removed.includes(id))
      if (overlayRemoved.length > 0) {
        reportSyncDiagnostic(
          'provider-sync/overlay-model-removed',
          `route ${route}: overlay removed ${String(overlayRemoved.length)} model(s): ${overlayRemoved.join(', ')}`,
        )
      }
      for (const id of planned.report.deprecated) {
        const reasons = references.filter(reference => reference.id === id).map(reference => reference.reason)
        reportSyncDiagnostic(
          'provider-sync/active-model-deprecated',
          `route ${route}: model "${id}" is no longer a member but is referenced by ${reasons.join(', ')}; kept as deprecated (source: pinned-in-use)`,
        )
      }
      if (planned.report.degraded && live !== undefined && (profile?.models?.length ?? 0) > 0) {
        reportSyncDiagnostic(
          'provider-sync/removals-degraded',
          `route ${route}: model removals skipped — ${planned.report.degradedReason ?? 'unknown reason'}; keeping all ${String(profile?.models?.length ?? 0)} stored model(s)`,
        )
      }
      return {
        route,
        ns,
        hasProfile: profile !== undefined,
        configured: profile?.models ?? [],
        endpointAuthority: profile?.catalogAuthority === 'endpoint',
        overlay,
        live,
        baseURL,
        models: planned.models,
        report: planned.report,
        cleanup,
        unadvertised,
        ...live === undefined ? {} : { advertisedCount: live.length },
        ...fetchError === undefined ? {} : { fetchError },
        references,
        ...metadata === undefined ? {} : { metadata },
        plan: recipe,
      }
    }

    /**
     * Persist one computed route's records under the settings revision-retry,
     * keeping the sync's fail-soft semantics: a result that changes nothing
     * skips the write, and a concurrent settings edit elsewhere is retried
     * rather than lost. A retry re-reads the route's records from the moved
     * namespace and re-plans from the same fetched listing, so an edit that
     * landed during the conflict (for example a newly pinned model) survives
     * instead of being overwritten by the stale plan.
     * @param settings - the settings seam.
     * @param outcome - the computed route refresh.
     * @returns the outcome actually persisted (re-planned after a conflict).
     */
    async function persistRouteModels(settings: SettingsSeam, outcome: RouteComputeOutcome): Promise<RouteComputeOutcome> {
      let current = outcome
      for (let attempt = 0; ; attempt++) {
        const modelsChanged = stringifyComparable(current.configured) !== stringifyComparable(current.models)
        if (!modelsChanged) {
          logger.debug(`route ${current.route}: ${current.live === undefined ? 'overlay' : `${String(current.advertisedCount ?? 0)} ${current.report.source} models`}, no change`)
          return current
        }
        try {
          await settings.mutate(
            current.ns as SettingsNamespace,
            [{ op: 'set', path: ['providers', current.route, 'models'], value: current.models }],
            revisionOf(settings, current.ns),
          )
          const removed = current.cleanup.length
          logger.info(removed > 0
            ? `route ${current.route}: catalog refresh — ${String(current.models.length)} models (${String(removed)} outdated pruned)`
            : current.live === undefined
              ? `route ${current.route}: catalog overlay applied — ${String(current.models.length)} models`
              : `route ${current.route}: catalog merged & enriched from models.dev — ${String(current.advertisedCount ?? 0)} ${current.report.source} models (${String(current.unadvertised.length)} kept)`)
          return current
        } catch (error) {
          const conflict = error as Partial<SettingsConflictError>
          if (conflict?.code !== 'SETTINGS_CONFLICT' || attempt >= 2) throw error
          const profile = sectionOf(settings, current.ns)?.providers?.[current.route]
          if (profile === undefined) {
            // The route was removed while the write was in flight: there is
            // nothing left to converge, and writing would resurrect a partial
            // profile row.
            logger.debug(`route ${current.route}: profile removed by a concurrent edit — re-plan skipped`)
            return current
          }
          const configured = profile.models ?? []
          const previous = current
          const planned = planWith(current.route, configured, current.plan, settings)
          const rePlannedReferences = routeReferences(settings, current.route)
          current = {
            ...current,
            configured,
            models: planned.models,
            report: planned.report,
            cleanup: danglingIds(configured, planned.models),
            unadvertised: unadvertisedIds(configured, current.live)
              .filter(id => planned.models.some(model => model.id === id)),
            references: rePlannedReferences,
          }
          // A reference added while the first write was in flight changes the
          // re-plan's decision; report the newly retained/pruned ids here, or
          // the concurrency window would make that decision silent.
          for (const id of planned.report.deprecated) {
            if (previous.report.deprecated.includes(id)) continue
            const reasons = rePlannedReferences.filter(reference => reference.id === id).map(reference => reference.reason)
            reportSyncDiagnostic(
              'provider-sync/active-model-deprecated',
              `route ${current.route}: model "${id}" is no longer a member but is referenced by ${reasons.join(', ')}; kept as deprecated (source: pinned-in-use)`,
            )
          }
          for (const id of planned.report.removed) {
            if (previous.report.removed.includes(id)) continue
            reportSyncDiagnostic(
              'provider-sync/model-pruned',
              `route ${current.route}: pruned model "${id}" after a concurrent edit (source: ${authorityLabel(planned.report)})`,
            )
          }
          if (stringifyComparable(current.configured) === stringifyComparable(current.models)) {
            logger.debug(`route ${current.route}: concurrent edit already converged — no second write`)
            return current
          }
        }
      }
    }

    /**
     * Drop pruned ids from `enpoi-orchestration.uiPreferences` after a route
     * write: a hidden entry for a model the route no longer carries, and any
     * favorite referencing it, would otherwise dangle. Fail-soft: a cleanup
     * failure is reported and never fails the pass.
     * @param route - the provider route whose ids were pruned.
     * @param removed - the pruned model ids.
     */
    async function cleanupPrunedReferences(settings: SettingsSeam, route: string, removed: readonly string[]): Promise<void> {
      if (removed.length === 0) return
      try {
        for (let attempt = 0; ; attempt++) {
          // Re-read and re-plan every attempt: a conflict means another
          // writer moved the namespace, and the stale whole-map payload would
          // clobber their edit. A re-plan that finds nothing left to clean
          // (the other writer already did, or a concurrent edit removed the
          // reference) is a clean no-op.
          const deleteDocument = readSettingsDocument(settings, ORCHESTRATION_NAMESPACE)
          const cleanup = pruneRouteReferences(deleteDocument, route, removed)
          const settingsOps: SettingsPathOp[] = []
          if (cleanup.hiddenModels !== undefined) {
            settingsOps.push({ op: 'set', path: ['uiPreferences', 'hiddenModels'], value: cleanup.hiddenModels })
          }
          if (cleanup.favorites !== undefined) {
            settingsOps.push({ op: 'set', path: ['uiPreferences', 'favorites'], value: cleanup.favorites })
          }
          if (settingsOps.length === 0) return
          try {
            await settings.mutate(ORCHESTRATION_NAMESPACE as SettingsNamespace, settingsOps, revisionOf(settings, ORCHESTRATION_NAMESPACE))
            logger.info(`route ${route}: pruned ids cleaned from hidden models/favorites (${String(removed.length)} id(s))`)
            return
          } catch (error) {
            const conflict = error as Partial<SettingsConflictError>
            if (conflict?.code === 'SETTINGS_CONFLICT' && attempt < 2) continue
            throw error
          }
        }
      } catch (error) {
        reportSyncDiagnostic(
          'provider-sync/visibility-cleanup',
          `route ${route}: pruned ids could not be cleaned from visibility preferences — ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    /**
     * Write one discovery route's endpoint listing to the shared discovered
     * cache, which is the llm-pi-ai resolution layer's source while the route
     * has no configured models. Idempotent: an unchanged listing leaves the
     * file (and every `discoveredAt`) exactly as it was. A successful empty
     * listing is written as `models: []` with a fresh fetch stamp: endpoint
     * authority treats that as known-empty, not as "no answer", and the
     * installed catalog must not refill a route the endpoint emptied. An
     * invalid body or failed fetch never reaches this function.
     * @param outcome - the computed route refresh (its live listing is the cache source).
     * @param hints - the pass's capability hints.
     * @returns whether the cache now holds this pass's listing.
     */
    async function writeDiscoveredCache(outcome: RouteComputeOutcome, hints: CapabilityHintContext): Promise<boolean> {
      if (outcome.live === undefined) return false
      // Only an explicitly endpoint-authoritative route may record a known
      // empty cache. A metadata declaration or a catalog route with an empty
      // listing is not proof that the installed catalog should be suppressed.
      if (outcome.live.length === 0 && !outcome.endpointAuthority) {
        logger.info(`route ${outcome.route}: empty listing not cached — route is not endpoint-authoritative`)
        return false
      }
      try {
        // Everything the endpoint advertised, provenanced and timestamped,
        // for the llm-pi-ai resolution layer to serve while this route has
        // no configured models. A retired id a route-local reference or an
        // operator pin still names is retained and marked deprecated instead
        // of vanishing and breaking that reference.
        const previous = readDiscoveredFile(discoveredCachePath()).routes[outcome.route]
        const pinned = (value(config.pinnedModels) ?? {})[outcome.route] ?? []
        const now = Date.now()
        const record = mergeDiscoveredRoute(
          previous,
          outcome.baseURL,
          mergeDiscoveredModels(outcome.route, outcome.live, hints, routeProviderMap, outcome.metadata),
          now,
          [...outcome.references.map(reference => reference.id), ...pinned],
        )
        // A successful probe is the freshness fact even when it advertises the
        // same empty set: do not leave the cache's lastSuccess timestamp old.
        if (outcome.live.length === 0) record.fetchedAt = now
        if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)) {
          logger.debug(`route ${outcome.route}: ${String(outcome.live.length)} discovered models, no change`)
        } else {
          try {
            await writeDiscoveredRoute(outcome.route, record)
            logger.info(outcome.live.length === 0
              ? `route ${outcome.route}: endpoint advertised no models — discovered cache records the empty listing`
              : `route ${outcome.route}: discovered ${String(outcome.live.length)} models from ${outcome.baseURL} (source: discovered)`)
          } catch (error) {
            logger.warn(`route ${outcome.route}: discovered models could not be cached — ${error instanceof Error ? error.message : String(error)}`)
            return false
          }
        }
        return true
      } catch (error) {
        logger.warn(describeSyncFailure(outcome.route, error))
        return false
      }
    }

  /** The pass currently in flight, or undefined; overlapping ticks short-circuit. */
  let inFlight: Promise<void> | undefined

  /**
   * Run one sync pass, short-circuiting a tick that overlaps a pass already in
   * flight. The boot delay, the interval, and a manual refresh share the same
   * settings document and discovered-cache writes: two overlapping passes
   * would each persist a plan computed from the document the other replaced.
   * @returns fulfillment after this pass settles; the in-flight pass's promise
   *   when an overlapping tick is skipped.
   */
  function syncOnce(): Promise<void> {
    if (inFlight !== undefined) {
      logger.debug('sync pass already in flight — overlapping tick skipped')
      return inFlight
    }
    inFlight = runSyncPass().finally(() => { inFlight = undefined })
    return inFlight
  }

  async function runSyncPass(): Promise<void> {
    // Refresh models.dev metadata on every pass (not just startup) so new
    // models and corrected limits appear within one interval; the pass cadence
    // itself is the configured interval (hourly in the shipped profile).
    const onlineOk = await refreshModelsDevOnline(reportSyncDiagnostic, modelsDevUrl)
    // Metadata refresh is background work: this pass uses the last-good
    // snapshot or bundled baseline immediately instead of adding N×timeout.
    void refreshRegistrySources()
    const overlays = loadOverlays()
    const hints = loadHints()
    const settings = ctx.get('settings') as SettingsSeam | undefined
    if (settings === undefined) {
      logger.warn('settings seam absent — skipping sync pass')
      return
    }
    // Routing-affinity headers first: an existing provider block that predates
    // the requirement gets the key before any model sync runs.
    const enforced = await enforceSessionHeaders(settings, sessionHeaders, message => { logger.info(message) })
    for (const route of enforced) {
      process.stderr.write(`[enpoi-provider-sync] route ${route}: session header written to the live provider block\n`)
    }
    const llmProviders = sectionOf(settings, LLM_NS)?.providers
    // Command Code lives in its own adapter settings namespace: a deployment
    // that configures only that namespace still syncs its catalog snapshot.
    const commandCode = sectionOf(settings, COMMANDCODE_NS)?.providers
    if (llmProviders === undefined && commandCode === undefined) {
      logger.warn('llm-pi-ai section absent — nothing to sync')
      return
    }

    // Configured routes plus every endpoint this deployment knows about. The
    // extra endpoints are how a provider the operator has *selected but not yet saved*
    // — a preset with a baseURL and no models — gets discovered and cached
    // before the config write that would otherwise refuse it for resolving no
    // models. A catalog-less route is never written to settings unless it is
    // configured; the cache is its only home.
    const routes = [...new Set([
      ...Object.keys(llmProviders ?? {}),
      ...Object.keys(commandCode ?? {}),
      ...Object.keys(endpoints),
    ])]
    /** Configured ids no endpoint advertised this pass, reported once at the end. */
    const unadvertised: string[] = []
    const stats = { routes: 0, pruned: 0, deprecated: 0, degraded: 0 }

    for (const route of routes) {
      const outcome = await computeRouteRefresh(route, { catalogOnlineOk: onlineOk, overlays, hints, settings })
      if (outcome === undefined) continue
      stats.routes += 1
      stats.deprecated += outcome.report.deprecated.length
      if (outcome.report.degraded) stats.degraded += 1
      // A route with nothing configured and no listing has nothing to
      // persist: its models stay the installed catalog plus anything
      // discovered below. A route without configured models is also never
      // materialized from the overlay alone, which would replace the
      // installed catalog with the overlay's few records.
      let final = outcome
      if (outcome.hasProfile && (outcome.live !== undefined || (outcome.overlay !== undefined && outcome.configured.length > 0))) {
        try {
          final = await persistRouteModels(settings, outcome)
          await cleanupPrunedReferences(settings, route, final.cleanup)
        } catch (error) {
          logger.warn(describeSyncFailure(route, error, outcome.ns))
        }
      }
      // The persisted plan is what the pass reports: a conflict retry may have
      // re-planned against a concurrent edit, and its removals are the ones
      // the visibility cleanup above was given.
      stats.pruned += final.cleanup.length
      unadvertised.push(...final.unadvertised.map(id => `${route}/${id}`))
      // The discovered cache is llm-pi-ai's resolution source; Command Code
      // resolves its own adapter catalog, and a catalog route's answer is the
      // installed catalog itself.
      if (final.ns === LLM_NS && !isCatalogRoute(route)) await writeDiscoveredCache(final, hints)
    }

    if (stats.pruned > 0 || stats.deprecated > 0 || stats.degraded > 0) {
      reportSyncDiagnostic(
        'provider-sync/pass-summary',
        `pass summary over ${String(stats.routes)} route(s): ${String(stats.pruned)} pruned, ${String(stats.deprecated)} deprecated, ${String(stats.degraded)} degraded`,
      )
    }

    // One line per pass, not one per entry: the operator needs to know the
    // working set contains ids their listing source did not advertise.
    if (unadvertised.length > 0) {
      process.stderr.write(
        `[enpoi-provider-sync] ${String(unadvertised.length)} stored model(s) not advertised by their listing source this pass — kept (protected, in grace, referenced, or removals degraded): ${unadvertised.join(', ')}\n`,
      )
    }
  }

  /**
   * Run the manual-refresh pipeline for one route: refresh the catalogue,
   * fetch the listing, compute the same membership the hourly pass computes,
   * emit the same diagnostics, and clean pruned ids from the visibility
   * preferences. The computed records are returned; the caller (the Models
   * page) owns the settings write, so a manual refresh and an open editor
   * never write behind each other.
   * @param route - the provider route key.
   * @returns the planned records and the removal report.
   * @throws when the settings seam is absent or the route is not configured.
   */
  async function refreshRouteForClient(route: string): Promise<ProviderSyncRouteRefreshValue> {
    const settings = ctx.get('settings') as SettingsSeam | undefined
    if (settings === undefined) throw new Error('settings seam absent — cannot refresh a route')
    const onlineOk = await refreshModelsDevOnline(reportSyncDiagnostic, modelsDevUrl)
    void refreshRegistrySources()
    const overlays = loadOverlays()
    const hints = loadHints()
    const outcome = await computeRouteRefresh(route, { catalogOnlineOk: onlineOk, overlays, hints, settings, force: true })
    if (outcome === undefined) throw new Error(`route "${route}" is not configured (no profile and no known endpoint)`)
    await cleanupPrunedReferences(settings, route, outcome.cleanup)
    // Same cache side effect as the hourly pass for a discovery route; the
    // settings records themselves are the caller's write.
    if (outcome.ns === LLM_NS && !isCatalogRoute(route)) await writeDiscoveredCache(outcome, hints)
    return {
      route,
      models: outcome.models,
      // The cleanup union, not the membership audit alone: the caller merges
      // stored rows into this list and must drop overlay removals too.
      removed: outcome.cleanup,
      deprecated: outcome.report.deprecated,
      degraded: outcome.report.degraded,
      ...outcome.report.degradedReason === undefined ? {} : { degradedReason: outcome.report.degradedReason },
      source: outcome.report.source,
      authority: outcome.report.authority,
      fetchedAt: Date.now(),
    }
  }

  /**
   * Run the manual-refresh pipeline over every discoverable route: refresh the
   * catalogue online (not from its cache), re-list each route's endpoint
   * (bypassing the freshness windows and the unattended shrink guard), persist
   * the configured routes' records, refresh every discovery cache, clean
   * pruned visibility references, and report one status per route. This is the
   * "Refresh all" action's host half; the per-route RPC remains the
   * editor-scoped path that returns records for the caller to write.
   *
   * A route with no endpoint is reported as `no-listing`; a catalog route the
   * operator has not configured is `static-catalog` because the installed
   * pi-ai catalog is its model source and there is no profile to write a
   * discovered listing into. A listing failure is `unreachable` and never
   * aborts the remaining routes.
   * @param requested - routes to refresh; omission refreshes every configured
   *   route, every known endpoint, and the Command Code namespace.
   * @returns one status per route plus the pass timestamp.
   * @throws when the settings seam is absent.
   */
  async function refreshRoutesForClient(requested?: readonly string[]): Promise<ProviderSyncRoutesRefreshValue> {
    const settings = ctx.get('settings') as SettingsSeam | undefined
    if (settings === undefined) throw new Error('settings seam absent — cannot refresh routes')
    const onlineOk = await refreshModelsDevOnline(reportSyncDiagnostic, modelsDevUrl)
    void refreshRegistrySources()
    const overlays = loadOverlays()
    const hints = loadHints()
    const llmProviders = sectionOf(settings, LLM_NS)?.providers
    const commandCode = sectionOf(settings, COMMANDCODE_NS)?.providers
    const routes = requested === undefined
      ? [...new Set([
        ...Object.keys(llmProviders ?? {}),
        ...Object.keys(commandCode ?? {}),
        ...Object.keys(endpoints),
      ])]
      : [...new Set(requested)]
    const statuses: ProviderSyncRouteStatus[] = []
    for (const route of routes) {
      // computeRouteRefresh re-reads the profile from settings, so a route the
      // caller saw a moment ago may already be gone by the time its turn runs.
      const profile: ProviderProfile | undefined = llmProviders?.[route] ?? commandCode?.[route]
      const catalogRoute = isCatalogRoute(route)
      // The profile's own baseURL is authoritative when present; the shipped
      // endpoint table is the fallback for routes the profile does not address.
      const baseURL = profile?.baseURL ?? endpoints[route]
      const outcome = await computeRouteRefresh(route, { catalogOnlineOk: onlineOk, overlays, hints, settings, force: true })
      if (outcome === undefined) {
        const staticCatalog = profile === undefined && catalogRoute && baseURL !== undefined
        statuses.push({
          route,
          status: staticCatalog ? 'static-catalog' : 'no-listing',
          source: 'none',
          authority: 'none',
          modelCount: (profile?.models ?? []).length,
          removed: [],
          deprecated: [],
          degraded: false,
          cached: false,
          message: staticCatalog
            ? 'served by the installed pi-ai catalog; add this provider to refresh its endpoint listing'
            : 'no baseURL and no known endpoint — this route has no endpoint to list',
          fetchedAt: Date.now(),
        })
        continue
      }
      let final = outcome
      if (outcome.hasProfile && (outcome.live !== undefined || (outcome.overlay !== undefined && outcome.configured.length > 0))) {
        try {
          final = await persistRouteModels(settings, outcome)
          await cleanupPrunedReferences(settings, route, final.cleanup)
        } catch (error) {
          logger.warn(describeSyncFailure(route, error, outcome.ns))
        }
      }
      // Same cache side effect as the hourly pass: a non-catalog llm-pi-ai
      // route's listing is what the resolution layer reads while the route has
      // no configured models. Command Code resolves its own adapter catalog.
      const cached = final.ns === LLM_NS && !catalogRoute
        ? await writeDiscoveredCache(final, hints)
        : false
      statuses.push({
        route,
        status: outcome.live === undefined ? 'unreachable' : 'ok',
        source: outcome.report.source,
        authority: outcome.report.authority,
        ...outcome.advertisedCount === undefined ? {} : { advertised: outcome.advertisedCount },
        modelCount: final.models.length,
        removed: final.cleanup,
        deprecated: final.report.deprecated,
        degraded: final.report.degraded,
        ...final.report.degradedReason === undefined ? {} : { degradedReason: final.report.degradedReason },
        cached,
        ...outcome.fetchError === undefined ? {} : { message: outcome.fetchError },
        fetchedAt: Date.now(),
      })
    }
    return { refreshedAt: Date.now(), routes: statuses }
  }

  // The manual-refresh RPC is imported lazily, like the other profile
  // plugins: the @Remote decorator stays out of the unit-test import graph.
  // The mount runs inside an effect so a teardown that lands before the
  // import settles never leaves the service registered on a dead fiber.
  ctx.effect(() => {
    let disposed = false
    void import('./remote.ts').then(({ mountProviderSyncRemote }) => {
      if (disposed) return
      try {
        mountProviderSyncRemote(ctx, refreshRouteForClient, refreshRoutesForClient)
      } catch (error) {
        process.stderr.write(`[enpoi-provider-sync] providerSync remote mount failed: ${String(error)}\n`)
      }
    }).catch((error: unknown) => {
      process.stderr.write(`[enpoi-provider-sync] providerSync remote import failed: ${String(error)}\n`)
    })
    return () => { disposed = true }
  }, 'enpoi-provider-sync remote')

  const delay = value(config.syncDelayMs) ?? 2000
  const interval = value(config.intervalMs) ?? 3_600_000

  ctx.effect(() => {
    let timer: NodeJS.Timeout | undefined
    let intervalTimer: NodeJS.Timeout | undefined

    if (value(config.syncOnStart) !== false) {
      timer = setTimeout(() => { void syncOnce() }, delay)
    }
    intervalTimer = setInterval(() => { void syncOnce() }, interval)

    return () => {
      if (timer !== undefined) clearTimeout(timer)
      if (intervalTimer !== undefined) clearInterval(intervalTimer)
    }
  }, 'enpoi-provider-sync schedule')
}
