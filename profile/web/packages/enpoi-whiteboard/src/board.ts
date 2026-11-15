/**
 * enpoi-whiteboard — pinned-board vocabulary: per-scope storage, resolution,
 * normalization, rendering, the hard token budget, and the path/staleness lint.
 * Functions are pure apart from the host-platform default that selects which
 * absolute-path syntax is checkable; the settings transport, tools and
 * runtime-context injection live in ./index.ts.
 *
 * Storage contract (doc 66 §3c, doc 67 §B): `enpoi-orchestration.whiteboard`
 * holds `{ version, docs: { global?: Board, projects: { <cwd>: Board },
 * sessions: { <sessionId>: Board } } }`. A legacy single-board document is
 * still readable and migrates into the bucket its own scope names; a legacy
 * global board that carries `meta.writtenBySessionId` belongs to that session
 * and migrates into its session bucket, leaving `global` empty
 * ({@link migrateLegacyStore}). Every entry carries a version; path entries
 * are validated on write and flagged stale — never auto-deleted.
 *
 * Path contract: one `path` entry names exactly one filesystem path. A quoted
 * path may contain spaces; unquoted prose, path lists, multiline text, URLs,
 * and unquoted glob patterns are not filesystem paths — the lint reports them as
 * `unknown` (a warning) and never as stale. Legacy entries that put prose or
 * several paths in one entry stay readable: they are preserved untouched and
 * are not auto-pruned or reclassified as missing files.
 *
 * Resolution contract: a read merges global → project (matching the session
 * cwd) → parent session (direct-child inheritance) → session (matching the
 * session id), later scopes overriding earlier ones by entry id, and reports
 * each resolved entry's authoring scope. The injected block is that resolved
 * view (session entries plus explicitly shared project/global ones); the
 * Watchtower card's primary surface is session-only, with shared entries in a
 * collapsed disclosure. The injected block is version-free so a write that
 * changes only bookkeeping cannot churn the request context.
 *
 * Bounded GC: session buckets do not accumulate forever — a sweep keeps only
 * the newest {@link DEFAULT_MAX_SESSION_BOARDS} by `updatedAt`
 * ({@link sweepSessionBoards}).
 *
 * @module dsh-enpoi-whiteboard/board
 */

/** Where a board applies; resolution prefers session over project over global. */
export type WhiteboardScope = 'session' | 'project' | 'global'

/** One entry kind. `path` is the only kind validated against the filesystem. */
export type WhiteboardEntryKind = 'path' | 'rule' | 'fact' | 'task'

/** One pinned-board entry. */
export interface WhiteboardEntry {
  /** Stable entry id; the handle for pin/unpin/replace-by-id. */
  id: string
  kind: WhiteboardEntryKind
  /** The entry text. New `path` writes name exactly one filesystem path; legacy mixed text is preserved and reported unverified. */
  text: string
  /** Pinned entries are never trimmed by an explicit compact; unpinned ones may be. */
  pinned: boolean
  /** Epoch ms the entry was (last) pinned; 0 when never pinned. */
  pinnedAt: number
  /** Entry version: 1 at creation, +1 per replace-by-id. */
  version: number
  /** Epoch ms of the last checkable path validation; cleared when the text is not a checkable single path. */
  lastValidatedAt?: number
  /** Set when a `path` entry is one checkable path that no longer resolves; cleared when it resolves again or stops being one path. */
  stale?: boolean
}

/** One scope's stored board. */
export interface WhiteboardBoard {
  /** Board version: 0 when never written, +1 per successful write to this board. */
  version: number
  entries: WhiteboardEntry[]
  /** Epoch ms of the last write to this board. */
  updatedAt: number
}

/** The normalized multi-scope store under `enpoi-orchestration.whiteboard`. */
export interface WhiteboardStore {
  /** Store version: 0 when never written, +1 per successful write. */
  version: number
  docs: {
    global?: WhiteboardBoard
    projects: Record<string, WhiteboardBoard>
    sessions: Record<string, WhiteboardBoard>
  }
}

/** One storage bucket a write can target. */
export type WhiteboardTarget =
  | { scope: 'global' }
  | { scope: 'project'; projectId: string }
  | { scope: 'session'; sessionId: string }

/** Attribution recorded on a legacy single-board document. */
export interface WhiteboardDocMeta {
  /**
   * Session id whose board a legacy `scope: global` document actually was.
   * Set by the one-time migration (`migrateLegacyStore`) or by whoever wrote
   * the legacy document; a global board carrying it migrates into
   * `sessions[writtenBySessionId]` instead of `global`, so every other session
   * resolves empty.
   */
  writtenBySessionId?: string
}

/** The persisted (pre-multi-scope) single-board document, kept for migration. */
export interface WhiteboardDoc {
  /** Board version: 0 when never written, +1 per successful write. */
  version: number
  scope: WhiteboardScope
  /** Session the board applies to when `scope === 'session'`. */
  sessionId?: string
  /** Project (session cwd) the board applies to when `scope === 'project'`. */
  projectId?: string
  /** Legacy attribution; see {@link WhiteboardDocMeta}. */
  meta?: WhiteboardDocMeta
  entries: WhiteboardEntry[]
  /** Epoch ms of the last write. */
  updatedAt: number
}

