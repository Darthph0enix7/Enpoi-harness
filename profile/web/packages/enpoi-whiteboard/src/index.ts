/**
 * enpoi-whiteboard — orchestrator-authored pinned context (doc 66 §3c,
 * doc 67 §B).
 *
 * The board lives in the shared settings namespace `enpoi-orchestration` under
 * `whiteboard` (hot-swappable + cross-device via settings sync), is authored
 * only through the five tools (`whiteboard_read`, `whiteboard_write`,
 * `whiteboard_pin`, `whiteboard_unpin`, `whiteboard_forget`), and is injected
 * through the runtime-context seam (`systemPrompt.context()`, a trailing
 * replace-in-place snapshot) — never the system prompt itself, so the frozen
 * prefix keeps its cache.
 *
 * Boards are stored per scope and resolved per session: global → project
 * (matching the session cwd) → parent session (direct-child inheritance) →
 * session (matching the session id), later scopes overriding earlier ones by
 * entry id. The injected block and every read render the resolved view, so a
 * session-scoped entry never leaks into another session; a legacy single-board
 * document stays readable and migrates into the bucket its own scope names —
 * a legacy `global` board attributed with `meta.writtenBySessionId` migrates
 * into that session's bucket and leaves `global` empty, so every other session
 * resolves empty. The Watchtower card renders only the session half of the
 * resolved view; project/global entries stay behind a collapsed disclosure.
 *
 * Guarantees: a rendered resolved board over the hard budget REFUSES the write
 * (never silently trims); an exact single-path entry is validated and flagged
 * `stale` — never deleted — while prose/mixed legacy values are unverified, not
 * stale; `whiteboard_forget` returns the entry it removed. Mutations return a
 * short receipt; only `whiteboard_read` returns the full resolved view. Session
 * buckets are bounded by a one-sweep-per-activation GC that keeps the newest
 * {@link DEFAULT_MAX_SESSION_BOARDS} boards.
 *
 * @module dsh-enpoi-whiteboard
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import Schema from '@deepseek-ai/schemastery'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_SESSION_BOARDS,
  WHITEBOARD_CONTEXT_NAME,
  WHITEBOARD_CONTEXT_ORDER,
  applyStoreWrites,
  checkBudget,
  estimateTokens,
  findEntryTarget,
  isWhiteboardScope,
  lintPaths,
  migrateLegacyStore,
  normalizeStore,
  readBoard,
  removeStoreEntry,
  renderWhiteboard,
  resolveBoard,
  setStorePinned,
  sweepSessionBoards,
  versionLine,
  writeBoard,
  type BoardScopeFacts,
  type LintResult,
  type ResolvedBoard,
  type WhiteboardEntry,
  type WhiteboardEntryKind,
  type WhiteboardScope,
  type WhiteboardStore,
  type WhiteboardTarget,
  type WhiteboardWriteRequest,
} from './board'

/** Cordis plugin name. */
export const name = 'enpoi-whiteboard'

/** The board's storage namespace is a shared service; tools are the write path. */
export const inject = ['tools']

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Read one effective numeric Config field (Volatile ref on 0.1.7+, plain value before it). */
function value(field: number | Volatile<number> | undefined): number | undefined {
  if (field === undefined) return undefined
  if (typeof field === 'number') return field
  return field.get()
}

/** Live-editable whiteboard bounds. */
export interface Config {
  /** Hard rendered-token budget (doc 67 §B); writes over it are refused. */
  budgetTokens?: Volatile<number>
  /** Bounded GC: how many session boards to keep across activations. */
  maxSessionBoards?: Volatile<number>
}

export const Config = Schema.object({
  budgetTokens: live(Schema.number().default(DEFAULT_BUDGET_TOKENS)),
  maxSessionBoards: live(Schema.number().default(DEFAULT_MAX_SESSION_BOARDS)),
})

/** Defaulted plain config handed to the tool/GC closures. */
export interface ResolvedWhiteboardConfig {
  budgetTokens: number
  maxSessionBoards: number
}

/** One entry in the full read result. */
type WhiteboardReadEntryValue = {
  id: string
  kind: WhiteboardEntryKind
  text: string
  pinned: boolean
  version: number
  scope: WhiteboardScope
  stale?: boolean
}

/** The full read tool value (stored view plus live path diagnostics). */
type WhiteboardReadValue = {
  ok: true
  version: number
  scope: WhiteboardScope
  tokens: number
  budget: number
  entries: WhiteboardReadEntryValue[]
  stale: string[]
  staleTotal: number
  unknown: string[]
  unknownTotal: number
  rendered: string
  versionLine: string
}

/** A refused mutation value. */
type WhiteboardRefusalValue = {
  ok: false
  reason: 'refused'
  message: string
  tokens?: number
  budget?: number
}

/** One successful mutation receipt. */
type WhiteboardReceiptValue = {
  ok: true
  op: string
  changedIds: string[]
  changedTotal: number
  version: number
  scope: WhiteboardScope
  checkedScope: WhiteboardScope
  checkedFacts: BoardScopeFacts
  tokens: number
  budget: number
  callerTokens: number
  callerScope: WhiteboardScope
  stale: string[]
  staleTotal: number
  unknown: string[]
  unknownTotal: number
  note?: string
}

/** One entry removed by `whiteboard_forget`. */
type WhiteboardRemovedEntry = {
  id: string
  kind: WhiteboardEntryKind
  text: string
  pinned: boolean
  version: number
  scope: WhiteboardScope
}

/** The forget tool value: a receipt that carries the removed entry, or a refusal. */
type WhiteboardForgetValue = (WhiteboardReceiptValue & { removed?: WhiteboardRemovedEntry }) | WhiteboardRefusalValue

/** Narrow one JSON value to a plain object. */
function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Narrow the tool output boundary to the read value (the output schema validates the fields). */
function isWhiteboardReadValue(value: unknown): value is WhiteboardReadValue {
  return isJsonObject(value)
    && value.ok === true
    && Array.isArray(value.entries)
    && Array.isArray(value.stale)
    && Array.isArray(value.unknown)
}

