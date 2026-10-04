/**
 * enpoi-diagnostics — the `diagnostics_report` agent tool (doc 68 §L3).
 *
 * The Creator/orchestrator asks for the top patterns with evidence and gets a
 * deterministic fold back: no model runs in this path. The tool is fail-open —
 * a store failure returns an empty report with `ok: false` instead of throwing
 * into the turn.
 *
 * @module dsh-enpoi-diagnostics/tools
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: loads the `tools` property augmentation on Context.
import type {} from '@deepseek-ai/dsh-tools'
import type { IncidentBus } from './capture.js'
import { buildReport, DEFAULT_DEGRADE_WINDOW_MS } from './report.js'
import { truncate, WINDOWS, type IncidentStore, type Window } from './store.js'

/** Registered tool name. */
export const DIAGNOSTICS_TOOL_NAME = 'diagnostics_report'

/** Tool dependencies. */
export interface DiagnosticsToolOptions {
  readonly store: IncidentStore
  readonly bus: IncidentBus
  readonly degradeWindowMs?: number
  readonly now?: () => number
}

const MAX_LIMIT = 25

/**
 * Register the `diagnostics_report` tool on the tools service.
 *
 * @param ctx - context that provides `tools`.
 * @param options - store, bus, and test seams.
 */
export function registerDiagnosticsTool(ctx: Context, options: DiagnosticsToolOptions): void {
  const now = options.now ?? Date.now
  const degradeWindowMs = options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS

  ctx.tools.register({
    name: DIAGNOSTICS_TOOL_NAME,
    description: [
      'Report honestly about the harness incident store: top error patterns with evidence (stable code,',
      'fingerprint, counts, sample message, last seen), the recent incident tail, a per-source breakdown,',
      'and degraded subsystems (providers, tools, plugin loads, compaction, client). Deterministic — no',
      'model in the detection path. Use it to investigate "something is failing and I cannot see it".',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: [...WINDOWS], description: 'Sliding window for pattern counts (default 24h).' },
        limit: { type: 'number', description: `Max patterns/incidents returned (default 10, max ${MAX_LIMIT}).` },
        includeLogs: { type: 'boolean', description: 'Include error-level log lines in the degraded fold (default true).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          window: { type: 'string' },
          status: { type: 'string' },
          summary: { type: 'string' },
          patterns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fingerprint: { type: 'string' },
                code: { type: 'string' },
                kind: { type: 'string' },
                severity: { type: 'string' },
                count: { type: 'number' },
                windowCount: { type: 'number' },
                lastSeen: { type: 'number' },
                sample: { type: 'string' },
              },
              required: ['fingerprint', 'code', 'kind', 'severity', 'count', 'windowCount', 'lastSeen', 'sample'],
            },
          },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'number' },
                severity: { type: 'string' },
                source: { type: 'string' },
                kind: { type: 'string' },
                code: { type: 'string' },
                message: { type: 'string' },
                count: { type: 'number' },
                sessionId: { type: 'string' },
              },
              required: ['at', 'severity', 'source', 'kind', 'code', 'message', 'count', 'sessionId'],
            },
          },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string' },
                count: { type: 'number' },
                lastSeen: { type: 'number' },
              },
              required: ['source', 'count', 'lastSeen'],
            },
          },
          degraded: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                subsystem: { type: 'string' },
                reason: { type: 'string' },
                count: { type: 'number' },
                lastSeen: { type: 'number' },
              },
              required: ['subsystem', 'reason', 'count', 'lastSeen'],
            },
          },
        },
        required: ['ok', 'window', 'status', 'summary', 'patterns', 'recent', 'sources', 'degraded'],
      },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown): Promise<unknown> {
      const request = (args ?? {}) as { window?: unknown; limit?: unknown; includeLogs?: unknown }
      const window: Window = typeof request.window === 'string' && (WINDOWS as readonly string[]).includes(request.window)
        ? (request.window as Window)
        : '24h'
      const limit = Number.isFinite(Number(request.limit))
        ? Math.min(Math.max(1, Math.trunc(Number(request.limit))), MAX_LIMIT)
        : 10
      try {
        options.bus.flushNow()
        const report = buildReport(options.store, options.bus.stats(), {
          window,
          limit,
          includeLogs: request.includeLogs !== false,
          degradeWindowMs,
          now: options.now ?? Date.now,
        })
        return {
          ok: report.ok,
          window: report.window,
          status: report.status,
          summary: report.summary,
          patterns: report.patterns.map(pattern => ({
            fingerprint: pattern.fingerprint,
            code: pattern.code,
            kind: pattern.kind,
            severity: pattern.severity,
            count: pattern.count,
            windowCount: pattern.windowCount,
            lastSeen: pattern.lastSeen,
            sample: pattern.sample,
          })),
          recent: report.recent.map(incident => ({
            at: incident.at,
            severity: incident.severity,
            source: incident.source,
            kind: incident.kind,
            code: incident.code,
            message: incident.message,
            count: incident.count,
            sessionId: incident.sessionId ?? '',
          })),
          sources: report.sources.map(source => ({ source: source.source, count: source.count, lastSeen: source.lastSeen })),
          degraded: report.degraded.map(entry => ({
            subsystem: entry.subsystem,
            reason: entry.reason,
            count: entry.count,
            lastSeen: entry.lastSeen,
          })),
        }
      } catch (error) {
        return {
          ok: false,
          window,
          status: 'unknown',
          summary: `diagnostics_report could not read the store: ${truncate(errorText(error), 200)}`,
          patterns: [],
          recent: [],
          sources: [],
          degraded: [],
        }
      }
    },
  })
}

function renderReport(value: unknown): string {
  const report = value as {
    ok?: boolean
    window?: string
    status?: string
    summary?: string
    patterns?: Array<{ code: string; count: number; sample: string }>
    degraded?: Array<{ subsystem: string; reason: string; count: number }>
  }
  const lines: string[] = []
  lines.push(`diagnostics (${report.window ?? '?'}): ${report.status ?? 'unknown'} — ${report.summary ?? ''}`)
  for (const pattern of report.patterns ?? []) {
    lines.push(`• ${pattern.code} ×${pattern.count} — ${pattern.sample.slice(0, 160)}`)
  }
  for (const entry of report.degraded ?? []) {
    lines.push(`⚠ ${entry.subsystem}: ${entry.reason} (${entry.count} in window)`)
  }
  return lines.join('\n')
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
