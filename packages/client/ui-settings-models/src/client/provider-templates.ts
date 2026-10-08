/**
 * Provider catalog for the Add Provider workflow.
 *
 * Generated from the models.dev mirror (~/.cache/opencode/models.json) by
 * packages/client/ui-settings-models/scripts/gen-provider-presets.mjs, each
 * preset carrying the provider's canonical settings (env vars, wire protocol,
 * base URL, docs) plus its shipped `keyless`/`popular` verdict.
 * Regenerate with: node packages/client/ui-settings-models/scripts/gen-provider-presets.mjs
 */

import presets from './provider-presets.ts'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS, heavyDashboardUrls, type HeavyProviderManifest } from './heavy-providers.ts'
import { heavyManifestState, resolveHeavyManifest } from './heavy-manifest-source.ts'
import type { ProviderPresetOverrides } from './provider-overrides.ts'

export interface ProviderTemplate {
  id: string
  name: string
  /** Env vars the provider needs (first = API key ref). */
  env: string[]
  /** DSH wire protocol: openai-completions | openai-responses | anthropic-messages. */
  protocol: string
  /** Base URL; may contain {env:VAR} placeholders substituted at runtime. */
  baseURL: string
  /** Docs URL for the provider. */
  doc?: string
  /**
   * Console/dashboard URL when the provider serves one; omitted when no
   * dashboard is known (the heavy manifests carry their own).
   */
  dashboard?: string
  /**
   * The provider serves requests without any credential (anonymous free
   * tier); its env ref stays optional and a supplied key switches to BYOK.
   * Carried by the generated row or the heavy manifest, replaceable by an
   * operator override.
   */
  keyless?: boolean
  /**
   * One-based position in the shipped Popular group; absent when the provider
   * is not popular. The picker orders that group by this rank, so the shipped
   * order lives in the generated data rather than in a runtime list.
   */
  popular?: number
  /**
   * HEAVY provider: listed, but nothing is installed until the operator adds
   * one. The manifest drives the mode choice, install job, health probe, and
   * removal confirmation; until then the preset has no route and is excluded
   * from the provider-sync endpoint set.
   */
  heavy?: HeavyProviderManifest
}

/** Rank an override-added popular provider receives: after every ranked row. */
const POPULAR_OVERRIDE_RANK = Number.MAX_SAFE_INTEGER

/**
 * Apply the operator overrides to one template listing: a hidden preset is
 * absent, a keyless verdict is replaced, and a popular verdict is forced in
 * (appended after the ranked rows) or out. An override with no fields for this
 * id returns the template unchanged.
 * @param templates - the listing to filter, in listing order.
 * @param overrides - parsed overrides keyed by provider id.
 * @returns the visible templates in listing order; inputs are never mutated.
 */
export function applyProviderPresetOverrides(
  templates: readonly ProviderTemplate[],
  overrides: ProviderPresetOverrides,
): ProviderTemplate[] {
  const visible: ProviderTemplate[] = []
  for (const template of templates) {
    const override = overrides[template.id]
    if (override?.hidden === true) continue
    if (override?.keyless === undefined && override?.popular === undefined) {
      visible.push(template)
      continue
    }
    const keyless = override.keyless ?? template.keyless
    const popular = override.popular === undefined
      ? template.popular
      : override.popular ? template.popular ?? POPULAR_OVERRIDE_RANK : undefined
    // `popular` is destructured out so a `popular: false` override can remove
    // the shipped rank; spreading the template alone would keep it.
    const { popular: _shippedPopular, ...rest } = template
    visible.push({
      ...rest,
      ...keyless === undefined ? {} : { keyless },
      ...popular === undefined ? {} : { popular },
    })
  }
  return visible
}

/**
 * One heavy manifest as an Add Provider template. Render code builds the
 * heavy group from the current manifest table through this, so a host reply
 * replaces every heavy row without a page copy to keep in step.
 * @param manifest - heavy manifest (host truth or the pre-connection fallback).
 * @returns the listing template for that provider.
 */
export function heavyTemplate(manifest: HeavyProviderManifest): ProviderTemplate {
  return {
    id: manifest.id,
    name: manifest.label,
    env: manifest.auth.apiKeyEnv === undefined ? [] : [manifest.auth.apiKeyEnv],
    protocol: manifest.protocol,
    baseURL: manifest.reuse.baseURL,
    ...manifest.docsUrl === undefined ? {} : { doc: manifest.docsUrl },
    ...manifest.auth.keyless ? { keyless: true } : {},
    heavy: manifest,
  }
}

/** The generated mainstream presets, verbatim from the data module. */
const MAINSTREAM_TEMPLATES: ProviderTemplate[] = presets as unknown as ProviderTemplate[]

/**
 * The pre-connection listing: mainstream presets plus the labelled fallback
 * heavy table. Live render code uses {@link liveProviderTemplates}; pickers
 * that honor operator overrides go through {@link applyProviderPresetOverrides}.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] =
  MAINSTREAM_TEMPLATES.concat(FALLBACK_HEAVY_PROVIDER_MANIFESTS.map(heavyTemplate))

/**
 * The listing to render now: mainstream presets plus the current heavy table
 * (the host's manifests once connected, the fallback before). This is the
 * shipped catalog unchanged; hidden presets are filtered where a picker
 * applies the parsed operator overrides.
 * @returns the templates in listing order.
 */
export function liveProviderTemplates(): ProviderTemplate[] {
  return MAINSTREAM_TEMPLATES.concat(heavyManifestState().manifests.map(heavyTemplate))
}

/**
 * Shipped popular ordering, derived from the generated rows' `popular` rank.
 * An operator override changes what a picker renders, never this shipped set.
 */
export const POPULAR_PROVIDERS: readonly string[] = PROVIDER_TEMPLATES
  .filter(template => template.popular !== undefined)
  .toSorted((left, right) => (left.popular ?? 0) - (right.popular ?? 0))
  .map(template => template.id)

/**
 * Shipped providers that need no API key, derived from the generated rows'
 * `keyless` verdict (plus any heavy manifest that declares its route keyless).
 * An operator override changes what the Add-Provider form does, never this
 * shipped set.
 */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(
  PROVIDER_TEMPLATES.filter(template => template.keyless === true).map(template => template.id),
)

/**
 * Resolve a preset by id, regardless of an operator `hidden` override: a
 * configured route's metadata (dashboard, docs, env ref) must keep resolving
 * after its preset left the picker.
 */
export function providerPreset(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find(p => p.id === id)
}

/**
 * Dashboard URLs known for one provider: the heavy manifest's server/local
 * dashboards when the id is heavy, otherwise the template's own `dashboard`
 * link. An ordinary API provider with no console yields an empty list, so
 * callers render nothing rather than guessing a URL.
 * @param providerId - route id.
 * @param mode - restrict heavy providers to one mode; omitted returns both.
 * @returns dashboard URLs in display order; empty when none is known.
 */
export function providerDashboardUrls(providerId: string, mode?: 'reuse' | 'local'): string[] {
  const manifest = resolveHeavyManifest(providerId)
  if (manifest !== undefined) return heavyDashboardUrls(manifest, mode)
  const dashboard = providerPreset(providerId)?.dashboard
  return dashboard === undefined || dashboard === '' ? [] : [dashboard]
}

/** Default API-key env ref for a provider id (deriveKeyRef convention). */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