/** Narrow the tool output boundary to a successful mutation receipt. */
function isWhiteboardReceiptValue(value: unknown): value is WhiteboardReceiptValue {
  return isJsonObject(value) && value.ok === true && typeof value.op === 'string' && Array.isArray(value.changedIds)
}

/** Narrow the tool output boundary to a refusal. */
function isWhiteboardRefusalValue(value: unknown): value is WhiteboardRefusalValue {
  return isJsonObject(value) && value.ok === false && value.reason === 'refused' && typeof value.message === 'string'
}

/** Resolve one mutation render value, failing loud if the tool schema and renderer drift. */
function mutationRenderValue(value: JsonValue): WhiteboardReceiptValue | WhiteboardRefusalValue {
  if (isWhiteboardRefusalValue(value) || isWhiteboardReceiptValue(value)) return value
  throw new Error('whiteboard mutation rendered a value outside its output schema')
}

/** Resolve one read render value, failing loud if the tool schema and renderer drift. */
function readRenderValue(value: JsonValue): WhiteboardReadValue {
  if (isWhiteboardReadValue(value)) return value
  throw new Error('whiteboard_read rendered a value outside its output schema')
}

/** Resolve one forget render value, failing loud if the tool schema and renderer drift. */
function forgetRenderValue(value: JsonValue): WhiteboardForgetValue {
  if (isWhiteboardRefusalValue(value) || isWhiteboardReceiptValue(value)) return value
  throw new Error('whiteboard_forget rendered a value outside its output schema')
}

/** Shared settings namespace (owned by enpoi-capabilities). */
const ORCH_NS = 'enpoi-orchestration'

/** The structural slice of the settings service this plugin uses. */
interface SettingsLike extends SettingsDocumentReader {
  /** Pre-0.1.7 namespace reader. */
  get?: (ns: string) => unknown
  /** 0.1.7+ narrow namespace reader. */
  describeNamespace?: (ns: string) => { ns: string; value?: unknown } | undefined
  describe?: () => Array<{ ns: string; revision?: number; value?: unknown }>
  mutate?: (
    ns: string,
    ops: Array<{ op: 'set'; path: string[]; value: unknown }>,
    expectedRevision?: number,
  ) => Promise<unknown>
}

/** The structural slice of the tool-execution identity this plugin uses. */
interface ToolExecLike {
  agent?: {
    session?: {
      id?: string
      header?: { cwd?: string; parentSession?: string }
    }
  }
}

/** The structural slice of `systemPrompt` this plugin uses. */
interface SystemPromptLike {
  context?: (contribution: {
    name: string
    order: number
    text: string | ((assembly: { agent?: ToolExecLike['agent'] }) => string)
  }) => () => void
}

function settingsOf(ctx: Context): SettingsLike | undefined {
  try {
    return ctx.get('settings') as SettingsLike | undefined
  } catch {
    return undefined
  }
}

/** One-time-per-process notice that a legacy board is being read in memory. */
let legacyReadLogged = false

/** Whether a value is a plain settings document object (not null/array/scalar). */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize/migrate one settings namespace document; owns the one-time legacy read notice. */
function storeFromDocument(document: Record<string, unknown> | undefined): WhiteboardStore {
  const migration = migrateLegacyStore(document?.whiteboard)
  if (migration.migrated && !legacyReadLogged) {
    legacyReadLogged = true
    const destination = migration.attributedTo === undefined ? 'global' : `session ${migration.attributedTo}`
    process.stderr.write(`[enpoi-whiteboard] legacy board read (${migration.entries} entries) — migrated in memory into ${destination}\n`)
  }
  return migration.store
}

/**
 * Read the current multi-scope store for the fail-open read/injection path.
 * Never throws: a missing settings service or a malformed value answers the
 * empty store, so a read can never break a turn (doc 66 invariant 1). Mutations
 * use {@link strictStoreFromSettings} instead: a transient read failure there
 * must not be mistaken for an empty board and overwrite it. A legacy
 * single-board document is migrated in memory — a `meta.writtenBySessionId`
 * global board lands in that session's bucket — and rewritten in the new shape
 * by the next write or by the one-time settings migration.
 * @param settings - the `settings` service, or undefined when absent.
 * @returns the normalized store.
 */
function storeFromSettings(settings: SettingsDocumentReader | undefined): WhiteboardStore {
  try {
    return storeFromDocument(readOrchestrationDocument(settings))
  } catch {
    return normalizeStore(undefined)
  }
}

/** A strict mutation read: the store plus the revision from the same describe snapshot. */
type StrictStoreRead =
  | { ok: true; store: WhiteboardStore; revision?: number }
  | { ok: false; message: string }

