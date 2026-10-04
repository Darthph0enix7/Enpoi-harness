/**
 * enpoi-model-chains — settings-defined model failover chains.
 *
 * A chain (UI name: "model group") is an ordered list of `{ provider, model,
 * effort? }` links that mixes providers/models, so a consumer that fails on
 * one link can continue on the next instead of dying. Data lives in the
 * shared `enpoi-orchestration` settings namespace under `chains` (the same
 * host-side settings API every other profile plugin reads; the namespace
 * schema is registered by enpoi-capabilities):
 *
 *   chains:
 *     stable:
 *       label: Stable
 *       links: [ { provider, model, effort? }, … ]   # ordered, explicit members
 *       selectors:                                    # optional, live at resolve
 *         - when: { zeroPrice: true, tools: true, minContextWindow: 32768, noTraining: true }
 *           adopt: true      # opt-in: new matches join; default false = candidates only
 *       attempts: 2        # per link; consumed by the fork's adapter loop
 *       onCut: failover    # failover | continue
 *       disabled: false    # retire switch
 *
 * This plugin provides the `modelChains` service the fork lanes and the
 * one-shot consumers resolve through:
 *
 *   ctx.get('modelChains').resolve('stable')
 *     → { id, label?, links: [{ provider, model, effort? }], attempts?, onCut? }
 *   ctx.get('modelChains').preview('stable')
 *     → { id, links, previous, added, removed, candidates, warnings }
 *
 * Explicit links come first; selector matches are appended, evaluated against
 * the live catalogue through the `catalogRules` service when it is mounted. A
 * selector adopts the matches present at its first evaluation; with
 * `adopt: true` it also continuously adopts new matches (announced on
 * stderr), while the default `adopt: false` reports newer ones as preview-only
 * candidates — auto-adoption is opt-in.
 *
 * `resolve()` answers a FROZEN, detached snapshot: the array and every link
 * are frozen, and the cache is rebuilt only on `settings/document-updated`
 * (and `settings/updated`) for `enpoi-orchestration`. A caller that snapshots
 * at turn/step start therefore keeps one consistent chain across its
 * attempts while an operator edit applies on the next resolution.
 *
 * Failure posture is FAIL-OPEN: an unknown id, `disabled: true`, a malformed
 * document, and an absent service all answer `undefined`, so the caller keeps
 * its inherited/default model. Malformed links (empty provider/model) are
 * dropped, never fatal, with one stderr warning per chain id — this harness's
 * logger drops info/warn, so stderr is the observable channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'

export const name = 'enpoi-model-chains'

/** The settings service must be up before the namespace can be read. */
export const inject = ['settings']

/** Namespace that owns `chains` (registered by enpoi-capabilities). */
const ORCH_NS = 'enpoi-orchestration'

/** One chain link: a provider route carrying exactly one model. */
export interface ModelChainLink {
  /** Provider route id (e.g. `antigravity`). */
  provider: string
  /** Model id interpreted by that provider (e.g. `gemini-3.8-flash-tiered`). */
  model: string
  /** Adapter-owned reasoning effort for this link, when declared. */
  effort?: string
}

/** One group selector: a predicate expanded against the live catalogue. */
export interface ChainSelector {
  /** Predicate clauses, validated and expanded by the `catalogRules` service. */
  when: Record<string, unknown>
  /** Continuous auto-adoption of new matches: opt-in (true), default false. */
  adopt: boolean
  /** Operator-facing label, when declared. */
  label?: string
}

/** One selector expansion as answered by the `catalogRules` service. */
export interface SelectorExpansion {
  /** Best-first matches. */
  links: ReadonlyArray<Readonly<ModelChainLink>>
  /** Discipline warnings (an empty selector warns; it never silently empties). */
  warnings?: readonly string[]
}

/** Expands one parsed selector against the live catalogue. */
export type SelectorExpander = (selector: ChainSelector, chainId: string, selectorIndex: number) => SelectorExpansion

