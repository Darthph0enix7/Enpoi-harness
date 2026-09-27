/**
 * Provider catalog for the Add Provider workflow.
 *
 * Generated from the models.dev mirror (~/.cache/opencode/models.json) by
 * /tmp/opencode/gen-provider-presets.mjs — 212 presets, each carrying the
 * provider's canonical settings (env vars, wire protocol, base URL, docs).
 * Regenerate with: node /tmp/opencode/gen-provider-presets.mjs
 */

import presets from './provider-presets.ts'

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
   * The provider serves requests without any credential (anonymous free
   * tier); its env ref stays optional and a supplied key switches to BYOK.
   */
  keyless?: boolean
}

/**
 * Presets whose free tier serves requests with no credential at all. Kept
 * outside the generated data module so regenerating the preset list cannot
 * drop the capability.
 */
const KEYLESS_PRESET_IDS = new Set(['kilo'])

export const PROVIDER_TEMPLATES: ProviderTemplate[] =
  (presets as unknown as ProviderTemplate[]).map(preset =>
    KEYLESS_PRESET_IDS.has(preset.id) ? { ...preset, keyless: true } : preset)

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

/** Default API-key env ref for a provider id (deriveKeyRef convention). */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}