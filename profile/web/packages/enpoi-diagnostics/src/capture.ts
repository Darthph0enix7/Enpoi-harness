/**
 * enpoi-diagnostics — capture seams (doc 68 §L1).
 *
 * Four seams feed one incident bus:
 * 1. **Persistent logger sink** — `ctx.logger.exporter()` accepts independent
 *    exporters (vendor/cordis/src/logger.ts `LoggerService.exporter`), so this
 *    plugin registers one with `levels: { default: 3 }` (DEBUG numeric level 3;
 *    the boot exporter at packages/boot/app-boot/src/index.ts:929 uses
 *    `{ default: 2 }` and therefore drops debug). Our sink sees every level the
 *    harness emits, including plugin activation failures, which cordis reports
 *    only through `ctx.logger.error` (vendor/cordis/src/fiber.ts `_reload`).
 * 2. **Plugin lifecycle** — `internal/status` fires on fiber state changes; a
 *    fiber in state 3 (FAILED) becomes a `plugin-failed` incident with the
 *    plugin name, independent of the log text.
 * 3. **Engine error paths** — the durable `session/event` stream: provider
 *    retries/errors (`llm/retry`), tool failures (`tool/result.error`), turn
 *    failures (`turn/end` reason `error`), and compaction failures
 *    (`compaction/end.error`). Subagent, council, and MCP mount failures reach
 *    this seam as their own tool errors/turn errors and their logger lines.
 * 4. **Client reports** — `diagnostics.report` RPC (see `remote.ts`).
 *
 * Every path is wrapped: a capture failure is swallowed and counted once on the
 * bus (`selfFailures`), never thrown into the harness.
 *
 * @module dsh-enpoi-diagnostics/capture
 */

import type { Context, Exporter, Message } from '@deepseek-ai/cordis'
import { fingerprintMessage } from './fingerprint.js'
import { severityRank, truncate, type IncidentInput, type IncidentStore, type Severity } from './store.js'

/** Fiber state 3 — cordis `FiberState.FAILED` (vendor/cordis/src/fiber.ts:151). */
const FIBER_STATE_FAILED = 3
/** Numeric DEBUG threshold; an exporter level of 3 delivers every level. */
const LOGGER_LEVEL_ALL = 3

/** Capture-side counters, exposed through the report surfaces. */
export interface CaptureStats {
  /** Occurrences accepted into the queue. */
  readonly queued: number
  /** Occurrences written to SQLite. */
  readonly stored: number
  /** Occurrences dropped (queue overflow or a store failure). */
  readonly dropped: number
  /** Failures inside diagnostics itself (swallowed, counted once each). */
  readonly selfFailures: number
  /** Queue depth at read time. */
  readonly pending: number
}

/** Bus construction options. */
export interface BusOptions {
  readonly flushMs?: number
  readonly queueLimit?: number
  /** Invoked at most once per process when the first self-failure happens. */
  readonly onSelfFailure?: () => void
}

/**
 * The incident bus: an in-memory queue in front of the synchronous store so a
 * capture never performs SQLite work inside a turn or a log call.
 */
export class IncidentBus {
  private pending: IncidentInput[] = []
  private timer: NodeJS.Timeout | undefined
  private flushing = false
  private disposed = false
  private failures = 0
  private drops = 0
  private stored = 0
  private queued = 0
  private selfNotified = false
  private readonly flushMs: number
  private readonly queueLimit: number

  constructor(private readonly store: IncidentStore, private readonly options: BusOptions = {}) {
    this.flushMs = Math.max(10, Math.trunc(options.flushMs ?? 250))
    this.queueLimit = Math.max(16, Math.trunc(options.queueLimit ?? 2000))
  }

  /** Queue one incident. Never throws; overflow is counted and dropped. */
  push(input: IncidentInput): void {
    if (this.disposed) return
    try {
      this.pending.push({ ...input, message: truncate(input.message, 500) })
      this.queued += 1
      if (this.pending.length >= this.queueLimit) {
        // Never grow past the cap: the oldest queued occurrence loses.
        this.pending.splice(0, this.pending.length - this.queueLimit)
        this.drops += 1
      }
      this.schedule()
    } catch {
      this.noteSelfFailure()
    }
  }

