/**
 * enpoi-diagnostics — request validation and response folding for the
 * `diagnostics` Remote namespace, kept decorator-free.
 *
 * The Typert Remote service class in `remote.ts` is a thin decorated shell over
 * these functions: standard-decorator syntax is not transformable by the
 * profile's vitest pipeline, so everything test-worthy lives here.
 *
 * @module dsh-enpoi-diagnostics/api
 */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { IncidentBus } from './capture.js'
import { fingerprintMessage } from './fingerprint.js'
import { buildReport, DEFAULT_DEGRADE_WINDOW_MS, type DegradedSubsystem, type ReportPattern } from './report.js'
import { SEVERITIES, truncate, WINDOWS, type IncidentInput, type IncidentStore, type Severity, type StoredIncident, type Window } from './store.js'

/** `diagnostics.report` request: one client-observed failure. */
export interface ClientReportRequest {
  /** Short client classifier, e.g. `window.onerror`, `unhandledrejection`, `rpc-failed`. */
  readonly kind?: unknown
  /** The error text (bounded; never a prompt). */
  readonly message?: unknown
  /** Optional stack (bounded to 1000 chars before storage). */
  readonly stack?: unknown
  /** Optional owning session id. */
  readonly sessionId?: unknown
  /** Optional page/route URL. */
  readonly url?: unknown
}

/** `diagnostics.report` result. */
export interface ClientReportValue {
  readonly ok: true
  readonly fingerprint: string
  readonly code: string
}

/** `diagnostics.list` request. */
export interface ListRequest {
  readonly limit?: unknown
  readonly since?: unknown
  readonly severity?: unknown
  readonly source?: unknown
  readonly kind?: unknown
  readonly fingerprint?: unknown
  readonly includeMuted?: unknown
}

/** `diagnostics.list` result. */
export interface ListValue {
  readonly generatedAt: number
  readonly items: readonly StoredIncident[]
}

/** `diagnostics.patterns` request. */
export interface PatternsRequest {
  readonly window?: unknown
  readonly limit?: unknown
  readonly minCount?: unknown
  readonly includeMuted?: unknown
  readonly kind?: unknown
}

/** `diagnostics.patterns` result. */
export interface PatternsValue {
  readonly window: Window
  readonly generatedAt: number
  readonly items: ReturnType<IncidentStore['patterns']>
}

/** `diagnostics.mute` request. */
export interface MuteRequest {
  readonly fingerprint?: unknown
  readonly muted?: unknown
}

/** `diagnostics.mute` result. */
export interface MuteValue {
  readonly ok: boolean
  readonly muted: boolean
  readonly note?: string
}

/** Compact health projection. */
export interface SystemHealthValue {
  readonly status: 'ok' | 'degraded'
  readonly generatedAt: number
  readonly degraded: readonly DegradedSubsystem[]
  readonly topPatterns: readonly ReportPattern[]
  readonly counts: { readonly incidents: number; readonly patterns: number; readonly muted: number }
  readonly capture: ReturnType<IncidentBus['stats']>
  readonly storePath: string
}

const MAX_KIND_CHARS = 100
const MAX_MESSAGE_CHARS = 4000
const MAX_STACK_CHARS = 1000
const MAX_SESSION_ID_CHARS = 200
const MAX_URL_CHARS = 2000
const KIND_RE = /^[A-Za-z0-9_.:/-]+$/
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{4,64}$/

function badRequest(method: string, detail: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', `diagnostics.${method}: ${detail}`, {})
}

function readKind(method: string, value: unknown): string {
  if (typeof value !== 'string') throw badRequest(method, 'kind must be a string')
  const kind = value.trim()
  if (kind === '') throw badRequest(method, 'kind must not be empty')
  if (kind.length > MAX_KIND_CHARS) throw badRequest(method, `kind must be at most ${MAX_KIND_CHARS} characters`)
  if (!KIND_RE.test(kind)) throw badRequest(method, 'kind must match [A-Za-z0-9_.:/-]+')
  return kind
}

