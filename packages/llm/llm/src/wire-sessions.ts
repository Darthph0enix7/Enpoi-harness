/**
 * Wire diagnostics: the last main model request, the bounded per-Session
 * inspector, and the optional historical archive the `ds wire` CLI reads.
 *
 * `wire-last.json` always holds the most recent main call. Each Session keeps
 * one atomically replaced inspector file under `wire-sessions/`. Per-call
 * historical files are opt-in (`DSH_WIRE_HISTORY=1`) and are bounded in count,
 * total bytes, and age; without the opt-in no historical file is written.
 *
 * Writes are process-local, fire-and-forget, and serialized: the latest
 * request replaces a pending one, so a chain's answered link wins over an
 * earlier failed link without retaining every request context. Concurrent
 * writer processes share the directory without a lock: each settled capture
 * re-applies the cap, so the bound is eventual rather than instantaneous, and
 * a crash or filesystem failure can leave extra files until a later successful
 * opted-in capture prunes them.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { Buffer } from 'node:buffer'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from './types.ts'
import type { Message } from './message.ts'

/** Sub-directory of the wire log root holding one JSON capture per Session. */
export const WIRE_SESSION_DIR = 'wire-sessions'

/** Newest per-Session capture files retained on disk; older files are pruned after a write. */
export const WIRE_SESSION_RETAIN = 100

/**
 * Default serialized-byte cap for one Session capture. Over the cap the file
 * stores only a summary; if that summary cannot fit either, the write is
 * skipped and the previous capture stays in place.
 */
export const WIRE_SESSION_MAX_BYTES = 16 * 1024 * 1024

/** Default serialized-byte cap for `wire-last.json`; an oversized request stores its summary only. */
export const WIRE_LAST_MAX_BYTES = 16 * 1024 * 1024

/** Historical archive files retained when `DSH_WIRE_HISTORY=1` is set. */
export const WIRE_HISTORY_MAX_FILES = 100

/** Historical archive bytes retained across all owned files when `DSH_WIRE_HISTORY=1` is set. */
export const WIRE_HISTORY_MAX_BYTES = 64 * 1024 * 1024

/** Historical archive age retained when `DSH_WIRE_HISTORY=1` is set. */
export const WIRE_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Per-Session file names this store addresses; any other identity is skipped. */
const SESSION_FILE_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Historical files this module owns: the retired `wire-<digits>.json` naming
 * and the current `wire-<timestamp>-<pid>-<uuid>.json` naming. Every other
 * `*.json` beside them belongs to another owner and is never pruned.
 */
