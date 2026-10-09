/**
 * Enpoi Harness provider-catalog sync.
 *
 * Refreshes each `llm-pi-ai` provider route's model list from the provider's
 * listing endpoint at the route's own wire protocol (`GET {baseURL}/models`
 * for the OpenAI protocols, `GET {root}/v1/models` for Anthropic Messages) and
 * enriches each entry using the authoritative `models.dev` catalog (the exact
 * single source of truth used by OpenCode and OpenChamber). The Command Code
 * namespace is covered from the provider package's bundled catalog snapshot:
 * its vendor serves no model listing, so the sync merges the snapshot instead
 * of probing a nonexistent endpoint.
 *
 * Features:
 * - 100% Dynamic Discovery from live provider endpoints.
 * - Authoritative metadata from models.dev (193+ providers, 10,000+ models).
 * - Exact context windows (e.g. 1M for GLM-5.2, 1M for MiniMax-M3, 1.05M for Luna).
 * - Exact max output token limits.
 * - Exact modalities (text, image, audio, video, pdf).
 * - Exact reasoning options & effort ladders.
 * - Tool-calling and price metadata (models.dev `tool_call` / `cost`) consumed
 *   by the dynamic catalogue rules (dsh-enpoi-catalog-rules predicates).
 * - Live hot-swap into runtime memory without restarting the server.
 * - Catalog-authoritative membership: on a route with a declared models.dev
 *   mapping, the route converges to the endpoint-advertised models the fresh
 *   catalog confirms, so ids the provider retired are removed. Hand-added
 *   (`source: 'manual'`), pinned (`pinnedModels`), overlay-`upsert`, recently
 *   first-seen endpoint-only, and referenced models survive; a removal pass
 *   runs only when both the endpoint listing and the models.dev catalogue are
 *   fresh, and aborts on the shrink guards.
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
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { Model, Api } from '@earendil-works/pi-ai'
// The schema floor is llm-pi-ai's own resolution default: the sync writes it
// explicitly so a discovered record is complete, but the one authoritative
// value stays in the adapter's config module.
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import {
  claimCapabilityHints,
  loadCapabilityHints,
  parseCapabilityHintsOverride,
  type CapabilityHintClaim,
  type CapabilityHints,
  type CapabilityHintsOverrideDocument,
} from './capability-hints.ts'

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
  /** Capacity fallbacks for models the live endpoint does not describe. */
  capacityDefaults: Volatile<Record<string, RouteCapacity>>
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
}