function readMessage(method: string, value: unknown): string {
  if (typeof value !== 'string') throw badRequest(method, 'message must be a string')
  const message = value.trim()
  if (message === '') throw badRequest(method, 'message must not be empty')
  if (message.length > MAX_MESSAGE_CHARS) throw badRequest(method, `message must be at most ${MAX_MESSAGE_CHARS} characters`)
  return message
}

function readOptional(method: string, field: string, value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw badRequest(method, `${field} must be a string when present`)
  if (value.length > max) throw badRequest(method, `${field} must be at most ${max} characters`)
  return value
}

function readLimit(method: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw badRequest(method, 'limit must be a finite number')
  return Math.min(Math.max(1, Math.trunc(numeric)), max)
}

function readWindow(method: string, value: unknown): Window {
  if (value === undefined || value === null) return '24h'
  if (typeof value !== 'string' || !(WINDOWS as readonly string[]).includes(value)) {
    throw badRequest(method, `window must be one of ${WINDOWS.join(', ')}`)
  }
  return value as Window
}

function readSeverity(method: string, value: unknown): Severity | 'all' {
  if (value === undefined || value === null || value === 'all') return 'all'
  if (typeof value !== 'string' || !(SEVERITIES as readonly string[]).includes(value)) {
    throw badRequest(method, `severity must be one of ${SEVERITIES.join(', ')} or all`)
  }
  return value as Severity
}

/** One validated client report. */
export interface ValidatedClientReport {
  readonly kind: string
  readonly message: string
  readonly stack?: string
  readonly sessionId?: string
  readonly url?: string
}

/**
 * Validate one client report payload.
 *
 * @param request - raw wire payload.
 * @returns the validated fields.
 * @throws RemoteError `gateway/bad-request` for malformed input.
 */
export function validateClientReport(request: ClientReportRequest | undefined): ValidatedClientReport {
  const source = request ?? {}
  const kind = readKind('report', source.kind)
  const message = readMessage('report', source.message)
  const stack = readOptional('report', 'stack', source.stack, MAX_STACK_CHARS)
  const sessionId = readOptional('report', 'sessionId', source.sessionId, MAX_SESSION_ID_CHARS)
  const url = readOptional('report', 'url', source.url, MAX_URL_CHARS)
  return {
    kind,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(url === undefined ? {} : { url }),
  }
}

/** Build the incident for one validated client report. */
export function clientReportIncident(report: ValidatedClientReport): IncidentInput {
  const fingerprinted = fingerprintMessage(`client:${report.kind}`, report.message)
  return {
    severity: 'error',
    source: 'client',
    kind: 'client-report',
    code: fingerprinted.code,
    fingerprint: fingerprinted.fingerprint,
    message: report.message,
    context: {
      clientKind: report.kind,
      url: report.url ?? null,
      stack: report.stack ?? null,
      normalized: fingerprinted.normalized,
    },
    ...(report.sessionId === undefined ? {} : { sessionId: report.sessionId }),
  }
}

/**
 * Ingest one client report through the bus.
 *
 * @param bus - incident bus.
 * @param request - raw wire payload.
 * @returns the stable fingerprint and code so the client can dedupe.
 * @throws RemoteError `gateway/bad-request` for malformed input.
 */
export function submitClientReport(bus: IncidentBus, request: ClientReportRequest | undefined): ClientReportValue {
  const report = validateClientReport(request)
  const fingerprinted = fingerprintMessage(`client:${report.kind}`, report.message)
  try {
    bus.push(clientReportIncident(report))
  } catch {
    bus.noteSelfFailure()
  }
  return { ok: true, fingerprint: fingerprinted.fingerprint, code: fingerprinted.code }
}

/**
 * Read the recent incident tail. Store failures yield an empty page.
 *
 * @param store - incident store.
 * @param request - filters.
 * @param now - clock.
 * @param bus - optional bus flushed first so queued captures are visible.
 * @returns incidents newest first.
 * @throws RemoteError `gateway/bad-request` for malformed filters.
 */