const HISTORY_FILE_NAME = /^wire-\d+(?:-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.json$/i

/** Pending historical writes; beyond this, a capture is skipped rather than retaining more request contexts. */
const MAX_PENDING_HISTORY_WRITES = 16

/** Pending per-Session refreshes; each Session keeps only its latest capture anyway. */
const MAX_PENDING_SESSION_WRITES = 16

/** Summary view of one captured request, safe to expose without its bodies. */
export interface SessionWireCaptureSummary {
  /** Capture time in epoch milliseconds. */
  readonly capturedAt: number
  /** Session the request was stamped with. */
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  /**
   * System-prompt text size and SHA-256 digest; null when neither
   * `options.system` nor a leading system message carried one.
   */
  readonly system: { readonly chars: number; readonly sha256: string } | null
  /** One row per request message, in request order. */
  readonly messages: readonly { readonly role: string; readonly chars: number }[]
  /** Tool names in request order. */
  readonly tools: readonly string[]
}

/** One captured request: the summary plus the secret-bearing bodies. */
export interface SessionWireCapture {
  readonly summary: SessionWireCaptureSummary
  /**
   * Full system prompt: `options.system` when set, otherwise the leading
   * system message's text (loop-built requests carry it there); null when the
   * request carried neither.
   */
  readonly system: string | null
  /** Tool schemas exactly as captured, parsed JSON. */
  readonly tools: readonly JsonValue[]
  /** Message bodies exactly as captured, parsed JSON. */
  readonly messages: readonly JsonValue[]
  /** True when the capture exceeded the byte cap and stores the summary only. */
  readonly truncated: boolean
}

/** Summary fields stored beside a size-capped capture; identity fields are top-level. */
type StoredSummary = Omit<SessionWireCaptureSummary, 'capturedAt' | 'sessionId' | 'provider' | 'model'>

/** Request subset the summary is computed from. */
interface SummarizedRequest {
  readonly system?: string
  readonly messages: readonly RequestMessage[]
  readonly tools: readonly ToolSchema[]
}

/** Identity and routing facts every capture carries; the bodies follow for an un-truncated capture. */
interface WirePayloadIdentity {
  readonly time: number
  readonly capturedAt: number
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly sessionId?: string
  readonly purpose?: string
}

/** One complete wire capture record before serialization. */
interface WirePayload extends WirePayloadIdentity {
  readonly system: string | null
  readonly messages: readonly RequestMessage[]
  readonly tools: readonly ToolSchema[]
}

/** One dispatch's capture plus the settings and destination read at dispatch time. */
interface CaptureEntry {
  readonly payload: WirePayload
  readonly settings: WireCaptureSettings
  readonly main: boolean
  serialized?: string
}

/**
 * Environment-controlled destination and retention policy, read once when a
 * capture is accepted so queued writes cannot observe later env changes.
 */
interface WireCaptureSettings {
  readonly root: string
  readonly wireLogPath?: string
  readonly history: boolean
  readonly historyMaxFiles: number
  readonly historyMaxBytes: number
  readonly historyMaxAgeMs: number
  readonly lastMaxBytes: number
  readonly sessionMaxBytes: number
  readonly sessionRetain: number
}

/** The request fields the capture identity copies. */
interface RequestIdentityFacts {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  readonly sessionId?: string
  readonly purpose?: string
}

/** Build the capture identity from one dispatched request. */
function payloadIdentity(options: RequestIdentityFacts, capturedAt: number): WirePayloadIdentity {
  return {
    time: capturedAt,
    capturedAt,
    provider: options.provider,
    model: options.model,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
  }
}

/** Build one capture record from a dispatched request; no serialization is performed here. */
function wirePayload(options: GenerateOptions, capturedAt: number): WirePayload {
  return {
    ...payloadIdentity(options, capturedAt),
    system: options.system ?? null,
    messages: options.messages,
    tools: options.tools ?? [],
  }
}

/**
 * Atomically refresh one Session's capture with its most recent main request.
 * Auxiliary calls (`purpose` set) never overwrite a main-request capture, and
 * requests without a Session identity are skipped. A capture error is
 * swallowed: diagnostics never break the request path.
 * @param logRoot - wire log root directory (`$DSH_HOME/logs`, `~/.dsh/logs`, or the directory of `DSH_WIRE_LOG`).
 * @param options - the dispatched request.
 */
export async function writeSessionWireCapture(logRoot: string, options: GenerateOptions): Promise<void> {
  try {
    await writeSessionPayload(logRoot, captureSettings(), wirePayload(options, Date.now()))
  } catch (error: unknown) {
    // Best-effort diagnostics: a capture failure never affects the request.
    void error
  }
}

/**
 * Write one already-built main-request payload, reusing `shared` when the
 * caller serialized it. The supplied settings were read when the direct caller
 * or the dispatch queue accepted the capture.
 */
async function writeSessionPayload(
  logRoot: string,
  settings: WireCaptureSettings,
  payload: WirePayload,
  shared?: string,
): Promise<void> {
  const sessionId = payload.sessionId
  if (sessionId === undefined || payload.purpose !== undefined) return
  if (!SESSION_FILE_NAME.test(sessionId)) return
  const dir = join(logRoot, WIRE_SESSION_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const capturedAt = payload.capturedAt
  const full = shared ?? JSON.stringify(payload)
  const bytes = Buffer.byteLength(full, 'utf8')
  let serialized = full
  if (bytes > settings.sessionMaxBytes) {
    // The summary carries no bodies, but it must still fit the same complete
    // file cap; otherwise this write is skipped and the prior file stays.
    serialized = JSON.stringify({
      ...payloadIdentity(payload, capturedAt),
      truncated: true as const,
      bytes,
      summary: await payloadSummary(payload),
    })
    if (Buffer.byteLength(serialized, 'utf8') > settings.sessionMaxBytes) return
  }
  const fileName = `${sessionId}.json`
  const target = join(dir, fileName)
  await writeAtomic(target, serialized)
  await pruneSessionCaptures(dir, settings.sessionRetain, fileName)
}

/**
 * Read the most recent capture for one Session.
 * @param sessionId - Session identity addressed by the capture file name.
 * @param options - optional wire log root override; defaults to `DSH_WIRE_LOG`'s directory, `$DSH_HOME/logs`, or `~/.dsh/logs`.
 * @returns the capture, or undefined when no readable in-bound regular file exists.
 */
export async function readSessionWireCapture(
  sessionId: string,
  options: { readonly root?: string } = {},
): Promise<SessionWireCapture | undefined> {
  if (!SESSION_FILE_NAME.test(sessionId)) return undefined
  try {
    const root = options.root ?? resolveWireLogRoot()
    const cap = positiveLimit('DSH_WIRE_SESSION_MAX_BYTES', WIRE_SESSION_MAX_BYTES)
    const target = join(root, WIRE_SESSION_DIR, `${sessionId}.json`)
    const info = await lstat(target)
    // Never follow a symlink and never read a file written under a larger cap.
    if (!info.isFile() || info.size > cap) return undefined
    const text = await readFile(target, 'utf8')
    return await parseCapture(sessionId, text)
  } catch (error: unknown) {
    // An absent or unreadable capture is simply no capture; callers report that.
    void error
    return undefined
  }
}

/**
 * Capture one dispatched request: refresh the last main request and its
 * per-Session inspector, and append the bounded historical archive only when
 * `DSH_WIRE_HISTORY=1` opts in. Auxiliary calls are skipped entirely without
 * that opt-in. The call reads every destination and cap setting once, here,
 * then only queues work: serialization and filesystem I/O run off the dispatch
 * stack and no failure reaches the request.
 * @param options - the fully projected request the adapter receives.
 */
export function captureWireRequest(options: GenerateOptions): void {
  try {
    const settings = captureSettings()
    if (options.purpose !== undefined && !settings.history) return
    const entry: CaptureEntry = {
      payload: wirePayload(options, Date.now()),
      settings,
      main: options.purpose === undefined,
    }
    if (entry.main) {
      lastMainCapture = entry
      const sessionId = options.sessionId
      if (sessionId !== undefined && SESSION_FILE_NAME.test(sessionId)) {
        lastSessionCaptures.delete(sessionId)
        lastSessionCaptures.set(sessionId, entry)
        while (lastSessionCaptures.size > MAX_PENDING_SESSION_WRITES) {
          for (const oldest of lastSessionCaptures.keys()) {
            lastSessionCaptures.delete(oldest)
            break
          }
        }
      }
    }
    if (settings.history) enqueueHistory(entry)
    scheduleDrain()
  } catch (error: unknown) {
    // Diagnostics never delay or fail a model request.
    void error
  }
}

/** Latest main-request capture; a newer main request replaces the pending one. */
let lastMainCapture: CaptureEntry | undefined
/** Latest main-request capture per Session, keyed by Session id. */
const lastSessionCaptures = new Map<string, CaptureEntry>()
/** Archival writes in dispatch order. */
const historyCaptures: CaptureEntry[] = []
let drainScheduled = false
let drainRunning = false
let nextDrainStep: 'main' | 'session' | 'history' = 'main'
let historyBackpressureReported = false

/** Queue one historical capture, dropping it when the bounded writer backlog is full. */
function enqueueHistory(entry: CaptureEntry): void {
  if (historyCaptures.length >= MAX_PENDING_HISTORY_WRITES) {
    if (!historyBackpressureReported) {
      historyBackpressureReported = true
      process.stderr.write('[wire-capture] DSH_WIRE_HISTORY backlog is full; skipping a historical capture\n')
    }
    return
  }
  historyCaptures.push(entry)
}

/**
 * Schedule the single drain loop off the dispatch stack. A promise
 * continuation, not a timer: the queue must still drain when a caller has
 * installed fake timers, and a lost timer callback would leave later captures
 * unscheduled. While a drain is running, a later capture only lands in the
 * pending views; the running loop sees it before it exits.
 */
function scheduleDrain(): void {
  if (drainScheduled || drainRunning) return
  drainScheduled = true
  void Promise.resolve().then(() => {
    drainScheduled = false
    void runDrain()
  })
}

/** Run one serialized drain loop until every queued capture has had a turn. */
async function runDrain(): Promise<void> {
  drainRunning = true
  try {
    do {
      await drainBatch()
    } while (hasPendingCaptures())
  } catch (error: unknown) {
    /* v8 ignore next -- every write step contains its own filesystem failure */
    void error
  } finally {
    drainRunning = false
  }
}

/** One fair batch: at most the latest main view, one Session, and one archive. */
async function drainBatch(): Promise<void> {
  for (let step = 0; step < 3; step += 1) {
    const current = nextDrainStep
    nextDrainStep = current === 'main' ? 'session' : current === 'session' ? 'history' : 'main'
    await drainOne(current)
  }
}

/** Write at most one pending capture of the requested kind. */
async function drainOne(kind: 'main' | 'session' | 'history'): Promise<void> {
  if (kind === 'main') {
    const main = lastMainCapture
    if (main === undefined) return
    lastMainCapture = undefined
    await writeLastCapture(main)
    return
  }
  if (kind === 'session') {
    const next = lastSessionCaptures.entries().next()
    if (next.done) return
    const [sessionId, entry] = next.value
    lastSessionCaptures.delete(sessionId)
    try {
      await writeSessionPayload(entry.settings.root, entry.settings, entry.payload, serializeCapture(entry))
    } catch (error: unknown) {
      /* v8 ignore next -- a failed inspector write changes no request */
      void error
    }
    return
  }
  const history = historyCaptures.shift()
  if (history !== undefined) await writeHistoryCapture(history)
}

/** Whether any capture remains queued. */
function hasPendingCaptures(): boolean {
  return lastMainCapture !== undefined || lastSessionCaptures.size > 0 || historyCaptures.length > 0
}

/** Serialize one entry once and reuse the string for every destination. */
function serializeCapture(entry: CaptureEntry): string | undefined {
  try {
    entry.serialized ??= JSON.stringify(entry.payload)
    return entry.serialized
  } catch (error: unknown) {
    // A non-serializable hand-built request produces no capture.
    void error
    return undefined
  }
}

/** Write `wire-last.json` (or `DSH_WIRE_LOG`) and replace an oversized request with its summary. */
async function writeLastCapture(entry: CaptureEntry): Promise<void> {
  try {
    const serialized = serializeCapture(entry)
    if (serialized === undefined) return
    const target = entry.settings.wireLogPath ?? join(entry.settings.root, 'wire-last.json')
    const bytes = Buffer.byteLength(serialized, 'utf8')
    let output = serialized
    if (bytes > entry.settings.lastMaxBytes) {
      output = JSON.stringify({
        ...payloadIdentity(entry.payload, entry.payload.capturedAt),
        truncated: true as const,
        bytes,
        summary: await payloadSummary(entry.payload),
      })
      // A summary that cannot fit the configured cap is not written; the
      // previous bounded capture stays readable.
      if (Buffer.byteLength(output, 'utf8') > entry.settings.lastMaxBytes) return
    }
    await writeAtomic(target, output)
  } catch (error: unknown) {
    // A failed last-request write leaves the prior capture readable.
    void error
  }
}

/** Write one bounded historical archive, then re-apply the shared-directory retention policy. */
async function writeHistoryCapture(entry: CaptureEntry): Promise<void> {
  try {
    const serialized = serializeCapture(entry)
    if (serialized === undefined) return
    const bytes = Buffer.byteLength(serialized, 'utf8')
    // A single capture larger than the whole budget is rejected rather than
    // evicting every retained archive to make room for it.
    if (bytes > entry.settings.historyMaxBytes) return
    const fileName = `wire-${entry.payload.capturedAt}-${process.pid}-${randomUUID()}.json`
    await writeAtomic(join(entry.settings.root, fileName), serialized)
    await pruneHistoryCaptures(entry.settings.root, entry.settings, fileName, bytes)
  } catch (error: unknown) {
    // Best-effort diagnostics: history never affects a request.
    void error
  }
}

/** Wire log root: the `DSH_WIRE_LOG` directory when set, otherwise `$DSH_HOME/logs` or `~/.dsh/logs`. */
function resolveWireLogRoot(): string {
  const wireLogPath = process.env.DSH_WIRE_LOG
  if (wireLogPath !== undefined && wireLogPath !== '') return dirname(wireLogPath)
  const configured = process.env.DSH_HOME?.trim()
  const home = configured !== undefined && configured.length > 0
    ? resolve(expandHome(configured))
    : join(homedir(), '.dsh')
  return join(home, 'logs')
}

/** Expand a leading `~` the way the harness home resolver does. */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Read the destination and retention policy once per dispatch. */
function captureSettings(): WireCaptureSettings {
  const wireLogPath = process.env.DSH_WIRE_LOG
  const history = historyEnabled()
  return {
    root: resolveWireLogRoot(),
    ...wireLogPath === undefined || wireLogPath === '' ? {} : { wireLogPath },
    history,
    historyMaxFiles: history ? positiveLimit('DSH_WIRE_HISTORY_MAX_FILES', WIRE_HISTORY_MAX_FILES) : WIRE_HISTORY_MAX_FILES,
    historyMaxBytes: history ? positiveLimit('DSH_WIRE_HISTORY_MAX_BYTES', WIRE_HISTORY_MAX_BYTES) : WIRE_HISTORY_MAX_BYTES,
    historyMaxAgeMs: history ? positiveLimit('DSH_WIRE_HISTORY_MAX_AGE_MS', WIRE_HISTORY_MAX_AGE_MS) : WIRE_HISTORY_MAX_AGE_MS,
    lastMaxBytes: positiveLimit('DSH_WIRE_LAST_MAX_BYTES', WIRE_LAST_MAX_BYTES),
    sessionMaxBytes: positiveLimit('DSH_WIRE_SESSION_MAX_BYTES', WIRE_SESSION_MAX_BYTES),
    sessionRetain: positiveLimit('DSH_WIRE_SESSION_RETAIN', WIRE_SESSION_RETAIN),
  }
}

/** `DSH_WIRE_HISTORY` is denied unless it explicitly opts in. */
function historyEnabled(): boolean {
  const raw = process.env.DSH_WIRE_HISTORY
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  warnSetting('DSH_WIRE_HISTORY', raw, 'off')
  return false
}

/** Settings values already reported, so one typo writes one stderr line. */
const warnedSettings = new Set<string>()

/** One loud diagnostic for an invalid value; the finite default remains in force. */
function warnSetting(name: string, raw: string, effective: string): void {
  const key = `${name}\u0000${raw}`
  if (warnedSettings.has(key)) return
  warnedSettings.add(key)
  process.stderr.write(`[wire-capture] ${name}=${JSON.stringify(raw)} is invalid; using ${effective}\n`)
}

/** Positive safe-integer environment bound; an invalid value is reported and replaced by the finite default. */
function positiveLimit(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (Number.isSafeInteger(value) && value > 0) return value
  warnSetting(name, raw, String(fallback))
  return fallback
}

/** Create the target directory owner-only and replace one file atomically. */
async function writeAtomic(target: string, contents: string): Promise<void> {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, contents, { flag: 'wx', mode: 0o600 })
    await rename(temp, target)
  } catch (error: unknown) {
    /* v8 ignore next -- a vanished temp file needs no cleanup */
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/** Delete historical files beyond count, total bytes, or age; only owned regular files are candidates. */
async function pruneHistoryCaptures(
  root: string,
  settings: WireCaptureSettings,
  keep: string,
  keepBytes: number,
): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    /* v8 ignore start -- an absent or unreadable directory retains nothing to prune */
    void error
    return
    /* v8 ignore stop */
  }
  const candidates: { name: string; path: string; mtimeMs: number; size: number }[] = []
  for (const entry of entries) {
    if (!HISTORY_FILE_NAME.test(entry.name)) continue
    const target = join(root, entry.name)
    try {
      const info = await lstat(target)
      // Never follow a symlink planted beside the captures.
      if (!info.isFile()) continue
      candidates.push({ name: entry.name, path: target, mtimeMs: info.mtimeMs, size: info.size })
    } catch (error: unknown) {
      /* v8 ignore next -- a capture that vanished mid-prune is already gone */
      void error
    }
  }
  candidates.sort(compareNewestFirst)
  const now = Date.now()
  // The just-written capture reserves its count slot and bytes before any
  // older candidate, so a future/stale mtime cannot retain it on top of a full
  // budget. Its bytes were already bounded by the writer.
  let kept = 1
  let keptBytes = keepBytes
  for (const candidate of candidates) {
    if (candidate.name === keep) continue
    const tooOld = now - candidate.mtimeMs > settings.historyMaxAgeMs
    const overCount = kept >= settings.historyMaxFiles
    const overBytes = keptBytes + candidate.size > settings.historyMaxBytes
    if (tooOld || overCount || overBytes) {
      /* v8 ignore next -- a concurrent prune may have removed the file */
      await unlink(candidate.path).catch(() => undefined)
      continue
    }
    kept += 1
    keptBytes += candidate.size
  }
}

