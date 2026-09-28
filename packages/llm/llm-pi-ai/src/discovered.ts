/**
 * The per-route discovered-model cache: what an OpenAI-compatible endpoint
 * answered when asked `GET {baseURL}/models`, normalized and timestamped so a
 * route the installed pi-ai catalog does not describe can still resolve.
 *
 * The catalogue proper is `providers.<route>.models` in `llm-pi-ai` settings;
 * a route that lists its models there needs nothing from this module. This
 * cache is the answer for the other case: a gateway (Kilo, a self-hosted
 * server) whose route has a baseURL but no installed catalog and — until
 * discovery has run — no configured models either. Without it, resolution
 * refuses the route and the provider editor cannot even save it, which is
 * exactly the deadlock that made a newly added provider a manual chore.
 *
 * The profile-side `dsh-enpoi-provider-sync` plugin owns the *writing*: it
 * fetches the same `{baseURL}/models` listing on its hourly rhythm, enriches
 * what models.dev and the installed catalog know, and persists the result to
 * this file. This module owns the *reading*, and the file format is the
 * contract between them:
 *
 * ```json
 * {
 *   "version": 1,
 *   "routes": {
 *     "kilo": {
 *       "baseURL": "https://api.kilo.ai/api/gateway",
 *       "fetchedAt": 1790000000000,
 *       "models": [
 *         {
 *           "id": "kilo-auto/efficient",
 *           "name": "Auto Efficient",
 *           "contextWindow": 1000000,
 *           "maxTokens": 65536,
 *           "input": ["text", "image"],
 *           "tools": true,
 *           "reasoning": true,
 *           "isFree": false,
 *           "gated": true,
 *           "gateReason": "sign-in required",
 *           "source": "discovered",
 *           "discoveredAt": 1790000000000
 *         }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * Only a model whose capabilities nothing disclosed carries `"unverified":
 * true`; it is then materialized with text-only input and no reasoning, never
 * with a guess. A model whose id the installed catalog *does* know is never
 * read from here at all — the catalog's capacities always win.
 *
 * @module dsh-llm-pi-ai/discovered
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cache format version; a file stamped otherwise is ignored rather than guessed at. */
export const DISCOVERED_CACHE_VERSION = 1

/** One model an endpoint advertised, normalized and provenanced. */
export interface DiscoveredModelRecord {
  /** Model id the endpoint accepts. */
  readonly id: string
  /** Human-readable name, when one was disclosed. */
  readonly name?: string | undefined
  /** Maximum combined request and response context, when disclosed. */
  readonly contextWindow?: number | undefined
  /** Maximum output tokens, when disclosed. */
  readonly maxTokens?: number | undefined
  /** Accepted input types; absent means undisclosed, never "text only" as a claim. */
  readonly input?: readonly ('text' | 'image')[] | undefined
  /** Whether the endpoint advertised tool calling; absent means undisclosed. */
  readonly tools?: boolean | undefined
  /** Whether the endpoint advertised reasoning; absent means undisclosed. */
  readonly reasoning?: boolean | undefined
  /** The listing's own price fields, kept verbatim for future consumers. */
  readonly pricing?: Readonly<Record<string, string>> | undefined
  /** Whether the endpoint's directory marked the model free. */
  readonly isFree?: boolean | undefined
  /**
   * Whether the endpoint's directory marked the model sign-in/paid-only
   * (`isFree: false`). Mirrors the catalogue rules engine's `gated` entry
   * flag, so a picker dims it with {@link gateReason} and a `gated` rule
   * clause can exclude it.
   */
  readonly gated?: boolean | undefined
  /** The picker-facing reason a gated model is unavailable; absent when not gated. */
  readonly gateReason?: string | undefined
  /** True when neither models.dev, the installed catalog, nor the listing disclosed any capability. */
  readonly unverified?: boolean | undefined
  /** Provenance marker: this record came from an endpoint listing, not configuration. */
  readonly source: 'discovered'
  /** Epoch milliseconds of the discovery that produced this record's content. */
  readonly discoveredAt: number
}

