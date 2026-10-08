/**
 * enpoi-catalog-rules — pure rule model for the synced model catalogue.
 *
 * Rules are DATA (the `enpoi-orchestration.catalogRules` settings document),
 * versioned and operator-editable. This module owns the predicate vocabulary,
 * the seeded privacy map, document parsing, and visibility resolution. It is
 * dependency-free (no Cordis, no Node builtins) so the same functions can back
 * both the host plugin and a future picker-side reason renderer.
 *
 * Visibility precedence (manual always wins, the permission-row pattern):
 *   manual hidden  >  manual shown  >  gated marker  >  hide rules  >  default visible.
 * Unknown privacy is `unknown` and never satisfies a `noTraining` predicate in
 * either direction — unknown is neither safe nor a trainer.
 *
 * Hide rules only affect visibility; they never delete catalogue entries.
 */

/** One cost dimension from models.dev, USD per million tokens. */
export interface CatalogCost {
  /** Input-token price per million, when known. */
  input?: number
  /** Output-token price per million, when known. */
  output?: number
}

/** One catalogue entry as projected from `llm-pi-ai.providers[route].models`. */
export interface CatalogEntry {
  /** Provider route id (e.g. `openrouter`). */
  provider: string
  /** Model id as the provider exposes it. */
  id: string
  /** Operator-facing name, when known. */
  name?: string
  /** Context window in tokens, when known. */
  contextWindow?: number
  /** Max output tokens, when known. */
  maxTokens?: number
  /** Input modalities from models.dev (`text`, `image`, …). */
  input?: readonly string[]
  /** Reasoning capability, when known. */
  reasoning?: boolean
  /** Tool-calling capability, when known. */
  tools?: boolean
  /** Price dimensions, when known. */
  cost?: CatalogCost
  /** Client-side gating (unavailable from this client, e.g. a plan wall). */
  gated?: boolean
  /**
   * Why the entry is gated, when the catalogue knows (e.g. `sign-in required`
   * from the provider sync's `isFree: false` verdict). The picker renders it;
   * a gate with no known reason falls back to `gated`.
   */
  gateReason?: string
}

/** Effective training policy for one provider/model. */
export type PrivacyPolicy = 'trains' | 'no-train'
/** Effective training policy, or `unknown` when no curated fact covers it. */
export type PrivacyVerdict = PrivacyPolicy | 'unknown'

/**
 * Privacy overrides, provider-level plus exact per-model entries. A `null`
 * value deletes that one seeded entry; `useSeed: false` disables the curated
 * seed entirely. Either way, whatever is left unanswered stays `unknown`.
 */
export interface PrivacyOverrides {
  /** Provider route id → policy, or `null` to delete the seeded entry. */
  providers?: Record<string, unknown>
  /** `provider/model` (or bare model id) → policy, or `null` to delete the seeded entry; beats the provider entry. */
  models?: Record<string, unknown>
  /** When false, the curated seed is not applied at all; only this document's entries answer. */
  useSeed?: boolean
}

/**
 * Curated privacy seed. Google/Kilo/Mistral free tiers train on content; Groq
 * and paid Mistral models do not. Anything absent stays `unknown` (never
 * treated as safe). The settings document may override every entry, delete one
 * with a `null` value, or disable the seed entirely with `useSeed: false`.
 */
export const SEED_PRIVACY: { providers: Record<string, PrivacyPolicy>; models: Record<string, PrivacyPolicy> } = Object.freeze({
  providers: Object.freeze({
    google: 'trains',
    'google-ai-studio': 'trains',
    antigravity: 'trains',
    kilo: 'trains',
    'kilo-code': 'trains',
    mistral: 'trains',
    groq: 'no-train',
  }),
  models: Object.freeze({
    'mistral/mistral-large-latest': 'no-train',
    'mistral/mistral-medium-latest': 'no-train',
    'mistral/mistral-small-latest': 'no-train',
    'mistral/codestral-latest': 'no-train',
  }),
})

/** Whether one value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed non-empty string, or undefined. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A finite number, or undefined. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A policy value from untrusted data, or undefined when not one of the two literals. */
function privacyPolicy(value: unknown): PrivacyPolicy | undefined {
  return value === 'trains' || value === 'no-train' ? value : undefined
}

