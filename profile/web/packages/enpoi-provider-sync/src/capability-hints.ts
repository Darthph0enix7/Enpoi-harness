/**
 * The shared model-capability id-heuristic table.
 *
 * One deployment-owned data file — `model-capability-hints.json`, sibling of
 * this module — is the single source for every "the id suggests a capability"
 * operand. Both consumers load it: this profile plugin at runtime (Node) and
 * the Models page's provider detail panel through the generated browser
 * mirror
 * (`packages/client/ui-settings-models/src/client/model-capability-hints.generated.ts`),
 * written by `scripts/write-client-mirror.mjs`. The browser bundle cannot
 * import this package's tree, so the mirror is generated, committed, and
 * pinned by parity specs on both sides; no table is hand-maintained twice.
 *
 * These operands are HINTS, never disclosures. The sync persists a hinted
 * capability only in the clearly-labeled `capabilityHints` field, keeps the
 * schema floor (`input: ['text']`, `reasoning: false`), and marks the record
 * `unverified`; the panel renders hinted badges differently from disclosed
 * ones.
 *
 * A deployment owner may override the shipped operands per route and pin
 * hints per model through `$DSH_HOME/model-capability-hints.json`; the
 * override wins over the shipped lists.
 *
 * @module dsh-enpoi-provider-sync/capability-hints
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** One operand family of the shared table. */
export type HintFamily = 'reasoning' | 'image' | 'audio' | 'video' | 'files' | 'toolsExclude'

/** The shipped id-heuristic operand table. Every list holds lowercase id substrings. */
export interface CapabilityHints {
  reasoning: string[]
  image: string[]
  audio: string[]
  video: string[]
  files: string[]
  toolsExclude: string[]
}

/** The operand families, in table order. */
export const HINT_FAMILIES: readonly HintFamily[] = ['reasoning', 'image', 'audio', 'video', 'files', 'toolsExclude']

/**
 * The families an owner override may replace. `toolsExclude` is panel-only —
 * a claim the sync cannot propagate into `capabilityHints` — so naming it in
 * an override fails loud instead of silently doing nothing.
 */
export const OVERRIDABLE_HINT_FAMILIES: readonly HintFamily[] = ['reasoning', 'image', 'audio', 'video', 'files']

/** A modality a hint may add on top of the text floor. */
export type HintedModality = 'image' | 'audio' | 'video' | 'pdf'

/**
 * One model's explicit hint pin in an owner override. A pin is still a hint:
 * the sync persists it under `capabilityHints`, never as a disclosed fact.
 */
export interface ModelHintPin {
  /** Modality tokens the pin claims; unknown tokens are refused at load. */
  input?: string[]
  /** Whether the pin claims reasoning. */
  reasoning?: boolean
}

/** One route's owner-override entry. */
export interface RouteHintOverride {
  /** Operand families replacing the shipped list of the same name for this route. */
  hints?: Partial<Record<HintFamily, string[]>>
  /** Explicit per-model pins keyed by the exact model id. */
  models?: Record<string, ModelHintPin>
}

/** The owner-override document shape (`$DSH_HOME/model-capability-hints.json`). */
export interface CapabilityHintsOverrideDocument {
  version?: number
  routes?: Record<string, RouteHintOverride>
}

/** One model's hinted capabilities and the table that produced them. */
export interface CapabilityHintClaim {
  /** Modalities beyond the text floor the hints claim. */
  input: HintedModality[]
  /** Whether the hints claim reasoning. */
  reasoning: boolean
  /** The shipped table, or an owner route/model override that won. */
  source: 'shipped-hints' | 'owner-override'
}

/**
 * The shipped table path, overridable for tests.
 * @returns the shipped JSON path.
 */
export function capabilityHintsPath(): string {
  const override = process.env.DSH_CAPABILITY_HINTS
  if (override !== undefined && override.length > 0) return override
  return fileURLToPath(new URL('../model-capability-hints.json', import.meta.url))
}