/** One route's discovered models plus the fetch that produced them. */
export interface DiscoveredRouteRecord {
  /** The endpoint that was interrogated, when the writer knew it. */
  readonly baseURL?: string | undefined
  /** Epoch milliseconds of the most recent successful fetch for the route. */
  readonly fetchedAt: number
  /** The normalized listing in endpoint order, deduplicated by id. */
  readonly models: readonly DiscoveredModelRecord[]
}

/** The whole cache file. */
export interface DiscoveredCache {
  readonly version: number
  readonly routes: Readonly<Record<string, DiscoveredRouteRecord>>
}

const EMPTY_ROUTES: ReadonlyMap<string, DiscoveredRouteRecord> = new Map()

/** The cache file this build reads; `DSH_DISCOVERED_MODELS` overrides it for tests and operations. */
export function discoveredModelsPath(): string {
  const override = process.env.DSH_DISCOVERED_MODELS
  if (override !== undefined && override.length > 0) return override
  const home = process.env.DSH_HOME
  return join(home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh'), 'cache', 'discovered-models.json')
}

/** A positive integer, or `undefined` for anything that is not one. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** A non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Normalize one model entry, or `undefined` when it names no usable id. */
function readModel(raw: unknown, fallbackStamp: number): DiscoveredModelRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const id = nonEmptyString(entry.id)
  if (id === undefined) return undefined
  const input = Array.isArray(entry.input)
    ? entry.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
    : undefined
  const pricing = entry.pricing !== null && typeof entry.pricing === 'object' && !Array.isArray(entry.pricing)
    ? Object.fromEntries(
      Object.entries(entry.pricing as Record<string, unknown>)
        .filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
    )
    : undefined
  // A gate reason without the gate is noise from a hand-edited cache; it is
  // kept only beside `gated: true`.
  const gateReason = entry.gated === true ? nonEmptyString(entry.gateReason) : undefined
  return {
    id,
    ...nonEmptyString(entry.name) === undefined ? {} : { name: nonEmptyString(entry.name) },
    ...positiveInteger(entry.contextWindow) === undefined ? {} : { contextWindow: positiveInteger(entry.contextWindow) },
    ...positiveInteger(entry.maxTokens) === undefined ? {} : { maxTokens: positiveInteger(entry.maxTokens) },
    ...input === undefined || input.length === 0 ? {} : { input },
    ...typeof entry.tools === 'boolean' ? { tools: entry.tools } : {},
    ...typeof entry.reasoning === 'boolean' ? { reasoning: entry.reasoning } : {},
    ...pricing === undefined || Object.keys(pricing).length === 0 ? {} : { pricing },
    ...typeof entry.isFree === 'boolean' ? { isFree: entry.isFree } : {},
    ...entry.gated === true ? { gated: true } : {},
    ...gateReason === undefined ? {} : { gateReason },
    ...entry.unverified === true ? { unverified: true } : {},
    source: 'discovered',
    discoveredAt: positiveInteger(entry.discoveredAt) ?? fallbackStamp,
  }
}

/** Normalize one route entry; `undefined` when it carries no usable models. */
function readRoute(raw: unknown): DiscoveredRouteRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const fetchedAt = positiveInteger(entry.fetchedAt) ?? 0
  if (!Array.isArray(entry.models)) return undefined
  const seen = new Set<string>()
  const models: DiscoveredModelRecord[] = []
  for (const candidate of entry.models) {
    const model = readModel(candidate, fetchedAt)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) return undefined
  return {
    ...nonEmptyString(entry.baseURL) === undefined ? {} : { baseURL: nonEmptyString(entry.baseURL) },
    fetchedAt,
    models,
  }
}

/**
 * Parse a cache document, dropping every malformed route and model rather
 * than failing the read: a stale or hand-edited cache must never be able to
 * block resolution that would otherwise work.
 * @param raw - the parsed JSON document.
 * @returns the normalized cache, empty when nothing usable is present.
 */