/** Stringify an error without letting a hostile `toString` throw. */
function errorText(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** The bounded refusal one failed strict mutation read returns. */
function strictReadFailure(error: unknown): { ok: false; message: string } {
  return { ok: false, message: `board read failed — board not written (${errorText(error)})` }
}

/**
 * Read the store for a mutation. Unlike the fail-open read/injection path, any
 * settings-surface throw or malformed namespace value refuses the write, so a
 * transient read failure can never be mistaken for an empty board and overwrite
 * the stored one. `describe()` is called once per attempt: its value and
 * revision come from the same snapshot. A descriptor without a resolved value
 * (the pre-0.1.7/test shape) falls back to `get()` for the value while keeping
 * that snapshot's revision. An absent namespace is a first write, not an error.
 * @param settings - the `settings` service, or undefined when absent.
 * @returns the store plus the revision to fence the write, or a bounded refusal.
 */
function strictStoreFromSettings(settings: SettingsLike | undefined): StrictStoreRead {
  if (settings === undefined) return { ok: false, message: 'settings service unavailable — board not written' }
  let sawSurface = false
  let revision: number | undefined
  let document: Record<string, unknown> | undefined
  let descriptor: { ns: string; revision?: number; value?: unknown } | undefined
  if (typeof settings.describe === 'function') {
    sawSurface = true
    try {
      const entries = settings.describe()
      descriptor = entries.find((entry) => entry.ns === ORCH_NS)
      if (descriptor !== undefined) revision = descriptor.revision
    } catch (error) {
      return strictReadFailure(error)
    }
  }
  if (descriptor?.value !== undefined) {
    if (!isObjectRecord(descriptor.value)) return { ok: false, message: 'whiteboard document is malformed — board not written' }
    document = descriptor.value
  } else {
    if (typeof settings.get === 'function') {
      sawSurface = true
      let value: unknown
      try {
        value = settings.get(ORCH_NS)
      } catch (error) {
        return strictReadFailure(error)
      }
      if (value !== undefined) {
        if (!isObjectRecord(value)) return { ok: false, message: 'whiteboard document is malformed — board not written' }
        document = value
      }
    }
    if (document === undefined && typeof settings.describeNamespace === 'function') {
      sawSurface = true
      let narrow: { ns: string; value?: unknown } | undefined
      try {
        narrow = settings.describeNamespace(ORCH_NS)
      } catch (error) {
        return strictReadFailure(error)
      }
      if (narrow?.value !== undefined) {
        if (!isObjectRecord(narrow.value)) return { ok: false, message: 'whiteboard document is malformed — board not written' }
        document = narrow.value
      }
    }
  }
  if (!sawSurface) return { ok: false, message: 'settings service unavailable — board not written' }
  try {
    const raw = document?.whiteboard
    if (raw !== undefined && raw !== null && !isObjectRecord(raw)) {
      return { ok: false, message: 'whiteboard document is malformed — board not written' }
    }
    return { ok: true, store: storeFromDocument(document), revision }
  } catch (error) {
    return strictReadFailure(error)
  }
}

/**
 * Read the current multi-scope store from one plugin context.
 * @param ctx - owning plugin context.
 * @returns the normalized store.
 */
export function readWhiteboardStore(ctx: Context): WhiteboardStore {
  return storeFromSettings(settingsOf(ctx))
}

/**
 * Resolve the shared whiteboard for one reader without a plugin context. This is
 * the shared-consumer read: it applies the same legacy migration and
 * global → project → parent-session → session resolution as the read tool,
 * budget check, and injected block, and it never writes or opens another
 * datastore. Consumers pass the `settings` service they already hold. This is
 * the fail-open read path (a missing/malformed document resolves empty);
 * mutations use the strict read and refuse instead of overwriting.
 * @param settings - the `settings` service, or undefined.
 * @param facts - the reader's session/project/parent scope facts.
 * @returns the resolved view; an absent or malformed document resolves empty.
 */
export function resolvedBoard(settings: SettingsDocumentReader | undefined, facts: BoardScopeFacts = {}): ResolvedBoard {
  return resolveBoard(storeFromSettings(settings), facts)
}

/**
 * Read the board resolved for one assembly's scope facts (global → project →
 * parent session → session).
 * @param ctx - owning plugin context.
 * @param facts - the reader's scope facts; omitted resolves global only.
 * @returns the resolved view.
 */
export function readWhiteboard(ctx: Context, facts: BoardScopeFacts = {}): ResolvedBoard {
  return resolvedBoard(settingsOf(ctx), facts)
}

/** The cwd a tool call resolves `path` entries against. */
function toolCwd(exec: ToolExecLike | undefined): string {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** The scope facts one agent contributes (a tool-call session or an assembly). */
function agentFacts(agent: ToolExecLike['agent']): BoardScopeFacts {
  const facts: BoardScopeFacts = {}
  const session = agent?.session
  const id = session?.id
  if (typeof id === 'string' && id.length > 0) facts.sessionId = id
  const parent = session?.header?.parentSession
  if (typeof parent === 'string' && parent.length > 0) facts.parentSessionId = parent
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) facts.projectId = cwd
  return facts
}

/** The scope facts one tool call contributes. */
function sessionFacts(exec: ToolExecLike | undefined): BoardScopeFacts {
  return agentFacts(exec?.agent)
}

/** The refusal every board mutation returns to a delegated child session. */
const CHILD_AUTHORING_REFUSAL = 'the whiteboard is authored by the main session; children read it'

/** Whether one tool execution is a delegated child (a session with a durable parent). */
function isChildSession(exec: ToolExecLike | undefined): boolean {
  return sessionFacts(exec).parentSessionId !== undefined
}

/** Resolve one parsed path against a cwd (absolute and home paths pass through resolved). */
function resolveEntryPath(pathText: string, cwd: string): string {
  if (pathText === '~') return homedir()
  if (pathText.startsWith('~/') || pathText.startsWith('~\\')) return resolve(homedir(), pathText.slice(2))
  return isAbsolute(pathText) ? pathText : resolve(cwd, pathText)
}

/** The board with its path entries linted against a cwd (the project's own cwd when writing there). */
function linted<T extends { entries: readonly WhiteboardEntry[] }>(
  doc: T,
  exec: ToolExecLike | undefined,
  cwd: string = toolCwd(exec),
): LintResult<T> {
  return lintPaths(doc, (_entry, pathText) => resolveEntryPath(pathText, cwd), existsSync, Date.now())
}

/** A write refusal surfaced to the model verbatim, escaped and code-point bounded. */
function refusal(message: string, extra: Pick<WhiteboardRefusalValue, 'tokens' | 'budget'> = {}): WhiteboardRefusalValue {
  return { ok: false, reason: 'refused', message: safeMessage(message), ...extra }
}

/** The result of one fenced store commit. */
type CommitResult =
  | { ok: true; store: WhiteboardStore; changed: boolean; changedIds: string[] }
  | { ok: false; message: string; tokens?: number; budget?: number }

/** One build's candidate store plus whether it actually changed anything. */
type BuildResult =
  | { ok: true; store: WhiteboardStore; changed?: boolean; changedIds?: string[] }
  | { ok: false; message: string }

/**
 * Read-modify-write the store under the namespace revision fence: a concurrent
 * writer (another tool call, or the operator's settings surface) is re-read and
 * the transition replayed, so a write is never silently clobbered. The candidate
 * is budget-checked as the resolved view of `checkFacts` — the audience the
 * write targets (or the writer's own session for a global write). Reads are
 * strict for mutations: a throw from the settings surface refuses before any
 * build or mutate, so a transient read failure cannot overwrite the board with
 * an empty store. The revision and value come from one `describe()` snapshot
 * per attempt. A transition that reports no change commits nothing and returns
 * the current store, so an identical write cannot bump the version or churn the
 * injected context.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 * @param checkFacts - the scope facts the budget check resolves against.
 * @param build - pure transition from the current store to the candidate.
 * @returns the committed store and changed ids, or a refusal message.
 */
async function commitStore(
  ctx: Context,
  config: ResolvedWhiteboardConfig,
  checkFacts: BoardScopeFacts,
  build: (store: WhiteboardStore, now: number) => BuildResult,
): Promise<CommitResult> {
  const settings = settingsOf(ctx)
  if (settings?.mutate === undefined) return { ok: false, message: 'settings service unavailable — board not written' }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now()
    const strict = strictStoreFromSettings(settings)
    if (!strict.ok) return { ok: false, message: strict.message }
    const current = strict.store
    const built = build(current, now)
    if (!built.ok) return { ok: false, message: built.message }
    if (built.changed === false) return { ok: true, store: current, changed: false, changedIds: [] }
    const next: WhiteboardStore = { ...built.store, version: current.version + 1 }
    const check = checkBudget(resolveBoard(next, checkFacts), config.budgetTokens)
    if (!check.ok) {
      return {
        ok: false,
        message: `Over budget: the resolved board renders ${check.tokens} tokens (budget ${check.budget}). Nothing was written.`,
        tokens: check.tokens,
        budget: check.budget,
      }
    }
    try {
      await settings.mutate(ORCH_NS, [{ op: 'set', path: ['whiteboard'], value: next }], strict.revision)
      return { ok: true, store: next, changed: true, changedIds: built.changedIds ?? [] }
    } catch (error) {
      lastError = error
      if ((error as { code?: string })?.code === 'SETTINGS_CONFLICT' && attempt < 2) continue
      return { ok: false, message: `board write failed: ${errorText(error)}` }
    }
  }
  return { ok: false, message: `board write failed after retries: ${errorText(lastError)}` }
}