/** Newest first, with a locale-independent name tie-break. */
function compareNewestFirst(
  left: { readonly name: string; readonly mtimeMs: number },
  right: { readonly name: string; readonly mtimeMs: number },
): number {
  return right.mtimeMs - left.mtimeMs
    || Buffer.compare(Buffer.from(right.name), Buffer.from(left.name))
}

/** Delete Session captures beyond `retain`; `keep` reserves one slot and symlinks are skipped. */
async function pruneSessionCaptures(dir: string, retain: number, keep: string): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    /* v8 ignore start -- an absent or unreadable directory retains nothing to prune */
    void error
    return
    /* v8 ignore stop */
  }
  const dated: { name: string; path: string; mtimeMs: number }[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue
    if (!SESSION_FILE_NAME.test(entry.name.slice(0, -'.json'.length))) continue
    const target = join(dir, entry.name)
    try {
      const info = await lstat(target)
      if (!info.isFile()) continue
      dated.push({ name: entry.name, path: target, mtimeMs: info.mtimeMs })
    } catch (error: unknown) {
      /* v8 ignore next -- a capture that vanished mid-prune is already gone */
      void error
    }
  }
  dated.sort(compareNewestFirst)
  // The just-written capture reserves one retention slot even if a concurrent
  // prune removed it before this readdir.
  const remaining = dated.filter(candidate => candidate.name !== keep)
  for (const stale of remaining.slice(Math.max(0, retain - 1))) {
    /* v8 ignore next -- a concurrent prune may have removed the file */
    await unlink(stale.path).catch(() => undefined)
  }
}

