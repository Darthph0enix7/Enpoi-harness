/**
 * enpoi-diagnostics — the incident store (doc 68 §L1 store, §L2 rollups).
 *
 * One SQLite file under `$DSH_HOME/diagnostics/incidents.sqlite` holds:
 * - `incidents`: one row per failure occurrence, aggregated inside a cooldown
 *   bucket (the same fingerprint inside `cooldownMs` bumps `count` on the open
 *   row instead of inserting a twin — that is the high-frequency aggregation
 *   rule). Row `at` is the bucket start; the newest occurrence of a bucket is
 *   within `cooldownMs` of it by construction.
 * - `patterns`: the deterministic rollup (`first_seen`, `last_seen`, `count`,
 *   `sample_message`, `sources`, `severity_max`, `upgraded_at`) plus the mute
 *   bookkeeping (`muted_at`). Sliding windows are computed at query time from
 *   `incidents`, never stored as extra tables.
 *
 * Bounds: `maxIncidents` rows (default 5000) and `maxPatterns` (default 2000);
 * every flush evicts the oldest rows first (`ORDER BY id ASC`) and the
 * least-recently-seen non-muted patterns first. WAL + a busy timeout make a
 * second reader (or a future second connection) safe.
 *
 * @module dsh-enpoi-diagnostics/store
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fingerprintMessage } from './fingerprint.js'
import type { StatementSync } from 'node:sqlite'

/** Ordered severities; index is the rank used for `severity_max`. */
export const SEVERITIES = ['debug', 'info', 'warn', 'error', 'fatal'] as const
/** One incident severity. */
export type Severity = (typeof SEVERITIES)[number]

/** Sliding windows served at query time (never persisted). */
export const WINDOWS = ['1h', '24h', '7d', 'all'] as const
/** One query window. */
export type Window = (typeof WINDOWS)[number]

const WINDOW_MS: Record<Exclude<Window, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
}

/** Rank a severity for max-upgrade comparisons. */
export function severityRank(severity: Severity): number {
  const rank = SEVERITIES.indexOf(severity)
  return rank < 0 ? 0 : rank
}

/** Coerce arbitrary input to a known severity (unknown → `error`, the safe default). */
export function normalizeSeverity(value: unknown): Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : 'error'
}

/** One capture-side incident, before it reaches an incident row. */
export interface IncidentInput {
  /** Occurrence time in milliseconds; defaults to the store clock. */
  readonly at?: number
  readonly severity: Severity
  /** Producing subsystem: `log:<logger>`, `session`, `plugin`, `client`, `diagnostics`. */
  readonly source: string
  /** Failure class: `log`, `provider-error`, `tool-error`, `turn-error`, `plugin-failed`, `client-report`, … */
  readonly kind: string
  /** Stable machine code (logger level, failure code, plugin marker). */
  readonly code: string
  /** Fingerprint from {@link import('./fingerprint').fingerprintMessage}. */
  readonly fingerprint: string
  /** Human-readable message; stored truncated to {@link MAX_MESSAGE_CHARS}. */
  readonly message: string
  readonly context?: Record<string, unknown>
  readonly sessionId?: string
  readonly provider?: string
  readonly model?: string
}

/** A stored `incidents` row. */
export interface StoredIncident {
  readonly id: number
  readonly at: number
  readonly severity: Severity
  readonly source: string
  readonly kind: string
  readonly code: string
  readonly fingerprint: string
  readonly message: string
  readonly context: Record<string, unknown>
  readonly sessionId: string | null
  readonly provider: string | null
  readonly model: string | null
  readonly count: number
}

/** A pattern rollup as returned by queries, with its window count resolved. */
export interface PatternRow {
  readonly fingerprint: string
  readonly code: string
  readonly kind: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly count: number
  readonly windowCount: number
  readonly sampleMessage: string
  readonly sources: readonly string[]
  readonly severityMax: Severity
  readonly upgradedAt: number | null
  readonly muted: boolean
}

/** Query options for {@link IncidentStore.patterns}. */
export interface PatternQuery {
  readonly window?: Window
  readonly limit?: number
  readonly minCount?: number
  readonly includeMuted?: boolean
  readonly kind?: string
}