/**
 * Result fields every whiteboard tool may return (the full `boardView` shape,
 * the short mutation receipt, and the optional `note`). Declared once so a tool
 * output schema cannot drift from the real result — `whiteboard_pin`/
 * `whiteboard_unpin` shipped without `scope` and the harness rejected their
 * (correct) output as invalid.
 */
const BOARD_RESULT_PROPERTIES = {
  ok: { type: 'boolean' as const },
  reason: { type: 'string' as const },
  message: { type: 'string' as const },
  version: { type: 'number' as const },
  scope: { type: 'string' as const },
  checkedScope: { type: 'string' as const },
  checkedFacts: { type: 'object' as const, additionalProperties: true },
  tokens: { type: 'number' as const },
  budget: { type: 'number' as const },
  callerTokens: { type: 'number' as const },
  callerScope: { type: 'string' as const },
  op: { type: 'string' as const },
  changedIds: { type: 'array' as const, items: { type: 'string' as const } },
  changedTotal: { type: 'number' as const },
  entries: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: true } },
  stale: { type: 'array' as const, items: { type: 'string' as const } },
  staleTotal: { type: 'number' as const },
  unknown: { type: 'array' as const, items: { type: 'string' as const } },
  unknownTotal: { type: 'number' as const },
  rendered: { type: 'string' as const },
  versionLine: { type: 'string' as const },
  note: { type: 'string' as const },
}

/** How many ids one mutation receipt lists before reporting the remainder as a count. */
const MAX_RECEIPT_IDS = 8

/** Hard cap on rendered mutation/refusal text, counted in code points (never splits a surrogate pair). */
const MAX_RECEIPT_CODEPOINTS = 600

/** Bound text by code points, so a bound never splits a surrogate pair. */
function takeChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** Bound text by code points with an explicit truncation marker. */
function boundText(text: string, max: number): string {
  return Array.from(text).length <= max ? text : `${takeChars(text, max - 1)}…`
}

/** Escape control characters and newlines in one dynamic value before it enters a receipt. */
function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (char) => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    const code = char.codePointAt(0) ?? 0
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

/** Escape control characters and bound one dynamic receipt/refusal value. */
function safeText(value: unknown, max: number = MAX_RECEIPT_CODEPOINTS): string {
  return boundText(escapeControls(String(value)), max)
}

/** Escape control characters and bound a refusal message. */
function safeMessage(message: string): string {
  return safeText(message, MAX_RECEIPT_CODEPOINTS)
}

/** Bound the assembled receipt while preserving its intentional line breaks. */
function boundedReceipt(text: string): string {
  return boundText(text, MAX_RECEIPT_CODEPOINTS)
}

/** Dedupe and bound one receipt id list, putting operation-relevant ids first. */
function boundedIds(ids: readonly string[], first: readonly string[] = []): string[] {
  const available = new Set(ids)
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...first, ...ids]) {
    if (!available.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_RECEIPT_IDS) break
  }
  return out
}

/**
 * The full read result. `rendered` and `tokens` are the stored resolved view —
 * exactly what the runtime-context injection would render — while `entries`,
 * `stale`, and `unknown` are the live lint diagnostics. A filesystem change
 * therefore changes diagnostics without changing the injected text/count.
 */
function boardView(stored: ResolvedBoard, diagnostic: LintResult<ResolvedBoard>, budgetTokens: number): WhiteboardReadValue {
  const rendered = renderWhiteboard(stored)
  const entries = diagnostic.doc.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    pinned: entry.pinned,
    version: entry.version,
    scope: entry.scope,
    ...(entry.stale === true ? { stale: true } : {}),
  }))
  return {
    ok: true,
    version: stored.version,
    scope: stored.scope,
    tokens: estimateTokens(rendered),
    budget: budgetTokens,
    entries,
    stale: diagnostic.stale,
    staleTotal: diagnostic.stale.length,
    unknown: diagnostic.unknown,
    unknownTotal: diagnostic.unknown.length,
    rendered,
    versionLine: versionLine(stored),
  }
}