/** One resolved entry, carrying the scope whose board authored it. */
export interface ResolvedEntry extends WhiteboardEntry {
  /** The authoring scope: session entries override project and global by id. */
  scope: WhiteboardScope
}

/** The resolved view one session's reads and the injected block render. */
export interface ResolvedBoard {
  /** Store version: bumps once per successful write to any scope. */
  version: number
  /** The most specific scope that contributed an entry; `global` when none did. */
  scope: WhiteboardScope
  entries: ResolvedEntry[]
  /** Latest `updatedAt` among the contributing boards. */
  updatedAt: number
}

/** The minimal board fields rendering and budget measurement read. */
export interface RenderableBoard {
  version: number
  entries: readonly WhiteboardEntry[]
}

/** Runtime-context position: after the keeper's state checkpoint (130). */
export const WHITEBOARD_CONTEXT_ORDER = 140

/** Runtime-context contribution name. */
export const WHITEBOARD_CONTEXT_NAME = 'whiteboard'

/** Runtime-context contribution header. */
export const WHITEBOARD_HEADER = '### Pinned context'

/** Hard rendered budget (doc 67 §B) — a write over it is refused, never trimmed. */
export const DEFAULT_BUDGET_TOKENS = 1500

/** How many session buckets the bounded GC keeps (newest by `updatedAt`). */
export const DEFAULT_MAX_SESSION_BOARDS = 200

/** Conservative chars-per-token estimate used for the rendered block. */
export const CHARS_PER_TOKEN = 4

/** The empty legacy board every single-doc read falls back to. */
export const EMPTY_WHITEBOARD: WhiteboardDoc = Object.freeze({
  version: 0,
  scope: 'global' as WhiteboardScope,
  entries: [] as WhiteboardEntry[],
  updatedAt: 0,
})

/** The empty per-scope board a first write starts from. */
const EMPTY_BOARD: WhiteboardBoard = Object.freeze({
  version: 0,
  entries: [] as WhiteboardEntry[],
  updatedAt: 0,
})

const KINDS: readonly WhiteboardEntryKind[] = ['path', 'rule', 'fact', 'task']
const SCOPES: readonly WhiteboardScope[] = ['session', 'project', 'global']

/** Whether a string is one of the three board scopes. */
export function isWhiteboardScope(value: unknown): value is WhiteboardScope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value)
}

/** Whether a string is one of the four entry kinds. */
export function isWhiteboardEntryKind(value: unknown): value is WhiteboardEntryKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Which host syntax an absolute path belongs to. */
export type PathSyntax = 'posix' | 'windows'

/** Why a `path` entry's text cannot be validated as one filesystem path. */
export type PathUnknownReason = 'empty' | 'multiline' | 'multiple' | 'prose' | 'glob' | 'url'

/** One `path` entry's parsed text: one identifiable path, or an unknown warning. */
export type PathTextCheck =
  | { kind: 'path'; path: string; absolute?: PathSyntax }
  | { kind: 'unknown'; reason: PathUnknownReason }

/** The host whose absolute-path rules the current lint runs under. */
function hostPathSyntax(): PathSyntax {
  return process.platform === 'win32' ? 'windows' : 'posix'
}

/** A Windows drive/UNC absolute path, accepted even when the host is POSIX. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/
/** A POSIX absolute path (`/`), accepted even when the host is Windows. */
const POSIX_ABSOLUTE = /^\//
/** A home-relative path (`~`, `~/…`, or `~\…`). */
const HOME_RELATIVE = /^~($|[\\/])/
/** A URL scheme, never a filesystem path. */
const URL_TEXT = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
/** Shell-style glob magic; unquoted text with these is a pattern, not one path. */
const GLOB_TEXT = /[*?[\]{}]/
/** A path separator, or a file extension on a bare name. */
function hasPathSignal(value: string): boolean {
  if (value.includes('/') || value.includes('\\')) return true
  const base = value.split(/[\\/]/).pop() ?? value
  const dot = base.lastIndexOf('.')
  return dot >= 0 && dot < base.length - 1
}

/** Strip one balanced outer quote pair; balanced quoting is the space-path intent marker. */
function unquotePath(text: string): { value: string; quoted: boolean } {
  const first = text[0]
  const last = text[text.length - 1]
  if (text.length >= 2 && first === last && (first === '"' || first === "'" || first === '`')) {
    const inner = text.slice(1, -1)
    if (!inner.includes(first)) return { value: inner.trim(), quoted: true }
  }
  return { value: text, quoted: false }
}

/**
 * Classify one `path` entry's text. Only a confidently identifiable single
 * filesystem path is validated; prose, lists, multiline text, URLs, and
 * unquoted glob patterns are `unknown` warnings. This keeps legacy mixed prose/path entries
 * from being falsely reported stale while still validating exact paths.
 * @param text - the entry text.
 * @returns the single path to validate, or the reason the text is not one path.
 */
