/**
 * enpoi-whiteboard — pinned-board vocabulary: per-scope storage, resolution,
 * normalization, rendering, the hard token budget, and the path/staleness lint.
 * Pure functions only; the settings transport, tools and runtime-context
 * injection live in ./index.ts.
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
 * Resolution contract: a read merges global → project (matching the session
 * cwd) → parent session (direct-child inheritance) → session (matching the
 * session id), later scopes overriding earlier ones by entry id, and reports
 * each resolved entry's authoring scope. The injected block is that resolved
 * view (session entries plus explicitly shared project/global ones); the
 * Watchtower card's primary surface is session-only, with shared entries in a
 * collapsed disclosure.
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
  /** The entry text (one compact line; `path` entries are project-relative paths). */
  text: string
  /** Pinned entries are never trimmed by an explicit compact; unpinned ones may be. */
  pinned: boolean
  /** Epoch ms the entry was (last) pinned; 0 when never pinned. */
  pinnedAt: number
  /** Entry version: 1 at creation, +1 per replace-by-id. */
  version: number
  /** Epoch ms of the last path validation. */
  lastValidatedAt?: number
  /** Set when a `path` entry no longer resolves; cleared when it does again. */
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
  if (raw.stale === true) entry.stale = true
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

/** The empty store every read falls back to. */
function emptyStore(): WhiteboardStore {
  return { version: 0, docs: { projects: {}, sessions: {} } }
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
    if (isRecord(raw.docs.global)) store.docs.global = normalizeBoard(raw.docs.global)
    for (const bucket of ['projects', 'sessions'] as const) {
      const value = raw.docs[bucket]
      if (!isRecord(value)) continue
      for (const [key, board] of Object.entries(value)) {
        if (key.length === 0 || !isRecord(board)) continue
        store.docs[bucket][key] = normalizeBoard(board)
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
  if (target.scope === 'project') return store.docs.projects[target.projectId]
  return store.docs.sessions[target.sessionId]
}

/** Copy-on-write placement of one board into its scope bucket. */
export function writeBoard(store: WhiteboardStore, target: WhiteboardTarget, board: WhiteboardBoard): WhiteboardStore {
  const docs: WhiteboardStore['docs'] = {
    ...store.docs,
    projects: { ...store.docs.projects },
    sessions: { ...store.docs.sessions },
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
  if (facts.projectId !== undefined) layers.push({ scope: 'project', board: store.docs.projects[facts.projectId] })
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId) {
    layers.push({ scope: 'session', board: store.docs.sessions[facts.parentSessionId] })
  }
  if (facts.sessionId !== undefined) layers.push({ scope: 'session', board: store.docs.sessions[facts.sessionId] })
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
  if (facts.sessionId !== undefined && has(store.docs.sessions[facts.sessionId])) {
    return { scope: 'session', sessionId: facts.sessionId }
  }
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId
    && has(store.docs.sessions[facts.parentSessionId])) {
    return { scope: 'session', sessionId: facts.parentSessionId }
  }
  if (facts.projectId !== undefined && has(store.docs.projects[facts.projectId])) {
    return { scope: 'project', projectId: facts.projectId }
  }
  if (has(store.docs.global)) return { scope: 'global' }
  return undefined
}

/**
 * Render a board as the exact text injected into the runtime-context snapshot.
 * Compact by construction: one line per entry, pinned first. Renders a resolved
 * board and a stored board alike (both carry version + entries).
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
  return `${WHITEBOARD_HEADER} (v${doc.version})\n${lines.join('\n')}`
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
  /** Ids of path entries that no longer resolve. */
  stale: string[]
}

/**
 * Validate every `path` entry against the filesystem and flag the missing ones.
 * Stale entries stay in the board (flagged, never deleted) so the operator can
 * see and prune them. Generic over stored and resolved boards: only `entries`
 * is rewritten, every other field (including per-entry scope) survives.
 * @param doc - the board to lint.
 * @param resolvePath - maps an entry text to an absolute path.
 * @param exists - filesystem predicate (`fs.existsSync` in production).
 * @param now - epoch ms stamped into `lastValidatedAt`.
 * @returns the linted board and the stale ids.
 */
export function lintPaths<T extends { entries: readonly WhiteboardEntry[] }>(
  doc: T,
  resolvePath: (entry: WhiteboardEntry) => string,
  exists: (path: string) => boolean,
  now: number,
): LintResult<T> {
  const stale: string[] = []
  const entries = doc.entries.map((entry): WhiteboardEntry => {
    if (entry.kind !== 'path') return entry
    let resolved: string
    try {
      resolved = resolvePath(entry)
    } catch {
      resolved = entry.text
    }
    const present = resolved.length > 0 && exists(resolved)
    const next: WhiteboardEntry = { ...entry, lastValidatedAt: now }
    if (present) delete next.stale
    else {
      next.stale = true
      stale.push(entry.id)
    }
    return next
  })
  return { doc: { ...doc, entries: entries as T['entries'] }, stale }
}