/** The two assembled views one mutation receipt reports. */
interface ReceiptViews {
  /** The committed store resolved on the budget-checked facts (the audience the write was checked against). */
  checked: ResolvedBoard
  /** The scope facts the budget check used. */
  checkedFacts: BoardScopeFacts
  /** Live path diagnostics for the checked view; they never change `tokens`. */
  checkedDiagnostics: LintResult<ResolvedBoard>
  /** The caller's stored resolved view, for comparison with `whiteboard_read`. */
  caller: ResolvedBoard
}

/**
 * The short mutation receipt: ids that actually changed, the checked view's
 * stored resolved token use against the budget, a board-version scalar, and
 * bounded relevant stale / unverified path ids. It also reports the caller
 * read's tokens/scope when the checked target differs. It never carries the
 * full board — `whiteboard_read` is the full view.
 */
function receiptView(
  views: ReceiptViews,
  budgetTokens: number,
  op: string,
  changedIds: readonly string[],
  note?: string,
): WhiteboardReceiptValue {
  const { checked, checkedFacts, checkedDiagnostics, caller } = views
  return {
    ok: true,
    op,
    changedIds: boundedIds(changedIds),
    changedTotal: changedIds.length,
    version: checked.version,
    scope: caller.scope,
    checkedScope: checked.scope,
    checkedFacts,
    tokens: estimateTokens(renderWhiteboard(checked)),
    budget: budgetTokens,
    callerTokens: estimateTokens(renderWhiteboard(caller)),
    callerScope: caller.scope,
    stale: boundedIds(checkedDiagnostics.stale, changedIds),
    staleTotal: checkedDiagnostics.stale.length,
    unknown: boundedIds(checkedDiagnostics.unknown, changedIds),
    unknownTotal: checkedDiagnostics.unknown.length,
    ...(note === undefined ? {} : { note: safeText(note, 240) }),
  }
}

/** The guidance note one mutation returns when path entries need operator action. */
function pathNote(staleTotal: number, unknownTotal: number): string | undefined {
  const parts: string[] = []
  if (staleTotal > 0) parts.push(`${staleTotal} stale path entr${staleTotal === 1 ? 'y' : 'ies'} (missing on disk; repoint or forget — never auto-deleted)`)
  if (unknownTotal > 0) parts.push(`${unknownTotal} path entr${unknownTotal === 1 ? 'y' : 'ies'} unverified (not one checkable path on this host; not stale)`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** The write target plus the facts and cwd its budget check resolves. */
type WriteTarget = { target: WhiteboardTarget; checkFacts: BoardScopeFacts; checkCwd?: string }

/**
 * Resolve one write's storage target. `scope` is explicit or defaults to the
 * caller's own session; explicit `sessionId`/`projectId` override the calling
 * session's identity. The budget check sees the view it can assemble:
 * - global, default project, and session writes check the caller's full resolved view;
 * - an explicit foreign project checks that project's global + project view;
 * - an explicit foreign session checks global + that session.
 * It cannot enumerate every session reader or persist a cwd catalog, so the
 * hard budget is enforced on the assembled checked view, not globally for all
 * readers. `checkCwd` is the cwd relative path entries are linted against; a
 * foreign session has no cwd in the tool identity, so its diagnostics use the
 * caller cwd.
 * @param exec - the tool execution identity.
 * @param args - the tool arguments.
 * @returns the target, check facts/cwd, or an error message.
 */
function writeTargetFor(exec: ToolExecLike | undefined, args: Record<string, unknown>): WriteTarget | { error: string } {
  const own = sessionFacts(exec)
  const ownCwd = toolCwd(exec)
  const scope = isWhiteboardScope(args.scope) ? args.scope : 'session'
  if (scope === 'global') return { target: { scope: 'global' }, checkFacts: own, checkCwd: ownCwd }
  if (scope === 'project') {
    const explicit = typeof args.projectId === 'string' && args.projectId.length > 0 ? args.projectId : undefined
    const projectId = explicit ?? ownCwd
    const foreign = explicit !== undefined && explicit !== ownCwd
    return foreign
      ? { target: { scope: 'project', projectId }, checkFacts: { projectId }, checkCwd: projectId }
      : { target: { scope: 'project', projectId }, checkFacts: own, checkCwd: ownCwd }
  }
  const explicit = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
  const sessionId = explicit ?? own.sessionId
  if (sessionId === undefined) return { error: 'scope "session" requires a session id and this execution has none' }
  return {
    target: { scope: 'session', sessionId },
    checkFacts: sessionId === own.sessionId ? own : { sessionId },
    checkCwd: ownCwd,
  }
}

/** Stable key for one storage bucket (groups replace requests by authoring board). */
function targetKey(target: WhiteboardTarget): string {
  if (target.scope === 'global') return 'global'
  if (target.scope === 'project') return `project:${target.projectId}`
  return `session:${target.sessionId}`
}

/**
 * Plan one write's storage targets. Append writes, and any write with an
 * explicit `scope`, use the explicit/default target. A replace under the
 * default session scope mirrors pin/unpin's authoring-board targeting: each
 * entry's `replaceId` is replaced where it actually lives (own session →
 * parent session → project → global), so replacing a project or global entry
 * never fails on a session lookup.
 * @param store - the store the transition runs against.
 * @param fallback - the explicit/default target.
 * @param facts - the caller's scope facts.
 * @param requests - the requested entries.
 * @param mode - `append` (default) or `replace` by id.
 * @param explicitScope - whether the caller named a scope.
 * @returns the target groups, or a refusal message.
 */
function planWriteTargets(
  store: WhiteboardStore,
  fallback: WhiteboardTarget,
  facts: BoardScopeFacts,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  explicitScope: boolean,
): { ok: true; groups: Array<{ target: WhiteboardTarget; requests: WhiteboardWriteRequest[] }> } | { ok: false; message: string } {
  if (mode !== 'replace' || explicitScope) return { ok: true, groups: [{ target: fallback, requests: [...requests] }] }
  const groups: Array<{ target: WhiteboardTarget; requests: WhiteboardWriteRequest[] }> = []
  const byKey = new Map<string, number>()
  for (const request of requests) {
    const id = request.replaceId ?? request.id
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: 'mode "replace" requires each entry to carry the id it replaces' }
    }
    const target = findEntryTarget(store, facts, id) ?? fallback
    const key = targetKey(target)
    const at = byKey.get(key)
    if (at === undefined) {
      byKey.set(key, groups.length)
      groups.push({ target, requests: [request] })
    } else groups[at]!.requests.push(request)
  }
  return { ok: true, groups }
}

