/**
 * The v1 provider catalog: the single source of provider ids, credential
 * references, profile row templates, and canary kinds this package applies.
 * The wizard lane keeps its own copy for UI labels; ids, refs, and row names
 * here are the values that reach `ctx.web`, the vault, and the profile.
 *
 * @module @deepseek-ai/dsh-web-setup/catalog
 */

import type { WebSetupProviderKind, WebSetupProviderSpec } from './types.ts'

/** Row id of the web capability seam in the shipped profile. */
export const WEB_ROW_ID = 'web'

/** Module name of the web capability seam. */
export const WEB_PLUGIN_NAME = '@deepseek-ai/dsh-web'

/** Row id of the model-facing web tool suite in the shipped profile. */
export const TOOL_WEB_ROW_ID = 'tool-web'

/** Module name of the model-facing web tool suite. */
export const TOOL_WEB_PLUGIN_NAME = '@deepseek-ai/dsh-tool-web'

/**
 * Every provider the v1 wizard can select. Row names for the not-yet-shipped
 * adapters (`brave`, `tavily`, `searxng`, `jina`) follow the shipped
 * `web-search-<id>` / `web-fetch-<id>` naming; `jina` is reserved for the
 * fetch adapter lane and its row mounts only once that package ships.
 */
export const WEB_SETUP_PROVIDERS: readonly WebSetupProviderSpec[] = [
  {
    id: 'exa',
    kind: 'search',
    keyRef: 'EXA_API_KEY',
    row: {
      id: 'web-search-exa',
      name: '@deepseek-ai/dsh-web-search-exa',
      config: { apiKeyEnv: 'EXA_API_KEY' },
    },
    canary: { kind: 'http-search', provider: 'exa' },
  },
  {
    id: 'deepseek-official',
    kind: 'search',
    keyRef: 'DEEPSEEK_API_KEY',
    row: {
      id: 'web-search-deepseek',
      name: '@deepseek-ai/dsh-web-search-deepseek',
      config: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    },
    canary: { kind: 'credential' },
  },
  {
    id: 'brave',
    kind: 'search',
    keyRef: 'BRAVE_API_KEY',
    row: {
      id: 'web-search-brave',
      name: '@deepseek-ai/dsh-web-search-brave',
      config: { apiKeyEnv: 'BRAVE_API_KEY' },
    },
    canary: { kind: 'http-search', provider: 'brave' },
  },
  {
    id: 'tavily',
    kind: 'search',
    keyRef: 'TAVILY_API_KEY',
    row: {
      id: 'web-search-tavily',
      name: '@deepseek-ai/dsh-web-search-tavily',
      config: { apiKeyEnv: 'TAVILY_API_KEY' },
    },
    canary: { kind: 'http-search', provider: 'tavily' },
  },
  {
    id: 'searxng',
    kind: 'search',
    keyRef: null,
    row: {
      id: 'web-search-searxng',
      name: '@deepseek-ai/dsh-web-search-searxng',
      config: {},
    },
    canary: { kind: 'http-search', provider: 'searxng' },
  },
  {
    id: 'http',
    kind: 'fetch',
    keyRef: null,
    row: {
      id: 'web-fetch-http',
      name: '@deepseek-ai/dsh-web-fetch-http',
      config: {},
    },
    canary: { kind: 'none' },
  },
  {
    id: 'jina',
    kind: 'fetch',
    keyRef: 'JINA_API_KEY',
    row: {
      id: 'web-fetch-jina',
      name: '@deepseek-ai/dsh-web-fetch-jina',
      config: { apiKeyEnv: 'JINA_API_KEY' },
    },
    canary: { kind: 'http-fetch', provider: 'jina' },
  },
]

/**
 * Resolve one catalog entry by kind and provider id.
 * @param kind - capability the caller wants to configure.
 * @param id - provider id as it appears on the wire.
 * @returns the catalog entry, or `undefined` for an unknown or wrong-kind id.
 */
export function providerSpec(kind: WebSetupProviderKind, id: string): WebSetupProviderSpec | undefined {
  return WEB_SETUP_PROVIDERS.find(spec => spec.kind === kind && spec.id === id)
}

/**
 * Catalog entry that names a provider id regardless of kind; used to report a
 * wrong-kind selection precisely instead of "unknown".
 * @param id - provider id as it appears on the wire.
 * @returns the catalog entry for either kind, or `undefined`.
 */
export function anyProviderSpec(id: string): WebSetupProviderSpec | undefined {
  return WEB_SETUP_PROVIDERS.find(spec => spec.id === id)
}

/**
 * Unique credential references the catalog names, in catalog order.
 * @returns bare reference names, such as `EXA_API_KEY`.
 */
export function catalogKeyRefs(): string[] {
  const refs: string[] = []
  for (const spec of WEB_SETUP_PROVIDERS) {
    if (spec.keyRef !== null && !refs.includes(spec.keyRef)) refs.push(spec.keyRef)
  }
  return refs
}
