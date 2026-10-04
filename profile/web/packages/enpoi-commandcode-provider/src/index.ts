/**
 * enpoi-commandcode-provider — DSH's Command Code route.
 *
 * Mounts one `LlmAdapter` for every route in the plugin config
 * (`providers.<route>`), exactly as the heavy-provider flow writes it:
 *
 * ```yaml
 * - id: commandcode-provider
 *   name: 'dsh-enpoi-commandcode-provider'
 *   config:
 *     providers:
 *       commandcode:
 *         displayName: Command Code (keypool)
 *         api: commandcode/alpha-generate
 *         baseURL: http://127.0.0.1:8899/commandcode
 *         keyless: true
 *         # Optional user-image request budget; defaults shown.
 *         userImageMaxPixels: 4194304
 *         userImageMaxBytes: 1048576
 * ```
 *
 * The route is dormant until the config names one — nothing is registered and
 * nothing is fetched. On mount, every route's catalog is fetched once at
 * startup from `{baseURL}/catalog.json` (falling back to the bundled
 * snapshot), and the adapter serves `commandcode` through the local keypool.
 * User-attached images are read at the route's request size
 * (`store.readImageRequest`); tool-result images keep their stored bytes before
 * the converter's own forwarder budget applies. The sanitizer (older-image
 * stripping, embedded-base64 scrubbing, 200k text cap) lives in the keypool and
 * is deliberately not duplicated here.
 *
 * @module dsh-enpoi-commandcode-provider
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CatalogEntry } from './catalog.js'
import { CatalogStore, parseCatalog } from './catalog.js'
import type { CommandCodeRouteProfile } from './adapter.js'
import { CommandCodeAdapter, DEFAULT_USER_IMAGE_MAX_BYTES, DEFAULT_USER_IMAGE_MAX_PIXELS } from './adapter.js'

/** Cordis plugin name. */
export const name = 'commandcode-provider'

/** The plugin needs the LLM seam; every other service is probed lazily. */
export const inject = ['llm']

/** Bundled catalog snapshot used when the keypool is unreachable. */
function loadSnapshot(): CatalogEntry[] {
  try {
    const path = fileURLToPath(new URL('../catalog.snapshot.json', import.meta.url))
    return parseCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return []
  }
}

/** One configured route read out of the raw plugin config. */
function routeFromConfig(route: string, raw: unknown): CommandCodeRouteProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`commandcode-provider: provider "${route}" must be an object`)
  }
  const record = raw as Record<string, unknown>
  const baseURL = record.baseURL
  if (typeof baseURL !== 'string' || baseURL.trim() === '') {
    throw new Error(`commandcode-provider: provider "${route}" needs a non-empty baseURL`)
  }
  const models = Array.isArray(record.models)
    ? record.models.flatMap((model): { id: string; name?: string }[] => {
        if (typeof model !== 'object' || model === null) return []
        const entry = model as Record<string, unknown>
        if (typeof entry.id !== 'string' || entry.id === '') return []
        return [typeof entry.name === 'string' ? { id: entry.id, name: entry.name } : { id: entry.id }]
      })
    : []
  const positiveInteger = (value: unknown, field: string, fallback: number): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`commandcode-provider: provider "${route}" ${field} must be a positive integer`)
    }
    return value
  }
  return {
    route,
    displayName: typeof record.displayName === 'string' && record.displayName !== '' ? record.displayName : route,
    baseURL,
    ...typeof record.apiKeyEnv === 'string' && record.apiKeyEnv !== '' ? { apiKeyEnv: record.apiKeyEnv } : {},
    keyless: record.keyless === true || (record.apiKeyEnv === undefined && record.key === undefined),
    models,
    userImageMaxPixels: positiveInteger(record.userImageMaxPixels, 'userImageMaxPixels', DEFAULT_USER_IMAGE_MAX_PIXELS),
    userImageMaxBytes: positiveInteger(record.userImageMaxBytes, 'userImageMaxBytes', DEFAULT_USER_IMAGE_MAX_BYTES),
  }
}

/**
 * Mount the adapter for every configured route. A bare mount (no routes) is
 * the dormant posture: nothing registers, nothing fetches.
 * @param ctx - owning context.
 * @param config - raw plugin config (`providers` dict).
 */
export function apply(ctx: Context, config: unknown): void {
  const providers = typeof config === 'object' && config !== null
    ? (config as Record<string, unknown>).providers
    : undefined
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return

  const profiles = new Map<string, CommandCodeRouteProfile>()
  for (const [route, raw] of Object.entries(providers as Record<string, unknown>)) {
    const profile = routeFromConfig(route, raw)
    profiles.set(route, profile)
    ctx.logger.info(`commandcode-provider: route "${route}" → ${profile.baseURL} (${profile.keyless ? 'keyless/keypool' : 'byok'})`)
  }
  if (profiles.size === 0) return

  const snapshot = loadSnapshot()
  const catalogs = new Map<string, CatalogStore>()
  const catalogFor = (profile: CommandCodeRouteProfile): CatalogStore => {
    let store = catalogs.get(profile.route)
    if (store === undefined) {
      store = new CatalogStore({ baseURL: profile.baseURL, snapshot })
      catalogs.set(profile.route, store)
      store.start()
    }
    return store
  }

  const resolveApiKey = async (profile: CommandCodeRouteProfile): Promise<string | undefined> => {
    if (profile.keyless || profile.apiKeyEnv === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    const hit = await credentials.resolve(profile.apiKeyEnv)
    return hit?.value
  }

  const attachments = (): AttachmentStore | undefined => ctx.get('attachments')
  const adapter = new CommandCodeAdapter({
    profiles: () => profiles,
    catalogFor,
    resolveApiKey,
    readImage: async (ref, signal) => {
      const store = attachments()
      if (store === undefined) return undefined
      try {
        const stored = await store.readImage(ref, signal)
        return { data: stored.data, mediaType: ref.mediaType }
      } catch {
        return undefined
      }
    },
    readUserImage: async (ref, target, signal) => {
      const store = attachments()
      if (store === undefined) return undefined
      try {
        const version = await store.readImageRequest(ref, target, signal)
        return { data: version.data, mediaType: version.mediaType }
      } catch {
        return undefined
      }
    },
  })

  ctx.llm.registerAdapter([...profiles.keys()], adapter)
}