export function classifyPathText(text: string): PathTextCheck {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: 'unknown', reason: 'empty' }
  if (/[\r\n]/.test(trimmed)) return { kind: 'unknown', reason: 'multiline' }
  if (/\0|[\u0000-\u001f\u007f]/.test(trimmed)) return { kind: 'unknown', reason: 'prose' }
  const unquoted = unquotePath(trimmed)
  const value = unquoted.value
  if (value.length === 0) return { kind: 'unknown', reason: 'empty' }
  if (URL_TEXT.test(value)) return { kind: 'unknown', reason: 'url' }
  // Quoting makes glob metacharacters literal: "docs/plan[1].md" and
  // "path?.md" are paths to validate, while the unquoted forms stay globs.
  if (!unquoted.quoted && GLOB_TEXT.test(value)) return { kind: 'unknown', reason: 'glob' }
  if (!unquoted.quoted && /\s/.test(value)) return { kind: 'unknown', reason: 'multiple' }
  const windows = WINDOWS_ABSOLUTE.test(value)
  const posix = POSIX_ABSOLUTE.test(value)
  const home = HOME_RELATIVE.test(value)
  // Quoting only allows spaces; a bare word (quoted or not) is not identifiable
  // as a path, so prose can never be validated as a missing file.
  if (!windows && !posix && !home && !hasPathSignal(value)) {
    return { kind: 'unknown', reason: 'prose' }
  }
  if (windows) return { kind: 'path', path: value, absolute: 'windows' }
  if (posix) return { kind: 'path', path: value, absolute: 'posix' }
  return { kind: 'path', path: value }
}

/** Whether a parsed path can be checked on the host running the lint. */
function checkableOnHost(check: Extract<PathTextCheck, { kind: 'path' }>, syntax: PathSyntax): boolean {
  return check.absolute === undefined || check.absolute === syntax
}

/** Whether a stored `path` entry's stale flag still describes a checkable single path. */
function keepsStaleFlag(entry: { kind: WhiteboardEntryKind; text: string }, syntax: PathSyntax): boolean {
  if (entry.kind !== 'path') return false
  const check = classifyPathText(entry.text)
  return check.kind === 'path' && checkableOnHost(check, syntax)
}

function finiteVersion(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/**
 * Coerce one stored entry into a well-formed entry, dropping nothing but
 * repairing absent optional fields. A value with no usable text or kind is
 * skipped by {@link normalizeBoard}.
 */
export function normalizeEntry(raw: unknown): WhiteboardEntry | undefined {
  if (!isRecord(raw)) return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const kind = isWhiteboardEntryKind(raw.kind) ? raw.kind : undefined
  if (text.length === 0 || kind === undefined) return undefined
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `wb-${Math.random().toString(36).slice(2, 10)}`
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 1
    ? Math.floor(raw.version)
    : 1
  const entry: WhiteboardEntry = {
    id,
    kind,
    text,
    pinned: raw.pinned === true,
    pinnedAt: typeof raw.pinnedAt === 'number' && Number.isFinite(raw.pinnedAt) ? raw.pinnedAt : 0,
    version,
  }
  if (typeof raw.lastValidatedAt === 'number' && Number.isFinite(raw.lastValidatedAt)) entry.lastValidatedAt = raw.lastValidatedAt
  // A stale flag and its validation timestamp are derived state. Keep them only
  // while the text is still one checkable path on this host; a legacy
  // prose/mixed entry must not inherit a false `(stale)` label or a misleading
  // validation time from the old whole-text lint.
  const keeps = keepsStaleFlag(entry, hostPathSyntax())
  if (!keeps) delete entry.lastValidatedAt
  if (raw.stale === true && keeps) entry.stale = true
  return entry
}

/**
 * Coerce one stored per-scope board. Unknown keys and malformed entries are
 * dropped, so a hand-edited settings file can never break a turn.
 * @param raw - the stored board value, if any.
 * @returns a well-formed board.
 */
export function normalizeBoard(raw: unknown): WhiteboardBoard {
  if (!isRecord(raw)) return { ...EMPTY_BOARD, entries: [] }
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(normalizeEntry).filter((entry): entry is WhiteboardEntry => entry !== undefined)
    : []
  return {
    version: finiteVersion(raw.version),
    entries,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  }
}

/**
 * Coerce the legacy single-board document. Kept for the normalizer every
 * pre-multi-scope consumer reads through; {@link normalizeStore} migrates it.
 * @param raw - the `enpoi-orchestration.whiteboard` value, if any.
 * @returns a well-formed board.
 */
export function normalizeDoc(raw: unknown): WhiteboardDoc {
  if (!isRecord(raw)) return { ...EMPTY_WHITEBOARD, entries: [] }
  const board = normalizeBoard(raw)
  const doc: WhiteboardDoc = {
    version: board.version,
    scope: isWhiteboardScope(raw.scope) ? raw.scope : 'global',
    entries: board.entries,
    updatedAt: board.updatedAt,
  }
  if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) doc.sessionId = raw.sessionId
  if (typeof raw.projectId === 'string' && raw.projectId.length > 0) doc.projectId = raw.projectId
  const writtenBySessionId = isRecord(raw.meta) && typeof raw.meta.writtenBySessionId === 'string'
    ? raw.meta.writtenBySessionId.trim()
    : ''
  if (writtenBySessionId.length > 0) doc.meta = { writtenBySessionId }
  return doc
}

