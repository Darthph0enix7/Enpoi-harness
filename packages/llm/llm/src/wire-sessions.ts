/**
 * Per-Session wire captures: one bounded, atomically replaced JSON file per
 * Session holding its most recent main model request, plus the read path the
 * Host API exposes read-only.
 *
 * The global `wire-last.json` / `wire-<ts>.json` files remain the `ds wire`
 * source; this store adds the per-Session view and never replaces them.
 *
 * @module @deepseek-ai/dsh-llm
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from './types.ts'
import type { Message } from './message.ts'

/** Sub-directory of the wire log root holding one JSON capture per Session. */
export const WIRE_SESSION_DIR = 'wire-sessions'

/** Newest per-Session capture files retained on disk; older files are pruned after a write. */
export const WIRE_SESSION_RETAIN = 100

/** Default serialized-byte cap for one capture before bodies are replaced by the summary. */
export const WIRE_SESSION_MAX_BYTES = 16 * 1024 * 1024

/** Per-Session file names this store addresses; any other identity is skipped. */
const SESSION_FILE_NAME = /^[A-Za-z0-9._-]+$/

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
  readonly tools?: readonly ToolSchema[]
}

/**
 * Atomically refresh one Session's capture with its most recent main request.
 * Auxiliary calls (`purpose` set) never overwrite a main-request capture, and
 * requests without a Session identity are skipped. A capture error is
 * swallowed: diagnostics never break the request path.
 * @param logRoot - wire log root directory (`~/.dsh/logs`, or the directory of `DSH_WIRE_LOG`).
 * @param options - the dispatched request.
 */
export async function writeSessionWireCapture(logRoot: string, options: GenerateOptions): Promise<void> {
  try {
    const sessionId = options.sessionId
    if (sessionId === undefined || options.purpose !== undefined) return
    if (!SESSION_FILE_NAME.test(sessionId)) return
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.join(logRoot, WIRE_SESSION_DIR)
    await fs.mkdir(dir, { recursive: true })
    const capturedAt = Date.now()
    const record = {
      capturedAt,
      sessionId,
      time: capturedAt,
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      system: options.system ?? null,
      messages: options.messages,
      tools: options.tools ?? [],
    }
    const full = JSON.stringify(record)
    const bytes = Buffer.byteLength(full, 'utf8')
    let serialized = full
    if (bytes > positiveBound('DSH_WIRE_SESSION_MAX_BYTES', WIRE_SESSION_MAX_BYTES)) {
      // Over the cap, the summary survives without the secret-bearing bodies.
      serialized = JSON.stringify({
        capturedAt,
        sessionId,
        time: capturedAt,
        provider: options.provider,
        model: options.model,
        truncated: true as const,
        bytes,
        summary: await summarizeRequest(options),
      })
    }
    const fileName = `${sessionId}.json`
    const target = path.join(dir, fileName)
    const temp = path.join(dir, `.${sessionId}.${process.pid}.${randomUUID()}.tmp`)
    await fs.writeFile(temp, serialized)
    try {
      await fs.rename(temp, target)
    } catch (error: unknown) {
      // Leave no half-written temp behind when the atomic swap fails.
      await fs.unlink(temp).catch(() => undefined)
      throw error
    }
    await pruneCaptures(dir, positiveBound('DSH_WIRE_SESSION_RETAIN', WIRE_SESSION_RETAIN), fileName)
  } catch (error: unknown) {
    // Best-effort diagnostics: a capture failure never affects the request.
    void error
  }
}

/**
 * Read the most recent capture for one Session.
 * @param sessionId - Session identity addressed by the capture file name.
 * @param options - optional wire log root override; defaults to `DSH_WIRE_LOG`'s directory or `~/.dsh/logs`.
 * @returns the capture, or undefined when no readable capture exists.
 */
export async function readSessionWireCapture(
  sessionId: string,
  options: { readonly root?: string } = {},
): Promise<SessionWireCapture | undefined> {
  if (!SESSION_FILE_NAME.test(sessionId)) return undefined
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const root = options.root ?? await defaultLogRoot()
    const text = await fs.readFile(path.join(root, WIRE_SESSION_DIR, `${sessionId}.json`), 'utf8')
    return await parseCapture(sessionId, text)
  } catch (error: unknown) {
    // An absent or unreadable capture is simply no capture; callers report that.
    void error
    return undefined
  }
}

/** Wire log root: the `DSH_WIRE_LOG` directory when set, otherwise the home log directory. */
async function defaultLogRoot(): Promise<string> {
  const wireLogPath = process.env.DSH_WIRE_LOG
  if (wireLogPath !== undefined) {
    const path = await import('node:path')
    return path.dirname(wireLogPath)
  }
  const os = await import('node:os')
  return `${os.homedir()}/.dsh/logs`
}

/** Positive integer environment bound, falling back when absent or invalid. */
function positiveBound(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Delete the oldest capture files once the directory holds more than `retain`; `keep` is never a candidate. */
async function pruneCaptures(dir: string, retain: number, keep: string): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const names = (await fs.readdir(dir)).filter(name => name.endsWith('.json'))
  if (names.length <= retain) return
  const dated: { name: string; at: number }[] = []
  for (const name of names) {
    try {
      dated.push({ name, at: (await fs.stat(path.join(dir, name))).mtimeMs })
    } catch {
      // A capture that vanished mid-prune is already gone.
    }
  }
  dated.sort((left, right) => right.at - left.at)
  for (const stale of dated.slice(retain)) {
    if (stale.name === keep) continue
    await fs.unlink(path.join(dir, stale.name)).catch(() => undefined)
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

/** Compute the summary rows for one request (or one parsed capture). */
async function summarizeRequest(request: SummarizedRequest): Promise<StoredSummary> {
  const system = resolveSystemText(request.system ?? null, request.messages)
  return {
    system: system === null ? null : { chars: system.length, sha256: await sha256(system) },
    messages: request.messages.map(message => ({ role: message.role, chars: messageChars(message) })),
    tools: (request.tools ?? []).map(tool => tool.name),
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