/**
 * Merge the curated seed with one document's privacy section (document wins
 * per key, invalid values are ignored rather than trusted). A `null` document
 * value deletes that key from the effective maps — the entry then falls back
 * to the next lookup level, and to `unknown` when none answers. `useSeed:
 * false` starts from empty maps, so only the document's own entries answer.
 * @param overrides - the `catalogRules.privacy` document section, if any.
 * @returns effective provider and model policy maps.
 */
export function effectivePrivacy(overrides: PrivacyOverrides | undefined): { providers: Record<string, PrivacyPolicy>; models: Record<string, PrivacyPolicy> } {
  const useSeed = overrides?.useSeed !== false
  const providers: Record<string, PrivacyPolicy> = useSeed ? { ...SEED_PRIVACY.providers } : {}
  const models: Record<string, PrivacyPolicy> = useSeed ? { ...SEED_PRIVACY.models } : {}
  if (overrides?.providers !== undefined && isRecord(overrides.providers)) {
    for (const [key, value] of Object.entries(overrides.providers)) {
      if (value === null) {
        delete providers[key]
        continue
      }
      const policy = privacyPolicy(value)
      if (policy !== undefined) providers[key] = policy
    }
  }
  if (overrides?.models !== undefined && isRecord(overrides.models)) {
    for (const [key, value] of Object.entries(overrides.models)) {
      if (value === null) {
        delete models[key]
        continue
      }
      const policy = privacyPolicy(value)
      if (policy !== undefined) models[key] = policy
    }
  }
  return { providers, models }
}

/**
 * Resolve the effective training policy for one provider/model.
 * Lookup order: `provider/model` exact → bare model id → provider → unknown.
 * @param provider - provider route id.
 * @param modelId - model id.
 * @param overrides - document privacy overrides (the curated seed is merged in).
 * @returns the effective verdict.
 */
export function resolvePrivacy(provider: string, modelId: string, overrides?: PrivacyOverrides): PrivacyVerdict {
  const { providers, models } = effectivePrivacy(overrides)
  return models[`${provider}/${modelId}`] ?? models[modelId] ?? providers[provider] ?? 'unknown'
}

/** Predicate vocabulary over catalogue entries; every present clause must pass (AND). */
export interface CatalogPredicate {
  /** `true` = at least one known price and all known prices are 0. Unknown price fails. */
  zeroPrice?: boolean
  /** Highest known price dimension must be ≤ this (USD per million). Unknown price fails. */
  maxPrice?: number
  /** Tool-calling capability. */
  tools?: boolean
  /** Image input modality. */
  vision?: boolean
  /** Audio input modality. */
  audio?: boolean
  /** Video input modality. */
  video?: boolean
  /** PDF (document) input modality. */
  pdf?: boolean
  /** Reasoning capability. */
  reasoning?: boolean
  /** Context window ≥ N; unknown context fails. */
  minContextWindow?: number
  /** Exact provider route id. */
  provider?: string
  /** Provider route id glob (`*`, `?`, case-insensitive). */
  providerGlob?: string
  /** Model id glob. */
  idGlob?: string
  /** Model name glob; unknown name fails. */
  nameGlob?: string
  /** `true` = verified no-train only; `false` = verified trainer only; unknown fails both. */
  noTraining?: boolean
  /** Gated marker. */
  gated?: boolean
}

/** One predicate evaluation: whether it matched, and the first failed clause. */
export interface PredicateEvaluation {
  matched: boolean
  /** Human clause name that failed first, when unmatched. */
  failed?: string
}

/**
 * Match a glob (`*` any run, `?` one character) case-insensitively.
 * @param pattern - glob pattern.
 * @param value - candidate string.
 * @returns whether the whole value matches.
 */