/**
 * Apply a batch of write requests to one stored board: `append` adds new
 * entries (an explicit id must be unused), `replace` overwrites entries by id
 * and bumps their version. The caller owns the board-version bump, budget, and
 * path lint — this function is the pure entry transition.
 * @param board - the current stored board.
 * @param requests - entries to write.
 * @param mode - `append` (default) or `replace` by id.
 * @param now - epoch ms stamped on new entries.
 * @returns the next board, or a refusal message.
 */
export function applyWrites(
  board: WhiteboardBoard,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  now: number,
): { ok: true; board: WhiteboardBoard } | { ok: false; message: string } {
  const entries = board.entries.map((entry) => ({ ...entry }))
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
      const next: WhiteboardEntry = {
        id,
        kind: request.kind,
        text,
        pinned: request.pinned ?? previous.pinned,
        pinnedAt: request.pinned === true && previous.pinned !== true ? now : previous.pinnedAt,
        version: previous.version + 1,
      }
      entries[index] = next
      continue
    }
    const id = typeof request.id === 'string' && request.id.length > 0
      ? request.id
      : `wb-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    if (entries.some((entry) => entry.id === id)) {
      return { ok: false, message: `entry id "${id}" already exists — use mode "replace" to overwrite it` }
    }
    entries.push({
      id,
      kind: request.kind,
      text,
      pinned: request.pinned === true,
      pinnedAt: request.pinned === true ? now : 0,
      version: 1,
    })
  }
  return { ok: true, board: { ...board, entries } }
}

/**
 * Apply writes to one scope bucket and bump that board's version.
 * @param store - the current store.
 * @param target - the scope bucket to write.
 * @param requests - entries to write.
 * @param mode - `append` (default) or `replace` by id.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store, or a refusal message.
 */
export function applyStoreWrites(
  store: WhiteboardStore,
  target: WhiteboardTarget,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  now: number,
): { ok: true; store: WhiteboardStore } | { ok: false; message: string } {
  const current = readBoard(store, target) ?? EMPTY_BOARD
  const applied = applyWrites(current, requests, mode, now)
  if (!applied.ok) return applied
  const board: WhiteboardBoard = { ...applied.board, version: current.version + 1, updatedAt: now }
  return { ok: true, store: writeBoard(store, target, board) }
}

/**
 * Toggle one entry's pinned flag in its authoring board and bump the board
 * version. Unpin is the only way to make an entry compactable; it never
 * deletes anything.
 * @param board - the current stored board.
 * @param id - the entry id.
 * @param pinned - the flag to set.
 * @param now - epoch ms for `pinnedAt`.
 * @returns the next board, or an error message.
 */
export function setPinned(
  board: WhiteboardBoard,
  id: string,
  pinned: boolean,
  now: number,
): { ok: true; board: WhiteboardBoard } | { ok: false; message: string } {
  const index = board.entries.findIndex((entry) => entry.id === id)
  if (index === -1) return { ok: false, message: `no entry with id "${id}"` }
  const entries = board.entries.map((entry, at) => (at === index
    ? { ...entry, pinned, pinnedAt: pinned ? now : entry.pinnedAt }
    : { ...entry }))
  return { ok: true, board: { ...board, entries } }
}

/**
 * Toggle one entry's pinned flag in the scope bucket that authored it.
 * @param store - the current store.
 * @param target - the authoring scope bucket (from {@link findEntryTarget}).
 * @param id - the entry id.
 * @param pinned - the flag to set.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store, or an error message.
 */
export function setStorePinned(
  store: WhiteboardStore,
  target: WhiteboardTarget,
  id: string,
  pinned: boolean,
  now: number,
): { ok: true; store: WhiteboardStore } | { ok: false; message: string } {
  const current = readBoard(store, target)
  if (current === undefined) return { ok: false, message: `no entry with id "${id}"` }
  const pinnedResult = setPinned(current, id, pinned, now)
  if (!pinnedResult.ok) return pinnedResult
  const board: WhiteboardBoard = { ...pinnedResult.board, version: current.version + 1, updatedAt: now }
  return { ok: true, store: writeBoard(store, target, board) }
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
    const leftAt = store.docs.sessions[left]?.updatedAt ?? 0
    const rightAt = store.docs.sessions[right]?.updatedAt ?? 0
    if (leftAt !== rightAt) return leftAt - rightAt
    return left < right ? -1 : 1
  })
  const dropped = ordered.slice(0, ids.length - Math.max(0, Math.floor(limit)))
  const sessions = { ...store.docs.sessions }
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