/** Query options for {@link IncidentStore.incidents}. */
export interface IncidentQuery {
  readonly limit?: number
  readonly since?: number
  readonly severity?: Severity | 'all'
  readonly source?: string
  readonly kind?: string
  readonly fingerprint?: string
  readonly includeMuted?: boolean
}

/** Aggregated counts used by surfaces. */
export interface StoreStats {
  readonly path: string
  readonly incidents: number
  readonly patterns: number
  readonly muted: number
  readonly maxIncidents: number
  readonly maxPatterns: number
  readonly cooldownMs: number
}

/** One per-source breakdown row. */
export interface SourceRow {
  readonly source: string
  readonly count: number
  readonly lastSeen: number
}

/** Store construction options. */
export interface StoreOptions {
  readonly maxIncidents?: number
  readonly maxPatterns?: number
  readonly cooldownMs?: number
  /** Injectable clock for tests. */
  readonly now?: () => number
}

/** Message text stored per incident (and per pattern sample). */
export const MAX_MESSAGE_CHARS = 500
/** Serialized context stored per incident. */
const MAX_CONTEXT_CHARS = 2000
/** Distinct sources retained per pattern. */
const MAX_PATTERN_SOURCES = 8

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT,
  provider TEXT,
  model TEXT,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS incidents_fingerprint_at ON incidents(fingerprint, at);
CREATE INDEX IF NOT EXISTS incidents_at ON incidents(at);
CREATE INDEX IF NOT EXISTS incidents_source ON incidents(source);

CREATE TABLE IF NOT EXISTS patterns (
  fingerprint TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sample_message TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  severity_max TEXT NOT NULL,
  upgraded_at INTEGER,
  code TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  muted_at INTEGER
);
CREATE INDEX IF NOT EXISTS patterns_last_seen ON patterns(last_seen);
`

interface PatternDbRow {
  fingerprint: string
  first_seen: number
  last_seen: number
  count: number
  sample_message: string
  sources: string
  severity_max: string
  upgraded_at: number | null
  code: string
  kind: string
  muted_at: number | null
}

interface IncidentDbRow {
  id: number
  at: number
  severity: string
  source: string
  kind: string
  code: string
  fingerprint: string
  message: string
  context_json: string
  session_id: string | null
  provider: string | null
  model: string | null
  count: number
}

/** Truncate one string to `max` characters (never throws). */
export function truncate(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : safeText(value)
  return text.length > max ? text.slice(0, max) : text
}

/** Stringify values without ever throwing (cycles, getters, bigints). */
export function safeText(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const kind = typeof value
  if (kind === 'string') return value as string
  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value)
  if (kind === 'symbol') return (value as symbol).toString()
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // fall through to toString
  }
  try {
    return Object.prototype.toString.call(value)
  } catch {
    return '[unprintable]'
  }
}

/** Parse a stored context document, returning `{}` for corrupt rows. */
export function parseContext(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Serialize and bound one context payload. */
function serializeContext(context: Record<string, unknown> | undefined): string {
  try {
    const json = JSON.stringify(context ?? {})
    return json.length > MAX_CONTEXT_CHARS ? `${json.slice(0, MAX_CONTEXT_CHARS - 12)}…"}` : json
  } catch {
    return '{}'
  }
}

/**
 * The incident store. One instance owns one SQLite file and one synchronous
 * connection; every writer in the process goes through it.
 */
export class IncidentStore {
  /** Resolved database path (the surface reports it verbatim). */
  readonly path: string
  private readonly db: DatabaseSync
  private readonly maxIncidents: number
  private readonly maxPatterns: number
  private readonly cooldownMs: number
  private readonly now: () => number
  /** Open cooldown buckets by fingerprint: the row that a repeat bumps. */
  private readonly buckets = new Map<string, { id: number; at: number }>()
  private closed = false

  private readonly selectPattern: StatementSync
  private readonly insertPattern: StatementSync
  private readonly updatePattern: StatementSync
  private readonly selectIncidentTail: StatementSync
  private readonly insertIncident: StatementSync
  private readonly bumpIncident: StatementSync
  private readonly countIncidents: StatementSync
  private readonly countPatterns: StatementSync