  /** Count one swallowed diagnostics failure (the single counter from doc 68 principles). */
  noteSelfFailure(): void {
    this.failures += 1
    if (!this.selfNotified) {
      this.selfNotified = true
      try {
        this.options.onSelfFailure?.()
      } catch {
        this.failures += 1
      }
    }
  }

  /** Flush now (used before report reads and on dispose). Never throws. */
  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.drain()
  }

  /** Stop the timer and flush what remains. */
  dispose(): void {
    this.disposed = true
    this.flushNow()
    this.pending = []
  }

  /** Read the capture counters. */
  stats(): CaptureStats {
    return {
      queued: this.queued,
      stored: this.stored,
      dropped: this.drops + this.failures,
      selfFailures: this.failures,
      pending: this.pending.length,
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.drain()
    }, this.flushMs)
    this.timer.unref?.()
  }

  private drain(): void {
    if (this.flushing || this.pending.length === 0) return
    this.flushing = true
    const batch = this.pending
    this.pending = []
    try {
      this.stored += this.store.recordMany(batch)
    } catch {
      this.failures += 1
      this.drops += batch.length
      if (!this.selfNotified) {
        this.selfNotified = true
        try {
          this.options.onSelfFailure?.()
        } catch {
          this.failures += 1
        }
      }
    } finally {
      this.flushing = false
    }
    if (this.pending.length > 0) this.schedule()
  }
}

/** Build one incident from a logger record. */
export function logIncident(message: Message): IncidentInput | undefined {
  const name = typeof message.name === 'string' && message.name !== '' ? message.name : 'root'
  // Our own lines would feed back into the store; they are never captured.
  if (name.startsWith('enpoi-diagnostics')) return undefined
  const severity: Severity = message.type === 'error' || message.type === 'warn' || message.type === 'info' || message.type === 'debug'
    ? message.type
    : 'error'
  const text = formatLogArgs(message.args)
  if (text === '') return undefined
  return {
    at: message.ts,
    severity,
    source: `log:${name}`,
    kind: 'log',
    ...fingerprintIncident(`log:${name}`, text, { logger: name, level: message.level, sn: message.sn }),
  }
}

