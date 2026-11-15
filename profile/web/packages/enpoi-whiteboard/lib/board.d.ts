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
export type WhiteboardScope = 'session' | 'project' | 'global';
/** One entry kind. `path` is the only kind validated against the filesystem. */
export type WhiteboardEntryKind = 'path' | 'rule' | 'fact' | 'task';
/** One pinned-board entry. */
export interface WhiteboardEntry {
    /** Stable entry id; the handle for pin/unpin/replace-by-id. */
    id: string;
    kind: WhiteboardEntryKind;
    /** The entry text. New `path` writes name exactly one filesystem path; legacy mixed text is preserved and reported unverified. */
    text: string;
    /** Pinned entries are never trimmed by an explicit compact; unpinned ones may be. */
    pinned: boolean;
    /** Epoch ms the entry was (last) pinned; 0 when never pinned. */
    pinnedAt: number;
    /** Entry version: 1 at creation, +1 per replace-by-id. */
    version: number;
    /** Epoch ms of the last checkable path validation; cleared when the text is not a checkable single path. */
    lastValidatedAt?: number;
    /** Set when a `path` entry is one checkable path that no longer resolves; cleared when it resolves again or stops being one path. */
    stale?: boolean;
}
/** One scope's stored board. */
export interface WhiteboardBoard {
    /** Board version: 0 when never written, +1 per successful write to this board. */
    version: number;
    entries: WhiteboardEntry[];
    /** Epoch ms of the last write to this board. */
    updatedAt: number;
}
/** The normalized multi-scope store under `enpoi-orchestration.whiteboard`. */
export interface WhiteboardStore {
    /** Store version: 0 when never written, +1 per successful write. */
    version: number;
    docs: {
        global?: WhiteboardBoard;
        projects: Record<string, WhiteboardBoard>;
        sessions: Record<string, WhiteboardBoard>;
    };
}
/** One storage bucket a write can target. */
export type WhiteboardTarget = {
    scope: 'global';
} | {
    scope: 'project';
    projectId: string;
} | {
    scope: 'session';
    sessionId: string;
};
/** Attribution recorded on a legacy single-board document. */
export interface WhiteboardDocMeta {
    /**
     * Session id whose board a legacy `scope: global` document actually was.
     * Set by the one-time migration (`migrateLegacyStore`) or by whoever wrote
     * the legacy document; a global board carrying it migrates into
     * `sessions[writtenBySessionId]` instead of `global`, so every other session
     * resolves empty.
     */
    writtenBySessionId?: string;
}
/** The persisted (pre-multi-scope) single-board document, kept for migration. */
export interface WhiteboardDoc {
    /** Board version: 0 when never written, +1 per successful write. */
    version: number;
    scope: WhiteboardScope;
    /** Session the board applies to when `scope === 'session'`. */
    sessionId?: string;
    /** Project (session cwd) the board applies to when `scope === 'project'`. */
    projectId?: string;
    /** Legacy attribution; see {@link WhiteboardDocMeta}. */
    meta?: WhiteboardDocMeta;
    entries: WhiteboardEntry[];
    /** Epoch ms of the last write. */
    updatedAt: number;
}
/** One resolved entry, carrying the scope whose board authored it. */
export interface ResolvedEntry extends WhiteboardEntry {
    /** The authoring scope: session entries override project and global by id. */
    scope: WhiteboardScope;
}
/** The resolved view one session's reads and the injected block render. */
export interface ResolvedBoard {
    /** Store version: bumps once per successful write to any scope. */
    version: number;
    /** The most specific scope that contributed an entry; `global` when none did. */
    scope: WhiteboardScope;
    entries: ResolvedEntry[];
    /** Latest `updatedAt` among the contributing boards. */
    updatedAt: number;
}
/** The minimal board fields rendering and budget measurement read. */
export interface RenderableBoard {
    version: number;
    entries: readonly WhiteboardEntry[];
}
/** Runtime-context position: after the keeper's state checkpoint (130). */
export declare const WHITEBOARD_CONTEXT_ORDER = 140;
/** Runtime-context contribution name. */
export declare const WHITEBOARD_CONTEXT_NAME = "whiteboard";
/** Runtime-context contribution header. */
export declare const WHITEBOARD_HEADER = "### Pinned context";
/** Hard rendered budget (doc 67 §B) — a write over it is refused, never trimmed. */
export declare const DEFAULT_BUDGET_TOKENS = 1500;
/** How many session buckets the bounded GC keeps (newest by `updatedAt`). */
export declare const DEFAULT_MAX_SESSION_BOARDS = 200;
/** Conservative chars-per-token estimate used for the rendered block. */
export declare const CHARS_PER_TOKEN = 4;
/** The empty legacy board every single-doc read falls back to. */
export declare const EMPTY_WHITEBOARD: WhiteboardDoc;
/** Whether a string is one of the three board scopes. */
export declare function isWhiteboardScope(value: unknown): value is WhiteboardScope;
/** Whether a string is one of the four entry kinds. */
export declare function isWhiteboardEntryKind(value: unknown): value is WhiteboardEntryKind;
/** Which host syntax an absolute path belongs to. */
export type PathSyntax = 'posix' | 'windows';
/** Why a `path` entry's text cannot be validated as one filesystem path. */
export type PathUnknownReason = 'empty' | 'multiline' | 'multiple' | 'prose' | 'glob' | 'url';
/** One `path` entry's parsed text: one identifiable path, or an unknown warning. */
export type PathTextCheck = {
    kind: 'path';
    path: string;
    absolute?: PathSyntax;
} | {
    kind: 'unknown';
    reason: PathUnknownReason;
};
/**
 * Classify one `path` entry's text. Only a confidently identifiable single
 * filesystem path is validated; prose, lists, multiline text, URLs, and
 * unquoted glob patterns are `unknown` warnings. This keeps legacy mixed prose/path entries
 * from being falsely reported stale while still validating exact paths.
 * @param text - the entry text.
 * @returns the single path to validate, or the reason the text is not one path.
 */