export function globMatches(pattern: string, value: string): boolean {
  let source = ''
  for (const character of pattern) {
    if (character === '*') source += '.*'
    else if (character === '?') source += '.'
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${source}$`, 'i').test(value)
  } catch {
    return false
  }
}

/** Known numeric cost dimensions of one entry. */
function knownCosts(entry: CatalogEntry): number[] {
  const values = [entry.cost?.input, entry.cost?.output].filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values
}

/** Whether every known price is zero (and at least one is known). */
function isKnownZeroPrice(entry: CatalogEntry): boolean {
  const costs = knownCosts(entry)
  return costs.length > 0 && costs.every(cost => cost === 0)
}

/** Whether the entry carries an image input modality. */
function hasVision(entry: CatalogEntry): boolean {
  return Array.isArray(entry.input) && (entry.input.includes('image') || entry.input.includes('vision'))
}

/** Whether the entry carries an audio input modality. */
function hasAudio(entry: CatalogEntry): boolean {
  return Array.isArray(entry.input) && entry.input.includes('audio')
}

/** Whether the entry carries a video input modality. */
function hasVideo(entry: CatalogEntry): boolean {
  return Array.isArray(entry.input) && entry.input.includes('video')
}

/** Whether the entry carries a PDF (document) input modality. */
function hasPdf(entry: CatalogEntry): boolean {
  return Array.isArray(entry.input) && entry.input.includes('pdf')
}

/**
 * Evaluate one predicate against one entry.
 * A predicate with no recognized clauses never matches (a malformed rule must
 * not hide the whole catalogue).
 * @param entry - catalogue entry.
 * @param predicate - predicate clauses (ANDed).
 * @param privacy - pre-resolved privacy verdict for the entry.
 * @returns the evaluation.
 */
export function evaluatePredicate(entry: CatalogEntry, predicate: CatalogPredicate, privacy: PrivacyVerdict): PredicateEvaluation {
  let clauses = 0
  const fail = (failed: string): PredicateEvaluation => ({ matched: false, failed })

  if (predicate.zeroPrice !== undefined) {
    clauses += 1
    if (predicate.zeroPrice !== isKnownZeroPrice(entry)) return fail('zero-price')
  }
  if (predicate.maxPrice !== undefined) {
    clauses += 1
    const costs = knownCosts(entry)
    const limit = predicate.maxPrice
    if (costs.length === 0 || !costs.every(cost => cost <= limit)) return fail(`price ≤ ${String(limit)}`)
  }
  if (predicate.tools !== undefined) {
    clauses += 1
    if (predicate.tools !== (entry.tools === true)) return fail(predicate.tools ? 'tool-calling' : 'no tool-calling')
  }
  if (predicate.vision !== undefined) {
    clauses += 1
    if (predicate.vision !== hasVision(entry)) return fail(predicate.vision ? 'vision' : 'no vision')
  }
  if (predicate.audio !== undefined) {
    clauses += 1
    if (predicate.audio !== hasAudio(entry)) return fail(predicate.audio ? 'audio' : 'no audio')
  }
  if (predicate.video !== undefined) {
    clauses += 1
    if (predicate.video !== hasVideo(entry)) return fail(predicate.video ? 'video' : 'no video')
  }
  if (predicate.pdf !== undefined) {
    clauses += 1
    if (predicate.pdf !== hasPdf(entry)) return fail(predicate.pdf ? 'pdf' : 'no pdf')
  }
  if (predicate.reasoning !== undefined) {
    clauses += 1
    if (predicate.reasoning !== (entry.reasoning === true)) return fail(predicate.reasoning ? 'reasoning' : 'no reasoning')
  }
  if (predicate.minContextWindow !== undefined) {
    clauses += 1
    const context = entry.contextWindow
    if (context === undefined || context < predicate.minContextWindow) return fail(`context ≥ ${String(predicate.minContextWindow)}`)
  }
  if (predicate.provider !== undefined) {
    clauses += 1
    if (entry.provider !== predicate.provider) return fail(`provider ${predicate.provider}`)
  }
  if (predicate.providerGlob !== undefined) {
    clauses += 1
    if (!globMatches(predicate.providerGlob, entry.provider)) return fail(`provider ~ ${predicate.providerGlob}`)
  }
  if (predicate.idGlob !== undefined) {
    clauses += 1
    if (!globMatches(predicate.idGlob, entry.id)) return fail(`id ~ ${predicate.idGlob}`)
  }
  if (predicate.nameGlob !== undefined) {
    clauses += 1
    if (entry.name === undefined || !globMatches(predicate.nameGlob, entry.name)) return fail(`name ~ ${predicate.nameGlob}`)
  }
  if (predicate.noTraining !== undefined) {
    clauses += 1
    const wanted: PrivacyPolicy = predicate.noTraining ? 'no-train' : 'trains'
    if (privacy !== wanted) return fail(predicate.noTraining ? 'no-training' : 'trains-on-content')
  }
  if (predicate.gated !== undefined) {
    clauses += 1
    if (predicate.gated !== (entry.gated === true)) return fail(predicate.gated ? 'gated' : 'not gated')
  }

  return clauses === 0 ? fail('empty predicate') : { matched: true }
}

/**
 * Short human summary of a predicate, used as the default hide reason and in
 * previews (e.g. `zero-price`, `tool-calling + context ≥ 32768`).
 * @param predicate - the predicate to describe.
 * @returns the summary line.
 */
export function describePredicate(predicate: CatalogPredicate): string {
  const parts: string[] = []
  if (predicate.zeroPrice === true) parts.push('zero-price')
  else if (predicate.zeroPrice === false) parts.push('not zero-price')
  if (predicate.maxPrice !== undefined) parts.push(`price ≤ ${String(predicate.maxPrice)}`)
  if (predicate.tools !== undefined) parts.push(predicate.tools ? 'tool-calling' : 'no tool-calling')
  if (predicate.vision !== undefined) parts.push(predicate.vision ? 'vision' : 'no vision')
  if (predicate.audio !== undefined) parts.push(predicate.audio ? 'audio' : 'no audio')
  if (predicate.video !== undefined) parts.push(predicate.video ? 'video' : 'no video')
  if (predicate.pdf !== undefined) parts.push(predicate.pdf ? 'pdf' : 'no pdf')
  if (predicate.reasoning !== undefined) parts.push(predicate.reasoning ? 'reasoning' : 'no reasoning')
  if (predicate.minContextWindow !== undefined) parts.push(`context ≥ ${String(predicate.minContextWindow)}`)
  if (predicate.provider !== undefined) parts.push(`provider ${predicate.provider}`)
  if (predicate.providerGlob !== undefined) parts.push(`provider ~ ${predicate.providerGlob}`)
  if (predicate.idGlob !== undefined) parts.push(`id ~ ${predicate.idGlob}`)
  if (predicate.nameGlob !== undefined) parts.push(`name ~ ${predicate.nameGlob}`)
  if (predicate.noTraining === true) parts.push('no-training')
  else if (predicate.noTraining === false) parts.push('trains-on-content')
  if (predicate.gated === true) parts.push('gated')
  else if (predicate.gated === false) parts.push('not gated')
  return parts.length > 0 ? parts.join(' + ') : 'empty predicate'
}

/** One visibility hide rule. */
export interface HideRule {
  /** Stable rule id for diffs and announcements. */
  id?: string
  /** Operator-facing label. */
  label?: string
  /** Custom reason shown by the picker; defaults to the predicate summary. */
  reason?: string
  /** Predicate clauses over catalogue entries. */
  when: CatalogPredicate
}

/** Manual overrides; these always beat every rule. */
export interface ModelOverrides {
  /** provider → model ids pinned hidden. */
  hidden?: Record<string, readonly string[]>
  /** provider → model ids pinned visible (overrides hide rules and gating). */
  shown?: Record<string, readonly string[]>
  /** Gated markers: unavailable from this client. */
  gated?: {
    providers?: readonly string[]
    models?: readonly string[]
  }
}

/** The parsed, validated `catalogRules` document. */
export interface ParsedRules {
  /** Document version (default 1); carried for changelog/lifecycle work. */
  version: number
  /** Document privacy overrides (the seed is applied at resolution time). */
  privacy: PrivacyOverrides
  /** Ordered hide rules; the first match decides. */
  hide: readonly HideRule[]
  /** Manual overrides. */
  overrides: {
    hidden: Record<string, readonly string[]>
    shown: Record<string, readonly string[]>
    gatedProviders: ReadonlySet<string>
    gatedModels: ReadonlySet<string>
  }
  /** Structural parse warnings; empty for a clean document. */
  warnings: readonly string[]
}

/**
 * Parse one predicate from untrusted data; unknown keys and bad types are
 * dropped with a warning.
 * @param raw - candidate predicate object.
 * @param context - pointer used in warning lines.
 * @param warnings - warning sink.
 * @returns the validated predicate (possibly empty).
 */
export function parseCatalogPredicate(raw: unknown, context: string, warnings: string[]): CatalogPredicate {
  if (!isRecord(raw)) {
    warnings.push(`${context}: "when" is not an object — rule ignored`)
    return {}
  }
  const predicate: CatalogPredicate = {}
  const booleanKeys = ['zeroPrice', 'tools', 'vision', 'audio', 'video', 'pdf', 'reasoning', 'noTraining', 'gated'] as const
  for (const key of booleanKeys) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value === 'boolean') predicate[key] = value
    else warnings.push(`${context}: predicate "${key}" is not a boolean — ignored`)
  }
  const numberKeys = ['maxPrice', 'minContextWindow'] as const
  for (const key of numberKeys) {
    const value = raw[key]
    if (value === undefined) continue
    const parsed = finiteNumber(value)
    if (parsed !== undefined) predicate[key] = parsed
    else warnings.push(`${context}: predicate "${key}" is not a number — ignored`)
  }
  const stringKeys = ['provider', 'providerGlob', 'idGlob', 'nameGlob'] as const
  for (const key of stringKeys) {
    const value = raw[key]
    if (value === undefined) continue
    const parsed = nonEmptyString(value)
    if (parsed !== undefined) predicate[key] = parsed
    else warnings.push(`${context}: predicate "${key}" is not a non-empty string — ignored`)
  }
  return predicate
}

/** Copy a string-array map, dropping malformed rows with a warning. */
function parseStringMap(raw: unknown, context: string, warnings: string[]): Record<string, readonly string[]> {
  if (raw === undefined) return {}
  if (!isRecord(raw)) {
    warnings.push(`${context} is not a map — ignored`)
    return {}
  }
  const result: Record<string, readonly string[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) {
      warnings.push(`${context}.${key} is not an array — ignored`)
      continue
    }
    result[key] = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  }
  return result
}

/** Copy a string array, or an empty array. */
function parseStringArray(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

/**
 * Parse the `catalogRules` document. Never throws: a malformed document
 * degrades to seeded defaults plus warnings, so one bad edit cannot brick the
 * picker.
 * @param raw - the raw `enpoi-orchestration.catalogRules` value.
 * @returns the parsed document with its warnings.
 */
export function parseRulesDocument(raw: unknown): ParsedRules {
  const warnings: string[] = []
  const source = isRecord(raw) ? raw : {}
  if (raw !== undefined && !isRecord(raw)) warnings.push('catalogRules is not an object — using defaults')

  const hide: HideRule[] = []
  const visibility = source.visibility
  if (visibility !== undefined && !isRecord(visibility)) {
    warnings.push('catalogRules.visibility is not an object — no hide rules')
  } else if (isRecord(visibility)) {
    const rawHide = visibility.hide
    if (rawHide !== undefined && !Array.isArray(rawHide)) {
      warnings.push('catalogRules.visibility.hide is not an array — no hide rules')
    } else if (Array.isArray(rawHide)) {
      rawHide.forEach((candidate, index) => {
        const context = `hide rule #${String(index + 1)}`
        if (!isRecord(candidate)) {
          warnings.push(`${context} is not an object — ignored`)
          return
        }
        if (candidate.when === undefined) {
          warnings.push(`${context} has no "when" — ignored`)
          return
        }
        const when = parseCatalogPredicate(candidate.when, context, warnings)
        if (describePredicate(when) === 'empty predicate') {
          warnings.push(`${context} has no recognized predicate clauses — ignored`)
          return
        }
        hide.push(Object.freeze({
          ...(nonEmptyString(candidate.id) !== undefined ? { id: nonEmptyString(candidate.id)! } : {}),
          ...(nonEmptyString(candidate.label) !== undefined ? { label: nonEmptyString(candidate.label)! } : {}),
          ...(nonEmptyString(candidate.reason) !== undefined ? { reason: nonEmptyString(candidate.reason)! } : {}),
          when: Object.freeze(when),
        }))
      })
    }
  }

  const privacyRaw = isRecord(source.privacy) ? source.privacy as PrivacyOverrides : undefined
  if (source.privacy !== undefined && !isRecord(source.privacy)) warnings.push('catalogRules.privacy is not an object — ignored')

  const overridesRaw = isRecord(source.overrides) ? source.overrides : {}
  const gatedRaw = isRecord(overridesRaw.gated) ? overridesRaw.gated : {}
  const version = finiteNumber(source.version) ?? 1

  return Object.freeze({
    version,
    privacy: privacyRaw ?? {},
    hide: Object.freeze(hide),
    overrides: Object.freeze({
      hidden: Object.freeze(parseStringMap(overridesRaw.hidden, 'overrides.hidden', warnings)),
      shown: Object.freeze(parseStringMap(overridesRaw.shown, 'overrides.shown', warnings)),
      gatedProviders: Object.freeze(new Set(parseStringArray(gatedRaw.providers))),
      gatedModels: Object.freeze(new Set(parseStringArray(gatedRaw.models))),
    }),
    warnings: Object.freeze(warnings),
  })
}

