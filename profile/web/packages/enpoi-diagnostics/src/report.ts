/**
 * enpoi-diagnostics — shared report projection (doc 68 §L3 agent + operator surfaces).
 *
 * One deterministic fold over the incident store backs every surface (the
 * `diagnostics_report` tool, `diagnostics.list`/`patterns`/`systemHealth`
 * RPCs): top patterns, the recent incident tail, a per-source breakdown, and
 * the degraded-subsystem list. No model, no I/O beyond local SQLite.
 *
 * @module dsh-enpoi-diagnostics/report
 */

import type { CaptureStats } from './capture.js'
import type { IncidentStore, Severity, StoreStats, Window } from './store.js'

/** One degraded-subsystem signal. */
export interface DegradedSubsystem {
  readonly subsystem: string
  readonly reason: string
  readonly count: number
  readonly lastSeen: number
  readonly fingerprint: string
}

/** One pattern in a report. */
export interface ReportPattern {
  readonly fingerprint: string
  readonly code: string
  readonly kind: string
  readonly severity: Severity
  readonly count: number
  readonly windowCount: number
  readonly firstSeen: number
  readonly lastSeen: number
  readonly sample: string
  readonly sources: readonly string[]
  readonly muted: boolean
}

/** One recent incident in a report. */
export interface ReportIncident {
  readonly id: number
  readonly at: number
  readonly severity: Severity
  readonly source: string
  readonly kind: string
  readonly code: string
  readonly fingerprint: string
  readonly message: string
  readonly count: number
  readonly sessionId: string | null
}

/** The complete report returned to tools and RPCs. */
export interface DiagnosticsReport {
  readonly ok: boolean
  readonly generatedAt: number
  readonly window: Window
  readonly status: 'ok' | 'degraded'
  readonly summary: string
  readonly patterns: readonly ReportPattern[]
  readonly recent: readonly ReportIncident[]
  readonly sources: ReadonlyArray<{ source: string; count: number; lastSeen: number }>
  readonly degraded: readonly DegradedSubsystem[]
  readonly store: StoreStats
  readonly capture: CaptureStats
}

/** Degradation window: an error kind seen inside this window degrades its subsystem. */
export const DEFAULT_DEGRADE_WINDOW_MS = 900_000

/** Kind → subsystem mapping for the degraded-subsystem fold. */
const KIND_SUBSYSTEM: Readonly<Record<string, { subsystem: string; reason: string }>> = {
  'provider-error': { subsystem: 'providers', reason: 'provider errors (retryable failures) are being recorded' },
  'turn-error': { subsystem: 'agent-loop', reason: 'turns are ending with structured failures' },
  'tool-error': { subsystem: 'tools', reason: 'tool calls are returning errors' },
  'plugin-failed': { subsystem: 'plugin-load', reason: 'a plugin fiber failed to activate' },
  'compaction-error': { subsystem: 'compaction', reason: 'compaction runs are failing' },
  'client-report': { subsystem: 'client', reason: 'the client reported errors the host never saw' },
  'diagnostics-self': { subsystem: 'diagnostics', reason: 'diagnostics itself swallowed a failure' },
  'log': { subsystem: 'logs', reason: 'error-level log lines are flowing' },
}

/** Report construction options. */
export interface ReportOptions {
  readonly window?: Window
  readonly limit?: number
  readonly includeLogs?: boolean
  readonly degradeWindowMs?: number
  readonly now?: () => number
}

/**
 * Fold the store into one report.
 *
 * @param store - the incident store.
 * @param capture - capture counters.
 * @param options - window, limits, and the degradation window.
 * @returns the report; never throws on store contents.
 */