/** Parse one capture file; undefined when it is malformed or belongs to another Session. */
async function parseCapture(sessionId: string, text: string): Promise<SessionWireCapture | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A truncated or hand-edited capture is not a readable capture.
    return undefined
  }
  if (!isRecord(parsed) || parsed.sessionId !== sessionId) return undefined
  const capturedAt = typeof parsed.capturedAt === 'number' ? parsed.capturedAt : parsed.time
  if (typeof capturedAt !== 'number' || typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') {
    return undefined
  }
  const identity = { capturedAt, sessionId, provider: parsed.provider, model: parsed.model }
  if (parsed.truncated === true) {
    const summary = storedSummary(parsed.summary)
    if (summary === undefined) return undefined
    return { summary: { ...identity, ...summary }, system: null, tools: [], messages: [], truncated: true }
  }
  if (!Array.isArray(parsed.messages) || !Array.isArray(parsed.tools)) return undefined
  const rawMessages: unknown[] = parsed.messages
  const rawTools: unknown[] = parsed.tools
  if (!rawMessages.every(isMessage) || !rawTools.every(isToolSchema)) return undefined
  const systemField = parsed.system
  if (systemField !== undefined && systemField !== null && typeof systemField !== 'string') return undefined
  const messages: Message[] = rawMessages
  const tools: ToolSchema[] = rawTools
  const system = resolveSystemText(systemField ?? null, messages)
  const summary = await summarizeRequest({
    messages,
    tools,
    ...system === null ? {} : { system },
  })
  return {
    summary: { ...identity, ...summary },
    system,
    tools: jsonView(tools),
    messages: jsonView(messages),
    truncated: false,
  }
}