/** The five board tools (doc 67 §B). */
function registerTools(ctx: Context, config: ResolvedWhiteboardConfig): void {
  const tools: ToolRuntime | undefined = ctx.tools
  if (tools === undefined) {
    process.stderr.write('[enpoi-whiteboard] no tools service — board tools not mounted\n')
    return
  }

  tools.register({
    name: 'whiteboard_read',
    description: [
      'Read the pinned context board resolved for this session: global entries, then this project\'s, then this session\'s (a direct child also inherits its parent session\'s), later scopes overriding earlier ones by entry id.',
      'Every entry reports the scope that authored it. This is the full view. `rendered` and `tokens` are the exact stored resolved injection; `entries`, `stale`, and `unknown` are live filesystem diagnostics and never change `rendered` or `tokens`. Mutations return only a short receipt.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' },
                pinned: { type: 'boolean' }, version: { type: 'number' }, scope: { type: 'string' },
                stale: { type: 'boolean' },
              },
              required: ['id', 'kind', 'text', 'pinned', 'version', 'scope'],
            },
          },
          stale: { type: 'array', items: { type: 'string' } },
          unknown: { type: 'array', items: { type: 'string' } },
          rendered: { type: 'string' },
          versionLine: { type: 'string' },
        },
        required: ['ok', 'version', 'scope', 'tokens', 'budget', 'entries', 'stale', 'staleTotal', 'unknown', 'unknownTotal', 'rendered', 'versionLine'],
      },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderWhiteboardResult(readRenderValue(value)) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec: ToolExecLike) {
      const stored = readWhiteboard(ctx, sessionFacts(exec))
      return boardView(stored, linted(stored, exec), config.budgetTokens)
    },
  })

  tools.register({
    name: 'whiteboard_write',
    description: [
      'Author the pinned context board for one scope. scope defaults to session (your own session); project stores under your session cwd (or projectId) and applies to that project; global applies to every session.',
      'Append entries, or replace entries by id. A replace under the default session scope replaces the entry in the scope that authored it, so a project/global entry is replaced there. Repeating an identical id+content is a deterministic no-op: no entry version, board version, or injected-context change.',
      'Kinds: path, rule, fact, task. A path entry must contain exactly one filesystem path (absolute, cwd-relative, ~/…, or a quoted path containing spaces; include a separator or file extension for bare names). Quoting makes glob metacharacters literal. Prose, path lists, multiline text, URLs, and unquoted globs are refused — use rule/fact/task for those. Missing paths are flagged stale, never deleted.',
      'Returns a short receipt (changed ids, checked stored-view tokens against the budget, checked scope/facts, caller-read tokens, board version, bounded stale/unverified ids), not the full board; use whiteboard_read for the full resolved view. The HARD budget is checked on the view the target can assemble: your full resolved view for global, default-project, and session writes; an explicit foreign project checks that project\'s view; an explicit foreign session checks that session. Other readers are not enumerated and no cwd catalog is persisted.',
      'Keep only core context the orchestrator must not have to repeat: current docs, invariants, task state.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) adds entries; replace overwrites the entry named by replaceId' },
        scope: { type: 'string', enum: ['session', 'project', 'global'], description: 'Where entries land (default: session — the calling session)' },
        sessionId: { type: 'string', description: 'Session id when scope=session (default: the calling session)' },
        projectId: { type: 'string', description: 'Project cwd when scope=project (default: the calling session cwd)' },
        entries: {
          type: 'array',
          description: 'Entries to write',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Stable id; required for append-with-known-id, and the old id for replace' },
              kind: { type: 'string', enum: ['path', 'rule', 'fact', 'task'] },
              text: { type: 'string', description: 'One compact line' },
              pinned: { type: 'boolean', description: 'Pinned entries sort first and are never compacted' },
            },
            required: ['kind', 'text'],
          },
        },
      },
      required: ['entries'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderWriteResult(mutationRenderValue(value)) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const mode = args.mode === 'replace' ? 'replace' as const : 'append' as const
      const rawEntries: unknown = args.entries
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) return refusal('entries must be a non-empty array')
      const requests: WhiteboardWriteRequest[] = []
      for (const raw of rawEntries) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return refusal('entries[] must contain objects')
        }
        const row = raw as Record<string, unknown>
        const kind = row.kind
        if (kind !== 'path' && kind !== 'rule' && kind !== 'fact' && kind !== 'task') {
          return refusal(`entries[].kind must be one of path|rule|fact|task (got ${JSON.stringify(kind)})`)
        }
        requests.push({
          kind,
          text: typeof row.text === 'string' ? row.text : '',
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          ...(mode === 'replace' && typeof row.id === 'string' ? { replaceId: row.id } : {}),
          ...(row.pinned === true ? { pinned: true } : {}),
        })
      }
      const target = writeTargetFor(exec, args)
      if ('error' in target) return refusal(target.error)
      const explicitScope = isWhiteboardScope(args.scope)
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, target.checkFacts, (store, now) => {
        const plan = planWriteTargets(store, target.target, facts, requests, mode, explicitScope)
        if (!plan.ok) return plan
        let next = store
        const changedIds: string[] = []
        for (const group of plan.groups) {
          const applied = applyStoreWrites(next, group.target, group.requests, mode, now)
          if (!applied.ok) return applied
          if (applied.changedIds.length === 0) continue
          for (const id of applied.changedIds) if (!changedIds.includes(id)) changedIds.push(id)
          const board = readBoard(applied.store, group.target)
          const lintCwd = group.target.scope === 'project' ? group.target.projectId : undefined
          next = board === undefined
            ? applied.store
            : writeBoard(applied.store, group.target, linted(board, exec, lintCwd).doc)
        }
        return { ok: true, store: next, changed: changedIds.length > 0, changedIds }
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const caller = resolveBoard(committed.store, facts)
      const checked = resolveBoard(committed.store, target.checkFacts)
      const checkedView = linted(checked, exec, target.checkCwd)
      const note = committed.changed ? pathNote(checkedView.stale.length, checkedView.unknown.length) : undefined
      return receiptView(
        { checked, checkedFacts: target.checkFacts, checkedDiagnostics: checkedView, caller },
        config.budgetTokens,
        committed.changed ? mode : 'unchanged',
        committed.changedIds,
        note,
      )
    },
  })

  tools.register({
    name: 'whiteboard_pin',
    description: 'Pin a whiteboard entry in the scope that authored it (pinned entries sort first and are never compacted). Pinning never rewrites the entry text.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderWriteResult(mutationRenderValue(value)) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        const pinned = setStorePinned(store, target, id, true, now)
        return pinned.ok ? { ok: true, store: pinned.store, changed: pinned.changed, changedIds: pinned.changed ? [id] : [] } : pinned
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const caller = resolveBoard(committed.store, facts)
      const view = linted(caller, exec)
      return receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        'pin',
        committed.changedIds,
        committed.changed ? undefined : `already pinned ${id}`,
      )
    },
  })

  tools.register({
    name: 'whiteboard_unpin',
    description: 'Unpin a whiteboard entry in the scope that authored it. Unpinning never deletes the entry; the operator prunes explicitly.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderWriteResult(mutationRenderValue(value)) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        const pinned = setStorePinned(store, target, id, false, now)
        return pinned.ok ? { ok: true, store: pinned.store, changed: pinned.changed, changedIds: pinned.changed ? [id] : [] } : pinned
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const caller = resolveBoard(committed.store, facts)
      const view = linted(caller, exec)
      return receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        'unpin',
        committed.changedIds,
        committed.changed ? undefined : `already unpinned ${id}`,
      )
    },
  })

  tools.register({
    name: 'whiteboard_forget',
    description: 'Delete one whiteboard entry in the scope that authored it (own session, then parent session, then project, then global). The removed entry — including its text — is returned, so nothing is ever dropped silently.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          removed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' },
              pinned: { type: 'boolean' }, version: { type: 'number' }, scope: { type: 'string' },
            },
            required: ['id', 'kind', 'text', 'pinned', 'version', 'scope'],
          },
        },
        required: ['ok'],
      },
      render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: renderForgetResult(forgetRenderValue(value)) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      let removed: Record<string, unknown> | undefined
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        const result = removeStoreEntry(store, target, id, now)
        if (!result.ok) return result
        removed = {
          id: result.removed.id,
          kind: result.removed.kind,
          text: result.removed.text,
          pinned: result.removed.pinned,
          version: result.removed.version,
          scope: target.scope,
        }
        return { ok: true, store: result.store, changed: true, changedIds: [id] }
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const caller = resolveBoard(committed.store, facts)
      const view = linted(caller, exec)
      const base = receiptView(
        { checked: caller, checkedFacts: facts, checkedDiagnostics: view, caller },
        config.budgetTokens,
        'forget',
        committed.changedIds,
        `forgot ${id}`,
      )
      return removed === undefined ? base : { ...base, removed }
    },
  })
}