/** A non-empty string, or `undefined`. */
function hintString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Deduplicated non-empty strings, preserving authored order. */
function hintList(raw: unknown, path: string, field: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`capability hints ${path}: "${field}" must be a list of id substrings`)
  const list: string[] = []
  for (const value of raw) {
    const operand = hintString(value)
    if (operand === undefined) throw new Error(`capability hints ${path}: "${field}" has an entry that is not an id substring`)
    if (!list.includes(operand)) list.push(operand)
  }
  return list
}

/**
 * Validate one parsed shipped-table document. Known families are required and
 * every operand must be a non-empty string; unknown keys are ignored.
 * @param raw - the parsed JSON value.
 * @param path - the file the value came from, for error messages.
 * @returns the validated table.
 */
export function parseCapabilityHints(raw: unknown, path: string): CapabilityHints {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`capability hints ${path}: document must be an object`)
  }
  const document = raw as Record<string, unknown>
  return {
    reasoning: hintList(document.reasoning, path, 'reasoning'),
    image: hintList(document.image, path, 'image'),
    audio: hintList(document.audio, path, 'audio'),
    video: hintList(document.video, path, 'video'),
    files: hintList(document.files, path, 'files'),
    toolsExclude: hintList(document.toolsExclude, path, 'toolsExclude'),
  }
}

/**
 * Load the shipped table from disk. Fails loudly so a packaging mistake is
 * visible instead of silently disabling hints.
 * @param path - table path; defaults to the bundled sibling JSON.
 * @returns the validated table.
 */
