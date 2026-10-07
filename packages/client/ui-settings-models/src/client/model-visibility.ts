/**
 * Effective picker visibility for the Models card's eye toggle.
 *
 * The composer picker hides a model when the operator hid it by hand
 * (`enpoi-orchestration.uiPreferences.hiddenModels`) or when the host catalogue
 * rules resolve it hidden — which includes the route rows' own `gated` marker,
 * stamped by `enpoi-provider-sync` when the endpoint listing reported
 * `isFree: false`. The eye must state what the picker does, so it derives from
 * the same two sources and never from a model-name list, a provider allowlist,
 * or any other hardcoded model set.
 *
 * The rule decisions are read from the mirror `ui-model-selection` keeps under
 * {@link CATALOG_DECISIONS_MIRROR_KEY} — the module documents that mirror for
 * surfaces that must resolve a decision synchronously without fetching
 * settings themselves.
 *
 * @module ui-settings-models/model-visibility
 */

/** The subset of a route's model row the visibility derivation reads. */
export interface ModelVisibilityRow {
  /** Model id, unique within the route. */
  readonly id: string
  /** Provider sync marked this model sign-in/paid-only (`isFree: false`). */
  readonly gated?: boolean | undefined
  /** The listing's own free marker, when the row still carries discovery fields. */
  readonly isFree?: boolean | undefined
  /** The picker-facing reason a gated model is unavailable, when disclosed. */
  readonly gateReason?: string | undefined
}

/** One model's picker visibility as the eye renders it. */
export interface ModelVisibility {
  /** Hidden from the picker: the eye renders off. */
  readonly hidden: boolean
  /** Why the picker hides it when no manual local pin did; null when visible or manually hidden. */
  readonly reason: string | null
  /**
   * True when the hide comes from provider data or a rule, so this surface
   * cannot toggle it: only a manual local pin can be switched here.
   */
  readonly locked: boolean
}

/** `localStorage` key of the picker's published decision mirror (`ui-model-selection`). */
export const CATALOG_DECISIONS_MIRROR_KEY = 'dsh_catalog_visibility_v1'

/** Window event the picker dispatches when the decision mirror moves. */
export const CATALOG_DECISIONS_CHANGED_EVENT = 'dsh:catalog-visibility-changed'

/** One published picker decision, reduced to the fields the eye reads. */
export interface CatalogDecision {
  /** Whether the picker hides the entry. */
  readonly state: 'visible' | 'hidden'
  /** Picker string for a hidden entry; null when the engine named none. */
  readonly reason: string | null
}

/**
 * Whether the row's own disclosed data marks it non-free. `gated` is the
 * provider-sync stamp for a listing's `isFree: false`; `isFree` is accepted so
 * a row carrying only the raw discovery marker derives the same verdict. An
 * absent marker is undisclosed, never a claim of paid or free.
 * @param row - the route model row.
 * @returns whether the model is sign-in/paid-only by its own data.
 */
export function isModelRowGated(row: ModelVisibilityRow): boolean {
  return row.gated === true || row.isFree === false
}

/**
 * Parse the picker's decision mirror, dropping malformed rows. Only decisions
 * that differ from default-visible are published, so an absent key is visible.
 * @param raw - parsed JSON document from the mirror, or anything else.
 * @returns `provider/model` → the reduced decision.
 */
export function parseCatalogDecisions(raw: unknown): Map<string, CatalogDecision> {
  const decisions = new Map<string, CatalogDecision>()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return decisions
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as { state?: unknown; reason?: unknown }
    if (entry.state !== 'visible' && entry.state !== 'hidden') continue
    const reason = typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : null
    decisions.set(key, { state: entry.state, reason })
  }
  return decisions
}

/**
 * Read the picker's decision mirror. Storage being disabled (private mode,
 * quota) reads as no decisions — the same answer as a host that published none.
 * @returns `provider/model` → the reduced decision.
 */
export function readCatalogDecisions(): Map<string, CatalogDecision> {
  try {
    return parseCatalogDecisions(JSON.parse(localStorage.getItem(CATALOG_DECISIONS_MIRROR_KEY) ?? 'null'))
  } catch {
    // Storage disabled or the mirror is malformed: the eye falls back to the
    // route row's own data, exactly as the picker falls back to its manual map.
    return new Map()
  }
}

/**
 * Decide one model's picker visibility. A published manual-shown pin beats
 * provider data and rules, exactly as the rules engine orders them; a
 * published hidden decision and a non-free row are both off and locked,
 * because only a manual local pin is switchable from this surface. An absent
 * decision is default-visible.
 * @param row - the route model row.
 * @param manualHidden - the route's locally hidden model ids.
 * @param decision - the published decision for `${provider}/${row.id}`, when any.
 * @returns how the eye renders and whether it can be toggled.
 */
export function modelVisibility(
  row: ModelVisibilityRow,
  manualHidden: ReadonlySet<string>,
  decision: CatalogDecision | undefined,
): ModelVisibility {
  const manual = manualHidden.has(row.id)
  if (decision?.state === 'visible') {
    // A manual-shown pin keeps the model in the picker whatever its marker.
    return manual
      ? { hidden: true, reason: null, locked: false }
      : { hidden: false, reason: null, locked: false }
  }
  if (decision?.state === 'hidden') return { hidden: true, reason: decision.reason, locked: true }
  if (isModelRowGated(row)) return { hidden: true, reason: row.gateReason ?? null, locked: true }
  if (manual) return { hidden: true, reason: null, locked: false }
  return { hidden: false, reason: null, locked: false }
}