/** A fresh scope bucket with no `Object.prototype` keys; arbitrary ids stay own data. */
function emptyBucket(): Record<string, WhiteboardBoard> {
  return Object.create(null) as Record<string, WhiteboardBoard>
}

/** Copy one scope bucket into a fresh null-prototype bucket (`__proto__`/`constructor` stay data). */
function copyBucket(bucket: Record<string, WhiteboardBoard>): Record<string, WhiteboardBoard> {
  const copy = emptyBucket()
  for (const key of Object.keys(bucket)) {
    const board = bucket[key]
    if (board !== undefined) copy[key] = board
  }
  return copy
}

/** Read a bucket entry only when the id is an own key, never an inherited Object member. */
function ownBoard(bucket: Record<string, WhiteboardBoard>, id: string): WhiteboardBoard | undefined {
  return Object.hasOwn(bucket, id) ? bucket[id] : undefined
}

/** The empty store every read falls back to. */
function emptyStore(): WhiteboardStore {
  return { version: 0, docs: { projects: emptyBucket(), sessions: emptyBucket() } }
}

/**
 * Place one legacy document into the bucket its own scope names. A legacy
 * `global` board carrying `meta.writtenBySessionId` is that session's board and
 * lands in its session bucket with `global` left empty — the one-time
 * attribution migration, deterministic and idempotent (a bucket-shaped
 * document never reaches here).
 * @param legacy - the normalized legacy document.
 * @returns the migrated store.
 */
function legacyStore(legacy: WhiteboardDoc): WhiteboardStore {
  const store = emptyStore()
  store.version = legacy.version
  const board: WhiteboardBoard = { version: legacy.version, entries: legacy.entries, updatedAt: legacy.updatedAt }
  if (legacy.scope === 'project' && legacy.projectId !== undefined) store.docs.projects[legacy.projectId] = board
  else if (legacy.scope === 'session' && legacy.sessionId !== undefined) store.docs.sessions[legacy.sessionId] = board
  else if (legacy.meta?.writtenBySessionId !== undefined) store.docs.sessions[legacy.meta.writtenBySessionId] = board
  else store.docs.global = board
  return store
}

/**
 * Coerce the settings value into the multi-scope store. A legacy single-board
 * document migrates into the bucket its own scope names (a session board into
 * `sessions[<id>]`, a project board into `projects[<cwd>]`, else — when a
 * `meta.writtenBySessionId` attribution is present — that session's bucket,
 * otherwise `global`), so an old document never leaks into sessions it did not
 * cover.
 * @param raw - the `enpoi-orchestration.whiteboard` value, if any.
 * @returns a well-formed store.
 */
export function normalizeStore(raw: unknown): WhiteboardStore {
  if (!isRecord(raw)) return emptyStore()
  if (isRecord(raw.docs)) {
    const store = emptyStore()
    store.version = finiteVersion(raw.version)
    const docs = raw.docs
    if (Object.hasOwn(docs, 'global') && isRecord(docs.global)) store.docs.global = normalizeBoard(docs.global)
    for (const bucket of ['projects', 'sessions'] as const) {
      if (!Object.hasOwn(docs, bucket)) continue
      const value = docs[bucket]
      if (!isRecord(value)) continue
      const target = store.docs[bucket]
      for (const key of Object.keys(value)) {
        const board = value[key]
        if (key.length === 0 || !isRecord(board)) continue
        target[key] = normalizeBoard(board)
      }
    }
    return store
  }
  return legacyStore(normalizeDoc(raw))
}

/** Result of the one-time legacy migration. */
export interface LegacyMigrationResult {
  /** The store in bucket shape. */
  store: WhiteboardStore
  /** True when the input was a legacy single-board document and was migrated. */
  migrated: boolean
  /** Sessions bucket the legacy global board was attributed to, when it was. */
  attributedTo?: string
  /** Entries carried by the legacy board (0 for an already bucket-shaped input). */
  entries: number
}

/**
 * Migrate a legacy single-board document into the bucket shape, attributing a
 * legacy `global` board to a session. Deterministic and idempotent: a document
 * that already carries `docs` is only normalized. The attribution comes from
 * `meta.writtenBySessionId` when present, or from `attributeToSessionId` (the
 * caller's one-time knowledge of who wrote the legacy board).
 * @param raw - the raw `enpoi-orchestration.whiteboard` value.
 * @param attributeToSessionId - session to attribute a legacy global board to when it carries none.
 * @returns the migrated store, whether a migration ran, and the attributed session.
 */