export function loadCapabilityHints(path: string = capabilityHintsPath()): CapabilityHints {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`capability hints ${path}: unreadable — ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseCapabilityHints(raw, path)
}

/**
 * Validate one parsed owner-override document. A malformed shape is refused
 * at load, naming the file; an absent file is handled by the caller as "no
 * override".
 * @param raw - the parsed JSON value.
 * @param path - the file the value came from, for error messages.
 * @returns the validated override document.
 */
export function parseCapabilityHintsOverride(raw: unknown, path: string): CapabilityHintsOverrideDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`capability-hints override ${path}: document must be an object`)
  }
  const document = raw as Record<string, unknown>
  const rawRoutes = document.routes
  if (rawRoutes === undefined) return {}
  if (rawRoutes === null || typeof rawRoutes !== 'object' || Array.isArray(rawRoutes)) {
    throw new Error(`capability-hints override ${path}: "routes" must be an object keyed by route id`)
  }
  const routes: Record<string, RouteHintOverride> = {}
  for (const [route, value] of Object.entries(rawRoutes as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`capability-hints override ${path}: route "${route}" must be an object`)
    }
    const entry = value as Record<string, unknown>
    const override: RouteHintOverride = {}
    if (entry.hints !== undefined) {
      if (entry.hints === null || typeof entry.hints !== 'object' || Array.isArray(entry.hints)) {
        throw new Error(`capability-hints override ${path}: route "${route}" has a "hints" that is not an object`)
      }
      const hints: Partial<Record<HintFamily, string[]>> = {}
      for (const [family, list] of Object.entries(entry.hints as Record<string, unknown>)) {
        if (!OVERRIDABLE_HINT_FAMILIES.includes(family as HintFamily)) {
          throw new Error(`capability-hints override ${path}: route "${route}" names unknown or non-overridable hint family "${family}"`)
        }
        hints[family as HintFamily] = hintList(list, path, `routes.${route}.hints.${family}`)
      }
      override.hints = hints
    }
    if (entry.models !== undefined) {
      if (entry.models === null || typeof entry.models !== 'object' || Array.isArray(entry.models)) {
        throw new Error(`capability-hints override ${path}: route "${route}" has a "models" that is not an object`)
      }
      const models: Record<string, ModelHintPin> = {}
      for (const [id, pin] of Object.entries(entry.models as Record<string, unknown>)) {
        if (hintString(id) === undefined) {
          throw new Error(`capability-hints override ${path}: route "${route}" has an empty model id`)
        }
        if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) {
          throw new Error(`capability-hints override ${path}: route "${route}" model "${id}" must be an object`)
        }
        const fields = pin as Record<string, unknown>
        const parsed: ModelHintPin = {}
        if (fields.input !== undefined) {
          if (!Array.isArray(fields.input)) {
            throw new Error(`capability-hints override ${path}: route "${route}" model "${id}" has an "input" that is not a list`)
          }
          const input: string[] = []
          for (const value of fields.input) {
            const token = hintString(value)
            if (token === undefined || (token !== 'text' && token !== 'image' && token !== 'audio' && token !== 'video' && token !== 'pdf')) {
              throw new Error(`capability-hints override ${path}: route "${route}" model "${id}" names unknown input modality "${String(value)}"`)
            }
            if (!input.includes(token)) input.push(token)
          }
          parsed.input = input
        }
        if (fields.reasoning !== undefined) {
          if (typeof fields.reasoning !== 'boolean') {
            throw new Error(`capability-hints override ${path}: route "${route}" model "${id}" has a non-boolean "reasoning"`)
          }
          parsed.reasoning = fields.reasoning
        }
        models[id] = parsed
      }
      override.models = models
    }
    routes[route] = override
  }
  return { routes }
}

/**
 * Whether one lowercased model id carries any of the operands.
 * @param lowerId - the lowercased model id.
 * @param operands - lowercase id substrings.
 * @returns true when at least one operand occurs in the id.
 */
export function matchesAnyOperand(lowerId: string, operands: readonly string[]): boolean {
  return operands.some(operand => operand.length > 0 && lowerId.includes(operand))
}

/** The operand lists one route sees: the owner's replacement families win over the shipped table. */
function routeFamilies(hints: CapabilityHints, route: string, override: CapabilityHintsOverrideDocument | undefined): CapabilityHints {
  const replacements = override?.routes?.[route]?.hints
  if (replacements === undefined) return hints
  const families: CapabilityHints = { ...hints }
  for (const family of HINT_FAMILIES) {
    const replacement = replacements[family]
    if (replacement !== undefined) families[family] = replacement
  }
  return families
}

/** The modality tokens one pin claims, the text floor stripped. */
function pinModalities(input: readonly string[] | undefined): HintedModality[] {
  const modalities: HintedModality[] = []
  for (const token of input ?? []) {
    if (token === 'image' || token === 'audio' || token === 'video' || token === 'pdf') {
      if (!modalities.includes(token)) modalities.push(token)
    }
  }
  return modalities
}

/**
 * The hints one model's id carries on one route. A per-model owner pin wins
 * outright; else the owner's route replacement families (when any) apply over
 * the shipped lists. A route the owner override names still returns an empty
 * claim when nothing matches, so the caller persists the labeled field and
 * the panel knows the owner evaluated the route rather than silently falling
 * back to the shipped table.
 * @param route - the provider route key.
 * @param id - the model id (exact spelling for pin lookup).
 * @param hints - the shipped table.
 * @param override - the owner override document, when one loaded.
 * @returns the claim, or `undefined` when the shipped table suggests nothing and no override applies.
 */
export function claimCapabilityHints(
  route: string,
  id: string,
  hints: CapabilityHints,
  override?: CapabilityHintsOverrideDocument,
): CapabilityHintClaim | undefined {
  const routeOverride = override?.routes?.[route]
  const pin = routeOverride?.models?.[id]
  if (pin !== undefined) {
    return { input: pinModalities(pin.input), reasoning: pin.reasoning === true, source: 'owner-override' }
  }
  const families = routeFamilies(hints, route, override)
  const lowerId = id.toLowerCase()
  const input: HintedModality[] = []
  if (matchesAnyOperand(lowerId, families.image)) input.push('image')
  if (matchesAnyOperand(lowerId, families.audio)) input.push('audio')
  if (matchesAnyOperand(lowerId, families.video)) input.push('video')
  if (matchesAnyOperand(lowerId, families.files)) input.push('pdf')
  const reasoning = matchesAnyOperand(lowerId, families.reasoning)
  if (input.length > 0 || reasoning) {
    return { input, reasoning, source: routeOverride?.hints === undefined ? 'shipped-hints' : 'owner-override' }
  }
  if (routeOverride !== undefined) return { input: [], reasoning: false, source: 'owner-override' }
  return undefined
}