export function buildReport(store: IncidentStore, capture: CaptureStats, options: ReportOptions = {}): DiagnosticsReport {
  const now = (options.now ?? Date.now)()
  const window = options.window ?? '24h'
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 10)), 100)
  const degradeWindowMs = Math.max(0, Math.trunc(options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS))
  const since = now - degradeWindowMs

  let patterns: ReportPattern[] = []
  let recent: ReportIncident[] = []
  let sources: Array<{ source: string; count: number; lastSeen: number }> = []
  let storeStats: StoreStats
  let storeReadFailed = false
  try {
    // A closed store answers empty, which would read as "healthy"; treat it as
    // a failed read so the report says so.
    if (!store.isOpen) throw new Error('diagnostics store is not open')
    patterns = store.patterns({ window, limit, includeMuted: false }).map(row => ({
      fingerprint: row.fingerprint,
      code: row.code,
      kind: row.kind,
      severity: row.severityMax,
      count: row.count,
      windowCount: row.windowCount,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      sample: row.sampleMessage,
      sources: row.sources,
      muted: row.muted,
    }))
    recent = store.incidents({ limit: Math.min(limit * 3, 100) }).map(row => ({
      id: row.id,
      at: row.at,
      severity: row.severity,
      source: row.source,
      kind: row.kind,
      code: row.code,
      fingerprint: row.fingerprint,
      message: row.message,
      count: row.count,
      sessionId: row.sessionId,
    }))
    sources = store.sources(20)
    storeStats = store.stats()
  } catch {
    storeReadFailed = true
    storeStats = {
      path: store.path,
      incidents: 0,
      patterns: 0,
      muted: 0,
      maxIncidents: 0,
      maxPatterns: 0,
      cooldownMs: 0,
    }
  }

  const degraded: DegradedSubsystem[] = []
  if (storeReadFailed) {
    degraded.push({
      subsystem: 'diagnostics',
      reason: 'the incident store could not be read; results are incomplete',
      count: 1,
      lastSeen: now,
      fingerprint: '',
    })
  }
  if (capture.selfFailures > 0) {
    degraded.push({
      subsystem: 'diagnostics',
      reason: `diagnostics swallowed ${capture.selfFailures} internal failure(s); capture may be incomplete`,
      count: capture.selfFailures,
      lastSeen: now,
      fingerprint: '',
    })
  }
  try {
    // Re-read muted state so a muted pattern never reads as degraded.
    const all = store.patterns({ window: 'all', limit: 200, includeMuted: false })
    const grouped = new Map<string, DegradedSubsystem>()
    for (const row of all) {
      if (row.lastSeen < since) continue
      const mapping = KIND_SUBSYSTEM[row.kind]
      if (mapping === undefined) continue
      if (row.kind === 'log') {
        if (options.includeLogs === false) continue
        if (row.severityMax !== 'error' && row.severityMax !== 'fatal') continue
      }
      if (row.kind === 'turn-error') continue // provider/agent-loop failures are already explicit patterns
      const windowCount = row.count
      const current = grouped.get(mapping.subsystem)
      const count = (current?.count ?? 0) + windowCount
      grouped.set(mapping.subsystem, {
        subsystem: mapping.subsystem,
        reason: mapping.reason,
        count,
        lastSeen: Math.max(current?.lastSeen ?? 0, row.lastSeen),
        fingerprint: current?.fingerprint !== undefined && current.fingerprint !== '' ? current.fingerprint : row.fingerprint,
      })
    }
    degraded.push(...[...grouped.values()].sort((a, b) => b.lastSeen - a.lastSeen || b.count - a.count))
  } catch {
    // A degraded fold failure leaves the explicit report intact.
  }

  const summaryParts: string[] = []
  summaryParts.push(`${storeStats.incidents} incident row(s) / ${storeStats.patterns} pattern(s)`)
  if (patterns.length > 0) {
    const top = patterns[0]
    summaryParts.push(`top: ${top.code} ×${top.count} (${top.sample.slice(0, 90)})`)
  } else {
    summaryParts.push('no patterns recorded')
  }
  if (degraded.length > 0) summaryParts.push(`degraded: ${degraded.map(entry => entry.subsystem).join(', ')}`)
  if (capture.selfFailures > 0) summaryParts.push(`selfFailures=${capture.selfFailures}`)

  return {
    ok: !storeReadFailed,
    generatedAt: now,
    window,
    status: degraded.length > 0 ? 'degraded' : 'ok',
    summary: summaryParts.join(' · '),
    patterns,
    recent,
    sources,
    degraded,
    store: storeStats,
    capture,
  }
}