export function migrateLegacyStore(raw: unknown, attributeToSessionId?: string): LegacyMigrationResult {
  if (!isRecord(raw)) return { store: normalizeStore(raw), migrated: false, entries: 0 }
  if (isRecord(raw.docs)) {
    return { store: normalizeStore(raw), migrated: false, entries: 0 }
  }
  const doc = normalizeDoc(raw)
  let attributedTo = doc.scope === 'global' && doc.meta?.writtenBySessionId !== undefined
    ? doc.meta.writtenBySessionId
    : undefined
  if (attributedTo === undefined && doc.scope === 'global'
    && typeof attributeToSessionId === 'string' && attributeToSessionId.length > 0) {
    doc.meta = { ...doc.meta, writtenBySessionId: attributeToSessionId }
    attributedTo = attributeToSessionId
  }
  return {
    store: legacyStore(doc),
    migrated: true,
    entries: doc.entries.length,
    ...(attributedTo === undefined ? {} : { attributedTo }),
  }
}

/** The stored board one target reads, if it has been written yet. */
export function readBoard(store: WhiteboardStore, target: WhiteboardTarget): WhiteboardBoard | undefined {
  if (target.scope === 'global') return store.docs.global
  if (target.scope === 'project') return ownBoard(store.docs.projects, target.projectId)
  return ownBoard(store.docs.sessions, target.sessionId)
}

/** Copy-on-write placement of one board into its scope bucket. */
export function writeBoard(store: WhiteboardStore, target: WhiteboardTarget, board: WhiteboardBoard): WhiteboardStore {
  const docs: WhiteboardStore['docs'] = {
    ...store.docs,
    projects: copyBucket(store.docs.projects),
    sessions: copyBucket(store.docs.sessions),
  }
  if (target.scope === 'global') docs.global = board
  else if (target.scope === 'project') docs.projects[target.projectId] = board
  else docs.sessions[target.sessionId] = board
  return { ...store, docs }
}

/** The scope facts one assembly resolves the board against. */
export interface BoardScopeFacts {
  /** The assembling agent's session id. */
  sessionId?: string
  /** The assembling session's durable parent session id (direct-child inheritance). */
  parentSessionId?: string
  /** The assembling session's project identity (session cwd). */
  projectId?: string
}

/**
 * Resolve the store for one assembly. Global entries come first, then the
 * matching project's, then the parent session's (direct-child inheritance),
 * then the session's own; a later scope overriding an earlier entry with the
 * same id. Each resolved entry reports its authoring scope, so a caller can
 * tell a session override from a global default.
 * @param store - the normalized store.
 * @param facts - the assembly's scope facts.
 * @returns the resolved view (empty entries when nothing matches).
 */
export function resolveBoard(store: WhiteboardStore, facts: BoardScopeFacts): ResolvedBoard {
  const layers: Array<{ scope: WhiteboardScope; board: WhiteboardBoard | undefined }> = [
    { scope: 'global', board: store.docs.global },
  ]
  if (facts.projectId !== undefined) layers.push({ scope: 'project', board: ownBoard(store.docs.projects, facts.projectId) })
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId) {
    layers.push({ scope: 'session', board: ownBoard(store.docs.sessions, facts.parentSessionId) })
  }
  if (facts.sessionId !== undefined) layers.push({ scope: 'session', board: ownBoard(store.docs.sessions, facts.sessionId) })
  const merged = new Map<string, ResolvedEntry>()
  let scope: WhiteboardScope = 'global'
  let updatedAt = 0
  for (const layer of layers) {
    const board = layer.board
    if (board === undefined || board.entries.length === 0) continue
    scope = layer.scope
    if (board.updatedAt > updatedAt) updatedAt = board.updatedAt
    for (const entry of board.entries) merged.set(entry.id, { ...entry, scope: layer.scope })
  }
  return { version: store.version, scope, entries: [...merged.values()], updatedAt }
}

/**
 * Find the scope whose board authored one resolved entry, most specific first
 * (own session, parent session, project, global). Pin/unpin commits there.
 * @param store - the normalized store.
 * @param facts - the caller's scope facts.
 * @param id - the entry id from a resolved read.
 * @returns the owning target, or `undefined` when no layer has the id.
 */
export function findEntryTarget(store: WhiteboardStore, facts: BoardScopeFacts, id: string): WhiteboardTarget | undefined {
  const has = (board: WhiteboardBoard | undefined): boolean => board !== undefined && board.entries.some((entry) => entry.id === id)
  if (facts.sessionId !== undefined && has(ownBoard(store.docs.sessions, facts.sessionId))) {
    return { scope: 'session', sessionId: facts.sessionId }
  }
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId
    && has(ownBoard(store.docs.sessions, facts.parentSessionId))) {
    return { scope: 'session', sessionId: facts.parentSessionId }
  }
  if (facts.projectId !== undefined && has(ownBoard(store.docs.projects, facts.projectId))) {
    return { scope: 'project', projectId: facts.projectId }
  }
  if (has(store.docs.global)) return { scope: 'global' }
  return undefined
}

/**
 * Render a board as the exact text injected into the runtime-context snapshot.
 * Compact by construction: one line per entry, pinned first. The header carries
 * no version: a store version bump that leaves every entry unchanged must not
 * churn the injected block. Renders a resolved board and a stored board alike.
 * @param doc - the board to render.
 * @returns the block, or `''` when the board holds no entries.
 */