/** JSON view of one validated capture array; typed values carry unknown fields, their serialized form is JSON. */
function jsonView(values: readonly unknown[]): JsonValue[] {
  return values as unknown as JsonValue[]
}

/** Summary rows for one wire payload, shared by the size-capped Session and last-request records. */
async function payloadSummary(payload: WirePayload): Promise<StoredSummary> {
  return summarizeRequest({
    messages: payload.messages,
    tools: payload.tools,
    ...payload.system === null ? {} : { system: payload.system },
  })
}

/** Compute the summary rows for one request (or one parsed capture). */
async function summarizeRequest(request: SummarizedRequest): Promise<StoredSummary> {
  const system = resolveSystemText(request.system ?? null, request.messages)
  return {
    system: system === null ? null : { chars: system.length, sha256: await sha256(system) },
    messages: request.messages.map(message => ({ role: message.role, chars: messageChars(message) })),
    tools: request.tools.map(tool => tool.name),
  }
}

/** Resolve the system prompt from the explicit field or the leading system message. */
function resolveSystemText(system: string | null, messages: readonly RequestMessage[]): string | null {
  if (system !== null && system.length > 0) return system
  const first = messages[0]
  if (first === undefined || first.role !== 'system') return null
  const text = first.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
  return text.length === 0 ? null : text
}

