/**
 * Provider catalog for the Add Provider workflow.
 *
 * Generated from the models.dev mirror (~/.cache/opencode/models.json) by
 * /tmp/opencode/gen-provider-presets.mjs — 212 presets, each carrying the
 * provider's canonical settings (env vars, wire protocol, base URL, docs).
 * Regenerate with: node /tmp/opencode/gen-provider-presets.mjs
 */

import presets from './provider-presets.ts'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS, heavyDashboardUrls, type HeavyProviderManifest } from './heavy-providers.ts'
import { heavyManifestState, resolveHeavyManifest } from './heavy-manifest-source.ts'

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
   */
  keyless?: boolean
  /**
   * HEAVY provider: listed, but nothing is installed until the operator adds
   * one. The manifest drives the mode choice, install job, health probe, and
   * removal confirmation; until then the preset has no route and is excluded
   * from the provider-sync endpoint set.
   */
  heavy?: HeavyProviderManifest
}

/**
 * Presets whose free tier serves requests with no credential at all. Kept
 * outside the generated data module so regenerating the preset list cannot
 * drop the capability.
 */
const KEYLESS_PRESET_IDS = new Set(['kilo'])

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

/** The generated mainstream presets with the keyless override applied. */
const MAINSTREAM_TEMPLATES: ProviderTemplate[] =
  (presets as unknown as ProviderTemplate[]).map(preset =>
    KEYLESS_PRESET_IDS.has(preset.id) ? { ...preset, keyless: true } : preset)

/**
 * The pre-connection listing: mainstream presets plus the labelled fallback
 * heavy table. Live render code uses {@link liveProviderTemplates}.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] =
  MAINSTREAM_TEMPLATES.concat(FALLBACK_HEAVY_PROVIDER_MANIFESTS.map(heavyTemplate))

/**
 * The listing to render now: mainstream presets plus the current heavy table
 * (the host's manifests once connected, the fallback before).
 * @returns the templates in listing order.
 */
export function liveProviderTemplates(): ProviderTemplate[] {
  return MAINSTREAM_TEMPLATES.concat(heavyManifestState().manifests.map(heavyTemplate))
}

/** OpenCode's popular-provider ordering (use-providers.ts popularProviders). */
export const POPULAR_PROVIDERS = [
  'opencode',
  'opencode-go',
  'anthropic',
  'github-copilot',
  'openai',
  'google',
  'openrouter',
  'vercel',
]

/** Providers that need no API key (local / free endpoints). */
export const KEYLESS_PROVIDERS = new Set(['ollama', 'lmstudio', 'llama-cpp', 'vllm', 'localai'])

/** Resolve a preset by id. */
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
