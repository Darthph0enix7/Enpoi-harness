/**
 * Catalogue facts for one selectable route.
 *
 * The peer routing service never guesses a capability. Every fact comes from
 * the same sources the model picker uses:
 *
 * - catalogue entries and the gated merge from `dsh-enpoi-catalog-rules`
 *   (`readCatalogue`, or the live `catalogRules` engine when mounted);
 * - the zero-price predicate from that package's selector expansion — never a
 *   local reimplementation of the price rule;
 * - privacy through `resolvePrivacy` (unknown is never treated as no-train);
 * - raw `llm-pi-ai` model rows only for `reasoningEfforts`, which the
 *   catalog-rules projection does not carry.
 *
 * @module dsh-enpoi-peer-routing/facts
 */

import type { PeerKnown } from '@deepseek-ai/dsh-api-peer/types'
import {
  parseRulesDocument, readCatalogue, resolvePrivacy,
  type CatalogEntry, type PrivacyOverrides,
} from 'dsh-enpoi-catalog-rules'
import { readOrchestrationDocument, readSettingsDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { isRecord, trimmedString } from './util.ts'

/** Catalogue predicates the routing service reads from the live rule engine. */
export interface CatalogRulesSeam {
  /** Catalogue entries with the engine's manual gated overrides merged in. */
  catalogue?: () => readonly CatalogEntry[]
  /** Raw selector expansion, reused for the zero-price predicate. */
  expandRawSelector?: (raw: unknown) => { readonly links: readonly { readonly provider: string; readonly model: string }[] }
}

/** One route's policy-relevant facts, resolved from the catalogue at call time. */
export interface RouteFacts {
  /** Provider route id. */
  readonly provider: string
  /** Model id within that route. */
  readonly model: string
  /** Tool-calling capability; `unknown` when no source stated it. */
  readonly tools: PeerKnown
  /** Image-input capability; `unknown` when the catalogue carries no modality list. */
  readonly vision: PeerKnown
  /** Context window in tokens, when the catalogue knows it. */
  readonly contextWindow?: number
  /** Whether the catalogue proves the route zero-price; unknown when it cannot. */
  readonly zeroPrice: PeerKnown
  /** Whether the catalogue (or a manual override) marks the route gated. */
  readonly gated: PeerKnown
  /**
   * Whether the catalogue marks the route deprecated: the endpoint stopped
   * advertising it and only a route-local reference kept the record. A
   * deprecated route is never selectable.
   */
  readonly deprecated: boolean
  /** Effective training verdict; never guessed. */
  readonly trainsOnData: 'yes' | 'no' | 'unknown'
  /** Reasoning levels the model advertises, sorted; empty when none are known. */
  readonly reasoningEfforts: readonly string[]
}

/** `provider/model` key shared by every routing map. */
export function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Known numeric cost dimensions the zero-price rule reads (`input`, `output`). */
function knownCosts(entry: CatalogEntry): number[] {
  return [entry.cost?.input, entry.cost?.output]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

/** Image-input capability from the catalogue's modality list. */
function visionOf(entry: CatalogEntry): PeerKnown {
  if (entry.input === undefined) return 'unknown'
  return entry.input.includes('image') || entry.input.includes('vision')
}

/** Map a privacy verdict to the peer contract's training vocabulary. */
function trainsOnDataOf(verdict: 'trains' | 'no-train' | 'unknown'): 'yes' | 'no' | 'unknown' {
  if (verdict === 'no-train') return 'no'
  if (verdict === 'trains') return 'yes'
  return 'unknown'
}

/**
 * Project one raw `reasoningEfforts` value into sorted level identifiers. The
 * stored form is the llm-pi-ai effort dict (`level → wire spelling`); an array
 * is accepted defensively, and anything else answers an empty ladder.
 * @param raw - raw `reasoningEfforts` field from a `llm-pi-ai` model row.
 * @returns sorted effort identifiers; empty when none are declared.
 */
export function projectReasoningEfforts(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return Object.freeze(raw
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item !== '')
      .sort())
  }
  if (isRecord(raw)) return Object.freeze(Object.keys(raw).filter(key => key.trim() !== '').sort())
  return Object.freeze([])
}

/**
 * Read every raw `llm-pi-ai` model row's `reasoningEfforts` field, keyed by
 * `provider/model`. The catalogue projection does not carry the ladder, so the
 * service reads exactly this one field from the raw document.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns raw effort fields, first row winning per route.
 */