/** One resolved chain snapshot; frozen by {@link ModelChainsResolver.resolve}. */
export interface ModelChain {
  /** Chain id as declared under `chains`. */
  id: string
  /** Operator-facing label, when declared. */
  label?: string
  /** Ordered links; never empty, never containing a malformed entry. */
  links: ReadonlyArray<Readonly<ModelChainLink>>
  /** Group selectors evaluated at resolve time (explicit links stay first). */
  selectors?: ReadonlyArray<Readonly<ChainSelector>>
  /** Per-link attempt budget declared by the operator (absent = caller default). */
  attempts?: number
  /** Cut policy (absent = caller's `failover` default). */
  onCut?: 'failover' | 'continue'
}

/** One chain preview: what it resolves to now, and what changed since the last resolve. */
export interface ChainPreview {
  /** Chain id. */
  id: string
  /** Links `resolve()` would answer right now. */
  links: ReadonlyArray<Readonly<ModelChainLink>>
  /** Links from the last `resolve()` in this process, or null when never resolved. */
  previous: ReadonlyArray<Readonly<ModelChainLink>> | null
  /** `provider/model` keys that joined since the last resolve. */
  added: readonly string[]
  /** `provider/model` keys that left since the last resolve. */
  removed: readonly string[]
  /** Matches a selector with `adopt: false` would add; adoption is opt-in. */
  candidates: ReadonlyArray<Readonly<ModelChainLink>>
  /** Expansion warnings (empty selectors, absent service). */
  warnings: readonly string[]
}

/** The service contract consumers call through `ctx.get('modelChains')`. */
export interface ModelChainsService {
  /**
   * Resolve one chain id to a frozen snapshot.
   * @param id - chain id from `enpoi-orchestration.chains`.
   * @returns the frozen chain, or `undefined` for unknown/disabled/malformed ids.
   */
  resolve(id: string): ModelChain | undefined
  /**
   * Preview one chain id: current resolution, previous resolution, and the
   * candidates an `adopt: false` selector is holding back.
   * @param id - chain id.
   * @returns the preview, or undefined for unknown/disabled/malformed ids.
   */
  preview(id: string): ChainPreview | undefined
}

/** Optional construction seams (ctx-bound in production, fakes in tests). */
export interface ModelChainsResolverOptions {
  /** Selector expander; absent leaves selector chains on their explicit links only. */
  expandSelector?: SelectorExpander
  /** Warning sink; defaults to stderr. */
  warn?: (line: string) => void
}

/** Whether one value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Parse one raw selector entry. Malformed entries are dropped with a warning. */
export function parseChainSelector(raw: unknown, warn: (line: string) => void): ChainSelector | undefined {
  if (!isRecord(raw)) {
    warn('selector is not an object — ignored\n')
    return undefined
  }
  if (!isRecord(raw.when) || Object.keys(raw.when).length === 0) {
    warn('selector has no "when" object — ignored\n')
    return undefined
  }
  const label = nonEmptyString(raw.label)
  return Object.freeze({
    when: Object.freeze({ ...raw.when }),
    adopt: raw.adopt === true,
    ...(label !== undefined ? { label } : {}),
  })
}

/**
 * Parse one raw `chains[id]` entry into a frozen snapshot. Malformed links and
 * selectors are dropped (with a warning); disabled, shapeless, and member-less
 * entries answer `undefined` so callers fail open.
 * @param id - the chain id being parsed (used in warnings and the snapshot).
 * @param raw - the raw `chains[id]` settings value.
 * @param warn - stderr reporter; the resolver dedupes it per id.
 * @returns the frozen chain, or undefined when unusable.
 */