/** UTF-16 code units one message contributes to the wire request. */
function messageChars(message: RequestMessage): number {
  let total = 0
  for (const block of message.content) total += blockChars(block)
  return total
}

/** Text length for text-like blocks, JSON length otherwise. */
function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text.length
    case 'tool-call':
      return block.arguments.length
    default:
      // Merge-extensible block types fall through to their JSON size.
      return JSON.stringify(block).length
  }
}

/** SHA-256 digest of UTF-8 text. */
async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Validate the summary block of a size-capped capture. */
function storedSummary(value: unknown): StoredSummary | undefined {
  if (!isRecord(value)) return undefined
  const system = value.system
  let resolvedSystem: StoredSummary['system']
  if (system === null) resolvedSystem = null
  else if (isRecord(system) && typeof system.chars === 'number' && typeof system.sha256 === 'string') {
    resolvedSystem = { chars: system.chars, sha256: system.sha256 }
  } else return undefined
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools)) return undefined
  const messages: { role: string; chars: number }[] = []
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.role !== 'string' || typeof message.chars !== 'number') return undefined
    messages.push({ role: message.role, chars: message.chars })
  }
  const tools: string[] = []
  for (const tool of value.tools) {
    if (typeof tool !== 'string') return undefined
    tools.push(tool)
  }
  return { system: resolvedSystem, messages, tools }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessage(value: unknown): value is Message {
  return isRecord(value)
    && typeof value.role === 'string'
    && Array.isArray(value.content)
}

function isToolSchema(value: unknown): value is ToolSchema {
  return isRecord(value) && typeof value.name === 'string'
}
