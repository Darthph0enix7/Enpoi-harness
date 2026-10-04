/**
 * enpoi-diagnostics — P1 of the diagnostics design (doc 68 §L1 + §L2):
 * capture + visibility, no UI, no LLM, no remediation.
 *
 * What it owns:
 * - One incident store at `$DSH_HOME/diagnostics/incidents.sqlite` (SQLite via
 *   `node:sqlite`, the same engine enpoi-memory uses), with the incident row
 *   shape and the `patterns` rollup table from the design.
 * - Four capture seams: the persistent logger sink (all levels), plugin
 *   lifecycle failures (`internal/status` FAILED), engine error paths over
 *   `session/event` (provider/tool/turn/compaction), and the client-report RPC.
 * - Deterministic pattern rollups: normalize → hash → stable code, upserted on
 *   every incident; 1h/24h/7d windows are query-time computations.
 * - The `diagnostics_report` tool and the `diagnostics` Typert Remote namespace
 *   (`report`, `list`, `patterns`, `mute`, `systemHealth`).
 *
 * Guarantees (doc 68 principles): never fails closed (every diagnostics failure
 * is swallowed and counted once), rows are bounded (`maxIncidents` /
 * `maxPatterns`, oldest evicted first), high-frequency kinds aggregate inside a
 * cooldown bucket instead of flooding rows, and no prompt content is stored —
 * only bounded formatted log lines and structured error facts.
 *
 * @module dsh-enpoi-diagnostics
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { attachLoggerSink, attachPluginLifecycle, attachSessionEvents, IncidentBus } from './capture.js'
import { fingerprintMessage } from './fingerprint.js'
import { DiagnosticsService } from './remote.js'
import { IncidentStore, normalizeSeverity, type Severity } from './store.js'
import { registerDiagnosticsTool } from './tools.js'

/** Cordis plugin name. */
export const name = 'enpoi-diagnostics'
/** Nothing is required at plugin scope: capture must attach even on a bare tree. */
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
  /** Absolute store path override; defaults to `$DSH_HOME/diagnostics/incidents.sqlite`. */
  dbPath?: Volatile<string>
  /** Incident row cap (oldest rows evicted first). */
  maxIncidents?: Volatile<number>
  /** Pattern cap (least-recently-seen non-muted patterns evicted first). */
  maxPatterns?: Volatile<number>
  /** Occurrences of one fingerprint inside this window collapse into one row. */
  cooldownMs?: Volatile<number>
  /** Queue flush cadence in milliseconds. */
  flushMs?: Volatile<number>
  /** Persist the logger sink (default true). */
  captureLogs?: Volatile<boolean>
  /** Persist session-event error paths (default true). */
  captureSessionEvents?: Volatile<boolean>
  /** Persist plugin activation failures (default true). */
  capturePluginLifecycle?: Volatile<boolean>
  /** Lowest logger severity persisted (default `debug` = every level). */
  minSeverity?: Volatile<Severity>
}

/**
 * Schemastery validator for {@link Config}. Every field is `.volatile()`: the
 * merged settings service derives live forms from this schema and persists
 * edits through the active profile patch without remounting the plugin.
 */