/** Bound one displayed id without losing its identifying head; control characters are escaped. */
function shortId(id: unknown): string {
  return safeText(id, 32)
}

/** Render one bounded id list plus the omitted count. */
function renderIdList(value: unknown, total: number): string {
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  const shown = ids.map(shortId).join(', ')
  return total > ids.length ? `${shown}${shown.length > 0 ? ' ' : ''}(+${total - ids.length} more)` : shown
}

/** Model-facing render for a successful board read (the full stored view plus live diagnostics). */
function renderWhiteboardResult(value: WhiteboardReadValue): string {
  const entries = value.entries
  const unknown = value.unknown
  const warning = unknown.length > 0
    ? `\nUnverified path entries (not stale): ${unknown.map((id) => escapeControls(String(id))).join(', ')}`
    : ''
  const scope = safeText(value.scope, 24)
  if (entries.length === 0) return `Whiteboard v${String(value.version)} resolves to no entries for this session (0/${String(value.budget)} tokens).${warning}`
  const lines = entries.map((entry) => `• ${entry.pinned === true ? '📌 ' : ''}[${safeText(entry.kind, 16)}] ${String(entry.text)}${entry.stale === true ? ' (stale)' : ''} — ${escapeControls(String(entry.id))} v${String(entry.version)} · ${safeText(entry.scope, 24)}`)
  return `${[...lines, `— v${String(value.version)} · ${scope} · ${String(value.tokens)}/${String(value.budget)} tokens`].join('\n')}${warning}`
}