/** Render logger arguments into one bounded safe line (never throws). */
export function formatLogArgs(args: readonly unknown[]): string {
  const parts: string[] = []
  for (const arg of args.slice(0, 6)) {
    parts.push(formatValue(arg))
    if (parts.join(' ').length > 2000) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
}

function formatValue(value: unknown): string {
  try {
    if (typeof value === 'string') return value
    if (value instanceof Error) {
      const head = `${value.name}: ${value.message}`
      // Stack line 0 repeats name+message; keep only the first frames.
      const frames = typeof value.stack === 'string'
        ? value.stack.split('\n').slice(1, 3).map(line => line.trim()).filter(line => line !== '').join(' | ')
        : ''
      return frames === '' ? head : `${head} | ${frames}`
    }
    if (value === null || value === undefined) return String(value)
    const kind = typeof value
    if (kind === 'number' || kind === 'boolean' || kind === 'bigint' || kind === 'symbol') return String(value)
    const json = JSON.stringify(value)
    return json === undefined ? Object.prototype.toString.call(value) : json.slice(0, 800)
  } catch {
    return '[unprintable]'
  }
}

/**
 * Attach the persistent logger sink. The exporter receives every level the
 * harness emits (`levels.default = 3`); it only enqueues, never touches SQLite.
 *
 * @param ctx - owning context.
 * @param bus - the incident bus.
 * @param minSeverity - lowest severity to persist (default `debug` = everything).
 */
export function attachLoggerSink(ctx: Context, bus: IncidentBus, minSeverity: Severity = 'debug'): void {
  const exporter: Exporter = {
    levels: { default: LOGGER_LEVEL_ALL },
    export: (message: Message) => {
      try {
        if (severityRank(message.type as Severity) < severityRank(minSeverity)) return
        const incident = logIncident(message)
        if (incident !== undefined) bus.push(incident)
      } catch {
        bus.noteSelfFailure()
      }
    },
  }
  try {
    ctx.logger.exporter(exporter)
  } catch {
    bus.noteSelfFailure()
  }
}

/** Per-session context remembered from the event stream (provider/model attribution). */
interface SessionContext {
  provider?: string
  model?: string
}

const MAX_SESSION_CONTEXTS = 200
const MAX_TOOL_CALLS = 500

/** Structural session shape this seam needs (the real Session satisfies it). */
interface SessionLike {
  readonly id: string
}

/** Structural event shape; plugin-extended event types are read by name, not by union membership. */
interface EventLike {
  readonly type: string
  readonly data: unknown
}

/**
 * Attach the engine-error-path seam over the durable `session/event` stream.
 *
 * @param ctx - owning context.
 * @param bus - the incident bus.
 */
export function attachSessionEvents(ctx: Context, bus: IncidentBus): void {
  const sessions = new Map<string, SessionContext>()
  const tools = new Map<string, string>()
  // Plugin-extended event names (`llm/retry`, `compaction/end`) are outside the
  // core SessionEventMap this package can see; the listener is structural and
  // every payload is re-validated field by field below.
  const listener = (session: SessionLike, event: EventLike): void => {
    try {
      const id = session.id
      const data = (event.data ?? {}) as Record<string, unknown>
      switch (event.type) {
        case 'request/context': {
          rememberSession(sessions, id, {
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            model: typeof data.model === 'string' ? data.model : undefined,
          })
          return
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : undefined
          const name = typeof data.name === 'string' ? data.name : 'unknown'
          if (callId !== undefined) {
            tools.set(callId, name)
            if (tools.size > MAX_TOOL_CALLS) tools.delete(tools.keys().next().value as string)
          }
          return
        }
        case 'tool/result': {
          const error = data.error as { name?: unknown; code?: unknown; reason?: unknown } | undefined
          if (error === undefined || error === null) return
          const callId = typeof data.callId === 'string' ? data.callId : undefined
          const tool = callId !== undefined ? tools.get(callId) ?? 'unknown' : 'unknown'
          const code = typeof error.code === 'string' ? error.code : 'TOOL_ERROR'
          const name = typeof error.name === 'string' ? error.name : 'ToolError'
          const reason = typeof error.reason === 'string' ? error.reason : ''
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: 'error',
            source: 'session',
            kind: 'tool-error',
            ...fingerprintIncident(`tool-error:${tool}`, `${name}: ${reason !== '' ? reason : code}`, {
              errorCode: code,
              tool,
              callId: callId ?? null,
              turn: data.turn ?? null,
              step: data.step ?? null,
            }),
          })
          return
        }
        case 'llm/retry': {
          const failure = data.failure as { message?: unknown; code?: unknown } | undefined
          const code = typeof failure?.code === 'string' ? failure.code : 'LLM_RETRY'
          const text = typeof failure?.message === 'string' && failure.message !== ''
            ? failure.message
            : `provider retry (${code})`
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: 'warn',
            source: 'session',
            kind: 'provider-error',
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            ...fingerprintIncident('provider-error', text, {
              errorCode: code,
              retry: data.retry ?? null,
              maxRetries: data.maxRetries ?? null,
              mode: data.mode ?? null,
              policyKey: data.policyKey ?? null,
              turn: data.turn ?? null,
              step: data.step ?? null,
              delayMs: data.delayMs ?? null,
            }),
          })
          return
        }
        case 'turn/end': {
          const reason = data.reason as { kind?: unknown; error?: { code?: unknown; message?: unknown } } | undefined
          if (reason?.kind !== 'error') return
          const code = typeof reason.error?.code === 'string' ? reason.error.code : 'UNKNOWN'
          const text = typeof reason.error?.message === 'string' && reason.error.message !== ''
            ? reason.error.message
            : `turn failed (${code})`
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: 'error',
            source: 'session',
            kind: 'turn-error',
            provider: typeof data.provider === 'string' ? data.provider : undefined,
            ...fingerprintIncident('turn-error', text, { errorCode: code, turn: data.turn ?? null }),
          })
          return
        }
        case 'compaction/end': {
          const error = data.error
          if (error === undefined || error === null) return
          const text = typeof error === 'string' ? error : errorText(error)
          bus.push({
            ...sessionAttribution(sessions, id),
            severity: 'error',
            source: 'session',
            kind: 'compaction-error',
            ...fingerprintIncident('compaction-error', text, { compactionId: data.compactionId ?? null }),
          })
          return
        }
        default:
          return
      }
    } catch {
      bus.noteSelfFailure()
    }
  }
  ctx.on('session/event', listener as never)
}