export function renderWhiteboard(doc: RenderableBoard): string {
  if (doc.entries.length === 0) return ''
  const lines = doc.entries
    .slice()
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return 0
    })
    .map((entry) => {
      const marker = entry.pinned ? '📌 ' : ''
      const stale = entry.stale === true ? ' (stale)' : ''
      return `- ${marker}[${entry.kind}] ${entry.text}${stale}`
    })
  return `${WHITEBOARD_HEADER}\n${lines.join('\n')}`
}

/** Character count of a rendered board, counted in code points (multibyte-safe). */
export function boardChars(rendered: string): number {
  return Array.from(rendered).length
}

/**
 * Estimate the rendered board's token cost. Conservative (4 chars/token) so the
 * hard budget refuses before a real tokenizer would overflow.
 * @param rendered - the exact injected text.
 * @returns estimated tokens, ceiling-rounded.
 */
export function estimateTokens(rendered: string): number {
  return Math.ceil(boardChars(rendered) / CHARS_PER_TOKEN)
}

/** The rendered character limit for a token budget. */
export function budgetChars(budgetTokens: number): number {
  return Math.max(0, Math.floor(budgetTokens)) * CHARS_PER_TOKEN
}

/** Result of one budget check. */
export interface BudgetCheck {
  ok: boolean
  tokens: number
  budget: number
  chars: number
  limit: number
}

/**
 * Check a complete rendered board against the hard budget. Writes run this over
 * the resolved view their scope target resolves to, so a session entry cannot
 * push a session's injected block over the limit.
 * @param doc - the candidate board (stored or resolved).
 * @param budgetTokens - the configured hard budget.
 * @returns the check with the exact numbers for the refusal message.
 */
export function checkBudget(doc: RenderableBoard, budgetTokens: number): BudgetCheck {
  const chars = boardChars(renderWhiteboard(doc))
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN)
  const limit = budgetChars(budgetTokens)
  return { ok: chars <= limit, tokens, budget: budgetTokens, chars, limit }
}

/** One requested entry for a write. */
export interface WhiteboardWriteRequest {
  id?: string
  kind: WhiteboardEntryKind
  text: string
  pinned?: boolean
  /** Set for `mode: 'replace'` rows: the entry id to replace. */
  replaceId?: string
}

/** Result of linting path entries against the filesystem. */
export interface LintResult<T> {
  doc: T
  /** Ids of single-path entries that no longer resolve. */
  stale: string[]
  /** Ids of path entries whose text is prose, a list, a URL, or a glob — a warning, never stale. */
  unknown: string[]
}

/**
 * Validate exactly the `path` entries whose text is one identifiable filesystem
 * path. Prose, path lists, multiline text, URLs, unquoted glob patterns, and
 * absolute paths for another host are reported as `unknown` warnings and left unstale;
 * their text is never rewritten or deleted. Stale entries stay in the board
 * (flagged, never deleted) so the operator can repoint or forget them. Generic
 * over stored and resolved boards: only `entries` is rewritten, every other
 * field (including per-entry scope) survives.
 * @param doc - the board to lint.
 * @param resolvePath - maps one parsed path to its host-usable path.
 * @param exists - filesystem predicate (`fs.existsSync` in production).
 * @param now - epoch ms stamped into `lastValidatedAt` for checked entries.
 * @param syntax - host absolute-path syntax; defaults to the running platform.
 * @returns the linted board, stale ids, and unknown-path ids.
 */
export function lintPaths<T extends { entries: readonly WhiteboardEntry[] }>(
  doc: T,
  resolvePath: (entry: WhiteboardEntry, path: string) => string,
  exists: (path: string) => boolean,
  now: number,
  syntax: PathSyntax = hostPathSyntax(),
): LintResult<T> {
  const stale: string[] = []
  const unknown: string[] = []
  const entries = doc.entries.map((entry): WhiteboardEntry => {
    if (entry.kind !== 'path') return entry
    const check = classifyPathText(entry.text)
    if (check.kind === 'unknown' || !checkableOnHost(check, syntax)) {
      const next = { ...entry }
      delete next.stale
      delete next.lastValidatedAt
      unknown.push(entry.id)
      return next
    }
    let resolved: string
    try {
      resolved = resolvePath(entry, check.path)
    } catch {
      const next = { ...entry }
      delete next.stale
      delete next.lastValidatedAt
      unknown.push(entry.id)
      return next
    }
    if (resolved.length === 0) {
      const next = { ...entry }
      delete next.stale
      delete next.lastValidatedAt
      unknown.push(entry.id)
      return next
    }
    const present = exists(resolved)
    const next: WhiteboardEntry = { ...entry, lastValidatedAt: now }
    if (present) delete next.stale
    else {
      next.stale = true
      stale.push(entry.id)
    }
    return next
  })
  return { doc: { ...doc, entries: entries as T['entries'] }, stale, unknown }
}

