/**
 * enpoi-update-check — host-side update check (docs/plan/ui-update-manifest.md
 * P2).
 *
 * What it owns:
 * - The periodic catalog check: a jittered boot check (~30 s base) and a
 *   jittered interval (default every 6 h) against the install's channel
 *   (`stable` or `beta`, from `$DSH_HOME/harness/install-state.json`).
 * - The install-vs-newest comparison and the `unknown | current | available |
 *   dismissed` status, exposed as the `updateCheck` Typert Remote namespace
 *   (`status`, `checkNow`, `dismiss`).
 * - The persisted per-install skip record
 *   (`$DSH_HOME/update-check/dismissed.json`); a newer catalog version re-arms.
 *
 * Advisory only: no download, no switch, no auto-update. Every failure is
 * fail-soft — the state stays `unknown` (or keeps its last successful
 * comparison) and at most one debug log line records the attempt. There is no
 * client push in this profile plugin family, so status is pollable through the
 * Remote namespace only; the P3 UI surface will own any push.
 *
 * @module dsh-enpoi-update-check
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { fetchCatalog, readInstallIdentity } from './catalog.js'
import { UpdateCheckService } from './remote.js'
import { UpdateCheckCore, startUpdateCheckSchedule } from './service.js'
import { readDismissedVersion, writeDismissedVersion } from './store.js'

/** Cordis plugin name. */
export const name = 'enpoi-update-check'

/** Nothing is required at plugin scope: the check must attach on a bare tree. */
export const inject: string[] = []

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

/** Plugin configuration (schemastery-validated by the loader; live-editable). */
export interface Config {
  /** Schedule automatic checks (default true). Manual `updateCheck.checkNow` still works when false. */
  enabled?: Volatile<boolean>
  /** Check interval in minutes (default 360; clamped to 1–10080). */
  intervalMinutes?: Volatile<number>
  /** Jitter bound in seconds added to the boot delay and every interval (default 300; clamped to 0–3600). */
  jitterSeconds?: Volatile<number>
}

/**
 * Schemastery validator for {@link Config}. Every field is `.volatile()`: the
 * merged settings service derives live forms from this schema and persists
 * edits through the active profile patch without remounting the plugin.
 */
export const Config: Schema<Config> = Schema.object({
  enabled: live(Schema.boolean().default(true)),
  intervalMinutes: live(Schema.number().default(360)),
  jitterSeconds: live(Schema.number().default(300)),
})

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.trunc(numeric), min), max)
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Mount the update check. A failure here disables the plugin loudly on stderr
 * and returns — it must never take the boot or a sibling plugin down with it.
 *
 * @param ctx - owning context.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  config = plainConfig(config)
  try {
    const homeResolver = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const resolveHome = typeof homeResolver === 'function' ? homeResolver : dshHomePath
    const home = resolveHome()
    const identity = readInstallIdentity(home)
    const dismissedPath = resolveHome('update-check', 'dismissed.json')
    const intervalMinutes = clamp(config.intervalMinutes, 1, 10_080, 360)
    const jitterSeconds = clamp(config.jitterSeconds, 0, 3_600, 300)

    const core = new UpdateCheckCore({
      identity,
      fetchCatalog: channel => fetchCatalog(channel),
      readDismissed: () => readDismissedVersion(dismissedPath),
      writeDismissed: version => { writeDismissedVersion(dismissedPath, version) },
      onFailure: message => { ctx.logger.debug(`enpoi-update-check: ${message}`) },
    })

    // The status surface exists even when checks are disabled, so the operator
    // can still read the last result and call checkNow explicitly.
    ctx.plugin(UpdateCheckService, { core })

    if (config.enabled !== false) {
      const stop = startUpdateCheckSchedule({
        run: () => { void core.checkNow() },
        intervalMs: intervalMinutes * 60_000,
        jitterMs: jitterSeconds * 1000,
      })
      ctx.effect(() => stop, 'enpoi-update-check.schedule')
    }

    const mounted = `enpoi-update-check mounted (home=${home} channel=${identity.channel} version=${identity.version === '' ? 'unknown' : identity.version} interval=${intervalMinutes}m checks=${config.enabled === false ? 'off' : 'on'})`
    process.stderr.write(`[enpoi-update-check] ${mounted}\n`)
    ctx.logger.info(`enpoi-update-check: ${mounted}`)
  } catch (error) {
    process.stderr.write(`[enpoi-update-check] disabled — ${errorText(error)}\n`)
  }
}

export {
  CATALOG_FETCH_TIMEOUT_MS,
  CATALOG_RAW_BASE_URL,
  CATALOG_SCHEMA_VERSION,
  catalogUrl,
  compareVersions,
  fetchCatalog,
  parseCatalogDocument,
  readInstallIdentity,
  type CatalogEntry,
  type InstallIdentity,
} from './catalog.js'
export { UPDATE_CHECK_NAMESPACE, UpdateCheckService, type DismissRequest, type UpdateCheckServiceOptions } from './remote.js'
export {
  FIRST_CHECK_DELAY_MS,
  jitteredDelay,
  startUpdateCheckSchedule,
  UpdateCheckCore,
  type UpdateCheckCoreOptions,
  type UpdateCheckLatest,
  type UpdateCheckScheduleOptions,
  type UpdateCheckState,
  type UpdateCheckStatus,
  type UpdateCheckTimers,
} from './service.js'
export { readDismissedVersion, writeDismissedVersion, type DismissedRecord } from './store.js'
