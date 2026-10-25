/**
 * First-run product defaults. On the first settled boot of a fresh settings
 * document the seed writes the keyless Kilo Gateway route and points the
 * default model at a free model the gateway actually serves, so a new machine
 * can talk to a model with no key and no setup. That model is the first
 * attempt and the shipped `free` model group is the fallback: the seed names
 * both, so one dead free id escalates through the group instead of leaving the
 * session with nothing. The same write pins the keeper and compaction personas
 * to the seeded route: they name a provider, so they are route state and ship
 * through this seed rather than the tracked profile template. The write goes
 * into the user layer, which keeps the route removable from the Models page:
 * removing it unsets the path, and the marker below stops any later boot from
 * re-adding it. The route names the public Kilo gateway endpoint, never a
 * machine-local server.
 * @module @deepseek-ai/dsh-host-first-run
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Empty type imports carry the `settings` and `loader` Context merges for the reads below.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'

/** Route id seeded on a fresh install. */
export const KILO_ROUTE_ID = 'kilo'
/**
 * Free model the seeded route serves, and the first attempt of the seeded
 * session default. Measured against the live gateway on 2026-10-25: the old
 * `kilo-auto/free` answered 200 with EMPTY content (it routes to a stealth
 * model) and `kilo-auto/balanced` answered 400 "You need to sign in to use
 * this model", while this id answered with real content (262k context, tools
 * and reasoning advertised). A deployment that overrides it keeps the shipped
 * `free` group as the fallback rung.
 */
export const KILO_MODEL_ID = 'poolside/laguna-s-2.1:free'
/** Display name the seeded route carries for {@link KILO_MODEL_ID}. */
export const KILO_MODEL_NAME = 'Poolside Laguna S 2.1 (free)'
/**
 * Shipped model group seeded as the default route's fallback. `free` is the
 * built-in group the composition ships (zero-price, tool-capable, ungated,
 * visible, ≥64k context), so a fresh install gets the live free catalogue as
 * the rung after {@link KILO_MODEL_ID} without any settings write of its own.
 */
export const KILO_FREE_CHAIN_ID = 'free'
/** Public gateway endpoint; a machine-local server is never assumed. */
export const KILO_BASE_URL = 'https://api.kilo.ai/api/gateway'
/** Credential reference the route names; keyless keeps it optional. */
export const KILO_KEY_REF = 'KILO_API_KEY'
/** Display name the seeded route carries. */
export const KILO_DISPLAY_NAME = 'Kilo Gateway'
/** llm-pi-ai wire protocol the seeded route declares. */
export const KILO_API = 'openai-completions'
/** Persona ids the seed points at the seeded route. */
export const KILO_PERSONA_IDS: readonly string[] = ['keeper', 'compaction']
/** Settings namespace owning the fleet document the personas live in. */
export const ORCHESTRATION_NAMESPACE = 'enpoi-orchestration'
/** Marker value written after a successful seed. */
export const FIRST_RUN_SEED_VERSION = '2026-09-28.1'

/** Plugin config: the seeded route, and the marker read back on later boots. */
export interface Config {
  /** Run the seed when no marker is stored. */
  enabled: boolean
  /** Route id to seed. */
  provider: string
  /** Model the route serves and the session default points at. */
  model: string
  /** Model group id seeded as the session default's fallback. */
  chain: string
  /** Display name written into the route profile. */
  displayName: string
  /** llm-pi-ai wire protocol the route profile declares. */
  api: string
  /** Gateway endpoint the route profile names. */
  baseURL: string
  /** Credential reference the route profile names. */
  apiKeyEnv: string
  /** Whether the route accepts keyless requests. */
  keyless: boolean
  /** Marker; any stored value means the seed already ran. */
  seedVersion: Volatile<string | undefined>
}

/** Validated seed configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(KILO_ROUTE_ID),
  model: z.string().default(KILO_MODEL_ID),
  chain: z.string().default(KILO_FREE_CHAIN_ID),
  displayName: z.string().default(KILO_DISPLAY_NAME),
  api: z.string().default(KILO_API),
  baseURL: z.string().default(KILO_BASE_URL),
  apiKeyEnv: z.string().default(KILO_KEY_REF),
  keyless: z.boolean().default(true),
  seedVersion: z.string().volatile(),
}) as z<Config>

/** Route fields an operator may override; each falls back to the shipped default. */
export interface KiloRouteOverrides {
  /** Display name written into the route profile. */
  displayName?: string
  /** llm-pi-ai wire protocol the route profile declares. */
  api?: string
  /** Gateway endpoint the route profile names. */
  baseURL?: string
  /** Credential reference the route profile names. */
  apiKeyEnv?: string
  /** Whether the route accepts keyless requests. */
  keyless?: boolean
}

/** The provider route value written into the `llm-pi-ai` user section. */
export function kiloRouteValue(model: string = KILO_MODEL_ID, route: KiloRouteOverrides = {}): Record<string, unknown> {
  return {
    displayName: route.displayName ?? KILO_DISPLAY_NAME,
    api: route.api ?? KILO_API,
    baseURL: route.baseURL ?? KILO_BASE_URL,
    apiKeyEnv: route.apiKeyEnv ?? KILO_KEY_REF,
    keyless: route.keyless ?? true,
    models: [{
      id: model,
      name: model === KILO_MODEL_ID ? KILO_MODEL_NAME : model,
    }],
  }
}