/** Whether one `provider` list contains the model id. */
function listHas(list: Record<string, readonly string[]> | undefined, provider: string, modelId: string): boolean {
  return list?.[provider]?.includes(modelId) === true
}

/**
 * Whether an entry is gated: an explicit `entry.gated` marker, or a manual
 * gated override naming the provider or `provider/model`.
 * @param entry - catalogue entry.
 * @param rules - parsed rules document.
 * @returns whether the entry is gated.
 */
export function isGated(entry: Pick<CatalogEntry, 'provider' | 'id' | 'gated'>, rules: ParsedRules): boolean {
  if (entry.gated === true) return true
  if (rules.overrides.gatedProviders.has(entry.provider)) return true
  return rules.overrides.gatedModels.has(`${entry.provider}/${entry.id}`) || rules.overrides.gatedModels.has(entry.id)
}

/**
 * Merge the picker's existing manual hidden pins (`uiPreferences.hiddenModels`,
 * the map the Models settings page writes) into a parsed rules document as
 * manual hidden overrides. Manual pins always beat rules, and this keeps the
 * two manual sources — uiPreferences and catalogRules.overrides — one concept.
 * @param rules - parsed rules document.
 * @param hiddenModels - raw `uiPreferences.hiddenModels` value, if any.
 * @returns a document whose manual hidden map is the union.
 */