/** Refusal for a new `path` entry that is not exactly one filesystem path. */
const ONE_PATH_REFUSAL = 'path entries require exactly one filesystem path (no prose, lists, multiline text, URLs, or unquoted globs); quote a path containing spaces or glob metacharacters and use one entry per path'

/** Validate newly authored `path` text; unchanged legacy text is never re-judged. */
function validatePathText(text: string): string | undefined {
  return classifyPathText(text).kind === 'path' ? undefined : ONE_PATH_REFUSAL
}

/**
 * Apply a batch of write requests to one stored board: `append` adds new
 * entries, `replace` overwrites entries by id and bumps their version. A write
 * that would leave an entry's kind, text, and pinned flag unchanged is a
 * deterministic no-op: it is not re-versioned and does not make the caller
 * write or re-render the board. The caller owns the board-version bump, budget,
 * and path lint — this function is the pure entry transition.
 * @param board - the current stored board.
 * @param requests - entries to write.
 * @param mode - `append` (default) or `replace` by id.
 * @param now - epoch ms stamped on new entries.
 * @returns the next board and the ids that actually changed, or a refusal.
 */
export function applyWrites(
  board: WhiteboardBoard,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  now: number,
): { ok: true; board: WhiteboardBoard; changedIds: string[] } | { ok: false; message: string } {
  const entries = board.entries.map((entry) => ({ ...entry }))
  const changedIds: string[] = []
  for (const request of requests) {
    if (!isWhiteboardEntryKind(request.kind)) return { ok: false, message: `unknown entry kind "${String(request.kind)}"` }
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (text.length === 0) return { ok: false, message: 'entry text must be a non-empty string' }
    if (mode === 'replace') {
      const id = request.replaceId ?? request.id
      if (typeof id !== 'string' || id.length === 0) return { ok: false, message: 'mode "replace" requires each entry to carry the id it replaces' }
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return { ok: false, message: `no entry with id "${id}" to replace` }
      const previous = entries[index]!
      const pinned = request.pinned ?? previous.pinned
      if (previous.kind === request.kind && previous.text === text && previous.pinned === pinned) continue
      if (request.kind === 'path' && (previous.kind !== 'path' || previous.text !== text)) {
        const invalid = validatePathText(text)
        if (invalid !== undefined) return { ok: false, message: invalid }
      }
      const next: WhiteboardEntry = {
        id,
        kind: request.kind,
        text,
        pinned,
        pinnedAt: request.pinned === true && previous.pinned !== true ? now : previous.pinnedAt,
        version: previous.version + 1,
      }
      entries[index] = next
      changedIds.push(id)
      continue
    }
    const id = typeof request.id === 'string' && request.id.length > 0
      ? request.id
      : `wb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const duplicate = entries.find((entry) => entry.id === id)
    if (duplicate !== undefined) {
      // Repeating the same entry is a no-op; a different body still asks for replace.
      if (duplicate.kind === request.kind && duplicate.text === text
        && (request.pinned === undefined || request.pinned === duplicate.pinned)) continue
      return { ok: false, message: `entry id "${id}" already exists — use mode "replace" to overwrite it` }
    }
    if (request.kind === 'path') {
      const invalid = validatePathText(text)
      if (invalid !== undefined) return { ok: false, message: invalid }
    }
    entries.push({
      id,
      kind: request.kind,
      text,
      pinned: request.pinned === true,
      pinnedAt: request.pinned === true ? now : 0,
      version: 1,
    })
    changedIds.push(id)
  }
  return { ok: true, board: { ...board, entries }, changedIds }
}

/**
 * Apply writes to one scope bucket. A semantic change bumps that board's
 * version and `updatedAt`; an identical-content write leaves the store
 * bit-identical and reports no changed ids, so no settings commit or context
 * re-render follows.
 * @param store - the current store.
 * @param target - the scope bucket to write.
 * @param requests - entries to write.
 * @param mode - `append` (default) or `replace` by id.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store and changed ids, or a refusal message.
 */
export function applyStoreWrites(
  store: WhiteboardStore,
  target: WhiteboardTarget,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  now: number,
): { ok: true; store: WhiteboardStore; changedIds: string[] } | { ok: false; message: string } {
  const current = readBoard(store, target) ?? EMPTY_BOARD
  const applied = applyWrites(current, requests, mode, now)
  if (!applied.ok) return applied
  if (applied.changedIds.length === 0) return { ok: true, store, changedIds: [] }
  const board: WhiteboardBoard = { ...applied.board, version: current.version + 1, updatedAt: now }
  return { ok: true, store: writeBoard(store, target, board), changedIds: applied.changedIds }
}

/**
 * Toggle one entry's pinned flag in its authoring board. Unpin is the only way
 * to make an entry compactable; it never deletes anything. Setting the flag it
 * already has is a no-op.
 * @param board - the current stored board.
 * @param id - the entry id.
 * @param pinned - the flag to set.
 * @param now - epoch ms for `pinnedAt`.
 * @returns the next board and whether it changed, or an error message.
 */
export function setPinned(
  board: WhiteboardBoard,
  id: string,
  pinned: boolean,
  now: number,
): { ok: true; board: WhiteboardBoard; changed: boolean } | { ok: false; message: string } {
  const index = board.entries.findIndex((entry) => entry.id === id)
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` }
  const previous = board.entries[index]!
  if (previous.pinned === pinned) return { ok: true, board, changed: false }
  const entries = board.entries.map((entry, at) => (at === index
    ? { ...entry, pinned, pinnedAt: pinned ? now : entry.pinnedAt }
    : { ...entry }))
  return { ok: true, board: { ...board, entries }, changed: true }
}