export function parseChainEntry(
  id: string,
  raw: unknown,
  warn: (line: string) => void,
): ModelChain | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    warn(`[enpoi-model-chains] chain "${id}" is not an object — ignored\n`)
    return undefined
  }
  if (raw.disabled === true) return undefined
  const rawLinks = raw.links
  if (rawLinks !== undefined && !Array.isArray(rawLinks)) {
    warn(`[enpoi-model-chains] chain "${id}" has no links array — ignored\n`)
    return undefined
  }
  const links: ModelChainLink[] = []
  let dropped = 0
  for (const candidate of rawLinks ?? []) {
    if (!isRecord(candidate)) {
      dropped += 1
      continue
    }
    const provider = nonEmptyString(candidate.provider)
    const model = nonEmptyString(candidate.model)
    if (provider === undefined || model === undefined) {
      dropped += 1
      continue
    }
    const effort = nonEmptyString(candidate.effort)
    links.push(Object.freeze({ provider, model, ...(effort !== undefined ? { effort } : {}) }))
  }
  if (dropped > 0) {
    warn(`[enpoi-model-chains] chain "${id}": dropped ${dropped} malformed link(s) — provider and model are required\n`)
  }
  const selectors: ChainSelector[] = []
  let droppedSelectors = 0
  if (raw.selectors !== undefined) {
    if (!Array.isArray(raw.selectors)) {
      warn(`[enpoi-model-chains] chain "${id}": selectors is not an array — ignored\n`)
    } else {
      for (const candidate of raw.selectors) {
        const selector = parseChainSelector(candidate, line => { warn(`[enpoi-model-chains] chain "${id}": ${line}`) })
        if (selector === undefined) {
          droppedSelectors += 1
          continue
        }
        selectors.push(selector)
      }
      if (droppedSelectors > 0) {
        warn(`[enpoi-model-chains] chain "${id}": dropped ${droppedSelectors} malformed selector(s)\n`)
      }
    }
  }
  if (links.length === 0 && selectors.length === 0) {
    warn(`[enpoi-model-chains] chain "${id}" has no usable links or selectors — ignored\n`)
    return undefined
  }
  const label = nonEmptyString(raw.label)
  const attemptsValue = raw.attempts
  const attempts = typeof attemptsValue === 'number' && Number.isFinite(attemptsValue) && attemptsValue >= 1
    ? Math.floor(attemptsValue)
    : undefined
  const onCut = raw.onCut === 'continue' ? 'continue' as const : raw.onCut === 'failover' ? 'failover' as const : undefined
  return Object.freeze({
    id,
    ...(label !== undefined ? { label } : {}),
    links: Object.freeze(links),
    ...(selectors.length > 0 ? { selectors: Object.freeze(selectors) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(onCut !== undefined ? { onCut } : {}),
  })
}

/**
 * Read the raw `enpoi-orchestration.chains` map through the same host-side
 * settings API the other profile plugins use. A missing/malformed map resolves
 * as empty so one bad document cannot brick every consumer.
 * @param ctx - owning plugin context.
 * @returns the raw chain map (possibly empty).
 */
export function readRawChains(ctx: Context): Record<string, unknown> {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    if (!isRecord(doc)) return {}
    const chains = doc.chains
    if (chains === undefined) return {}
    if (!isRecord(chains)) {
      process.stderr.write(`[enpoi-model-chains] "${ORCH_NS}.chains" is not a map — ignored\n`)
      return {}
    }
    return chains
  } catch (error) {
    process.stderr.write(`[enpoi-model-chains] cannot read "${ORCH_NS}.chains": ${String(error)}\n`)
    return {}
  }
}

/** `provider/model` key used for dedupe and announcements. */
function linkKey(link: Readonly<ModelChainLink>): string {
  return `${link.provider}/${link.model}`
}

/** One expanded chain: merged links plus expansion diagnostics. */
interface ExpandedChain {
  links: ModelChainLink[]
  candidates: ModelChainLink[]
  warnings: string[]
}

/**
 * Caching chain resolver. The raw document is read once at construction and
 * rebuilt by {@link refresh} — callers through {@link ModelChainsService.resolve}
 * never see live edits mid-turn, and a malformed chain is reported once per id
 * (until it parses clean, so a re-broken chain warns again). Selector chains
 * re-evaluate against the live catalogue on every resolve.
 */
export class ModelChainsResolver implements ModelChainsService {
  private raw: Record<string, unknown>
  private readonly cache = new Map<string, ModelChain | undefined>()
  private readonly warned = new Set<string>()
  private readonly selectorWarned = new Set<string>()
  private readonly announced = new Set<string>()
  private readonly lastResolved = new Map<string, readonly ModelChainLink[]>()
  private readonly baselines = new Map<string, Set<string>>()