export const Config = Schema.object({
  intervalMs: live(Schema.number().default(3_600_000)),
  syncOnStart: live(Schema.boolean().default(true)),
  syncDelayMs: live(Schema.number().default(2000)),
  endpoints: live(Schema.dict(String).default({})),
  capacityDefaults: live(Schema.any().default({})),
  modelsDevUrl: live(Schema.string().default(DEFAULT_MODELS_DEV_URL)),
  routeProviderMap: live(Schema.dict(Schema.array(String)).default({})),
  pinnedModels: live(Schema.dict(Schema.array(String)).default({})),
  endpointGraceMs: live(Schema.number().default(ENDPOINT_ONLY_GRACE_MS)),
  catalogFreshMs: live(Schema.number().default(CATALOG_FRESH_MS)),
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
  maxTokens?: number
  /** Modalities the listing itself disclosed; `undefined` means it said nothing. */
  input?: Array<LiveModality>
  /** Whether the listing advertised tool calling; `undefined` means undisclosed. */
  tools?: boolean
  /** Whether the listing advertised reasoning; `undefined` means undisclosed. */
  reasoning?: boolean
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

/** The gate reason the listing's own `isFree: false` verdict earns. */
const SIGN_IN_REQUIRED = 'sign-in required'

/** The llm-pi-ai namespace (branded through the settings seam). */
const LLM_NS = 'llm-pi-ai'

/** The default-model selection's Config namespace (the `agent-default-model` profile entry). */
const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

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
  models?: Array<Record<string, unknown>>
  pool?: {
    strategy?: string
    identities?: Array<{ id: string, credentialRef: string, priority?: number, enabled?: boolean }>
  }
}

function sectionOf(settings: SettingsSeam, ns: string): { providers?: Record<string, ProviderProfile> } | undefined {
  const section = readSettingsDocument(settings, ns) as { providers?: Record<string, ProviderProfile> } | undefined
  if (section === null || typeof section !== 'object') return undefined
  return section
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

/** Resolve a model from models.dev with provider scoping and fallback. */
function resolveFromModelsDev(
  route: string,
  modelId: string,
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
): ModelsDevModel | undefined {
  const db = loadModelsDev()
  const cleanId = modelId.toLowerCase().trim()

  // Progressive suffix stripping: -thinking → -tiered → -preview → -exp →
  // -high/-low/-medium → -agent → -latest → -image. Each round re-checks the
  // exact id, so gemini-2.5-flash-thinking → gemini-2.5-flash resolves.
  // The ORIGINAL case is checked first: models.dev keys preserve case
  // (e.g. 'MiniMax-M3', 'zai-org/GLM-5.3-Flash'), so lowercasing alone would
  // miss them.
  const SUFFIXES = ['-thinking', '-tiered', '-preview', '-exp', '-high', '-low', '-medium', '-agent', '-latest', '-image']
  const candidates: string[] = [modelId, cleanId]
  let base = cleanId
  for (const suffix of SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      candidates.push(base)
    }
  }

  const candidateProviders = routeProviderMap[route] ?? [route]

  const find = (pModels: Record<string, unknown> | undefined): ModelsDevModel | undefined => {
    if (!pModels) return undefined
    for (const c of candidates) {
      const hit = pModels[c] as ModelsDevModel | undefined
      if (hit) return hit
    }
    // Prefix match: alias ids like gemini-3.1-pro-high → gemini-3.1-pro →
    // models.dev gemini-3.1-pro-preview. Pick the shortest matching id.
    const prefix = base
    if (prefix.length >= 8) {
      const matches = Object.keys(pModels).filter(k => k.startsWith(`${prefix}-`))
      if (matches.length > 0) {
        matches.sort((a, b) => a.length - b.length)
        return pModels[matches[0]] as ModelsDevModel | undefined
      }
    }
    return undefined
  }

  // 1. Check candidate providers
  for (const p of candidateProviders) {
    const hit = find(db[p]?.models)
    if (hit) return hit
  }

  // 2. Global search across all providers in models.dev
  for (const [, pData] of Object.entries(db)) {
    const hit = find(pData.models)
    if (hit) return hit
  }

  return undefined
}

/** Global in-memory catalog index of all known models across pi-ai (secondary fallback). */
let globalCatalogIndex: Map<string, Model<Api>> | undefined

function getCatalogIndex(): Map<string, Model<Api>> {
  if (globalCatalogIndex !== undefined) return globalCatalogIndex
  const index = new Map<string, Model<Api>>()
  for (const provider of builtinProviders()) {
    try {
      const models = getBuiltinModels(provider.id as Parameters<typeof getBuiltinModels>[0])
      for (const m of models) {
        if (!index.has(m.id)) index.set(m.id, m)
        const short = m.id.includes('/') ? m.id.split('/').pop()! : m.id
        if (!index.has(short)) index.set(short, m)
      }
    } catch {
      // provider catalog resolution errors ignored
    }
  }
  globalCatalogIndex = index
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

/** A positive integer field of a listing entry, or `undefined`. */
function listingCapacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
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

/** The modalities one listing entry disclosed, or `undefined` when it stayed silent. */
function listingModalities(entry: Record<string, unknown>): LiveModality[] | undefined {
  const architecture = entry.architecture as { input_modalities?: unknown } | undefined
  const raw = Array.isArray(entry.input_modalities)
    ? entry.input_modalities
    : Array.isArray(entry.modalities)
      ? entry.modalities
      : Array.isArray(architecture?.input_modalities)
        ? architecture.input_modalities
        : undefined
  if (raw === undefined) return undefined
  const inputs = liveModalities(raw)
  return inputs.length === 0 ? undefined : inputs
}

/**
 * The `supported_parameters` vocabulary OpenRouter-style gateways publish.
 * Absent means undisclosed; present means the endpoint enumerated what it
 * takes, so an omission is a disclosure of absence for the two flags read
 * here — never an assumption in the other direction.
 */
function listingSupported(entry: Record<string, unknown>): { tools?: boolean; reasoning?: boolean } {
  const raw = entry.supported_parameters
  if (!Array.isArray(raw)) return {}
  const strings = raw.filter((value): value is string => typeof value === 'string')
  return {
    tools: strings.includes('tools') || strings.includes('tool_choice'),
    reasoning: strings.includes('reasoning'),
  }
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
 * Normalize one raw listing row into the fields this sync understands. Every
 * capability field stays absent when the listing did not disclose it, so the
 * caller can tell "the endpoint said no" from "the endpoint said nothing".
 * @param entry - one raw row of the endpoint's listing.
 * @returns the normalized model, or `undefined` when it names no usable id.
 */
export function normalizeListingEntry(entry: unknown): LiveModel | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const row = entry as Record<string, unknown>
  const id = listingString(row.id)
  if (id === undefined) return undefined
  const displayName = listingString(row.name, row.display_name, row.displayName, row.description)
  const topProvider = row.top_provider as { context_length?: unknown; max_completion_tokens?: unknown } | undefined
  const limit = row.limit as { context?: unknown; output?: unknown } | undefined
  const contextWindow = listingCapacity(
    row.context_length,
    row.contextWindow,
    row.context_window,
    row.max_input_tokens,
    topProvider?.context_length,
    limit?.context,
  )
  const maxTokens = listingCapacity(
    row.maxOutputTokens,
    row.max_output_tokens,
    row.maxTokens,
    row.max_tokens,
    topProvider?.max_completion_tokens,
    limit?.output,
  )
  const supported = listingSupported(row)
  const isFree = typeof row.isFree === 'boolean' ? row.isFree : undefined
  return {
    id,
    ...displayName === undefined || displayName.length > 120 ? {} : { name: displayName },
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...listingModalities(row) === undefined ? {} : { input: listingModalities(row) },
    ...supported.tools === undefined ? {} : { tools: supported.tools },
    ...supported.reasoning === undefined ? {} : { reasoning: supported.reasoning },
    ...listingPricing(row) === undefined ? {} : { pricing: listingPricing(row) },
    ...isFree === undefined ? {} : { isFree },
    ...isFree === false ? { gated: true, gateReason: SIGN_IN_REQUIRED } : {},
  }
}

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
  const body = (await response.json()) as { data?: unknown[] } | unknown[]
  const data = Array.isArray(body) ? body : body.data
  if (!Array.isArray(data)) throw new Error(`GET ${request.url} -> unexpected shape`)
  const seen = new Set<string>()
  const models: LiveModel[] = []
  for (const raw of data) {
    const model = normalizeListingEntry(raw)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
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
    const model = normalizeListingEntry({
      id,
      name: entry.name,
      context_window: limit?.context,
      max_output_tokens: limit?.output,
      ...(Array.isArray(modalities?.input) ? { input_modalities: modalities.input } : {}),
      ...(supported.length === 0 ? {} : { supported_parameters: supported }),
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
    }
  }
  return raw as CatalogOverlayDocument
}

/**
 * Apply one route's overlay to its merged settings-model list: removal wins
 * over the listing, an upsert replaces the entry's named fields, and an id
 * neither the listing nor the configuration carries is appended. The input is
 * returned unchanged when the route has no overlay, so routes the file does
 * not name are untouched.
 * @param models - the merged settings records, in endpoint/configuration order.
 * @param overlay - the route's overlay, `undefined` when the file names none.
 * @returns the corrected list.
 */
export function applyCatalogOverlay(
  models: Array<Record<string, unknown>>,
  overlay: RouteCatalogOverlay | undefined,
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
    if (id !== undefined && removed.has(id)) continue
    const upsert = id === undefined ? undefined : upserts.get(id)
    if (upsert === undefined) {
      applied.push(entry)
    } else {
      // The overlay record is maintained truth: its fields win, and the
      // "nothing described this model" marker and the id-hint claim the merge
      // may have stamped are cleared because the overlay does describe it.
      applied.push({ ...entry, ...upsert, unverified: undefined, capabilityHints: undefined })
    }
    if (id !== undefined) seen.add(id)
  }
  for (const [id, entry] of upserts) {
    if (seen.has(id)) continue
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
  maxTokens?: number
  input?: Array<LiveModality>
  tools?: boolean
  reasoning?: boolean
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
 * @param previous - the route's existing record, when one exists.
 * @param baseURL - the endpoint interrogated.
 * @param models - the freshly analyzed models, without provenance stamps.
 * @param now - the current epoch milliseconds.
 * @returns the record to persist.
 */
export function mergeDiscoveredRoute(
  previous: DiscoveredFileRoute | undefined,
  baseURL: string,
  models: Array<Omit<DiscoveredFileModel, 'source' | 'discoveredAt'>>,
  now: number,
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


/** Capacity fallback for one model id on one route. */
interface CapacityFallback {
  contextWindow?: number
  maxTokens?: number
  matched: 'prefix' | 'default'
}

function fallbackFor(capacities: Record<string, RouteCapacity> | undefined, route: string, modelId: string): CapacityFallback | undefined {
  const routeCaps: RouteCapacity | undefined = capacities?.[route]
  if (routeCaps === undefined) return undefined
  if (routeCaps.prefixes !== undefined) {
    const hit = Object.entries(routeCaps.prefixes).find(([prefix]) => modelId.startsWith(prefix))
    if (hit !== undefined) return { ...hit[1], matched: 'prefix' }
  }
  return routeCaps.default === undefined ? undefined : { ...routeCaps.default, matched: 'default' }
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

/** One model's two renderings: what settings stores and what the discovery cache keeps. */
interface AnalyzedModel {
  /**
   * The settings-model record. Capabilities are disclosed facts or the schema
   * floor; a guess from the shared id table rides only in the labeled
   * `capabilityHints` field, and `unverified: true` marks a floor that no
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
 * Capabilities are persisted only when a source disclosed them: models.dev,
 * the installed catalog, or the listing itself. The shared id table's
 * operands never become facts — a capability nothing disclosed keeps the
 * schema floor (`text` input, no reasoning) and is marked `unverified`, with
 * the id guess kept only in the labeled `capabilityHints` field. The rules
 * engine and the panel therefore read vectors, not guesses.
 * @param route - the provider route key, for models.dev scoping.
 * @param model - the normalized listing entry.
 * @param fallback - the route's capacity fallback for ids nothing sizes.
 * @param hints - the shipped hint table plus the owner override.
 * @param routeProviderMap - the effective route → models.dev provider keys.
 * @returns the settings record and the cache record.
 */
function analyzeModel(
  route: string,
  model: LiveModel,
  fallback: CapacityFallback | undefined,
  hints: CapabilityHintContext,
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
): AnalyzedModel {
  const mDev = resolveFromModelsDev(route, model.id, routeProviderMap)
  const catalog = getCatalogIndex()
  const shortId = model.id.includes('/') ? model.id.split('/').pop()! : model.id
  const cat = catalog.get(model.id) ?? catalog.get(shortId)

  // 1. Resolve Name — models.dev is AUTHORITATIVE; the live proxy's
  // description is often mislabeled (e.g. gemini-2.5-flash-thinking described
  // as "Gemini 3.1 Flash Lite"), so it is only a fallback.
  let name = mDev?.name
  if (name === undefined || name.length === 0) {
    const liveName = model.name
    if (liveName !== undefined && liveName !== model.id && liveName.length <= 60) {
      name = liveName
    } else {
      name = cat?.name ?? beautifyId(model.id)
    }
  }

  // 2. Resolve Context Window & Max Output Tokens — models.dev is
  // AUTHORITATIVE; the route prefix fallback is a guess for unknown ids and
  // must come LAST (it was winning over real models.dev limits, e.g.
  // gemini-3.1-flash-image got 1M instead of its true 65K).
  const devContext = mDev?.limit?.context ?? mDev?.limit?.input ?? mDev?.contextWindow
  const devMax = mDev?.limit?.output ?? mDev?.maxTokens
  const prefixContext = fallback?.matched === 'prefix' ? fallback.contextWindow : undefined
  const prefixMax = fallback?.matched === 'prefix' ? fallback.maxTokens : undefined

  const contextWindow = model.contextWindow ?? devContext ?? cat?.contextWindow ?? prefixContext ?? fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = model.maxTokens ?? devMax ?? cat?.maxTokens ?? prefixMax ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS

  // 3. Resolve Modalities, Reasoning, and their provenance. `input` and
  // `reasoning` are facts only when a disclosure stated them; the shared id
  // table's operands are hints. An explicit `reasoning: false` from any
  // source is a disclosure of absence and blocks the heuristics that used to
  // override it.
  const disclosed = [mDev?.modalities?.input, cat?.input, model.input]
    .find(value => Array.isArray(value) && liveModalities(value).length > 0)
  const modalityDisclosed = disclosed !== undefined
  const inputModalities: LiveModality[] = modalityDisclosed
    ? ['text', ...liveModalities(disclosed).filter(modality => modality !== 'text')]
    : ['text']
  const reasoningSources = [mDev?.reasoning, cat?.reasoning, model.reasoning]
    .filter((value): value is boolean => typeof value === 'boolean')
  const reasoningOptions = Array.isArray(mDev?.reasoning_options) && mDev.reasoning_options.length > 0
  const thinkingLevels = cat?.thinkingLevelMap !== undefined && Object.keys(cat.thinkingLevelMap).some(key => key !== 'off')
  const reasoningDisclosed = reasoningSources.length > 0 || reasoningOptions || thinkingLevels
  const isReasoning = reasoningSources.some(value => value === true) || reasoningOptions || thinkingLevels

  // The shared table's guess (and any owner override) never becomes a fact:
  // it is kept only under `capabilityHints`, and a claim for a capability
  // nothing disclosed marks the record unverified.
  const claim: CapabilityHintClaim | undefined = claimCapabilityHints(route, model.id, hints.table, hints.override)
  const hintedInput = !modalityDisclosed && claim !== undefined && claim.input.length > 0
  const hintedReasoning = !reasoningDisclosed && claim?.reasoning === true
  const nothingDescribed = mDev === undefined && cat === undefined
    && model.input === undefined && model.reasoning === undefined && model.tools === undefined
  const unverified = nothingDescribed || hintedInput || hintedReasoning
  // A disclosed capability keeps its fact; the labeled hint field carries only
  // the claims a disclosure did not cover.
  const capabilityHints: Record<string, unknown> | undefined = claim === undefined ? undefined : {
    ...claim.input.length === 0 || modalityDisclosed ? {} : { input: claim.input },
    ...claim.reasoning && !reasoningDisclosed ? { reasoning: true } : {},
    source: claim.source,
  }

  // 4. Resolve Reasoning Efforts
  // NOTE: the `off` level is deliberately NOT written as a key — `off` is a
  // YAML 1.1 boolean alias, so a YAML 1.1 parser (PyYAML, js-yaml 1.1 schema)
  // would read `off: null` as `false: null` and corrupt the dict. The harness
  // itself uses YAML 1.2 (reads `off` as a string), but the sync output must
  // stay unambiguous for every consumer. Omitting `off` is equivalent: the
  // catalog materializer maps absent levels to `null` (off included), and
  // "not thinking" is the parameter's absence on the wire anyway.
  let reasoningEfforts: Record<string, string | null> | undefined
  if (isReasoning) {
    const levels: Record<string, string | null> = {}
    const VALID_THINKING_KEYS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

    if (Array.isArray(mDev?.reasoning_options)) {
      for (const opt of mDev.reasoning_options) {
        if (Array.isArray(opt.values)) {
          for (const val of opt.values) {
            if (typeof val === 'string' && VALID_THINKING_KEYS.has(val)) {
              levels[val] = val
            }
          }
        }
      }
    }

    if (cat?.thinkingLevelMap !== undefined) {
      for (const [k, v] of Object.entries(cat.thinkingLevelMap)) {
        if (VALID_THINKING_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
          levels[k] = v
        }
      }
    }

    if (Object.keys(levels).length === 0) {
      levels.minimal = 'minimal'
      levels.low = 'low'
      levels.medium = 'medium'
      levels.high = 'high'
      levels.xhigh = 'xhigh'
      levels.max = 'max'
    }

    if (Object.keys(levels).length > 0) {
      reasoningEfforts = levels
    }
  }

  // 5. Tool-calling and price metadata. Both feed the dynamic catalogue rules
  // (dsh-enpoi-catalog-rules): the `tools` and `zeroPrice`/`maxPrice`
  // predicates. models.dev wins; the listing fills what models.dev does not
  // know; absent fields stay absent so a rule can tell "unknown" from "known
  // free"/"known pays".
  const tools = typeof mDev?.tool_call === 'boolean'
    ? mDev.tool_call
    : model.tools
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

  return {
    settings: {
      id: model.id,
      name,
      contextWindow,
      maxTokens,
      input: inputModalities,
      reasoning: isReasoning,
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
      contextWindow,
      maxTokens,
      ...(modalityDisclosed ? { input: inputModalities } : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      ...(model.isFree === undefined ? {} : { isFree: model.isFree }),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(costTiers === undefined ? {} : { costTiers }),
      ...gate,
      ...(unverified ? { unverified: true } : {}),
    },
  }
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
 * `source: 'manual'` entry keeps its own stamp), and a live id the
 * configuration does not name is appended. This is the degraded-pass merge:
 * the removal-aware membership planner ({@link planRouteModels}) is the path a
 * healthy pass takes.
 * @param route - provider route key, for models.dev scoping.
 * @param configured - the route's current `models` array, when any.
 * @param live - normalized live listing entries.
 * @param capacities - the route's capacity fallbacks.
 * @param hints - the shipped hint table plus the owner override; defaults to
 *   the shipped table with no override.
 * @param routeProviderMap - the effective route → models.dev provider keys;
 *   defaults to the shipped table.
 * @returns the merged list and the configured ids nothing advertised.
 */
export function mergeConfiguredModels(
  route: string,
  configured: Array<Record<string, unknown>> | undefined,
  live: LiveModel[],
  capacities: Record<string, RouteCapacity> | undefined,
  hints: CapabilityHintContext = { table: loadCapabilityHints(), override: {} },
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
): ConfiguredMerge {
  const advertised = new Map<string, Record<string, unknown>>()
  for (const model of live) {
    if (advertised.has(model.id)) continue
    advertised.set(model.id, analyzeModel(route, model, fallbackFor(capacities, route, model.id), hints, routeProviderMap).settings)
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
      models.push(entry.source === 'manual' ? { ...fresh, source: 'manual' } : fresh)
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
 * The model ids one models.dev provider carries, as an exact set (the
 * published key and its lowercase spelling). `undefined` when the fresh
 * snapshot does not carry the provider at all — membership then has no
 * catalog authority for the route.
 * @param providerKey - the exact models.dev provider key.
 * @returns the id set, or undefined when the provider is absent.
 */
function modelsDevProviderModelIds(providerKey: string): Set<string> | undefined {
  const provider = loadModelsDev()[providerKey]
  if (provider?.models === undefined) return undefined
  const ids = new Set<string>()
  for (const key of Object.keys(provider.models)) {
    ids.add(key)
    ids.add(key.toLowerCase())
  }
  return ids
}

/** One route-local model reference that must never be pruned silently. */
export interface RouteModelReference {
  /** The referenced model id on this route. */
  id: string
  /** Why it is referenced (`agent-default-model`, `chain:<id>`, `favorite`). */
  reason: string
}

/**
 * Collect every model of `route` referenced by the default model selection,
 * the `enpoi-orchestration.chains` links, and the picker favorites. Malformed
 * entries are ignored: a reference nothing can express is no reference.
 * @param defaultModel - the `agent-default-model` settings document, when read.
 * @param orchestration - the `enpoi-orchestration` settings document, when read.
 * @param route - the provider route key whose models are collected.
 * @returns the route-local references with their reasons.
 */
export function referencedRouteModels(
  defaultModel: unknown,
  orchestration: unknown,
  route: string,
): RouteModelReference[] {
  const found: RouteModelReference[] = []
  if (defaultModel !== null && typeof defaultModel === 'object' && !Array.isArray(defaultModel)) {
    const selection = defaultModel as { provider?: unknown, model?: unknown }
    if (selection.provider === route && typeof selection.model === 'string' && selection.model !== '') {
      found.push({ id: selection.model, reason: 'agent-default-model' })
    }
  }
  if (orchestration === null || typeof orchestration !== 'object' || Array.isArray(orchestration)) return found
  const document = orchestration as { chains?: unknown, uiPreferences?: unknown }
  const chains = document.chains
  if (chains !== null && typeof chains === 'object' && !Array.isArray(chains)) {
    for (const [chainId, raw] of Object.entries(chains as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
      const links = (raw as { links?: unknown }).links
      if (!Array.isArray(links)) continue
      for (const link of links) {
        if (link === null || typeof link !== 'object' || Array.isArray(link)) continue
        const entry = link as { provider?: unknown, model?: unknown }
        if (entry.provider === route && typeof entry.model === 'string' && entry.model !== '') {
          found.push({ id: entry.model, reason: `chain:${chainId}` })
        }
      }
    }
  }
  const preferences = document.uiPreferences
  if (preferences !== null && typeof preferences === 'object' && !Array.isArray(preferences)) {
    const favorites = (preferences as { favorites?: unknown }).favorites
    if (Array.isArray(favorites)) {
      for (const favorite of favorites) {
        if (favorite === null || typeof favorite !== 'object' || Array.isArray(favorite)) continue
        const entry = favorite as { provider?: unknown, modelId?: unknown }
        if (entry.provider === route && typeof entry.modelId === 'string' && entry.modelId !== '') {
          found.push({ id: entry.modelId, reason: 'favorite' })
        }
      }
    }
  }
  return found
}

/**
 * Merge a live listing into the discovered-cache records, without provenance stamps.
 * @param route - provider route key, for models.dev scoping.
 * @param live - normalized live listing entries.
 * @param capacities - the route's capacity fallbacks.
 * @param hints - the shipped hint table plus the owner override; defaults to
 *   the shipped table with no override.
 * @param routeProviderMap - the effective route → models.dev provider keys;
 *   defaults to the shipped table.
 * @returns the discovered records, minus the provenance stamps the writer adds.
 */
export function mergeDiscoveredModels(
  route: string,
  live: LiveModel[],
  capacities: Record<string, RouteCapacity> | undefined,
  hints: CapabilityHintContext = { table: loadCapabilityHints(), override: {} },
  routeProviderMap: RouteProviderMap = DEFAULT_ROUTE_PROVIDER_MAP,
): Array<Omit<DiscoveredFileModel, 'source' | 'discoveredAt'>> {
  return live.map((model) => {
    const fallback = fallbackFor(capacities, route, model.id)
    return analyzeModel(route, model, fallback, hints, routeProviderMap).discovered
  })
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
  /** Ids dropped from the route this pass. */
  removed: string[]
  /** Ids kept only because they are referenced and no longer a member. */
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
  /** Capacity fallbacks for models the live endpoint does not describe. */
  capacities?: Record<string, RouteCapacity> | undefined
  /** The shipped hint table plus the owner override. */
  hints?: CapabilityHintContext | undefined
  /** The effective route → models.dev provider keys. */
  routeProviderMap?: RouteProviderMap | undefined
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
 * successful listing fetch the advertised list itself is the authority.
 * Removals run only when the endpoint listing and the catalogue are both
 * fresh in the same pass, and abort when the effective set would be empty or
 * would drop more than half of the route's stored models. A referenced model
 * that would be pruned is kept, stamped `deprecated: true` and
 * `source: 'pinned-in-use'`, and named in the report. A degraded pass is the
 * legacy merge: nothing is removed.
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
    advertised.set(model.id, analyzeModel(input.route, model, fallbackFor(input.capacities, input.route, model.id), hints, routeProviderMap).settings)
  }

  const catalogIds = input.catalogRoute && input.catalogProviderKey !== undefined
    ? modelsDevProviderModelIds(input.catalogProviderKey)
    : undefined
  const authority: RouteAuthority = live === undefined
    ? 'none'
    : catalogIds !== undefined
      ? 'catalog'
      : input.catalogRoute ? 'none' : 'endpoint'
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
      if (catalogIds.has(id) || catalogIds.has(id.toLowerCase())) continue
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
  for (const [id, entry] of configuredById) {
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
      if (catalogIds.has(id) || catalogIds.has(id.toLowerCase())) memberBase.add(id)
    }
  } else if (authority === 'endpoint') {
    for (const id of advertised.keys()) memberBase.add(id)
  }
  const isMember = (id: string): boolean => memberBase.has(id) || protectedIds.has(id) || grace.has(id)

  const removalsAllowed = authority !== 'none' && input.endpointFresh && input.catalogFresh
  let keepAll = !removalsAllowed
  if (keepAll) {
    report.degraded = true
    report.degradedReason = live === undefined
      ? 'the endpoint listing could not be fetched'
      : !input.endpointFresh
        ? 'the endpoint listing fetch did not succeed'
        : !input.catalogFresh
          ? 'the models.dev catalogue is stale (no online refresh and the cache is 48 h or older)'
          : input.catalogRoute
            ? 'the route has no declared models.dev catalog mapping'
            : 'no membership authority'
  } else {
    const currentIds = [...configuredById.keys()]
    const wouldRemove = currentIds.filter(id => !isMember(id) && !references.has(id))
    const skipWithholdGuard = input.force === true
    if (memberBase.size === 0 && protectedIds.size === 0 && grace.size === 0) {
      keepAll = true
      report.degraded = true
      report.degradedReason = 'the effective model set would be empty'
    } else if (!skipWithholdGuard && currentIds.length > 0 && wouldRemove.length * 2 > currentIds.length) {
      keepAll = true
      report.degraded = true
      report.degradedReason = `removals would drop ${String(wouldRemove.length)} of ${String(currentIds.length)} stored models (more than half)`
    }
  }

  const models: Array<Record<string, unknown>> = []
  if (keepAll) {
    models.push(...(live === undefined ? configured : mergeConfiguredModels(input.route, configured, live, input.capacities, hints, routeProviderMap).models))
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
  return { models: applyCatalogOverlay(models, input.overlay), report }
}

/** The value `providerSync.refreshRoute` returns to the client. */
export interface ProviderSyncRouteRefreshValue {
  route: string
  /** The route's planned settings records; the caller persists them. */
  models: Array<Record<string, unknown>>
  /** Ids the plan removed (the caller's replace must drop them). */
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

function stringifyComparable(models: Array<Record<string, unknown>> | undefined): string {
  return JSON.stringify(
    (models ?? []).map(m => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input ?? null,
      reasoning: m.reasoningEfforts ? Object.keys(m.reasoningEfforts as object).sort() : null,
      tools: m.tools ?? null,
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
  const capacities = (value(config.capacityDefaults) ?? {}) as Record<string, RouteCapacity>
  const modelsDevUrl = value(config.modelsDevUrl) ?? DEFAULT_MODELS_DEV_URL
  // The configured route map extends the shipped table key by key: a route the
  // deployment newly serves is mapped from configuration alone.
  const routeProviderMap: RouteProviderMap = { ...DEFAULT_ROUTE_PROVIDER_MAP, ...value(config.routeProviderMap) }

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

  /** Read the maintained overlays once per pass; a malformed file is reported and yields none. */
  function loadOverlays(): CatalogOverlayDocument {
    try {
      return loadCatalogOverlays()
    } catch (error) {
      reportSyncDiagnostic('provider-sync/catalog-overlays', error instanceof Error ? error.message : String(error))
      return {}
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

    interface RouteComputeOutcome {
      route: string
      /** The settings namespace that owns the route. */
      ns: string
      /** Whether the route has a settings profile (a write is skipped otherwise). */
      hasProfile: boolean
      /** The route's stored records, when it has a profile. */
      configured: Array<Record<string, unknown>>
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
      return planRouteModels({
        route,
        configured,
        live: recipe.live,
        catalogRoute: recipe.catalogRoute,
        catalogProviderKey: recipe.catalogProviderKey,
        endpointFresh: recipe.live !== undefined,
        catalogFresh: recipe.catalogOnlineOk
          || (catalogCacheAgeMs(Date.now()) ?? Number.POSITIVE_INFINITY) < (value(config.catalogFreshMs) ?? CATALOG_FRESH_MS),
        pinnedModels: (value(config.pinnedModels) ?? {})[route],
        overlay: recipe.overlay,
        references: referencedRouteModels(
          readSettingsDocument(settings, AGENT_DEFAULT_MODEL_NS),
          readSettingsDocument(settings, ORCHESTRATION_NAMESPACE),
          route,
        ),
        now: Date.now(),
        capacities,
        hints: recipe.hints,
        routeProviderMap,
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
      const baseURL = knownEndpoint ?? profile?.baseURL
      if (baseURL === undefined) {
        logger.debug(`route ${route}: no baseURL and no known endpoint — skipped`)
        return undefined
      }
      const overlay = options.overlays.routes?.[route]
      const key = await resolveListingKey(profile)
      let live: LiveModel[] | undefined
      try {
        // Command Code serves no model listing; its bundled snapshot is the listing.
        live = ns === COMMANDCODE_NS ? loadCommandCodeCatalog() : await fetchModels(baseURL, key, profile?.api)
      } catch (error) {
        logger.warn(describeSyncFailure(route, error, ns))
      }
      const recipe: PlanRecipe = {
        live,
        catalogRoute,
        catalogProviderKey: routeProviderMap[route]?.[0],
        catalogOnlineOk: options.catalogOnlineOk,
        overlay,
        hints: options.hints,
        source: ns === COMMANDCODE_NS ? 'catalog' : 'live',
        force: options.force,
      }
      const planned = planWith(route, profile?.models, recipe, options.settings)
      const references = referencedRouteModels(
        readSettingsDocument(options.settings, AGENT_DEFAULT_MODEL_NS),
        readSettingsDocument(options.settings, ORCHESTRATION_NAMESPACE),
        route,
      )
      const unadvertised = unadvertisedIds(profile?.models ?? [], live)
      // Every configured id the plan no longer carries (membership removals
      // and overlay removals alike) is a dangling visibility reference.
      const cleanup = danglingIds(profile?.models ?? [], planned.models)
      if (planned.report.removed.length > 0) {
        reportSyncDiagnostic(
          'provider-sync/model-pruned',
          `route ${route}: pruned ${String(planned.report.removed.length)} outdated model(s) (source: ${authorityLabel(planned.report)}): ${planned.report.removed.join(', ')}`,
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
        overlay,
        live,
        baseURL,
        models: planned.models,
        report: planned.report,
        cleanup,
        unadvertised,
        ...live === undefined ? {} : { advertisedCount: live.length },
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
      if (stringifyComparable(current.configured) === stringifyComparable(current.models)) {
        logger.debug(`route ${current.route}: ${current.live === undefined ? 'overlay' : `${String(current.advertisedCount ?? 0)} ${current.report.source} models`}, no change`)
        return current
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await settings.mutate(
            current.ns as SettingsNamespace,
            [{ op: 'set', path: ['providers', current.route, 'models'], value: current.models }],
            revisionOf(settings, current.ns),
          )
          const removed = current.report.removed.length
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
          const planned = planWith(current.route, configured, current.plan, settings)
          current = {
            ...current,
            configured,
            models: planned.models,
            report: planned.report,
            cleanup: danglingIds(configured, planned.models),
            unadvertised: unadvertisedIds(configured, current.live),
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
     * file (and every `discoveredAt`) exactly as it was. An empty listing is
     * never written, so a route that answers nothing keeps its last good
     * cache instead of silently falling back to the installed catalog.
     * @param outcome - the computed route refresh (its live listing is the cache source).
     * @param hints - the pass's capability hints.
     * @returns fulfillment after the cache write settles.
     */
    async function writeDiscoveredCache(outcome: RouteComputeOutcome, hints: CapabilityHintContext): Promise<void> {
      if (outcome.live === undefined) return
      if (outcome.live.length === 0) {
        logger.warn(`route ${outcome.route}: endpoint advertised no models — discovered cache kept`)
        return
      }
      try {
        // Everything the endpoint advertised, provenanced and timestamped,
        // for the llm-pi-ai resolution layer to serve while this route has
        // no configured models.
        const previous = readDiscoveredFile(discoveredCachePath()).routes[outcome.route]
        const record = mergeDiscoveredRoute(
          previous,
          outcome.baseURL,
          mergeDiscoveredModels(outcome.route, outcome.live, capacities, hints, routeProviderMap),
          Date.now(),
        )
        if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)) {
          logger.debug(`route ${outcome.route}: ${String(outcome.live.length)} discovered models, no change`)
        } else {
          try {
            await writeDiscoveredRoute(outcome.route, record)
            logger.info(`route ${outcome.route}: discovered ${String(outcome.live.length)} models from ${outcome.baseURL} (source: discovered)`)
          } catch (error) {
            logger.warn(`route ${outcome.route}: discovered models could not be cached — ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error) {
        logger.warn(describeSyncFailure(outcome.route, error))
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
    const overlays = loadOverlays()
    const hints = loadHints()
    const settings = ctx.get('settings') as SettingsSeam | undefined
    if (settings === undefined) {
      logger.warn('settings seam absent — skipping sync pass')
      return
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
      stats.pruned += final.report.removed.length
      unadvertised.push(...final.unadvertised.map(id => `${route}/${id}`))
      // The discovered cache is llm-pi-ai's resolution source; Command Code
      // resolves its own adapter catalog, and a catalog route's answer is the
      // installed catalog itself.
      if (outcome.ns === LLM_NS && !isCatalogRoute(route)) await writeDiscoveredCache(outcome, hints)
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
      removed: outcome.report.removed,
      deprecated: outcome.report.deprecated,
      degraded: outcome.report.degraded,
      ...outcome.report.degradedReason === undefined ? {} : { degradedReason: outcome.report.degradedReason },
      source: outcome.report.source,
      authority: outcome.report.authority,
      fetchedAt: Date.now(),
    }
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
        mountProviderSyncRemote(ctx, refreshRouteForClient)
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