export function parseDiscoveredCache(raw: unknown): DiscoveredCache {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: DISCOVERED_CACHE_VERSION, routes: {} }
  }
  const document = raw as Record<string, unknown>
  // A file stamped with another format version belongs to a different build;
  // guessing at its meaning would be worse than discovering again.
  const version = positiveInteger(document.version) ?? DISCOVERED_CACHE_VERSION
  if (version !== DISCOVERED_CACHE_VERSION) return { version: DISCOVERED_CACHE_VERSION, routes: {} }
  const routes: Record<string, DiscoveredRouteRecord> = {}
  const source = document.routes
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    for (const [route, value] of Object.entries(source as Record<string, unknown>)) {
      if (route.length === 0) continue
      const record = readRoute(value)
      if (record !== undefined) routes[route] = record
    }
  }
  return { version, routes }
}

let loaded: { path: string; stamp: string; routes: ReadonlyMap<string, DiscoveredRouteRecord> } | undefined

/** Bytes sampled from each end of the cache file for the memo key. */
const STAMP_SAMPLE_BYTES = 256

/**
 * The file's current identity, or `''` when it does not exist. Resolution
 * memoizes on this, so a sync pass that rewrites the cache is visible to the
 * very next resolution without a restart. `mtimeMs:size` alone can miss a
 * same-size rewrite inside one mtime tick, so the first and last bytes are
 * sampled too — cheap (no parse) and enough to notice any rewrite that moves
 * the document's edges.
 * @param path - the cache file.
 * @returns `mtimeMs:size:head:tail`, stable across reads of unchanged content.
 */
export function discoveredModelsStamp(path: string = discoveredModelsPath()): string {
  try {
    const stats = statSync(path)
    let head = ''
    let tail = ''
    const fd = openSync(path, 'r')
    try {
      const sample = Buffer.alloc(Math.min(STAMP_SAMPLE_BYTES, stats.size))
      const headRead = readSync(fd, sample, 0, sample.length, 0)
      head = sample.subarray(0, headRead).toString('latin1')
      if (stats.size > sample.length) {
        const tailRead = readSync(fd, sample, 0, sample.length, stats.size - sample.length)
        tail = sample.subarray(0, tailRead).toString('latin1')
      }
    } finally {
      closeSync(fd)
    }
    return `${String(stats.mtimeMs)}:${String(stats.size)}:${head}:${tail}`
  } catch {
    return ''
  }
}

/**
 * Read the discovered-model cache for one route set. Missing, unreadable, or
 * malformed files read as empty; this layer may contribute models but must
 * never be a new failure mode for configuration that does not need it.
 * @param path - the cache file; defaults to this deployment's cache.
 * @returns the normalized routes by provider id, memoized by file identity.
 */
export function discoveredRoutes(path: string = discoveredModelsPath()): ReadonlyMap<string, DiscoveredRouteRecord> {
  const stamp = discoveredModelsStamp(path)
  if (loaded !== undefined && loaded.path === path && loaded.stamp === stamp) return loaded.routes
  let routes: ReadonlyMap<string, DiscoveredRouteRecord> = EMPTY_ROUTES
  if (stamp !== '') {
    try {
      routes = new Map(Object.entries(parseDiscoveredCache(JSON.parse(readFileSync(path, 'utf8'))).routes))
    } catch {
      routes = EMPTY_ROUTES
    }
  }
  loaded = { path, stamp, routes }
  return routes
}

/** The discovered models for one route, or `undefined` when the cache says nothing about it. */
export function discoveredModelsFor(provider: string): readonly DiscoveredModelRecord[] | undefined {
  const record = discoveredRoutes().get(provider)
  return record === undefined ? undefined : record.models
}

/** Drop the memoized read; tests and cache writers call this after rewriting the file. */
export function resetDiscoveredModelsCache(): void {
  loaded = undefined
}