  /**
   * @param readRaw - reader for the raw `chains` map (ctx-bound in production).
   * @param options - optional selector expander and warning sink.
   */
  constructor(
    private readonly readRaw: () => Record<string, unknown>,
    private readonly options: ModelChainsResolverOptions = {},
  ) {
    this.raw = this.readRaw()
  }

  /** Re-read the settings document; the next resolve builds fresh snapshots. */
  refresh(): void {
    this.raw = this.readRaw()
    this.cache.clear()
    // An operator edit re-baselines `adopt: false` selectors: the edited
    // document is the operator's latest adoption decision.
    this.baselines.clear()
  }

  /** The warning sink: injected in tests, stderr in production. */
  private warn(line: string): void {
    ;(this.options.warn ?? ((text: string) => { process.stderr.write(text) }))(line)
  }

  /** Parse (and cache) one chain, with per-id warning dedupe. */
  private chainOf(key: string): ModelChain | undefined {
    if (this.cache.has(key)) return this.cache.get(key)
    let reported = false
    const chain = parseChainEntry(key, this.raw[key], (line) => {
      if (reported || this.warned.has(key)) return
      reported = true
      this.warned.add(key)
      this.warn(line)
    })
    if (chain !== undefined) this.warned.delete(key)
    this.cache.set(key, chain)
    return chain
  }

  /**
   * Merge explicit links with selector matches.
   * @param chain - parsed chain.
   * @param announce - whether newly joined links should be announced.
   * @returns merged links, candidates held back by `adopt: false`, warnings.
   */
  private expandChain(chain: ModelChain, announce: boolean): ExpandedChain {
    const links: ModelChainLink[] = []
    const seen = new Set<string>()
    const warnings: string[] = []
    const candidates: ModelChainLink[] = []
    const add = (link: ModelChainLink): void => {
      const key = linkKey(link)
      if (seen.has(key)) return
      seen.add(key)
      links.push(link)
    }
    for (const link of chain.links) add(link)
    const selectors = chain.selectors ?? []
    selectors.forEach((selector, index) => {
      if (this.options.expandSelector === undefined) {
        warnings.push(`[enpoi-model-chains] chain "${chain.id}" selector #${String(index + 1)}: catalogRules service absent — selector ignored\n`)
        return
      }
      const selectionKey = `${chain.id}#${String(index)}`
      let expansion: SelectorExpansion
      try {
        expansion = this.options.expandSelector(selector, chain.id, index)
      } catch (error) {
        warnings.push(`[enpoi-model-chains] chain "${chain.id}" selector #${String(index + 1)} failed: ${error instanceof Error ? error.message : String(error)}\n`)
        return
      }
      for (const line of expansion.warnings ?? []) warnings.push(line)
      const matches = expansion.links.map(link => Object.freeze({ provider: link.provider, model: link.model }))
      if (selector.adopt === false) {
        let baseline = this.baselines.get(selectionKey)
        if (baseline === undefined) {
          baseline = new Set(matches.map(linkKey))
          this.baselines.set(selectionKey, baseline)
        }
        for (const link of matches) {
          if (baseline.has(linkKey(link))) add(link)
          else candidates.push(link)
        }
      } else {
        for (const link of matches) add(link)
      }
    })
    if (candidates.length > 0) {
      const names = candidates.map(linkKey).join(', ')
      warnings.push(`[enpoi-model-chains] chain "${chain.id}": ${String(candidates.length)} new selector match(es) awaiting adoption (adopt: false): ${names}\n`)
    }
    if (announce) {
      const previous = this.lastResolved.get(chain.id)
      if (previous !== undefined) {
        const previousKeys = new Set(previous.map(linkKey))
        for (const link of links) {
          const key = linkKey(link)
          const memo = `${chain.id}\u0000${key}`
          if (previousKeys.has(key) || this.announced.has(memo)) continue
          this.announced.add(memo)
          warnings.push(`[enpoi-model-chains] a new model joined chain "${chain.id}": ${key}\n`)
        }
      }
    }
    return { links, candidates, warnings }
  }

  /** Write each expansion warning once per selector position. */
  private reportWarnings(chainId: string, warnings: readonly string[]): void {
    for (const line of warnings) {
      if (this.selectorWarned.has(line)) continue
      this.selectorWarned.add(line)
      this.warn(line)
    }
  }

