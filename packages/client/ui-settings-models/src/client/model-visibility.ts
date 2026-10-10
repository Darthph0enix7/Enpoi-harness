/**
 * Effective picker visibility for the Models card's eye toggle.
 *
 * The composer picker hides a model when the operator hid it by hand
 * (`enpoi-orchestration.uiPreferences.hiddenModels`), when the host catalogue
 * rules resolve it hidden — which includes the route rows' own `gated` marker,
 * stamped by `enpoi-provider-sync` when the endpoint listing reported
 * `isFree: false` — and shows it again when the operator pinned it shown
 * (`uiPreferences.shownModels`). The eye must state what the picker does and
 * must always let the operator override it, so it derives from those sources
 * and never from a model-name list, a provider allowlist, or any other
 * hardcoded model set.
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
  /**
   * Why the picker hides it when no manual hidden pin did; null when visible
   * or manually hidden. The eye keeps it for the tooltip, and the operator can
   * still click through to pin the model shown.
   */
  readonly reason: string | null
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
 * Decide one model's picker visibility, in the same precedence the rules
 * engine applies: a manual hidden pin beats a manual shown pin, the shown pin
 * beats everything else, then the published decision map (rules and gating),
 * then the row's own gate marker, else default-visible. The operator may
 * always toggle any row from the settings surface — a hide coming from a rule
 * or gate is overridden by pinning the model shown, which is why no verdict
 * here is locked.
 * @param row - the route model row.
 * @param manualHidden - the route's locally hidden model ids.
 * @param decision - the published decision for `${provider}/${row.id}`, when any.
 * @param manualShown - the route's locally shown (explicitly pinned) model ids.
 * @returns how the eye renders.
 */
export function modelVisibility(
  row: ModelVisibilityRow,
  manualHidden: ReadonlySet<string>,
  decision?: CatalogDecision | undefined,
  manualShown: ReadonlySet<string> = new Set(),
): ModelVisibility {
  if (manualHidden.has(row.id)) return { hidden: true, reason: null }
  if (manualShown.has(row.id)) return { hidden: false, reason: null }
  if (decision?.state === 'visible') return { hidden: false, reason: null }
  if (decision?.state === 'hidden') return { hidden: true, reason: decision.reason }
  if (isModelRowGated(row)) return { hidden: true, reason: row.gateReason ?? null }
  return { hidden: false, reason: null }
}