export const Config: Schema<Config> = Schema.object({
  dbPath: live(Schema.string()),
  maxIncidents: live(Schema.number().default(5000)),
  maxPatterns: live(Schema.number().default(2000)),
  cooldownMs: live(Schema.number().default(300_000)),
  flushMs: live(Schema.number().default(250)),
  captureLogs: live(Schema.boolean().default(true)),
  captureSessionEvents: live(Schema.boolean().default(true)),
  capturePluginLifecycle: live(Schema.boolean().default(true)),
  minSeverity: live(Schema.union(['debug', 'info', 'warn', 'error', 'fatal'] as const).default('debug')),
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
 * Mount diagnostics. A failure here disables diagnostics loudly on stderr and
 * returns — it must never take the boot or a sibling plugin down with it.
 *
 * @param ctx - owning context.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  config = plainConfig(config)
  try {
    const homeResolver = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const resolveHome = typeof homeResolver === 'function' ? homeResolver : dshHomePath
    const path = typeof config.dbPath === 'string' && config.dbPath !== ''
      ? config.dbPath
      : resolveHome('diagnostics', 'incidents.sqlite')
    const store = new IncidentStore(path, {
      maxIncidents: clamp(config.maxIncidents, 1, 1_000_000, 5000),
      maxPatterns: clamp(config.maxPatterns, 1, 1_000_000, 2000),
      cooldownMs: clamp(config.cooldownMs, 0, 86_400_000, 300_000),
    })
    const minSeverity = normalizeSeverity(config.minSeverity ?? 'debug')

    // Exactly one self-incident per process, written straight to the store
    // (never through the bus, which is what failed) and never thrown.
    let selfIncidentWritten = false
    const bus = new IncidentBus(store, {
      flushMs: clamp(config.flushMs, 10, 60_000, 250),
      onSelfFailure: () => {
        if (selfIncidentWritten) return
        selfIncidentWritten = true
        try {
          const fingerprinted = fingerprintMessage('diagnostics-self', 'internal failure swallowed')
          store.record({
            severity: 'error',
            source: 'diagnostics',
            kind: 'diagnostics-self',
            code: fingerprinted.code,
            fingerprint: fingerprinted.fingerprint,
            message: 'diagnostics swallowed an internal failure; capture may be incomplete',
          })
        } catch {
          // The store itself is the failure: the in-memory counter is the only signal left.
        }
      },
    })

    // Clean shutdown runs in reverse order: drain the queue, then close the DB.
    ctx.effect(() => () => {
      try {
        bus.dispose()
      } catch {
        // dispose is already total; this guard only protects the disposer chain.
      }
      store.close()
    }, 'enpoi-diagnostics.store')

    if (config.captureLogs !== false) attachLoggerSink(ctx, bus, minSeverity)
    if (config.captureSessionEvents !== false) attachSessionEvents(ctx, bus)
    if (config.capturePluginLifecycle !== false) attachPluginLifecycle(ctx, bus)

    // Operator/agent surfaces. The remote service never blocks a turn; the tool
    // only registers when a tools service is present.
    ctx.plugin(DiagnosticsService, { store, bus })
    ctx.inject(['tools'], (toolsCtx: Context) => {
      registerDiagnosticsTool(toolsCtx, { store, bus })
    })

    // A boot marker is itself evidence: the store path and caps are queryable.
    const mounted = `enpoi-diagnostics mounted (store=${path})`
    const bootPrint = fingerprintMessage('boot', 'enpoi-diagnostics mounted')
    bus.push({
      severity: 'info',
      source: 'diagnostics',
      kind: 'boot',
      code: bootPrint.code,
      fingerprint: bootPrint.fingerprint,
      message: mounted,
      context: { path, minSeverity },
    })

    // Dump line: the plugin's load proof on stderr (the harness logger may
    // route elsewhere), plus one ordinary logger line.
    process.stderr.write(`[enpoi-diagnostics] ${mounted} maxIncidents=${String(config.maxIncidents ?? 5000)} cooldownMs=${String(config.cooldownMs ?? 300_000)}\n`)
    ctx.logger.info(`enpoi-diagnostics: ${mounted}`)
  } catch (error) {
    process.stderr.write(`[enpoi-diagnostics] disabled — ${errorText(error)}\n`)
  }
}

export { IncidentBus } from './capture.js'
export { fingerprintMessage, normalizeMessage, MAX_NORMALIZED_CHARS } from './fingerprint.js'
export { buildReport, DEFAULT_DEGRADE_WINDOW_MS, type DiagnosticsReport } from './report.js'
export { DiagnosticsService, DIAGNOSTICS_NAMESPACE, type DiagnosticsServiceOptions } from './remote.js'
export {
  listIncidentsFrom,
  listPatternsFrom,
  mutePattern,
  submitClientReport,
  systemHealthFrom,
  type ClientReportRequest,
  type SystemHealthValue,
} from './api.js'
export {
  IncidentStore,
  MAX_MESSAGE_CHARS,
  normalizeSeverity,
  SEVERITIES,
  severityRank,
  WINDOWS,
  type IncidentInput,
  type PatternRow,
  type Severity,
  type StoreStats,
  type Window,
} from './store.js'
export { DIAGNOSTICS_TOOL_NAME, registerDiagnosticsTool } from './tools.js'