/**
 * Toggle one entry's pinned flag in the scope bucket that authored it. A
 * repeated pin/unpin leaves the store untouched.
 * @param store - the current store.
 * @param target - the authoring scope bucket (from {@link findEntryTarget}).
 * @param id - the entry id.
 * @param pinned - the flag to set.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store and whether it changed, or an error message.
 */
export function setStorePinned(
  store: WhiteboardStore,
  target: WhiteboardTarget,
  id: string,
  pinned: boolean,
  now: number,
): { ok: true; store: WhiteboardStore; changed: boolean } | { ok: false; message: string } {
  const current = readBoard(store, target)
  if (current === undefined) return { ok: false, message: `no entry with id "${id}"` }
  const pinnedResult = setPinned(current, id, pinned, now)
  if (!pinnedResult.ok) return pinnedResult
  if (!pinnedResult.changed) return { ok: true, store, changed: false }
  const board: WhiteboardBoard = { ...pinnedResult.board, version: current.version + 1, updatedAt: now }
  return { ok: true, store: writeBoard(store, target, board), changed: true }
}

/**
 * Delete one entry from a stored board. The removed entry is returned in full,
 * so a forget is never a silent drop. The caller owns the board-version bump.
 * @param board - the current stored board.
 * @param id - the entry id.
 * @param now - epoch ms stamped on the board.
 * @returns the next board plus the removed entry, or an error message.
 */
export function removeEntry(
  board: WhiteboardBoard,
  id: string,
  now: number,
): { ok: true; board: WhiteboardBoard; removed: WhiteboardEntry } | { ok: false; message: string } {
  const index = board.entries.findIndex((entry) => entry.id === id)
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` }
  const removed = { ...board.entries[index]! }
  const entries = board.entries.filter((_, at) => at !== index).map((entry) => ({ ...entry }))
  return { ok: true, board: { ...board, entries, updatedAt: now }, removed }
}

/**
 * Delete one entry from the scope bucket that authored it and bump that
 * board's version, mirroring {@link setStorePinned}'s authoring-board lookup.
 * @param store - the current store.
 * @param target - the authoring scope bucket (from {@link findEntryTarget}).
 * @param id - the entry id.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store plus the removed entry, or an error message.
 */
export function removeStoreEntry(
  store: WhiteboardStore,
  target: WhiteboardTarget,
  id: string,
  now: number,
): { ok: true; store: WhiteboardStore; removed: WhiteboardEntry } | { ok: false; message: string } {
  const current = readBoard(store, target)
  if (current === undefined) return { ok: false, message: `no entry with id "${id}"` }
  const removal = removeEntry(current, id, now)
  if (!removal.ok) return removal
  const board: WhiteboardBoard = { ...removal.board, version: current.version + 1, updatedAt: now }
  return { ok: true, store: writeBoard(store, target, board), removed: removal.removed }
}

/**
 * Bounded GC for session buckets: keep only the `limit` most recently updated
 * boards, dropping the oldest by `updatedAt` (ties broken by session id).
 * Dropped board text is returned by id, never silently discarded.
 * @param store - the current store.
 * @param limit - how many session boards to keep.
 * @returns the next store and the dropped session ids.
 */
export function sweepSessionBoards(
  store: WhiteboardStore,
  limit: number,
): { store: WhiteboardStore; dropped: string[] } {
  const ids = Object.keys(store.docs.sessions)
  if (!Number.isFinite(limit) || ids.length <= Math.max(0, Math.floor(limit))) return { store, dropped: [] }
  const ordered = [...ids].sort((left, right) => {
    const leftAt = ownBoard(store.docs.sessions, left)?.updatedAt ?? 0
    const rightAt = ownBoard(store.docs.sessions, right)?.updatedAt ?? 0
    if (leftAt !== rightAt) return leftAt - rightAt
    return left < right ? -1 : 1
  })
  const dropped = ordered.slice(0, ids.length - Math.max(0, Math.floor(limit)))
  const sessions = copyBucket(store.docs.sessions)
  for (const id of dropped) delete sessions[id]
  return { store: { ...store, docs: { ...store.docs, sessions } }, dropped }
}

/** The minimal fields the freshness line reads. */
export interface VersionLineFacts {
  version: number
  scope: WhiteboardScope
  updatedAt: number
}

/** The board's freshness line, recorded by every spawn whose request carries it. */
export function versionLine(doc: VersionLineFacts): string {
  return `${WHITEBOARD_HEADER} v${doc.version} (${doc.scope}${doc.updatedAt > 0 ? ` · updated ${new Date(doc.updatedAt).toISOString()}` : ''})`
}