export function readRawEfforts(settings: SettingsDocumentReader | undefined): ReadonlyMap<string, unknown> {
  const efforts = new Map<string, unknown>()
  const document = readSettingsDocument(settings, 'llm-pi-ai')
  const providers = document?.providers
  if (!isRecord(providers)) return efforts
  for (const [provider, profile] of Object.entries(providers)) {
    if (!isRecord(profile) || !Array.isArray(profile.models)) continue
    for (const raw of profile.models) {
      if (!isRecord(raw)) continue
      const id = trimmedString(raw.id)
      if (id === undefined) continue
      const key = routeKey(provider, id)
      if (!efforts.has(key)) efforts.set(key, raw.reasoningEfforts)
    }
  }
  return efforts
}

/**
 * Catalogue entries to evaluate: the live rules engine's projection when it is
 * mounted (manual gated overrides included), the raw catalogue only when no
 * engine exists. A mounted engine that throws or cannot project answers NO
 * routes, so a manual gate can never be bypassed by a rules failure.
 * @param rules - the `catalogRules` service seam, when mounted.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns catalogue entries with gated markers applied.
 */
export function readGatedCatalogue(
  rules: CatalogRulesSeam | undefined,
  settings: SettingsDocumentReader | undefined,
): readonly CatalogEntry[] {
  if (rules !== undefined) {
    try {
      return rules.catalogue?.() ?? []
    } catch {
      return []
    }
  }
  return readCatalogue(settings)
}

/** The zero-price selector expansion, as the routing service consumes it. */
export interface ZeroPriceExpansion {
  readonly links: readonly { readonly provider: string; readonly model: string }[]
}

/** `provider/model` keys the zero-price selector matched. */
export function zeroPriceKeysOf(expansion: ZeroPriceExpansion | undefined): ReadonlySet<string> | undefined {
  if (expansion === undefined) return undefined
  return new Set(expansion.links.map(link => routeKey(link.provider, link.model)))
}

/**
 * Ask the live rules engine for the zero-price set. When the engine is absent
 * or the expansion throws, the answer is `undefined` — unknown price, which
 * every price-requiring policy refuses.
 * @param rules - the `catalogRules` service seam, when mounted.
 * @returns zero-price route keys, or undefined when unprovable.
 */
export function readZeroPriceKeys(rules: CatalogRulesSeam | undefined): ReadonlySet<string> | undefined {
  if (rules?.expandRawSelector === undefined) return undefined
  try {
    return zeroPriceKeysOf(rules.expandRawSelector({ when: { zeroPrice: true } }))
  } catch {
    return undefined
  }
}

/**
 * Read the effective privacy overrides from the shared orchestration document.
 * The curated seed stays in `resolvePrivacy`, so an absent document answers the
 * seed's verdict, never an optimistic default.
 * @param settings - the `settings` service from `ctx.get('settings')`.
 * @returns the document's privacy section (the seed is applied at lookup time).
 */
export function readPrivacyOverrides(settings: SettingsDocumentReader | undefined): PrivacyOverrides | undefined {
  return parseRulesDocument(readOrchestrationDocument(settings)?.catalogRules).privacy
}

/** Inputs of {@link projectRouteFacts}. */
export interface RouteFactsOptions {
  /** Catalogue entries with gated markers applied. */
  readonly entries: readonly CatalogEntry[]
  /** Raw `reasoningEfforts` fields keyed by `provider/model`. */
  readonly rawEfforts: ReadonlyMap<string, unknown>
  /** Zero-price route keys, or undefined when the rule engine cannot prove them. */
  readonly zeroPriceKeys: ReadonlySet<string> | undefined
  /** Effective privacy overrides for `resolvePrivacy`. */
  readonly privacy: PrivacyOverrides | undefined
}

/**
 * Project every catalogue entry into {@link RouteFacts}. This is the ONE
 * projection both `evaluate` and `discover` read, so discovery can never show a
 * route whose facts evaluation would refuse.
 * @param options - catalogue, raw efforts, zero-price keys, and privacy.
 * @returns facts keyed by `provider/model`, first row winning per route.
 */
export function projectRouteFacts(options: RouteFactsOptions): ReadonlyMap<string, RouteFacts> {
  const facts = new Map<string, RouteFacts>()
  for (const entry of options.entries) {
    const key = routeKey(entry.provider, entry.id)
    if (facts.has(key)) continue
    const costs = knownCosts(entry)
    facts.set(key, {
      provider: entry.provider,
      model: entry.id,
      tools: entry.tools === true ? true : entry.tools === false ? false : 'unknown',
      vision: visionOf(entry),
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      zeroPrice: costs.length === 0 || options.zeroPriceKeys === undefined
        ? 'unknown'
        : options.zeroPriceKeys.has(key),
      gated: entry.gated === true,
      deprecated: entry.deprecated === true,
      trainsOnData: trainsOnDataOf(resolvePrivacy(entry.provider, entry.id, options.privacy)),
      reasoningEfforts: projectReasoningEfforts(options.rawEfforts.get(key)),
    })
  }
  return facts
}