export function withHiddenPins(rules: ParsedRules, hiddenModels: unknown): ParsedRules {
  if (!isRecord(hiddenModels)) return rules
  const merged: Record<string, readonly string[]> = { ...rules.overrides.hidden }
  let changed = false
  for (const [provider, models] of Object.entries(hiddenModels)) {
    if (!Array.isArray(models)) continue
    const current = new Set(merged[provider] ?? [])
    for (const model of models) {
      if (typeof model === 'string' && model.trim() !== '') current.add(model)
    }
    const next = [...current]
    if (next.length !== (merged[provider]?.length ?? 0)) {
      merged[provider] = Object.freeze(next)
      changed = true
    }
  }
  if (!changed) return rules
  return Object.freeze({
    ...rules,
    overrides: Object.freeze({ ...rules.overrides, hidden: Object.freeze(merged) }),
  })
}

/** The rule text used in reasons: explicit reason, label, id, else the predicate summary. */
function ruleText(rule: HideRule): string {
  return rule.reason ?? rule.label ?? rule.id ?? describePredicate(rule.when)
}

/** One picker-facing visibility decision for a catalogue entry. */
export interface VisibilityDecision {
  /** Provider route id. */
  provider: string
  /** Model id. */
  model: string
  /** Whether the picker shows it. */
  state: 'visible' | 'hidden'
  /** Why: default, manual pin, hide rule, or gating. */
  source: 'default' | 'manual' | 'rule' | 'gated'
  /** Picker string, or null when visible by default. */
  reason: string | null
  /** The rule text that hid it (`source === 'rule'`). */
  rule?: string
  /** The rule text a manual pin overrode, when applicable. */
  overriddenRule?: string
}

