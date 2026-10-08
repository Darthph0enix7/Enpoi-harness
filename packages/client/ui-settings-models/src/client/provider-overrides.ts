/**
 * Operator overrides for the Add-Provider preset catalog.
 *
 * The catalog itself is generated data (`provider-presets.ts`), so a shipped
 * provider could only be hidden, made keyless, or made popular by editing
 * generated code. This module reads the override map from the open
 * `enpoi-orchestration.uiPreferences.providerCatalog` settings document the
 * Models page already mirrors, which keeps the module React-free and usable
 * from the data layer.
 *
 * @module ui-settings-models/provider-overrides
 */

/**
 * One provider's operator override. Every field is optional: an absent field
 * keeps the shipped verdict from the generated row.
 */
export interface ProviderPresetOverride {
  /**
   * Keep the preset out of the Add-Provider picker and out of the unconfigured
   * provider listing. A configured route (or a live registered one) is never
   * dropped from the Models page by this flag.
   */
  hidden?: boolean
  /** Replace the generated keyless verdict for this provider. */
  keyless?: boolean
  /** Include in (true) or exclude from (false) the picker's Popular group. */
  popular?: boolean
}

/** Operator overrides keyed by provider id. */
export type ProviderPresetOverrides = Readonly<Record<string, ProviderPresetOverride>>

/** Whether `value` is a plain JSON object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one boolean override field, ignoring non-boolean values. */
function booleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  return typeof record[field] === 'boolean' ? record[field] : undefined
}

/**
 * Parse the provider-catalog override map out of a settings namespace
 * document: the `enpoi-orchestration` namespace's
 * `uiPreferences.providerCatalog` record, keyed by provider id. Malformed
 * entries and non-boolean fields are dropped rather than coerced, so a typo in
 * the settings file cannot silently hide a provider.
 * @param document - the namespace document, as read from the settings mirror.
 * @returns the overrides; empty when the document carries none.
 */
export function parseProviderPresetOverrides(document: unknown): ProviderPresetOverrides {
  if (!isRecord(document)) return {}
  const uiPreferences = document['uiPreferences']
  if (!isRecord(uiPreferences)) return {}
  const catalog = uiPreferences['providerCatalog']
  if (!isRecord(catalog)) return {}
  const overrides: Record<string, ProviderPresetOverride> = {}
  for (const [id, raw] of Object.entries(catalog)) {
    if (!isRecord(raw)) continue
    const hidden = booleanField(raw, 'hidden')
    const keyless = booleanField(raw, 'keyless')
    const popular = booleanField(raw, 'popular')
    if (hidden === undefined && keyless === undefined && popular === undefined) continue
    overrides[id] = {
      ...hidden === undefined ? {} : { hidden },
      ...keyless === undefined ? {} : { keyless },
      ...popular === undefined ? {} : { popular },
    }
  }
  return overrides
}