/**
 * The persona seeds written into the `enpoi-orchestration` user section. A
 * blank chain is "no group", so it is omitted rather than written empty.
 */
export function kiloPersonaSeeds(
  provider: string,
  model: string,
  chain: string = KILO_FREE_CHAIN_ID,
): Record<string, { provider: string; model: string; chain?: string }> {
  const seeds: Record<string, { provider: string; model: string; chain?: string }> = {}
  for (const id of KILO_PERSONA_IDS) seeds[id] = { provider, model, ...chain === '' ? {} : { chain } }
  return seeds
}

/** The settings operations the seed needs; `ctx.settings` satisfies this structurally. */
export interface SeedSettings {
  /**
   * Project one namespace's user section.
   * @param ns - settings namespace identity.
   * @returns the descriptor's user projection, or undefined when the namespace is not mounted.
   */
  describeNamespace(ns: string): { user?: unknown } | undefined
  /**
   * Merge fields into a namespace's user section.
   * @param ns - settings namespace identity.
   * @param patch - fields to merge.
   * @returns settlement after the write was persisted.
   */
  update(ns: string, patch: object): Promise<void>
}

/** What one seed attempt decided. */
export type SeedOutcome =
  /** The route, default model, personas, and marker were written. */
  | 'seeded'
  /** Provider routes already exist (a configured install); only the marker moved. */
  | 'present'
  /** A marker was already stored; nothing was read or written. */
  | 'already'
  /** The settings namespaces are not mounted in this composition. */
  | 'unavailable'

/** Seed request after config resolution. */
export interface SeedOptions extends KiloRouteOverrides {
  provider: string
  model: string
  /** Model group id written onto the default seat and the personas. */
  chain: string
  version: string
}

/** Whether one settings projection carries any configured provider route. */
function hasProviderRoutes(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false
  const providers = (user as { providers?: unknown }).providers
  return typeof providers === 'object' && providers !== null && Object.keys(providers).length > 0
}

/**
 * Seed the first-run defaults, at most once per settings document.
 * @param settings - the live settings service, or undefined when it is not mounted.
 * @param options - resolved route fields, model, chain, and marker version.
 * @returns what this attempt decided.
 * @throws When the settings service refuses a write; the caller logs and continues.
 */
export async function seedFirstRun(
  settings: SeedSettings | undefined,
  options: SeedOptions,
): Promise<SeedOutcome> {
  if (settings === undefined) return 'unavailable'
  const providerSection = settings.describeNamespace('llm-pi-ai')
  if (providerSection === undefined) return 'unavailable'
  if (!hasProviderRoutes(providerSection.user)) {
    await settings.update('llm-pi-ai', { providers: { [options.provider]: kiloRouteValue(options.model, options) } })
    // Provider/model is the first attempt; the chain is the shipped free group
    // appended behind it. The runtime starts at the named link and escalates
    // through the group's selector matches on a retryable failure.
    await settings.update('agent-default-model', {
      provider: options.provider,
      model: options.model,
      // A blank configured group means "no fallback": omit the key instead of
      // storing an empty group id.
      ...options.chain === '' ? {} : { chain: options.chain },
    })
    // The personas name the route just seeded, so they land in the same
    // once-only write. A profile without the fleet namespace (a non-Enpoi
    // composition) skips them instead of failing the whole seed.
    if (settings.describeNamespace(ORCHESTRATION_NAMESPACE) !== undefined) {
      await settings.update(ORCHESTRATION_NAMESPACE, {
        personas: kiloPersonaSeeds(options.provider, options.model, options.chain),
      })
    }
    await settings.update('first-run', { seedVersion: options.version })
    return 'seeded'
  }
  await settings.update('first-run', { seedVersion: options.version })
  return 'present'
}

/** Stable Cordis plugin name. */
export const name = 'first-run'

/** The seed reads and writes the settings document. */
export const inject = ['settings']

/**
 * Register the seed after the Loader settles every entry, so the namespaces it
 * writes exist; a refused or failed seed logs one warning and never blocks boot.
 * @param ctx - host context carrying the settings service.
 * @param config - resolved seed configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // The marker is an internal fact, not a user-editable setting.
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'first-run: hide the seed marker')
  if (!config.enabled || (config.seedVersion.get() ?? '') !== '') return
  void ctx.root.loader.await()
    .then(() => seedFirstRun(ctx.settings, {
      provider: config.provider,
      model: config.model,
      chain: config.chain,
      version: FIRST_RUN_SEED_VERSION,
      displayName: config.displayName,
      api: config.api,
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      keyless: config.keyless,
    }))
    .then((outcome) => {
      if (outcome === 'seeded') {
        ctx.logger.info('first-run: seeded the keyless %s route (%s, group %s)', config.provider, config.model, config.chain)
      }
      else if (outcome === 'unavailable') ctx.logger.debug('first-run: settings namespaces are not mounted; seed skipped')
    })
    .catch((error: unknown) => {
      ctx.logger.warn('first-run: seed did not complete:', error)
    })
}