/**
 * Decide one entry's visibility.
 * @param entry - catalogue entry (gated may already be merged in).
 * @param rules - parsed rules document.
 * @param privacy - pre-resolved privacy verdict for the entry.
 * @returns the decision.
 */
export function decideVisibility(entry: CatalogEntry, rules: ParsedRules, privacy: PrivacyVerdict): VisibilityDecision {
  const manualHidden = listHas(rules.overrides.hidden, entry.provider, entry.id)
  const manualShown = listHas(rules.overrides.shown, entry.provider, entry.id)
  const gated = isGated(entry, rules)
  const hit = rules.hide.find(rule => evaluatePredicate(entry, rule.when, privacy).matched)

  if (manualHidden) {
    return {
      provider: entry.provider, model: entry.id, state: 'hidden', source: 'manual',
      reason: 'hidden manually',
      ...(hit !== undefined ? { overriddenRule: ruleText(hit) } : {}),
    }
  }
  if (manualShown) {
    if (hit !== undefined) {
      return {
        provider: entry.provider, model: entry.id, state: 'visible', source: 'manual',
        reason: `pinned visible (rule: ${ruleText(hit)})`, overriddenRule: ruleText(hit),
      }
    }
    if (gated) {
      return { provider: entry.provider, model: entry.id, state: 'visible', source: 'manual', reason: 'pinned visible (gated)' }
    }
    return { provider: entry.provider, model: entry.id, state: 'visible', source: 'manual', reason: 'pinned visible' }
  }
  if (gated) {
    return {
      provider: entry.provider, model: entry.id, state: 'hidden', source: 'gated',
      reason: entry.gateReason ?? 'gated',
    }
  }
  if (hit !== undefined) {
    return { provider: entry.provider, model: entry.id, state: 'hidden', source: 'rule', reason: `hidden by rule: ${ruleText(hit)}`, rule: ruleText(hit) }
  }
  return { provider: entry.provider, model: entry.id, state: 'visible', source: 'default', reason: null }
}