  /**
   * Resolve one chain id against the current snapshot.
   * @param id - chain id.
   * @returns the frozen chain, or undefined (unknown/disabled/malformed).
   */
  resolve(id: string): ModelChain | undefined {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') return undefined
    const chain = this.chainOf(key)
    if (chain === undefined) return undefined
    if (chain.selectors === undefined) return chain
    const expanded = this.expandChain(chain, true)
    this.reportWarnings(key, expanded.warnings)
    if (expanded.links.length === 0) {
      this.selectorWarned.add(key)
      this.warn(`[enpoi-model-chains] chain "${key}" has no usable links or selector matches — ignored\n`)
      return undefined
    }
    const frozenLinks = Object.freeze(expanded.links.map(link => Object.freeze(link)))
    this.lastResolved.set(key, frozenLinks)
    return Object.freeze({ ...chain, links: frozenLinks })
  }

  /**
   * Preview one chain id without changing what the next resolve answers.
   * @param id - chain id.
   * @returns current/previous links, added/removed keys, held-back candidates.
   */
  preview(id: string): ChainPreview | undefined {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') return undefined
    const chain = this.chainOf(key)
    if (chain === undefined) return undefined
    if (chain.selectors === undefined) {
      return Object.freeze({
        id: key,
        links: chain.links,
        previous: this.lastResolved.get(key) ?? null,
        added: Object.freeze([]),
        removed: Object.freeze([]),
        candidates: Object.freeze([]),
        warnings: Object.freeze([]),
      })
    }
    const expanded = this.expandChain(chain, false)
    const previous = this.lastResolved.get(key) ?? null
    const currentKeys = expanded.links.map(linkKey)
    const previousKeys = (previous ?? []).map(linkKey)
    const currentSet = new Set(currentKeys)
    const previousSet = new Set(previousKeys)
    return Object.freeze({
      id: key,
      links: Object.freeze(expanded.links.map(link => Object.freeze(link))),
      previous,
      added: Object.freeze(currentKeys.filter(candidate => !previousSet.has(candidate))),
      removed: Object.freeze(previousKeys.filter(candidate => !currentSet.has(candidate))),
      candidates: Object.freeze(expanded.candidates.map(link => Object.freeze(link))),
      warnings: Object.freeze(expanded.warnings),
    })
  }
}

/** The `catalogRules` seam as this plugin consumes it. */
interface CatalogRulesSeam {
  /** Parses and expands one raw selector against the live catalogue. */
  expandRawSelector?(raw: unknown): SelectorExpansion
  /** Typed expansion path used by hosts that already parsed the selector. */
  expandSelector?(selector: { when: unknown; adopt?: boolean; label?: string }): SelectorExpansion
}

/**
 * Mount the `modelChains` service and keep it in step with the namespace.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  const expander: SelectorExpander = (selector, chainId, selectorIndex) => {
    const rules = ctx.get('catalogRules') as CatalogRulesSeam | undefined
    if (rules?.expandRawSelector !== undefined) return rules.expandRawSelector(selector)
    if (rules?.expandSelector !== undefined) return rules.expandSelector(selector)
    return {
      links: [],
      warnings: [`[enpoi-model-chains] chain "${chainId}" selector #${String(selectorIndex + 1)}: catalogRules service absent — selector ignored\n`],
    }
  }
  const resolver = new ModelChainsResolver(() => readRawChains(ctx), { expandSelector: expander })
  // Plain-object facade: the contract's methods are this-bound to nothing, so
  // a caller that destructures them (`const { resolve } = service`) still works.
  ctx.provide('modelChains', {
    resolve: (id: string) => resolver.resolve(id),
    preview: (id: string) => resolver.preview(id),
  })
  const onNamespaceChange = ((ns: unknown) => {
    if (String(ns) !== ORCH_NS) return
    resolver.refresh()
  }) as (...args: unknown[]) => unknown
  ctx.on('settings/document-updated', onNamespaceChange)
  ctx.on('settings/updated', onNamespaceChange)
  process.stderr.write('[enpoi-model-chains] mounted\n')
}