/**
 * Render a failed fiber's stored error for the loud path. Cordis keeps it on
 * the fiber (`_error`, the `reason` its `_reload` catch stored); it may be any
 * thrown value, so everything degrades to bounded text and never throws.
 * @param value - the fiber's stored failure.
 * @returns bounded `Name: message` text (plus the stable code when present).
 */
function fiberFailureText(value: unknown): string {
  if (value === undefined || value === null) return 'no error captured'
  const code = typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string'
    ? ` [${String((value as { code: string }).code)}]`
    : ''
  if (value instanceof Error) return truncate(`${value.name}: ${value.message}${code}`, 300)
  return truncate(`${String(value)}${code}`, 300)
}

/**
 * Attach the plugin-lifecycle seam (`internal/status` FAILED transitions).
 *
 * A failed fiber is never fatal — cordis contains the rejection — but it must
 * never be invisible either. Each failure gets ONE stderr line naming the
 * plugin/fiber and the stored error (the journal), plus one coded
 * diagnostics-ledger row whose message carries the same reason. This is the
 * fibre-level analogue of `tool-groups/mount-failed`.
 */
export function attachPluginLifecycle(ctx: Context, bus: IncidentBus): void {
  const seen = new WeakSet<object>()
  ctx.on('internal/status', (fiber: { state?: unknown; name?: unknown; _error?: unknown }) => {
    try {
      if (fiber === null || typeof fiber !== 'object') return
      if (fiber.state !== FIBER_STATE_FAILED) return
      if (seen.has(fiber)) return
      seen.add(fiber)
      const name = typeof fiber.name === 'string' && fiber.name !== '' ? fiber.name : 'unknown'
      const reason = fiberFailureText(fiber._error)
      const text = `plugin fiber failed: ${name}: ${reason}`
      // Journal line first: a fiber death must be visible without querying the
      // ledger (the ledger itself may be what nobody reads during boot).
      process.stderr.write(`[enpoi-diagnostics] ${text}\n`)
      bus.push({
        severity: 'error',
        source: 'plugin',
        kind: 'plugin-failed',
        ...fingerprintIncident('plugin-failed', text, { plugin: name, fiber: name, error: reason }),
      })
    } catch {
      bus.noteSelfFailure()
    }
  })
}

function rememberSession(sessions: Map<string, SessionContext>, id: string, patch: SessionContext): void {
  const previous = sessions.get(id) ?? {}
  sessions.set(id, { ...previous, ...patch })
  if (sessions.size > MAX_SESSION_CONTEXTS) {
    sessions.delete(sessions.keys().next().value as string)
  }
}

function sessionAttribution(sessions: Map<string, SessionContext>, id: string): { sessionId: string; provider?: string; model?: string } {
  const context = sessions.get(id)
  return {
    sessionId: id,
    ...(context?.provider === undefined ? {} : { provider: context.provider }),
    ...(context?.model === undefined ? {} : { model: context.model }),
  }
}

function fingerprintIncident(
  subject: string,
  text: string,
  context: Record<string, unknown> = {},
): Pick<IncidentInput, 'message' | 'fingerprint' | 'code' | 'context'> {
  const fingerprinted = fingerprintMessage(subject, text)
  return {
    message: text.slice(0, 500),
    fingerprint: fingerprinted.fingerprint,
    // The stable code is derived from the fingerprint (doc 68 §L2), so equal
    // patterns always present the same code; the producer's own code travels
    // in context.errorCode when it exists.
    code: fingerprinted.code,
    context: { ...context, normalized: fingerprinted.normalized },
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    try {
      return JSON.stringify(error).slice(0, 500)
    } catch {
      return '[error]'
    }
  }
  return String(error)
}