/** The picker rendering helper: the hidden-reason string, or null when visible. */
export function formatHiddenReason(decision: VisibilityDecision): string | null {
  return decision.state === 'hidden' ? decision.reason : null
}

/** One published picker decision: the engine's answer for one `provider/model`. */
export interface ResolvedVisibilityEntry {
  /** Whether the picker shows it. */
  state: 'visible' | 'hidden'
  /** Picker string, or null when visible by default. */
  reason: string | null
  /** Why: default, manual pin, hide rule, or gating. */
  source: VisibilityDecision['source']
  /** The rule text that hid it (`source === 'rule'`). */
  rule?: string
  /** The rule text a manual pin overrode, when applicable. */
  overriddenRule?: string
}

/**
 * Project the engine's decisions into the compact map the picker reads from
 * `enpoi-orchestration.catalogRules.resolved`. Entries visible by default are
 * omitted — absence means default-visible — so the map carries exactly the
 * state a client cannot derive: hidden entries (with their reason) and manual
 * pins (with the rule or gate they override).
 * @param decisions - the report's per-entry decisions.
 * @returns the serializable map, `provider/model` keyed, sorted for stability.
 */
export function buildResolvedVisibility(
  decisions: readonly VisibilityDecision[],
): Record<string, ResolvedVisibilityEntry> {
  const resolved: Record<string, ResolvedVisibilityEntry> = {}
  for (const decision of [...decisions].sort((left, right) =>
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`))) {
    if (decision.state === 'visible' && decision.source !== 'manual') continue
    resolved[`${decision.provider}/${decision.model}`] = {
      state: decision.state,
      reason: decision.reason,
      source: decision.source,
      ...(decision.rule !== undefined ? { rule: decision.rule } : {}),
      ...(decision.overriddenRule !== undefined ? { overriddenRule: decision.overriddenRule } : {}),
    }
  }
  return resolved
}

/** Full visibility report over a catalogue snapshot. */
export interface VisibilityReport {
  decisions: readonly VisibilityDecision[]
  /** Discipline warnings: rules and pins that matched nothing. */
  warnings: readonly string[]
}

/**
 * Evaluate visibility for every entry, with the discipline warnings that keep
 * a stale rule from silently emptying the picker.
 * @param entries - catalogue snapshot (gated markers may already be merged).
 * @param rules - parsed rules document.
 * @returns decisions plus warnings.
 */
export function evaluateVisibility(entries: readonly CatalogEntry[], rules: ParsedRules): VisibilityReport {
  const decisions: VisibilityDecision[] = []
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, rules.privacy)
    decisions.push(decideVisibility(entry, rules, verdict))
  }
  const warnings: string[] = []
  rules.hide.forEach((rule, index) => {
    const matches = entries.filter(entry => evaluatePredicate(entry, rule.when, resolvePrivacy(entry.provider, entry.id, rules.privacy)).matched)
    if (matches.length === 0) {
      const name = rule.label ?? rule.id ?? `#${String(index + 1)}`
      warnings.push(`hide rule "${name}" (${describePredicate(rule.when)}) matched no catalogue entries — nothing is hidden by it`)
    }
  })
  for (const [provider, models] of Object.entries(rules.overrides.hidden)) {
    for (const model of models) {
      if (!entries.some(entry => entry.provider === provider && entry.id === model)) {
        warnings.push(`manual hidden pin "${provider}/${model}" matches no catalogue entry`)
      }
    }
  }
  for (const [provider, models] of Object.entries(rules.overrides.shown)) {
    for (const model of models) {
      if (!entries.some(entry => entry.provider === provider && entry.id === model)) {
        warnings.push(`manual visible pin "${provider}/${model}" matches no catalogue entry`)
      }
    }
  }
  return { decisions: Object.freeze(decisions), warnings: Object.freeze(warnings) }
}

