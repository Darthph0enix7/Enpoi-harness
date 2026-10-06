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
 *         displayName: Command Code
 *         api: commandcode/alpha-generate
 *         baseURL: https://api.commandcode.ai
 *         apiKeyEnv: COMMANDCODE_KEY_1
 *         pool:
 *           strategy: priority-sticky
 *           identities:
 *             - { id: key-1, credentialRef: COMMANDCODE_KEY_1, priority: 1 }
 *         # Optional user-image request budget; defaults shown.
 *         userImageMaxPixels: 4194304
 *         userImageMaxBytes: 1048576
 * ```
 *
 * The route is dormant until the config names one — nothing is registered and
 * nothing is fetched. Route profiles resolve per operation from the live
 * config, so a settings edit (a new pool identity, a credential reference, a
 * changed baseURL) reaches the next request without a remount; a changed route
 * set re-registers in place through the loader's volatile-update seam. Every
 * route's catalog resolves on first use: a loopback baseURL (a legacy keypool
 * deployment) may serve `{baseURL}/catalog.json` and falls back to the bundled
 * snapshot; a non-loopback (direct-vendor) route resolves the bundled snapshot
 * without fetching, because the vendor exposes no catalog endpoint.
 *
 * The shipped route is the direct vendor endpoint with a native credential
 * pool: the route profile carries the identities ({ id, credentialRef,
 * priority }), the adapter resolves each secret from the credentials store
 * (Settings → Models Keys card) or the environment, injects the Command Code
 * CLI headers itself, rotates identities on quota/auth failures, and has the
 * conversion seam text-sanitize the request (`src/sanitize.ts` through
 * `src/convert.ts`); rotation state persists in
 * `$DSH_HOME/pools/commandcode.json`. A route without pool identities keeps
 * the single-key path, and a keyless route is refused unless it points at
 * loopback (a keypool that injects its own auth): an anonymous request cannot
 * pass the vendor gate. Mounted routes also register with the configurable-
 * provider directory under this plugin's settings namespace, which is how the
 * Keys card reaches pool status and identity checks, and register a model
 * discovery for the namespace: the Models page's Refresh and Test Connection,
 * and the Add Provider draft, answer from the bundled catalog snapshot on a
 * direct route (the vendor exposes no model listing), so a freshly written
 * route carries the catalog's models, context windows, and input modalities.
 *
 * @module dsh-enpoi-commandcode-provider
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import {
  LlmError,
  type AdapterRegistrationHandle,
  type DirectoryRegistrationHandle,
  type LlmConfigurableProvider,
} from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { PoolEngine } from '@deepseek-ai/dsh-llm-pi-ai'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import type { CatalogEntry } from './catalog.js'
import { CatalogStore, contextWindowOf, maxOutputTokensOf, modalitiesOf, parseCatalog } from './catalog.js'
import type { CommandCodePoolConfig, CommandCodePoolIdentity, CommandCodeRouteModel, CommandCodeRouteProfile } from './adapter.js'
import { CommandCodeAdapter, DEFAULT_USER_IMAGE_MAX_BYTES, DEFAULT_USER_IMAGE_MAX_PIXELS } from './adapter.js'

/** Cordis plugin name. */
export const name = 'commandcode-provider'

/** The plugin needs the LLM seam; every other service is probed lazily. */
export const inject = ['llm']

/** Settings namespace fallback when the plugin entry carries no id. */
const DEFAULT_SETTINGS_NS = 'commandcode-provider'

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Detach every Config field into plain values (idempotent on pre-0.1.7 plain configs). */
function plainConfig<T extends object>(config: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config)) {
    out[key] = typeof (field as { get?: () => unknown } | undefined)?.get === 'function'
      ? (field as { get: () => unknown }).get()
      : field
  }
  return out as T
}

/** One provider route as the heavy-provider flow (or an operator) writes it. */
export interface CommandCodeRouteConfig {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  keyless?: boolean
  models?: CommandCodeRouteModel[]
  userImageMaxPixels?: number
  userImageMaxBytes?: number
  /** Opt-in native credential pool; see {@link CommandCodePoolConfig}. */
  pool?: CommandCodePoolConfig
}

/** Plugin configuration (schemastery-validated by the loader; live-editable). */
export interface Config {
  /** Provider routes keyed by route name; settings edits reach the next request without a remount. */
  providers?: Volatile<Record<string, CommandCodeRouteConfig>>
}

const poolIdentitySchema = Schema.object({
  id: Schema.string().required(),
  credentialRef: Schema.string().required(),
  priority: Schema.natural(),
  enabled: Schema.boolean().default(true),
})

/**
 * The only wire protocol this adapter serves. The schema declares it as a
 * single-value union so the settings page's protocol picker (which reads union
 * nodes out of the route schema) offers the route's actual protocol instead of
 * an empty control; the value is the manifest's declared `protocol`.
 */
const ROUTE_PROTOCOLS = ['commandcode/alpha-generate'] as const

/** One route model entry as the route writer and the models page persist it. */
const routeModelSchema = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  contextWindow: Schema.natural().min(1),
  maxTokens: Schema.natural().min(1),
  input: Schema.array(Schema.union(['text', 'image'] as const)),
})

const routeProfileSchema = Schema.object({
  displayName: Schema.string(),
  api: Schema.union(ROUTE_PROTOCOLS),
  baseURL: Schema.string(),
  apiKeyEnv: Schema.string(),
  keyless: Schema.boolean(),
  models: Schema.array(routeModelSchema),
  userImageMaxPixels: Schema.natural(),
  userImageMaxBytes: Schema.natural(),
  // `.default(undefined)` is load-bearing: without it the nested object
  // materializes as `{}` for a route that declares no pool, and schemastery
  // then rejects the absent `identities` — failing every keypool route at
  // load. An explicit `pool: {}` still fails loud, as it should.
  pool: Schema.object({
    strategy: Schema.union(['priority-sticky', 'balanced'] as const),
    identities: Schema.array(poolIdentitySchema).required(),
  }).default(undefined),
})

/**
 * Schemastery validator for {@link Config}. `providers` is `.volatile()`, so
 * the merged settings service derives live forms from this schema and persists
 * edits through the active profile patch without remounting the plugin.
 */
export const Config = Schema.object({
  providers: live(Schema.dict(routeProfileSchema).default({})),
})

/** Bundled catalog snapshot used when the keypool is unreachable. */
function loadSnapshot(): CatalogEntry[] {
  try {
    const path = fileURLToPath(new URL('../catalog.snapshot.json', import.meta.url))
    return parseCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return []
  }
}

/**
 * Parse and validate one route's opt-in pool block. Every failure is loud at
 * load: a pool that cannot route is a configuration error, never a silent
 * fallback to the keypool path.
 * @param route - route key, for the error message.
 * @param raw - the `pool` value as written.
 * @returns the parsed pool, or an empty object when none was declared.
 */
function parsePoolConfig(route: string, raw: unknown): { pool?: CommandCodePoolConfig } {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`commandcode-provider: provider "${route}" pool must be an object`)
  }
  const record = raw as Record<string, unknown>
  const strategy = record.strategy
  if (strategy !== undefined && strategy !== 'priority-sticky' && strategy !== 'balanced') {
    throw new Error(`commandcode-provider: provider "${route}" pool.strategy must be "priority-sticky" or "balanced"`)
  }
  const identitiesRaw = record.identities
  if (!Array.isArray(identitiesRaw) || identitiesRaw.length === 0) {
    throw new Error(`commandcode-provider: provider "${route}" pool.identities must be a non-empty array`)
  }
  const identities: CommandCodePoolIdentity[] = []
  const seen = new Set<string>()
  for (const entry of identitiesRaw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`commandcode-provider: provider "${route}" pool identity must be an object`)
    }
    const identity = entry as Record<string, unknown>
    if (typeof identity.id !== 'string' || identity.id === '') {
      throw new Error(`commandcode-provider: provider "${route}" pool identity needs a non-empty id`)
    }
    if (seen.has(identity.id)) {
      throw new Error(`commandcode-provider: provider "${route}" pool identity id "${identity.id}" is duplicated`)
    }
    seen.add(identity.id)
    if (typeof identity.credentialRef !== 'string' || identity.credentialRef === '') {
      throw new Error(
        `commandcode-provider: provider "${route}" pool identity "${identity.id}" needs a non-empty credentialRef`,
      )
    }
    // A ref outside the credentials grammar can never resolve: the resolver
    // rejects it with a raw TypeError at request time, so the pool is refused
    // at parse time with the same Keys-card action the adapter raises.
    if (!isCredentialRefName(identity.credentialRef)) {
      throw new LlmError(
        `Command Code route "${route}" pool identity "${identity.id}" names "${identity.credentialRef}", which is not`
        + ' a credential reference; name one (for example COMMANDCODE_KEY_1) and store its key on the'
        + ' Models page (Keys card) or export it, then retry',
        'MISSING_CREDENTIAL',
      )
    }
    const priority = identity.priority
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isSafeInteger(priority) || priority < 0)) {
      throw new Error(
        `commandcode-provider: provider "${route}" pool identity "${identity.id}" priority must be a non-negative integer`,
      )
    }
    const enabled = identity.enabled
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error(`commandcode-provider: provider "${route}" pool identity "${identity.id}" enabled must be a boolean`)
    }
    identities.push({
      id: identity.id,
      credentialRef: identity.credentialRef,
      ...typeof priority === 'number' ? { priority } : {},
      ...typeof enabled === 'boolean' ? { enabled } : {},
    })
  }
  return { pool: { ...strategy === undefined ? {} : { strategy }, identities } }
}

/**
 * Read one optional positive-integer model capacity. A malformed value is a
 * configuration error, never silently dropped: the models page writes these
 * from discovery, so a bad one means a bad write.
 * @param value - the raw capacity as written.
 * @param route - route key, for the error message.
 * @param field - capacity field name, for the error message.
 * @returns the capacity, or undefined when absent.
 */
function optionalCapacity(value: unknown, route: string, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`commandcode-provider: provider "${route}" model ${field} must be a positive integer`)
  }
  return value
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
    ? record.models.flatMap((model): CommandCodeRouteModel[] => {
        if (typeof model !== 'object' || model === null) return []
        const entry = model as Record<string, unknown>
        if (typeof entry.id !== 'string' || entry.id === '') return []
        const contextWindow = optionalCapacity(entry.contextWindow, route, 'contextWindow')
        const maxTokens = optionalCapacity(entry.maxTokens, route, 'maxTokens')
        const input = Array.isArray(entry.input)
          ? entry.input.filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
          : []
        return [{
          id: entry.id,
          ...typeof entry.name === 'string' ? { name: entry.name } : {},
          ...contextWindow === undefined ? {} : { contextWindow },
          ...maxTokens === undefined ? {} : { maxTokens },
          ...input.length === 0 ? {} : { input },
        }]
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
    ...parsePoolConfig(route, record.pool),
  }
}

/** The raw `providers` dict of a resolved or candidate config; volatile references are unwrapped. */
function providersOf(source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return undefined
  return (plainConfig(source) as { providers?: unknown }).providers
}

/**
 * Parse every route in a `providers` value. A malformed route throws — the
 * same failure the mount-time read produced — so a settings write that could
 * not serve is refused rather than committed.
 * @param providers - the `providers` dict; any other value yields no routes.
 * @returns the parsed routes by provider key.
 */
function parseProfiles(providers: unknown): Map<string, CommandCodeRouteProfile> {
  const profiles = new Map<string, CommandCodeRouteProfile>()
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return profiles
  for (const [route, raw] of Object.entries(providers)) profiles.set(route, routeFromConfig(route, raw))
  return profiles
}

/**
 * Mount the adapter for the configured routes. A bare mount (no routes) is the
 * dormant posture: nothing registers, nothing fetches, and a later settings
 * edit can still supply the first route.
 * @param ctx - owning context.
 * @param config - validated plugin config (`providers` dict).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settingsNs = ctx.fiber.entry?.options.id ?? DEFAULT_SETTINGS_NS
  const snapshot = loadSnapshot()

  // Profiles resolve per operation from the live config, memoized by the raw
  // snapshot's identity so an unchanged config costs one identity check. A
  // settings edit commits a new volatile snapshot — the same seam llm-pi-ai
  // resolves over — so the next request, not the next remount, observes it.
  let lastRaw: unknown
  let memoized: ReadonlyMap<string, CommandCodeRouteProfile> | undefined
  const profiles = (): ReadonlyMap<string, CommandCodeRouteProfile> => {
    const raw = providersOf(config)
    if (memoized !== undefined && raw === lastRaw) return memoized
    const next = parseProfiles(raw)
    lastRaw = raw
    memoized = next
    return next
  }

  for (const [route, profile] of profiles()) {
    const posture = profile.pool === undefined
      ? (profile.keyless ? 'keyless/keypool' : 'byok')
      : `native pool ×${String(profile.pool.identities.length)}`
    ctx.logger.info(`commandcode-provider: route "${route}" → ${profile.baseURL} (${posture})`)
  }

  const catalogs = new Map<string, { baseURL: string; store: CatalogStore }>()
  const catalogFor = (profile: CommandCodeRouteProfile): CatalogStore => {
    const cached = catalogs.get(profile.route)
    // A route's baseURL is editable: a changed one resolves a fresh store
    // instead of serving the previous endpoint's catalog.
    if (cached !== undefined && cached.baseURL === profile.baseURL) return cached.store
    const store = new CatalogStore({ baseURL: profile.baseURL, snapshot })
    catalogs.set(profile.route, { baseURL: profile.baseURL, store })
    store.start()
    return store
  }

  // Configuration surfaces interrogate this namespace through the registered
  // discovery: Refresh and Test Connection on a configured route, and the Add
  // Provider flow before its first route exists. The bundled snapshot answers
  // a draft or an unmounted route, and a configured loopback route keeps its
  // live keypool catalog. The discovery never mutates settings or credentials
  // — the caller owns the write.
  ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
    const profile = request.provider === undefined ? undefined : profiles().get(request.provider)
    const entries = profile === undefined ? snapshot : await catalogFor(profile).entries()
    return entries.map((entry) => {
      const contextWindow = contextWindowOf(entry)
      const maxTokens = maxOutputTokensOf(entry)
      const input = modalitiesOf(entry)
      return {
        id: entry.id,
        name: entry.name,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...input === undefined ? {} : { inputModalities: input },
      }
    })
  })

  const resolveApiKey = async (profile: CommandCodeRouteProfile): Promise<string | undefined> => {
    if (profile.keyless || profile.apiKeyEnv === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    const hit = await credentials.resolve(profile.apiKeyEnv)
    return hit?.value
  }

  // One pool engine for the plugin instance; routing state survives restarts
  // under `$DSH_HOME/pools/commandcode.json` and never holds key material.
  const launchEnv = launchEnvironmentOf(ctx)
  const poolEngine = new PoolEngine({
    stateDir: join(launchEnv.get('DSH_HOME')?.value ?? join(homedir(), '.dsh'), 'pools'),
    log: message => ctx.logger.warn(message),
  })
  const resolveCredential = async (reference: string): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(credentialRef(reference)))?.value
      : launchEnv.get(reference)?.value
    return hit !== undefined && hit.length > 0 ? hit : undefined
  }

  const attachments = (): AttachmentStore | undefined => ctx.get('attachments')
  const adapter = new CommandCodeAdapter({
    profiles,
    catalogFor,
    resolveApiKey,
    pool: poolEngine,
    resolveCredential,
    log: message => ctx.logger.warn(message),
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

  // The Keys card reaches this plugin's routes through the configurable-
  // provider directory; without the registration `llm.poolStatus()` has no
  // namespace to answer from and the card cannot show cooldowns or offer
  // identity checks. Both registrations track the current route set: the
  // registry and the directory capture routes at registration, so a route
  // added or removed by settings swaps them in place on the loader's
  // volatile-update instead of remounting the plugin.
  const directoryEntries = (): LlmConfigurableProvider[] => [...profiles().values()].map(profile => ({
    provider: profile.route,
    displayName: profile.displayName,
    settingsNs,
    settingsPath: ['providers', profile.route],
    // Every route exists only because configuration named it; the adapter
    // ships no route catalog of its own.
    declared: true,
  }))
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: LlmConfigurableProvider[] | undefined
  const ensureDirectory = (): void => {
    const entries = directoryEntries()
    if (directoryFacts !== undefined && deepEqualJson(entries, directoryFacts)) return
    if (directory === undefined) {
      if (entries.length === 0) {
        directoryFacts = entries
        return
      }
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }

  // The registry captures the route set and each route's display name, so a
  // change to either re-registers the same adapter instance; every other
  // profile fact is read per operation by the adapter itself.
  const registrationFacts = (): { provider: string; displayName: string }[] =>
    [...profiles().values()]
      .map(profile => ({ provider: profile.route, displayName: profile.displayName }))
      .sort((left, right) => left.provider.localeCompare(right.provider))
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: { provider: string; displayName: string }[] | undefined
  const ensureRegistration = (): void => {
    const facts = registrationFacts()
    if (registeredFacts !== undefined && deepEqualJson(facts, registeredFacts)) return
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }

  ctx.llm.registerPoolOperations(settingsNs, {
    async status(provider: string) {
      const profile = profiles().get(provider)
      await poolEngine.hydrate(provider)
      return poolEngine.identitiesStatus(provider, profile?.pool?.identities ?? [])
    },
    async resetCooldown(provider: string, identityId?: string) {
      await poolEngine.hydrate(provider)
      poolEngine.resetCooldown(provider, identityId)
    },
    async testIdentity(_provider: string, _identityId: string, _apiKey?: string) {
      // The vendor exposes no credential-test endpoint: a real probe would be a
      // full /alpha/generate call and spend quota. The owner-run live gate
      // (scripts/live-gate.mjs) is the supported proof instead. Status 501 is
      // the structured "not implemented" signal the Keys card renders as a
      // disabled, explanatory state rather than a failed credential.
      return {
        ok: false,
        status: 501,
        error: 'Command Code identity testing is not implemented; run scripts/live-gate.mjs',
      }
    },
  })

  // Refuse a settings write whose routes cannot be served, mirroring the
  // mount-time failure it would otherwise become on the next request; the
  // running references then keep serving the previous configuration.
  ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    parseProfiles(providersOf(raw))
    return raw
  })

  ensureDirectory()
  ensureRegistration()
  ctx.on('loader/volatile-update', () => {
    try {
      ensureRegistration()
      ensureDirectory()
    } catch (error) {
      ctx.logger.error('commandcode-provider: configuration conflicts with an existing provider route')
      ctx.logger.error(error)
    }
  })
}