  /**
   * @param path - absolute SQLite path; missing parent directories are created.
   * @param options - caps, cooldown, and an optional test clock.
   */
  constructor(path: string, options: StoreOptions = {}) {
    this.path = path
    this.maxIncidents = Math.max(1, Math.trunc(options.maxIncidents ?? 5000))
    this.maxPatterns = Math.max(1, Math.trunc(options.maxPatterns ?? 2000))
    this.cooldownMs = Math.max(0, Math.trunc(options.cooldownMs ?? 300_000))
    this.now = options.now ?? Date.now
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL;')
    this.db.exec('PRAGMA busy_timeout=3000;')
    this.db.exec(SCHEMA)
    this.selectPattern = this.db.prepare('SELECT * FROM patterns WHERE fingerprint = ?')
    this.insertPattern = this.db.prepare(
      'INSERT INTO patterns (fingerprint, first_seen, last_seen, count, sample_message, sources, severity_max, upgraded_at, code, kind)'
      + ' VALUES (?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)',
    )
    this.updatePattern = this.db.prepare(
      'UPDATE patterns SET first_seen = ?, last_seen = ?, count = ?, sample_message = ?, sources = ?, severity_max = ?, upgraded_at = ? WHERE fingerprint = ?',
    )
    this.selectIncidentTail = this.db.prepare('SELECT id, at FROM incidents WHERE fingerprint = ? ORDER BY id DESC LIMIT 1')
    this.insertIncident = this.db.prepare(
      'INSERT INTO incidents (at, severity, source, kind, code, fingerprint, message, context_json, session_id, provider, model, count)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
    )
    this.bumpIncident = this.db.prepare('UPDATE incidents SET count = count + 1 WHERE id = ?')
    this.countIncidents = this.db.prepare('SELECT COUNT(*) AS n FROM incidents')
    this.countPatterns = this.db.prepare('SELECT COUNT(*) AS n FROM patterns')
  }

  /** Whether the store is still open (a closed store rejects writes). */
  get isOpen(): boolean {
    return !this.closed
  }

  /**
   * Record one incident: upsert the pattern rollup, then either bump the open
   * cooldown bucket's row or open a new one.
   *
   * @param input - the incident to store.
   * @returns the fingerprint, code, and whether the row was aggregated.
   */
  record(input: IncidentInput): { fingerprint: string; code: string; aggregated: boolean } {
    if (this.closed) throw new Error('diagnostics store is closed')
    const at = input.at ?? this.now()
    const severity = normalizeSeverity(input.severity)
    const message = truncate(input.message, MAX_MESSAGE_CHARS)
    const code = truncate(input.code, 60) || severity.toUpperCase()
    const kind = truncate(input.kind, 60) || 'unknown'
    // A missing fingerprint would collapse every incident into one pattern;
    // derive one from the message instead of failing the capture.
    const fingerprint = truncate(input.fingerprint, 64) || fingerprintMessage(kind, message).fingerprint
    const source = truncate(input.source, 120) || 'unknown'