/** Model-facing render for one short mutation receipt (or its refusal). */
function renderReceipt(value: WhiteboardReceiptValue | WhiteboardRefusalValue): string {
  if (value.ok !== true) return safeMessage(String(value.message ?? 'Whiteboard mutation refused.'))
  const op = safeText(typeof value.op === 'string' ? value.op : 'write', 24)
  const changedTotal = typeof value.changedTotal === 'number' ? value.changedTotal : 0
  const staleTotal = typeof value.staleTotal === 'number' ? value.staleTotal : 0
  const unknownTotal = typeof value.unknownTotal === 'number' ? value.unknownTotal : 0
  const tokens = typeof value.tokens === 'number' ? value.tokens : 0
  const callerTokens = typeof value.callerTokens === 'number' ? value.callerTokens : tokens
  const callerScope = safeText(value.scope, 32)
  const checkedScope = safeText(typeof value.checkedScope === 'string' ? value.checkedScope : value.scope, 32)
  const head = checkedScope === callerScope && callerTokens === tokens
    ? `Whiteboard v${String(value.version)} · ${callerScope} · ${String(tokens)}/${String(value.budget)} tokens`
    : `Whiteboard v${String(value.version)} · read ${callerScope} ${String(callerTokens)} tok · checked ${checkedScope} ${String(tokens)}/${String(value.budget)} tok`
  const action = op === 'unchanged'
    ? 'unchanged (identical content; no version or injection change)'
    : `${op}: ${changedTotal === 0 ? 'none' : renderIdList(value.changedIds, changedTotal)}`
  const flags: string[] = []
  if (staleTotal > 0) flags.push(`stale ${staleTotal}: ${renderIdList(value.stale, staleTotal)}`)
  if (unknownTotal > 0) flags.push(`unverified path ${unknownTotal}: ${renderIdList(value.unknown, unknownTotal)}`)
  const lines = [head, [action, ...flags].filter((part) => part.length > 0).join(' · ')]
  const note = typeof value.note === 'string' && value.note.length > 0 ? safeText(value.note, 240) : undefined
  if (note !== undefined) lines.push(note)
  return boundedReceipt(lines.join('\n'))
}

/** Model-facing render for a board mutation (short receipt). */
function renderWriteResult(value: WhiteboardReceiptValue | WhiteboardRefusalValue): string {
  return renderReceipt(value)
}

/** Model-facing render for a forgotten entry — the removed text is always reported. */
function renderForgetResult(value: WhiteboardForgetValue): string {
  if (value.ok !== true) return safeMessage(String(value.message ?? 'Whiteboard forget refused.'))
  const removed = value.removed
  const display = removed === undefined ? '' : safeText(removed.text, 240)
  const head = removed === undefined
    ? 'Whiteboard entry forgotten.'
    : `Forgot [${safeText(removed.kind, 16)}] ${display} — ${shortId(removed.id)} (${safeText(removed.scope, 24)}).`
  return boundedReceipt(`${head}\n${renderReceipt({ ...value, op: 'forget', note: undefined })}`)
}

/** Delay before the activation sweep, so the settings service has mounted. */
const SESSION_SWEEP_DELAY_MS = 2_000

/**
 * Bounded GC: keep only the newest `maxSessionBoards` session buckets. The
 * harness has no session-delete event a plugin can hook (delete disposes the
 * live session and removes its log), so the trigger is one sweep per plugin
 * activation — every profile restart prunes what accumulated. Best-effort: a
 * missing settings service, a strict-read failure, or a conflict leaves the
 * store untouched; one line reports what was dropped.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 */
async function sweepSessionBoardsNow(ctx: Context, config: ResolvedWhiteboardConfig): Promise<void> {
  const pending = sweepSessionBoards(readWhiteboardStore(ctx), config.maxSessionBoards)
  if (pending.dropped.length === 0) return
  let dropped: string[] = []
  const committed = await commitStore(ctx, config, {}, (current) => {
    const next = sweepSessionBoards(current, config.maxSessionBoards)
    dropped = next.dropped
    return { ok: true, store: next.store }
  })
  if (!committed.ok) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC skipped: ${committed.message}\n`)
    return
  }
  if (dropped.length > 0) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC dropped ${dropped.length} board(s) over the ${config.maxSessionBoards} limit: ${dropped.join(', ')}\n`)
  }
}

/**
 * Schedule the one-time-per-activation bounded GC.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 */
function scheduleSessionSweep(ctx: Context, config: ResolvedWhiteboardConfig): void {
  const timer = setTimeout(() => {
    void sweepSessionBoardsNow(ctx, config).catch((error: unknown) => {
      process.stderr.write(`[enpoi-whiteboard] session-board GC failed: ${String(error)}\n`)
    })
  }, SESSION_SWEEP_DELAY_MS)
  timer.unref()
  ctx.effect(() => () => { clearTimeout(timer) }, 'enpoi-whiteboard: session-board GC')
}

/**
 * Install the runtime-context contribution. The contribution renders the board
 * resolved for each assembling agent (session → project → global), so every
 * agent sees exactly the entries that apply to it — a session-scoped entry
 * never leaks into another session, and a global entry applies everywhere.
 */
function installInjection(ctx: Context): void {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt?.context === undefined) {
    process.stderr.write('[enpoi-whiteboard] no systemPrompt service — runtime-context injection skipped\n')
    return
  }
  const dispose = systemPrompt.context({
    name: WHITEBOARD_CONTEXT_NAME,
    order: WHITEBOARD_CONTEXT_ORDER,
    text: (assembly) => {
      try {
        const resolved = resolveBoard(readWhiteboardStore(ctx), agentFacts(assembly?.agent))
        return renderWhiteboard(resolved)
      } catch {
        return ''
      }
    },
  })
  ctx.effect(() => dispose, 'enpoi-whiteboard: runtime-context injection')
}

export type { BoardScopeFacts, ResolvedBoard, WhiteboardEntry } from './board'

export function apply(ctx: Context, config: Config = {}): void {
  const budgetTokens = value(config.budgetTokens)
  const maxSessionBoards = value(config.maxSessionBoards)
  const resolved: ResolvedWhiteboardConfig = {
    budgetTokens: typeof budgetTokens === 'number' && Number.isFinite(budgetTokens) && budgetTokens > 0
      ? Math.floor(budgetTokens)
      : DEFAULT_BUDGET_TOKENS,
    maxSessionBoards: typeof maxSessionBoards === 'number' && Number.isFinite(maxSessionBoards) && maxSessionBoards >= 1
      ? Math.floor(maxSessionBoards)
      : DEFAULT_MAX_SESSION_BOARDS,
  }
  registerTools(ctx, resolved)
  installInjection(ctx)
  scheduleSessionSweep(ctx, resolved)
  process.stderr.write(`[enpoi-whiteboard] mounted (budget ${resolved.budgetTokens} tokens, ${resolved.maxSessionBoards} session boards max; per-scope board resolved lazily per assembly; runtime-context seam)\n`)
}