/** Before/after effect of a proposed rules edit on the current catalogue. */
export interface RulesDiff {
  /** `provider/model` keys the edit would newly hide. */
  hiddenAdded: readonly string[]
  /** `provider/model` keys the edit would unhide. */
  hiddenRemoved: readonly string[]
  /** `provider/model` keys the edit would newly gate. */
  gatedAdded: readonly string[]
  /** `provider/model` keys the edit would ungate. */
  gatedRemoved: readonly string[]
  /** Discipline warnings of the proposed document (empty rules, stale pins). */
  warnings: readonly string[]
}

/** Hidden/gated key sets for one document over one catalogue snapshot. */
function visibilityKeys(entries: readonly CatalogEntry[], rules: ParsedRules): { hidden: Set<string>; gated: Set<string> } {
  const hidden = new Set<string>()
  const gated = new Set<string>()
  for (const entry of entries) {
    const verdict = resolvePrivacy(entry.provider, entry.id, rules.privacy)
    const decision = decideVisibility(entry, rules, verdict)
    if (decision.state === 'hidden') hidden.add(`${entry.provider}/${entry.id}`)
    if (isGated(entry, rules) && !listHas(rules.overrides.shown, entry.provider, entry.id)) gated.add(`${entry.provider}/${entry.id}`)
  }
  return { hidden, gated }
}

/**
 * Diff a proposed rules document against the current one over the live
 * catalogue, so an edit's effect is visible before it is applied.
 * @param before - parsed current document.
 * @param after - parsed proposed document.
 * @param entries - live catalogue snapshot.
 * @returns the added/removed keys and the proposed document's warnings.
 */
export function diffRules(before: ParsedRules, after: ParsedRules, entries: readonly CatalogEntry[]): RulesDiff {
  const from = visibilityKeys(entries, before)
  const to = visibilityKeys(entries, after)
  const added = (next: Set<string>, previous: Set<string>): string[] => [...next].filter(key => !previous.has(key)).sort()
  const removed = (next: Set<string>, previous: Set<string>): string[] => [...previous].filter(key => !next.has(key)).sort()
  return {
    hiddenAdded: Object.freeze(added(to.hidden, from.hidden)),
    hiddenRemoved: Object.freeze(removed(to.hidden, from.hidden)),
    gatedAdded: Object.freeze(added(to.gated, from.gated)),
    gatedRemoved: Object.freeze(removed(to.gated, from.gated)),
    warnings: Object.freeze([...after.warnings, ...evaluateVisibility(entries, after).warnings]),
  }
}