    this.db.exec('BEGIN IMMEDIATE')
    let aggregated = false
    try {
      this.upsertPattern({ at, severity, source, kind, code, fingerprint, message })
      const open = this.buckets.get(fingerprint) ?? this.tailBucket(fingerprint)
      // Aggregate only into the same, not-yet-expired bucket: an occurrence
      // older than the bucket head (out-of-order capture, clock step) opens its
      // own row rather than silently inflating a later bucket.
      if (open !== undefined && at >= open.at && at - open.at < this.cooldownMs) {
        this.bumpIncident.run(open.id)
        this.buckets.set(fingerprint, open)
        aggregated = true
      } else {
        const info = this.insertIncident.run(
          at,
          severity,
          source,
          kind,
          code,
          fingerprint,
          message,
          serializeContext(input.context),
          input.sessionId ?? null,
          input.provider ?? null,
          input.model ?? null,
        )
        this.buckets.set(fingerprint, { id: Number(info.lastInsertRowid), at })
      }
      this.enforceCaps()
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A failed rollback must not mask the original failure.
      }
      throw error
    }
    return { fingerprint, code, aggregated }
  }

  /** Record a batch in one transaction (the queue flush path). */
  recordMany(inputs: readonly IncidentInput[]): number {
    let stored = 0
    for (const input of inputs) {
      this.record(input)
      stored += 1
    }
    return stored
  }

  /** Read pattern rollups ordered by most recent activity. */
  patterns(query: PatternQuery = {}): PatternRow[] {
    if (this.closed) return []
    const window = query.window ?? 'all'
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 500)
    const minCount = Math.max(1, Math.trunc(query.minCount ?? 1))
    const since = window === 'all' ? Number.MIN_SAFE_INTEGER : this.now() - WINDOW_MS[window]
    const rows = this.db.prepare(
      `SELECT p.*, COALESCE((SELECT SUM(i.count) FROM incidents i WHERE i.fingerprint = p.fingerprint AND i.at >= ?), 0) AS window_count
       FROM patterns p
       WHERE (? = 1 OR p.muted_at IS NULL)
         AND p.count >= ?
         AND (? IS NULL OR p.kind = ?)
       ORDER BY p.last_seen DESC
       LIMIT ?`,
    ).all(since, query.includeMuted === true ? 1 : 0, minCount, query.kind ?? null, query.kind ?? null, limit) as unknown as Array<PatternDbRow & { window_count: number }>
    return rows.map(row => this.toPatternRow(row, row.window_count))
  }

  /** Read recent incident rows ordered by insertion (newest first). */
  incidents(query: IncidentQuery = {}): StoredIncident[] {
    if (this.closed) return []
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), 500)
    const clauses: string[] = []
    const args: Array<string | number> = []
    if (query.since !== undefined) {
      clauses.push('i.at >= ?')
      args.push(Math.trunc(query.since))
    }
    if (query.severity !== undefined && query.severity !== 'all') {
      clauses.push('i.severity = ?')
      args.push(normalizeSeverity(query.severity))
    }
    if (query.source !== undefined) {
      clauses.push('i.source = ?')
      args.push(truncate(query.source, 120))
    }
    if (query.kind !== undefined) {
      clauses.push('i.kind = ?')
      args.push(truncate(query.kind, 60))
    }
    if (query.fingerprint !== undefined) {
      clauses.push('i.fingerprint = ?')
      args.push(truncate(query.fingerprint, 64))
    }
    if (query.includeMuted !== true) {
      clauses.push('i.fingerprint NOT IN (SELECT fingerprint FROM patterns WHERE muted_at IS NOT NULL)')
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT i.* FROM incidents i ${where} ORDER BY i.id DESC LIMIT ?`,
    ).all(...args, limit) as unknown as IncidentDbRow[]
    return rows.map(row => this.toIncidentRow(row))
  }

  /** Per-source occurrence breakdown for the operator report. */
  sources(limit = 20): SourceRow[] {
    if (this.closed) return []
    const rows = this.db.prepare(
      'SELECT source, SUM(count) AS count, MAX(at) AS last_seen FROM incidents GROUP BY source ORDER BY count DESC LIMIT ?',
    ).all(Math.min(Math.max(1, Math.trunc(limit)), 100)) as unknown as Array<{ source: string; count: number; last_seen: number }>
    return rows.map(row => ({ source: row.source, count: row.count, lastSeen: row.last_seen }))
  }

  /** Mute or unmute one pattern. Returns the resulting state (unknown fingerprints stay unmuted). */
  mute(fingerprint: string, muted = true): { ok: boolean; muted: boolean; note?: string } {
    if (this.closed) return { ok: false, muted: false, note: 'store closed' }
    const key = truncate(fingerprint, 64)
    const result = this.db.prepare('UPDATE patterns SET muted_at = ? WHERE fingerprint = ?')
      .run(muted ? this.now() : null, key)
    if (result.changes === 0) return { ok: false, muted: false, note: 'unknown fingerprint' }
    return { ok: true, muted }
  }

  /** Store counters for surfaces. */
  stats(): StoreStats {
    if (this.closed) {
      return { path: this.path, incidents: 0, patterns: 0, muted: 0, maxIncidents: this.maxIncidents, maxPatterns: this.maxPatterns, cooldownMs: this.cooldownMs }
    }
    const incidents = Number((this.countIncidents.get() as { n: number } | undefined)?.n ?? 0)
    const patterns = Number((this.countPatterns.get() as { n: number } | undefined)?.n ?? 0)
    const muted = Number((this.db.prepare('SELECT COUNT(*) AS n FROM patterns WHERE muted_at IS NOT NULL').get() as { n: number } | undefined)?.n ?? 0)
    return { path: this.path, incidents, patterns, muted, maxIncidents: this.maxIncidents, maxPatterns: this.maxPatterns, cooldownMs: this.cooldownMs }
  }

  /** Close the connection; further writes throw and reads return empty. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.buckets.clear()
    try {
      this.db.close()
    } catch {
      // A close failure must never surface into the harness.
    }
  }

  /** Read-modify-write one pattern row inside the caller's transaction. */
  private upsertPattern(input: {
    at: number
    severity: Severity
    source: string
    kind: string
    code: string
    fingerprint: string
    message: string
  }): void {
    const previous = this.selectPattern.get(input.fingerprint) as unknown as PatternDbRow | undefined
    if (previous === undefined) {
      this.insertPattern.run(
        input.fingerprint,
        input.at,
        input.at,
        input.message,
        JSON.stringify([input.source]),
        input.severity,
        input.code,
        input.kind,
      )
      return
    }
    const sources = new Set<string>()
    try {
      const parsed: unknown = JSON.parse(previous.sources)
      if (Array.isArray(parsed)) for (const entry of parsed) if (typeof entry === 'string') sources.add(entry)
    } catch {
      // Corrupt sources JSON stays empty; the live source is re-added below.
    }
    sources.add(input.source)
    const severityMax = severityRank(input.severity) > severityRank(normalizeSeverity(previous.severity_max))
      ? input.severity
      : normalizeSeverity(previous.severity_max)
    const upgradedAt = severityMax !== normalizeSeverity(previous.severity_max) ? input.at : previous.upgraded_at
    this.updatePattern.run(
      Math.min(previous.first_seen, input.at),
      Math.max(previous.last_seen, input.at),
      previous.count + 1,
      previous.sample_message === '' ? input.message : previous.sample_message,
      JSON.stringify([...sources].slice(-MAX_PATTERN_SOURCES)),
      severityMax,
      upgradedAt,
      input.fingerprint,
    )
  }

  /** Resolve a fingerprint's open bucket from disk (after a restart). */
  private tailBucket(fingerprint: string): { id: number; at: number } | undefined {
    const row = this.selectIncidentTail.get(fingerprint) as unknown as { id: number; at: number } | undefined
    return row === undefined ? undefined : { id: row.id, at: row.at }
  }

  /** Evict the oldest incident rows and least-recently-seen patterns past their caps. */
  private enforceCaps(): void {
    const incidentCount = Number((this.countIncidents.get() as { n: number } | undefined)?.n ?? 0)
    if (incidentCount > this.maxIncidents) {
      this.db.prepare(
        'DELETE FROM incidents WHERE id IN (SELECT id FROM incidents ORDER BY id ASC LIMIT ?)',
      ).run(incidentCount - this.maxIncidents)
    }
    const patternCount = Number((this.countPatterns.get() as { n: number } | undefined)?.n ?? 0)
    if (patternCount > this.maxPatterns) {
      this.db.prepare(
        'DELETE FROM patterns WHERE fingerprint IN (SELECT fingerprint FROM patterns WHERE muted_at IS NULL ORDER BY last_seen ASC LIMIT ?)',
      ).run(patternCount - this.maxPatterns)
    }
    if (this.buckets.size > this.maxPatterns * 2) this.buckets.clear()
  }

  private toPatternRow(row: PatternDbRow, windowCount: number): PatternRow {
    let sources: string[] = []
    try {
      const parsed: unknown = JSON.parse(row.sources)
      if (Array.isArray(parsed)) sources = parsed.filter((entry): entry is string => typeof entry === 'string')
    } catch {
      sources = []
    }
    return {
      fingerprint: row.fingerprint,
      code: row.code,
      kind: row.kind,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      count: row.count,
      windowCount,
      sampleMessage: row.sample_message,
      sources,
      severityMax: normalizeSeverity(row.severity_max),
      upgradedAt: row.upgraded_at ?? null,
      muted: row.muted_at !== null,
    }
  }

  private toIncidentRow(row: IncidentDbRow): StoredIncident {
    return {
      id: row.id,
      at: row.at,
      severity: normalizeSeverity(row.severity),
      source: row.source,
      kind: row.kind,
      code: row.code,
      fingerprint: row.fingerprint,
      message: row.message,
      context: parseContext(row.context_json),
      sessionId: row.session_id,
      provider: row.provider,
      model: row.model,
      count: row.count,
    }
  }
}