export declare function classifyPathText(text: string): PathTextCheck;
/**
 * Coerce one stored entry into a well-formed entry, dropping nothing but
 * repairing absent optional fields. A value with no usable text or kind is
 * skipped by {@link normalizeBoard}.
 */
export declare function normalizeEntry(raw: unknown): WhiteboardEntry | undefined;
/**
 * Coerce one stored per-scope board. Unknown keys and malformed entries are
 * dropped, so a hand-edited settings file can never break a turn.
 * @param raw - the stored board value, if any.
 * @returns a well-formed board.
 */
export declare function normalizeBoard(raw: unknown): WhiteboardBoard;
/**
 * Coerce the legacy single-board document. Kept for the normalizer every
 * pre-multi-scope consumer reads through; {@link normalizeStore} migrates it.
 * @param raw - the `enpoi-orchestration.whiteboard` value, if any.
 * @returns a well-formed board.
 */
export declare function normalizeDoc(raw: unknown): WhiteboardDoc;
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
export declare function normalizeStore(raw: unknown): WhiteboardStore;
/** Result of the one-time legacy migration. */
export interface LegacyMigrationResult {
    /** The store in bucket shape. */
    store: WhiteboardStore;
    /** True when the input was a legacy single-board document and was migrated. */
    migrated: boolean;
    /** Sessions bucket the legacy global board was attributed to, when it was. */
    attributedTo?: string;
    /** Entries carried by the legacy board (0 for an already bucket-shaped input). */
    entries: number;
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
export declare function migrateLegacyStore(raw: unknown, attributeToSessionId?: string): LegacyMigrationResult;
/** The stored board one target reads, if it has been written yet. */
export declare function readBoard(store: WhiteboardStore, target: WhiteboardTarget): WhiteboardBoard | undefined;
/** Copy-on-write placement of one board into its scope bucket. */
export declare function writeBoard(store: WhiteboardStore, target: WhiteboardTarget, board: WhiteboardBoard): WhiteboardStore;
/** The scope facts one assembly resolves the board against. */
export interface BoardScopeFacts {
    /** The assembling agent's session id. */
    sessionId?: string;
    /** The assembling session's durable parent session id (direct-child inheritance). */
    parentSessionId?: string;
    /** The assembling session's project identity (session cwd). */
    projectId?: string;
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
export declare function resolveBoard(store: WhiteboardStore, facts: BoardScopeFacts): ResolvedBoard;
/**
 * Find the scope whose board authored one resolved entry, most specific first
 * (own session, parent session, project, global). Pin/unpin commits there.
 * @param store - the normalized store.
 * @param facts - the caller's scope facts.
 * @param id - the entry id from a resolved read.
 * @returns the owning target, or `undefined` when no layer has the id.
 */
export declare function findEntryTarget(store: WhiteboardStore, facts: BoardScopeFacts, id: string): WhiteboardTarget | undefined;
/**
 * Render a board as the exact text injected into the runtime-context snapshot.
 * Compact by construction: one line per entry, pinned first. The header carries
 * no version: a store version bump that leaves every entry unchanged must not
 * churn the injected block. Renders a resolved board and a stored board alike.
 * @param doc - the board to render.
 * @returns the block, or `''` when the board holds no entries.
 */
export declare function renderWhiteboard(doc: RenderableBoard): string;
/** Character count of a rendered board, counted in code points (multibyte-safe). */
export declare function boardChars(rendered: string): number;
/**
 * Estimate the rendered board's token cost. Conservative (4 chars/token) so the
 * hard budget refuses before a real tokenizer would overflow.
 * @param rendered - the exact injected text.
 * @returns estimated tokens, ceiling-rounded.
 */
export declare function estimateTokens(rendered: string): number;
/** The rendered character limit for a token budget. */
export declare function budgetChars(budgetTokens: number): number;
/** Result of one budget check. */
export interface BudgetCheck {
    ok: boolean;
    tokens: number;
    budget: number;
    chars: number;
    limit: number;
}
/**
 * Check a complete rendered board against the hard budget. Writes run this over
 * the resolved view their scope target resolves to, so a session entry cannot
 * push a session's injected block over the limit.
 * @param doc - the candidate board (stored or resolved).
 * @param budgetTokens - the configured hard budget.
 * @returns the check with the exact numbers for the refusal message.
 */
export declare function checkBudget(doc: RenderableBoard, budgetTokens: number): BudgetCheck;
/** One requested entry for a write. */
export interface WhiteboardWriteRequest {
    id?: string;
    kind: WhiteboardEntryKind;
    text: string;
    pinned?: boolean;
    /** Set for `mode: 'replace'` rows: the entry id to replace. */
    replaceId?: string;
}
/** Result of linting path entries against the filesystem. */
export interface LintResult<T> {
    doc: T;
    /** Ids of single-path entries that no longer resolve. */
    stale: string[];
    /** Ids of path entries whose text is prose, a list, a URL, or a glob — a warning, never stale. */
    unknown: string[];
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
export declare function lintPaths<T extends {
    entries: readonly WhiteboardEntry[];
}>(doc: T, resolvePath: (entry: WhiteboardEntry, path: string) => string, exists: (path: string) => boolean, now: number, syntax?: PathSyntax): LintResult<T>;
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
export declare function applyWrites(board: WhiteboardBoard, requests: readonly WhiteboardWriteRequest[], mode: 'append' | 'replace', now: number): {
    ok: true;
    board: WhiteboardBoard;
    changedIds: string[];
} | {
    ok: false;
    message: string;
};
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
export declare function applyStoreWrites(store: WhiteboardStore, target: WhiteboardTarget, requests: readonly WhiteboardWriteRequest[], mode: 'append' | 'replace', now: number): {
    ok: true;
    store: WhiteboardStore;
    changedIds: string[];
} | {
    ok: false;
    message: string;
};
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
export declare function setPinned(board: WhiteboardBoard, id: string, pinned: boolean, now: number): {
    ok: true;
    board: WhiteboardBoard;
    changed: boolean;
} | {
    ok: false;
    message: string;
};
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
export declare function setStorePinned(store: WhiteboardStore, target: WhiteboardTarget, id: string, pinned: boolean, now: number): {
    ok: true;
    store: WhiteboardStore;
    changed: boolean;
} | {
    ok: false;
    message: string;
};
/**
 * Delete one entry from a stored board. The removed entry is returned in full,
 * so a forget is never a silent drop. The caller owns the board-version bump.
 * @param board - the current stored board.
 * @param id - the entry id.
 * @param now - epoch ms stamped on the board.
 * @returns the next board plus the removed entry, or an error message.
 */
export declare function removeEntry(board: WhiteboardBoard, id: string, now: number): {
    ok: true;
    board: WhiteboardBoard;
    removed: WhiteboardEntry;
} | {
    ok: false;
    message: string;
};
/**
 * Delete one entry from the scope bucket that authored it and bump that
 * board's version, mirroring {@link setStorePinned}'s authoring-board lookup.
 * @param store - the current store.
 * @param target - the authoring scope bucket (from {@link findEntryTarget}).
 * @param id - the entry id.
 * @param now - epoch ms stamped onto the board.
 * @returns the next store plus the removed entry, or an error message.
 */
export declare function removeStoreEntry(store: WhiteboardStore, target: WhiteboardTarget, id: string, now: number): {
    ok: true;
    store: WhiteboardStore;
    removed: WhiteboardEntry;
} | {
    ok: false;
    message: string;
};
/**
 * Bounded GC for session buckets: keep only the `limit` most recently updated
 * boards, dropping the oldest by `updatedAt` (ties broken by session id).
 * Dropped board text is returned by id, never silently discarded.
 * @param store - the current store.
 * @param limit - how many session boards to keep.
 * @returns the next store and the dropped session ids.
 */
export declare function sweepSessionBoards(store: WhiteboardStore, limit: number): {
    store: WhiteboardStore;
    dropped: string[];
};
/** The minimal fields the freshness line reads. */
export interface VersionLineFacts {
    version: number;
    scope: WhiteboardScope;
    updatedAt: number;
}
/** The board's freshness line, recorded by every spawn whose request carries it. */
export declare function versionLine(doc: VersionLineFacts): string;