export function listIncidentsFrom(store: IncidentStore, request: ListRequest | undefined, now: () => number, bus?: IncidentBus): ListValue {
  const source = request ?? {}
  const limit = readLimit('list', source.limit, 50, 500)
  const since = source.since === undefined || source.since === null ? undefined : Number(source.since)
  if (since !== undefined && !Number.isFinite(since)) throw badRequest('list', 'since must be a finite number')
  const severity = readSeverity('list', source.severity)
  try {
    bus?.flushNow()
    const items = store.incidents({
      limit,
      ...(since === undefined ? {} : { since }),
      severity,
      ...(source.source === undefined || source.source === null ? {} : { source: truncate(source.source, 120) }),
      ...(source.kind === undefined || source.kind === null ? {} : { kind: truncate(source.kind, 60) }),
      ...(source.fingerprint === undefined || source.fingerprint === null ? {} : { fingerprint: truncate(source.fingerprint, 64) }),
      includeMuted: source.includeMuted === true,
    })
    return { generatedAt: now(), items }
  } catch {
    return { generatedAt: now(), items: [] }
  }
}

/**
 * Read pattern rollups with a sliding-window count. Store failures yield an
 * empty page.
 *
 * @param store - incident store.
 * @param request - filters.
 * @param now - clock.
 * @param bus - optional bus flushed first so queued captures are visible.
 * @returns patterns by most recent activity.
 * @throws RemoteError `gateway/bad-request` for malformed filters.
 */
export function listPatternsFrom(store: IncidentStore, request: PatternsRequest | undefined, now: () => number, bus?: IncidentBus): PatternsValue {
  const source = request ?? {}
  const window = readWindow('patterns', source.window)
  const limit = readLimit('patterns', source.limit, 50, 500)
  const minCount = readLimit('patterns', source.minCount, 1, 100_000)
  try {
    bus?.flushNow()
    const items = store.patterns({
      window,
      limit,
      minCount,
      includeMuted: source.includeMuted === true,
      ...(source.kind === undefined || source.kind === null ? {} : { kind: truncate(source.kind, 60) }),
    })
    return { window, generatedAt: now(), items }
  } catch {
    return { window, generatedAt: now(), items: [] }
  }
}

/**
 * Mute or unmute one pattern. Muting never drops data.
 *
 * @param store - incident store.
 * @param bus - incident bus (flushed first so queued incidents are visible).
 * @param request - fingerprint and desired state.
 * @returns the resulting state; unknown fingerprints report `ok: false`.
 * @throws RemoteError `gateway/bad-request` for malformed input.
 */
export function mutePattern(
  store: IncidentStore,
  bus: IncidentBus,
  request: MuteRequest | undefined,
): MuteValue {
  const source = request ?? {}
  const fingerprint = readOptional('mute', 'fingerprint', source.fingerprint, 64)
  if (fingerprint === undefined || !FINGERPRINT_RE.test(fingerprint)) {
    throw badRequest('mute', 'fingerprint must be 4-64 characters of [A-Za-z0-9_-]')
  }
  const muted = source.muted === undefined ? true : source.muted === true
  try {
    bus.flushNow()
    return store.mute(fingerprint, muted)
  } catch {
    return { ok: false, muted: false, note: 'store unavailable' }
  }
}

/**
 * Fold the compact health projection.
 *
 * @param store - incident store.
 * @param bus - incident bus.
 * @param options - degradation window and clock.
 * @returns the health fold.
 */
export function systemHealthFrom(
  store: IncidentStore,
  bus: IncidentBus,
  options: { degradeWindowMs?: number; now?: () => number } = {},
): SystemHealthValue {
  try {
    bus.flushNow()
  } catch {
    bus.noteSelfFailure()
  }
  const report = buildReport(store, bus.stats(), {
    window: '24h',
    limit: 5,
    degradeWindowMs: options.degradeWindowMs ?? DEFAULT_DEGRADE_WINDOW_MS,
    now: options.now,
  })
  return {
    status: report.status,
    generatedAt: report.generatedAt,
    degraded: report.degraded,
    topPatterns: report.patterns,
    counts: {
      incidents: report.store.incidents,
      patterns: report.store.patterns,
      muted: report.store.muted,
    },
    capture: report.capture,
    storePath: report.store.path,
  }
}
